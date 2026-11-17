// 上漲谷中控 - 本機伺服器（不需要安裝任何套件，Node.js 18 以上即可）
// 啟動：node server.js   然後打開 http://127.0.0.1:8787
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const updater = require('./update');
const makeMarket = require('./market');

const PORT = Number(process.env.PORT) || 8787;
// 只接受本機連線
const HOST = '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DASHBOARD = path.join(__dirname, 'dashboard.html');
const USERSCRIPT = path.join(__dirname, 'szg-hub.user.js');
const AGENT_FILE = path.join(__dirname, 'agent.js');

fs.mkdirSync(DATA_DIR, { recursive: true });


let updateInfo = { current: updater.localVersion(), latest: null, hasUpdate: false, notes: '', checkedAt: 0, error: '' };
async function checkUpdate() {
  try {
    const r = await updater.check();
    updateInfo = { current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, notes: r.notes, checkedAt: Date.now(), error: '' };
    if (r.hasUpdate) {
      const busy = db.jobs.some(j => ACTIVE.has(j.status) && j.kind !== 'idle');
      if (db.settings.autoUpdate !== false && !busy) return await applyUpdateAndRestart();
      console.log(`有新版本 ${r.latest}（目前 ${r.current}）${busy ? '，等工作結束後自動更新' : '，可在面板按「更新並重啟」'}。`);
    }
  } catch (e) {
    const c = e.cause && (e.cause.code || (e.cause.errors && e.cause.errors[0] && e.cause.errors[0].code) || e.cause.message);
    updateInfo.error = c ? `${e.message}（${c}）` : e.message;
    updateInfo.checkedAt = Date.now();
    console.log('檢查更新失敗：' + updateInfo.error);
  }
}

// 功能程式在 agent.js，由各設定檔的 Tampermonkey 透過 @require 載入
function agentSource() { return stampVersion(fs.readFileSync(AGENT_FILE, 'utf8')); }
async function applyUpdateAndRestart() {
  const r = await updater.apply();
  if (r.updated) {
    console.log(`已更新到 ${r.latest}，重新啟動中…`);
    clearTimeout(saveTimer);
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(db)); } catch (_) {}
    setTimeout(() => process.exit(3), 300); // start.bat 看到代碼 3 會自動重開
  }
  return r;
}
// 版本號只有一個來源：version.json。提供給瀏覽器的腳本會把版本號換成它，
// 所以伺服器、面板、腳本、Tampermonkey 顯示的數字永遠一致；每次發新版，遊戲頁面都會自動重整一次。
function scriptVersion() { return updater.localVersion(); }
function stampVersion(src) {
  const v = scriptVersion();
  return src.replace(/const AGENT_VERSION = '[\d.]+';/, `const AGENT_VERSION = '${v}';`)
            .replace(/(\/\/ @version\s+)\S+/, `$1${v}`);
}
function userscriptSource() { return stampVersion(fs.readFileSync(USERSCRIPT, 'utf8')); }
let db = { chars: {}, jobs: [], settings: { accountLabels: {}, mainCharId: null, presets: [], slotStats: {} } };
try {
  const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  db = { ...db, ...loaded, jobs: loaded.jobs || [], settings: { ...db.settings, ...(loaded.settings || {}) } };
} catch (_) { /* 第一次啟動 */ }

