// 上漲谷中控 - 連到「組隊大廳」（lobby.js）的部分
//   - 公布：隊長角色（設定裡開了「公布到大廳」）每 30 秒把隊伍資料送到大廳；沒有隊伍的先自動建立一個
//   - 申請：從大廳選隊伍、選自己的角色申請；核准後拿到隊伍代碼 → 建立組隊工作（加入、換到同一張圖、開始掛機）
//   - 審核：別人的申請由大廳照隊長的自動同意規則處理，不符合的在面板等隊長決定
//   - 核對：有人加入後，用遊戲的隊伍資料核對他回報的等級、職業；謊報就踢出並回報大廳
//   - 架設：這台電腦要當大廳主機時（設定 lobbyHost），由中控把 lobby.js 開起來並看著它
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_URL = 'https://desktop-90ip8gr.tail33a91c.ts.net:8443'; // 公開的大廳（大廳主人的電腦，tailscale funnel）
const POLL_MS = Number(process.env.SZG_LOBBY_POLL_MS) || 10000;
const PUB_MS = Number(process.env.SZG_LOBBY_PUB_MS) || 30000;
const LV_SLACK = 2; // 回報的等級比實際高超過這麼多才算謊報（回報後到加入之間不會降級，但可能剛好升級顯示延遲）

