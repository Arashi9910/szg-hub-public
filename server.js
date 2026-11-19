// 上漲谷中控 - 本機伺服器（不需要安裝任何套件，Node.js 18 以上即可）
// 啟動：node server.js   然後打開 http://127.0.0.1:8787
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const updater = require('./update');
const makeMarket = require('./market');
const makeExtDb = require('./extdb');

const PORT = Number(process.env.PORT) || 8787;
// 只接受本機連線
const HOST = '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DASHBOARD = path.join(__dirname, 'dashboard.html');
const USERSCRIPT = path.join(__dirname, 'szg-hub.user.js');
const AGENT_FILE = path.join(__dirname, 'agent.js');
const WORLD_FILE = path.join(__dirname, 'data', 'world.json'); // 遊戲的地圖／怪物／掉落表（由遊戲頁面上傳）

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
  // 優先順序：冒險資料庫 < 內建題庫 < 你自己學到／更正的
  try { for (const x of extdb.quizList()) bank[qnorm(x.q)] = { q: x.q, options: x.options, answer: x.answer, src: 'ext' }; } catch (_) {}
  try {
    for (const x of JSON.parse(fs.readFileSync(QUIZ_FILE, 'utf8')).questions || []) if (x.q && x.answer) bank[qnorm(x.q)] = { q: x.q, options: x.options || [], answer: x.answer, src: 'bank' };
  } catch (_) {}
  for (const [k, x] of Object.entries(quizStore().learned)) bank[k] = { ...x, src: 'learned' };
  return bank;
}
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
market = makeMarket(() => db, save, id => charName(id));
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
  t[charId] = { page: q.page || '', at: Date.now(), hidden: q.hidden === '1', off: q.off === '1' };
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

