// 上漲谷中控 - 背景執行：不用開 Chrome 視窗，由中控在背景開「無頭 Chrome」跑遊戲頁面＋中控腳本
//
// 運作方式：
//   - 每個遊戲帳號一個獨立的 Chrome 資料夾（data/bg/<編號>），和你平常的 Chrome 分開，所以要各自登入一次
//   - 登入：開一個「一般的 Chrome 視窗」（沒有任何自動化，Google 登入不會被擋），登入後關掉視窗
//   - 背景：同一個資料夾用 --headless=new 開，透過 Chrome DevTools Protocol（Node 22 內建 WebSocket，不用裝套件）
//     在每個遊戲分頁一開始就注入「szg-hub.user.js＋agent.js」，等於在背景版 Chrome 裝了竄改猴腳本
//   - 腳本要連中控（GM_xmlhttpRequest）一律由這裡代送，而且只准連到中控本身
//   - 中控重新啟動（例如自動更新）時，背景 Chrome 會繼續跑，中控起來後重新接上，不會打斷遊戲分頁
//   - 你平常的 Chrome 也開著同一隻角色時，背景那頁自動讓位（agent 的 bgStandby），關掉後再接手
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const GAME = (process.env.SZG_BG_GAME || 'https://play.szg08.com').replace(/\/+$/, ''); // 測試時指到模擬遊戲
const LOGIN_PATH = process.env.SZG_BG_LOGIN_PATH || '/game/';
const LOGIN_HEADLESS = process.env.SZG_BG_LOGIN_HEADLESS === '1'; // 只給測試用（雲端沒有螢幕）
const TICK_MS = Number(process.env.SZG_BG_TICK_MS) || 15000;
const ACCT_CHECK_MS = 60000;
const RELOAD_GAP_MS = Number(process.env.SZG_BG_RELOAD_GAP_MS) || 60000; // 定時重新整理：兩頁之間至少隔多久（錯開）

const sleep = ms => new Promise(r => setTimeout(r, ms));
const onGameUrl = u => String(u || '').startsWith(GAME + '/game');

function findChrome(custom) {
  const c = [custom, process.env.SZG_CHROME];
  if (process.platform === 'win32') {
    for (const b of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) if (b) c.push(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return c.find(p => p && fs.existsSync(p)) || '';
}

// ---------- Chrome DevTools Protocol（一條連線、flatten session） ----------
class Cdp {
  constructor(url) {
    this.n = 0; this.wait = new Map(); this.handlers = new Set(); this.closed = false;
    this.ready = new Promise((ok, bad) => {
      const ws = this.ws = new WebSocket(url);
      const t = setTimeout(() => { bad(new Error('連不上背景 Chrome（逾時）')); try { ws.close(); } catch (_) {} }, 8000);
      ws.onopen = () => { clearTimeout(t); ok(); };
      ws.onerror = () => { clearTimeout(t); bad(new Error('連不上背景 Chrome')); };
      ws.onclose = () => {
        this.closed = true;
        for (const w of this.wait.values()) { clearTimeout(w.t); w.bad(new Error('背景 Chrome 連線中斷')); }
        this.wait.clear();
        for (const h of this.handlers) { try { h({ method: '__closed' }); } catch (_) {} }
      };
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (_) { return; }
        if (m.id && this.wait.has(m.id)) {
          const w = this.wait.get(m.id); this.wait.delete(m.id); clearTimeout(w.t);
          if (m.error) w.bad(new Error(m.error.message || 'CDP 錯誤')); else w.ok(m.result || {});
        } else if (m.method) for (const h of this.handlers) { try { h(m); } catch (_) {} }
      };
    });
  }
  send(method, params = {}, sessionId, ms = 15000) {
    if (this.closed) return Promise.reject(new Error('背景 Chrome 連線中斷'));
    const id = ++this.n;
    return new Promise((ok, bad) => {
      const t = setTimeout(() => { this.wait.delete(id); bad(new Error(method + ' 逾時')); }, ms);
      this.wait.set(id, { ok, bad, t });
      try { this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); }
      catch (e) { clearTimeout(t); this.wait.delete(id); bad(e); }
    });
  }
  on(h) { this.handlers.add(h); }
  close() { try { this.ws.close(); } catch (_) {} }
}

// 每個分頁檢查一次：網址、畫面上的角色、腳本有沒有在跑、是否讓位；每分鐘多問一次帳號（看有沒有登入）
const probeExpr = withAcct => `(async () => {
  const o = { url: location.href, char: sessionStorage.getItem('mapleCharacter') || '', hasState: !!sessionStorage.getItem('mapleSessionView'), loadedAt: Math.round(performance.timeOrigin), busy: !!(window.__szgBg && window.__szgBg.isBusy && window.__szgBg.isBusy()), bg: window.__szgBg ? { key: window.__szgBg.key, standby: !!window.__szgBg.standby, lite: !!window.__szgBg.lite } : null, hidden: document.hidden, badge: ((document.getElementById('szg-hub-badge') || {}).textContent || '').slice(0, 120) };
  if (${withAcct ? 'true' : 'false'} && location.origin === ${JSON.stringify(GAME)}) {
    try { const r = await fetch('/api/account', { cache: 'no-store', credentials: 'same-origin' }); o.acct = r.status; if (r.ok) { const j = await r.json(); o.code = j.playerCode || ''; o.chars = j.characterIds || []; } } catch (e) { o.acct = 0; }
  }
  return o;
})()`;

