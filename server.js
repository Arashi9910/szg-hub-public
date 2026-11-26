// 上漲谷中控 - 本機伺服器（不需要安裝任何套件，Node.js 18 以上即可）
// 啟動：node server.js   然後打開 http://127.0.0.1:8787
'use strict';

// Mac／Linux 直接用 `node server.js` 開時：自動更新要「結束（代碼 3）再重開」，Windows 由 start.bat 重開，
// 這裡沒有 start.bat，所以第一個程序當看門的，真正的中控是子程序；子程序結束代碼 3 就重開一個（v0.67.1，有人回報 Mac 一更新就停）
if (process.platform !== 'win32' && !process.env.SZG_LAUNCHER && !process.env.SZG_CHILD) {
  const { spawn } = require('child_process');
  let child = null, stopping = false;
  const run = () => {
    child = spawn(process.execPath, [...process.execArgv, __filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, SZG_CHILD: '1' } });
    child.on('exit', code => {
      if (code === 3 && !stopping) { console.log('已更新，重新啟動中控…'); setTimeout(run, 500); return; }
      process.exit(code == null ? 0 : code);
    });
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopping = true; if (child && child.exitCode === null) child.kill(sig); });
  run();
  return; // eslint-disable-line no-unreachable
}

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const updater = require('./update');
const makeMarket = require('./market');
const makeExtDb = require('./extdb');
const makeBg = require('./bg');
const makeLobby = require('./lobbyhub');

const PORT = Number(process.env.PORT) || 8787;
// 只接受本機連線
const HOST = '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DASHBOARD = path.join(__dirname, 'dashboard.html');
const USERSCRIPT = path.join(__dirname, 'szg-hub.user.js');
const AGENT_FILE = path.join(__dirname, 'agent.js');
const WORLD_FILE = path.join(__dirname, 'data', 'world.json');
const AVATAR_DIR = path.join(__dirname, 'data', 'avatars');
const avatarDiag = {}; // 全身照上傳失敗的原因（只放記憶體） // 角色全身照（站姿 GIF） // 遊戲的地圖／怪物／掉落表（由遊戲頁面上傳）

fs.mkdirSync(DATA_DIR, { recursive: true });


