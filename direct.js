// 上漲谷中控 - 直連模式：不開 Chrome，在 Node 裡（node:vm）模擬一個「遊戲頁面」跑同一份 agent.js＋中控腳本
//
// 運作方式：
//   - 背景執行原本每隻角色一個無頭 Chrome 分頁（bg.js），12 個帳號要 8～11 GB 記憶體
//   - 直連模式：每隻角色一個 vm context 當作「分頁」，裡面有假的 window／document／location／sessionStorage，
//     agent.js 和 szg-hub.user.js 原封不動放進去跑（跟 bg.js 的 injected() 一樣的組法）
//   - 遊戲 API 用帳號的登入 cookie（__Host-maple_session）直接連 play.szg08.com，
//     每個請求帶 Origin／Referer（不然 403「來源不符」）、像 Chrome 的 User-Agent；/api/game 另外帶 X-Game-Version
//   - 遊戲頁面自己的「定時同步」由這裡的小客戶端代做（閒置每 8.25 秒一次），同步完寫 sessionStorage.mapleSessionView，
//     agent 讀狀態的方式跟在真的分頁裡一樣
//   - 重新整理（location.reload、location.href＝…）＝丟掉整個 context 開一個新的：先發 pagehide，再清掉所有計時器
//   - 依賴：只用 Node 22 內建功能
'use strict';
const vm = require('vm');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IDLE_POLL_MS = Number(process.env.SZG_DIRECT_POLL_MS) || 8250; // 遊戲頁面閒置時的同步間隔（±10%）
const FULL_SYNC_MS = 5 * 60 * 1000;   // 偶爾要一份完整的（遊戲頁面也會 fullSync）
const AUTH_RETRY_MS = Number(process.env.SZG_DIRECT_AUTH_RETRY_MS) || 60000; // 登入過期：慢慢重試，不要一直打
const VERSION_TTL_MS = 60000;         // 每次「載入頁面」時，版本號超過 60 秒就重新讀
const MIN_RELOAD_GAP_MS = 2000;       // 連續重新整理至少隔 2 秒
const jitter = ms => Math.round(ms * (0.9 + Math.random() * 0.2));

// 整個程序只裝一次：vm 裡（agent）漏接的 Promise 錯誤只記下來，不要讓中控掛掉
const REJ = Symbol.for('szg.direct.unhandledRejection');
function installRejectionLogger(log) {
  if (process[REJ]) return;
  process[REJ] = true;
  process.on('unhandledRejection', e => { try { log('未處理的錯誤（已忽略）：' + String((e && e.stack) || e).slice(0, 500)); } catch (_) {} });
}

// ---------- cookie ----------
const cookieHeader = jar => [...jar].map(([k, v]) => k + '=' + v).join('; ');
function takeCookies(jar, res) {
  let list = [];
  try { list = res.headers.getSetCookie ? res.headers.getSetCookie() : []; } catch (_) {}
  for (const sc of list) {
    const [nv, ...attrs] = String(sc).split(';');
    const i = nv.indexOf('='); if (i <= 0) continue;
    const name = nv.slice(0, i).trim(), value = nv.slice(i + 1).trim();
    const gone = attrs.some(a => { const [k, v] = a.split('=').map(s => s && s.trim().toLowerCase()); return (k === 'max-age' && Number(v) <= 0) || (k === 'expires' && Date.parse(v) < Date.now()); });
    if (gone || value === '') jar.delete(name); else jar.set(name, value);
  }
}