module.exports = function makeBg(opt) {
  const { dataDir, hubUrl, getCfg, setCfg, userscript, agent } = opt;
  // 紀錄：印在中控視窗，也留最近 100 筆給「帳號」分頁看（v0.71.3，查視窗被關掉之類的問題）
  const events = [];
  const log0 = opt.log || (m => console.log('[背景] ' + m));
  const log = m => { events.push({ at: Date.now(), msg: String(m).slice(0, 300) }); if (events.length > 100) events.splice(0, events.length - 100); log0(m); };
  const run = {}; // 設定檔 id -> 執行狀態
  const cfg = () => { const c = getCfg() || {}; return { chromePath: c.chromePath || '', lite: c.lite !== false, trimMin: c.trimMin === undefined ? 10 : Math.max(0, Number(c.trimMin) || 0), reloadHours: c.reloadHours === undefined ? 6 : Math.max(0, Number(c.reloadHours) || 0), profiles: Array.isArray(c.profiles) ? c.profiles : [] }; };
  const prof = id => cfg().profiles.find(p => p.id === id);
  const dirOf = id => path.join(dataDir, 'bg', String(id).replace(/[^\w-]/g, ''));
  const R = id => run[id] || (run[id] = { id, state: 'off', msg: '', pages: {}, fails: [], busy: false, needLogin: false, cdp: null, login: null });
  const wantKeys = p => { const l = (p.pages && p.pages.length ? p.pages : ['']); return [...new Set(l.map(c => c || '_'))]; };
  function patchProf(id, patch) {
    const c = getCfg() || {}; const list = (c.profiles || []).map(p => p.id === id ? { ...p, ...patch } : p);
    setCfg({ ...c, profiles: list });
  }

  function prepDir(dir) {
    fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
    const pf = path.join(dir, 'Default', 'Preferences');
    // 「繼續上次的工作階段」：遊戲的登入 cookie 如果是工作階段 cookie，關掉登入視窗後也不會消失
    if (!fs.existsSync(pf)) fs.writeFileSync(pf, JSON.stringify({ session: { restore_on_startup: 1 } }));
  }
  const sandboxArgs = () => (process.platform === 'linux' && process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []);

  // ---------- 分頁裡注入的程式（等於背景版的竄改猴＋中控腳本） ----------
  function injected(id, key, lite) {
    const us = userscript(); const body = us.split('// ==/UserScript==')[1] || us;
    const fixed = body.replace(/const HUB = '[^']*';/, `const HUB = ${JSON.stringify(hubUrl)};`);
    return `(function(){
if (location.origin !== ${JSON.stringify(GAME)} || location.pathname.indexOf('/game') !== 0) return;
if (window.__szgBg) return; // 防止重複注入
window.__szgBg = { profile: ${JSON.stringify(id)}, key: ${JSON.stringify(key)}, standby: false, lite: ${lite ? 'true' : 'false'} };
${lite ? `// 省資源模式：背景分頁沒人看，動畫每 0.5 秒畫一格就好（遊戲資料照常同步），關掉 CSS 動畫
(function(){ try { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => setTimeout(() => raf(cb), 500); } catch (_) {}
  const st = () => { try { const e = document.createElement('style'); e.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; (document.head || document.documentElement).appendChild(e); } catch (_) {} };
  if (document.documentElement) st(); else document.addEventListener('DOMContentLoaded', st); })();` : ''}
const unsafeWindow = window;
const GM_getValue = (k, d) => { try { const v = localStorage.getItem('__gm:' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
const GM_setValue = (k, v) => { try { localStorage.setItem('__gm:' + k, JSON.stringify(v)); } catch (_) {} };
let __n = 0; const __cb = {};
window.__szgGmxDone = (i, r) => { const o = __cb[i]; if (!o) return; delete __cb[i]; clearTimeout(o.__t);
  try { if (r.error) { if (r.error === 'timeout') { o.ontimeout ? o.ontimeout() : o.onerror && o.onerror(r); } else o.onerror && o.onerror(r); } else o.onload && o.onload(r); } catch (e) { console.error(e); } };
const GM_xmlhttpRequest = o => { const i = ++__n; __cb[i] = o; const ms = o.timeout || 30000;
  o.__t = setTimeout(() => { if (!__cb[i]) return; delete __cb[i]; o.ontimeout ? o.ontimeout() : o.onerror && o.onerror({ error: 'timeout' }); }, ms + 3000);
  try { window.__szgGmx(JSON.stringify({ id: i, method: o.method || 'GET', url: String(o.url), headers: o.headers || {}, data: o.data == null ? null : String(o.data), timeout: ms })); }
  catch (e) { delete __cb[i]; clearTimeout(o.__t); setTimeout(() => o.onerror && o.onerror({ error: String(e) }), 0); } };
${agent()}
${fixed}
})();`;
  }

  // 腳本連中控：只准連到中控本身
  async function gmx(cdp, sid, p) {
    let o; try { o = JSON.parse(p.payload); } catch (_) { return; }
    let out;
    try {
      const u = new URL(o.url);
      if (u.origin !== new URL(hubUrl).origin) throw new Error('背景執行只允許連到中控');
      const method = String(o.method || 'GET').toUpperCase();
      const r = await fetch(u, { method, headers: o.headers || {}, body: method === 'GET' || method === 'HEAD' || o.data == null ? undefined : o.data, signal: AbortSignal.timeout(Math.min(Number(o.timeout) || 8000, 120000)) });
      out = { status: r.status, responseText: await r.text() };
    } catch (e) { out = { error: e && e.name === 'TimeoutError' ? 'timeout' : String((e && e.message) || e) }; }
    cdp.send('Runtime.evaluate', { expression: `window.__szgGmxDone && window.__szgGmxDone(${Number(o.id)}, ${JSON.stringify(out)})`, contextId: p.executionContextId }, sid).catch(() => {});
  }

  // 省資源模式：背景（看不到的）分頁不下載圖片、音效、影片（遊戲資料、全身照 /api/appearance 不受影響）
  const LITE_BLOCK = ['*.png', '*.png?*', '*.jpg', '*.jpg?*', '*.jpeg', '*.gif', '*.gif?*', '*.webp', '*.webp?*', '*.svg', '*.mp3', '*.mp3?*', '*.ogg', '*.ogg?*', '*.wav', '*.m4a', '*.mp4', '*.webm', '*.woff', '*.woff2', '*.ttf'];
  const liteFor = r => cfg().lite && !r.visible && !r.noLite;
  async function applyLiteNet(r, sid) {
    await r.cdp.send('Network.enable', {}, sid).catch(() => {});
    await r.cdp.send('Network.setBlockedURLs', { urls: liteFor(r) ? LITE_BLOCK : [] }, sid).catch(() => {});
  }
  async function setupSession(r, key, sid) {
    const { cdp } = r;
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Runtime.addBinding', { name: '__szgGmx' }, sid);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid).catch(() => {}); // 背景分頁也當成「看得到」，不會掉進離線掛機
    await applyLiteNet(r, sid);
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injected(r.id, key, liteFor(r)) }, sid);
    return identifier;
  }
  // 「帳號目前的角色」那頁（key '_'）改成固定那隻角色：不重開分頁，只換注入的 key（重新整理、中控重啟後也認得）
  // 省資源模式切換後：每頁換注入、換擋的網址，再重新整理
  async function reapplyLite(r) {
    for (const [key, pg] of Object.entries(r.pages)) {
      try {
        if (pg.scriptId) await r.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: pg.scriptId }, pg.sessionId).catch(() => {});
        await applyLiteNet(r, pg.sessionId);
        pg.scriptId = (await r.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injected(r.id, key, liteFor(r)) }, pg.sessionId)).identifier;
        await r.cdp.send('Page.reload', {}, pg.sessionId);
        pg.openedAt = Date.now();
      } catch (_) {}
    }
  }
  async function rekeyPage(r, from, to) {
    const pg = r.pages[from]; if (!pg || r.pages[to] || !r.cdp) return false;
    try {
      if (pg.scriptId) await r.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: pg.scriptId }, pg.sessionId).catch(() => {});
      const { identifier } = await r.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injected(r.id, to, liteFor(r)) }, pg.sessionId);
      await r.cdp.send('Runtime.evaluate', { expression: `window.__szgBg && (window.__szgBg.key = ${JSON.stringify(to)})` }, pg.sessionId).catch(() => {});
      pg.scriptId = identifier; pg.char = to;
      delete r.pages[from]; r.pages[to] = pg;
      return true;
    } catch (_) { return false; }
  }

  async function openPage(r, key) {
    const char = key === '_' ? '' : key;
    const url = GAME + '/game/' + (char ? '?szgChar=' + encodeURIComponent(char) : '');
    const { targetId } = await r.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await r.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const scriptId = await setupSession(r, key, sessionId);
    r.pages[key] = { targetId, sessionId, scriptId, char, openedAt: Date.now(), info: null, fail: 0, acctAt: 0 };
    await r.cdp.send('Page.navigate', { url }, sessionId);
  }
  async function closePage(r, key) {
    const pg = r.pages[key]; delete r.pages[key];
    if (pg && r.cdp && !r.cdp.closed) await r.cdp.send('Target.closeTarget', { targetId: pg.targetId }).catch(() => {});
  }

  async function wsFromDir(dir, waitMs) {
    const end = Date.now() + waitMs;
    for (;;) {
      try {
        const [port] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
        const j = await (await fetch(`http://127.0.0.1:${Number(port)}/json/version`, { signal: AbortSignal.timeout(1500) })).json();
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      } catch (_) {}
      if (Date.now() >= end) return '';
      await sleep(300);
    }
  }

  function onEvent(r, m, cdp) {
    if (m.method === '__closed') {
      if (r.cdp && r.cdp !== cdp) return; // 舊的連線（已經換新的 Chrome 了）
      if (r.stopping) { r.cdp = null; r.pages = {}; return; } // 中控自己關的（停止、登入、切換顯示）：不算當掉
      if (r.visible) { r.visible = ''; r.state = 'off'; r.msg = ''; r.cdp = null; r.pages = {}; log(`${(prof(r.id) || {}).name}：顯示的視窗關掉了，回到背景`); return; } // 使用者關掉「顯示」的視窗：下一輪自動回到無頭背景
      if (r.state === 'running') { r.state = 'error'; r.msg = '背景 Chrome 關掉了，稍後自動重開'; r.fails.push(Date.now()); } r.cdp = null; r.pages = {}; return; }
    if (m.method === 'Runtime.bindingCalled' && m.params && m.params.name === '__szgGmx') return void gmx(cdp, m.sessionId, m.params);
    const pg = Object.entries(r.pages).find(([, p]) => p.sessionId === m.sessionId);
    // 分頁裡的錯誤記下來（面板看得到最近幾筆，方便查問題）
    if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params && (m.params.type === 'error' || m.params.type === 'warning'))) {
      const d = m.params.exceptionDetails, txt = d ? ((d.exception && d.exception.description) || d.text || '') : (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
      // 只記中控腳本自己的錯誤、和真正沒處理到的例外；遊戲自己的連線逾時（client error during sync AbortError）是遊戲會自己重試的訊息，不列入
      const t = String(txt);
      const mine = /szg-hub|中控/.test(t), benign = /AbortError|signal is aborted|client error during sync|Failed to fetch/i.test(t);
      if (m.method === 'Runtime.consoleAPICalled' ? !mine : (benign && !mine)) return;
      (r.logs || (r.logs = [])).push({ at: Date.now(), page: pg ? pg[0] : '', msg: t.slice(0, 300) }); if (r.logs.length > 30) r.logs.shift();
      return;
    }
    if (m.method === 'Inspector.targetCrashed' && pg) { pg[1].crashed = true; return; }
    if (m.method === 'Target.detachedFromTarget' && m.params) { const k = Object.entries(r.pages).find(([, p]) => p.sessionId === m.params.sessionId); if (k) delete r.pages[k[0]]; }
  }

  async function start(id, opt = {}) {
    const p = prof(id); if (!p) throw new Error('沒有這個背景帳號');
    const r = R(id);
    if (r.busy || r.login) return;
    r.busy = true; r.state = 'starting'; r.msg = ''; r.needLogin = false;
    let reattachTried = false;
    try {
      if (typeof WebSocket !== 'function') throw new Error('背景執行需要 Node.js 22 以上（目前 ' + process.version + '）');
      const chrome = findChrome(cfg().chromePath);
      if (!chrome) throw new Error('找不到 Chrome：請在下面填 chrome.exe 的位置');
      const dir = dirOf(id); prepDir(dir);
      // 中控重新啟動後，背景 Chrome 可能還在跑：直接接上
      let ws = opt.visible ? '' : await wsFromDir(dir, 0), reattach = !!ws;
      reattachTried = reattach;
      // v0.71.2：接不上的時候先看這個資料夾是不是有 Chrome 開著，不要一律關掉（以前自動更新重開中控時，會把開著的視窗關掉）
      //   - 中控開的 Chrome（有遠端除錯）：多半是電腦正忙、一下子沒回應，多等一下再接
      //   - 不是中控開的（登入視窗、自己開的視窗）：不關，等它關掉再開始；按「開始」（opt.force）才會照舊關掉重開
      if (!ws && !opt.visible) {
        const mine = await chromeOf(id);
        if (mine.some(x => /--remote-debugging-port/.test(x.cmd))) { ws = await wsFromDir(dir, 12000); reattach = reattachTried = !!ws; if (!ws) log(`${p.name}：背景 Chrome 等了 12 秒沒回應，關掉重開`); }
        else if (mine.length && !opt.force) {
          r.state = 'wait'; r.msg = '這個帳號的 Chrome 視窗開著（可能是登入視窗）：關掉後會自動開始背景執行';
          if (!r.waitLogged) { r.waitLogged = true; log(`${p.name}：${r.msg}`); }
          return;
        }
      }
      r.waitLogged = false;
      r.visible = opt.visible ? String(opt.visible) : '';
      if (!ws) {
        // 先清掉殘留：還佔著這個資料夾的 Chrome（登入視窗關了但程式沒結束）、上次沒清乾淨的鎖定檔
        const killed = await killStale(id);
        for (const f of ['DevToolsActivePort', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) {} }
        const logFile = path.join(dir, 'chrome-start.log');
        let logFd = 'ignore'; try { logFd = fs.openSync(logFile, 'w'); } catch (_) {}
        const args = [...(opt.visible ? ['--new-window'] : ['--headless=new']), '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
          '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
          '--mute-audio', '--window-size=1280,800',
          // 省記憶體：同一個遊戲網站的分頁共用一個程序；關掉背景 Chrome 用不到的功能（同步、擴充、元件更新、翻譯…）
          '--process-per-site', '--disable-extensions', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--disable-background-networking',
          '--disable-breakpad', '--no-pings', '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CalculateNativeWinOcclusion,HeavyAdIntervention,BackForwardCache',
          ...(opt.visible ? [] : ['--disable-gpu', '--disable-gpu-compositing']), ...sandboxArgs(), 'about:blank'];
        const t0 = Date.now();
        const proc = spawn(chrome, args, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
        if (typeof logFd === 'number') try { fs.closeSync(logFd); } catch (_) {}
        let exited = null, spawnErr = '';
        proc.on('error', e => { spawnErr = e.message; });
        proc.on('exit', (code, sig) => { exited = { code, sig, at: Date.now() }; });
        proc.unref();
        // 電腦忙的時候（一次開很多帳號）Chrome 可能要好一陣子才準備好：最多等 60 秒；Chrome 自己先結束就不用等
        const end = Date.now() + 60000;
        while (!ws && Date.now() < end && !spawnErr) {
          ws = await wsFromDir(dir, 0);
          if (ws) break;
          // 一啟動就結束：Windows 上常是「交給另一個正在用這個資料夾的 Chrome」然後自己退出；多給 3 秒看看檔案是否出現
          if (exited && Date.now() - exited.at > 3000) break;
          await sleep(400);
        }
        if (!ws) {
          const tail = (() => { try { return fs.readFileSync(logFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^\[\d+:\d+:\d+\/\d+\.\d+:(INFO|VERBOSE)/.test(l)).slice(-3).join(' ｜ ').slice(0, 300); } catch (_) { return ''; } })();
          const sec = Math.round((Date.now() - t0) / 1000), extra = (killed ? `（啟動前已結束 ${killed} 個殘留的 Chrome）` : '') + (tail ? `　Chrome 訊息：${tail}` : '');
          if (spawnErr) throw new Error('開不了 Chrome：' + spawnErr);
          if (exited) throw new Error(`背景 Chrome 一啟動就結束了（結束碼 ${exited.code ?? exited.sig}）。可能是這個帳號的資料夾正被別的 Chrome 使用，或資料夾損壞：可以按「刪除」後重新加入這個帳號${extra}`);
          try { process.kill(proc.pid); } catch (_) {}
          throw new Error(`背景 Chrome 等了 ${sec} 秒還沒準備好：電腦可能太忙（同時開太多帳號），可以晚點再按開始，或少開幾個${extra}`);
        }
      }
      const cdp = new Cdp(ws); await cdp.ready;
      r.cdp = cdp; r.pages = {};
      cdp.on(m => onEvent(r, m, cdp));
      const { targetInfos } = await cdp.send('Target.getTargets');
      const pagesT = (targetInfos || []).filter(t => t.type === 'page');
      const want = wantKeys(p);
      const extra = [];
      // v0.71.3：接回時先看是不是看得到的視窗（以前要接完分頁才知道，看得到的視窗會被當成背景套用省資源模式、擋掉遊戲圖片）
      if (reattach) { try { const v = await cdp.send('Browser.getVersion'); if (!/Headless/i.test(v.userAgent || '')) r.visible = r.visible || '_'; } catch (_) {} }
      for (const t of pagesT) {
        if (reattach && t.url.indexOf(GAME + '/game') === 0) {
          // 接回中控重新啟動前就開著的遊戲分頁：重新裝好代送與注入（之後重新整理也有腳本），不用重新整理
          // 一頁接不上（例如遊戲跳出對話框卡住）不影響別頁，也不會因此把整個 Chrome 關掉（v0.71.3）
          try {
          const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
          let key = '';
          // 分頁可能正在重新整理（例如剛好要換新版腳本）：多問幾次，問不到就當成第一個還沒接上的角色分頁，不要關掉它重開（v0.71.2）
          for (let i = 0; i < 6 && !key; i++) {
            try { const v = await cdp.send('Runtime.evaluate', { expression: 'window.__szgBg ? window.__szgBg.key : ""', returnByValue: true }, sessionId); key = (v.result && v.result.value) || ''; } catch (_) {}
            if (!key) await sleep(500);
          }
          if (!key) key = want.find(k => !r.pages[k]) || '';
          if (key && want.includes(key) && !r.pages[key]) {
            const scriptId = await setupSession(r, key, sessionId);
            r.pages[key] = { targetId: t.targetId, sessionId, scriptId, char: key === '_' ? '' : key, openedAt: Date.now(), info: null, fail: 0, acctAt: 0 };
            continue;
          }
          } catch (e) { log(`${p.name}：接回分頁時出錯（${e.message}），這一頁先不管`); if (r.visible) continue; }
        }
        extra.push(t.targetId);
      }
      for (const k of want) if (!r.pages[k]) await openPage(r, k);
      if (r.visible) { const pg = r.pages[r.visible] || r.pages[want[0]]; if (pg) await cdp.send('Target.activateTarget', { targetId: pg.targetId }).catch(() => {}); }
      // 開機時的空白頁、上次留下的頁面；看得到的視窗是你在用的，不關它的分頁（v0.71.3）
      if (!r.visible) for (const t of extra) await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
      r.state = 'running'; r.startedAt = Date.now();
      log(`${p.name}：${reattach ? '接上執行中的' : '啟動'}${r.visible ? '看得到的' : '背景'} Chrome（${want.length} 個分頁）`);
    } catch (e) {
      r.state = 'error'; r.msg = e.message; r.fails.push(Date.now());
      // 接回別人開著的 Chrome 出錯：只斷線、下次再接，不關掉它（以前會把看得到的遊戲視窗整個關掉，v0.71.3）
      if (r.cdp) { if (!reattachTried) { try { await r.cdp.send('Browser.close'); } catch (_) {} } r.cdp.close(); r.cdp = null; }
      log(`${p.name}：${e.message}`);
    } finally { r.busy = false; }
  }

  async function stopBrowser(id) {
    const r = R(id);
    const dir = dirOf(id);
    let cdp = r.cdp;
    if (!cdp || cdp.closed) { const ws = await wsFromDir(dir, 0); if (ws) { cdp = new Cdp(ws); try { await cdp.ready; } catch (_) { cdp = null; } } }
    r.stopping = true;
    try { if (cdp) { try { await cdp.send('Browser.close', {}, undefined, 5000); } catch (_) {} cdp.close(); } } finally { setTimeout(() => { r.stopping = false; }, 1500); }
    r.cdp = null; r.pages = {};
    // 等 Chrome 放開資料夾
    for (let i = 0; i < 30 && fs.existsSync(path.join(dir, 'DevToolsActivePort')) && await wsFromDir(dir, 0); i++) await sleep(300);
    await sleep(800);
  }

  const GOOGLE_LOGIN = new RegExp(process.env.SZG_GOOGLE_LOGIN_RE || '^https://accounts\\.google\\.com/', 'i'); // 測試用 SZG_GOOGLE_LOGIN_RE 換成模擬的網址
  async function stop(id) { const r = R(id); r.busy = true; try { await stopBrowser(id); } finally { r.busy = false; } r.state = 'off'; r.msg = ''; }

  // 登入：同一個資料夾開「一般的 Chrome 視窗」（不接 DevTools，不是自動化瀏覽器，Google 登入不會被擋）
  async function login(id, opt = {}) {
    const p = prof(id); if (!p) throw new Error('沒有這個背景帳號');
    const chrome = findChrome(cfg().chromePath);
    if (!chrome) throw new Error('找不到 Chrome：請先填 chrome.exe 的位置');
    const r = R(id);
    if (r.login) return;
    await stop(id);
    // 還有中控開的 Chrome（有遠端除錯）佔著這個資料夾：新開的視窗會變成它的一個視窗（同一個資料夾只會有一個 Chrome），
    // Google 會判斷成自動化瀏覽器、擋登入（「這個瀏覽器或應用程式可能有安全疑慮」）→ 先確實關掉
    if ((await chromeOf(id)).some(x => /--remote-debugging-port/.test(x.cmd))) { log(`${p.name}：先關掉還在跑的背景 Chrome，再開登入視窗`); await killStale(id); }
    const dir = dirOf(id); prepDir(dir);
    try { fs.unlinkSync(path.join(dir, 'DevToolsActivePort')); } catch (_) {}
    const args = [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', ...(LOGIN_HEADLESS ? ['--headless=new', '--remote-debugging-port=0', ...sandboxArgs()] : []),
      // 第一次登入、有填 Email：多開一頁 Google 登入（帶入 Email），登入 Google 後遊戲頁按 Google 登入只要選帳號
      ...(p.email && !p.code && !LOGIN_HEADLESS ? [`https://accounts.google.com/ServiceLogin?Email=${encodeURIComponent(p.email)}&continue=${encodeURIComponent('https://accounts.google.com/')}`] : []),
      GAME + LOGIN_PATH.replace('{name}', encodeURIComponent(p.name))]; // {name} 只給測試用
    const proc = spawn(chrome, args, { detached: true, stdio: 'ignore' });
    r.login = proc; r.state = 'login'; r.msg = ''; r.needLogin = false;
    proc.on('error', e => { r.login = null; r.state = 'error'; r.msg = '開不了 Chrome：' + e.message; });
    proc.on('exit', () => {
      r.login = null; r.state = 'off';
      log(`${p.name}：登入視窗關掉了`);
      const q = prof(id); if (q && q.on) setTimeout(() => start(id).catch(() => {}), 1500); // 登入完自動開始背景
      if (batch.cur === id) { batch.done.push(id); batch.cur = ''; setTimeout(nextBatch, 2500); } // 批次登入：換下一個
    });
    log(`${p.name}：開啟登入視窗`);
  }
  // 「登入完成」：正常關閉登入視窗，Chrome 才會把登入的 cookie 存好（強制結束會遺失）
  //   Windows 用 taskkill 不加 /F（等於按視窗的 ✕）；測試用的無頭登入視窗有 DevTools，用 Browser.close
  async function loginDone(id) {
    const r = R(id); const proc = r.login; if (!proc) return false;
    const ws = await wsFromDir(dirOf(id), 0);
    if (ws) { const c = new Cdp(ws); try { await c.ready; await c.send('Browser.close', {}, undefined, 5000); c.close(); return true; } catch (_) { c.close(); } }
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(proc.pid)], () => {});
    else { try { proc.kill('SIGTERM'); } catch (_) {} }
    return true;
  }

  // ---------- 批次登入：一次跳一個登入視窗，關掉就換下一個 ----------
  const batch = { queue: [], cur: '', done: [], skipped: [] };
  async function nextBatch() {
    if (batch.cur) return;
    const id = batch.queue.shift(); if (!id) return;
    if (!prof(id)) return nextBatch();
    batch.cur = id;
    try { await login(id); } catch (e) { batch.skipped.push(id); batch.cur = ''; log('批次登入：' + e.message); return nextBatch(); }
  }

  async function probe(r, key, pg) {
    const now = Date.now();
    const withAcct = now - pg.acctAt >= ACCT_CHECK_MS || (r.needLogin && now - pg.acctAt >= 5000);
    try {
      if (pg.crashed) throw new Error('分頁當掉');
      const v = await r.cdp.send('Runtime.evaluate', { expression: probeExpr(withAcct), awaitPromise: true, returnByValue: true }, pg.sessionId, 15000);
      const o = (v.result && v.result.value) || {};
      pg.info = { ...(pg.info || {}), ...o, at: now }; pg.fail = 0;
      // 「顯示」的視窗（中控開的、有遠端除錯）裡按 Google 登入會被 Google 擋（「這個瀏覽器或應用程式可能有安全疑慮」）：
      // 看到 Google 登入頁（同一頁或跳出來的視窗）就自動換成「一般的 Chrome 登入視窗」，在那裡登入
      if (r.visible && !r.toLogin) {
        let g = GOOGLE_LOGIN.test(String(o.url || ''));
        if (!g) { try { const t = await r.cdp.send('Target.getTargets', {}, undefined, 5000); g = (t.targetInfos || []).some(x => x.type === 'page' && GOOGLE_LOGIN.test(x.url || '')); } catch (_) {} }
        if (g) {
          r.toLogin = true; const nm = (prof(r.id) || {}).name;
          log(`${nm}：顯示的視窗打開了 Google 登入，Google 會擋自動化的瀏覽器 → 改開一般的登入視窗`);
          (r.logs || (r.logs = [])).push({ at: now, page: key, msg: 'Google 登入要在一般的登入視窗登入：已自動換過去，登入完關掉視窗就會回到背景執行' });
          setTimeout(() => login(r.id).catch(e => log(`${nm}：開登入視窗失敗（${e.message}）`)).finally(() => { r.toLogin = false; }), 300);
          return;
        }
      }
      try { const h = await r.cdp.send('Runtime.getHeapUsage', {}, pg.sessionId, 5000); pg.heap = Math.round((h.usedSize || 0) / 1048576); pg.heapTotal = Math.round((h.totalSize || 0) / 1048576); } catch (_) {}
      if (o.hasState) pg.stateOk = true;
      // 省資源模式的保險：遊戲頁載入 2 分鐘還沒有遊戲資料 → 這個帳號改回完整模式（可能遊戲有地方需要圖片才會啟動）
      if (o.bg && o.bg.lite && !o.hasState && onGameUrl(o.url) && !r.needLogin && o.loadedAt && now - o.loadedAt > 120000 && !r.noLite) {
        r.noLite = true; log(`${(prof(r.id) || {}).name}：省資源模式下遊戲沒有載入完成，這個帳號改回完整模式`);
        (r.logs || (r.logs = [])).push({ at: now, page: key, msg: '省資源模式下遊戲沒有載入完成，已改回完整模式（中控重開前有效）' });
        await reapplyLite(r); return;
      }
      if (!onGameUrl(o.url) && now - pg.openedAt > 30000) r.needLogin = true; // 被導到登入頁之類的地方
      const onGame = onGameUrl(o.url);
      if (withAcct && o.acct !== undefined) { // 頁面還沒載入（about:blank）時不算檢查過
        pg.acctAt = now;
        r.needLogin = o.acct === 401 || o.acct === 403 || (!onGame && now - pg.openedAt > 30000);
        if (o.code) {
          const p = prof(r.id) || {};
          if (p.code !== o.code || JSON.stringify(p.charIds || []) !== JSON.stringify(o.chars || [])) patchProf(r.id, { code: o.code, charIds: o.chars || [] });
          // 登入後知道帳號有哪些角色了：「帳號目前的角色」改成帳號的角色（最多兩隻同時在線），目前顯示的那隻排第一、沿用原本的分頁
          const pages = p.pages && p.pages.length ? p.pages : [''];
          if (pages.includes('') && (o.chars || []).length) {
            const cur = key === '_' && o.char && o.chars.includes(o.char) ? o.char : '';
            const next = [...new Set([...pages.filter(Boolean), cur, ...o.chars].filter(Boolean))].slice(0, Math.max(2, pages.filter(Boolean).length));
            if (cur && next.includes(cur)) await rekeyPage(r, '_', cur);
            patchProf(r.id, { pages: next });
            log(`${p.name}：登入後改成開帳號的角色（${next.length} 隻）`);
          }
        }
      }
    } catch (e) {
      pg.fail++;
      if (pg.crashed || pg.fail >= 3) {
        // 看得到的視窗：先開新的再關舊的（以前先關，視窗只剩那一頁時整個視窗就關掉了）；沒當掉的只重新整理
        if (r.visible && !pg.crashed) { log(`${(prof(r.id) || {}).name}：顯示中的分頁沒有回應，重新整理（${e.message}）`); pg.fail = 0; await r.cdp.send('Page.reload', {}, pg.sessionId).catch(() => {}); return; }
        log(`${(prof(r.id) || {}).name}：分頁沒有回應，重新開啟（${e.message}）`);
        if (r.visible) { const old = r.pages[key]; delete r.pages[key]; await openPage(r, key).catch(() => {}); if (old && r.cdp) await r.cdp.send('Target.closeTarget', { targetId: old.targetId }).catch(() => {}); }
        else { await closePage(r, key); await openPage(r, key).catch(() => {}); }
      }
    }
  }

  let ticking = false, lastReloadAt = 0, lastTrimAt = 0;
  // 記憶體整理：通知 Chrome「記憶體吃緊」（丟掉快取、壓縮）＋整理每頁的 JS 記憶體。不影響遊戲運作
  async function trimProfile(r) {
    if (!r.cdp || r.cdp.closed) return;
    await r.cdp.send('Memory.simulatePressureNotification', { level: 'critical' }).catch(() => {});
    for (const pg of Object.values(r.pages)) {
      if (pg.info && pg.info.busy) continue;
      await r.cdp.send('HeapProfiler.collectGarbage', {}, pg.sessionId, 20000).catch(() => {});
    }
    r.trimAt = Date.now();
  }
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      for (const p of cfg().profiles) {
        const r = R(p.id);
        if (r.busy || r.login) continue;
        if (!p.on) continue;
        if (!r.cdp || r.cdp.closed) {
          r.fails = r.fails.filter(t => Date.now() - t < 10 * 60 * 1000);
          if (r.fails.length >= 3) { r.state = 'error'; r.msg = (r.msg || '一直開不起來') + '（10 分鐘內失敗 3 次，先停止自動重開；按「開始」再試）'; continue; }
          await start(p.id);
          continue;
        }
        const want = wantKeys(p);
        for (const k of Object.keys(r.pages)) if (!want.includes(k)) await closePage(r, k);
        for (const k of want) if (!r.pages[k]) await openPage(r, k).catch(e => { r.msg = e.message; });
        for (const [k, pg] of Object.entries(r.pages)) await probe(r, k, pg);
      }
      // 定時記憶體整理：一輪只整理一個帳號，輪流
      const TM = cfg().trimMin;
      if (TM > 0 && Date.now() - lastTrimAt > 20000) {
        const due = cfg().profiles.map(p => run[p.id]).filter(r => r && r.cdp && r.state === 'running' && !r.busy && Date.now() - (r.trimAt || r.startedAt || 0) > TM * 60000).sort((a, b) => (a.trimAt || 0) - (b.trimAt || 0))[0];
        if (due) { lastTrimAt = Date.now(); await trimProfile(due); }
      }
      // 定時重新整理：掛久了頁面記憶體會越長越大。一輪只重整一頁、錯開；有工作／打王（isBusy）、讓位中、看得到的視窗不重整
      const H = cfg().reloadHours;
      if (H > 0) {
        const now = Date.now();
        outer: for (const p of cfg().profiles) {
          const r = run[p.id]; if (!r || !r.cdp || r.busy || r.visible || r.state !== 'running') continue;
          for (const pg of Object.values(r.pages)) {
            const i = pg.info || {};
            if (!i.loadedAt || now - i.loadedAt < H * 3600e3 || i.busy || (i.bg && i.bg.standby) || now - (lastReloadAt || 0) < RELOAD_GAP_MS) continue;
            await r.cdp.send('Page.reload', {}, pg.sessionId).catch(() => {});
            lastReloadAt = now; pg.info = { ...i, loadedAt: now };
            r.reloads = (r.reloads || 0) + 1;
            break outer;
          }
        }
      }
    } catch (e) { log('檢查失敗：' + e.message); }
    finally { ticking = false; }
  }

  // ---------- 記憶體：每個背景帳號的 Chrome（主程式＋所有子程序）用了多少 ----------
  let mem = { at: 0, by: {}, total: 0, err: '' }, memBusy = false;
  function runCmd(cmd, args) { return new Promise(res => execFile(cmd, args, { timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (e, out) => res(e ? '' : String(out)))); }
  // 列出所有 chrome 程序（含命令列）；Windows 輸出強制 UTF-8（路徑有中文時，預設的 Big5 會變亂碼）
  async function listChrome() {
    if (process.platform === 'win32') {
      const out = await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress"]);
      let j = []; try { j = JSON.parse(out || '[]'); } catch (_) {}
      return (Array.isArray(j) ? j : [j]).filter(Boolean).map(x => ({ pid: x.ProcessId, ppid: x.ParentProcessId, bytes: Number(x.WorkingSetSize) || 0, cmd: x.CommandLine || '' }));
    }
    const out = await runCmd('ps', ['-eo', 'pid=,ppid=,rss=,args=']);
    return out.split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], bytes: +m[3] * 1024, cmd: m[4] }));
  }
  // 只用「data\bg\<帳號編號>」比對（編號是英數字），不受資料夾路徑的中文、大小寫影響
  const dirRe = id => new RegExp('[\\\\/]bg[\\\\/]' + String(id).replace(/[^\w-]/g, '') + '(["\\s\\\\/]|$)', 'i');
  // 找出還佔著這個帳號資料夾的 Chrome（例如登入視窗關了但程式沒結束），全部結束掉
  // 這個帳號資料夾的 Chrome 主程序（不含子程序）
  async function chromeOf(id) { const re = dirRe(id); try { return (await listChrome()).filter(x => !/--type=/.test(x.cmd) && re.test(x.cmd)); } catch (_) { return []; } }
  async function killStale(id) {
    const re = dirRe(id), find = async () => (await listChrome()).filter(x => !/--type=/.test(x.cmd) && re.test(x.cmd));
    let hit = await find(); const n = hit.length;
    if (!n) return 0;
    // 先好好關（讓登入 cookie 寫回硬碟），5 秒內沒結束才強制結束
    for (const x of hit) {
      if (process.platform === 'win32') await runCmd('taskkill', ['/PID', String(x.pid)]);
      else { try { process.kill(x.pid, 'SIGTERM'); } catch (_) {} }
    }
    for (let i = 0; i < 10 && (hit = await find()).length; i++) await sleep(500);
    for (const x of hit) {
      if (process.platform === 'win32') await runCmd('taskkill', ['/PID', String(x.pid), '/T', '/F']);
      else { try { process.kill(x.pid, 'SIGKILL'); } catch (_) {} }
    }
    await sleep(1000);
    return n;
  }
  async function refreshMem() {
    if (memBusy || Date.now() - mem.at < 30000) return; memBusy = true;
    try {
      const procs = await listChrome();
      const kids = new Map(); for (const p of procs) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(p);
      const by = {}; let total = 0, totalPage = 0;
      for (const p of cfg().profiles) {
        // 只用「data\bg\<帳號編號>」比對（編號是英數字），不受資料夾路徑的中文、大小寫影響
        const re = dirRe(p.id), roots = procs.filter(x => !/--type=/.test(x.cmd) && re.test(x.cmd));
        let sum = 0, page = 0, n = 0; const seen = new Set();
        const walk = x => { if (seen.has(x.pid)) return; seen.add(x.pid); sum += x.bytes; if (/--type=renderer/.test(x.cmd) && !/--extension-process/.test(x.cmd)) page += x.bytes; n++; for (const c of kids.get(x.pid) || []) walk(c); };
        roots.forEach(walk);
        if (n) { by[p.id] = { mb: Math.round(sum / 1048576), pageMb: Math.round(page / 1048576), baseMb: Math.round((sum - page) / 1048576), procs: n }; total += sum; totalPage += page; }
      }
      mem = { at: Date.now(), by, total: Math.round(total / 1048576), page: Math.round(totalPage / 1048576), base: Math.round((total - totalPage) / 1048576), procs: procs.length, matched: Object.keys(by).length, err: !procs.length ? '讀不到程序清單' : !Object.keys(by).length && cfg().profiles.some(p => run[p.id] && run[p.id].state === 'running') ? '對不到背景 Chrome 的程序' : '' };
    } catch (e) { mem = { ...mem, at: Date.now(), err: e.message }; }
    finally { memBusy = false; }
  }

  function status() {
    refreshMem();
    const c = cfg();
    return {
      all: allJob && (!allJob.end || Date.now() - allJob.end < 15000) ? { ...allJob } : null,
      batch: { cur: batch.cur, queue: [...batch.queue], done: batch.done.length, skipped: batch.skipped.length, total: batch.done.length + batch.skipped.length + batch.queue.length + (batch.cur ? 1 : 0) },
      events: events.slice(-60),
      lite: c.lite, reloadHours: c.reloadHours, trimMin: c.trimMin, mem: { total: mem.total, page: mem.page || 0, base: mem.base || 0, at: mem.at, err: mem.err },
      chrome: findChrome(c.chromePath), chromePath: c.chromePath, nodeOk: typeof WebSocket === 'function', node: process.version, game: GAME,
      profiles: c.profiles.map(p => {
        const r = run[p.id] || {};
        return {
          id: p.id, name: p.name, email: p.email || '', note: p.note || '', on: !!p.on, visible: (run[p.id] || {}).visible || '', pages: p.pages || [''], code: p.code || '', charIds: p.charIds || [],
          mem: mem.by[p.id] || null, noLite: !!r.noLite, reloads: r.reloads || 0, trimAt: r.trimAt || 0,
          state: r.state || 'off', msg: r.msg || '', logs: (r.logs || []).slice(-10), needLogin: !!r.needLogin, startedAt: r.startedAt || 0, dir: dirOf(p.id),
          live: Object.entries(r.pages || {}).map(([k, pg]) => ({ heap: pg.heap || 0, heapTotal: pg.heapTotal || 0, key: k, char: (pg.info && pg.info.char) || pg.char, url: pg.info && pg.info.url, standby: !!(pg.info && pg.info.bg && pg.info.bg.standby), injected: !!(pg.info && pg.info.bg), badge: pg.info && pg.info.badge, at: (pg.info && pg.info.at) || 0, fail: pg.fail })),
        };
      }),
    };
  }

  // ---------- 面板用的操作 ----------
  async function action(name, b) {
    const c = getCfg() || {}; const list = Array.isArray(c.profiles) ? c.profiles : [];
    if (name === 'config') {
      const patch = {};
      if (b.chromePath !== undefined) patch.chromePath = String(b.chromePath || '').trim();
      if (b.trimMin !== undefined) patch.trimMin = Math.max(0, Math.min(1440, Number(b.trimMin) || 0));
      if (b.reloadHours !== undefined) patch.reloadHours = Math.max(0, Math.min(168, Number(b.reloadHours) || 0));
      const liteChanged = b.lite !== undefined && (b.lite !== false) !== (c.lite !== false);
      if (b.lite !== undefined) patch.lite = b.lite !== false;
      setCfg({ ...c, ...patch });
      if (liteChanged) for (const p of list) { const r = run[p.id]; if (r && r.cdp && r.state === 'running') { r.noLite = false; await reapplyLite(r); } }
      return status();
    }
    if (name === 'add') {
      const id = 'p' + Date.now().toString(36);
      setCfg({ ...c, profiles: [...list, { id, name: String(b.name || '').trim().slice(0, 20) || `帳號 ${list.length + 1}`, email: String(b.email || '').trim().slice(0, 120), note: '', on: false, pages: [''] }] });
      return { id, ...status() };
    }
    if (name === 'order') {
      const ids = Array.isArray(b.ids) ? b.ids : [];
      const byId = new Map(list.map(x => [x.id, x]));
      const out = ids.map(i => byId.get(i)).filter(Boolean); for (const x of list) if (!out.includes(x)) out.push(x);
      setCfg({ ...c, profiles: out }); return status();
    }
    if (name === 'all') { // 依序開始／停止（一次開十幾個 Chrome 會卡）：背景進行，面板看進度
      if (allJob && !allJob.end) throw new Error(`上一批還在${allJob.op === 'start' ? '開始' : '停止'}（${allJob.done}/${allJob.total}），等它做完`);
      const ids = (Array.isArray(b.ids) && b.ids.length ? b.ids : list.map(x => x.id)).filter(id => list.find(x => x.id === id));
      if (b.op !== 'start' && b.op !== 'stop') throw new Error('不明的操作');
      const job = allJob = { op: b.op, total: ids.length, done: 0, skipped: 0, cur: '', at: Date.now(), end: 0 };
      (async () => {
        for (const id of ids) {
          job.cur = id;
          const r = R(id);
          try {
            if (b.op === 'start') {
              patchProf(id, { on: true }); r.fails = [];
              if (r.state === 'running' && r.cdp && !r.cdp.closed) job.skipped++; // 已經在跑的不用重開
              else await start(id);
            } else {
              patchProf(id, { on: false });
              if (r.state === 'off' && !r.cdp) job.skipped++;
              else { r.state = 'stopping'; await stop(id); }
            }
          } catch (e) { log('依序' + (b.op === 'start' ? '開始' : '停止') + '：' + e.message); }
          job.done++;
        }
        job.cur = ''; job.end = Date.now();
      })();
      return status();
    }
    if (name === 'trim') { // 立刻整理全部（測試、比較前後用）
      for (const p of list) { const r = run[p.id]; if (r && r.state === 'running') await trimProfile(r); }
      mem.at = 0; return status();
    }
    if (name === 'login-batch') {
      const ids = (Array.isArray(b.ids) ? b.ids : []).filter(id => list.find(x => x.id === id) && id !== batch.cur && !batch.queue.includes(id));
      if (!batch.cur && !batch.queue.length) { batch.done = []; batch.skipped = []; }
      for (const id of ids) patchProf(id, { on: true });
      batch.queue.push(...ids); nextBatch(); return status();
    }
    if (name === 'login-cancel') { batch.queue = []; return status(); }
    if (name === 'login-skip') { const id = batch.cur; if (id) { batch.skipped.push(id); batch.cur = ''; await loginDone(id); } setTimeout(nextBatch, 1500); return status(); }
    if (name === 'import') return importCsv(String(b.csv || ''), !!b.dry);
    const p = list.find(x => x.id === b.id); if (!p) throw new Error('沒有這個背景帳號');
    if (name === 'rename') patchProf(p.id, { name: String(b.name || '').trim().slice(0, 20) || p.name });
    else if (name === 'edit') {
      const patch = {};
      if (b.name !== undefined) patch.name = String(b.name || '').trim().slice(0, 20) || p.name;
      if (b.email !== undefined) patch.email = String(b.email || '').trim().slice(0, 120);
      if (b.note !== undefined) patch.note = String(b.note || '').slice(0, 200);
      patchProf(p.id, patch);
    }
    else if (name === 'show') { // 改成看得到的視窗，顯示那隻角色（中控腳本照跑；關掉視窗就回到背景）
      const ch = String(b.char || '');
      const pages = p.pages && p.pages.length ? p.pages : [''];
      if (ch && !pages.includes(ch)) patchProf(p.id, { pages: [...pages.filter(x => x), ch].slice(0, 6) });
      patchProf(p.id, { on: true });
      const r = R(p.id);
      if (r.visible && r.cdp && !r.cdp.closed) { const pg = r.pages[ch || '_'] || Object.values(r.pages)[0]; if (pg) await r.cdp.send('Target.activateTarget', { targetId: pg.targetId }).catch(() => {}); r.visible = ch || '_'; }
      else { r.busy = true; try { await stopBrowser(p.id); } finally { r.busy = false; } await start(p.id, { visible: ch || '_' }); }
    }
    else if (name === 'hide') { const r = R(p.id); if (r.visible) { r.busy = true; try { await stopBrowser(p.id); } finally { r.busy = false; } r.visible = ''; await start(p.id); } }
    else if (name === 'remove') { await stop(p.id); delete run[p.id]; setCfg({ ...c, profiles: list.filter(x => x.id !== p.id) }); }
    else if (name === 'start') { patchProf(p.id, { on: true }); R(p.id).fails = []; await start(p.id, { force: true }); }
    else if (name === 'stop') { patchProf(p.id, { on: false }); await stop(p.id); }
    else if (name === 'login') { patchProf(p.id, { on: true }); await login(p.id); }
    else if (name === 'login-done') await loginDone(p.id);
    else if (name === 'reload') { const r = R(p.id); for (const pg of Object.values(r.pages)) if (r.cdp) await r.cdp.send('Page.reload', {}, pg.sessionId).catch(() => {}); }
    else if (name === 'pages') {
      let pages = [...new Set((Array.isArray(b.pages) ? b.pages : []).map(x => String(x || '')).filter(x => x === '' || /^[\w-]{1,64}$/.test(x)))].slice(0, 6);
      if ((p.charIds || []).length) { // 登入過、知道有哪些角色：只能勾帳號的角色
        pages = pages.filter(x => x && p.charIds.includes(x));
        if (!pages.length) throw new Error('至少要勾一隻角色；這個帳號不想在背景開的話，請按「停止」');
      }
      patchProf(p.id, { pages: pages.length ? pages : [''] });
      setTimeout(tick, 100);
    } else throw new Error('不明的操作');
    return status();
  }

  // ---------- CSV 匯出／匯入（Excel 可以直接開；欄位：名稱,Email,遊戲ID,背景角色ID,開啟,備註） ----------
  const CSV_HEAD = ['名稱', 'Email', '遊戲ID', '背景角色ID', '角色名稱（參考，匯入時不讀）', '開啟', '備註'];
  const csvCell = v => { v = String(v == null ? '' : v); return /[",\r\n]/.test(v) || /^[=+\-@]/.test(v) ? '"' + (/^[=+\-@]/.test(v) ? "'" : '') + v.replace(/"/g, '""') + '"' : v; };
  function exportCsv(nameOf) {
    const rows = cfg().profiles.map(p => [p.name, p.email || '', p.code || '', (p.pages || []).filter(Boolean).join(' '), (p.pages || []).filter(Boolean).map(id => nameOf(id)).join(' '), p.on ? '是' : '否', p.note || '']);
    return '﻿' + [CSV_HEAD, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  function parseCsv(t) {
    t = t.replace(/^﻿/, ''); const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',' || ch === '\t') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ''));
  }
  function importCsv(text, dry) {
    const rows = parseCsv(text); if (!rows.length) throw new Error('檔案是空的');
    const head = rows[0].map(x => String(x).trim()); const col = n => head.findIndex(h => h === n || h.startsWith(n));
    const iName = col('名稱'), iMail = col('Email'), iPages = col('背景角色ID'), iOn = col('開啟'), iNote = col('備註');
    if (iName < 0 && iMail < 0) throw new Error('第一列要有欄位名稱（至少要有「名稱」或「Email」），可以先匯出一份當範本');
    const c = getCfg() || {}; const list = (c.profiles || []).map(x => ({ ...x }));
    const out = [], added = [], updated = [];
    const used = new Set();
    for (const r of rows.slice(1)) {
      const g = i => i >= 0 ? String(r[i] == null ? '' : r[i]).trim().replace(/^'(?=[=+\-@])/, '') : undefined;
      const name = g(iName), email = g(iMail);
      if (!name && !email) continue;
      let p = list.find(x => !used.has(x.id) && email && x.email && x.email.toLowerCase() === email.toLowerCase()) || list.find(x => !used.has(x.id) && name && x.name === name);
      const patch = {};
      if (name) patch.name = name.slice(0, 20);
      if (email !== undefined) patch.email = email.slice(0, 120);
      if (iNote >= 0) patch.note = g(iNote).slice(0, 200);
      if (iPages >= 0) { const pg = g(iPages).split(/[\s;、，,]+/).filter(x => /^[\w-]{1,64}$/.test(x)).slice(0, 6); patch.pages = pg.length ? pg : ['']; }
      if (iOn >= 0) patch.on = /^(是|y|yes|1|true|開|on)$/i.test(g(iOn));
      if (p) { Object.assign(p, patch); used.add(p.id); updated.push(p.name); out.push(p); }
      else { p = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: patch.name || email.split('@')[0].slice(0, 20), email: patch.email || '', note: patch.note || '', on: false, pages: patch.pages || [''] }; added.push(p.name); out.push(p); }
    }
    for (const x of list) if (!used.has(x.id)) out.push(x); // 檔案裡沒有的保留在最後
    const sum = { added: added.length, updated: updated.length, kept: list.length - used.size, addedNames: added.slice(0, 20), updatedNames: updated.slice(0, 20) };
    if (!dry) { setCfg({ ...c, profiles: out }); setTimeout(tick, 100); }
    return { ...status(), import: sum };
  }

  // ---------- 讀遊戲程式碼（只讀，給開發核對遊戲欄位）：用已登入的背景分頁 fetch，結果只放記憶體 ----------
  const srcCache = {}; // 檔名 -> {at, text, status, from}
  function srcPage(want) {
    for (const p of cfg().profiles) {
      if (want && p.id !== want && p.name !== want) continue;
      const r = run[p.id];
      if (!r || !r.cdp || r.state !== 'running' || r.needLogin) continue;
      for (const pg of Object.values(r.pages)) if (pg.info && String(pg.info.url || '').startsWith(GAME + '/game') && pg.info.hasState) return { r, pg, name: p.name };
    }
    return null;
  }
  async function gameSrc(q) {
    const at = srcPage(q.profile);
    if (q.list) { // 頁面載入過的程式檔
      if (!at) return { error: '沒有已登入、執行中的背景分頁' };
      const v = await at.r.cdp.send('Runtime.evaluate', { expression: `[...new Set([...document.scripts].map(s => s.src).concat(performance.getEntriesByType('resource').map(e => e.name)))].filter(u => u.startsWith(location.origin) && /\\.(m?js|json)(\\?|$)/.test(u)).map(u => u.slice(location.origin.length))`, returnByValue: true }, at.pg.sessionId, 15000);
      return { from: at.name, files: (v.result && v.result.value) || [] };
    }
    const file = String(q.file || '/game/game.js');
    if (!/^\/[\w./-]+\.(m?js|json)$/.test(file) || file.includes('..')) return { error: '只能讀遊戲網站上的 .js／.json 檔（例如 /game/game.js）' };
    let c = srcCache[file];
    if (!c || q.fresh || Date.now() - c.at > 10 * 60000) {
      if (!at) return { error: '沒有已登入、執行中的背景分頁（帳號分頁要有一個在跑、而且已登入）' };
      const v = await at.r.cdp.send('Runtime.evaluate', { expression: `fetch(${JSON.stringify(file)}, { cache: 'no-store', credentials: 'same-origin' }).then(async r => ({ status: r.status, text: r.ok ? await r.text() : '' }))`, awaitPromise: true, returnByValue: true }, at.pg.sessionId, 60000);
      const o = (v.result && v.result.value) || {};
      c = srcCache[file] = { at: Date.now(), text: String(o.text || ''), status: o.status || 0, from: at.name };
    }
    const t = c.text;
    let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    const out = { file, status: c.status, from: c.from, at: c.at, len: t.length, hash: h.toString(16) };
    if (q.q) {
      let re; try { re = new RegExp(String(q.q).slice(0, 300), 'g' + (q.i ? 'i' : '')); } catch (e) { return { ...out, error: '搜尋字串不是正確的正規表示式：' + e.message }; }
      const ctx = Math.max(0, Math.min(1500, Number(q.ctx) || 150)), max = Math.max(1, Math.min(200, Number(q.max) || 20)), skip = Math.max(0, Number(q.skip) || 0);
      const matches = []; let n = 0, m;
      while ((m = re.exec(t))) { if (n >= skip && matches.length < max) matches.push({ i: m.index, text: t.slice(Math.max(0, m.index - ctx), m.index + m[0].length + ctx) }); n++; if (!m[0].length) re.lastIndex++; }
      Object.assign(out, { q: q.q, count: n, matches });
    }
    if (q.words) { // 只回識別字（例如 words=^party 列出所有 party 開頭的字）
      let re; try { re = new RegExp(String(q.words).slice(0, 200), q.i ? 'i' : ''); } catch (e) { return { ...out, error: e.message }; }
      const cnt = {}; for (const w of t.match(/[A-Za-z_$][\w$]{2,}/g) || []) if (re.test(w)) cnt[w] = (cnt[w] || 0) + 1;
      out.words = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 500);
    }
    if (q.from !== undefined && q.from !== '') { const f = Math.max(0, Number(q.from) || 0); out.slice = { from: f, text: t.slice(f, f + Math.max(1, Math.min(8000, Number(q.len) || 2000))) }; }
    return out;
  }

  let allJob = null;
  let timer = null;
  function boot() {
    (async () => { for (const p of cfg().profiles) if (p.on) await start(p.id).catch(() => {}); })(); // 依序開，避免十幾個 Chrome 同時啟動
    timer = setInterval(tick, TICK_MS);
  }
  // 中控正常關閉（Ctrl+C、關視窗）時一起關掉背景 Chrome；自動更新重新啟動時不關（中控起來後會接回去）
  async function shutdown() {
    clearInterval(timer);
    await Promise.all(cfg().profiles.map(p => (run[p.id] && run[p.id].cdp) ? stopBrowser(p.id).catch(() => {}) : null));
  }

  return { boot, tick, status, action, shutdown, exportCsv, gameSrc, GAME };
};