let updateInfo = { current: updater.localVersion(), latest: null, hasUpdate: false, notes: '', checkedAt: 0, error: '' };
async function checkUpdate() {
  try {
    const r = await updater.check();
    updateInfo = { current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, notes: r.notes, checkedAt: Date.now(), error: '' };
    if (r.hasUpdate) {
      const busy = updateBlockers().length > 0;
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

// 更新（重啟伺服器）要等哪些工作結束：掛機指令、打王不用等——它們在遊戲分頁裡跑，伺服器重啟不影響，
// 遊戲分頁也會等工作做完才重新整理換新腳本（打王會一直輪流，等它們會讓更新一直卡住）
function updateBlockers() { return db.jobs.filter(j => ACTIVE.has(j.status) && j.kind !== 'idle' && j.kind !== 'boss'); }
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
function isLocal(req) {
  // 經過 Tailscale serve（HTTPS 轉送到本機）的請求看起來也是 127.0.0.1，用轉送標頭分辨：一律當遠端、要通行碼
  if (req.headers['x-forwarded-for'] || req.headers['tailscale-user-login'] || req.headers['x-forwarded-proto']) return false;
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function tokenOk(req, url) {
  const t = req.headers['x-hub-token'] || url.searchParams.get('token') || '';
  const a = Buffer.from(String(t));
  // 手機（配對過的裝置）各自一組通行碼，可以個別撤銷
  const d = (db.mDevices || []).find(x => { const k = Buffer.from(x.token); return k.length === a.length && crypto.timingSafeEqual(k, a); });
  if (d && Date.now() - (d.seenAt || 0) > 60000) d.seenAt = Date.now();
  return !!d;
}

let db = { chars: {}, jobs: [], settings: { accountLabels: {}, mainCharId: null, presets: [], slotStats: {} } };
try {
  const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  db = { ...db, ...loaded, jobs: loaded.jobs || [], settings: { ...db.settings, ...(loaded.settings || {}) } };
} catch (_) { /* 第一次啟動 */ }
// v0.69.6：打王設定的修復。手機版以前存打王設定時，會用 /api/boss 整理過的 cfg（只有 sellOn、sellMaps，沒有 sell 規則）整個蓋掉，
// 掉落篩選就被關掉、規則不見。被蓋過的設定還留著 sellOn＝true 和算好的 sellMaps：把每張圖的結果還原成「個別調整」，實際賣的東西跟原本一樣
function bossSettingsFix() {
  const b = db.settings && db.settings.boss; if (!b || typeof b !== 'object') return false;
  let changed = false;
  if (!b.sell && b.sellOn === true && b.sellMaps && typeof b.sellMaps === 'object') {
    const over = {};
    for (const [m, x] of Object.entries(b.sellMaps)) if (x && Array.isArray(x.itemIds)) over[m] = { itemIds: x.itemIds.map(Number).filter(n => n > 0) };
    b.sell = { on: true, rule: {}, over, restored: Date.now() };
    changed = true;
  }
  if ('sellOn' in b) { delete b.sellOn; changed = true; } // 只是 /api/boss 給面板看的整理欄位，不該存進設定
  return changed;
}
bossSettingsFix();
// v0.71：去處規則（dest.js）。第一次啟動把野王掉落篩選、派工販售範本轉成去處規則（舊欄位保留不動，萬一要退回舊版還在）
const D = require('./dest.js');
function destMigrate() {
  if (db.settings.dest) return false;
  db.settings.dest = D.migrate(db.settings);
  return true;
}
if (destMigrate()) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(db)); } catch (_) {} }
// 完整的 world.json（去處規則要用掉落資料）：檔案有改才重讀
let _worldFull = { at: 0, w: {} };
function worldFull() {
  try { const st = fs.statSync(WORLD_FILE); if (st.mtimeMs !== _worldFull.at) _worldFull = { at: st.mtimeMs, w: JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8')) }; } catch (_) {}
  return _worldFull.w;
}
const destSellOf = (map, ctx) => { try { return D.sellOf(worldFull(), db.settings, map, ctx); } catch (e) { console.warn('[去處規則]', e); return null; } };

// ---- 知識王題庫：隨程式更新的 quiz-bank.json ＋ 各帳號作答時自動學到的（存在 data/state.json） ----
const QUIZ_FILE = path.join(__dirname, 'quiz-bank.json');
const qnorm = s => String(s || '').replace(/[\s　]+/g, '').replace(/[「」『』《》〈〉？?！!。，,、：:；;（）()【】"'“”‘’…·．.]/g, '').toLowerCase();
function quizStore() { return db.quiz || (db.quiz = { learned: {}, unknown: {}, log: [] }); }
function quizBank() {
  const bank = {};
  // 優先順序：冒險資料庫 < 內建題庫 < 你自己學到／更正的
  try { for (const x of extdb.quizList()) bank[qnorm(x.q)] = { q: x.q, options: x.options, answer: x.answer, src: 'ext' }; } catch (_) {}
  try {
    for (const x of JSON.parse(fs.readFileSync(QUIZ_FILE, 'utf8')).questions || []) if (x.q && x.answer) bank[qnorm(x.q)] = { q: x.q, options: x.options || [], answer: x.answer, src: 'bank' };
  } catch (_) {}
  // 共享題庫（大家的中控一起累積、遊戲公布的正解）：在內建之後、自己學到的之前
  if (quizShareOn()) for (const [k, x] of Object.entries((db.quizShared && db.quizShared.items) || {})) bank[k] = { q: x.q, options: x.options || [], answer: x.answer, src: 'shared', n: x.n };
  for (const [k, x] of Object.entries(quizStore().learned)) bank[k] = { ...x, src: 'learned' };
  return bank;
}
// ===== 共享題庫：Google 試算表＋Apps Script（tools/quiz-share.gs）=====
// 預設加入（公開版也是）；只上傳遊戲公布的正確答案＋匿名編號，不送角色名稱。設定：settings.quizShare = { on, url }
const QUIZ_SHARE_URL = 'https://script.google.com/macros/s/AKfycbxsdKpgb1W1YlFfwE0DpK0ZvWObMcsdnCLDr1WdURBG7MPApdaR8MPzkCZ2KQY2eiqKzQ/exec';
const quizShareCfg = () => { const x = (db.settings && db.settings.quizShare) || {}; return { on: x.on !== false, url: x.url || process.env.SZG_QUIZ_SHARE_URL || QUIZ_SHARE_URL }; };
// 只接受 Google Apps Script 的網址（測試時可以用環境變數指到本機的模擬）
const quizShareOn = () => { const c = quizShareCfg(); return c.on && (/^https:\/\/script\.google(usercontent)?\.com\//.test(c.url || '') || (!!process.env.SZG_QUIZ_SHARE_URL && c.url === process.env.SZG_QUIZ_SHARE_URL)); };
function quizShareState() {
  db.installId = db.installId || crypto.randomBytes(12).toString('hex');
  const st = db.quizShareState || (db.quizShareState = { queue: [], sent: {}, lastPull: 0, lastPush: 0, error: '', scanTo: 0 });
  return st;
}
// 遊戲公布正解時呼叫：已經在共享題庫而且一樣的不用再送；內建、冒險資料庫本來就一樣的也不送
function quizShareQueue(q, options, answer) {
  if (!quizShareOn() || !q || !answer || !Array.isArray(options) || !options.includes(answer)) return;
  const st = quizShareState(), k = qnorm(q), tag = k + '|' + qnorm(answer);
  if (st.sent[tag] || st.queue.some(x => x.key === k && qnorm(x.answer) === qnorm(answer))) return;
  st.queue = st.queue.filter(x => x.key !== k); // 同一題後來的答案取代前面的
  st.queue.push({ key: k, q: String(q).slice(0, 300), options: options.map(o => String(o).slice(0, 120)).slice(0, 8), answer: String(answer).slice(0, 120) });
  if (st.queue.length > 3000) st.queue.splice(0, st.queue.length - 3000);
}
let quizShareBusy = false;
async function quizShareSync(force) {
  if (!quizShareOn() || quizShareBusy) return;
  quizShareBusy = true;
  const st = quizShareState(), url = quizShareCfg().url;
  try {
    if (force || Date.now() - st.lastPull > 30 * 60e3) {
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { redirect: 'follow' });
      const j = await r.json();
      if (!j || !Array.isArray(j.items)) throw new Error('下載的格式不對');
      const items = {}; for (const x of j.items) if (x && x.q && x.answer) items[qnorm(x.q)] = { q: String(x.q), options: (x.options || []).map(String), answer: String(x.answer), n: Number(x.n) || 1 };
      const before = Object.keys((db.quizShared && db.quizShared.items) || {}).length;
      db.quizShared = { at: Date.now(), items };
      st.lastPull = Date.now();
      if (Object.keys(items).length !== before) quizLog(`共享題庫：下載 ${Object.keys(items).length} 題`);
      // 等你作答的題目如果共享題庫有了，就不用再等
      const uq = quizStore().unknown; for (const k of Object.keys(uq)) if (items[k]) delete uq[k];
    }
    // 補送自己學到的題目：面板選的答案，腳本會拿去遊戲作答；答錯會被遊戲正解蓋掉，
    // 所以放 30 分鐘還留著的就是遊戲認可的。選項缺的從其他題庫補（共享題庫要求答案在選項裡），
    // 暫時補不到的記在 optWait，之後每次同步再試
    const upTo = Date.now() - (Number(process.env.SZG_QUIZ_VERIFY_MS) || 30 * 60e3);
    const wait = new Set(st.optWait || []);
    if ((st.scanTo || 0) < upTo || wait.size) {
      let other = null; const L = quizStore().learned;
      for (const [k, x] of Object.entries(L)) {
        const at = x.at || 1; if (at > upTo || (at <= (st.scanTo || 0) && !wait.has(k))) continue;
        wait.delete(k);
        let opts = x.options || [];
        if (!opts.includes(x.answer)) {
          if (!other) { other = {}; try { for (const y of extdb.quizList()) other[qnorm(y.q)] = y.options || []; } catch (_) {} for (const [kk, y] of Object.entries((db.quizShared && db.quizShared.items) || {})) other[kk] = y.options || []; }
          const o = (other[k] || []).map(String), hit = o.find(v => qnorm(v) === qnorm(x.answer));
          if (!hit) { wait.add(k); continue; }
          opts = o; x.answer = hit; x.options = o;
        }
        quizShareQueue(x.q, opts, x.answer);
      }
      for (const k of wait) if (!L[k]) wait.delete(k);
      st.optWait = [...wait].slice(-1000); st.scanTo = Math.max(st.scanTo || 0, upTo);
    }
    if (st.queue.length && (force || Date.now() - st.lastPush > 5 * 60e3)) {
      const batch = st.queue.slice(0, 300);
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ install: db.installId, items: batch }), redirect: 'follow' });
      const j = await r.json();
      if (!j.ok) throw new Error('上傳失敗：' + (j.error || r.status));
      for (const x of batch) st.sent[x.key + '|' + qnorm(x.answer)] = 1;
      st.queue.splice(0, batch.length); st.lastPush = Date.now();
      if (j.added || j.voted) quizLog(`共享題庫：上傳 ${batch.length} 題（新題目 ${j.added}、投票 ${j.voted}）`);
    }
    st.error = '';
  } catch (e) { st.error = String(e.message || e).slice(0, 200); }
  finally { quizShareBusy = false; save(); }
}
setInterval(() => quizShareSync(false), 60e3);
setTimeout(() => quizShareSync(false), 15e3);
function quizLog(msg) { const q = quizStore(); q.log.push({ at: Date.now(), msg: String(msg).slice(0, 200) }); if (q.log.length > 200) q.log.splice(0, q.log.length - 200); }

let saveTimer = null;
const lootBuf = []; let lootSeq = 0;
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
market = makeMarket(() => db, save, id => charName(id), t => rollProfile(t));
// 冒險資料庫（外部）：題庫、道具／怪物資料與圖示
const extdb = makeExtDb(DATA_DIR, () => db.settings || {}, msg => { console.log('[資料庫] ' + msg); quizLog(msg); save(); });
extdb.schedule();
// 組隊功能已移除：之前留下的組隊工作直接刪掉（面板「最近的換圖進度」不再顯示）
db.jobs = db.jobs.filter(j => !j.partyRun);


// ================= 交易工作 =================
// 狀態：pending（等你確認）→ approved（排隊中）→ running → done / failed / cancelled
const ACTIVE = new Set(['approved', 'running']);
const ONLINE_MS = 90 * 1000; // 這段時間內有回報資料，才算對方在線

function codeOf(charId) { const s = db.chars[charId]; return s && s.playerCode; }
function onlineCode(code) {
  return liveTabs(code).length > 0 || Object.values(db.chars).some(s => s.playerCode === code && Date.now() - (s.receivedAt || 0) < ONLINE_MS);
}
// 某個帳號目前應該處理的工作：最早建立、還沒結束、而且牽涉到它的那一個
// 排程規則：
//  1. 某個工作一旦開始交易，就把雙方帳號「鎖」在這個工作上，直到它結束，才換下一個（避免中途被別的工作插隊）
//  2. 沒有鎖的時候，依「按下確認執行」的先後排隊（同時確認的，依建立順序）
const locks = {}; // 帳號代碼 -> 工作 id
function jobOrder(j) { return [j.approvedAt || j.createdAt, db.jobs.indexOf(j)]; }
// ===== 遊戲分頁 =====
// 同一個帳號可以開兩個遊戲分頁（A、B 角色各一個，兩隻同時在線）。每個分頁每 3 秒來問一次工作（/api/agent），
// 用這個記下「哪隻角色現在有自己的分頁」：工作交給要做事的那隻角色自己的分頁；它沒有分頁時，交給同帳號另一個分頁去顯示「等待」
const TAB_LIVE_MS = 90 * 1000; // 背景分頁的計時器會被瀏覽器放慢到約 1 分鐘一次，所以抓寬一點
const tabs = {}; // 帳號代碼 -> { 角色 id: { page, at, hidden, off } }
function seenTab(code, charId, q) {
  if (!code || !charId) return;
  const t = tabs[code] || (tabs[code] = {});
  t[charId] = { page: q.page || '', at: Date.now(), hidden: q.hidden === '1', off: q.off === '1', bg: q.bg === '1' };
}
// 背景執行（bg.js）的分頁：你自己的 Chrome 也開著同一隻角色時讓位，避免同一件事做兩次
function realTabFor(code, charId, page) {
  const t = tabOf(code, charId);
  return !!(t && !t.bg && t.page !== page);
}
function tabOf(code, charId) {
  const t = code && charId && tabs[code] && tabs[code][charId];
  return t && Date.now() - t.at < TAB_LIVE_MS ? t : null;
}
// 這個帳號現在開著的分頁（看得到的、最近問過的排前面）
function liveTabs(code) {
  return Object.entries(tabs[code] || {}).filter(([, t]) => Date.now() - t.at < TAB_LIVE_MS)
    .sort((a, b) => (a[1].hidden - b[1].hidden) || (b[1].at - a[1].at)).map(([id]) => id);
}
function charHasTab(charId) {
  const s = db.chars[charId];
  const code = (s && s.playerCode) || (Object.values(db.chars).find(x => x.playerCode && (x.accountChars || []).some(c => c.id === charId)) || {}).playerCode;
  return !!tabOf(code, charId);
}
// 這個工作在這個帳號要由哪隻角色做：背包工作＝那隻角色；交易＝送出方／收貨方；掛機指令＝指定的分頁（沒指定＝哪個都可以）
function needCharOf(j, code) {
  if (j.kind === 'idle') return j.needChar || null;
  if (BAG_KINDS.has(j.kind)) return j.fromCharId;
  if (!j.strictChar) return null;
  return j.fromCode === code ? j.fromCharId : j.toCharId;
}
// 交給哪個分頁：要做事的角色有分頁就給它；沒有的話交給同帳號的某個分頁（只會顯示「等待」），並記住，不要每次換
function routeOf(job, code) {
  const need = needCharOf(job, code);
  if (need && tabOf(code, need)) return need;
  job.route = job.route || {};
  const cur = job.route[code];
  if (cur && tabOf(code, cur)) return cur;
  const lt = liveTabs(code);
  if (!lt.length) return null;
  job.route[code] = lt[0];
  return lt[0];
}
const jobCmp = (a, b) => { const x = jobOrder(a), y = jobOrder(b); return x[0] - y[0] || x[1] - y[1]; };
// 帳號目前的交易（交易一次只能跟一個人）：鎖住的那個，否則最早確認的那個
function tradeHead(code) {
  const lockedId = locks[code];
  if (lockedId) {
    const lj = db.jobs.find(j => j.id === lockedId);
    if (lj && ACTIVE.has(lj.status)) return lj;
    delete locks[code];
  }
  return db.jobs.filter(j => !BAG_KINDS.has(j.kind) && ACTIVE.has(j.status) && (j.fromCode === code || j.toCode === code)).sort(jobCmp)[0] || null;
}
// 某個分頁現在要做的工作：交給它的工作裡，它自己就能做的排前面（依確認先後）；要等別隻角色的排最後
function headFor(code, charId) {
  const th = tradeHead(code);
  const mine = db.jobs.filter(j => j.kind !== 'idle' && ACTIVE.has(j.status) && (j.fromCode === code || j.toCode === code) && (BAG_KINDS.has(j.kind) || j === th))
    .sort(jobCmp).filter(j => routeOf(j, code) === charId);
  return mine.find(j => { const n = needCharOf(j, code); return !n || n === charId; }) || mine[0] || null;
}
// 舊的「帳號目前工作」：給面板與相容用（帳號任一分頁的頭一個）
function currentJobFor(code) {
  for (const id of liveTabs(code)) { const j = headFor(code, id); if (j) return j; }
  return tradeHead(code);
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

const BAG_KINDS = new Set(['sell', 'lock', 'unlock', 'idle', 'forge', 'equip', 'unequip']);
// 新種類的工作要遊戲分頁的腳本夠新才看得懂：還沒換上新腳本的，工作先排隊等，不交給它（避免「未知的工作類型」直接失敗）
const KIND_MIN_AGENT = { forge: '0.27.0', equip: '0.71.1', unequip: '0.71.1' };
const verLt = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
function agentTooOld(job, code, charId) {
  const k = KIND_MIN_AGENT[job.kind], need = job.minAgent && (!k || verLt(k, job.minAgent)) ? job.minAgent : k; if (!need) return false; // 工作可以自己要求更新的腳本（例如組隊大廳的加入／踢人）
  const snap = (charId && db.chars[charId]) || Object.values(db.chars).filter(s => s.playerCode === code).sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0))[0];
  return !snap || verLt(snap.scriptVersion, need) ? (snap ? snap.scriptVersion || '?' : '?') : false;
}
// 公會倉庫：存入、領取、查看都是「某隻角色在自己頁面執行」的背包工作
for (const k of ['guildDeposit', 'guildWithdraw', 'guildView', 'guildSell']) BAG_KINDS.add(k);
Object.assign(KIND_MIN_AGENT, { guildDeposit: '0.25.0', guildWithdraw: '0.25.0', guildView: '0.25.0', guildSell: '0.28.0' });
// 公倉楓幣／點數（存入或提領）：建立後一律待確認，要使用者在工作清單按確認（單一或全部確認）
BAG_KINDS.add('guildMoney'); KIND_MIN_AGENT.guildMoney = '0.34.1';
// 查看公倉：找一隻有自己分頁的角色（優先本尊），建立後直接排隊（只讀，不用確認）
function createGuildView(charId) {
  const live = Object.values(db.chars).filter(s => s.playerCode && tabOf(s.playerCode, s.char.id));
  const owner = (charId && db.chars[charId]) || live.find(s => s.char.id === db.settings.mainCharId) || live[0];
  if (!owner) throw new Error('沒有在線的遊戲分頁可以讀取公會倉庫');
  const old = db.jobs.find(j => j.kind === 'guildView' && ['pending', 'approved', 'running'].includes(j.status));
  if (old) return old;
  const job = {
    id: crypto.randomBytes(6).toString('hex'), kind: 'guildView', status: 'approved', createdAt: Date.now(), approvedAt: Date.now(),
    fromCharId: owner.char.id, fromName: owner.char.name, fromCode: owner.playerCode,
    toCharId: owner.char.id, toName: owner.char.name, toCode: owner.playerCode,
    batches: [{ items: [], gear: [], money: 0 }], batchIndex: 0, log: [], lastMsg: '',
  };
  db.jobs.push(job); save();
  return job;
}
// 自動存入：每 N 分鐘照「存入規則」的勾選與條件，替有自己遊戲分頁的角色建立存入工作（直接排隊，不用確認）
// 設定：settings.guildAuto = { mode: 'off' | 'preview' | 'deposit', everyMin }；勾選與條件：settings.guildDep（cats 是整類，例如「卷軸」「裝備」）
// 浮動判斷基準（跟面板 rollProfileDefault 同一套預設）：每個部位、武器種類看的素質不同
const WEAPON_PHYS = ['sword', 'twoSword', 'axe', 'twoAxe', 'mace', 'twoMace', 'spear', 'polearm', 'bow', 'crossbow', 'claw', 'dagger', 'knuckle', 'gun'];
const WEAPON_MAGIC = ['wand', 'staff'];
function rollProfile(t) {
  const p = (db.settings.rollProfiles || {})[t];
  if (p && Array.isArray(p.stats)) return { stats: p.stats, min: Number(p.min) || 0 };
  if (WEAPON_MAGIC.includes(t)) return { stats: ['incMAD'], min: 1 };
  if (WEAPON_PHYS.includes(t)) return { stats: ['incPAD'], min: 1 };
  return { stats: ['incSTR', 'incDEX', 'incINT', 'incLUK'], min: 1 }; // 防具、飾品（含手套）看四屬
}
function guildRollPass(g, dep) {
  const cs = (dep.conds || []).filter(c => c.k && (c.k === '_pass' || (c.min !== '' && c.min != null)));
  if (!cs.length) return true;
  if (!g.baseStats || !g.cleanStats) return !!dep.unknown;
  const d = k => (Number(g.cleanStats[k]) || 0) - (Number(g.baseStats[k]) || 0);
  const sum = () => [...new Set([...Object.keys(g.baseStats), ...Object.keys(g.cleanStats)])].reduce((t, k) => t + d(k), 0);
  const pass = () => { const p = rollProfile(g.gtype || g.type || g.weaponType || g.slot || ''); return p.stats.reduce((t, k) => t + d(k), 0) >= p.min; };
  const ok = cs.map(c => c.k === '_pass' ? pass() : (c.k === '_sum' ? sum() : d(c.k)) >= Number(c.min));
  return dep.mode === 'any' ? ok.some(Boolean) : ok.every(Boolean);
}
// 技能書獨立一類：舊腳本把技能書回報成「消耗」，用遊戲目錄（world.json 的 names：[名稱, 類別]）改回來
let _bookIds = { at: 0, set: new Set() };
function bookIds() {
  try { const st = fs.statSync(WORLD_FILE); if (st.mtimeMs !== _bookIds.at) { const w = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8')); _bookIds = { at: st.mtimeMs, set: new Set(Object.entries(w.names || {}).filter(([, n]) => n && n[1] === '技能書').map(([id]) => Number(id))) }; } } catch (_) {}
  return _bookIds.set;
}
const itemKind = it => (it.kind === '消耗' && bookIds().has(Number(it.itemId)) ? '技能書' : it.kind);
function guildPlanFor(snap, dep) {
  const names = new Set(dep.names || []), cats = new Set(dep.cats || []), keep = Math.max(0, Number(dep.keep) || 0);
  const ids = new Set((dep.ids || []).map(Number)); // v0.71：派工去處選「公倉」的道具（用道具編號）
  const items = [], gear = [];
  for (const it of snap.items || []) {
    if (it.loc !== '背包' || !(it.tradableQty > 0) || it.supply) continue;
    if (!names.has('i:' + it.key) && !cats.has(itemKind(it)) && !ids.has(Number(it.itemId))) continue;
    const qty = it.tradableQty - keep;
    if (qty > 0) items.push({ key: it.key, name: it.name, qty });
  }
  for (const g of snap.gear || []) {
    if (g.loc !== '背包' || g.locked || !g.tradable) continue;
    if (!names.has('g:' + g.name) && !cats.has('裝備') && !ids.has(Number(g.itemId))) continue;
    if (guildRollPass(g, dep)) gear.push({ uid: g.uid, name: g.name });
  }
  return { items, gear };
}
function guildLog(msg) {
  (db.guildLog || (db.guildLog = [])).push({ at: Date.now(), msg });
  if (db.guildLog.length > 120) db.guildLog.splice(0, db.guildLog.length - 120);
}
function guildAutoTick(force) {
  const a = db.settings.guildAuto || {};
  if (!a.mode || a.mode === 'off') return;
  const every = Math.max(10, Number(a.everyMin) || 30) * 60e3;
  if (!force && Date.now() - (db.guildAutoAt || 0) < every) return;
  db.guildAutoAt = Date.now();
  const dep = db.settings.guildDep || {};
  if (!(dep.names || []).length && !(dep.cats || []).length && !(dep.ids || []).length) { guildLog('自動存入：存入規則還沒設定要存什麼，略過'); save(); return; }
  const g = db.guild && db.guild.data;
  const usedKeys = new Set(Object.keys((g && g.items) || {}));
  let gearUsed = ((g && g.gear) || []).length;
  let made = 0, nItem = 0, nGear = 0;
  const lines = [];
  for (const snap of Object.values(db.chars)) {
    if (!snap.playerCode || Date.now() - (snap.receivedAt || 0) > ONLINE_MS) continue;
    if (!tabOf(snap.playerCode, snap.char.id)) continue; // 沒有自己分頁的角色（背景掛機）資料是舊的，也沒有人能替它存

    if (Array.isArray(dep.chars) && !dep.chars.includes(snap.char.id)) continue;
    const mine = db.jobs.filter(j => String(j.kind).startsWith('guild') && j.fromCharId === snap.char.id);
    if (mine.some(j => ['pending', 'approved', 'running'].includes(j.status))) continue;
    // 剛做完公倉工作、角色還沒回報新的背包資料：這份資料是舊的，等下一次
    const lastDone = Math.max(0, ...mine.filter(j => j.kind !== 'guildView').map(j => ((j.log || []).slice(-1)[0] || {}).at || 0));
    if (lastDone && (snap.receivedAt || 0) < lastDone + 2000) continue;
    const plan = guildPlanFor(snap, dep);
    if (!plan.items.length && !plan.gear.length) continue;
    if (g && g.capacity) {
      for (const it of plan.items) usedKeys.add(it.key);
      gearUsed += plan.gear.length;
      if (usedKeys.size > g.capacity.items || gearUsed > g.capacity.gear) { guildLog(`自動存入：公倉可能放不下（道具 ${usedKeys.size}/${g.capacity.items} 格、裝備 ${gearUsed}/${g.capacity.gear} 件），這次停止`); break; }
    }
    const q = plan.items.reduce((t, x) => t + x.qty, 0);
    nItem += q; nGear += plan.gear.length;
    lines.push(`${snap.char.name}（道具 ${q} 個、裝備 ${plan.gear.length} 件）`);
    if (a.mode === 'deposit') {
      const job = createBagJob({ kind: 'guildDeposit', fromCharId: snap.char.id, batches: [{ items: plan.items, gear: plan.gear }] });
      job.status = 'approved'; job.approvedAt = Date.now(); job.auto = true; jobLog(job, '自動存入規則建立，直接排隊執行');
      made++;
    }
  }
  if (lines.length) guildLog(`${a.mode === 'deposit' ? '自動存入' : '試跑（不會存）'}：${lines.join('、')}，共道具 ${nItem} 個、裝備 ${nGear} 件${a.mode === 'deposit' ? `，建立 ${made} 個工作` : ''}`);
  else if (force) guildLog('自動存入：目前沒有符合的東西');
  save();
}
setInterval(() => { try { guildAutoTick(false); } catch (e) { console.warn('[公倉自動存入]', e); } }, 60 * 1000);

// ================= 自動強化（v0.71.4） =================
// settings.forgeAuto = { mode: 'off'|'confirm'|'auto', everyMin, dailyCap（楓幣；auto 模式每天最多自動花多少）, rules: [{id, on, charId, gearName, item, count, stopAfter, stopOnFail, minSucc}] }
//   confirm：照規則建立強化工作，要在「工作」按確認才衝；auto：今天花的（含進行中的預估）加上這次最多會花的不超過上限就直接衝，超過的、詛咒卷軸一律等確認
// 只衝「沒進過強化工坊」的裝備（衝過的不會再自動衝第二次）、只用那隻角色背包裡的卷軸，一次一個工作
const FORGE_FEE = 100000;
function forgeAutoCfg() {
  const a = db.settings.forgeAuto || {};
  return { mode: ['confirm', 'auto'].includes(a.mode) ? a.mode : 'off', everyMin: Math.max(10, Number(a.everyMin) || 30), dailyCap: Math.max(0, Number(a.dailyCap) || 0), rules: Array.isArray(a.rules) ? a.rules : [] };
}
function forgeAutoLog(msg) { (db.forgeAutoLog || (db.forgeAutoLog = [])).push({ at: Date.now(), msg }); if (db.forgeAutoLog.length > 100) db.forgeAutoLog.splice(0, db.forgeAutoLog.length - 100); }
function dayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
// 今天強化花掉的楓幣（結果回報的）＋還在跑的強化工作的預估
function forgeSpentToday() {
  const t0 = dayStart();
  const done = (db.forgeLog || []).filter(r => r.at >= t0).reduce((t, r) => t + (Number(r.fee) || 0), 0);
  const running = db.jobs.filter(j => j.kind === 'forge' && ['approved', 'running'].includes(j.status) && (j.approvedAt || j.createdAt) >= t0).reduce((t, j) => t + (Number(j.estimate) || 0), 0);
  return done + running;
}
// 照一條規則挑要衝的裝備；cap＝最多能花多少（null＝不限）
function forgeAutoPlan(rule, cap) {
  const snap = db.chars[rule.charId]; if (!snap) return { why: '找不到角色資料' };
  const sc = (worldFull().scrolls || {})[rule.item]; if (!sc) return { why: '找不到這種卷軸的資料' };
  const forged = new Set((db.forgeLog || []).flatMap(r => (r.results || []).map(x => x.uid)));
  let scrolls = (snap.items || []).filter(i => i.key === rule.item && i.loc === '背包').reduce((t, i) => t + (Number(i.qty) || 0), 0);
  let money = Number(snap.char.money) || 0;
  const pieces = (snap.gear || []).filter(g => g.loc === '背包' && g.name === rule.gearName && !g.locked && g.slotsLeft > 0 && !forged.has(g.uid))
    .sort((a, b) => (a.plus || 0) - (b.plus || 0) || b.slotsLeft - a.slotsLeft);
  if (!pieces.length) return { why: '' };
  const use = []; let maxAtt = 0;
  for (const g of pieces) {
    const n = Math.min(10, g.slotsLeft, rule.count === 'all' || !rule.count ? g.slotsLeft : Number(rule.count) || 1);
    if (n > scrolls || n * FORGE_FEE > money || (cap != null && (maxAtt + n) * FORGE_FEE > cap)) continue;
    use.push({ g, n }); scrolls -= n; money -= n * FORGE_FEE; maxAtt += n;
  }
  if (!use.length) return { why: scrolls < 1 ? '卷軸用完了' : '楓幣或今天的上限不夠', pieces: pieces.length };
  const groups = [], bySlots = {};
  for (const { g } of use) (bySlots[g.slotsLeft] || (bySlots[g.slotsLeft] = [])).push(g.uid);
  for (const [sl, uids] of Object.entries(bySlots)) for (let i = 0; i < uids.length; i += 10) groups.push({ slots: Number(sl), uids: uids.slice(i, i + 10) });
  return { snap, sc, use, groups, maxFee: maxAtt * FORGE_FEE, pieces: pieces.length };
}
function forgeAutoTick(force) {
  const a = forgeAutoCfg();
  if (a.mode === 'off') return;
  if (!force && Date.now() - (db.forgeAutoAt || 0) < a.everyMin * 60e3) return;
  db.forgeAutoAt = Date.now();
  for (const rule of a.rules.filter(r => r && r.on !== false && r.charId && r.gearName && r.item)) {
    const snap = db.chars[rule.charId], name = snap ? snap.char.name : rule.charId;
    if (!snap || !snap.playerCode || !tabOf(snap.playerCode, snap.char.id)) continue; // 要有自己的遊戲分頁才衝得了
    if (db.jobs.some(j => j.kind === 'forge' && j.fromCharId === rule.charId && ['pending', 'approved', 'running'].includes(j.status))) continue; // 一次一個
    // 剛衝完、角色還沒回報新的背包：等下一次
    const last = (db.forgeLog || []).filter(r => r.charId === rule.charId).slice(-1)[0];
    if (last && (snap.receivedAt || 0) < last.at + 2000) continue;
    const cursed = (((worldFull().scrolls || {})[rule.item]) || [])[3] > 0;
    const left = a.dailyCap - forgeSpentToday();
    let pl = forgeAutoPlan(rule, null), approve = false;
    if (!pl.use) continue;
    if (a.mode === 'auto' && !cursed) { const fit = forgeAutoPlan(rule, Math.max(0, left)); if (fit.use) { pl = fit; approve = true; } }
    const forge = { item: rule.item, itemName: pl.sc[0], rate: pl.sc[2], cursed: pl.sc[3], count: rule.count || 'all', stopAfter: Number(rule.stopAfter) || 0, stopOnFail: !!rule.stopOnFail, minSucc: Number(rule.minSucc) || 0, groups: pl.groups };
    let job;
    try { job = createBagJob({ kind: 'forge', fromCharId: rule.charId, estimate: pl.maxFee, batches: [{ items: [], gear: pl.use.map(x => ({ uid: x.g.uid, name: x.g.name })), forge }] }); }
    catch (e) { forgeAutoLog(`${name}：沒辦法建立工作（${e.message}）`); continue; }
    job.auto = true;
    if (approve) { job.status = 'approved'; job.approvedAt = Date.now(); }
    const why = a.mode === 'auto' && !approve ? (cursed ? '（詛咒卷軸，一律等你確認）' : `（今天的上限只剩 ${Math.max(0, Math.round(left / 1e4))} 萬，等你確認）`) : '';
    const msg = `${name}：${rule.gearName} ${pl.use.length} 件、${pl.sc[0]}、最多 ${Math.round(pl.maxFee / 1e4)} 萬楓幣 → ${approve ? '直接開始衝' : '建立工作，等你確認'}${why}`;
    jobLog(job, '自動強化規則建立' + (approve ? '，在今天的楓幣上限內，直接排隊執行' : '，請確認後執行'));
    forgeAutoLog(msg);
  }
  save();
}
setInterval(() => { try { forgeAutoTick(false); } catch (e) { console.warn('[自動強化]', e); } }, 60 * 1000);

// ================= 掛機控制 =================
// 指令（開始／暫停／重新開始）依帳號分組，交給那個帳號目前在線的遊戲頁面執行；
// 同帳號的第二隻角色也可以直接控制（遊戲允許用 characterId 指定）。
const IDLE_ACTIONS = new Set(['start', 'stop', 'restart', 'switch', 'wake', 'map', 'autosell', 'cfg']);
// v0.72：角色抽屜的能力點、技能、掛機設定（cfg）：只放行這幾種遊戲指令，欄位都檢查過；遊戲自己還會再檢查一次
const CFG_STATS = ['str', 'dex', 'int', 'luk'], CFG_SETTINGS = ['autoSkills', 'autoStats', 'autoPotion', 'autoStartOnMap'];
const int = (v, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const skillId = v => (typeof v === 'string' || typeof v === 'number') && /^[\w-]{1,40}$/.test(String(v)) ? String(v) : null;
function cleanCfg(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.type === 'statBatch') {
    const al = (Array.isArray(c.allocations) ? c.allocations : []).map(a => ({ stat: CFG_STATS.includes(a.stat) ? a.stat : null, amount: int(a.amount, 1, 999), from: int(a.from, 0, 9999) })).filter(a => a.stat && a.amount && a.from != null);
    return al.length ? { type: 'statBatch', includeSocial: false, allocations: al.slice(0, 4) } : null;
  }
  if (c.type === 'learnBatch') {
    const al = (Array.isArray(c.allocations) ? c.allocations : []).map(a => ({ skill: skillId(a.skill), amount: int(a.amount, 1, 30), from: int(a.from, 0, 30) })).filter(a => a.skill && a.amount && a.from != null);
    return al.length ? { type: 'learnBatch', allocations: al.slice(0, 60) } : null;
  }
  if (c.type === 'statPlan') {
    const plan = (Array.isArray(c.plan) ? c.plan : []).map(r => ({ stat: CFG_STATS.includes(r.stat) ? r.stat : null, target: int(r.target, 4, 1999) })).filter(r => r.stat && r.target);
    return { type: 'statPlan', plan: plan.slice(0, 8), enabled: !!c.enabled };
  }
  if (c.type === 'skillPlan') {
    const plan = (Array.isArray(c.plan) ? c.plan : []).map(r => ({ skill: skillId(r.skill), target: int(r.target, 1, 30) })).filter(r => r.skill && r.target);
    return { type: 'skillPlan', plan: plan.slice(0, 60), enabled: !!c.enabled };
  }
  if (c.type === 'setting') return CFG_SETTINGS.includes(c.key) ? { type: 'setting', key: c.key, value: !!c.value } : null;
  if (c.type === 'autoBuff' || c.type === 'skill') return skillId(c.skill) ? { type: c.type, skill: skillId(c.skill) } : null;
  return null;
}
// 遊戲的地圖自動販售設定：{ enabled, itemIds }（遊戲只接受角色「目前所在地圖」的設定）
const cleanSell = x => x && typeof x === 'object' ? { enabled: !!x.enabled, itemIds: [...new Set((x.itemIds || []).map(Number).filter(n => Number.isFinite(n) && n > 0))].slice(0, 400) } : undefined;
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
function routeForAccount(accountId, preferChar) {
  // 優先：指定的角色有自己的分頁 → 它；否則帳號開著的分頁（看得到的優先）；都沒有就用最近回報的
  const list = Object.values(db.chars).filter(s => s.accountId === accountId && s.playerCode)
    .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  if (!list.length) return null;
  const code = list[0].playerCode;
  if (preferChar && tabOf(code, preferChar) && db.chars[preferChar]) return db.chars[preferChar];
  const lt = liveTabs(code).map(id => db.chars[id]).filter(Boolean);
  return lt[0] || list[0];
}
function createIdleJobs(body) {
  const targets = (body.targets || []).filter(t => t && t.charId && IDLE_ACTIONS.has(t.action));
  if (!targets.length) throw new Error('沒有選擇角色');
  const byAcc = {}, skipped = [];
  for (const t of targets) {
    const acc = accountOfChar(t.charId);
    if (!acc) continue;
    // 已經有自己分頁的角色不用切換（切了反而會讓兩個分頁變成同一隻）
    if (t.action === 'switch' && charHasTab(t.charId)) { skipped.push(`${charName(t.charId)} 已經有自己的分頁`); continue; }
    if (t.action === 'switch') {
      // 切換角色：每個帳號只能有一隻是目前角色，同帳號勾了兩隻就以最後一隻為準
      byAcc[acc] = (byAcc[acc] || []).filter(x => x.action !== 'switch');
      byAcc[acc].push({ charId: t.charId, name: charName(t.charId), action: 'switch' });
      continue;
    }
    if (t.action === 'wake') {
      // 領取離線收益是整個頁面的動作：每個分頁（每隻有分頁的角色）做一次
      if (!(byAcc[acc] || []).some(x => x.action === 'wake' && x.charId === t.charId)) (byAcc[acc] || (byAcc[acc] = [])).push({ charId: t.charId, name: charName(t.charId), action: 'wake' });
      continue;
    }
    if (t.action === 'map') {
      if (!t.map) continue;
      (byAcc[acc] || (byAcc[acc] = [])).push({ charId: t.charId, name: charName(t.charId), action: 'map', map: String(t.map), mapName: String(t.mapName || t.map).slice(0, 40), sell: cleanSell(t.sell) });
      continue;
    }
    if (t.action === 'cfg') {
      const cmd = cleanCfg(t.cmd); if (!cmd) throw new Error('設定的內容不正確');
      (byAcc[acc] || (byAcc[acc] = [])).push({ charId: t.charId, name: charName(t.charId), action: 'cfg', cmd, label: String(t.label || cmd.type).slice(0, 80) });
      continue;
    }
    if (t.action === 'autosell') {
      if (!t.map || !t.sell) continue;
      (byAcc[acc] || (byAcc[acc] = [])).push({ charId: t.charId, name: charName(t.charId), action: 'autosell', map: String(t.map), mapName: String(t.mapName || t.map).slice(0, 40), sell: cleanSell(t.sell) });
      continue;
    }
    (byAcc[acc] || (byAcc[acc] = [])).push({ charId: t.charId, name: charName(t.charId), action: t.action });
    db.settings.idleLast = { ...(db.settings.idleLast || {}), [t.charId]: { action: t.action, at: Date.now(), by: 'panel' } };
  }
  // 再依「交給哪個分頁」分組：角色有自己的分頁 → 交給它自己（畫面馬上更新；領取離線收益只能由自己的分頁做）；
  // 沒有分頁的 → 帳號的任一分頁代做（遊戲允許用 characterId 指定同帳號的另一隻）；切換＝換掉某個分頁顯示的角色
  const groups = [];
  for (const [acc, list] of Object.entries(byAcc)) {
    const by = {};
    for (const t of list) {
      const own = t.action !== 'switch' && charHasTab(t.charId) ? t.charId : '';
      if (t.action === 'wake' && !own) continue; // 沒有分頁的角色沒有畫面可以「繼續」
      (by[own] || (by[own] = [])).push(t);
    }
    for (const [own, ts] of Object.entries(by)) groups.push([acc, own, ts]);
  }
  const jobs = [];
  for (const [acc, own, list] of groups) {
    const route = routeForAccount(acc, own);
    if (!route) continue;
    if (list.some(t => t.action === 'switch') && db.jobs.some(j => j.kind !== 'idle' && ACTIVE.has(j.status) && (j.fromCode === route.playerCode || j.toCode === route.playerCode) && routeOf(j, route.playerCode) === route.char.id)) {
      throw new Error(`${route.char.name} 的分頁有交易／背包工作還沒完成，先不要切換角色`);
    }
    const job = {
      id: crypto.randomBytes(6).toString('hex'), kind: 'idle', status: 'approved', createdAt: Date.now(), approvedAt: Date.now(),
      fromCharId: route.char.id, fromName: route.char.name, fromCode: route.playerCode,
      toCharId: route.char.id, toName: route.char.name, toCode: route.playerCode,
      needChar: own || null,
      batches: [{ targets: list, items: [], gear: [], money: 0 }], batchIndex: 0, log: [], lastMsg: '',
      ...(list.some(t => t.action === 'cfg') ? { minAgent: '0.72.0' } : {}),
    };
    jobLog(job, '已送出：' + list.map(t => `${t.name} ${({ start: '開始掛機', stop: '暫停掛機', restart: '重新開始掛機', switch: '切換為目前角色', wake: '領取離線掛機收益', cfg: t.label || '', map: '前往 ' + (t.mapName || '') + (t.sell ? '（套用自動販售）' : ''), autosell: '套用 ' + (t.mapName || '') + ' 的自動販售' })[t.action]}`).join('、'));
    db.jobs.push(job);
    jobs.push(job);
  }
  if (!jobs.length) throw new Error(skipped.length ? skipped.join('、') + '，不用切換' : '找不到可執行的遊戲頁面（那些帳號的遊戲分頁要開著）');
  if (skipped.length) jobs.skipped = skipped;
  save();
  return jobs;
}
function idleLog(entry) {
  db.idleLog = db.idleLog || [];
  db.idleLog.push({ at: Date.now(), ...entry });
  if (db.idleLog.length > 200) db.idleLog.splice(0, db.idleLog.length - 200);
  save();
}
// ===== 死亡原因與復活次數 =====
// agent 從遊戲同步回應判斷死亡（hp<=0、deaths 增加、deathAt 改變）並 POST /api/death {ev:'death'|'revive'}。
// db.deaths = { log: [{at, key, charId, name, lv, map, mapName, boss, xpLoss, gameDeaths, revivedAt, revivedBy}], since: {角色: 開始計算時間} }（v0.68.0 的舊紀錄還有 cause、killer、top… 欄位，面板不再顯示）
function deathDb() { const d = db.deaths || (db.deaths = {}); d.log = d.log || []; d.since = d.since || {}; return d; }
function deathEvent(e) {
  const d = deathDb(), now = Date.now(), id = String(e.charId || '');
  if (!id) return;
  if (!d.since[id]) d.since[id] = now;
  if (e.ev === 'death') {
    const at = Number(e.at) || now;
    // 同一次死亡可能從兩個分頁回報（同帳號）：遊戲死亡時間一樣、或 30 秒內的算同一次
    const key = Number(e.key) || 0;
    if (d.log.some(x => x.charId === id && (x.key && key ? x.key === key : Math.abs(x.at - at) < 30000))) return;
    const str = (v, n) => String(v == null ? '' : v).slice(0, n);
    d.log.push({ at, key, charId: id, name: charName(id), lv: Number(e.lv) || 0, map: str(e.map, 40), mapName: str(e.mapName, 40), boss: str(e.boss, 40),
      xpLoss: Number(e.xpLoss) || 0, gameDeaths: e.gameDeaths == null ? null : Number(e.gameDeaths) });
    if (d.log.length > 1000) d.log.splice(0, d.log.length - 1000);
  } else if (e.ev === 'revive') {
    const x = [...d.log].reverse().find(l => l.charId === id);
    if (!x || x.revivedAt || now - x.at > 6 * 3600e3) return; // 一次死亡只算一次復活
    x.revivedAt = now; x.revivedBy = ['hub', 'game'].includes(e.by) ? e.by : 'other';
  }
  save();
}
function deathSummary() {
  const d = deathDb(), now = Date.now(), by = {};
  for (const x of d.log) {
    const s = by[x.charId] || (by[x.charId] = { charId: x.charId, name: charName(x.charId), deaths: 0, d24: 0, d1: 0, revives: 0, rv: { hub: 0, game: 0, other: 0 }, pl: {}, last: null });
    s.deaths++; if (now - x.at < 24 * 3600e3) s.d24++; if (now - x.at < 3600e3) s.d1++;
    if (x.revivedAt) { s.revives++; s.rv[x.revivedBy || 'other']++; }
    const k = (x.boss ? '王|' + x.boss + '|' : '圖||') + (x.mapName || x.map || '?');
    const p = s.pl[k] || (s.pl[k] = { map: x.mapName || x.map || '', boss: x.boss || '', n: 0, last: 0 }); p.n++; p.last = x.at;
    s.last = x;
  }
  const chars = Object.values(by).map(({ pl, ...s }) => ({ ...s, since: d.since[s.charId] || 0, places: Object.values(pl).sort((a, b) => b.n - a.n || b.last - a.last) })).sort((a, b) => b.d24 - a.d24 || b.deaths - a.deaths);
  return { chars, log: d.log.slice(-200).reverse(), since: d.since };
}
function createBagJob(body) {
  const owner = db.chars[body.fromCharId];
  if (!owner) throw new Error('找不到角色資料');
  if (!owner.playerCode) throw new Error('角色還沒回報 12 碼 ID，請先更新腳本並打開遊戲頁面');
  const b = (body.batches || [])[0] || {};
  if (body.kind === 'guildMoney') {
    const mesos = Math.floor(Number(b.mesos) || 0), cash = Math.floor(Number(b.cash) || 0), op = b.op === 'withdraw' ? 'withdraw' : 'deposit';
    if (!(mesos > 0) && !(cash > 0)) throw new Error('沒有填楓幣或點數的金額');
    if (mesos < 0 || cash < 0) throw new Error('金額不能是負數');
    const job = {
      id: crypto.randomBytes(6).toString('hex'), kind: 'guildMoney', status: 'pending', createdAt: Date.now(),
      fromCharId: owner.char.id, fromName: owner.char.name, fromCode: owner.playerCode,
      toCharId: owner.char.id, toName: owner.char.name, toCode: owner.playerCode,
      batches: [{ items: [], gear: [], money: 0, op, mesos, cash }], batchIndex: 0, log: [], lastMsg: '',
    };
    db.jobs.push(job); save();
    return job;
  }
  if (!(b.items || []).length && !(b.gear || []).length) throw new Error('沒有選擇任何物品');
  const job = {
    id: crypto.randomBytes(6).toString('hex'), kind: body.kind, status: 'pending', createdAt: Date.now(),
    fromCharId: owner.char.id, fromName: owner.char.name, fromCode: owner.playerCode,
    toCharId: owner.char.id, toName: owner.char.name, toCode: owner.playerCode,
    batches: [{ items: b.items || [], gear: b.gear || [], money: 0, ...(body.kind === 'forge' && b.forge ? { forge: b.forge } : {}) }], batchIndex: 0, log: [], lastMsg: '',
    estimate: Number(body.estimate) || 0,
  };
  // v0.71.1：穿上／脫下是在角色抽屜看過比較、按了確認才送的，直接排隊（一次一件、可以再脫下來，不用到工作清單再確認一次）
  if ((body.kind === 'equip' || body.kind === 'unequip') && body.approve) {
    if ((b.gear || []).length !== 1) throw new Error('一次只能穿上或脫下一件裝備');
    job.status = 'approved'; job.approvedAt = Date.now();
  }
  db.jobs.push(job);
  save();
  return job;
}

function createJob(body) {
  if (body.kind === 'idle') throw new Error('掛機指令請用 /api/idle');
  if (body.kind === 'guildView') return createGuildView(body.fromCharId);
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

// 總覽「需要處理」用的小摘要：公倉用量、知識王還沒答的題目（不必等使用者打開那一頁）
function alertSummary() {
  const out = {};
  const g = db.guild && db.guild.data;
  if (g && g.capacity) out.guild = { items: Object.values(g.items || {}).filter(n => n > 0).length, itemsCap: g.capacity.items || 0, gear: (g.gear || []).length, gearCap: g.capacity.gear || 0, at: db.guild.at || 0 };
  const st = db.quiz && db.quiz.unknown;
  if (st) { const now = Date.now(); const xs = Object.values(st).filter(u => now - (u.at || 0) < 12 * 3600e3); out.quiz = { n: xs.length, by: [...new Set(xs.map(u => u.by).filter(Boolean))].slice(0, 6) }; }
  return out;
}
// 總覽「自動化」總表：各自動功能最後一次做事的時間與訊息（設定本身在 settings 裡）
function automationInfo() {
  const last = arr => { const x = (arr || [])[(arr || []).length - 1]; return x ? { at: x.at, msg: String(x.msg || '').slice(0, 120), name: x.name || '' } : null; };
  const m = db.market || {};
  return {
    idle: last(db.idleLog), gear: last(db.gearLog), guild: last(db.guildLog), quiz: last(db.quiz && db.quiz.log),
    market: { lastScan: m.lastFull || 0, list: last(m.listLog) }, boss: last(db.boss && db.boss.log),
    update: { at: (updateInfo && updateInfo.checkedAt) || 0, error: (updateInfo && updateInfo.error) || '' },
  };
}
// ===== 輪流打野王 =====
// 遊戲機制（2026-11-20 讀遊戲程式碼＋實際資料核對）：
//  - 19 張有野外首領的地圖（catalog.maps[].bossSpawns），每隻王有自己的重生時間；王是「每隻角色一份」（solo:角色:地圖），
//    同一個隊伍共用一份（party:隊伍:地圖）
//  - 同步帶 includeBossRespawns:true（＋fullSync）會回 bossRespawns：[{map, mob, name, instanceId, deadline, spawned, available}]
//    available＝王已死、可以付費重生（＝冷卻中，deadline 是預計重生時間）；deadline 0／已過且 available=false＝進地圖就會出現
//  - 戰鬥中的怪在同步回應的 enemies（{id, hp, maxHp}）；離開首領地圖時王的血量與冷卻會保留
//  - 付費重生（bossRespawn，10 點或 1000 萬楓幣）不使用
// settings.boss = { mode: off|preview|auto, charMobs, estMax(分), stuckMin(分：血量多久沒降就離開), maxMin(分：安全上限), sell:{on, rule, over}, sellMaps:{地圖:{enabled,itemIds}}（面板依規則算好的） … }
// v0.69：visitMax（每次最多打 N 分鐘）不再用——打很久的王（海怒斯、噴火龍、格瑞芬多）會打到一半被時間到、連續打拉去別的王
// db.boss = { state: {角色: {at, offset, list}}, hp: {instanceId: {hp, maxHp, at}}, last: {角色|mob: {at, result}}, home: {角色: map}, log, seen }
// 0.43.0：換圖後開始掛機、掛機設定組合。舊腳本的分頁會先重新整理換新腳本再接工作（避免舊腳本打王不開掛機、站著發呆）
BAG_KINDS.add('boss'); KIND_MIN_AGENT.boss = '0.69.3'; // 0.69.1：強制停止；0.69.2：原本的地圖判斷；0.69.3：隊伍同進退 // 0.69：血量有在掉就打到死、到王的地圖套用自動販售
const BOSS_RETRY_MS = 30 * 60 * 1000;   // 沒打成功（逾時、倒下、王不在）的同一隻王，30 分鐘內不再去
const BOSS_STATE_STALE = 20 * 60 * 1000; // 王的狀態超過這麼久沒更新就先不派
// 每隻角色各自要打的王：settings.boss.charMobs = {角色: ['*']（全部）| [王 id…]}，空的／沒有＝不打。
// 舊設定（chars＋共用的 mobs）沒有 charMobs 時自動換算；chars 由 charMobs 推出來（agent 的 /api/boss/need 用）
function bossCharMobs(b) {
  const cm = {};
  if (b.charMobs && typeof b.charMobs === 'object') { for (const [k, v] of Object.entries(b.charMobs)) if (Array.isArray(v) && v.length) cm[k] = v.map(String); }
  else for (const [k, on] of Object.entries(b.chars || {})) if (on) cm[k] = Array.isArray(b.mobs) ? b.mobs.map(String) : ['*'];
  return cm;
}
function bossCfg() {
  const b = db.settings.boss || {}, charMobs = bossCharMobs(b);
  return { mode: b.mode || 'off', charMobs, chars: Object.fromEntries(Object.keys(charMobs).map(k => [k, true])), mobs: null,
    // together＝同隊一起打同一隻；split＝保留隊伍但各自打不同隻；mixed＝togetherMobs 裡的王整隊一起打，其他的各自分開打（先分開、再一起）
    partyMode: ['split', 'mixed'].includes(b.partyMode) ? b.partyMode : 'together',
    togetherMobs: Array.isArray(b.togetherMobs) ? b.togetherMobs.map(String) : [],
    // v0.69.3：每個隊伍各自的打法 {隊員 id 排序後用逗號接起來: {mode, togetherMobs}}；沒設的隊伍用上面的 partyMode／togetherMobs
    parties: b.parties && typeof b.parties === 'object' ? b.parties : {},
    chain: b.chain !== false,                                    // 連續打：打完一隻直接去下一隻，全部打完才回練功圖
    estMax: Number(b.estMax) > 0 ? Number(b.estMax) : 15,
    stuckMin: Math.min(30, Math.max(1, Number(b.stuckMin) || 3)), maxMin: Math.min(600, Math.max(10, Number(b.maxMin) || 180)),
    sellOn: !!(db.settings.dest || {}).boss, sellMaps: b.sellMaps && typeof b.sellMaps === 'object' ? b.sellMaps : {}, // v0.71：掉落篩選＝去處規則的「野王地圖套用」
    presetBoss: [1, 2, 3].includes(Number(b.presetBoss)) ? Number(b.presetBoss) : 0,   // 0＝不切換
    presetTrain: [1, 2, 3].includes(Number(b.presetTrain)) ? Number(b.presetTrain) : 0 }; // 0＝換回出發前用的那套
}
function bossDb() {
  const b = db.boss || (db.boss = {});
  for (const k of ['state', 'hp', 'last', 'home', 'seen']) b[k] = b[k] || {};
  b.log = b.log || [];
  return b;
}
// 新出現的王：b.known = {mob: {at, name, ack}}。第一次建立時，目前有的王都算舊的，只有 BOSS_ADDED 裡的
// （2026-11-25 遊戲新增：海怒斯、噴火龍、格瑞芬多）算新的；之後角色回報裡第一次出現的王都算新的
const BOSS_ADDED = ['gms8510000', 'gms8180000', 'gms8180001'];
function bossKnow(list) {
  const b = bossDb(), first = !b.known, now = Date.now();
  if (first) b.known = {};
  let changed = false;
  for (const r of list) {
    if (!r.mob || b.known[r.mob]) continue;
    b.known[r.mob] = { at: first && !BOSS_ADDED.includes(r.mob) ? 0 : now, name: r.name || '' }; changed = true;
  }
  return changed || first;
}
function bossNewList() {
  loadWorldIndex();
  // 打王關著時角色不會回報王的狀態：用之前存下來的狀態建立（不然新的王永遠不會出現）
  if (!bossDb().known) { const all = Object.values(bossDb().state).flatMap(st => st.list || []); if (all.length) { bossKnow(all); save(); } }
  const k = bossDb().known || {}, now = Date.now();
  return Object.entries(k).filter(([, v]) => v.at && !v.ack && now - v.at < 14 * 24 * 3600e3)
    .map(([mob, v]) => ({ mob, name: (worldMobs[mob] || {}).name || v.name || mob, lv: (worldMobs[mob] || {}).lv || 0, at: v.at })).sort((a, b) => a.lv - b.lv);
}
function bossLog(charId, msg) {
  const b = bossDb();
  b.log.push({ at: Date.now(), charId, name: charId ? charName(charId) : '', msg: String(msg).slice(0, 200) });
  if (b.log.length > 200) b.log.splice(0, b.log.length - 200);
  save();
}
let worldMobs = null, worldMapNames = null, worldReadAt = 0;
function loadWorldIndex() {
  if (worldMobs && Object.keys(worldMobs).length && Date.now() - worldReadAt < 5 * 60 * 1000) return;
  worldReadAt = Date.now();
  try {
    const w = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'));
    worldMobs = Object.fromEntries((w.mobs || []).map(m => [m.id, m]));
    worldMapNames = Object.fromEntries((w.maps || []).map(m => [m.id, m.name]));
  } catch (_) { worldMobs = worldMobs || {}; worldMapNames = worldMapNames || {}; }
}
const bossMapSet = () => new Set(Object.values(bossDb().state).flatMap(st => (st.list || []).map(r => r.map)));
const charDps = charId => { const d = (db.dps || {})[charId]; return d && Date.now() - (d.receivedAt || 0) < 6 * 3600e3 ? ((d.w60 && d.w60.dps) || (d.w5 && d.w5.dps) || 0) : 0; };
// 某隻角色每隻王的狀態（面板顯示與排程共用）
// allow：這一組（隊伍）可以打的王（隊員各自勾的合起來，'*'＝全部）；沒給就用這隻自己的
function bossRows(charId, dpsOverride, allow) {
  loadWorldIndex();
  const c = bossCfg(), b = bossDb(), st = b.state[charId];
  if (!allow) allow = new Set(c.charMobs[charId] || []);
  if (!st) return [];
  const now = Date.now(), srvNow = now + (st.offset || 0), dps = dpsOverride != null ? dpsOverride : charDps(charId);
  return (st.list || []).map(r => {
    const mob = worldMobs[r.mob] || {};
    const cooling = !!(r.available && r.deadline > srvNow);
    const ready = !cooling && (r.spawned || !(r.deadline > srvNow));
    const h = b.hp[r.instanceId];
    const maxHp = (h && h.maxHp) || mob.hp || 0;
    const hp = h && now - h.at < 7 * 24 * 3600e3 ? h.hp : maxHp;
    const estSec = dps > 0 && hp > 0 ? Math.round(hp / dps) : null;
    const last = b.last[charId + '|' + r.mob] || null;
    const denied = !!(allow.skip && allow.skip.has(r.mob)); // v0.69.4：隊伍設定這隻不打
    const selected = (allow.has('*') || allow.has(r.mob)) && !denied;
    let skip = '';
    if (!selected) skip = denied ? '隊伍設定不打' : '沒有勾選';
    else if (cooling) skip = '冷卻中';
    else if (estSec != null && estSec > c.estMax * 60) skip = `預估 ${Math.ceil(estSec / 60)} 分鐘才打得死，超過 ${c.estMax} 分鐘`;
    else if (last && last.result !== 'killed' && last.result !== 'cooling' && now - last.at < BOSS_RETRY_MS) skip = `${Math.ceil((BOSS_RETRY_MS - (now - last.at)) / 60000)} 分鐘後再試（上次：${BOSS_RESULT[last.result] || last.result}）`;
    return { mob: r.mob, name: r.name || mob.name || r.mob, map: r.map, mapName: r.mapName || worldMapNames[r.map] || r.map, instanceId: r.instanceId, party: /^party:/.test(r.instanceId || ''),
      lv: mob.lv || 0, hp, maxHp, hpKnown: !!h, ready, cooling, remainMs: cooling ? r.deadline - srvNow : 0, estSec, selected, last, skip };
  });
}
const BOSS_RESULT = { killed: '打死了', timeout: '時間到還沒打死', dead: '角色倒下', absent: '王不在場上', stuck: '打不動（血量沒有下降）', moved: '中途被換到別的地圖', cooling: '還在冷卻', error: '出錯', stopped: '強制停止' };
function bossBusy(charId) { return db.jobs.some(j => ACTIVE.has(j.status) && (j.fromCharId === charId || j.toCharId === charId)); }
// 隊伍：每隻角色回報時帶著遊戲的 party（{code, members:[{id, name, …}]}）。同隊伍共用同一份野王，
// 所以排程以「隊伍」為單位：勾了其中一隻，同隊的一起挑同一隻王出發（預估用隊員 DPS 加總），各自打完回自己原本的地圖
function partyMap() {
  const of = {}, at = {}, members = {}, leader = {}; // leader[隊伍代碼]＝遊戲裡的隊長（隊員資料的 leader 旗標）
  for (const snap of Object.values(db.chars)) {
    const p = snap.party && snap.party.party; if (!p || !p.code || !Array.isArray(p.members) || p.members.length < 2) continue;
    if (Date.now() - (snap.receivedAt || 0) > 30 * 60 * 1000) continue;
    for (const m of p.members) {
      if (!m || !m.id) continue;
      if (!at[m.id] || snap.receivedAt > at[m.id]) { at[m.id] = snap.receivedAt; of[m.id] = p.code; }
      if (m.leader === true) leader[p.code] = m.id;
    }
  }
  // 補判斷（v0.69.3）：遊戲回報的野王 instanceId 是 party:隊伍代碼:地圖（同隊共用一份王）。角色回報的隊伍資料缺了或太舊時，
  // 用它認出同一隊（以前會被當成各自一人，兩隻挑不同的王分開去打）
  const bs = (db.boss || {}).state || {};
  for (const [id, st] of Object.entries(bs)) {
    const snap = db.chars[id]; if (!snap || of[id] || Date.now() - (st.at || 0) > 30 * 60000) continue;
    if (snap.party && snap.party.party !== undefined && (snap.receivedAt || 0) >= (st.at || 0)) continue; // 角色自己回報的比較新：以它為準（可能已經退隊）
    const r = (st.list || []).find(x => /^party:[^:]+:/.test(x.instanceId || ''));
    if (r) of[id] = r.instanceId.split(':')[1];
  }
  for (const [id, code] of Object.entries(of)) (members[code] || (members[code] = [])).push(id);
  for (const code of Object.keys(leader)) if (of[leader[code]] !== code) delete leader[code]; // 隊長已經在別隊了（資料舊）
  return { of, members, leader };
}
function bossUnitOf(charId, pm) {
  const code = pm.of[charId];
  const ids = code ? pm.members[code].filter(id => db.chars[id]) : [];
  return ids.length > 1 ? { code, ids } : { code: null, ids: [charId] };
}
// 每個隊伍各自的打法：先找隊員完全一樣的設定，沒有就找重疊最多（至少 2 隻）的，再沒有就用預設
const partyKey = ids => ids.filter(id => db.chars[id]).slice().sort().join(',');
function partyCfgOf(ids, c) {
  const k = partyKey(ids), P = c.parties || {};
  let best = P[k], ov = 1;
  if (!best) for (const [key, v] of Object.entries(P)) { const n = key.split(',').filter(x => ids.includes(x)).length; if (n > ov && n >= 2) { ov = n; best = v; } }
  const mode = best && ['together', 'split', 'mixed'].includes(best.mode) ? best.mode : c.partyMode;
  return { key: k, custom: !!(best && best.mode), mode, togetherMobs: best && Array.isArray(best.togetherMobs) ? best.togetherMobs.map(String) : c.togetherMobs,
    skipMobs: best && Array.isArray(best.skipMobs) ? best.skipMobs.map(String) : [] };
}
// 出發單位：隊伍一起打＝整隊；各自打＝每隻自己（同隊的王是共用的，靠 busyInst 避免兩隻同時去同一隻）
const bossUnitFor = (charId, pm, c) => { const u = bossUnitOf(charId, pm); return u.code && partyCfgOf(u.ids, c).mode === 'split' ? { code: null, ids: [charId] } : u; };
// 為什麼這隻現在不能出發（隊伍卡片顯示「等誰」）
function bossWhyNot(id) {
  const s = db.chars[id]; if (!s || !s.char) return '沒有資料';
  if (!s.playerCode || !tabOf(s.playerCode, id)) return '沒有遊戲分頁';
  if (!s.char.auto) return '沒在掛機';
  if (bossHeld(id)) return '按了停止，暫停打王';
  if (bossBusy(id)) return db.jobs.some(j => j.kind === 'boss' && ACTIVE.has(j.status) && j.fromCharId === id) ? '打王中' : '有其他工作';
  return '';
}
// 可以打的王＝隊員勾的合起來，扣掉隊伍設定「不打」的（v0.69.4；各自分開打時也照隊伍的設定）
function bossAllow(unit, c) {
  const set = new Set(unit.ids.flatMap(id => c.charMobs[id] || []));
  const P = c.parties || {};
  if (Object.keys(P).length) {
    const pm = partyMap(), skip = new Set();
    for (const id of unit.ids) { const u = bossUnitOf(id, pm); if (u.code) for (const m of partyCfgOf(u.ids, c).skipMobs) skip.add(m); }
    if (skip.size) set.skip = skip;
  }
  return set;
}
const bossHeld = id => { const h = (bossDb().hold || {})[id]; return h && h > Date.now() ? h : 0; }; // 按了強制停止：這段時間不再派去打王
const bossAvail = id => { const s = db.chars[id]; return !!(s && s.char && s.playerCode && tabOf(s.playerCode, id) && s.char.auto && !bossBusy(id) && !bossHeld(id)); };
const BOSS_HOLD_MS = 30 * 60 * 1000;
// 同一趟一起出發的隊友（同隊伍代碼、同一個建立時間）還在進行中的打王工作
const bossRunMates = j => db.jobs.filter(x => x !== j && x.kind === 'boss' && ACTIVE.has(x.status) && x.batches[0].boss.unit && x.batches[0].boss.unit === j.batches[0].boss.unit && x.createdAt === j.createdAt);
// 強制停止：{instanceId?（正在打的那一場）, charIds?（只停這幾隻）}。還沒開始的工作直接取消；進行中的標 stopReq，
// 遊戲分頁每 4 秒問一次（/api/boss/stopreq），看到就放棄這隻、回原本的地圖開始掛機。停的角色 30 分鐘內不再派去打王
function bossStop(e) {
  const b = bossDb(), now = Date.now(); b.hold = b.hold || {};
  const ids = Array.isArray(e.charIds) && e.charIds.length ? new Set(e.charIds.map(String)) : null;
  const js = db.jobs.filter(j => j.kind === 'boss' && ACTIVE.has(j.status) && (!e.instanceId || j.batches[0].boss.instanceId === e.instanceId) && (!ids || ids.has(j.fromCharId)));
  // 一起打的隊友：整隊同進退，跟著回去（不暫停打王）
  for (const j of js.slice()) if (j.batches[0].boss.unit) for (const m of bossRunMates(j)) if (!js.includes(m) && !m.stopReq) { m.stopReq = now; m.stopWhy = `隊友 ${j.fromName} 被停止`; jobLog(m, `隊友 ${j.fromName} 被停止，整隊一起回練功圖`); }
  for (const j of js) {
    b.hold[j.fromCharId] = now + BOSS_HOLD_MS;
    if (j.status !== 'running') { j.status = 'cancelled'; jobLog(j, '你按了強制停止，取消'); }
    else { j.stopReq = now; jobLog(j, '你按了強制停止：放棄這隻王，回原本的地圖練功'); }
    bossLog(j.fromCharId, `強制停止：不打 ${j.batches[0].boss.name}，回原本的地圖練功（30 分鐘內不再派去打王）`);
  }
  for (const [k, v] of Object.entries(b.hold)) if (v < now) delete b.hold[k];
  save();
  return { stopped: js.map(j => j.fromName) };
}
// 從這幾隻角色（ids）可以打的王裡挑一隻：已重生、有勾、預估不會太久、別人沒在打、30 分鐘內沒失敗過；mobOk 再限制哪些王（依王決定時用）
// 王的狀態：同隊伍的王是共用的，用隊伍裡最新回報的那一份（自己打時也一樣，隊友剛打死的王才會看成冷卻中）
function bossPick(ids, c, now, busyInst, mobOk, dpsIds, stateIds) {
  const b = bossDb();
  const stId = (stateIds || ids).filter(id => b.state[id] && now - b.state[id].at < BOSS_STATE_STALE).sort((x, y) => b.state[y].at - b.state[x].at)[0];
  if (!stId) return null;
  const dps = (dpsIds || ids).reduce((t, id) => t + charDps(id), 0);
  return bossRows(stId, dps, bossAllow({ ids }, c)).filter(r => r.ready && !r.skip && !busyInst.has(r.instanceId) && (!mobOk || mobOk(r.mob)))
    .filter(r => !ids.some(id => { const l = b.last[id + '|' + r.mob]; return l && l.result !== 'killed' && l.result !== 'cooling' && now - l.at < BOSS_RETRY_MS; }))
    .sort((x, y) => (x.estSec == null) - (y.estSec == null) || (x.estSec || 0) - (y.estSec || 0))[0] || null;
}
// 出發（試跑只寫紀錄）：go 的每隻各一個 boss 工作；code＝隊伍代碼（一起打）或 null（自己打）
// 野王地圖的自動販售（面板依「共用規則＋個別調整」算好存在 sellMaps）；沒開＝null（不動遊戲裡那張圖的設定）
// v0.71：改用去處規則（野王地圖有開才套用）
function bossSellOf(c, map) { return destSellOf(map, 'boss'); }
function bossDispatch(c, charId, unitIds, code, go, r, busyInst, now) {
  const b = bossDb();
  const est = r.estSec != null ? `預估 ${Math.max(1, Math.round(r.estSec / 60))} 分鐘` : '還沒有實戰 DPS，無法預估';
  const names = go.map(id => db.chars[id].char.name);
  const left = unitIds.filter(id => !go.includes(id)).map(id => db.chars[id].char.name);
  const who = code ? `隊伍 ${names.join('、')} 一起` : '';
  const leftTxt = left.length ? `；${left.join('、')} 沒有分頁／沒在掛機／有其他工作，這次不去` : '';
  busyInst.add(r.instanceId);
  if (c.mode === 'preview') {
    const key = unitIds.slice().sort().join(',') + '|' + r.mob + '|' + Math.floor(now / BOSS_RETRY_MS);
    if (!b.seen[key]) { b.seen[key] = 1; bossLog(charId, `試跑：${code ? `隊伍 ${names.join('、')} 會一起去` : '會去'} ${r.mapName} 打 ${r.name}（${est}，打完各自回原地圖${leftTxt}）`); }
    return;
  }
  for (const id of go) {
    const snap = db.chars[id], homeName = worldMapNames[b.home[id]] || b.homeName[id] || '原地圖';
    const job = {
      id: crypto.randomBytes(6).toString('hex'), kind: 'boss', status: 'approved', auto: true, createdAt: now, approvedAt: now,
      fromCharId: id, fromName: snap.char.name, fromCode: snap.playerCode, toCharId: id, toName: snap.char.name, toCode: snap.playerCode,
      batches: [{ items: [], gear: [], money: 0, boss: { mob: r.mob, name: r.name, map: r.map, mapName: r.mapName, instanceId: r.instanceId, back: b.home[id] || '', backName: homeName, stuckMin: c.stuckMin, maxMin: c.maxMin, sell: bossSellOf(c, r.map), presetBoss: c.presetBoss, presetTrain: c.presetTrain, chain: c.chain, unit: code || '', party: code ? names : null } }],
      batchIndex: 0, log: [], lastMsg: '',
    };
    job.bossMaps = [r.map];
    jobLog(job, `自動：${who}去 ${r.mapName} 打 ${r.name}（${est}）`);
    db.jobs.push(job);
  }
  bossLog(charId, `出發：${who}去 ${r.mapName} 打 ${r.name}（${est}${leftTxt}）`);
}
// 記住角色原本的練功圖（打完王要回去的地方）。v0.69.2：練功圖本身也有野王（例如海岸草叢3 的紅寶王）時以前不會記，
// 打完王就「不知道原本的地圖」留在王那邊。現在只排除「正在打王」或「剛打完王（15 分鐘內）還停在那張王圖」的情況。
function bossNoteHome(id, maps) {
  const s = db.chars[id], sc = s && s.char, b = bossDb(); if (!sc || !sc.map) return;
  if (db.jobs.some(j => j.kind === 'boss' && j.fromCharId === id && ACTIVE.has(j.status))) return;
  if (maps.has(sc.map) && db.jobs.some(j => j.kind === 'boss' && j.fromCharId === id && Date.now() - (j.updatedAt || j.createdAt) < 15 * 60000 && (j.bossMaps || [j.batches[0].boss.map]).includes(sc.map))) return;
  b.home[id] = sc.map; b.homeName[id] = sc.mapName || '';
}
// 保險：打王工作結束 1.5 分鐘後，角色還停在這次打過的王圖（遊戲分頁中途重新整理、回程換圖失敗等）→ 建一個工作帶回原本的地圖並開始掛機
function bossReturnCheck() {
  const b = bossDb(), now = Date.now();
  for (const j of db.jobs) {
    if (j.kind !== 'boss' || j.returnChecked || ACTIVE.has(j.status)) continue;
    const end = j.updatedAt || j.createdAt;
    if (now - end > 30 * 60000) { j.returnChecked = true; continue; }
    if (now - end < 90000) continue;
    const s = db.chars[j.fromCharId]; if (!s || !s.char) continue;
    if ((s.receivedAt || 0) < end + 30000) continue;              // 等結束後的新快照
    const visited = j.bossMaps || [j.batches[0].boss.map];
    const home = j.batches[0].boss.back || b.home[j.fromCharId];
    j.returnChecked = true;
    if (!visited.includes(s.char.map) || !home || home === s.char.map) continue;
    if (db.jobs.some(x => x.fromCharId === j.fromCharId && ACTIVE.has(x.status))) continue;
    const name = worldMapNames[home] || b.homeName[j.fromCharId] || j.batches[0].boss.backName || home;
    createPartyJob(j.fromCharId, { role: 'solo', ops: false, map: home, mapName: name }, `打完王還停在 ${s.char.mapName || s.char.map}：自動帶回 ${name} 並開始掛機`);
    bossLog(j.fromCharId, `打完王還停在 ${s.char.mapName || s.char.map}，自動帶回 ${name} 並開始掛機`);
  }
}
setInterval(() => { try { loadWorldIndex(); bossReturnCheck(); } catch (e) { console.warn('[野王 回程檢查]', e); } }, 30 * 1000);
function bossTick(force) {
  const c = bossCfg(); if (c.mode === 'off') return;
  const b = bossDb(), maps = bossMapSet(), pm = partyMap(), handled = new Set(), now = Date.now();
  const busyInst = new Set(db.jobs.filter(j => j.kind === 'boss' && ACTIVE.has(j.status)).map(j => j.batches[0].boss.instanceId));
  const activeOf = id => db.jobs.some(j => j.kind === 'boss' && ACTIVE.has(j.status) && j.fromCharId === id);
  b.homeName = b.homeName || {};
  for (const charId of Object.keys(c.chars).filter(id => c.chars[id])) {
    if (handled.has(charId) || !db.chars[charId]) continue;
    const party = bossUnitOf(charId, pm), pc = party.code ? partyCfgOf(party.ids, c) : null, tog = new Set(pc ? pc.togetherMobs : []);
    // 依王決定（mixed）：隊友各自先打「分開打」的王；全隊都空下來、而且沒有分開打的王可打了，才一起去打「一起打」的王
    if (pc && pc.mode === 'mixed') {
      party.ids.forEach(id => handled.add(id));
      for (const id of party.ids) bossNoteHome(id, maps);
      const sent = new Set();
      for (const id of party.ids) {
        if (!c.chars[id] || activeOf(id) || !bossAvail(id)) continue;
        const r = bossPick([id], c, now, busyInst, mob => !tog.has(mob), null, party.ids);
        if (r) { bossDispatch(c, id, [id], null, [id], r, busyInst, now); sent.add(id); }
      }
      if (sent.size || party.ids.some(activeOf)) continue;
      const go = party.ids.filter(bossAvail); if (go.length < party.ids.length) continue; // 一起打：全員能出發才去
      const r = bossPick(party.ids, c, now, busyInst, mob => tog.has(mob), go);
      if (r) bossDispatch(c, charId, party.ids, party.code, go, r, busyInst, now);
      continue;
    }
    const unit = bossUnitFor(charId, pm, c);
    unit.ids.forEach(id => handled.add(id));
    for (const id of unit.ids) bossNoteHome(id, maps);
    // 隊伍裡還有人在打王：等大家都回來再一起挑下一隻
    if (unit.ids.some(activeOf)) continue;
    const go = unit.ids.filter(bossAvail);                       // 有自己的分頁、在掛機、沒有其他工作
    if (!go.length) continue;
    if (unit.code && go.length < unit.ids.length) continue;      // v0.69.3：隊伍一起打要全員能出發（以前能去的先去，弱的那隻一個人去常被打死）
    const r = bossPick(unit.ids, c, now, busyInst, null, go, party.code ? party.ids : null);
    if (r) bossDispatch(c, charId, unit.ids, unit.code, go, r, busyInst, now);
  }
  for (const k of Object.keys(b.seen)) if (Number(k.split('|').pop()) < Math.floor(now / BOSS_RETRY_MS) - 1) delete b.seen[k];
  save();
}
setInterval(() => { try { bossTick(false); } catch (e) { console.warn('[野王]', e); } }, 60 * 1000);
// 連續打的下一隻：和 bossTick 同一套挑法（已重生、沒勾的不去、預估太久不去、別人正在打的不去），
// 隊伍一起打時同隊的人拿到同一個決定（key＝隊伍＋剛打完的那隻，3 分鐘內有效）
const bossNextDec = {};
function bossNext(e) {
  const c = bossCfg(), now = Date.now();
  if (c.mode !== 'auto' || !c.chain) return { none: true, why: c.mode !== 'auto' ? '打王不是自動出發' : '沒開連續打' };
  const job = db.jobs.find(j => j.id === e.jobId && j.kind === 'boss' && ACTIVE.has(j.status));
  if (!job || job.fromCharId !== e.charId) return { none: true, why: '找不到這個打王工作' };
  if (job.stopReq) return { none: true, why: '強制停止' };
  const pm = partyMap(), pu = bossUnitOf(e.charId, pm), pc = pu.code ? partyCfgOf(pu.ids, c) : null, tog = new Set(pc ? pc.togetherMobs : []);
  let unit = bossUnitFor(e.charId, pm, c), mobOk = null;
  // 一起打：同一趟出發的隊友有人已經回去（倒下太多次、被停止、打不動…）→ 整隊一起回，不讓剩下的人自己接著打下一隻
  if (job.batches[0].boss.unit) {
    const run = db.jobs.filter(j => j.kind === 'boss' && j.batches[0].boss.unit === job.batches[0].boss.unit && j.createdAt === job.createdAt);
    const gone = run.filter(j => !ACTIVE.has(j.status) || j.stopReq);
    if (gone.length) return { none: true, why: `隊友 ${gone.map(j => j.fromName).join('、')} 已經回去，整隊一起回練功圖` };
  }
  // 依王決定：這個工作是一起打的（boss.unit 有隊伍代碼）就只接「一起打」的王，自己打的就只接「分開打」的王
  if (pc && pc.mode === 'mixed') {
    if (job.batches[0].boss.unit) { unit = bossUnitOf(e.charId, pm); mobOk = m => tog.has(m); }
    else { unit = { code: null, ids: [e.charId] }; mobOk = m => !tog.has(m); }
  }
  // 同一次出發（同隊的工作 createdAt 相同）＋剛打完的那隻；自己打的用工作 id，避免拿到上一輪留下的決定
  const key = (unit.code ? unit.code + '|' + job.createdAt : job.id) + '|' + (e.prev || e.mob || '');
  for (const [k, d] of Object.entries(bossNextDec)) if (now - d.at > 3 * 60000) delete bossNextDec[k];
  let dec = bossNextDec[key];
  if (!dec) {
    const active = j => j.kind === 'boss' && ACTIVE.has(j.status);
    const parts = unit.ids.filter(id => db.jobs.some(j => active(j) && j.fromCharId === id));
    if (!parts.includes(e.charId)) parts.push(e.charId);
    // 別人（不是這一組）正在打的王不去；同隊各自打時，隊友正在打的也算別人
    const busyInst = new Set(db.jobs.filter(j => active(j) && !parts.includes(j.fromCharId)).map(j => j.batches[0].boss.instanceId));
    const b = bossDb();
    const pIds = bossUnitOf(e.charId, pm).ids; // 狀態用整個隊伍最新的一份（隊伍的王共用）
    const stId = [...new Set([...parts, ...pIds])].filter(id => b.state[id]).sort((x, y) => b.state[y].at - b.state[x].at)[0];
    let r = null;
    if (stId) {
      const dps = parts.reduce((t, id) => t + charDps(id), 0);
      r = bossRows(stId, dps, bossAllow({ ids: parts }, c)).filter(x => x.ready && !x.skip && !busyInst.has(x.instanceId) && x.instanceId !== e.prev && x.mob !== e.mob && (!mobOk || mobOk(x.mob)))
        .filter(x => !parts.some(id => { const l = b.last[id + '|' + x.mob]; return l && l.result !== 'killed' && l.result !== 'cooling' && now - l.at < BOSS_RETRY_MS; }))
        .sort((x, y) => (x.estSec == null) - (y.estSec == null) || (x.estSec || 0) - (y.estSec || 0))[0] || null;
    }
    dec = bossNextDec[key] = { at: now, boss: r ? { mob: r.mob, name: r.name, map: r.map, mapName: r.mapName, instanceId: r.instanceId, sell: bossSellOf(c, r.map) } : null };
    if (r) bossLog(e.charId, `連續打：${parts.length > 1 ? `隊伍 ${parts.map(charName).join('、')} 一起` : ''}接著去 ${r.mapName} 打 ${r.name}`);
  }
  if (!dec.boss) return { none: true, why: '沒有其他已重生的王' };
  Object.assign(job.batches[0].boss, dec.boss);
  job.bossMaps = [...new Set([...(job.bossMaps || []), dec.boss.map])];
  jobLog(job, `連續打：接著去 ${dec.boss.mapName} 打 ${dec.boss.name}`);
  save();
  return { boss: dec.boss };
}
// ===== 組隊（組隊分頁）=====
// 遊戲指令（2026-11-21 讀 game.js）：partyCreate、partyJoin {code}（隊伍代碼，可跨帳號）、partyLeave、partyKick {memberId}、
// partyInvite {code: 12 碼玩家 ID}、partyFollow {memberId}（一鍵同圖）；隊伍在同步回應最上層 party = {code, leader, members:[{id, name, map…}]}，最多 6 人。
// 套用一個隊伍＝每個隊員一個 party 工作（各自的分頁做）：要重組時先離開原本的隊伍 → 隊長建隊、把代碼回報給中控 → 隊員拿代碼加入 → 換圖、開始掛機。
// 隊伍已經是這幾個人就不動隊伍，只換圖＋開掛機。
BAG_KINDS.add('party'); KIND_MIN_AGENT.party = '0.46.0';
function partyRuns() { const r = db.partyRuns || (db.partyRuns = {}); for (const [k, v] of Object.entries(r)) if (Date.now() - v.at > 24 * 3600e3) delete r[k]; return r; }
function applyParties(list) {
  const pm = partyMap(), jobs = [], warn = [], runs = partyRuns();
  loadWorldIndex();
  for (const p of list || []) {
    const members = [...new Set((p.members || []).filter(id => db.chars[id]))];
    if (!members.length) continue;
    if (members.length > 6) throw new Error(`${p.name || '隊伍'} 超過 6 人（遊戲上限）`);
    for (const id of members) if (db.jobs.some(j => ACTIVE.has(j.status) && j.kind === 'party' && j.fromCharId === id)) throw new Error(`${charName(id)} 還有組隊工作在進行，等它做完再套用`);
    const codes = members.map(id => pm.of[id] || '');
    const same = members.length === 1 ? !codes[0] : !!(codes[0] && codes.every(c => c === codes[0]) && (pm.members[codes[0]] || []).length === members.length);
    // 沿用現有的隊伍：遊戲裡的隊長是這次的隊員之一 → 不解散，隊長留著、踢掉不要的、其他人用隊伍代碼加入
    // （有好幾隊可以沿用時，挑已經在裡面的人最多的那隊）
    let keep = null;
    if (!same && members.length > 1) {
      for (const code of new Set(codes.filter(Boolean))) {
        const L = pm.leader[code]; if (!L || !members.includes(L)) continue;
        const inside = members.filter(id => pm.of[id] === code);
        const others = (pm.members[code] || []).filter(id => !members.includes(id));
        const extra = others.filter(id => db.chars[id]), strangers = others.length - extra.length; // 不是這台中控的角色（例如大廳來的玩家）不踢
        if (members.length + strangers > 6) continue;
        if (!keep || inside.length > keep.inside.length) keep = { code, leader: L, inside, extra };
      }
    }
    const runId = crypto.randomBytes(6).toString('hex'), leader = keep ? keep.leader : members[0];
    const mapName = (worldMapNames || {})[p.map] || p.mapName || p.map || '';
    runs[runId] = { at: Date.now(), partyId: p.id || '', name: p.name || '', leader, members, code: keep ? keep.code : same && codes[0] ? codes[0] : null, map: p.map || '', mapName };
    for (const id of members) {
      const snap = db.chars[id];
      if (!tabOf(snap.playerCode, id)) warn.push(`${snap.char.name} 沒有自己的遊戲分頁（開了才會執行）`);
      const role = members.length === 1 ? 'solo' : id === leader ? 'leader' : 'member';
      const pj = { runId, role, ops: !same, map: p.map || '', mapName, leaderName: charName(leader), name: p.name || '', sell: p.map ? cleanSell(p.sell) : undefined };
      let note;
      if (same) note = '（隊伍不變）';
      else if (keep && id === leader) { pj.ops = false; pj.kick = keep.extra.map(x => ({ id: x, name: charName(x) })); note = `（沿用隊伍，不解散${pj.kick.length ? `；踢出 ${pj.kick.map(x => x.name).join('、')}` : ''}）`; }
      else if (keep && keep.inside.includes(id)) { pj.ops = false; note = `（已經在 ${charName(leader)} 的隊伍裡）`; }
      else if (keep) { pj.code = keep.code; note = `（用隊伍代碼加入 ${charName(leader)} 的隊伍）`; }
      else note = role === 'leader' ? '（隊長，建立隊伍）' : role === 'member' ? `（加入 ${charName(leader)} 的隊伍）` : '（單人）';
      const job = {
        id: crypto.randomBytes(6).toString('hex'), kind: 'party', status: 'approved', createdAt: Date.now(), approvedAt: Date.now(),
        fromCharId: id, fromName: snap.char.name, fromCode: snap.playerCode, toCharId: id, toName: snap.char.name, toCode: snap.playerCode,
        batches: [{ items: [], gear: [], money: 0, party: pj }],
        batchIndex: 0, log: [], lastMsg: '', ...(pj.kick && pj.kick.length ? { minAgent: '0.68.4' } : {}), // 舊腳本不會踢人
      };
      jobLog(job, `組隊：${p.name || ''}${note}${p.map ? `，前往 ${mapName}` : ''}`);
      db.jobs.push(job); jobs.push(job);
    }
  }
  save();
  return { jobs: jobs.length, warn };
}
function partyRunInfo(id) {
  const r = partyRuns()[id]; if (!r) return { error: '找不到這次組隊（可能已過期）' };
  const lj = db.jobs.filter(j => j.kind === 'party' && j.batches[0].party.runId === id && j.fromCharId === r.leader).slice(-1)[0];
  if (!r.code && lj && ['failed', 'cancelled'].includes(lj.status)) return { error: `隊長 ${charName(r.leader)} 建立隊伍失敗：${lj.lastMsg || ''}` };
  return { code: r.code || '' };
}

const bossHpTrack = {}; // instanceId → { t0, hp0, at }（只放記憶體）
function bossLive() {
  const b = bossDb(), by = {};
  for (const j of db.jobs.filter(j => j.kind === 'boss' && ACTIVE.has(j.status))) {
    const x = j.batches[0].boss, g = by[x.instanceId] || (by[x.instanceId] = { instanceId: x.instanceId, mob: x.mob, name: x.name, mapName: x.mapName, names: [], startedAt: j.createdAt, msg: '' });
    g.names.push(j.fromName); (g.who || (g.who = [])).push({ charId: j.fromCharId, name: j.fromName, stopping: !!j.stopReq }); g.startedAt = Math.min(g.startedAt, j.createdAt); if (j.lastMsg) g.msg = j.lastMsg;
  }
  return Object.values(by).map(g => {
    const h = b.hp[g.instanceId], t = bossHpTrack[g.instanceId];
    const fresh = h && h.at >= g.startedAt;
    let etaSec = null, perMin = null;
    if (fresh && t && h.at > t.t0 + 8000 && t.hp0 > h.hp) { const rate = (t.hp0 - h.hp) / ((h.at - t.t0) / 1000); perMin = rate * 60; etaSec = Math.round(h.hp / rate); }
    return { ...g, hp: fresh ? h.hp : null, maxHp: h ? h.maxHp : null, hpAt: fresh ? h.at : 0, perMin, etaSec };
  });
}
function bossSummary() {
  const c = bossCfg(), b = bossDb();
  const pm = partyMap();
  const ids = new Set([...Object.keys(b.state), ...Object.keys(c.chars).filter(k => c.chars[k])]);
  for (const id of Object.keys(c.chars).filter(k => c.chars[k])) bossUnitOf(id, pm).ids.forEach(x => ids.add(x));
  const chars = [...ids].filter(id => db.chars[id]).map(id => {
    const s = db.chars[id], unit = bossUnitOf(id, pm), u2 = bossUnitFor(id, pm, c), split = !!unit.code && u2.ids.length === 1;
    const pdps = unit.code ? unit.ids.reduce((t, x) => t + charDps(x), 0) : null;
    return { charId: id, slot: s.char.settingsSlot || 1, party: unit.code ? { code: unit.code, ids: unit.ids, names: unit.ids.map(x => db.chars[x].char.name) } : null, partyDps: pdps, name: s.char.name, lv: s.char.lv, map: s.char.map, mapName: s.char.mapName, auto: !!s.char.auto, tab: !!tabOf(s.playerCode, id), on: split || !unit.code ? !!c.chars[id] : unit.ids.some(x => c.chars[x]), picked: !!c.chars[id], mobs: c.charMobs[id] || [],
      at: (b.state[id] || {}).at || 0, dps: charDps(id), rows: bossRows(id, split ? null : pdps, bossAllow(u2, c)),
      held: bossHeld(id), job: (db.jobs.filter(j => j.kind === 'boss' && j.fromCharId === id).slice(-1)[0]) || null };
  });
  // 隊伍卡片：每個隊伍的打法、誰卡住（一起打要全員能出發）
  const parties = [], seenCode = new Set();
  for (const id of ids) { const u = bossUnitOf(id, pm); if (!u.code || seenCode.has(u.code)) continue; seenCode.add(u.code);
    const pc = partyCfgOf(u.ids, c);
    parties.push({ code: u.code, key: pc.key, custom: pc.custom, mode: pc.mode, togetherMobs: pc.togetherMobs, skipMobs: pc.skipMobs, ids: u.ids, names: u.ids.map(x => db.chars[x].char.name),
      dps: u.ids.reduce((t, x) => t + charDps(x), 0), why: Object.fromEntries(u.ids.map(x => [x, bossWhyNot(x)])), picked: u.ids.some(x => c.chars[x]) }); }
  return { cfg: c, chars, parties, live: bossLive(), log: b.log.slice(-100), newBosses: bossNewList() };
}

// ===== 即時經驗速度 =====
// 遊戲畫面的「平均每小時經驗」是整輪掛機的平均，換圖／換隊後要很久才看得出差別。
// 中控每 10 秒收到每隻角色當下的經驗值，自己算「最近 3 分鐘」的每小時經驗（跨等級用經驗表補上）；
// 換地圖或換隊伍時重新開始量（只用換之後的資料），並記下換之前 10 分鐘的速度當比較基準。只放記憶體。
const EXP_WIN = 3 * 60 * 1000, EXP_BASE = 10 * 60 * 1000, EXP_KEEP = 15 * 60 * 1000;
const expTrack = {}; // 角色 → { pts:[{t, lv, xp, need}], since, key, base:{rate, span}|null, prevKey }
function expGain(a, b) {
  if (b.lv === a.lv) return b.xp - a.xp;
  if (b.lv < a.lv) return 0;
  let g = Math.max(0, (a.need || 0) - a.xp) + b.xp;
  for (let l = a.lv + 1; l < b.lv; l++) g += Number((db.expTable || {})[l]) || 0;
  return g;
}
function expRate(pts, from) {
  const ps = pts.filter(p => p.t >= from);
  if (ps.length < 2) return null;
  let g = 0; for (let i = 1; i < ps.length; i++) g += expGain(ps[i - 1], ps[i]);
  const span = ps[ps.length - 1].t - ps[0].t;
  return span >= 50000 ? { rate: Math.round(g / span * 3600000), span } : { rate: null, span };
}
function partyCodeOf(snap) { const p = snap.party && snap.party.party; return p && p.code && (p.members || []).length > 1 ? p.code : ''; }
function expSample(snap) {
  const c = snap.char; if (!c || !(c.lv > 0) || c.xp == null) return;
  const now = Date.now(), tr = expTrack[c.id] || (expTrack[c.id] = { pts: [], since: now, key: '' });
  const key = (c.map || '') + '|' + partyCodeOf(snap);
  if (tr.key && key !== tr.key) {
    // 換地圖／換隊伍：記下換之前 10 分鐘的速度當基準，從現在重新量
    const b = expRate(tr.pts, now - EXP_BASE);
    tr.base = b && b.rate != null ? { rate: b.rate, span: b.span, key: tr.key, at: now } : null;
    tr.since = now;
  }
  tr.key = key;
  const last = tr.pts[tr.pts.length - 1];
  if (last && now - last.t < 8000) return;
  tr.pts.push({ t: now, lv: c.lv, xp: Number(c.xp) || 0, need: Number(c.nextXp) || 0 });
  while (tr.pts.length && now - tr.pts[0].t > EXP_KEEP) tr.pts.shift();
}
function expLive() {
  const out = {}, now = Date.now();
  for (const [id, tr] of Object.entries(expTrack)) {
    const last = tr.pts[tr.pts.length - 1]; if (!last || now - last.t > 90000) continue; // 超過 90 秒沒新資料（分頁關了、離線掛機）不算
    const r = expRate(tr.pts, Math.max(tr.since, now - EXP_WIN));
    out[id] = { rate: r && r.rate, span: r ? r.span : 0, since: tr.since, base: tr.base || null };
  }
  return out;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Token',
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

// ===== 手機版（/m）=====
// 手機經 Tailscale（建議用 tailscale serve 的 HTTPS 網址）連回這台電腦。配對：電腦面板「手機」產生 QR code（網址 /m#t=裝置通行碼），
// 手機掃了就記住；裝置清單在 db.mDevices，可以個別撤銷。手機用精簡的 /api/m/summary（每 10 秒），操作沿用原本的 API。
const M_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#16181d"/><path d="M48 14l8 18 18-6-8 18 16 8-18 6 4 20-20-12-20 12 4-20-18-6 16-8-8-18 18 6z" fill="#e8453c"/></svg>';
function charGroupOf(id) {
  const g = (db.settings.charGroup || {})[id]; if (g) return g;
  for (const s of Object.values(db.chars)) { const i = (s.accountChars || []).findIndex(c => c.id === id); if (i >= 0) return i === 0 ? 'A' : 'B'; }
  return 'A';
}
function mobileSummary() {
  const now = Date.now(), live = expLive(), pm = partyMap();
  const jobsActive = db.jobs.filter(j => ACTIVE.has(j.status));
  const chars = [], seen = new Set();
  for (const s of Object.values(db.chars)) {
    const c = s.char; if (!c || !c.id) continue; seen.add(c.id);
    const tab = !!tabOf(s.playerCode, c.id), j = jobsActive.find(x => x.fromCharId === c.id);
    chars.push({ id: c.id, name: c.name, lv: c.lv, expPct: c.expPct, xp: c.xp || 0, nextXp: c.nextXp || null, nextXpExact: !!c.nextXpExact, job: c.jobName || c.job, map: c.map, mapName: c.mapName, auto: !!c.auto, until: c.until || null,
      hourly: c.hourlyExp || null, live: (live[c.id] || {}).rate ?? null, hp: c.hp, maxhp: c.maxhp, dead: typeof c.hp === 'number' && c.hp <= 0, money: c.money || 0,
      tab, at: s.receivedAt || 0, offline: !!s.idleOffline, group: charGroupOf(c.id), party: pm.of[c.id] || null, acc: s.accountId || '',
      job2: j ? { kind: j.kind, status: j.status, msg: String(j.lastMsg || '').slice(0, 80) } : null, ava: (db.avatars || {})[c.id] ? db.avatars[c.id].at : 0 });
  }
  // 同帳號、還沒同步過的角色（背景掛機）
  for (const s of Object.values(db.chars)) for (const x of s.accountChars || []) if (!seen.has(x.id)) { seen.add(x.id);
    chars.push({ id: x.id, name: x.name, lv: x.lv, job: x.jobName || x.job || '', auto: !!x.auto, unsynced: true, tab: false, group: charGroupOf(x.id), acc: s.accountId || '', ava: (db.avatars || {})[x.id] ? db.avatars[x.id].at : 0 }); }
  const pj = j => ({ id: j.id, kind: j.kind, status: j.status, from: j.fromName, to: j.toName, msg: String(j.lastMsg || '').slice(0, 120), at: j.updatedAt || j.createdAt, auto: !!j.auto,
    what: j.kind === 'boss' ? `打 ${j.batches[0].boss.name}` : j.kind === 'party' ? '組隊' : j.kind === 'idle' ? ((j.batches[0].targets || []).map(t => t.action === 'map' ? `換圖 ${t.mapName || ''}` : ({ start: '開始掛機', stop: '暫停', restart: '重新開始', wake: '領取離線', switch: '切換角色' }[t.action] || t.action)).join('、')) : '' });
  const bc = bossCfg();
  return { now, version: scriptVersion(), chars, expTable: db.expTable || {},
    jobs: db.jobs.filter(j => ACTIVE.has(j.status) || j.status === 'failed' || now - (j.updatedAt || j.createdAt || 0) < 3 * 3600e3).slice(-60).map(pj),
    boss: { mode: bc.mode, n: Object.keys(bc.charMobs).length, live: bossLive() },
    parties: (db.settings.parties || []).map(p => ({ ...p, sell: p.map ? boardSellOf(p.map) : undefined })), idleLog: (db.idleLog || []).slice(-15), update: updateInfo };
}
// 派工看板上那張圖的自動販售範本（組隊套用時一起送；和電腦面板 ptApply 同規則）
// 派工看板上每張圖算好的自動販售（給面板比對「遊戲裡的設定跟去處規則一不一樣」）
function destSellBoard() {
  const bs = { A: db.settings.board || {}, ...(db.settings.boards || {}) }, out = {};
  for (const g of ['A', 'B']) for (const l of Object.values((bs[g] || {}).lanes || {})) for (const m of l || []) if (!(m in out)) out[m] = destSellOf(m, 'board');
  return out;
}
function boardSellOf(map) { return destSellOf(map, 'board') || undefined; } // v0.71：派工地圖的自動販售＝去處規則算出來的
function mobileDevices() { return (db.mDevices || []).map(d => ({ id: d.id, name: d.name, at: d.at, seenAt: d.seenAt || 0 })); }
async function mobileApi(req, url) {
  if (req.method === 'GET' && url.pathname === '/api/m/summary') return [200, mobileSummary()];
  if (req.method === 'GET' && url.pathname === '/api/m/maps') {
    let w = {}; try { w = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8')); } catch (_) {}
    const mobs = Object.fromEntries((w.mobs || []).map(m => [m.id, m]));
    return [200, { maps: (w.maps || []).filter(m => (m.mobIds || []).length).map(m => [m.id, m.name, m.minLevel || 0, m.region || '']),
      bosses: (w.maps || []).flatMap(m => (m.boss || []).map(id => mobs[id] ? { mob: id, name: mobs[id].name, lv: mobs[id].lv || 0, mapName: m.name } : null)).filter(Boolean) }];
  }
  // 以下只能在家裡電腦上操作（手機不能幫別的裝置配對、也不能撤銷）
  if (!isLocal(req)) return [403, { error: '只能在家裡電腦上操作' }];
  if (req.method === 'GET' && url.pathname === '/api/m/devices') return [200, { devices: mobileDevices() }];
  if (req.method === 'GET' && url.pathname === '/api/m/info') {
    // Tailscale 的機器名稱（tailscale serve 的 HTTPS 網址用）
    const info = { remote: false, port: PORT, dns: '', ips: Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address) };
    for (const exe of ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
      try {
        const out = require('child_process').execFileSync(exe, ['status', '--json'], { timeout: 4000, windowsHide: true }).toString(); const j = JSON.parse(out); info.dns = String((j.Self && j.Self.DNSName) || '').replace(/\.$/, '');
        // 有沒有用 tailscale serve 把 HTTPS 轉到這個埠
        try { const sv = require('child_process').execFileSync(exe, ['serve', 'status', '--json'], { timeout: 4000, windowsHide: true }).toString(); info.serve = sv.includes(':' + PORT); } catch (_) { info.serve = false; }
        if (info.dns) break;
      } catch (_) {}
    }
    return [200, info];
  }
  if (req.method === 'POST' && url.pathname === '/api/m/pair') {
    const e = JSON.parse((await readBody(req)) || '{}');
    const d = { id: crypto.randomBytes(4).toString('hex'), name: String(e.name || '手機').slice(0, 20), token: crypto.randomBytes(16).toString('hex'), at: Date.now(), seenAt: 0 };
    db.mDevices = [...(db.mDevices || []), d]; save();
    return [200, { id: d.id, token: d.token }];
  }
  if (req.method === 'POST' && url.pathname === '/api/m/revoke') {
    const e = JSON.parse((await readBody(req)) || '{}');
    db.mDevices = (db.mDevices || []).filter(d => d.id !== e.id); save();
    return [200, { ok: true, devices: mobileDevices() }];
  }
  return null;
}
// 組隊大廳：單一角色的組隊工作（建隊伍、用代碼加入、踢人），跟「組隊」分頁的 applyParties 同一種工作
function createPartyJob(charId, party, label) {
  const snap = db.chars[charId]; if (!snap) throw new Error('沒有這隻角色的資料');
  const job = {
    id: crypto.randomBytes(6).toString('hex'), kind: 'party', status: 'approved', createdAt: Date.now(), approvedAt: Date.now(), minAgent: '0.64.0',
    fromCharId: charId, fromName: snap.char.name, fromCode: snap.playerCode, toCharId: charId, toName: snap.char.name, toCode: snap.playerCode,
    batches: [{ items: [], gear: [], money: 0, party: { runId: '', ...party } }], batchIndex: 0, log: [], lastMsg: '',
  };
  jobLog(job, label); db.jobs.push(job); save();
  return job;
}
const lobby = makeLobby({
  getDb: () => db, save, charName, charDps, expLive: () => expLive(), worldFile: WORLD_FILE, avatarDir: AVATAR_DIR, dataDir: DATA_DIR,
  createPartyJob, isActiveJob: fn => db.jobs.some(j => ACTIVE.has(j.status) && fn(j)),
});
const bg = makeBg({
  dataDir: DATA_DIR, hubUrl: `http://127.0.0.1:${PORT}`,
  getCfg: () => db.settings.bg || {}, setCfg: c => { db.settings.bg = c; save(); },
  userscript: userscriptSource, agent: agentSource, log: m => console.log('[背景執行] ' + m),
});
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    // 手機版頁面本身沒有資料，不用通行碼（資料 API 才要）；通行碼放在網址 # 後面，只有手機自己讀得到
    if (req.method === 'GET' && url.pathname === '/dest.js') return send(res, 200, fs.readFileSync(path.join(__dirname, 'dest.js'), 'utf8'), 'application/javascript; charset=utf-8');
    if (req.method === 'GET' && (url.pathname === '/m' || url.pathname === '/m/')) return send(res, 200, fs.readFileSync(path.join(__dirname, 'm.html'), 'utf8'), 'text/html; charset=utf-8');
    // 加到主畫面後是另一個獨立的 App（iPhone 的儲存空間和 Safari 分開），所以啟動網址要帶著這支手機的通行碼（# 後面不會送到伺服器）
    if (req.method === 'GET' && url.pathname === '/m/manifest.webmanifest') return send(res, 200, { name: '上漲谷中控', short_name: '上漲谷', start_url: /^[0-9a-f]{16,64}$/.test(url.searchParams.get('t') || '') ? `/m#t=${url.searchParams.get('t')}` : '/m', scope: '/m', display: 'standalone', background_color: '#16181d', theme_color: '#16181d', icons: [{ src: '/m/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }, 'application/manifest+json; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/m/icon.svg') return send(res, 200, M_ICON, 'image/svg+xml');
    if (!isLocal(req) && !tokenOk(req, url)) return send(res, 401, { error: '需要通行碼' });

    if (req.method === 'GET' && url.pathname === '/agent.js') {
      return send(res, 200, agentSource(), 'text/javascript; charset=utf-8');
    }
    if (process.env.SZG_TEST_RESTART && req.method === 'POST' && url.pathname === '/__test/exit3') { send(res, 200, { ok: true, pid: process.pid }); setTimeout(() => process.exit(3), 200); return; } // 只給測試用
    // 記憶體診斷（中控本身、組隊大廳伺服器）
    if (req.method === 'GET' && url.pathname === '/api/sys') {
      const mb = n => Math.round(n / 1048576);
      const m = process.memoryUsage(); let lobbyMem = null;
      try { const h = (db.settings.lobbyHost || {}); if (h.on) { const j = await (await fetch(`http://127.0.0.1:${Number(h.port) || 8790}/api/ping`, { signal: AbortSignal.timeout(2000) })).json(); lobbyMem = j.mem || null; } } catch (_) {}
      let stateKB = 0; try { stateKB = Math.round(fs.statSync(STATE_FILE).size / 1024); } catch (_) {}
      return send(res, 200, { pid: process.pid, node: process.version, uptimeMin: Math.round(process.uptime() / 60), rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers), stateKB, execArgv: process.execArgv, lobby: lobbyMem,
        counts: { chars: Object.keys(db.chars).length, jobs: db.jobs.length, tabs: Object.values(tabs).reduce((a, t) => a + Object.keys(t).length, 0) } });
    }
    // 更新公告（version.json 的 changelog，最近 5 次）
    if (req.method === 'GET' && url.pathname === '/api/changelog') {
      let v = {}; try { v = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')); } catch (_) {}
      return send(res, 200, { version: v.version || '', changelog: (v.changelog || []).filter(e => !e.private).slice(0, 5) });
    }
    if (req.method === 'GET' && url.pathname === '/api/agent-version') {
      return send(res, 200, { version: scriptVersion() });
    }
    // 背景執行（不用開 Chrome 視窗）：只能在這台電腦上操作
    if (req.method === 'GET' && url.pathname === '/api/bg/standby') {
      return send(res, 200, { standby: realTabFor(url.searchParams.get('code') || '', url.searchParams.get('charId') || '', url.searchParams.get('page') || '') });
    }
    if (url.pathname === '/api/bg' || url.pathname.startsWith('/api/bg/')) {
      if (!isLocal(req)) return send(res, 403, { error: '背景執行只能在這台電腦上的面板操作' });
      if (req.method === 'GET' && url.pathname === '/api/bg') return send(res, 200, bg.status());
      if (req.method === 'GET' && url.pathname === '/api/bg/export.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="szg-bg-accounts-${new Date().toISOString().slice(0, 10)}.csv"` });
        return res.end(bg.exportCsv(id => charName(id)));
      }
      // 讀遊戲程式碼（只讀）：/api/bg/gamesrc?file=/game/game.js&q=正規表示式&ctx=150&max=20｜words=^party｜from=0&len=2000｜list=1｜fresh=1｜profile=帳號名
      if (req.method === 'GET' && url.pathname === '/api/bg/gamesrc') {
        const q = Object.fromEntries(url.searchParams);
        try { return send(res, 200, await bg.gameSrc(q)); } catch (e) { return send(res, 200, { error: e.message }); }
      }
      const act = url.pathname.slice('/api/bg/'.length);
      if (req.method === 'POST' && /^(config|add|rename|edit|remove|start|stop|login|login-done|login-batch|login-skip|login-cancel|reload|pages|order|all|import|show|hide|trim)$/.test(act)) {
        return send(res, 200, await bg.action(act, JSON.parse((await readBody(req)) || '{}')));
      }
      return send(res, 404, { error: 'not found' });
    }
    // 組隊大廳
    if (url.pathname === '/api/lobby' || url.pathname.startsWith('/api/lobby/')) {
      if (req.method === 'GET' && url.pathname === '/api/lobby') return send(res, 200, await lobby.view());
      if (url.pathname.startsWith('/api/lobby/admin')) { // 大廳主人管理（只限這台電腦）
        if (!isLocal(req)) return send(res, 403, { error: '只能在大廳主機上操作' });
        if (req.method === 'GET') return send(res, 200, await lobby.adminCall('GET', '/api/admin/state'));
        const op = url.pathname.split('/').pop();
        if (!/^(delist|ban|unban)$/.test(op)) return send(res, 404, { error: 'not found' });
        return send(res, 200, await lobby.adminCall('POST', '/api/admin/' + op, JSON.parse((await readBody(req)) || '{}')));
      }
      const act = url.pathname.slice('/api/lobby/'.length);
      if (req.method === 'POST' && /^(cfg|pub|request|decide|cancel|host|follow|leave|kick)$/.test(act)) {
        if (act === 'host' && !isLocal(req)) return send(res, 403, { error: '只能在這台電腦上設定' });
        return send(res, 200, await lobby.action(act, JSON.parse((await readBody(req)) || '{}')));
      }
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && url.pathname === '/szg-hub.user.js') {
      return send(res, 200, userscriptSource(), 'text/javascript; charset=utf-8');
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(DASHBOARD, 'utf8'), 'text/html; charset=utf-8');
    }

    // 掉落紀錄（只放記憶體，給工廠圖動畫用）
    if (req.method === 'POST' && url.pathname === '/api/loot') {
      const e = JSON.parse(await readBody(req));
      for (const x of (e && e.events) || []) { if (!x || !x.charId || !x.name) continue; lootSeq++; lootBuf.push({ seq: lootSeq, charId: String(x.charId), map: String(x.map || ''), name: String(x.name).slice(0, 40), qty: Number(x.qty) || 1, sold: !!x.sold, money: Number(x.money) || 0, at: Number(x.at) || Date.now() }); }
      if (lootBuf.length > 800) lootBuf.splice(0, lootBuf.length - 800);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/loot') {
      const since = Number(url.searchParams.get('since')) || 0;
      return send(res, 200, { seq: lootSeq, events: since ? lootBuf.filter(x => x.seq > since).slice(-200) : [] });
    }
    if (req.method === 'POST' && url.pathname === '/api/dps') {
      const e = JSON.parse(await readBody(req));
      if (!e || !e.charId) return send(res, 400, { error: 'bad dps' });
      db.dps = db.dps || {};
      db.dps[e.charId] = { ...e, receivedAt: Date.now() };
      return send(res, 200, { ok: true }); // 不特別存檔：下次其他資料存檔時一起寫入
    }
    if (url.pathname.startsWith('/api/m/')) { const r = await mobileApi(req, url); if (r) return send(res, r[0], r[1]); }
    if (req.method === 'GET' && url.pathname === '/api/data') {
      const tabsOut = {}; for (const [code, m] of Object.entries(tabs)) for (const [id, t] of Object.entries(m)) if (Date.now() - t.at < TAB_LIVE_MS) tabsOut[id] = { code, at: t.at, hidden: t.hidden, off: t.off, bg: !!t.bg };
      return send(res, 200, { now: Date.now(), tabs: tabsOut, chars: db.chars, dps: db.dps || {}, expLive: expLive(), avatars: Object.fromEntries(Object.entries(db.avatars || {}).map(([k, v]) => [k, v.at])), settings: db.settings, jobs: db.jobs.slice(-100), expTable: db.expTable || {}, idleLog: (db.idleLog || []).slice(-50), gearLog: (db.gearLog || []).slice(-80), scriptVersion: scriptVersion(), update: updateInfo, alerts: alertSummary(), auto: automationInfo(), destSell: destSellBoard() });
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
      expSample(snap);
      // 經驗表：遊戲給的「這一級需要多少經驗」是精確值，記下來給升級時間估算用
      if (snap.char.nextXpExact && snap.char.lv > 0 && snap.char.nextXp > 0) {
        db.expTable = db.expTable || {};
        if (db.expTable[snap.char.lv] !== snap.char.nextXp) db.expTable[snap.char.lv] = snap.char.nextXp;
      }
      // 同帳號的另一隻角色：更新它在角色大廳看得到的基本資料（等級、是否掛機）
      for (const other of snap.accountChars || []) {
        const prev = db.chars[other.id];
        if (prev && other.id !== snap.char.id) {
          if (snap.playerCode) prev.playerCode = snap.playerCode;
          prev.accountId = snap.accountId;
          if (tabOf(snap.playerCode, other.id)) continue; // 它有自己的分頁，自己回報的比較新
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
      // 打王設定一律合併（v0.69.6）：只改送來的欄位，沒送的（例如掉落篩選、隊伍打法）保留，哪個畫面存都不會清掉別的設定
      if (patch && patch.boss && typeof patch.boss === 'object') patch.boss = { ...(db.settings.boss || {}), ...patch.boss };
      // 去處規則也合併（v0.71）：只改送來的欄位（例如只改共用規則，不會清掉每張圖的覆寫）
      if (patch && patch.dest && typeof patch.dest === 'object') patch.dest = { ...(db.settings.dest || {}), ...patch.dest };
      if (patch && 'dest' in patch && !patch.dest) delete patch.dest;
      db.settings = { ...db.settings, ...patch };
      bossSettingsFix();
      save();
      return send(res, 200, { ok: true, settings: db.settings });
    }


    // ---- 冒險資料庫 ----
    if (req.method === 'GET' && url.pathname === '/api/extdb') return send(res, 200, extdb.forDashboard());
    if (req.method === 'GET' && url.pathname === '/api/extdb/status') return send(res, 200, { ...extdb.status(), auto: db.settings.extDbAuto !== false });
    if (req.method === 'POST' && url.pathname === '/api/extdb/refresh') {
      try { return send(res, 200, await extdb.refresh('手動')); } catch (e) { return send(res, 502, { error: e.message }); }
    }

    // ---- 自動更新 ----
    if (req.method === 'POST' && url.pathname === '/api/update/check') {
      await checkUpdate();
      return send(res, 200, updateInfo);
    }
    if (req.method === 'POST' && url.pathname === '/api/update/apply') {
      if (updateBlockers().length) return send(res, 409, { error: '有交易工作正在執行，請等它結束或取消後再更新' });
      const r = await applyUpdateAndRestart();
      return send(res, 200, { ok: true, updated: r.updated, latest: r.latest });
    }

    // ---- 交易工作 ----
    // 公會倉庫內容：遊戲不會在同步時送，只在查看／存取後回傳，所以存最後一次看到的
    if (req.method === 'GET' && url.pathname === '/api/guild') return send(res, 200, { ...(db.guild || { data: null }), log: (db.guildLog || []).slice(-40), autoAt: db.guildAutoAt || 0 });
    if (req.method === 'POST' && url.pathname === '/api/guild/auto-run') { guildAutoTick(true); return send(res, 200, { ok: true, log: (db.guildLog || []).slice(-5) }); }
    if (req.method === 'POST' && url.pathname === '/api/guild') {
      const b = JSON.parse(await readBody(req));
      if (!b || !b.data || typeof b.data !== 'object') return send(res, 400, { error: 'bad guild data' });
      db.guild = { at: Date.now(), charId: b.charId || null, charName: b.charName || '', data: b.data };
      save();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/guild/refresh') {
      try { const b = JSON.parse((await readBody(req)) || '{}'); return send(res, 200, { ok: true, job: createGuildView(b.charId) }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    // 強化工坊的結果（每件衝了幾次、成功幾次、是否及格），給面板和之後的分流用
    if (req.method === 'POST' && url.pathname === '/api/forge/result') {
      const r = JSON.parse(await readBody(req));
      if (!r || !Array.isArray(r.results)) return send(res, 400, { error: 'bad result' });
      (db.forgeLog || (db.forgeLog = [])).push({ at: Date.now(), ...r });
      if (db.forgeLog.length > 100) db.forgeLog.splice(0, db.forgeLog.length - 100);
      save();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/forge') return send(res, 200, { log: (db.forgeLog || []).slice(-40), autoLog: (db.forgeAutoLog || []).slice(-40), spentToday: forgeSpentToday(), autoAt: db.forgeAutoAt || 0 });
    // 自動強化：馬上照規則檢查一次（面板「立即檢查」）
    if (req.method === 'POST' && url.pathname === '/api/forge/auto-run') { forgeAutoTick(true); return send(res, 200, { ok: true, autoLog: (db.forgeAutoLog || []).slice(-40), spentToday: forgeSpentToday() }); }
    // 分流：記下某筆強化結果已經處理過（及格／不及格各做了什麼）
    if (req.method === 'POST' && url.pathname === '/api/forge/split') {
      const b = JSON.parse(await readBody(req));
      const r = (db.forgeLog || []).find(x => x.jobId === b.jobId && x.at === b.at);
      if (!r) return send(res, 404, { error: '找不到這筆強化結果' });
      r.split = { at: Date.now(), summary: String(b.summary || '').slice(0, 300) };
      save();
      return send(res, 200, { ok: true });
    }
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
    // 一鍵清除：已完成、已取消（含掛機指令）；failed: true 時連失敗的也清。執行中、待確認的不動
    if (req.method === 'POST' && url.pathname === '/api/jobs/clear') {
      const b = JSON.parse((await readBody(req)) || '{}');
      const st = new Set(b.failed ? ['failed'] : ['done', 'cancelled']);
      const before = db.jobs.length;
      db.jobs = db.jobs.filter(j => !st.has(j.status));
      save();
      return send(res, 200, { ok: true, removed: before - db.jobs.length });
    }
    // 一鍵重試：所有失敗的工作從失敗的那一批重新開始（手機版「全部重試」）
    if (req.method === 'POST' && url.pathname === '/api/jobs/retry-all') {
      let n = 0;
      for (const j of db.jobs) if (j.status === 'failed') { j.status = 'approved'; j.approvedAt = Date.now(); jobLog(j, `重試全部：從第 ${j.batchIndex + 1} 批重新開始`); n++; }
      save();
      return send(res, 200, { ok: true, retried: n });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs/approve-all') {
      for (const j of db.jobs) if (j.status === 'pending') { j.status = 'approved'; j.approvedAt = Date.now(); jobLog(j, '已確認，排隊等待執行'); }
      save();
      return send(res, 200, { ok: true });
    }

    // ---- 地圖／怪物／掉落資料 ----
    if (req.method === 'GET' && url.pathname === '/api/world/version') {
      let v = ''; try { v = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8')).version; } catch (_) {}
      return send(res, 200, { version: v });
    }
    if (req.method === 'GET' && url.pathname === '/api/world') {
      let txt = '{}'; try { txt = fs.readFileSync(WORLD_FILE, 'utf8'); } catch (_) {}
      return send(res, 200, txt);
    }
    if (req.method === 'POST' && url.pathname === '/api/world') {
      const body = await readBody(req, 30 * 1024 * 1024);
      const w = JSON.parse(body);
      if (!w || !Array.isArray(w.maps)) return send(res, 400, { error: 'bad world' });
      try { fs.writeFileSync(WORLD_FILE + '.tmp', body); fs.renameSync(WORLD_FILE + '.tmp', WORLD_FILE); } catch (e) { return send(res, 500, { error: e.message }); }
      return send(res, 200, { ok: true });
    }

    // ---- 角色全身照（遊戲分頁用遊戲自己的外觀產生器做好站姿 GIF 傳上來）----
    if (req.method === 'POST' && url.pathname === '/api/avatar') {
      const e = JSON.parse(await readBody(req, 2 * 1024 * 1024));
      const id = String((e && e.charId) || '').replace(/[^\w-]/g, '');
      const buf = e && e.gif ? Buffer.from(String(e.gif), 'base64') : null;
      if (!id || !buf || buf.length < 20 || buf.slice(0, 3).toString() !== 'GIF') return send(res, 400, { error: 'bad avatar' });
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      fs.writeFileSync(path.join(AVATAR_DIR, id + '.gif'), buf);
      db.avatars = db.avatars || {}; db.avatars[id] = { at: Date.now(), key: String(e.key || '').slice(0, 300) }; save();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/avatar/diag') {
      const e = JSON.parse(await readBody(req));
      if (e && e.charId) avatarDiag[String(e.charId)] = { at: Date.now(), step: String(e.step || ''), msg: String(e.msg || '').slice(0, 200) };
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/avatar-diag') return send(res, 200, avatarDiag);
    if (req.method === 'GET' && url.pathname.startsWith('/api/avatar/')) {
      const id = url.pathname.slice('/api/avatar/'.length).replace(/[^\w-]/g, '');
      const f = path.join(AVATAR_DIR, id + '.gif');
      if (!id || !fs.existsSync(f)) return send(res, 404, { error: 'no avatar' });
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'max-age=86400' }); return res.end(fs.readFileSync(f));
    }

    // ---- 組隊 ----
    if (req.method === 'POST' && url.pathname === '/api/party/apply') {
      const e = JSON.parse(await readBody(req));
      return send(res, 200, applyParties(e.parties));
    }
    if (req.method === 'POST' && url.pathname === '/api/party/code') {
      const e = JSON.parse(await readBody(req)); const r = partyRuns()[e.runId];
      if (r && e.code) { r.code = String(e.code); save(); }
      return send(res, 200, { ok: !!r });
    }
    if (req.method === 'GET' && url.pathname === '/api/party/run') return send(res, 200, partyRunInfo(url.searchParams.get('id') || ''));

    // ---- 野王 ----
    if (req.method === 'GET' && url.pathname === '/api/boss') {
      // v0.71：野王地圖用去處規則算好的自動販售（給面板、手機顯示；打王工作出發時也是用同一個算法）
      const destSell = {}; for (const m of worldFull().maps || []) if ((m.boss || []).length) destSell[m.id] = destSellOf(m.id, 'boss');
      return send(res, 200, { ...bossSummary(), destSell });
    }
    if (req.method === 'GET' && url.pathname === '/api/boss/need') {
      const c = bossCfg(), id = url.searchParams.get('charId') || '';
      return send(res, 200, { need: c.mode !== 'off' && !!c.chars[id] });
    }
    // 新的王：add＝加到等級夠的角色（有勾王、不是「全部」、等級 >= 王的等級）；之後標成已處理
    if (req.method === 'POST' && url.pathname === '/api/boss/new') {
      const e = JSON.parse(await readBody(req) || '{}'), b = bossDb(), list = bossNewList(), want = new Set(Array.isArray(e.mobs) ? e.mobs : list.map(x => x.mob));
      const added = [];
      if (e.add) {
        const cm = { ...bossCharMobs(db.settings.boss || {}) };
        for (const [id, mobs] of Object.entries(cm)) {
          if (!mobs.length || mobs.includes('*') || !db.chars[id]) continue;
          const lv = Number(db.chars[id].char.lv) || 0, add = list.filter(x => want.has(x.mob) && !mobs.includes(x.mob) && (!x.lv || lv >= x.lv));
          if (add.length) { cm[id] = [...mobs, ...add.map(x => x.mob)]; added.push(`${charName(id)}：${add.map(x => x.name).join('、')}`); }
        }
        db.settings.boss = { ...(db.settings.boss || {}), charMobs: cm };
        if (added.length) bossLog('', `新的王加到 ${added.length} 隻角色：${added.join('；')}`);
      }
      for (const m of want) if (b.known && b.known[m]) b.known[m].ack = Date.now();
      save();
      return send(res, 200, { ok: true, added, ...bossSummary() });
    }
    if (req.method === 'POST' && url.pathname === '/api/boss/state') {
      const e = JSON.parse(await readBody(req));
      if (!e || !e.charId || !Array.isArray(e.list)) return send(res, 400, { error: 'bad boss state' });
      bossDb().state[e.charId] = { at: Date.now(), offset: Number(e.serverTime) > 0 ? Number(e.serverTime) - Date.now() : 0,
        list: e.list.slice(0, 60).map(r => ({ map: String(r.map || ''), mapName: String(r.mapName || ''), mob: String(r.mob || ''), name: String(r.name || ''), instanceId: String(r.instanceId || ''), deadline: Number(r.deadline) || 0, spawned: !!r.spawned, available: !!r.available })) };
      bossKnow(bossDb().state[e.charId].list);
      save();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/boss/hp') {
      const e = JSON.parse(await readBody(req));
      if (e && e.instanceId) {
        if (e.hp == null) delete bossDb().hp[e.instanceId]; else bossDb().hp[e.instanceId] = { hp: Number(e.hp) || 0, maxHp: Number(e.maxHp) || 0, at: Date.now() };
        // 即時進度：這一趟第一次看到的血量與時間（算每分鐘掉多少、還要多久）
        const t = bossHpTrack[e.instanceId];
        if (e.hp != null && (!t || Date.now() - t.at > 60000)) bossHpTrack[e.instanceId] = { t0: Date.now(), hp0: Number(e.hp) || 0, at: Date.now() };
        else if (t) t.at = Date.now();
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/boss/stop') return send(res, 200, { ...bossStop(JSON.parse((await readBody(req)) || '{}') || {}), ...bossSummary() });
    if (req.method === 'POST' && url.pathname === '/api/boss/unhold') { const b = bossDb(); const e = JSON.parse((await readBody(req)) || '{}') || {}; if (b.hold) { if (e.charId) delete b.hold[e.charId]; else b.hold = {}; } save(); return send(res, 200, bossSummary()); }
    if (req.method === 'GET' && url.pathname === '/api/boss/stopreq') {
      const j = db.jobs.find(x => x.id === url.searchParams.get('job'));
      return send(res, 200, { stop: !!(j && (j.stopReq || j.status === 'cancelled')), why: (j && j.stopWhy) || '' });
    }
    // 連續打：打完一隻問下一隻
    if (req.method === 'POST' && url.pathname === '/api/boss/next') {
      const e = JSON.parse(await readBody(req));
      return send(res, 200, bossNext(e || {}));
    }
    if (req.method === 'POST' && url.pathname === '/api/boss/result') {
      const e = JSON.parse(await readBody(req));
      if (e && e.charId && e.logOnly) { bossLog(e.charId, String(e.msg || '')); return send(res, 200, { ok: true }); }
      if (!e || !e.charId || !e.mob) return send(res, 400, { error: 'bad boss result' });
      bossDb().last[e.charId + '|' + e.mob] = { at: Date.now(), result: String(e.result || 'error'), ms: Number(e.ms) || 0 };
      // 一起打：有人沒打成（倒下太多次、打不動、被換圖、出錯…）就整隊一起回去
      if (!['killed', 'cooling'].includes(e.result)) {
        const j = db.jobs.find(x => x.kind === 'boss' && ACTIVE.has(x.status) && x.fromCharId === e.charId);
        if (j && j.batches[0].boss.unit) for (const m of bossRunMates(j)) if (!m.stopReq) { m.stopReq = Date.now(); m.stopWhy = `隊友 ${j.fromName}：${BOSS_RESULT[e.result] || e.result}`; jobLog(m, `${m.stopWhy}，整隊一起回練功圖`); }
      }
      bossLog(e.charId, String(e.msg || BOSS_RESULT[e.result] || e.result));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/boss/run-now') { bossTick(true); return send(res, 200, bossSummary()); }

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
      const r = charId && stall ? market.reportStall(charId, stall) : null;
      return send(res, 200, { ok: true, autoClaim: market.cfg().autoClaim, delist: (r && r.delist) || [] });
    }
    if (req.method === 'POST' && url.pathname === '/api/market/delisted') {
      const { charId, rows } = JSON.parse(await readBody(req));
      if (charId) market.delisted(charId, rows);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/market/unblock') {
      const { k } = JSON.parse(await readBody(req));
      if (k) market.unblock(String(k));
      return send(res, 200, { ok: true });
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
      // 舊腳本看不懂「浮動達標／浮動分數」條件（會當成 0 → 全部賣掉）：沒帶版本或版本太舊的，用到這些條件的規則先不給
      const oldAgent = verLt(url.searchParams.get('v') || '0', '0.36.0');
      const rules = (a.rules || []).filter(r => !oldAgent || !(r.conds || []).some(c => /^_roll/.test(c.stat || '')));
      // rollProfiles：腳本判斷「浮動達標」用（跟面板的部位設定同一份；沒設定的部位用預設）
      return send(res, 200, { mode: a.mode || 'off', rules, chars: a.chars || {}, rollProfiles: db.settings.rollProfiles || {} });
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
      // 等你作答的題目：超過 12 小時沒再出現的（那輪已經結束）自動清掉
      for (const [k, u] of Object.entries(st.unknown)) if (Date.now() - (u.at || 0) > 12 * 3600e3 || bank[k]) delete st.unknown[k];
      const srcCount = {}; for (const x of Object.values(bank)) srcCount[x.src] = (srcCount[x.src] || 0) + 1;
      return send(res, 200, { auto: !!db.settings.quizAuto, answers, count: Object.keys(bank).length, srcCount, extdb: extdb.status(),
        share: (() => { const c = quizShareCfg(), ss = quizShareState(); return { on: c.on !== false, configured: quizShareOn() || /^https:/.test(c.url || ''), custom: !!(db.settings.quizShare && db.settings.quizShare.url), count: Object.keys((db.quizShared && db.quizShared.items) || {}).length, lastPull: ss.lastPull, lastPush: ss.lastPush, queue: ss.queue.length, sent: Object.keys(ss.sent).length, error: ss.error }; })(),
        unknown: Object.values(st.unknown).sort((a, b) => b.at - a.at).slice(0, 40), learned: Object.values(st.learned).slice(-100), log: st.log.slice(-50) });
    }
    if (req.method === 'GET' && url.pathname === '/api/quiz/export') {
      return send(res, 200, { version: 1, questions: Object.values(quizBank()).map(x => ({ q: x.q, options: x.options || [], answer: x.answer, src: x.src })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/quiz/learn') {
      const e = JSON.parse(await readBody(req));
      if (!e || !e.q || !e.answer) return send(res, 400, { error: '缺少題目或答案' });
      const k = qnorm(e.q), st = quizStore();
      const known = quizBank()[k];
      // 遊戲公布的正解（腳本送來的會帶 correct 欄位；面板自己作答的沒有）→ 送進共享題庫
      if (e.correct !== undefined && !(known && ['bank', 'ext'].includes(known.src) && qnorm(known.answer) === qnorm(e.answer))) quizShareQueue(e.q, (e.options || []).map(String), String(e.answer));
      if (!known || qnorm(known.answer) !== qnorm(e.answer)) {
        st.learned[k] = { q: String(e.q), options: (e.options || []).map(String), answer: String(e.answer), by: e.by || (e.charId ? charName(e.charId) : ''), at: Date.now() };
        quizLog(`${known ? '更正' : '新增'}：${e.q} → ${e.answer}${e.by ? '（' + e.by + '）' : ''}`);
      }
      delete st.unknown[k];
      save();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/quiz/share/sync') { const ss = quizShareState(); ss.lastPull = 0; await quizShareSync(true); return send(res, 200, { ok: !ss.error, error: ss.error }); }
    if (req.method === 'POST' && url.pathname === '/api/quiz/unknown') {
      const e = JSON.parse(await readBody(req));
      if (e && e.q) {
        const k = qnorm(e.q), st = quizStore();
        if (!st.unknown[k]) {
          quizLog(`題庫沒有，等你作答：${e.q}`);
          const ss = quizShareState(); if (quizShareOn() && Date.now() - ss.lastPull > 120e3) { ss.lastPull = 0; quizShareSync(false); } // 也許別人已經答過：馬上抓一次共享題庫
        }
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
      return send(res, 200, { ok: true, jobs, skipped: jobs.skipped || [] });
    }
    if (req.method === 'GET' && url.pathname === '/api/idle-policy') {
      const p = db.settings.idlePolicy || {};
      return send(res, 200, { policy: { autoRenew: !!p.autoRenew, renewBeforeMin: Number(p.renewBeforeMin) || 30, stopAfterHours: Number(p.stopAfterHours) || 0, wakeHours: Number(p.wakeHours) || 0,
        autoRevive: p.autoRevive !== false, reviveMaxPerHour: Number(p.reviveMaxPerHour) || 6 }, // 死掉自動原地復活：預設開
        excluded: db.settings.idleExcluded || {}, last: db.settings.idleLast || {} });
    }
    if (req.method === 'POST' && url.pathname === '/api/death') {
      const e = JSON.parse(await readBody(req));
      if (e && (e.ev === 'death' || e.ev === 'revive')) deathEvent(e);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/deaths') return send(res, 200, deathSummary());
    // 歸零：{charId} 只清那隻，沒給就全部
    if (req.method === 'POST' && url.pathname === '/api/deaths/reset') {
      const b = JSON.parse(await readBody(req) || '{}'), d = deathDb(), now = Date.now();
      if (b.charId) { d.log = d.log.filter(x => x.charId !== b.charId); d.since[b.charId] = now; }
      else { d.log = []; d.since = {}; }
      save(); return send(res, 200, deathSummary());
    }
    if (req.method === 'POST' && url.pathname === '/api/idle-log') {
      const e = JSON.parse(await readBody(req));
      if (e && e.charId && e.msg) {
        idleLog({ charId: e.charId, name: charName(e.charId), msg: String(e.msg).slice(0, 200), ...(e.kind ? { kind: String(e.kind) } : {}) });
        if (e.action) db.settings.idleLast = { ...(db.settings.idleLast || {}), [e.charId]: { action: e.action, at: Date.now(), by: 'auto' } };
      }
      return send(res, 200, { ok: true });
    }

    // 腳本查詢：這個帳號現在要做什麼
    // 分頁心跳：分頁在做很久的工作（打王、批次衝卷）時不會來問工作，用這個告訴中控它還在，免得工作被改派給同帳號的別的分頁
    if (req.method === 'GET' && url.pathname === '/api/agent/beat') {
      if (url.searchParams.get('bg') === '1' && realTabFor(url.searchParams.get('code') || '', url.searchParams.get('charId') || '', url.searchParams.get('page') || '')) return send(res, 200, { ok: true, standby: true });
      seenTab(url.searchParams.get('code') || '', url.searchParams.get('charId') || '', Object.fromEntries(url.searchParams));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/agent') {
      const code = url.searchParams.get('code') || '';
      const pollChar = url.searchParams.get('charId') || '';
      const peek = url.searchParams.get('peek') === '1';
      if (url.searchParams.get('bg') === '1' && realTabFor(code, pollChar, url.searchParams.get('page') || '')) return send(res, 200, { job: null, standby: true });
      if (!peek) seenTab(code, pollChar, Object.fromEntries(url.searchParams));
      // 掛機指令馬上執行，不用排在交易後面（交給指定的分頁；沒指定就給帳號的任一分頁）
      const idleJob = db.jobs.filter(j => j.kind === 'idle' && ACTIVE.has(j.status) && j.fromCode === code).sort(jobCmp).find(j => routeOf(j, code) === pollChar);
      if (idleJob) return send(res, 200, { job: idleJob, role: 'owner', peerReady: true });
      const job = headFor(code, pollChar);
      if (!job) return send(res, 200, { job: null });
      const old = agentTooOld(job, code, pollChar);
      if (old) {
        const msg = `等待 ${job.fromName} 的遊戲分頁換上新腳本（目前 v${old}，需要 v${job.minAgent || KIND_MIN_AGENT[job.kind]} 以上；太久沒換請手動重新整理那個分頁）`;
        if (job.lastMsg !== msg) { jobLog(job, msg); job.lastMsg = msg; save(); }
        return send(res, 200, { job: null, needUpdate: job.minAgent || KIND_MIN_AGENT[job.kind] });
      }
      if (BAG_KINDS.has(job.kind)) return send(res, 200, { job, role: 'owner', peerReady: true });
      const role = job.fromCode === code ? 'giver' : 'receiver';
      const peer = role === 'giver' ? job.toCode : job.fromCode;
      // 對方帳號也必須以這個工作為優先（而且是要交易的那隻角色的分頁在處理），才開始（避免同時跟兩個人交易）
      const peerTab = routeOf(job, peer);
      const peerReady = !!peerTab && headFor(peer, peerTab) === job && tradeHead(code) === job;
      if (peerReady && !peek) lockJob(job);
      return send(res, 200, { job, role, peerReady });
    }
    // 分頁要換角色（切換）或關閉前通知：這個分頁不再負責那隻角色
    if (req.method === 'POST' && url.pathname === '/api/agent/leave') {
      const b = JSON.parse(await readBody(req) || '{}');
      const t = tabs[b.code] && tabs[b.code][b.charId];
      if (t && (!b.page || t.page === b.page)) delete tabs[b.code][b.charId];
      return send(res, 200, { ok: true });
    }
    // 收貨方發現遊戲裡已經有某個帳號的邀請：如果那個帳號正好有工作要交給我，就改成先處理它
    if (req.method === 'POST' && url.pathname === '/api/agent/claim') {
      const { code, inviterCode } = JSON.parse(await readBody(req));
      const job = db.jobs.filter(j => ACTIVE.has(j.status) && !BAG_KINDS.has(j.kind) && j.fromCode === inviterCode && j.toCode === code)
        .sort((a, b) => { const x = jobOrder(a), y = jobOrder(b); return x[0] - y[0] || x[1] - y[1]; })[0];
      if (!job) return send(res, 200, { ok: false });
      const cur = tradeHead(code);
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
  bg.boot();
  lobby.boot();
});
// 正常關閉中控（Ctrl+C、關掉視窗）時一起關掉背景 Chrome；自動更新重新啟動（exit 3）不會經過這裡，背景 Chrome 會繼續跑、中控起來後接回去
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      if (shuttingDown) return; shuttingDown = true;
      clearTimeout(saveTimer); try { fs.writeFileSync(STATE_FILE, JSON.stringify(db)); } catch (_) {}
      Promise.race([bg.shutdown(), new Promise(r => setTimeout(r, 8000))]).finally(() => process.exit(0));
    });
  } catch (_) {}
}
