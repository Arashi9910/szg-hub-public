// 上漲谷中控 - 組隊大廳伺服器（獨立程式，跟中控分開：另一個埠、另一份資料，碰不到任何人的中控）
//
// 誰會用：每個人的中控（server.js 的 lobbyhub.js）連進來，公布自己的隊伍、申請別人的隊伍。
//   - 隊伍代碼只存在大廳伺服器上，核准之後才交給申請的人（不會出現在公開清單）
//   - 自動同意：隊長設定等級範圍、職業、有空位，符合的申請大廳直接核准
//   - 加入後隊長的中控會用遊戲的隊伍資料核對（等級、職業），謊報的會被踢出並回報這裡，同一個人被踢 2 次封鎖 24 小時
//   - 資料都是各人的中控自行回報的，大廳沒辦法自己驗證
// 啟動：node lobby.js（環境變數 LOBBY_PORT，預設 8790；只聽 127.0.0.1，對外用 tailscale funnel）
// 資料：data/lobby/lobby.json；管理密碼：data/lobby/admin.txt（第一次啟動自動產生）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.LOBBY_PORT) || 8790;
const DIR = process.env.LOBBY_DATA || path.join(__dirname, 'data', 'lobby');
const FILE = path.join(DIR, 'lobby.json');
const LISTING_TTL = Number(process.env.LOBBY_LISTING_TTL_MS) || 2 * 60 * 1000; // 2 分鐘沒更新就下架
const PENDING_TTL = 10 * 60 * 1000;   // 申請 10 分鐘沒人理就過期
const APPROVED_TTL = 5 * 60 * 1000;   // 核准後 5 分鐘內要加入（之後代碼收回）
const STRIKE_BAN = 2, BAN_MS = 24 * 3600e3, STRIKE_WINDOW = 7 * 24 * 3600e3;
const MAX_PARTY = 6;

fs.mkdirSync(DIR, { recursive: true });
let ADMIN = ''; try { ADMIN = fs.readFileSync(path.join(DIR, 'admin.txt'), 'utf8').trim(); } catch (_) {}
if (!ADMIN) { ADMIN = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(DIR, 'admin.txt'), ADMIN); }

let db = { clients: {}, listings: {}, requests: {}, log: [], avas: {} }; // avas：角色名稱 → 全身照（隊長的中控、申請時送來的）
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_) {}
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('存檔失敗', e.message); } }, 2000); };
const log = msg => { db.log.push({ at: Date.now(), msg: String(msg).slice(0, 300) }); if (db.log.length > 300) db.log.splice(0, db.log.length - 300); save(); console.log('[大廳] ' + msg); };
const rid = () => crypto.randomBytes(8).toString('hex');
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0; };
const hashTok = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// ---------- 頻率限制（記憶體） ----------
const buckets = new Map();
function limited(key, max, ms) {
  const now = Date.now(), b = (buckets.get(key) || []).filter(t => now - t < ms);
  if (b.length >= max) { buckets.set(key, b); return true; }
  b.push(now); buckets.set(key, b); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (!b.length || now - b[b.length - 1] > 3600e3) buckets.delete(k); }, 10 * 60 * 1000).unref();

// ---------- 清理：過期的公告、申請 ----------
function sweep() {
  const now = Date.now(); let changed = false;
  for (const [id, l] of Object.entries(db.listings)) if (now - l.updatedAt > LISTING_TTL) { delete db.listings[id]; changed = true; }
  for (const [id, r] of Object.entries(db.requests)) {
    if (r.status === 'pending' && (now - r.createdAt > PENDING_TTL || !db.listings[r.listingId])) { r.status = 'expired'; r.decidedAt = now; changed = true; }
    if (r.status === 'approved' && now - r.decidedAt > APPROVED_TTL) { r.status = 'expired'; r.code = ''; changed = true; }
    if (r.code && r.status !== 'approved') { r.code = ''; changed = true; }
    if (now - (r.decidedAt || r.createdAt) > 24 * 3600e3) { delete db.requests[id]; changed = true; }
  }
  for (const [n, a] of Object.entries(db.avas || {})) if (now - a.at > 14 * 24 * 3600e3) { delete db.avas[n]; changed = true; }
  for (const [t, c] of Object.entries(db.clients)) if (now - (c.seenAt || 0) > 30 * 24 * 3600e3 && !(c.bannedUntil > now)) { delete db.clients[t]; changed = true; }
  if (changed) save();
}
setInterval(sweep, 15000).unref();

