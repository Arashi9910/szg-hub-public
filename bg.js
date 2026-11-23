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
  const o = { url: location.href, char: sessionStorage.getItem('mapleCharacter') || '', bg: window.__szgBg ? { key: window.__szgBg.key, standby: !!window.__szgBg.standby } : null, hidden: document.hidden, badge: ((document.getElementById('szg-hub-badge') || {}).textContent || '').slice(0, 120) };
  if (${withAcct ? 'true' : 'false'} && location.origin === ${JSON.stringify(GAME)}) {
    try { const r = await fetch('/api/account', { cache: 'no-store', credentials: 'same-origin' }); o.acct = r.status; if (r.ok) { const j = await r.json(); o.code = j.playerCode || ''; o.chars = j.characterIds || []; } } catch (e) { o.acct = 0; }
  }
  return o;
})()`;

module.exports = function makeBg(opt) {
  const { dataDir, hubUrl, getCfg, setCfg, userscript, agent } = opt;
  const log = opt.log || (m => console.log('[背景] ' + m));
  const run = {}; // 設定檔 id -> 執行狀態
  const cfg = () => { const c = getCfg() || {}; return { chromePath: c.chromePath || '', profiles: Array.isArray(c.profiles) ? c.profiles : [] }; };
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
  function injected(id, key) {
    const us = userscript(); const body = us.split('// ==/UserScript==')[1] || us;
    const fixed = body.replace(/const HUB = '[^']*';/, `const HUB = ${JSON.stringify(hubUrl)};`);
    return `(function(){
if (location.origin !== ${JSON.stringify(GAME)} || location.pathname.indexOf('/game') !== 0) return;
if (window.__szgBg) return; // 防止重複注入
window.__szgBg = { profile: ${JSON.stringify(id)}, key: ${JSON.stringify(key)}, standby: false };
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

  async function setupSession(r, key, sid) {
    const { cdp } = r;
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Runtime.addBinding', { name: '__szgGmx' }, sid);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid).catch(() => {}); // 背景分頁也當成「看得到」，不會掉進離線掛機
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injected(r.id, key) }, sid);
  }

  async function openPage(r, key) {
    const char = key === '_' ? '' : key;
    const url = GAME + '/game/' + (char ? '?szgChar=' + encodeURIComponent(char) : '');
    const { targetId } = await r.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await r.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await setupSession(r, key, sessionId);
    r.pages[key] = { targetId, sessionId, char, openedAt: Date.now(), info: null, fail: 0, acctAt: 0 };
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

  function onEvent(r, m) {
    if (m.method === '__closed') { if (r.state === 'running') { r.state = 'error'; r.msg = '背景 Chrome 關掉了，稍後自動重開'; r.fails.push(Date.now()); } r.cdp = null; r.pages = {}; return; }
    if (m.method === 'Runtime.bindingCalled' && m.params && m.params.name === '__szgGmx') return void gmx(r.cdp, m.sessionId, m.params);
    const pg = Object.entries(r.pages).find(([, p]) => p.sessionId === m.sessionId);
    // 分頁裡的錯誤記下來（面板看得到最近幾筆，方便查問題）
    if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params && (m.params.type === 'error' || m.params.type === 'warning'))) {
      const d = m.params.exceptionDetails, txt = d ? ((d.exception && d.exception.description) || d.text || '') : (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
      (r.logs || (r.logs = [])).push({ at: Date.now(), page: pg ? pg[0] : '', msg: String(txt).slice(0, 300) }); if (r.logs.length > 30) r.logs.shift();
      return;
    }
    if (m.method === 'Inspector.targetCrashed' && pg) { pg[1].crashed = true; return; }
    if (m.method === 'Target.detachedFromTarget' && m.params) { const k = Object.entries(r.pages).find(([, p]) => p.sessionId === m.params.sessionId); if (k) delete r.pages[k[0]]; }
  }

  async function start(id) {
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
      let ws = await wsFromDir(dir, 0), reattach = !!ws;
      if (!ws) {
        try { fs.unlinkSync(path.join(dir, 'DevToolsActivePort')); } catch (_) {}
        const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
          '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
          '--mute-audio', '--window-size=1280,800', '--disable-features=Translate,MediaRouter', ...sandboxArgs(), 'about:blank'];
        const proc = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: true });
        proc.on('error', e => { r.msg = '開不了 Chrome：' + e.message; });
        proc.unref();
        ws = await wsFromDir(dir, 25000);
        if (!ws) throw new Error('背景 Chrome 沒有啟動（這個資料夾可能正被另一個 Chrome 使用，例如登入視窗還沒關）');
      }
      const cdp = new Cdp(ws); await cdp.ready;
      r.cdp = cdp; r.pages = {};
      cdp.on(m => onEvent(r, m));
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
            await setupSession(r, key, sessionId);
            r.pages[key] = { targetId: t.targetId, sessionId, char: key === '_' ? '' : key, openedAt: Date.now(), info: null, fail: 0, acctAt: 0 };
            continue;
          }
        }
        extra.push(t.targetId);
      }
      for (const k of want) if (!r.pages[k]) await openPage(r, k);
      for (const t of extra) await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {}); // 開機時的空白頁、上次留下的頁面
      r.state = 'running'; r.startedAt = Date.now();
      log(`${p.name}：${reattach ? '接上執行中的' : '啟動'}背景 Chrome（${want.length} 個分頁）`);
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
    if (cdp) { try { await cdp.send('Browser.close', {}, undefined, 5000); } catch (_) {} cdp.close(); }
    r.cdp = null; r.pages = {};
    // 等 Chrome 放開資料夾
    for (let i = 0; i < 30 && fs.existsSync(path.join(dir, 'DevToolsActivePort')) && await wsFromDir(dir, 0); i++) await sleep(300);
    await sleep(800);
  }

  async function stop(id) { const r = R(id); r.busy = true; try { await stopBrowser(id); } finally { r.busy = false; } r.state = 'off'; r.msg = ''; }

  // 登入：同一個資料夾開「一般的 Chrome 視窗」（不接 DevTools，不是自動化瀏覽器，Google 登入不會被擋）
  async function login(id) {
    const p = prof(id); if (!p) throw new Error('沒有這個背景帳號');
    const chrome = findChrome(cfg().chromePath);
    if (!chrome) throw new Error('找不到 Chrome：請先填 chrome.exe 的位置');
    const r = R(id);
    if (r.login) return;
    await stop(id);
    const dir = dirOf(id); prepDir(dir);
    try { fs.unlinkSync(path.join(dir, 'DevToolsActivePort')); } catch (_) {}
    const args = [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', ...(LOGIN_HEADLESS ? ['--headless=new', '--remote-debugging-port=0', ...sandboxArgs()] : []), GAME + LOGIN_PATH];
    const proc = spawn(chrome, args, { detached: true, stdio: 'ignore' });
    r.login = proc; r.state = 'login'; r.msg = ''; r.needLogin = false;
    proc.on('error', e => { r.login = null; r.state = 'error'; r.msg = '開不了 Chrome：' + e.message; });
    proc.on('exit', () => {
      r.login = null; r.state = 'off';
      log(`${p.name}：登入視窗關掉了`);
      const q = prof(id); if (q && q.on) setTimeout(() => start(id).catch(() => {}), 1500); // 登入完自動開始背景
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

  async function probe(r, key, pg) {
    const now = Date.now();
    const withAcct = now - pg.acctAt >= ACCT_CHECK_MS || (r.needLogin && now - pg.acctAt >= 5000);
    try {
      if (pg.crashed) throw new Error('分頁當掉');
      const v = await r.cdp.send('Runtime.evaluate', { expression: probeExpr(withAcct), awaitPromise: true, returnByValue: true }, pg.sessionId, 15000);
      const o = (v.result && v.result.value) || {};
      pg.info = { ...(pg.info || {}), ...o, at: now }; pg.fail = 0;
      if (!onGameUrl(o.url) && now - pg.openedAt > 30000) r.needLogin = true; // 被導到登入頁之類的地方
      const onGame = onGameUrl(o.url);
      if (withAcct && o.acct !== undefined) { // 頁面還沒載入（about:blank）時不算檢查過
        pg.acctAt = now;
        r.needLogin = o.acct === 401 || o.acct === 403 || (!onGame && now - pg.openedAt > 30000);
        if (o.code) {
          const p = prof(r.id) || {};
          if (p.code !== o.code || JSON.stringify(p.charIds || []) !== JSON.stringify(o.chars || [])) patchProf(r.id, { code: o.code, charIds: o.chars || [] });
        }
      }
    } catch (e) {
      pg.fail++;
      if (pg.crashed || pg.fail >= 3) { log(`${(prof(r.id) || {}).name}：分頁沒有回應，重新開啟（${e.message}）`); await closePage(r, key); await openPage(r, key).catch(() => {}); }
    }
  }

  let ticking = false;
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
    } catch (e) { log('檢查失敗：' + e.message); }
    finally { ticking = false; }
  }

  function status() {
    const c = cfg();
    return {
      chrome: findChrome(c.chromePath), chromePath: c.chromePath, nodeOk: typeof WebSocket === 'function', node: process.version, game: GAME,
      profiles: c.profiles.map(p => {
        const r = run[p.id] || {};
        return {
          id: p.id, name: p.name, on: !!p.on, pages: p.pages || [''], code: p.code || '', charIds: p.charIds || [],
          state: r.state || 'off', msg: r.msg || '', logs: (r.logs || []).slice(-10), needLogin: !!r.needLogin, startedAt: r.startedAt || 0, dir: dirOf(p.id),
          live: Object.entries(r.pages || {}).map(([k, pg]) => ({ key: k, char: (pg.info && pg.info.char) || pg.char, url: pg.info && pg.info.url, standby: !!(pg.info && pg.info.bg && pg.info.bg.standby), injected: !!(pg.info && pg.info.bg), badge: pg.info && pg.info.badge, at: (pg.info && pg.info.at) || 0, fail: pg.fail })),
        };
      }),
    };
  }

  // ---------- 面板用的操作 ----------
  async function action(name, b) {
    const c = getCfg() || {}; const list = Array.isArray(c.profiles) ? c.profiles : [];
    if (name === 'config') { setCfg({ ...c, chromePath: String(b.chromePath || '').trim() }); return status(); }
    if (name === 'add') {
      const id = 'p' + Date.now().toString(36);
      setCfg({ ...c, profiles: [...list, { id, name: String(b.name || '').trim().slice(0, 20) || `帳號 ${list.length + 1}`, on: false, pages: [''] }] });
      return { id, ...status() };
    }
    const p = list.find(x => x.id === b.id); if (!p) throw new Error('沒有這個背景帳號');
    if (name === 'rename') patchProf(p.id, { name: String(b.name || '').trim().slice(0, 20) || p.name });
    else if (name === 'remove') { await stop(p.id); delete run[p.id]; setCfg({ ...c, profiles: list.filter(x => x.id !== p.id) }); }
    else if (name === 'start') { patchProf(p.id, { on: true }); R(p.id).fails = []; await start(p.id); }
    else if (name === 'stop') { patchProf(p.id, { on: false }); await stop(p.id); }
    else if (name === 'login') { patchProf(p.id, { on: true }); await login(p.id); }
    else if (name === 'login-done') await loginDone(p.id);
    else if (name === 'reload') { const r = R(p.id); for (const pg of Object.values(r.pages)) if (r.cdp) await r.cdp.send('Page.reload', {}, pg.sessionId).catch(() => {}); }
    else if (name === 'pages') {
      const pages = [...new Set((Array.isArray(b.pages) ? b.pages : []).map(x => String(x || '')).filter(x => x === '' || /^[\w-]{1,64}$/.test(x)))].slice(0, 6);
      patchProf(p.id, { pages: pages.length ? pages : [''] });
      setTimeout(tick, 100);
    } else throw new Error('不明的操作');
    return status();
  }

  let timer = null;
  function boot() {
    for (const p of cfg().profiles) if (p.on) start(p.id).catch(() => {});
    timer = setInterval(tick, TICK_MS);
  }
  // 中控正常關閉（Ctrl+C、關視窗）時一起關掉背景 Chrome；自動更新重新啟動時不關（中控起來後會接回去）
  async function shutdown() {
    clearInterval(timer);
    await Promise.all(cfg().profiles.map(p => (run[p.id] && run[p.id].cdp) ? stopBrowser(p.id).catch(() => {}) : null));
  }

  return { boot, tick, status, action, shutdown, GAME };
};
