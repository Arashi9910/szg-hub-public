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
  const log = opt.log || (m => console.log('[背景] ' + m));
  const run = {}; // 設定檔 id -> 執行狀態
  const cfg = () => { const c = getCfg() || {}; return { chromePath: c.chromePath || '', lite: c.lite !== false, reloadHours: c.reloadHours === undefined ? 6 : Math.max(0, Number(c.reloadHours) || 0), profiles: Array.isArray(c.profiles) ? c.profiles : [] }; };
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
    try {
      if (typeof WebSocket !== 'function') throw new Error('背景執行需要 Node.js 22 以上（目前 ' + process.version + '）');
      const chrome = findChrome(cfg().chromePath);
      if (!chrome) throw new Error('找不到 Chrome：請在下面填 chrome.exe 的位置');
      const dir = dirOf(id); prepDir(dir);
      // 中控重新啟動後，背景 Chrome 可能還在跑：直接接上
      let ws = opt.visible ? '' : await wsFromDir(dir, 0), reattach = !!ws;
      r.visible = opt.visible ? String(opt.visible) : '';
      if (!ws) {
        try { fs.unlinkSync(path.join(dir, 'DevToolsActivePort')); } catch (_) {}
        const args = [...(opt.visible ? ['--new-window'] : ['--headless=new']), '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
          '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
          '--mute-audio', '--window-size=1280,800',
          // 省記憶體：同一個遊戲網站的分頁共用一個程序；關掉背景 Chrome 用不到的功能（同步、擴充、元件更新、翻譯…）
          '--process-per-site', '--disable-extensions', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--disable-background-networking',
          '--disable-breakpad', '--no-pings', '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CalculateNativeWinOcclusion,HeavyAdIntervention,BackForwardCache',
          ...(opt.visible ? [] : ['--disable-gpu', '--disable-gpu-compositing']), ...sandboxArgs(), 'about:blank'];
        const proc = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: true });
        proc.on('error', e => { r.msg = '開不了 Chrome：' + e.message; });
        proc.unref();
        ws = await wsFromDir(dir, 25000);
        if (!ws) throw new Error('背景 Chrome 沒有啟動（這個資料夾可能正被另一個 Chrome 使用，例如登入視窗還沒關）');
      }
      const cdp = new Cdp(ws); await cdp.ready;
      r.cdp = cdp; r.pages = {};
      cdp.on(m => onEvent(r, m, cdp));
      const { targetInfos } = await cdp.send('Target.getTargets');
      const pagesT = (targetInfos || []).filter(t => t.type === 'page');
      const want = wantKeys(p);
      const extra = [];
      for (const t of pagesT) {
        if (reattach && t.url.indexOf(GAME + '/game') === 0) {
          // 接回中控重新啟動前就開著的遊戲分頁：重新裝好代送與注入（之後重新整理也有腳本），不用重新整理
          const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
          let key = '';
          try { const v = await cdp.send('Runtime.evaluate', { expression: 'window.__szgBg ? window.__szgBg.key : ""', returnByValue: true }, sessionId); key = (v.result && v.result.value) || ''; } catch (_) {}
          if (key && want.includes(key) && !r.pages[key]) {
            const scriptId = await setupSession(r, key, sessionId);
            r.pages[key] = { targetId: t.targetId, sessionId, scriptId, char: key === '_' ? '' : key, openedAt: Date.now(), info: null, fail: 0, acctAt: 0 };
            continue;
          }
        }
        extra.push(t.targetId);
      }
      if (reattach) { try { const v = await cdp.send('Browser.getVersion'); if (!/Headless/i.test(v.userAgent || '')) r.visible = r.visible || '_'; } catch (_) {} }
      for (const k of want) if (!r.pages[k]) await openPage(r, k);
      if (r.visible) { const pg = r.pages[r.visible] || r.pages[want[0]]; if (pg) await cdp.send('Target.activateTarget', { targetId: pg.targetId }).catch(() => {}); }
      for (const t of extra) await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {}); // 開機時的空白頁、上次留下的頁面
      r.state = 'running'; r.startedAt = Date.now();
      log(`${p.name}：${reattach ? '接上執行中的' : '啟動'}${r.visible ? '看得到的' : '背景'} Chrome（${want.length} 個分頁）`);
    } catch (e) {
      r.state = 'error'; r.msg = e.message; r.fails.push(Date.now());
      if (r.cdp) { try { await r.cdp.send('Browser.close'); } catch (_) {} r.cdp.close(); r.cdp = null; }
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

  async function stop(id) { const r = R(id); r.busy = true; try { await stopBrowser(id); } finally { r.busy = false; } r.state = 'off'; r.msg = ''; }

  // 登入：同一個資料夾開「一般的 Chrome 視窗」（不接 DevTools，不是自動化瀏覽器，Google 登入不會被擋）
  async function login(id, opt = {}) {
    const p = prof(id); if (!p) throw new Error('沒有這個背景帳號');
    const chrome = findChrome(cfg().chromePath);
    if (!chrome) throw new Error('找不到 Chrome：請先填 chrome.exe 的位置');
    const r = R(id);
    if (r.login) return;
    await stop(id);
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
      if (pg.crashed || pg.fail >= 3) { log(`${(prof(r.id) || {}).name}：分頁沒有回應，重新開啟（${e.message}）`); await closePage(r, key); await openPage(r, key).catch(() => {}); }
    }
  }

  let ticking = false, lastReloadAt = 0;
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
  async function refreshMem() {
    if (memBusy || Date.now() - mem.at < 30000) return; memBusy = true;
    try {
      let procs = [];
      if (process.platform === 'win32') {
        const out = await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress"]);
        let j = []; try { j = JSON.parse(out || '[]'); } catch (_) {}
        procs = (Array.isArray(j) ? j : [j]).filter(Boolean).map(x => ({ pid: x.ProcessId, ppid: x.ParentProcessId, bytes: Number(x.WorkingSetSize) || 0, cmd: x.CommandLine || '' }));
      } else {
        const out = await runCmd('ps', ['-eo', 'pid=,ppid=,rss=,args=']);
        procs = out.split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], bytes: +m[3] * 1024, cmd: m[4] }));
      }
      const kids = new Map(); for (const p of procs) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(p);
      const by = {}; let total = 0;
      for (const p of cfg().profiles) {
        const dir = dirOf(p.id), re = new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(["\\s]|$)'), roots = procs.filter(x => !/--type=/.test(x.cmd) && re.test(x.cmd));
        let sum = 0, n = 0; const seen = new Set();
        const walk = x => { if (seen.has(x.pid)) return; seen.add(x.pid); sum += x.bytes; n++; for (const c of kids.get(x.pid) || []) walk(c); };
        roots.forEach(walk);
        if (n) { by[p.id] = { mb: Math.round(sum / 1048576), procs: n }; total += sum; }
      }
      mem = { at: Date.now(), by, total: Math.round(total / 1048576), err: procs.length ? '' : '讀不到程序清單' };
    } catch (e) { mem = { ...mem, at: Date.now(), err: e.message }; }
    finally { memBusy = false; }
  }

  function status() {
    refreshMem();
    const c = cfg();
    return {
      batch: { cur: batch.cur, queue: [...batch.queue], done: batch.done.length, skipped: batch.skipped.length, total: batch.done.length + batch.skipped.length + batch.queue.length + (batch.cur ? 1 : 0) },
      lite: c.lite, reloadHours: c.reloadHours, mem: { total: mem.total, at: mem.at, err: mem.err },
      chrome: findChrome(c.chromePath), chromePath: c.chromePath, nodeOk: typeof WebSocket === 'function', node: process.version, game: GAME,
      profiles: c.profiles.map(p => {
        const r = run[p.id] || {};
        return {
          id: p.id, name: p.name, email: p.email || '', note: p.note || '', on: !!p.on, visible: (run[p.id] || {}).visible || '', pages: p.pages || [''], code: p.code || '', charIds: p.charIds || [],
          mem: mem.by[p.id] || null, noLite: !!r.noLite, reloads: r.reloads || 0,
          state: r.state || 'off', msg: r.msg || '', logs: (r.logs || []).slice(-10), needLogin: !!r.needLogin, startedAt: r.startedAt || 0, dir: dirOf(p.id),
          live: Object.entries(r.pages || {}).map(([k, pg]) => ({ key: k, char: (pg.info && pg.info.char) || pg.char, url: pg.info && pg.info.url, standby: !!(pg.info && pg.info.bg && pg.info.bg.standby), injected: !!(pg.info && pg.info.bg), badge: pg.info && pg.info.badge, at: (pg.info && pg.info.at) || 0, fail: pg.fail })),
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
    if (name === 'all') { // 依序開始／停止（一次開十幾個 Chrome 會卡）
      const ids = Array.isArray(b.ids) && b.ids.length ? b.ids : list.map(x => x.id);
      for (const id of ids) { if (!list.find(x => x.id === id)) continue; if (b.op === 'start') { patchProf(id, { on: true }); R(id).fails = []; await start(id); } else if (b.op === 'stop') { patchProf(id, { on: false }); await stop(id); } }
      return status();
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
    else if (name === 'start') { patchProf(p.id, { on: true }); R(p.id).fails = []; await start(p.id); }
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

  return { boot, tick, status, action, shutdown, exportCsv, GAME };
};