const BAG_KINDS = new Set(['sell', 'lock', 'unlock', 'idle', 'forge']);
// 新種類的工作要遊戲分頁的腳本夠新才看得懂：還沒換上新腳本的，工作先排隊等，不交給它（避免「未知的工作類型」直接失敗）
const KIND_MIN_AGENT = { forge: '0.27.0' };
const verLt = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
function agentTooOld(job, code, charId) {
  const need = KIND_MIN_AGENT[job.kind]; if (!need) return false;
  const snap = (charId && db.chars[charId]) || Object.values(db.chars).filter(s => s.playerCode === code).sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0))[0];
  return !snap || verLt(snap.scriptVersion, need) ? (snap ? snap.scriptVersion || '?' : '?') : false;
}
// 公會倉庫：存入、領取、查看都是「某隻角色在自己頁面執行」的背包工作
for (const k of ['guildDeposit', 'guildWithdraw', 'guildView', 'guildSell']) BAG_KINDS.add(k);
Object.assign(KIND_MIN_AGENT, { guildDeposit: '0.25.0', guildWithdraw: '0.25.0', guildView: '0.25.0', guildSell: '0.28.0' });
// 存楓幣／點數到公倉：一定要使用者在工作清單逐一確認（「全部確認」也不包含它）
BAG_KINDS.add('guildMoney'); KIND_MIN_AGENT.guildMoney = '0.34.0';
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
  if (t === 'gloves') return { stats: ['incPAD', 'incSTR', 'incDEX', 'incINT', 'incLUK'], min: 1 };
  return { stats: ['incSTR', 'incDEX', 'incINT', 'incLUK', 'incPAD', 'incMAD'], min: 1 };
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
function guildPlanFor(snap, dep) {
  const names = new Set(dep.names || []), cats = new Set(dep.cats || []), keep = Math.max(0, Number(dep.keep) || 0);
  const items = [], gear = [];
  for (const it of snap.items || []) {
    if (it.loc !== '背包' || !(it.tradableQty > 0) || it.supply) continue;
    if (!names.has('i:' + it.key) && !cats.has(it.kind)) continue;
    const qty = it.tradableQty - keep;
    if (qty > 0) items.push({ key: it.key, name: it.name, qty });
  }
  for (const g of snap.gear || []) {
    if (g.loc !== '背包' || g.locked || !g.tradable) continue;
    if (!names.has('g:' + g.name) && !cats.has('裝備')) continue;
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
  if (!(dep.names || []).length && !(dep.cats || []).length) { guildLog('自動存入：存入規則還沒設定要存什麼，略過'); save(); return; }
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

// ================= 掛機控制 =================
// 指令（開始／暫停／重新開始）依帳號分組，交給那個帳號目前在線的遊戲頁面執行；
// 同帳號的第二隻角色也可以直接控制（遊戲允許用 characterId 指定）。
const IDLE_ACTIONS = new Set(['start', 'stop', 'restart', 'switch', 'wake', 'map', 'autosell']);
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
    };
    jobLog(job, '已送出：' + list.map(t => `${t.name} ${({ start: '開始掛機', stop: '暫停掛機', restart: '重新開始掛機', switch: '切換為目前角色', wake: '領取離線掛機收益', map: '前往 ' + (t.mapName || '') + (t.sell ? '（套用自動販售）' : ''), autosell: '套用 ' + (t.mapName || '') + ' 的自動販售' })[t.action]}`).join('、'));
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
function createBagJob(body) {
  const owner = db.chars[body.fromCharId];
  if (!owner) throw new Error('找不到角色資料');
  if (!owner.playerCode) throw new Error('角色還沒回報 12 碼 ID，請先更新腳本並打開遊戲頁面');
  const b = (body.batches || [])[0] || {};
  if (body.kind === 'guildMoney') {
    const mesos = Math.floor(Number(b.mesos) || 0), cash = Math.floor(Number(b.cash) || 0);
    if (!(mesos > 0) && !(cash > 0)) throw new Error('沒有填要存的楓幣或點數');
    if (mesos < 0 || cash < 0) throw new Error('金額不能是負數');
    const job = {
      id: crypto.randomBytes(6).toString('hex'), kind: 'guildMoney', status: 'pending', createdAt: Date.now(),
      fromCharId: owner.char.id, fromName: owner.char.name, fromCode: owner.playerCode,
      toCharId: owner.char.id, toName: owner.char.name, toCode: owner.playerCode,
      batches: [{ items: [], gear: [], money: 0, mesos, cash }], batchIndex: 0, log: [], lastMsg: '',
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
    if (req.method === 'GET' && url.pathname === '/api/data') {
      const tabsOut = {}; for (const [code, m] of Object.entries(tabs)) for (const [id, t] of Object.entries(m)) if (Date.now() - t.at < TAB_LIVE_MS) tabsOut[id] = { code, at: t.at, hidden: t.hidden, off: t.off };
      return send(res, 200, { now: Date.now(), tabs: tabsOut, chars: db.chars, dps: db.dps || {}, settings: db.settings, jobs: db.jobs.slice(-100), expTable: db.expTable || {}, idleLog: (db.idleLog || []).slice(-50), gearLog: (db.gearLog || []).slice(-80), scriptVersion: scriptVersion(), update: updateInfo });
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
      db.settings = { ...db.settings, ...patch };
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
      if (db.jobs.some(j => ACTIVE.has(j.status))) return send(res, 409, { error: '有交易工作正在執行，請等它結束或取消後再更新' });
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
    if (req.method === 'GET' && url.pathname === '/api/forge') return send(res, 200, { log: (db.forgeLog || []).slice(-40) });
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
    if (req.method === 'POST' && url.pathname === '/api/jobs/approve-all') {
      for (const j of db.jobs) if (j.status === 'pending' && j.kind !== 'guildMoney') { j.status = 'approved'; j.approvedAt = Date.now(); jobLog(j, '已確認，排隊等待執行'); }
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
      // 等你作答的題目：超過 12 小時沒再出現的（那輪已經結束）自動清掉
      for (const [k, u] of Object.entries(st.unknown)) if (Date.now() - (u.at || 0) > 12 * 3600e3 || bank[k]) delete st.unknown[k];
      const srcCount = {}; for (const x of Object.values(bank)) srcCount[x.src] = (srcCount[x.src] || 0) + 1;
      return send(res, 200, { auto: !!db.settings.quizAuto, answers, count: Object.keys(bank).length, srcCount, extdb: extdb.status(),
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
      return send(res, 200, { ok: true, jobs, skipped: jobs.skipped || [] });
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
      const pollChar = url.searchParams.get('charId') || '';
      const peek = url.searchParams.get('peek') === '1';
      if (!peek) seenTab(code, pollChar, Object.fromEntries(url.searchParams));
      // 掛機指令馬上執行，不用排在交易後面（交給指定的分頁；沒指定就給帳號的任一分頁）
      const idleJob = db.jobs.filter(j => j.kind === 'idle' && ACTIVE.has(j.status) && j.fromCode === code).sort(jobCmp).find(j => routeOf(j, code) === pollChar);
      if (idleJob) return send(res, 200, { job: idleJob, role: 'owner', peerReady: true });
      const job = headFor(code, pollChar);
      if (!job) return send(res, 200, { job: null });
      const old = agentTooOld(job, code, pollChar);
      if (old) {
        const msg = `等待 ${job.fromName} 的遊戲分頁換上新腳本（目前 v${old}，需要 v${KIND_MIN_AGENT[job.kind]} 以上；太久沒換請手動重新整理那個分頁）`;
        if (job.lastMsg !== msg) { jobLog(job, msg); job.lastMsg = msg; save(); }
        return send(res, 200, { job: null, needUpdate: KIND_MIN_AGENT[job.kind] });
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
});