module.exports = function makeDirect({ hubUrl, game, agent, userscript, log }) {
  const GAME = String(game || process.env.SZG_BG_GAME || 'https://play.szg08.com').replace(/\/+$/, '');
  const HUB_ORIGIN = new URL(hubUrl).origin;
  log = log || (m => console.log('[直連] ' + m));
  installRejectionLogger(log);

  // 連遊戲：一律帶 cookie＋Origin／Referer＋UA
  async function gameFetch(jar, url, init = {}) {
    const h = new Headers(init.headers || {});
    h.set('Origin', GAME); h.set('Referer', GAME + '/game/'); h.set('User-Agent', UA);
    if (!h.has('Accept-Language')) h.set('Accept-Language', 'zh-TW,zh;q=0.9');
    const ck = cookieHeader(jar); if (ck) h.set('Cookie', ck);
    const r = await fetch(url, { method: init.method || 'GET', headers: h, body: init.body, redirect: 'manual', signal: init.signal });
    takeCookies(jar, r);
    return r;
  }
  async function fetchText(jar, path) {
    const r = await gameFetch(jar, new URL(path, GAME + '/').href, { signal: AbortSignal.timeout(20000) });
    return { status: r.status, text: await r.text() };
  }
  // 帳號資訊：401／403＝還沒登入或 cookie 過期（登入後 7 天有效，不會自動延長）
  async function account(jar) {
    const r = await gameFetch(jar, GAME + '/api/account', { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
    let a = null; try { a = JSON.parse(await r.text()); } catch (_) {}
    return { status: r.status, code: (a && a.playerCode) || '', chars: (a && Array.isArray(a.characterIds) && a.characterIds) || [], active: (a && a.activeCharacterId) || '' };
  }

  // 遊戲版本號（X-Game-Version）：client-update.js 裡的 40 碼十六進位；讀不到就找頁面裡 X-Game-Version 旁邊的字串
  const verRe = /X-Game-Version['"]?\s*[:,]\s*['"`]([^'"`\s]{1,80})['"`]/i;
  let ver = { v: '', at: 0, p: null };
  async function gameVersion(jar, force) {
    if (!force && ver.v && Date.now() - ver.at < VERSION_TTL_MS) return ver.v;
    if (ver.p) return ver.p;
    ver.p = (async () => {
      let v = '';
      try {
        const r = await fetchText(jar, '/game/client-update.js');
        if (r.status === 200) v = ((r.text.match(/\b[0-9a-f]{40}\b/) || [])[0]) || ((r.text.match(verRe) || [])[1]) || '';
      } catch (_) {}
      if (!v) { try { const r = await fetchText(jar, '/game/'); if (r.status === 200) v = (r.text.match(verRe) || [])[1] || ''; } catch (_) {} }
      if (v) { if (ver.v && v !== ver.v) log('遊戲版本更新：' + v.slice(0, 12)); ver.v = v; ver.at = Date.now(); }
      return ver.v;
    })().finally(() => { ver.p = null; });
    return ver.p;
  }
  const staleVersion = () => { ver.at = 0; };

  // 遊戲自己的 view-delta.mjs（合併增量同步用）：執行時才下載、用 data: 網址 import，不把遊戲程式碼放進 repo。
  // 讀不到（模擬遊戲沒有）就不要增量，每次拿完整的同步結果
  const viewMod = { mod: null, ver: '', at: 0, p: null };
  async function viewDelta(jar) {
    if (viewMod.ver === ver.v && (viewMod.mod || Date.now() - viewMod.at < 10 * 60000) && viewMod.at) return viewMod.mod;
    if (viewMod.p) return viewMod.p;
    viewMod.p = (async () => {
      viewMod.at = Date.now(); viewMod.ver = ver.v;
      try {
        const r = await fetchText(jar, '/game/view-delta.mjs');
        if (r.status !== 200 || !/mergeViewDelta/.test(r.text)) { viewMod.mod = null; return null; }
        const m = await import('data:text/javascript;base64,' + Buffer.from(r.text).toString('base64'));
        viewMod.mod = typeof m.mergeViewDelta === 'function' && typeof m.viewCacheHint === 'function' ? m : null;
      } catch (e) { viewMod.mod = null; log('view-delta.mjs 載入失敗，改用完整同步：' + e.message); }
      return viewMod.mod;
    })().finally(() => { viewMod.p = null; });
    return viewMod.p;
  }

  // 每次載入的 vm.Script 共用（agent 原始碼沒變就不用重新編譯）
  let scriptCache = { src: '', script: null };
  function pageScript(src) {
    if (scriptCache.src !== src) scriptCache = { src, script: new vm.Script(src, { filename: 'szg-direct-agent.js' }) };
    return scriptCache.script;
  }
  // 跟 bg.js injected() 一樣的組法：GM_* 用 localStorage「__gm:」鍵、GM_xmlhttpRequest 交給外面代送（只准連中控）
  function injected(o) {
    const us = userscript(); const body = us.split('// ==/UserScript==')[1] || us;
    const fixed = body.replace(/const HUB = '[^']*';/, `const HUB = ${JSON.stringify(hubUrl)};`);
    return `(function(){
if (window.__szgBg) return; // 防止重複注入
window.__szgBg = { profile: ${JSON.stringify(o.profile)}, key: ${JSON.stringify(o.key)}, standby: false, lite: true, boot: ${JSON.stringify(o.boot || '')}, direct: true };
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

  // 假頁面裡的 Storage：方法放在 prototype 上（agent 會改 Storage.prototype.setItem 擋住遊戲寫回舊角色）
  const STORAGE_SRC = `(function(host){
  const B = new WeakMap();
  function Storage() { throw new TypeError('Illegal constructor'); }
  Storage.prototype.getItem = function (k) { const v = B.get(this).get(String(k)); return v == null ? null : String(v); };
  Storage.prototype.setItem = function (k, v) { B.get(this).set(String(k), String(v)); };
  Storage.prototype.removeItem = function (k) { B.get(this).del(String(k)); };
  Storage.prototype.clear = function () { for (const k of B.get(this).keys()) B.get(this).del(k); };
  Storage.prototype.key = function (i) { const k = B.get(this).keys()[i]; return k == null ? null : k; };
  Object.defineProperty(Storage.prototype, 'length', { get() { return B.get(this).keys().length; } });
  const mk = be => { const s = Object.create(Storage.prototype); B.set(s, be); return s; };
  globalThis.Storage = Storage;
  globalThis.sessionStorage = mk(host.session);
  globalThis.localStorage = mk(host.local);
})`;

  function runner(opts) {
    const { profile, boot, jar, gm } = opts;
    let key = opts.key || '_';
    const name = String(profile) + (key && key !== '_' ? '/' + key : '');
    const say = m => { try { (opts.onLog || log)(`[${name}] ${m}`); } catch (_) {} };
    const session = new Map(); // 分頁的 sessionStorage：重新整理還在，關掉（stop）才清
    const st = { state: 'stopped', at: 0, loadedAt: 0, syncs: 0, errors: 0, msg: '', char: '' };
    let page = null;           // 目前的「頁面」
    let loadTimer = null, running = false, loads = 0, failStreak = 0, lastLoadStart = 0, navUrl = null, navType = 'navigate';

    const sessionBe = { get: k => session.get(k), set: (k, v) => session.set(k, v), del: k => session.delete(k), keys: () => [...session.keys()] };
    // localStorage：「__gm:」開頭的＝GM 儲存空間（同一個帳號的頁面共用）；其他的也放 GM，加「__ls:」前綴
    const localBe = {
      get: k => { if (k.startsWith('__gm:')) { const v = gm.get(k.slice(5), undefined); return v === undefined ? null : JSON.stringify(v); } const v = gm.get('__ls:' + k, undefined); return v === undefined ? null : v; },
      set: (k, v) => { if (k.startsWith('__gm:')) { let x; try { x = JSON.parse(v); } catch (_) { x = v; } gm.set(k.slice(5), x); } else gm.set('__ls:' + k, v); },
      del: k => gm.set(k.startsWith('__gm:') ? k.slice(5) : '__ls:' + k, undefined),
      keys: () => [],
    };

    function schedule(ms, why) {
      clearTimeout(loadTimer);
      if (!running) return;
      loadTimer = setTimeout(() => { loadTimer = null; load().catch(e => { say('載入失敗：' + e.message); }); }, Math.max(0, ms));
      if (why) say(why);
    }
    // 頁面要求重新整理／換網址（agent 的 location.reload、location.href＝…）：合併成一次，至少隔 2 秒
    function requestReload(url) {
      if (!running) return;
      if (url) { navUrl = url; navType = 'navigate'; } else if (!navUrl) navType = 'reload';
      if (loadTimer) return;
      schedule(Math.max(50, MIN_RELOAD_GAP_MS - (Date.now() - lastLoadStart)));
    }

    // 關掉目前的頁面：先發 pagehide（agent 會放掉分頁標記），再清掉所有計時器、讓還在路上的請求不再回到這頁
    function teardown() {
      const p = page; if (!p) return;
      page = null;
      try { p.dispatch(p.winListeners, 'pagehide', { persisted: false }); } catch (_) {}
      try { p.dispatch(p.winListeners, 'unload', {}); } catch (_) {}
      p.alive = false;
      for (const t of p.timers.values()) { clearTimeout(t); clearInterval(t); }
      p.timers.clear();
      for (const ac of p.aborts) { try { ac.abort(); } catch (_) {} }
      p.aborts.clear();
      p.winListeners.clear(); p.docListeners.clear();
    }

    function fail(state, msg, retryMs) {
      teardown();
      st.state = state; st.msg = msg; st.errors++;
      schedule(retryMs, msg + `（${Math.round(retryMs / 1000)} 秒後重試）`);
    }

    // ---------- 載入一個新頁面 ----------
    async function load() {
      teardown();
      if (!running) return;
      lastLoadStart = Date.now();
      st.state = 'loading';
      const isReload = loads > 0 && navType === 'reload';
      const url = new URL(navUrl || '/game/', GAME + '/');
      navUrl = null; navType = 'navigate';
      // 1) 先確認登入（等於打開 /game/）
      let acc;
      try { acc = await account(jar); }
      catch (e) { failStreak++; return fail('error', '連不到遊戲：' + e.message, Math.min(5000 * 2 ** (failStreak - 1), 120000)); }
      if (!running) return;
      if (acc.status === 401 || acc.status === 403) { failStreak = 0; try { opts.onAuth && opts.onAuth(acc.status); } catch (_) {} return fail('auth', `遊戲登入過期（HTTP ${acc.status}）`, AUTH_RETRY_MS); }
      if (acc.status !== 200) { failStreak++; return fail('error', `遊戲 /api/account 回 HTTP ${acc.status}`, Math.min(5000 * 2 ** (failStreak - 1), 120000)); }
      // 2) 版本號、增量同步模組（讀不到不擋）
      await gameVersion(jar).catch(() => '');
      await viewDelta(jar).catch(() => null);
      if (!running) return;
      // 3) 這頁要顯示哪隻角色：第一次載入用指定的角色（'_'＝帳號目前那隻）；重新整理沿用 sessionStorage（跟真的分頁一樣）
      if (loads === 0 && key && key !== '_') { session.set('mapleCharacter', key); session.delete('mapleSessionView'); }
      if (!session.get('mapleCharacter') && acc.active) session.set('mapleCharacter', acc.active);
      loads++;
      try { makePage(url, isReload); }
      catch (e) { failStreak++; return fail('error', '頁面程式執行失敗：' + e.message, Math.min(10000 * 2 ** (failStreak - 1), 120000)); }
    }

    function makePage(url, isReload) {
      const p = { alive: true, timers: new Map(), aborts: new Set(), winListeners: new Map(), docListeners: new Map(), t0: performance.now(), timeOrigin: Date.now(), seq: 0 };
      p.dispatch = (map, type, extra) => {
        const ev = Object.assign({ type, target: g, currentTarget: g, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} }, extra || {});
        for (const fn of [...(map.get(type) || [])]) { try { typeof fn === 'function' ? fn.call(g, ev) : fn && fn.handleEvent && fn.handleEvent(ev); } catch (e) { say(`${type} 事件錯誤：` + e.message); } }
      };
      const addL = map => (type, fn) => { if (!p.alive || !fn) return; const s = map.get(type) || new Set(); s.add(fn); map.set(type, s); };
      const remL = map => (type, fn) => { const s = map.get(type); if (s) s.delete(fn); };

      // 計時器：都記在這頁底下，關頁時一起清；callback 包 try/catch
      const wrap = (fn, args) => () => { if (!p.alive) return; try { if (typeof fn === 'function') fn(...args); } catch (e) { say('計時器錯誤：' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' ')); } };
      const timers = {
        setTimeout(fn, ms, ...args) {
          if (!p.alive) return 0;
          const id = ++p.seq, w = wrap(fn, args);
          const t = setTimeout(() => { p.timers.delete(id); w(); }, Math.max(0, Number(ms) || 0));
          if (t.unref) t.unref();
          p.timers.set(id, t); return id;
        },
        setInterval(fn, ms, ...args) {
          if (!p.alive) return 0;
          const id = ++p.seq, t = setInterval(wrap(fn, args), Math.max(10, Number(ms) || 0));
          if (t.unref) t.unref();
          p.timers.set(id, t); return id;
        },
        clear(id) { const t = p.timers.get(id); if (t) { clearTimeout(t); clearInterval(t); p.timers.delete(id); } },
      };

      // 這頁的基本 fetch：只准連遊戲；頁面關掉後結果不再送回來
      const loc = new URL(url.href);
      const baseFetch = function (input, init) {
        if (!p.alive) return new Promise(() => {});
        let u, method, headers, body;
        try {
          const isReq = input && typeof input === 'object' && typeof input.url === 'string' && !(input instanceof URL);
          u = new URL(isReq ? input.url : String(input), loc.href);
          init = init || {};
          method = String(init.method || (isReq && input.method) || 'GET').toUpperCase();
          headers = new Headers((isReq && input.headers) || undefined);
          if (init.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
          body = init.body != null ? init.body : undefined;
        } catch (e) { return Promise.reject(new TypeError('Failed to fetch: ' + e.message)); }
        if (u.origin !== GAME) return Promise.reject(new TypeError('Failed to fetch（直連模式只允許連到遊戲）'));
        const isGame = u.pathname === '/api/game';
        const ac = new AbortController(); p.aborts.add(ac);
        if (init.signal) { try { if (init.signal.aborted) ac.abort(); else init.signal.addEventListener('abort', () => ac.abort()); } catch (_) {} }
        const tm = setTimeout(() => ac.abort(), 60000); if (tm.unref) tm.unref();
        const go = (async () => {
          if (isGame) { const v = await gameVersion(jar).catch(() => ver.v); if (v) headers.set('X-Game-Version', v); }
          const r = await gameFetch(jar, u.href, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, signal: ac.signal });
          // 遊戲說「已更新」：下次重新讀版本號
          if (isGame && !r.ok) { try { const t = await r.clone().text(); if (/遊戲已更新|重新整理/.test(t)) staleVersion(); } catch (_) {} }
          if (r.status === 401 || r.status === 403) { try { const t = await r.clone().text(); if (!/來源不符/.test(t)) p.authHit = r.status; } catch (_) {} }
          return r;
        })();
        return new Promise((res, rej) => {
          go.then(r => { clearTimeout(tm); p.aborts.delete(ac); if (p.alive) res(r); },
            e => { clearTimeout(tm); p.aborts.delete(ac); if (p.alive) rej(e && e.name === 'AbortError' ? new TypeError('Failed to fetch') : e); });
        });
      };

      // 中控腳本連中控（GM_xmlhttpRequest）：只准連中控本身
      const gmx = payload => {
        let o; try { o = JSON.parse(payload); } catch (_) { return; }
        (async () => {
          let out;
          try {
            const u = new URL(o.url);
            if (u.origin !== HUB_ORIGIN) throw new Error('直連模式只允許連到中控');
            const method = String(o.method || 'GET').toUpperCase();
            const r = await fetch(u, { method, headers: o.headers || {}, body: method === 'GET' || method === 'HEAD' || o.data == null ? undefined : o.data, signal: AbortSignal.timeout(Math.min(Number(o.timeout) || 8000, 120000)) });
            out = { status: r.status, responseText: await r.text() };
          } catch (e) { out = { error: e && e.name === 'TimeoutError' ? 'timeout' : String((e && e.message) || e) }; }
          if (!p.alive) return;
          try { g.__szgGmxDone && g.__szgGmxDone(Number(o.id), out); } catch (e) { say('GM 回呼錯誤：' + e.message); }
        })();
      };

      // ---------- 假的瀏覽器環境 ----------
      const ctx = vm.createContext({}, { name: '直連 ' + name });
      const g = vm.runInContext('globalThis', ctx);
      p.g = g; p.ctx = ctx;
      const cons = {};
      for (const lv of ['log', 'info', 'warn', 'error', 'debug']) cons[lv] = (...a) => { if (lv === 'debug') return; try { say(`console.${lv}：` + a.map(x => x instanceof Error || (x && x.stack && x.message) ? x.message : typeof x === 'object' ? safeJson(x) : String(x)).join(' ').slice(0, 400)); } catch (_) {} };
      cons.trace = cons.debug; cons.table = cons.log; cons.group = cons.groupCollapsed = cons.groupEnd = () => {};
      const location = {
        get href() { return loc.href; }, set href(v) { requestReload(new URL(String(v), loc.href).href); },
        get origin() { return loc.origin; }, get protocol() { return loc.protocol; }, get host() { return loc.host; }, get hostname() { return loc.hostname; },
        get port() { return loc.port; }, get pathname() { return loc.pathname; }, get search() { return loc.search; }, get hash() { return loc.hash; },
        reload() { requestReload(); }, assign(v) { requestReload(new URL(String(v), loc.href).href); }, replace(v) { requestReload(new URL(String(v), loc.href).href); },
        toString() { return loc.href; },
      };
      let hState = null;
      const history = {
        get state() { return hState; }, get length() { return 1; },
        replaceState(s, _t, u) { hState = s; if (u != null) { const n = new URL(String(u), loc.href); if (n.origin === loc.origin) loc.href = n.href; } },
        pushState(s, _t, u) { history.replaceState(s, _t, u); }, back() {}, forward() {}, go() {},
      };
      const perf = {
        now: () => performance.now() - p.t0, timeOrigin: p.timeOrigin,
        getEntriesByType: t => (t === 'navigation' ? [{ type: isReload ? 'reload' : 'navigate', name: url.href, entryType: 'navigation' }] : []),
        getEntries: () => [], mark() {}, measure() {},
      };
      const fakeEl = () => ({ style: {}, dataset: {}, children: [], appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], textContent: '', innerHTML: '' });
      const document = {
        body: null, head: null, documentElement: null, hidden: false, visibilityState: 'visible', readyState: 'loading', cookie: '', title: '上漲谷', referrer: '',
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [], getElementsByClassName: () => [],
        createElement: fakeEl, createTextNode: () => ({}), hasFocus: () => false,
        addEventListener: addL(p.docListeners), removeEventListener: remL(p.docListeners),
        get location() { return location; },
      };
      const navigator = { userAgent: UA, language: 'zh-TW', languages: ['zh-TW', 'zh'], onLine: true, platform: 'Win32', hardwareConcurrency: 4, webdriver: false, sendBeacon: () => true };
      Object.assign(g, {
        window: g, self: g, top: g, parent: g, globalThis: g, frames: g,
        document, location, history, navigator, performance: perf, console: cons,
        fetch: baseFetch, setTimeout: timers.setTimeout, setInterval: timers.setInterval, clearTimeout: timers.clear, clearInterval: timers.clear,
        requestAnimationFrame: fn => timers.setTimeout(() => fn(perf.now()), 500), cancelAnimationFrame: timers.clear,
        requestIdleCallback: fn => timers.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 10 }), 50), cancelIdleCallback: timers.clear,
        queueMicrotask: fn => queueMicrotask(() => { if (p.alive) try { fn(); } catch (e) { say('microtask 錯誤：' + e.message); } }),
        addEventListener: addL(p.winListeners), removeEventListener: remL(p.winListeners), dispatchEvent: ev => { p.dispatch(p.winListeners, ev && ev.type, ev); return true; },
        open: () => null, confirm: () => false, alert: () => {}, prompt: () => null, focus() {}, blur() {}, close() {}, print() {}, scrollTo() {},
        innerWidth: 1280, innerHeight: 860, devicePixelRatio: 1, isSecureContext: true, origin: GAME, name: '',
        Response, Headers, Request, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder, Blob, FormData,
        atob, btoa, structuredClone, crypto: globalThis.crypto, Event: globalThis.Event, EventTarget: globalThis.EventTarget,
        __szgGmx: gmx,
      });
      vm.runInContext(STORAGE_SRC, ctx)({ session: sessionBe, local: localBe });
      page = p;
      st.loadedAt = Date.now();

      // document-start：先放中控腳本（agent 在遊戲程式之前裝好 fetch 攔截、處理 ?szgChar=）
      pageScript(injected({ profile, key, boot })).runInContext(ctx);
      if (!p.alive) return;
      // 頁面載入完成
      document.readyState = 'interactive'; p.dispatch(p.docListeners, 'readystatechange');
      p.dispatch(p.docListeners, 'DOMContentLoaded');
      document.readyState = 'complete'; p.dispatch(p.docListeners, 'readystatechange');
      p.dispatch(p.winListeners, 'load');
      p.dispatch(p.winListeners, 'pageshow', { persisted: false });
      // 遊戲頁面自己的定時同步
      gameClient(p, g, timers);
    }

    // ---------- 遊戲頁面的同步（代替 game.js） ----------
    function gameClient(p, g, timers) {
      let cur = g.sessionStorage.getItem('mapleCharacter') || ''; // 跟真實遊戲一樣：同步用記憶體裡「畫面上的角色」
      let prev = null, needFull = true, lastFull = 0, backoff = 0;
      const next = ms => timers.setTimeout(poll, ms);
      async function poll() {
        if (!p.alive) return;
        const mod = viewMod.mod;
        const full = needFull || Date.now() - lastFull > FULL_SYNC_MS;
        // includeSocial:false：真實頁面沒開聊天時也不拿聊天資料（實測一次少 18 KB，2026-11-28）
        const payload = { type: 'sync', characterId: cur || undefined, includeSocial: false };
        if (mod) { payload.acceptViewDelta = 1; payload.viewAlbum = 1; if (prev && !full) { try { payload.viewCache = mod.viewCacheHint(prev); } catch (_) {} } }
        if (full) payload.fullSync = true;
        let r, j = null;
        try {
          // 用「目前的」window.fetch：agent 的 DPS／掉落／公會等攔截才看得到同步結果
          r = await g.fetch('/api/game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          try { j = await r.json(); } catch (_) {}
        } catch (e) {
          if (!p.alive) return;
          st.errors++; st.msg = '同步失敗：' + e.message; backoff = Math.min((backoff || IDLE_POLL_MS) * 2, 120000); needFull = true;
          return next(backoff);
        }
        if (!p.alive) return;
        if (r.status === 401 || (r.status === 403 && p.authHit)) { try { opts.onAuth && opts.onAuth(r.status); } catch (_) {} return fail('auth', `遊戲登入過期（HTTP ${r.status}）`, AUTH_RETRY_MS); }
        const err = !r.ok || (j && j.error) ? String((j && (j.error || j.message)) || 'HTTP ' + r.status) : '';
        if (err) {
          st.errors++; st.msg = '同步：' + err;
          if (/遊戲已更新|重新整理/.test(err)) { staleVersion(); if (Date.now() - st.loadedAt > 60000) { say('遊戲有新版本，重新載入'); return requestReload(); } }
          backoff = Math.min((backoff || IDLE_POLL_MS) * 2, 120000); needFull = true;
          return next(backoff);
        }
        let state = j;
        if (j && j.viewDelta && mod) {
          try { state = mod.mergeViewDelta(prev, j); }
          catch (e) { needFull = true; st.msg = '增量同步對不上，下次完整同步'; return next(1000); }
        }
        if (full) lastFull = Date.now();
        needFull = false; backoff = 0;
        if (state && state.character) {
          prev = state;
          cur = state.character.id;
          try {
            g.sessionStorage.setItem('mapleCharacter', state.character.id);
            g.sessionStorage.setItem('mapleSessionView', JSON.stringify({ state }));
          } catch (e) { say('寫入 sessionStorage 失敗：' + e.message); }
          st.char = state.character.id; st.at = Date.now(); st.syncs++; st.state = 'running'; st.msg = ''; failStreak = 0;
        }
        next(jitter(IDLE_POLL_MS));
      }
      poll();
    }

    return {
      start() {
        if (running) return;
        running = true; loads = 0; failStreak = 0; navUrl = null; navType = 'navigate'; session.clear();
        st.state = 'loading'; st.msg = ''; st.char = '';
        schedule(0);
      },
      stop() {
        running = false;
        clearTimeout(loadTimer); loadTimer = null;
        teardown();
        session.clear();
        st.state = 'stopped';
      },
      reload() { if (!running) return this.start(); navType = 'reload'; schedule(0); },
      setKey(k) { key = k || '_'; if (page && page.g && page.g.__szgBg) page.g.__szgBg.key = key; },
      // 除錯／測試用：在目前的頁面裡執行一段程式（等於 DevTools 的 console）
      evalPage(src) { if (!page || !page.alive) throw new Error('頁面還沒載入'); return vm.runInContext(String(src), page.ctx); },
      status() {
        let busy = false, standby = false;
        try { const b = page && page.alive && page.g.__szgBg; busy = !!(b && b.isBusy && b.isBusy()); standby = !!(b && b.standby); } catch (_) {}
        return { key, char: st.char || session.get('mapleCharacter') || '', state: st.state, at: st.at, loadedAt: st.loadedAt, syncs: st.syncs, errors: st.errors, msg: st.msg, busy, standby, timers: page ? page.timers.size : 0 };
      },
    };
  }

  return { runner, account, fetchText, gameVersion: jar => gameVersion(jar, true) };
};

function safeJson(x) { try { return JSON.stringify(x); } catch (_) { return String(x); } }