// ---------- 公開的資料（不含代碼、不含通行碼） ----------
const avaUrl = name => { const a = db.avas && db.avas[name]; return a ? `/ava/n/${encodeURIComponent(name)}.gif?t=${a.at}` : ''; };
const pubMember = (m, l) => ({ name: m.name, lv: m.lv, jobName: m.jobName || '', branch: m.branch || '', leader: !!m.leader, sameMap: !m.map || !l.map || m.map === l.map, mapName: m.mapName || '', ava: avaUrl(m.name) });
function putAva(name, b64) {
  if (!name || typeof b64 !== 'string' || b64.length > 40000 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return;
  db.avas = db.avas || {}; db.avas[name] = { b64, at: Date.now() };
}
function pubListing(l, viewer) {
  return {
    id: l.id, leader: l.leader, map: l.map, mapName: l.mapName, mapLv: l.mapLv, region: l.region,
    members: l.members.map(m => pubMember(m, l)), size: sizeOf(l), max: MAX_PARTY, web: !!l.web, exp: l.exp, dps: l.dps, note: l.note,
    rules: { auto: !!l.rules.auto, lvMin: l.rules.lvMin, lvMax: l.rules.lvMax, branches: l.rules.branches },
    ava: l.ava ? `/ava/${l.id}.gif?t=${l.avaAt}` : avaUrl(l.leader.name), updatedAt: l.updatedAt, createdAt: l.createdAt, mine: !!viewer && l.owner === viewer.id,
  };
}
const sizeOf = l => Math.max(l.members.length, l.size || 0);
function fits(l, ch) {
  const r = l.rules || {};
  if (sizeOf(l) >= MAX_PARTY) return '隊伍已滿';
  if (r.lvMin && ch.lv < r.lvMin) return `等級要 ${r.lvMin} 以上`;
  if (r.lvMax && ch.lv > r.lvMax) return `等級要 ${r.lvMax} 以下`;
  if ((r.branches || []).length && !r.branches.includes(ch.branch)) return `只收 ${r.branches.join('、')}`;
  return '';
}

// ---------- 請求處理 ----------
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
function readBody(req, max = 320 * 1024) {
  return new Promise((ok, bad) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { bad(Object.assign(new Error('資料太大'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf8'); ok(t ? JSON.parse(t) : {}); } catch (_) { bad(Object.assign(new Error('格式錯誤'), { code: 400 })); } });
    req.on('error', bad);
  });
}
const ipOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
function clientOf(req) {
  const t = req.headers['x-lobby-token']; if (!t) return null;
  const c = db.clients[hashTok(t)]; if (!c) return null;
  if (Date.now() - (c.seenAt || 0) > 60000) { c.seenAt = Date.now(); save(); }
  return c;
}
const banned = c => c && c.bannedUntil > Date.now();
function strike(c, why) {
  if (!c) return;
  const now = Date.now();
  c.strikes = (c.strikes || []).filter(t => now - t < STRIKE_WINDOW); c.strikes.push(now);
  if (c.strikes.length >= STRIKE_BAN) { c.bannedUntil = now + BAN_MS; c.banWhy = why; for (const [id, l] of Object.entries(db.listings)) if (l.owner === c.id) delete db.listings[id]; log(`封鎖 ${c.id}（${why}）24 小時`); }
  save();
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const P = url.pathname, M = req.method;
  if (M === 'OPTIONS') return send(res, 204, '');
  if (M === 'GET' && (P === '/' || P === '/index.html')) return send(res, 200, fs.readFileSync(PAGE_FILE, 'utf8'), 'text/html; charset=utf-8');
  if (M === 'GET' && P === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\n', 'text/plain; charset=utf-8');
  if (M === 'GET' && P === '/api/ping') { const m = process.memoryUsage(); return send(res, 200, { ok: true, name: '上漲谷組隊大廳', listings: Object.keys(db.listings).length, mem: { rss: Math.round(m.rss / 1048576), heapUsed: Math.round(m.heapUsed / 1048576) } }); }
  if (M === 'GET' && P.startsWith('/ava/n/')) {
    let name = ''; try { name = decodeURIComponent(P.slice(7).replace(/\.gif$/, '')); } catch (_) {}
    const a = db.avas && db.avas[name]; if (!a) return send(res, 404, { error: 'no avatar' });
    return send(res, 200, Buffer.from(a.b64, 'base64'), 'image/gif', { 'Cache-Control': 'max-age=300' });
  }
  if (M === 'GET' && /^\/ava\/[0-9a-f]{16}\.gif$/.test(P)) {
    const l = db.listings[P.slice(5, 21)]; if (!l || !l.ava) return send(res, 404, { error: 'no avatar' });
    return send(res, 200, Buffer.from(l.ava, 'base64'), 'image/gif', { 'Cache-Control': 'max-age=300' });
  }
  const ip = ipOf(req);
  if (limited('ip:' + ip, 600, 60000)) return send(res, 429, { error: '太頻繁了，等一下再試' });

  if (M === 'POST' && P === '/api/register') {
    if (limited('reg:' + ip, 10, 3600e3)) return send(res, 429, { error: '註冊太頻繁' });
    const b = await readBody(req).catch(() => ({}));
    const token = crypto.randomBytes(24).toString('hex'), c = { id: rid(), createdAt: Date.now(), seenAt: Date.now(), strikes: [], bannedUntil: 0, web: !!b.web };
    db.clients[hashTok(token)] = c; save();
    return send(res, 200, { token, id: c.id });
  }
  if (M === 'GET' && P === '/api/listings') {
    sweep();
    const c = clientOf(req);
    return send(res, 200, { now: Date.now(), listings: Object.values(db.listings).sort((a, b) => b.updatedAt - a.updatedAt).map(l => pubListing(l, c)) });
  }

  // ---- 以下要通行碼 ----
  if (P.startsWith('/api/admin/')) return admin(req, res, P, M);
  const c = clientOf(req);
  if (!c) return send(res, 401, { error: '大廳不認得這台中控，請重新連線' });
  if (limited('c:' + c.id, 120, 60000)) return send(res, 429, { error: '太頻繁了，等一下再試' });
  if (banned(c) && M === 'POST') return send(res, 403, { error: `已被大廳封鎖到 ${new Date(c.bannedUntil).toLocaleString('zh-TW')}（${c.banWhy || ''}）` });

  if (M === 'POST' && P === '/api/publish') {
    if (limited('pub:' + c.id, 30, 60000)) return send(res, 429, { error: '公布太頻繁' }); // 正常是 30 秒一次
    const b = await readBody(req), now = Date.now(), keep = new Set(), ids = {}, avaOk = [];
    for (const x of (Array.isArray(b.listings) ? b.listings : []).slice(0, 6)) {
      const key = str(x.key, 64); if (!key) continue;
      let l = Object.values(db.listings).find(l => l.owner === c.id && l.key === key);
      const members = (Array.isArray(x.members) ? x.members : []).slice(0, MAX_PARTY).map(m => ({ name: str(m.name, 24), lv: num(m.lv, 1, 300), job: str(m.job, 40), jobName: str(m.jobName, 20), branch: str(m.branch, 10), map: str(m.map, 40), mapName: str(m.mapName, 40), leader: !!m.leader })).filter(m => m.name);
      if (x.avas && typeof x.avas === 'object') for (const [n, b64] of Object.entries(x.avas).slice(0, MAX_PARTY)) if (members.some(m => m.name === n)) { putAva(str(n, 24), b64); if (db.avas[str(n, 24)]) avaOk.push(str(n, 24)); }
      if (!members.length) continue;
      const rules = x.rules || {};
      const data = {
        leader: { name: str(x.leader && x.leader.name, 24), lv: num(x.leader && x.leader.lv, 1, 300), jobName: str(x.leader && x.leader.jobName, 20), branch: str(x.leader && x.leader.branch, 10) },
        map: str(x.map, 40), mapName: str(x.mapName, 40), mapLv: num(x.mapLv, 0, 300), region: str(x.region, 30),
        members, exp: num(x.exp, 0, 1e12), dps: num(x.dps, 0, 1e9), note: str(x.note, 60),
        rules: { auto: !!rules.auto, lvMin: num(rules.lvMin, 0, 300), lvMax: num(rules.lvMax, 0, 300), branches: (Array.isArray(rules.branches) ? rules.branches : []).map(s => str(s, 10)).filter(Boolean).slice(0, 6) },
        code: str(x.code, 40), updatedAt: now, web: !!c.web,
        size: c.web ? num(x.size, 1, MAX_PARTY) : 0, // 網頁版自己填人數（沒有遊戲資料）
      };
      if (!l) { l = { id: rid(), owner: c.id, key, createdAt: now, ava: '', avaAt: 0 }; db.listings[l.id] = l; log(`公布：${data.leader.name}＠${data.mapName}`); }
      Object.assign(l, data);
      if (x.ava && typeof x.ava === 'string' && x.ava.length < 40000 && /^[A-Za-z0-9+/=]+$/.test(x.ava)) { l.ava = x.ava; l.avaAt = now; }
      keep.add(l.id); ids[key] = l.id;
    }
    for (const [id, l] of Object.entries(db.listings)) if (l.owner === c.id && !keep.has(id)) delete db.listings[id];
    save();
    return send(res, 200, { ok: true, ids, avas: avaOk, banned: banned(c) ? c.bannedUntil : 0 }); // avas：收下的全身照（中控只把這些記成已送）
  }

  if (M === 'GET' && P === '/api/mine') {
    sweep();
    const mine = Object.values(db.listings).filter(l => l.owner === c.id);
    const lids = new Set(mine.map(l => l.id));
    const incoming = Object.values(db.requests).filter(r => lids.has(r.listingId)).map(r => ({ id: r.id, listingId: r.listingId, key: (db.listings[r.listingId] || {}).key, char: r.char, msg: r.msg, status: r.status, by: r.by, createdAt: r.createdAt, decidedAt: r.decidedAt || 0 }));
    const outgoing = Object.values(db.requests).filter(r => r.from === c.id).map(r => {
      const l = db.listings[r.listingId] || r.snap || {};
      return { id: r.id, listingId: r.listingId, ref: r.ref, status: r.status, why: r.why || '', code: r.status === 'approved' ? r.code : '', map: l.map, mapName: l.mapName, leaderName: (l.leader || {}).name || '', createdAt: r.createdAt, decidedAt: r.decidedAt || 0 };
    });
    return send(res, 200, { now: Date.now(), banned: banned(c) ? { until: c.bannedUntil, why: c.banWhy || '' } : null, listings: mine.map(l => ({ id: l.id, key: l.key, ...(c.web ? { ...pubListing(l, c), code: l.code, rules: l.rules } : {}) })), incoming, outgoing });
  }

  if (M === 'POST' && P === '/api/request') {
    if (limited('req:' + c.id, 10, 60000)) return send(res, 429, { error: '申請太頻繁，等一下再試' });
    const b = await readBody(req), l = db.listings[str(b.listingId, 20)];
    if (!l) return send(res, 404, { error: '這個隊伍已經下架了' });
    if (l.owner === c.id) return send(res, 400, { error: '這是你自己的隊伍' });
    const live = Object.values(db.requests).filter(r => r.from === c.id && (r.status === 'pending' || r.status === 'approved'));
    if (live.length >= 6) return send(res, 429, { error: '同時進行中的申請最多 6 個' });
    const ch = b.char || {};
    const char = { name: str(ch.name, 24), lv: num(ch.lv, 1, 300), job: str(ch.job, 40), jobName: str(ch.jobName, 20), branch: str(ch.branch, 10), dps: num(ch.dps, 0, 1e9), exp: num(ch.exp, 0, 1e12) };
    if (!char.name) return send(res, 400, { error: '缺角色資料' });
    if (live.some(r => r.listingId === l.id && r.char.name === char.name)) return send(res, 400, { error: '這隻角色已經申請過這個隊伍了' });
    char.web = !!c.web;
    if (ch.ava) putAva(char.name, ch.ava);
    const r = { id: rid(), listingId: l.id, from: c.id, ref: str(b.ref, 64), char, msg: str(b.msg, 60), status: 'pending', by: '', createdAt: Date.now(), decidedAt: 0, code: '', snap: { map: l.map, mapName: l.mapName, leader: { name: l.leader.name } } };
    const no = fits(l, char);
    if (no && sizeOf(l) >= MAX_PARTY) { r.status = 'denied'; r.why = no; r.by = 'auto'; r.decidedAt = Date.now(); }
    else if (l.rules.auto && !no && l.code) { r.status = 'approved'; r.by = 'auto'; r.decidedAt = Date.now(); r.code = l.code; }
    db.requests[r.id] = r; save();
    log(`申請：${char.name} → ${l.leader.name}＠${l.mapName}（${r.status === 'approved' ? '自動同意' : r.status === 'denied' ? '拒絕：' + no : '等隊長'}）`);
    return send(res, 200, { id: r.id, status: r.status, why: r.why || (r.status === 'pending' && no ? `不符合自動同意（${no}），等隊長決定` : ''), code: r.status === 'approved' ? r.code : '' });
  }

  if (M === 'POST' && P === '/api/decide') {
    const b = await readBody(req), r = db.requests[str(b.requestId, 20)], l = r && db.listings[r.listingId];
    if (!r || !l || l.owner !== c.id) return send(res, 404, { error: '找不到這個申請' });
    if (r.status !== 'pending') return send(res, 400, { error: '這個申請已經處理過了' });
    if (b.approve) {
      if (sizeOf(l) >= MAX_PARTY) return send(res, 400, { error: '隊伍已滿' });
      if (!l.code) return send(res, 400, { error: '還沒有隊伍代碼（隊長的遊戲分頁要開著）' });
      r.status = 'approved'; r.code = l.code;
    } else { r.status = 'denied'; r.why = str(b.why, 40) || '隊長拒絕'; }
    r.by = 'manual'; r.decidedAt = Date.now(); save();
    return send(res, 200, { ok: true, status: r.status });
  }

  if (M === 'POST' && (P === '/api/cancel' || P === '/api/joined' || P === '/api/joinfail')) {
    const b = await readBody(req), r = db.requests[str(b.requestId, 20)];
    if (!r || r.from !== c.id) return send(res, 404, { error: '找不到這個申請' });
    if (P === '/api/cancel' && (r.status === 'pending' || r.status === 'approved')) r.status = 'cancelled';
    if (P === '/api/joined' && r.status === 'approved') r.status = 'joined';
    if (P === '/api/joinfail' && r.status === 'approved') { r.status = 'failed'; r.why = str(b.why, 80); }
    r.code = ''; r.decidedAt = r.decidedAt || Date.now(); save();
    return send(res, 200, { ok: true, status: r.status });
  }

  // 申請者的中控補送全身照（申請時還沒有，或換裝了）
  if (M === 'POST' && P === '/api/myava') {
    const b = await readBody(req), r = db.requests[str(b.requestId, 20)];
    if (!r || r.from !== c.id || !['approved', 'joined'].includes(r.status)) return send(res, 404, { error: '找不到這個申請' });
    if (limited('ava:' + c.id, 20, 60000)) return send(res, 429, { error: '太頻繁' });
    putAva(r.char.name, b.ava); save();
    return send(res, 200, { ok: true });
  }
  // 隊長的中控核對後發現謊報（等級、職業跟遊戲隊伍資料不符）→ 已經踢出，記一次
  if (M === 'POST' && P === '/api/mismatch') {
    const b = await readBody(req), r = db.requests[str(b.requestId, 20)], l = r && db.listings[r.listingId];
    if (!r || (l ? l.owner !== c.id : true)) return send(res, 404, { error: '找不到這個申請' });
    if (r.status === 'kicked') return send(res, 200, { ok: true });
    r.status = 'kicked'; r.why = str(b.why, 80) || '資料不符'; r.code = ''; save();
    const offender = Object.values(db.clients).find(x => x.id === r.from);
    strike(offender, `${r.char.name}：${r.why}`);
    log(`核對不符：${r.char.name}（${r.why}），踢出`);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}

// ---------- 管理（大廳主人：中控面板帶著 data/lobby/admin.txt 的密碼來） ----------
async function admin(req, res, P, M) {
  const k = String(req.headers['x-lobby-admin'] || '');
  const a = Buffer.from(k), b = Buffer.from(ADMIN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 403, { error: '管理密碼錯誤' });
  if (M === 'GET' && P === '/api/admin/state') {
    const now = Date.now();
    return send(res, 200, {
      listings: Object.values(db.listings).map(l => ({ ...pubListing(l), owner: l.owner })),
      clients: Object.values(db.clients).map(c => ({ id: c.id, createdAt: c.createdAt, seenAt: c.seenAt, strikes: (c.strikes || []).length, bannedUntil: c.bannedUntil > now ? c.bannedUntil : 0, banWhy: c.banWhy || '',
        listings: Object.values(db.listings).filter(l => l.owner === c.id).length })).sort((x, y) => y.seenAt - x.seenAt).slice(0, 300),
      requests: Object.values(db.requests).sort((x, y) => y.createdAt - x.createdAt).slice(0, 100).map(r => ({ id: r.id, from: r.from, char: r.char, status: r.status, by: r.by, why: r.why || '', at: r.createdAt, leader: ((db.listings[r.listingId] || r.snap || {}).leader || {}).name || '' })),
      log: db.log.slice(-100),
    });
  }
  const body = await readBody(req);
  const cl = Object.values(db.clients).find(x => x.id === str(body.clientId, 20));
  if (M === 'POST' && P === '/api/admin/delist') { const l = db.listings[str(body.listingId, 20)]; if (l) { delete db.listings[l.id]; log(`管理：下架 ${l.leader.name}`); } save(); return send(res, 200, { ok: true }); }
  if (M === 'POST' && P === '/api/admin/ban') { if (!cl) return send(res, 404, { error: 'no client' }); cl.bannedUntil = Date.now() + (num(body.hours, 1, 24 * 365) || 24) * 3600e3; cl.banWhy = str(body.why, 60) || '管理員封鎖'; for (const [id, l] of Object.entries(db.listings)) if (l.owner === cl.id) delete db.listings[id]; log(`管理：封鎖 ${cl.id}`); save(); return send(res, 200, { ok: true }); }
  if (M === 'POST' && P === '/api/admin/unban') { if (!cl) return send(res, 404, { error: 'no client' }); cl.bannedUntil = 0; cl.strikes = []; log(`管理：解除封鎖 ${cl.id}`); save(); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: 'not found' });
}

// ---------- 網頁版大廳（沒裝中控的人也能看、申請、公布；資料自己填，通過後自己在遊戲輸入隊伍代碼）----------
const PAGE_FILE = path.join(__dirname, 'lobby.html'); // 每次讀檔：中控更新 lobby.html 後不用重開大廳

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { try { send(res, e.code || 400, { error: e.message || String(e) }); } catch (_) {} });
});
server.listen(PORT, process.env.LOBBY_HOST || '127.0.0.1', () => { try { fs.writeFileSync(path.join(DIR, 'lobby.pid'), String(process.pid)); } catch (_) {} console.log(`上漲谷組隊大廳：http://127.0.0.1:${PORT}（對外用 tailscale funnel）`); });

// 中控自動更新換了這個檔案 → 結束（代碼 3），由中控重新開起來
const SELF = __filename; let selfAt = 0; try { selfAt = fs.statSync(SELF).mtimeMs; } catch (_) {}
setInterval(() => { try { if (fs.statSync(SELF).mtimeMs !== selfAt) { clearTimeout(saveTimer); fs.writeFileSync(FILE, JSON.stringify(db)); console.log('大廳程式更新了，重新啟動'); process.exit(3); } } catch (_) {} }, 30000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearTimeout(saveTimer); try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (_) {} process.exit(0); });