// ---- 知識王題庫：隨程式更新的 quiz-bank.json ＋ 各帳號作答時自動學到的（存在 data/state.json） ----
const QUIZ_FILE = path.join(__dirname, 'quiz-bank.json');
const qnorm = s => String(s || '').replace(/[\s　]+/g, '').replace(/[「」『』《》〈〉？?！!。，,、：:；;（）()【】"'“”‘’…·．.]/g, '').toLowerCase();
function quizStore() { return db.quiz || (db.quiz = { learned: {}, unknown: {}, log: [] }); }
function quizBank() {
  const bank = {};
  try {
    for (const x of JSON.parse(fs.readFileSync(QUIZ_FILE, 'utf8')).questions || []) if (x.q && x.answer) bank[qnorm(x.q)] = { q: x.q, options: x.options || [], answer: x.answer, src: 'bank' };
  } catch (_) {}
  for (const [k, x] of Object.entries(quizStore().learned)) bank[k] = { ...x, src: 'learned' };
  return bank;
}
function quizLog(msg) { const q = quizStore(); q.log.push({ at: Date.now(), msg: String(msg).slice(0, 200) }); if (q.log.length > 200) q.log.splice(0, q.log.length - 200); }

let saveTimer = null;
let market = null; // 自由市場模組（db 載入後建立）
let saveFailed = false;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, STATE_FILE);
      if (saveFailed) { console.log('存檔恢復正常。'); saveFailed = false; }
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (!saveFailed) console.warn(`[警告] 資料存檔失敗（${e.code || e.message}）：面板照常運作，但關掉伺服器後資料不會保留。若是 ENOSPC，代表硬碟空間不足。`);
      saveFailed = true;
    }
  }, 1000);
}
market = makeMarket(() => db, save, id => charName(id));


// ================= 交易工作 =================
// 狀態：pending（等你確認）→ approved（排隊中）→ running → done / failed / cancelled
const ACTIVE = new Set(['approved', 'running']);
const ONLINE_MS = 90 * 1000; // 這段時間內有回報資料，才算對方在線

function codeOf(charId) { const s = db.chars[charId]; return s && s.playerCode; }
function onlineCode(code) {
  return Object.values(db.chars).some(s => s.playerCode === code && Date.now() - (s.receivedAt || 0) < ONLINE_MS);
}
// 某個帳號目前應該處理的工作：最早建立、還沒結束、而且牽涉到它的那一個
// 排程規則：
//  1. 某個工作一旦開始交易，就把雙方帳號「鎖」在這個工作上，直到它結束，才換下一個（避免中途被別的工作插隊）
//  2. 沒有鎖的時候，依「按下確認執行」的先後排隊（同時確認的，依建立順序）
const locks = {}; // 帳號代碼 -> 工作 id
function jobOrder(j) { return [j.approvedAt || j.createdAt, db.jobs.indexOf(j)]; }
function currentJobFor(code) {
  const lockedId = locks[code];
  if (lockedId) {
    const lj = db.jobs.find(j => j.id === lockedId);
    if (lj && ACTIVE.has(lj.status)) return lj;
    delete locks[code];
  }
  return db.jobs.filter(j => j.kind !== 'idle' && ACTIVE.has(j.status) && (j.fromCode === code || j.toCode === code))
    .sort((a, b) => { const x = jobOrder(a), y = jobOrder(b); return x[0] - y[0] || x[1] - y[1]; })[0] || null;
}
function lockJob(job) {
  locks[job.fromCode] = job.id;
  locks[job.toCode] = job.id;
}
function jobLog(job, msg) {
  const last = job.log[job.log.length - 1];
  if (last && last.msg === msg) { last.at = Date.now(); last.n = (last.n || 1) + 1; return; }
  job.log.push({ at: Date.now(), msg });
  if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
}
function publicJob(j) { return j; }

const BAG_KINDS = new Set(['sell', 'lock', 'unlock', 'idle']);

