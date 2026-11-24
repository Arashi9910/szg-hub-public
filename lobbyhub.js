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
    const members = (party.members || []).map(m => ({ name: m.name, lv: m.lv, job: m.job, jobName: (db().chars[m.id] && db().chars[m.id].char.jobName) || '' }));
    const l = {
      key: charId, code: party.code,
      leader: { name: c.name, lv: c.lv, jobName: c.jobName || '', branch: c.branch || '' },
      map: c.map, mapName: c.mapName || mi.name || c.map, mapLv: mi.minLevel || 0, region: mi.region || '',
      members, exp: Math.round((live && live.rate) || c.hourlyExp || 0), dps: Math.round(charDps(charId) || 0), note: pc.note || '', rules: pc.rules || {},
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
      const r = await call('POST', '/api/publish', { listings: out.map(l => { const x = { ...l }; delete x._avaAt; return x; }) });
      for (const l of out) { if (r.ids && r.ids[l.key]) pub[l.key].listingId = r.ids[l.key]; if (l._avaAt) st().avaSent[l.key] = l._avaAt; }
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
        log(`${charName(loc.charId)} 的申請通過，加入 ${loc.leaderName} 的隊伍`);
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
      log(`${m.name} 加入後核對不符（${why}），踢出`);
    }
    for (const [id, x] of Object.entries(s.chk)) if (Date.now() - x.at > 24 * 3600e3) delete s.chk[id];
    for (const [id, t] of Object.entries(s.seen || {})) if (Date.now() - t > 24 * 3600e3) delete s.seen[id];
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
      const r = await call('POST', '/api/request', { listingId: b.listingId, ref: c.id, msg: String(b.msg || '').slice(0, 60),
        char: { name: c.name, lv: c.lv, job: c.job, jobName: c.jobName || '', branch: c.branch || '', dps: Math.round(charDps(c.id) || 0), exp: Math.round((live && live.rate) || c.hourlyExp || 0) } });
      s.req[r.id] = { at: Date.now(), charId: c.id, listingId: b.listingId, map: l.map || '', mapName: l.mapName || '', leaderName: (l.leader || {}).name || '', status: r.status, why: r.why || '' };
      save(); setTimeout(() => poll().catch(() => {}), 200);
      return { ...r, view: await view() };
    }
    if (name === 'decide') { await call('POST', '/api/decide', { requestId: b.requestId, approve: !!b.approve }); await poll(); return view(); }
    if (name === 'cancel') { await call('POST', '/api/cancel', { requestId: b.requestId }); if (s.req[b.requestId]) s.req[b.requestId].status = 'cancelled'; save(); return view(); }
    if (name === 'host') { const h = { ...(S().lobbyHost || {}) }; h.on = !!b.on; if (b.port) h.port = Number(b.port) || 8790; db().settings.lobbyHost = h; save(); await hostTick(); return view(); }
    throw new Error('不明的操作');
  }

  function boot() {
    setInterval(() => poll().catch(() => {}), POLL_MS);
    setTimeout(() => poll().catch(() => {}), 3000);
    setInterval(() => hostTick().catch(() => {}), 30000);
    setTimeout(() => hostTick().catch(() => {}), 1000);
  }
  return { boot, view, action, adminCall, poll, publish, DEFAULT_URL };
};