module.exports = function makeLobby(o) {
  const { getDb, save, charName, charDps, expLive, worldFile, avatarDir, createPartyJob, dataDir, isActiveJob } = o;
  const log = o.log || (m => console.log('[組隊大廳] ' + m));
  const db = () => getDb();
  const S = () => db().settings || {};
  const cfg = () => { const c = S().lobby || {}; return { on: c.on !== false, url: String(c.url || process.env.SZG_LOBBY_URL || DEFAULT_URL).replace(/\/+$/, '') }; };
  const st = () => db().lobbyState || (db().lobbyState = { token: '', url: '', req: {}, chk: {}, avaSent: {} });
  // 通知（大廳分頁最下面）：誰加入、誰離開、跟著隊長換圖…
  function note(msg, kind = '') { const s = st(); s.notes = s.notes || []; s.notes.push({ at: Date.now(), msg, kind }); if (s.notes.length > 50) s.notes.splice(0, s.notes.length - 50); save(); log(msg); }
  const status = { ok: false, err: '', at: 0, banned: null, listings: [], listingsAt: 0, mine: { incoming: [], outgoing: [] }, pub: {} };

  // ---------- 跟大廳講話 ----------
  async function call(method, p, body, noAuth) {
    const c = cfg(), s = st();
    if (s.url !== c.url) { s.url = c.url; s.token = ''; } // 換了大廳：重新註冊
    if (!noAuth && !s.token) {
      const r = await call('POST', '/api/register', {}, true);
      s.token = r.token; save();
    }
    const r = await fetch(c.url + p, { method, headers: { 'Content-Type': 'application/json', ...(noAuth ? {} : { 'X-Lobby-Token': s.token }) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 && !noAuth) { s.token = ''; save(); throw new Error('大廳不認得這台中控，下一輪重新連線'); }
    if (!r.ok) throw Object.assign(new Error(j.error || ('大廳回應 ' + r.status)), { status: r.status });
    return j;
  }

  // ---------- 世界資料（地圖等級、地區） ----------
  let world = { at: 0, maps: {} };
  function mapInfo(id) {
    try { const t = fs.statSync(worldFile).mtimeMs; if (t !== world.at) { const w = JSON.parse(fs.readFileSync(worldFile, 'utf8')); world = { at: t, maps: Object.fromEntries((w.maps || []).map(m => [m.id, m])) }; } } catch (_) {}
    return world.maps[id] || {};
  }

  // ---------- 公布 ----------
  const pubCfg = () => S().lobbyPub || {};
  const creating = {}; // 角色 → 上次自動建隊伍的時間
  function buildListing(charId, pc) {
    const s = db().chars[charId];
    if (!s || !s.char) return { state: 'stale', msg: '還沒有這隻角色的資料' };
    if (Date.now() - (s.receivedAt || 0) > 5 * 60 * 1000) return { state: 'stale', msg: '超過 5 分鐘沒有資料（遊戲分頁要開著）' };
    const party = s.party && s.party.party;
    if (!party || !party.code) {
      const busy = isActiveJob(j => j.kind === 'party' && j.fromCharId === charId);
      if (!busy && Date.now() - (creating[charId] || 0) > 2 * 60 * 1000) { creating[charId] = Date.now(); createPartyJob(charId, { role: 'leader', ops: true, create: true, noStart: true }, '組隊大廳：建立隊伍'); }
      return { state: 'creating', msg: '沒有隊伍，正在幫你建立一個' };
    }
    // 誰是隊長：真實遊戲的 party.leader 是「自己是不是隊長」（true／false），隊員資料有 leader 旗標；模擬遊戲是隊長的 id，兩種都認
    const mem = party.members || [], me = mem.find(m => m.id === charId || m.self), lm = mem.find(m => m.leader);
    const isLeader = party.leader === true || party.leader === charId || !!(me && me.leader) || (mem.length <= 1 && party.leader !== false);
    if (!isLeader) return { state: 'notLeader', msg: `在 ${lm ? lm.name : '別人'} 的隊伍裡，不是隊長` };
    const c = s.char, mi = mapInfo(c.map), live = expLive()[charId];
    const members = (party.members || []).map(m => { const own = db().chars[m.id]; return { name: m.name, lv: m.lv, job: m.job, jobName: m.jobName || (own && own.char.jobName) || '', branch: m.branch || (own && own.char.branch) || '', map: m.map, mapName: mapInfo(m.map).name || '', leader: !!m.leader || m.id === charId && mem.length <= 1 }; });
    // 隊員裡自己的角色：全身照一起送（沒變就不送）
    // 大廳回覆收下了才記成已送（v0.66.1：大廳還是舊版時送了沒收，以前會被當成送過）
    const avas = {}, avaAt = {}; const sentN = st().avaSent2 || (st().avaSent2 = {});
    for (const m of party.members || []) { const a = (db().avatars || {})[m.id]; if (a && sentN[m.name] !== a.at) { try { avas[m.name] = fs.readFileSync(path.join(avatarDir, m.id + '.gif')).toString('base64'); avaAt[m.name] = a.at; } catch (_) {} } }
    const l = {
      key: charId, code: party.code,
      leader: { name: c.name, lv: c.lv, jobName: c.jobName || '', branch: c.branch || '' },
      map: c.map, mapName: c.mapName || mi.name || c.map, mapLv: mi.minLevel || 0, region: mi.region || '',
      members, avas, _avaN: avaAt, exp: Math.round((live && live.rate) || c.hourlyExp || 0), dps: Math.round(charDps(charId) || 0), note: pc.note || '', rules: pc.rules || {},
    };
    const ava = (db().avatars || {})[charId];
    if (ava && st().avaSent[charId] !== ava.at) { try { l.ava = fs.readFileSync(path.join(avatarDir, charId + '.gif')).toString('base64'); l._avaAt = ava.at; } catch (_) {} }
    return { state: 'live', listing: l, size: members.length };
  }
  let pubBusy = false, pubAt = 0;
  async function publish(force) {
    if (pubBusy || (!force && Date.now() - pubAt < PUB_MS)) return; pubBusy = true; pubAt = Date.now();
    try {
      const out = [], pub = {};
      for (const [charId, pc] of Object.entries(pubCfg())) {
        if (!pc || !pc.on) continue;
        const b = buildListing(charId, pc);
        pub[charId] = { state: b.state, msg: b.msg || '', size: b.size || 0 };
        if (b.listing) out.push(b.listing);
      }
      if (!out.length && !Object.keys(status.lastPub || {}).length && !force) { status.pub = pub; return; }
      const r = await call('POST', '/api/publish', { listings: out.map(l => { const x = { ...l }; delete x._avaAt; delete x._avaN; return x; }) });
      const sentN = st().avaSent2 || (st().avaSent2 = {});
      for (const l of out) { if (r.ids && r.ids[l.key]) pub[l.key].listingId = r.ids[l.key]; if (l._avaAt) st().avaSent[l.key] = l._avaAt; for (const n of r.avas || []) if (l._avaN && l._avaN[n]) sentN[n] = l._avaN[n]; }
      status.pub = pub; status.lastPub = r.ids || {}; save();
    } catch (e) { status.err = e.message; }
    finally { pubBusy = false; }
  }

  // ---------- 輪詢：我的申請、別人的申請 ----------
  let pollBusy = false;
  async function poll() {
    if (pollBusy) return;
    if (!cfg().on) { // 關掉大廳：把公告撤下來（失敗就下一輪再試）
      if (st().needClear) { pollBusy = true; try { await call('POST', '/api/publish', { listings: [] }); st().needClear = false; save(); } catch (_) {} finally { pollBusy = false; } }
      return;
    }
    // 沒有公布、也沒有進行中的申請：不用一直問大廳（只是瀏覽的人連註冊都不用）
    const active = Object.values(pubCfg()).some(p => p && p.on) || Object.keys(status.lastPub || {}).length
      || Object.values(st().req).some(x => ['pending', 'approved'].includes(x.status) || (x.jobId && !x.reported) || Date.now() - x.at < 15 * 60 * 1000);
    if (!active) return;
    pollBusy = true;
    try {
      await publish(false);
      const m = await call('GET', '/api/mine');
      status.ok = true; status.err = ''; status.at = Date.now(); status.banned = m.banned; status.mine = { incoming: m.incoming || [], outgoing: m.outgoing || [] };
      await handleOutgoing(m.outgoing || []);
      await verifyIncoming(m.incoming || []);
    } catch (e) { status.ok = false; status.err = e.message; status.at = Date.now(); }
    finally { pollBusy = false; }
  }

  // 我送出的申請：核准了就去加入
  async function handleOutgoing(list) {
    const s = st();
    for (const r of list) {
      const loc = s.req[r.id]; if (!loc) continue;
      loc.status = r.status; loc.why = r.why || '';
      if (r.status === 'approved' && r.code && !loc.jobId) {
        const job = createPartyJob(loc.charId, { role: 'member', ops: true, code: r.code, map: loc.map, mapName: loc.mapName, leaderName: loc.leaderName }, `組隊大廳：加入 ${loc.leaderName} 的隊伍，前往 ${loc.mapName}`);
        loc.jobId = job.id; loc.joinAt = Date.now(); save();
        note(`${charName(loc.charId)} 的申請通過，正在加入 ${loc.leaderName} 的隊伍（${loc.mapName}）`, 'join');
      }
      // 加入後：自己的全身照有新的（申請時還沒有、換裝）就補送給大廳
      if ((r.status === 'approved' || r.status === 'joined') && loc.charId) {
        const a = (db().avatars || {})[loc.charId];
        if (a && loc.avaAt !== a.at) { try { await call('POST', '/api/myava', { requestId: r.id, ava: fs.readFileSync(path.join(avatarDir, loc.charId + '.gif')).toString('base64') }); loc.avaAt = a.at; save(); } catch (_) {} }
      }
      if (loc.jobId && !loc.reported) {
        const j = db().jobs.find(x => x.id === loc.jobId);
        if (j && j.status === 'done') { loc.reported = 'joined'; await call('POST', '/api/joined', { requestId: r.id }).catch(() => {}); save(); }
        else if (j && (j.status === 'failed' || j.status === 'cancelled')) { loc.reported = 'failed'; await call('POST', '/api/joinfail', { requestId: r.id, why: j.lastMsg || '' }).catch(() => {}); save(); }
        else if (!j) loc.reported = 'gone';
      }
    }
    for (const [id, loc] of Object.entries(s.req)) if (Date.now() - loc.at > 24 * 3600e3) delete s.req[id];
  }

  // 別人加入我的隊伍後：用遊戲的隊伍資料核對他回報的等級、職業
  async function verifyIncoming(list) {
    const s = st();
    for (const r of list) {
      if (r.status !== 'approved' && r.status !== 'joined') continue;
      const seen = s.seen || (s.seen = {}); if (!seen[r.id]) { seen[r.id] = Date.now(); save(); } // 這台中控第一次看到核准的時間（用自己的時鐘，不跟大廳的時鐘比）
      const ck = s.chk[r.id];
      if (ck && ck.result === 'kicked' && ck.jobId) { // 踢人失敗（例如那時他其實還沒加入）→ 重新核對
        const kj = db().jobs.find(j => j.id === ck.jobId);
        if (kj && (kj.status === 'failed' || kj.status === 'cancelled')) { delete s.chk[r.id]; seen[r.id] = Date.now(); save(); }
        continue;
      }
      if (ck) continue;
      if (Date.now() - (r.decidedAt || r.createdAt) > 15 * 60 * 1000) { s.chk[r.id] = { at: Date.now(), result: 'notSeen' }; continue; }
      const snap = db().chars[r.key]; const party = snap && snap.party && snap.party.party;
      if (!snap || (snap.receivedAt || 0) < seen[r.id] + 1000) continue; // 只用核准之後才收到的隊伍資料（舊資料裡可能還有上次被踢的人）
      const m = party && (party.members || []).find(x => x.name === r.char.name && !db().chars[x.id]);
      if (!m) continue; // 還沒加入
      const bad = [];
      if (Number(m.lv) + LV_SLACK < Number(r.char.lv)) bad.push(`等級回報 ${r.char.lv}，實際 ${m.lv}`);
      if (r.char.job && m.job && r.char.job !== m.job) bad.push(`職業回報 ${r.char.jobName || r.char.job}，實際不符`);
      if (!bad.length) { s.chk[r.id] = { at: Date.now(), result: 'ok' }; save(); continue; }
      const why = bad.join('；');
      const kj = createPartyJob(r.key, { role: 'kick', memberId: m.id, memberName: m.name, why }, `組隊大廳：踢出 ${m.name}（${why}）`);
      s.chk[r.id] = { at: Date.now(), result: 'kicked', why, jobId: kj.id }; save();
      await call('POST', '/api/mismatch', { requestId: r.id, why }).catch(() => {});
      note(`${m.name} 加入後核對不符（${why}），已踢出`, 'kick');
    }
    for (const [id, x] of Object.entries(s.chk)) if (Date.now() - x.at > 24 * 3600e3) delete s.chk[id];
    for (const [id, t] of Object.entries(s.seen || {})) if (Date.now() - t > 24 * 3600e3) delete s.seen[id];
  }

  // ---------- 隊伍：成員變化通知、隊長換圖時隊員跟著換 ----------
  // 跟隨：只在「隊長剛換圖、這隻原本就跟隊長在同一張圖、而且在掛機」時才帶過去；打王地圖、正在做組隊／打王工作的不動
  const followOn = () => S().lobbyFollow !== false;
  let isBossMap = () => false;
  function bossMapFn() {
    try { const w = JSON.parse(fs.readFileSync(worldFile, 'utf8')); const set = new Set((w.maps || []).filter(m => (m.boss || []).length || (m.bossSpawns || []).length).map(m => m.id)); isBossMap = id => set.has(id) || /boss/i.test(String(id)); } catch (_) {}
  }
  function partyTick() {
    const s = st(); s.lead = s.lead || {}; s.pmem = s.pmem || {};
    const now = Date.now();
    for (const snap of Object.values(db().chars)) {
      const c = snap.char; if (!c || now - (snap.receivedAt || 0) > 3 * 60 * 1000) continue;
      const party = snap.party && snap.party.party, mem = (party && party.members) || [];
      // 成員變化（每個隊伍只由隊長、或隊伍裡第一隻自己的角色報一次）
      if (party && party.code && mem.length) {
        const owner = mem.find(m => db().chars[m.id]);
        if (owner && owner.id === c.id) {
          const names = mem.map(m => m.name), prev = s.pmem[party.code];
          if (prev) {
            for (const n of names) if (!prev.includes(n)) note(`${n} 加入了 ${(mem.find(m => m.leader) || {}).name || '隊伍'} 的隊伍`, 'in');
            for (const n of prev) if (!names.includes(n)) note(`${n} 離開了 ${(mem.find(m => m.leader) || {}).name || '隊伍'} 的隊伍`, 'out');
          }
          s.pmem[party.code] = names;
        }
      }
      const lead = mem.find(m => m.leader);
      if (!party || mem.length < 2 || !lead || lead.id === c.id) { delete s.lead[c.id]; continue; }
      const prev = s.lead[c.id], cur = lead.map;
      s.lead[c.id] = cur;
      if (!followOn() || !prev || !cur || prev === cur) continue;
      if (c.map !== prev || !c.auto || isBossMap(cur)) continue;
      if (isActiveJob(j => (j.kind === 'party' || j.kind === 'boss') && j.fromCharId === c.id)) continue;
      const mapName = mapInfo(cur).name || cur;
      createPartyJob(c.id, { role: 'follow', ops: false, map: cur, mapName, leaderName: lead.name }, `組隊：隊長 ${lead.name} 換到 ${mapName}，跟著過去`);
      note(`隊長 ${lead.name} 換到 ${mapName}，${c.name} 跟著過去`, 'follow');
    }
    for (const k of Object.keys(s.pmem)) if (!Object.values(db().chars).some(x => x.party && x.party.party && x.party.party.code === k)) delete s.pmem[k];
  }
  // 面板「我的隊伍」：自己的角色所在的隊伍（同一隊只列一次）
  function myParties() {
    const out = {}, now = Date.now(), lobbyAva = Object.fromEntries((status.listings || []).flatMap(l => (l.members || []).filter(m => m.ava).map(m => [m.name, cfg().url + m.ava])));
    for (const snap of Object.values(db().chars)) {
      const party = snap.party && snap.party.party; if (!party || !party.code || now - (snap.receivedAt || 0) > 10 * 60 * 1000) continue;
      const mem = party.members || []; if (mem.length < 2 && !(pubCfg()[snap.char.id] || {}).on) continue;
      const o = out[party.code] || (out[party.code] = { code: party.code, members: {}, at: 0 });
      if ((snap.receivedAt || 0) < o.at) continue; o.at = snap.receivedAt;
      for (const m of mem) {
        const own = db().chars[m.id];
        o.members[m.id] = { id: m.id, name: m.name, lv: m.lv, jobName: m.jobName || (own && own.char.jobName) || '', branch: m.branch || (own && own.char.branch) || '', map: m.map, mapName: mapInfo(m.map).name || m.map, leader: !!m.leader, auto: !!m.auto, own: !!own,
          ava: own && (db().avatars || {})[m.id] ? `/api/avatar/${encodeURIComponent(m.id)}?t=${db().avatars[m.id].at}` : lobbyAva[m.name] || '' };
      }
    }
    return Object.values(out).map(p => { const ms = Object.values(p.members).sort((a, b) => b.leader - a.leader); const L = ms.find(m => m.leader) || ms[0]; return { code: p.code, leader: L, map: L.map, mapName: L.mapName, members: ms, iLead: L.own, listed: !!(pubCfg()[L.id] || {}).on }; });
  }

  // ---------- 架設大廳（這台電腦當主機） ----------
  const hostCfg = () => { const h = S().lobbyHost || {}; return { on: !!h.on, port: Number(h.port) || 8790 }; };
  let hostProc = null, hostUp = false, hostChecking = false;
  async function hostTick() {
    const h = hostCfg(); if (hostChecking) return; hostChecking = true;
    try {
      let up = false; try { up = (await fetch(`http://127.0.0.1:${h.port}/api/ping`, { signal: AbortSignal.timeout(3000) })).ok; } catch (_) {}
      hostUp = up;
      if (h.on && !up && !(hostProc && hostProc.exitCode === null)) {
        fs.mkdirSync(path.join(dataDir, 'lobby'), { recursive: true });
        const out = fs.openSync(path.join(dataDir, 'lobby', 'lobby.log'), 'a');
        hostProc = spawn(process.execPath, [path.join(__dirname, 'lobby.js')], { cwd: __dirname, env: { ...process.env, LOBBY_PORT: String(h.port) }, detached: true, stdio: ['ignore', out, out], windowsHide: true });
        hostProc.unref(); log('啟動組隊大廳伺服器（port ' + h.port + '）');
      }
      if (!h.on && up) { // 關掉：請大廳自己結束
        try { const pid = Number(fs.readFileSync(path.join(dataDir, 'lobby', 'lobby.pid'), 'utf8')); if (pid) process.kill(pid); } catch (_) {}
      }
    } finally { hostChecking = false; }
  }
  const adminKey = () => { try { return fs.readFileSync(path.join(dataDir, 'lobby', 'admin.txt'), 'utf8').trim(); } catch (_) { return ''; } };
  async function adminCall(method, p, body) {
    const r = await fetch(`http://127.0.0.1:${hostCfg().port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Lobby-Admin': adminKey() }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j;
  }

  // ---------- 給面板的 API ----------
  async function listings(force) {
    if (!cfg().on) return [];
    if (force || Date.now() - status.listingsAt > 5000) {
      try { const j = await call('GET', '/api/listings', null, true); status.listings = j.listings || []; status.listingsAt = Date.now(); status.ok = true; status.err = ''; }
      catch (e) { status.ok = false; status.err = e.message; }
    }
    return status.listings;
  }
  async function view() {
    const ls = await listings(false);
    return {
      cfg: { ...cfg(), defaultUrl: DEFAULT_URL }, status: { ok: status.ok, err: status.err, at: status.at, banned: status.banned },
      listings: ls.map(l => ({ ...l, mine: Object.values(status.lastPub || {}).includes(l.id), ava: l.ava ? cfg().url + l.ava : '' })), pub: pubCfg(), pubState: status.pub,
      incoming: status.mine.incoming, outgoing: status.mine.outgoing, local: st().req, chk: st().chk,
      parties: myParties(), notes: (st().notes || []).slice(-30).reverse(), follow: followOn(),
      host: { ...hostCfg(), up: hostUp, hasAdmin: !!adminKey() },
    };
  }
  async function action(name, b) {
    const s = st();
    if (name === 'cfg') {
      const c = { ...(S().lobby || {}) };
      if (b.on !== undefined) c.on = !!b.on;
      if (b.url !== undefined) { const u = String(b.url || '').trim().replace(/\/+$/, ''); if (u && !/^https?:\/\/[^\s]+$/.test(u)) throw new Error('網址格式不對'); c.url = u || undefined; }
      db().settings.lobby = c; save();
      if (!c.on) { status.ok = false; status.err = ''; st().needClear = true; save(); await poll().catch(() => {}); }
      return view();
    }
    if (name === 'pub') {
      const id = String(b.charId || ''); if (!db().chars[id]) throw new Error('沒有這隻角色的資料');
      const all = { ...pubCfg() }, cur = all[id] || {};
      const rules = b.rules ? { auto: !!b.rules.auto, lvMin: Number(b.rules.lvMin) || 0, lvMax: Number(b.rules.lvMax) || 0, branches: (b.rules.branches || []).map(String).slice(0, 6) } : cur.rules || { auto: false };
      all[id] = { on: b.on !== undefined ? !!b.on : !!cur.on, note: b.note !== undefined ? String(b.note).slice(0, 60) : cur.note || '', rules };
      if (!all[id].on && !all[id].note && !all[id].rules.auto) delete all[id];
      db().settings.lobbyPub = all; save();
      await publish(true); return view();
    }
    if (name === 'request') {
      const sn = db().chars[String(b.charId || '')]; if (!sn) throw new Error('沒有這隻角色的資料');
      const l = status.listings.find(x => x.id === b.listingId) || {};
      const c = sn.char, live = expLive()[c.id];
      let ava = ''; try { if ((db().avatars || {})[c.id]) ava = fs.readFileSync(path.join(avatarDir, c.id + '.gif')).toString('base64'); } catch (_) {}
      const r = await call('POST', '/api/request', { listingId: b.listingId, ref: c.id, msg: String(b.msg || '').slice(0, 60),
        char: { name: c.name, lv: c.lv, job: c.job, jobName: c.jobName || '', branch: c.branch || '', dps: Math.round(charDps(c.id) || 0), exp: Math.round((live && live.rate) || c.hourlyExp || 0), ava: ava.length < 40000 ? ava : '' } });
      s.req[r.id] = { at: Date.now(), charId: c.id, listingId: b.listingId, map: l.map || '', mapName: l.mapName || '', leaderName: (l.leader || {}).name || '', status: r.status, why: r.why || '' };
      save(); setTimeout(() => poll().catch(() => {}), 200);
      return { ...r, view: await view() };
    }
    if (name === 'decide') { await call('POST', '/api/decide', { requestId: b.requestId, approve: !!b.approve }); await poll(); return view(); }
    if (name === 'cancel') { await call('POST', '/api/cancel', { requestId: b.requestId }); if (s.req[b.requestId]) s.req[b.requestId].status = 'cancelled'; save(); return view(); }
    if (name === 'follow') { db().settings.lobbyFollow = !!b.on; save(); return view(); }
    if (name === 'leave' || name === 'kick') {
      const id = String(b.charId || ''), sn = db().chars[id]; if (!sn) throw new Error('沒有這隻角色的資料');
      const party = sn.party && sn.party.party; if (!party || !party.code) throw new Error('這隻角色不在隊伍裡');
      if (isActiveJob(j => j.kind === 'party' && j.fromCharId === id)) throw new Error('這隻角色還有組隊工作在進行，等它做完');
      if (name === 'leave') { createPartyJob(id, { role: 'leave' }, '組隊：退出隊伍'); note(`${sn.char.name} 退出隊伍`, 'out'); }
      else {
        const m = (party.members || []).find(x => x.id === b.memberId); if (!m) throw new Error('隊伍裡沒有這個人');
        const me = (party.members || []).find(x => x.id === id);
        if (!(party.leader === true || (me && me.leader))) throw new Error('只有隊長可以踢人');
        createPartyJob(id, { role: 'kick', memberId: m.id, memberName: m.name }, `組隊：踢出 ${m.name}`);
        note(`${sn.char.name} 把 ${m.name} 踢出隊伍`, 'kick');
      }
      return view();
    }
    if (name === 'host') { const h = { ...(S().lobbyHost || {}) }; h.on = !!b.on; if (b.port) h.port = Number(b.port) || 8790; db().settings.lobbyHost = h; save(); await hostTick(); return view(); }
    throw new Error('不明的操作');
  }

  function boot() {
    setInterval(() => poll().catch(() => {}), POLL_MS);
    setTimeout(() => poll().catch(() => {}), 3000);
    setInterval(() => hostTick().catch(() => {}), 30000);
    bossMapFn(); setInterval(bossMapFn, 10 * 60 * 1000);
    setInterval(() => { try { partyTick(); } catch (e) { log('隊伍檢查失敗：' + e.message); } }, Number(process.env.SZG_PARTY_TICK_MS) || 5000);
    setTimeout(() => hostTick().catch(() => {}), 1000);
  }
  return { boot, view, action, adminCall, poll, publish, DEFAULT_URL };
};