// ================= 掛機控制 =================
// 指令（開始／暫停／重新開始）依帳號分組，交給那個帳號目前在線的遊戲頁面執行；
// 同帳號的第二隻角色也可以直接控制（遊戲允許用 characterId 指定）。
const IDLE_ACTIONS = new Set(['start', 'stop', 'restart', 'switch', 'wake']);
function accountOfChar(charId) {
  const own = db.chars[charId];
  if (own) return own.accountId;
  const holder = Object.values(db.chars).find(s => (s.accountChars || []).some(c => c.id === charId));
  return holder && holder.accountId;
}
function charName(charId) {
  const own = db.chars[charId];
  if (own) return own.char.name;
  for (const s of Object.values(db.chars)) { const c = (s.accountChars || []).find(c => c.id === charId); if (c) return c.name; }
  return charId;
}
function routeForAccount(accountId) {
  // 優先：最近回報、而且是帳號目前角色的那個頁面
  const list = Object.values(db.chars).filter(s => s.accountId === accountId && s.playerCode)
    .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  return list.find(s => s.activeCharId === s.char.id) || list[0];
}
function createIdleJobs(body) {
  const targets = (body.targets || []).filter(t => t && t.charId && IDLE_ACTIONS.has(t.action));
  if (!targets.length) throw new Error('沒有選擇角色');
  const byAcc = {};
  for (const t of targets) {
    const acc = accountOfChar(t.charId);
    if (!acc) continue;
    if (t.action === 'switch') {
      // 切換角色：每個帳號只能有一隻是目前角色，同帳號勾了兩隻就以最後一隻為準
      byAcc[acc] = (byAcc[acc] || []).filter(x => x.action !== 'switch');
      byAcc[acc].push({ charId: t.charId, name: charName(t.charId), action: 'switch' });
      continue;
    }
    if (t.action === 'wake') {
      // 領取離線收益是整個頁面的動作，一個帳號做一次就好
      if (!(byAcc[acc] || []).some(x => x.action === 'wake')) (byAcc[acc] || (byAcc[acc] = [])).push({ charId: t.charId, name: charName(t.charId), action: 'wake' });
      continue;
    }
    (byAcc[acc] || (byAcc[acc] = [])).push({ charId: t.charId, name: charName(t.charId), action: t.action });
    db.settings.idleLast = { ...(db.settings.idleLast || {}), [t.charId]: { action: t.action, at: Date.now(), by: 'panel' } };
  }
  const jobs = [];
  for (const [acc, list] of Object.entries(byAcc)) {
    const route = routeForAccount(acc);
    if (!route) continue;
    if (list.some(t => t.action === 'switch') && db.jobs.some(j => j.kind !== 'idle' && ACTIVE.has(j.status) && (j.fromCode === route.playerCode || j.toCode === route.playerCode))) {
      throw new Error(`${route.char.name} 的帳號有交易／背包工作還沒完成，先不要切換角色`);
    }
    const job = {
      id: crypto.randomBytes(6).toString('hex'), kind: 'idle', status: 'approved', createdAt: Date.now(), approvedAt: Date.now(),
      fromCharId: route.char.id, fromName: route.char.name, fromCode: route.playerCode,
      toCharId: route.char.id, toName: route.char.name, toCode: route.playerCode,
      batches: [{ targets: list, items: [], gear: [], money: 0 }], batchIndex: 0, log: [], lastMsg: '',
    };
    jobLog(job, '已送出：' + list.map(t => `${t.name} ${({ start: '開始掛機', stop: '暫停掛機', restart: '重新開始掛機', switch: '切換為目前角色', wake: '領取離線掛機收益' })[t.action]}`).join('、'));
    db.jobs.push(job);
    jobs.push(job);
  }
  if (!jobs.length) throw new Error('找不到可執行的遊戲頁面（那些帳號的遊戲分頁要開著）');
  save();
  return jobs;
}
function idleLog(entry) {
  db.idleLog = db.idleLog || [];
  db.idleLog.push({ at: Date.now(), ...entry });
  if (db.idleLog.length > 200) db.idleLog.splice(0, db.idleLog.length - 200);
  save();
}
function createBagJob(body) {
  const owner = db.chars[body.fromCharId];
  if (!owner) throw new Error('找不到角色資料');
  if (!owner.playerCode) throw new Error('角色還沒回報 12 碼 ID，請先更新腳本並打開遊戲頁面');
  const b = (body.batches || [])[0] || {};
  if (!(b.items || []).length && !(b.gear || []).length) throw new Error('沒有選擇任何物品');
  const job = {
    id: crypto.randomBytes(6).toString('hex'), kind: body.kind, status: 'pending', createdAt: Date.now(),
    fromCharId: owner.char.id, fromName: owner.char.name, fromCode: owner.playerCode,
    toCharId: owner.char.id, toName: owner.char.name, toCode: owner.playerCode,
    batches: [{ items: b.items || [], gear: b.gear || [], money: 0 }], batchIndex: 0, log: [], lastMsg: '',
    estimate: Number(body.estimate) || 0,
  };
  db.jobs.push(job);
  save();
  return job;
}

function createJob(body) {
  if (body.kind === 'idle') throw new Error('掛機指令請用 /api/idle');
  if (BAG_KINDS.has(body.kind)) return createBagJob(body);
  const from = db.chars[body.fromCharId], to = db.chars[body.toCharId];
  if (!from || !to) throw new Error('找不到角色資料');
  if (!from.playerCode || !to.playerCode) throw new Error('角色還沒回報 12 碼 ID，請先更新腳本並打開遊戲頁面');
  if (from.playerCode === to.playerCode) throw new Error('同帳號角色請用倉庫轉移，不能交易');
  const batches = (body.batches || []).filter(b => (b.items && b.items.length) || (b.gear && b.gear.length) || b.money);
  if (!batches.length) throw new Error('沒有要交易的東西');
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    kind: body.kind === 'give' ? 'give' : 'collect',
    status: 'pending',
    createdAt: Date.now(),
    fromCharId: from.char.id, fromName: from.char.name, fromCode: from.playerCode,
    toCharId: to.char.id, toName: to.char.name, toCode: to.playerCode,
    strictChar: true,
    batches, batchIndex: 0,
    log: [], lastMsg: '',
  };
  db.jobs.push(job);
  save();
  return job;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.method === 'GET' && url.pathname === '/agent.js') {
      return send(res, 200, agentSource(), 'text/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/agent-version') {
      return send(res, 200, { version: scriptVersion() });
    }
    if (req.method === 'GET' && url.pathname === '/szg-hub.user.js') {
      return send(res, 200, userscriptSource(), 'text/javascript; charset=utf-8');
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(DASHBOARD, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/data') {
      return send(res, 200, { now: Date.now(), chars: db.chars, settings: db.settings, jobs: db.jobs.slice(-100), idleLog: (db.idleLog || []).slice(-50), gearLog: (db.gearLog || []).slice(-80), scriptVersion: scriptVersion(), update: updateInfo });
    }

    if (req.method === 'POST' && url.pathname === '/api/push') {
      const snap = JSON.parse(await readBody(req));
      if (!snap || !snap.char || !snap.char.id) return send(res, 400, { error: 'bad snapshot' });
      snap.receivedAt = Date.now();
      // 這次沒帶 12 碼 ID（查詢暫時失敗）時，沿用之前記住的；同帳號其他角色的 ID 也可以用（ID 跟著帳號）
      if (!snap.playerCode) {
        const prev = db.chars[snap.char.id];
        const sibling = Object.values(db.chars).find(s => s.playerCode && s.accountId === snap.accountId);
        snap.playerCode = (prev && prev.playerCode) || (sibling && sibling.playerCode) || undefined;
        if (snap.playerCode) snap.codeFromCache = true;
      }
      db.chars[snap.char.id] = snap;
      // 同帳號的另一隻角色：更新它在角色大廳看得到的基本資料（等級、是否掛機）
      for (const other of snap.accountChars || []) {
        const prev = db.chars[other.id];
        if (prev && other.id !== snap.char.id) {
          if (snap.playerCode) prev.playerCode = snap.playerCode;
          prev.char.lv = other.lv;
          prev.char.auto = !!other.auto;
          prev.accountId = snap.accountId;
        }
      }
      save();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const patch = JSON.parse(await readBody(req));
      db.settings = { ...db.settings, ...patch };
      save();
      return send(res, 200, { ok: true, settings: db.settings });
    }


    // ---- 自動更新 ----
    if (req.method === 'POST' && url.pathname === '/api/update/check') {
      await checkUpdate();
      return send(res, 200, updateInfo);
    }
    if (req.method === 'POST' && url.pathname === '/api/update/apply') {
      if (db.jobs.some(j => ACTIVE.has(j.status))) return send(res, 409, { error: '有交易工作正在執行，請等它結束或取消後再更新' });
      const r = await applyUpdateAndRestart();
      return send(res, 200, { ok: true, updated: r.updated, latest: r.latest });
    }

    // ---- 交易工作 ----
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      return send(res, 200, { jobs: db.jobs.slice(-100).map(publicJob) });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const body = JSON.parse(await readBody(req));
      const list = Array.isArray(body) ? body : [body];
      const created = [];
      for (const b of list) created.push(createJob(b));
      return send(res, 200, { ok: true, jobs: created });
    }
    let m;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/jobs\/(\w+)\/(approve|cancel|retry|delete)$/))) {
      const job = db.jobs.find(j => j.id === m[1]);
      if (!job) return send(res, 404, { error: 'no job' });
      if (m[2] === 'approve' && job.status === 'pending') { job.status = 'approved'; job.approvedAt = Date.now(); jobLog(job, '已確認，排隊等待執行'); }
      if (m[2] === 'cancel' && !['done', 'cancelled'].includes(job.status)) { job.status = 'cancelled'; jobLog(job, '已取消（若遊戲裡還有進行中的交易，請手動取消）'); }
      if (m[2] === 'retry' && job.status === 'failed') { job.status = 'approved'; job.approvedAt = Date.now(); jobLog(job, `從第 ${job.batchIndex + 1} 批重新開始`); }
      if (m[2] === 'delete' && !ACTIVE.has(job.status)) db.jobs = db.jobs.filter(j => j !== job);
      save();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs/approve-all') {
      for (const j of db.jobs) if (j.status === 'pending') { j.status = 'approved'; j.approvedAt = Date.now(); jobLog(j, '已確認，排隊等待執行'); }
      save();
      return send(res, 200, { ok: true });
    }

    // ---- 自由市場 ----
    if (req.method === 'GET' && url.pathname === '/api/market') return send(res, 200, market.summary());
    if (req.method === 'POST' && url.pathname === '/api/market/claim') {
      const { charId } = JSON.parse(await readBody(req));
      return send(res, 200, market.claim(charId));
    }
    if (req.method === 'POST' && url.pathname === '/api/market/report') {
      const { charId, results } = JSON.parse(await readBody(req));
      market.report(charId, results);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/market/stall') {
      const { charId, stall } = JSON.parse(await readBody(req));
      if (charId && stall) market.reportStall(charId, stall);
      return send(res, 200, { ok: true, autoClaim: market.cfg().autoClaim });
    }
    if (req.method === 'POST' && url.pathname === '/api/market/scan-now') return send(res, 200, { ok: true, added: market.enqueueAll(true) });
    if (req.method === 'GET' && url.pathname === '/api/market/plan') {
      const charId = url.searchParams.get('charId');
      if (charId) return send(res, 200, market.plan(charId));
      return send(res, 200, { plans: Object.keys(db.chars).map(id => ({ charId: id, name: charName(id), ...market.plan(id) })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/market/log') {
      const e = JSON.parse(await readBody(req));
      if (e && e.msg) market.log({ charId: e.charId, msg: String(e.msg).slice(0, 600) });
      return send(res, 200, { ok: true });
    }

    // ---- 撿到裝備自動處理 ----
    if (req.method === 'GET' && url.pathname === '/api/autosell') {
      const a = db.settings.autoSell || {};
      return send(res, 200, { mode: a.mode || 'off', rules: a.rules || [], chars: a.chars || {} });
    }
    if (req.method === 'POST' && url.pathname === '/api/gear-log') {
      const e = JSON.parse(await readBody(req));
      if (e && e.msg) {
        db.gearLog = db.gearLog || [];
        db.gearLog.push({ at: Date.now(), charId: e.charId, name: e.charId ? charName(e.charId) : '', msg: String(e.msg).slice(0, 600) });
        if (db.gearLog.length > 300) db.gearLog.splice(0, db.gearLog.length - 300);
        save();
      }
      return send(res, 200, { ok: true });
    }

    // ---- 知識王 ----
    if (req.method === 'GET' && url.pathname === '/api/quiz') {
      const bank = quizBank();
      const answers = {};
      for (const [k, x] of Object.entries(bank)) answers[k] = x.answer;
      const st = quizStore();
      return send(res, 200, { auto: !!db.settings.quizAuto, answers, count: Object.keys(bank).length,
        unknown: Object.values(st.unknown), learned: Object.values(st.learned).slice(-100), log: st.log.slice(-50) });
    }
    if (req.method === 'GET' && url.pathname === '/api/quiz/export') {
      return send(res, 200, { version: 1, questions: Object.values(quizBank()).map(x => ({ q: x.q, options: x.options || [], answer: x.answer, src: x.src })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/quiz/learn') {
      const e = JSON.parse(await readBody(req));
      if (!e || !e.q || !e.answer) return send(res, 400, { error: '缺少題目或答案' });
      const k = qnorm(e.q), st = quizStore();
      const known = quizBank()[k];
      if (!known || qnorm(known.answer) !== qnorm(e.answer)) {
        st.learned[k] = { q: String(e.q), options: (e.options || []).map(String), answer: String(e.answer), by: e.by || (e.charId ? charName(e.charId) : ''), at: Date.now() };
        quizLog(`${known ? '更正' : '新增'}：${e.q} → ${e.answer}${e.by ? '（' + e.by + '）' : ''}`);
      }
      delete st.unknown[k];
      save();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/quiz/unknown') {
      const e = JSON.parse(await readBody(req));
      if (e && e.q) {
        const k = qnorm(e.q), st = quizStore();
        if (!st.unknown[k]) quizLog(`題庫沒有，等你作答：${e.q}`);
        st.unknown[k] = { q: String(e.q), options: (e.options || []).map(String), by: e.charId ? charName(e.charId) : '', at: Date.now() };
        save();
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/quiz/log') {
      const e = JSON.parse(await readBody(req));
      if (e && e.msg) { quizLog((e.charId ? charName(e.charId) + '：' : '') + e.msg); save(); }
      return send(res, 200, { ok: true });
    }

    // ---- 掛機控制 ----
    if (req.method === 'POST' && url.pathname === '/api/idle') {
      const jobs = createIdleJobs(JSON.parse(await readBody(req)));
      return send(res, 200, { ok: true, jobs });
    }
    if (req.method === 'GET' && url.pathname === '/api/idle-policy') {
      const p = db.settings.idlePolicy || {};
      return send(res, 200, { policy: { autoRenew: !!p.autoRenew, renewBeforeMin: Number(p.renewBeforeMin) || 30, stopAfterHours: Number(p.stopAfterHours) || 0, wakeHours: Number(p.wakeHours) || 0 },
        excluded: db.settings.idleExcluded || {}, last: db.settings.idleLast || {} });
    }
    if (req.method === 'POST' && url.pathname === '/api/idle-log') {
      const e = JSON.parse(await readBody(req));
      if (e && e.charId && e.msg) {
        idleLog({ charId: e.charId, name: charName(e.charId), msg: String(e.msg).slice(0, 200) });
        if (e.action) db.settings.idleLast = { ...(db.settings.idleLast || {}), [e.charId]: { action: e.action, at: Date.now(), by: 'auto' } };
      }
      return send(res, 200, { ok: true });
    }

    // 腳本查詢：這個帳號現在要做什麼
    if (req.method === 'GET' && url.pathname === '/api/agent') {
      const code = url.searchParams.get('code') || '';
      // 掛機指令馬上執行，不用排在交易後面
      const idleJob = db.jobs.find(j => j.kind === 'idle' && ACTIVE.has(j.status) && j.fromCode === code);
      if (idleJob) return send(res, 200, { job: idleJob, role: 'owner', peerReady: true });
      const job = currentJobFor(code);
      if (!job) return send(res, 200, { job: null });
      if (BAG_KINDS.has(job.kind)) return send(res, 200, { job, role: 'owner', peerReady: true });
      const role = job.fromCode === code ? 'giver' : 'receiver';
      const peer = role === 'giver' ? job.toCode : job.fromCode;
      // 對方帳號也必須以這個工作為優先，才開始（避免同時跟兩個人交易）
      const peerJob = currentJobFor(peer);
      const peerReady = !!peerJob && peerJob.id === job.id && onlineCode(peer);
      if (peerReady) lockJob(job);
      return send(res, 200, { job, role, peerReady });
    }
    // 收貨方發現遊戲裡已經有某個帳號的邀請：如果那個帳號正好有工作要交給我，就改成先處理它
    if (req.method === 'POST' && url.pathname === '/api/agent/claim') {
      const { code, inviterCode } = JSON.parse(await readBody(req));
      const job = db.jobs.filter(j => ACTIVE.has(j.status) && !BAG_KINDS.has(j.kind) && j.fromCode === inviterCode && j.toCode === code)
        .sort((a, b) => { const x = jobOrder(a), y = jobOrder(b); return x[0] - y[0] || x[1] - y[1]; })[0];
      if (!job) return send(res, 200, { ok: false });
      const cur = currentJobFor(code);
      if (cur && cur.id !== job.id) jobLog(cur, `${job.fromName} 的邀請已經送到，先處理它，這個工作稍後再繼續`);
      for (const k of Object.keys(locks)) if (locks[k] === (cur && cur.id)) delete locks[k];
      lockJob(job);
      return send(res, 200, { ok: true, jobId: job.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/report') {
      const ev = JSON.parse(await readBody(req));
      const job = db.jobs.find(j => j.id === ev.jobId);
      if (!job || !ACTIVE.has(job.status)) return send(res, 200, { ok: true, ignored: true });
      if (ev.batchIndex !== job.batchIndex) return send(res, 200, { ok: true, ignored: true });
      if (job.status === 'approved') job.status = 'running';
      if (ev.event === 'log' || ev.event === 'waiting') { jobLog(job, ev.msg); job.lastMsg = ev.msg; }
      if (ev.event === 'error') { job.status = 'failed'; jobLog(job, '失敗：' + ev.msg); job.lastMsg = ev.msg; }
      if (ev.event === 'batchDone') {
        jobLog(job, BAG_KINDS.has(job.kind) ? '完成' : ev.skippedEmpty ? `第 ${job.batchIndex + 1} 批沒有東西，略過` : `第 ${job.batchIndex + 1} 批交易完成`);
        job.batchIndex++;
        if (job.batchIndex >= job.batches.length) { job.status = 'done'; job.lastMsg = '全部完成'; jobLog(job, '全部完成'); }
      }
      job.updatedAt = Date.now();
      save();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/forget') {
      const { charId } = JSON.parse(await readBody(req));
      delete db.chars[charId];
      save();
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`上漲谷中控已啟動：http://127.0.0.1:${PORT}`);
  console.log(`版本 ${scriptVersion()}。各設定檔安裝網址：http://127.0.0.1:${PORT}/szg-hub.user.js`);
  console.log('');
  console.log('保持這個視窗開著；關掉視窗就會停止。');
  checkUpdate();
  setInterval(checkUpdate, 2 * 60 * 1000);
});
