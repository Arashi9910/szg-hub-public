// 上漲谷中控 - 功能程式（由 Tampermonkey 透過 @require 從中控伺服器載入）
// 版本號由伺服器依 version.json 自動填入。
function agentMain(ctx) {
  'use strict';
  const AGENT_VERSION = '0.6.3';
  const { GM_xmlhttpRequest, GM_getValue, GM_setValue, W, HUB, TOKEN, shared } = ctx;
  const SCAN_MS = 10000;      // 資料回報間隔
  const HEARTBEAT_MS = 60000;
  const AGENT_MS = 3000;      // 工作輪詢間隔
  const STEP_TIMEOUT_MS = 3 * 60 * 1000; // 交易某一步卡超過 3 分鐘就取消
  const JOB_BITS = { '劍士': 1, '法師': 2, '弓箭手': 4, '盜賊': 8, '海盜': 16 };

  let catalog = null;
  let lastHash = '';
  let lastSent = 0;
  let account = null;          // { playerCode, activeCharacterId }
  let accountAt = 0;

  // ---------- 同一個帳號開兩個分頁（A、B 角色各一個）----------
  // 每次載入頁面一個新的 PAGE_ID；網址帶 ?szgChar=<角色ID> 時，這個分頁固定顯示那隻角色
  // （document-start 就改 sessionStorage，遊戲程式載入時就會用這隻），改完把參數拿掉，之後在遊戲裡切換也不會被拉回來
  const PAGE_ID = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12);
  try {
    const u = new URL(location.href), want = u.searchParams.get('szgChar');
    if (want) {
      sessionStorage.setItem('mapleCharacter', want);
      sessionStorage.removeItem('mapleSessionView');
      u.searchParams.delete('szgChar');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    }
  } catch (_) {}
  // 分頁編號：同一個分頁重新整理（F5、自動更新）沿用，新開的分頁（含「複製分頁」，它會連 sessionStorage 一起複製）換一個新的
  const TAB_ID = (() => {
    let nav = '';
    try { nav = (performance.getEntriesByType('navigation')[0] || {}).type || ''; } catch (_) {}
    let id = sessionStorage.getItem('szgTabId');
    if (!id || nav !== 'reload') { id = PAGE_ID; sessionStorage.setItem('szgTabId', id); }
    return id;
  })();
  const myChar = () => sessionStorage.getItem('mapleCharacter') || '';
  const ck = k => k + ':' + myChar(); // 每隻角色（每個分頁）各自一份的設定鍵；同設定檔的分頁共用 GM 儲存空間
  // 這隻角色由哪個分頁負責：{page, at, hidden}。同一隻角色開了兩個分頁時，後開的那個暫停中控功能，避免同一件事做兩次
  const tabKey = id => 'charTab:' + id;
  const tabFresh = v => v && Date.now() - v.at < (v.hidden ? 100000 : 20000);
  const isMe = v => v && (v.page === PAGE_ID || (v.tab && v.tab === TAB_ID)); // 同一個分頁重新整理前的自己
  let dupTab = false;
  function tabBeat() {
    const id = myChar(); if (!id) return;
    const v = GM_getValue(tabKey(id), null);
    if (v && !isMe(v) && tabFresh(v)) {
      if (!dupTab) { dupTab = true; setBadge(null, '⚠ 這隻角色已經在另一個分頁開著：這個分頁先不執行中控工作（關掉其中一個就好）'); }
      becomeOther();
      return;
    }
    if (dupTab) { dupTab = false; setBadge('ok'); }
    GM_setValue(tabKey(id), { page: PAGE_ID, tab: TAB_ID, at: Date.now(), hidden: document.hidden });
  }
  // 別的分頁是否正在負責某隻角色（同帳號的另一隻有自己的分頁時，這個分頁就不幫它做事）
  const otherTabHas = id => { const v = GM_getValue(tabKey(id), null); return !!(v && !isMe(v) && tabFresh(v)); };
  const passive = () => dupTab;
  // 直接開新分頁時，遊戲會載入帳號「目前」那隻（通常是已經有分頁的 A）：
  // 剛開的分頁發現這隻已經有人負責、同帳號另一隻沒有分頁 → 自動換成另一隻（等於按了「＋ 開 某某 的分頁」）
  let becoming = false;
  async function becomeOther() {
    if (becoming || performance.now() > 90000) return; // 只處理剛開的分頁；開很久的分頁不自動換
    const last = Number(sessionStorage.getItem('szgAutoOther') || 0);
    if (Date.now() - last < 60000) return; // 剛換過還是重複：不要一直重新整理
    becoming = true;
    try {
      await loadAccount().catch(() => null);
      const st = readState();
      const ids = (account && account.characterIds) || (st && (st.characters || []).map(c => c.id)) || [];
      const me = myChar();
      const free = ids.find(x => x && x !== me && !otherTabHas(x));
      if (!free) return; // 兩隻都有分頁了：維持暫停並提示
      sessionStorage.setItem('szgAutoOther', String(Date.now()));
      sessionStorage.setItem('mapleCharacter', free);
      sessionStorage.removeItem('mapleSessionView');
      // 遊戲同步完會把 mapleCharacter 寫回畫面上的角色：重新整理前擋住
      try { const SP = (W.Storage || Storage).prototype, orig = SP.setItem, ss = W.sessionStorage; SP.setItem = function (k, val) { if (this === ss && k === 'mapleCharacter' && val !== free) return; return orig.call(this, k, val); }; } catch (_) {}
      W.addEventListener('pagehide', () => { try { sessionStorage.setItem('mapleCharacter', free); sessionStorage.removeItem('mapleSessionView'); } catch (_) {} });
      setBadge(null, '這隻角色已經有分頁了，自動換成同帳號的另一隻…');
      setTimeout(() => location.reload(), 300);
    } finally { becoming = false; }
  }

    // ---------- 共用 ----------
    function hub(method, path, body) {
      return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (TOKEN) headers['X-Hub-Token'] = TOKEN;
        GM_xmlhttpRequest({
          method, url: HUB + path, headers, timeout: 8000,
          data: body ? JSON.stringify(body) : undefined,
          onload: r => {
            setBadge(r.status === 200 ? 'ok' : r.status === 401 ? 'auth' : 'err');
            if (r.status !== 200) return reject(new Error('hub ' + r.status));
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          },
          onerror: () => { setBadge('err'); reject(new Error('hub offline')); },
          ontimeout: () => { setBadge('err'); reject(new Error('hub timeout')); },
        });
      });
    }

    // 送指令給遊戲伺服器：
    //  - 「忙碌／稍後重試」：等 2、4、6 秒重送，最多 4 次
    //  - 「遊戲已更新，請重新整理」：這個頁面已經過期，自動重新整理（交易進度存在遊戲伺服器上，重整後會接著做）
    //  - 一律透過「遊戲頁面自己的 fetch」送出：遊戲的 client-update.js 會在上面補上版本標頭（X-Game-Version 等），
    //    少了這個標頭，伺服器會當成舊版遊戲而拒絕（回「遊戲已更新」）
    //  - 每個操作都要帶 requestId（遊戲規定的操作識別碼）
    let reloadingForGameUpdate = false;
    const pageFetch = (...args) => (W && typeof W.fetch === 'function' ? W.fetch(...args) : fetch(...args));
    const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    async function game(action) {
      const characterId = sessionStorage.getItem('mapleCharacter');
      const payload = { ...action, characterId: action.characterId || characterId };
      if (payload.type !== 'sync' && !payload.requestId) payload.requestId = newRequestId();
      for (let attempt = 0; ; attempt++) {
        const r = await pageFetch('/api/game', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        let j = null;
        try { j = await r.json(); } catch (_) {}
        if (r.ok && !(j && j.error)) return j;
        const msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
        if (/遊戲已更新|重新整理後/.test(msg)) {
          // 5 分鐘內最多自動重整一次，避免一直重整
          const last = GM_getValue(ck('gameUpdateReloadAt'), 0);
          if (!reloadingForGameUpdate && Date.now() - last > 5 * 60 * 1000) {
            reloadingForGameUpdate = true;
            GM_setValue(ck('gameUpdateReloadAt'), Date.now());
            setBadge(null, '遊戲有新版本，3 秒後自動重新整理頁面');
            setTimeout(() => location.reload(), 3000);
            const e = new Error(msg); e.gameUpdated = true; throw e;
          }
          throw new Error(msg + '（已經自動重新整理過，仍然被拒絕）');
        }
        if (/忙碌|稍後重試|稍後再試|too many|busy/i.test(msg) && attempt < 3) {
          await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(msg);
      }
    }

    // 遊戲頁面自己存的狀態（畫面上的角色）。背包、倉庫這些欄位頁面不一定會即時更新（實測：中控鎖定道具後，
    // 另一個分頁的頁面資料一直是舊的），所以另外定時（45 秒）和每次做完工作後直接向遊戲要一份，背包相關欄位用比較新的那份
    const OWN_KEYS = ['inventoryStacks', 'inventory', 'equipmentBag', 'gear', 'warehouse', 'warehouseGear', 'warehouseMesos', 'supply', 'autoSell'];
    let ownState = null, ownStateAt = 0;
    async function refreshOwnState(force) {
      if (!force && Date.now() - ownStateAt < 45000) return;
      const id = myChar(); if (!id) return;
      ownStateAt = Date.now();
      try {
        const j = await game({ type: 'sync' });
        if (j && j.character && j.character.id === id && Array.isArray(j.character.inventoryStacks)) { ownState = j; lastHash = ''; }
      } catch (_) {}
    }
    function readState() {
      const raw = sessionStorage.getItem('mapleSessionView');
      if (!raw) return null;
      const v = JSON.parse(raw);
      const page = v && v.state && v.state.character ? v.state : null;
      if (!page || !ownState || ownState.character.id !== page.character.id || Date.now() - ownStateAt > 120000) return page;
      const ch = { ...page.character };
      for (const k of OWN_KEYS) if (k in ownState.character) ch[k] = ownState.character[k];
      return { ...page, character: ch };
    }

    // 帳號資訊（12 碼 ID、目前角色）。查詢失敗時沿用上次成功的結果，並記下失敗原因回報給面板。
    const CODE_RE = /^[A-F0-9]{12}$/;
    let accountError = '';
    function rememberedCode() {
      const charId = sessionStorage.getItem('mapleCharacter') || '';
      return GM_getValue('code:' + charId, '') || '';
    }
    function rememberCode(code) {
      const charId = sessionStorage.getItem('mapleCharacter') || '';
      if (charId && CODE_RE.test(code)) GM_setValue('code:' + charId, code);
    }
    async function loadAccount() {
      const ttl = account && account.playerCode && !accountError ? 5 * 60 * 1000 : 30 * 1000;
      if (account && Date.now() - accountAt < ttl) return account;
      accountAt = Date.now();
      try {
        const r = await fetch('/api/account', { credentials: 'same-origin', cache: 'no-store' });
        const text = await r.text();
        let a = null;
        try { a = JSON.parse(text); } catch (_) {}
        if (!r.ok) throw new Error(`HTTP ${r.status}${a && (a.error || a.message) ? '：' + (a.error || a.message) : ''}`);
        if (!a || !CODE_RE.test(String(a.playerCode || ''))) {
          const keys = a ? Object.keys(a).filter(k => !/key|token|mail/i.test(k)).join(',') : '非 JSON';
          throw new Error(`回應沒有 ID（欄位：${keys}${a && a.status ? '，status=' + a.status : ''}）`);
        }
        account = { playerCode: a.playerCode, activeCharacterId: a.activeCharacterId, characterIds: Array.isArray(a.characterIds) ? a.characterIds : null };
        rememberCode(a.playerCode);
        accountError = '';
      } catch (e) {
        accountError = String(e && e.message || e);
        const code = (account && account.playerCode) || rememberedCode() || scrapeCode();
        account = { playerCode: code || undefined, activeCharacterId: account && account.activeCharacterId };
      }
      return account;
    }
    // 備援：從畫面上讀 ID（人物頁、交易視窗都會顯示）
    function scrapeCode() {
      const text = document.body ? document.body.innerText : '';
      const m = text.match(/你的遊戲 ID[：:]\s*([A-F0-9]{12})/) || text.match(/\bID\s*\n?\s*([A-F0-9]{12})\b/);
      if (m) { rememberCode(m[1]); return m[1]; }
      return '';
    }

    // ---------- 目錄 ----------
    async function loadCatalog() {
      if (catalog) return catalog;
      const res = await fetch('/api/catalog', { credentials: 'same-origin' });
      const cat = await res.json();
      const mapsById = {};
      for (const m of Object.values(cat.maps || {})) {
        if (m && m.id != null) mapsById[String(m.id)] = m.name;
        if (m && m.msId != null) mapsById[String(m.msId)] = m.name;
      }
      const skillNames = {};
      for (const sk of (Array.isArray(cat.skills) ? cat.skills : Object.values(cat.skills || {}))) if (sk && sk.msId != null) skillNames[sk.msId] = sk.name;
      const mobNames = {};
      for (const m of cat.mobs || []) if (m && m.id) mobNames[m.id] = m.name;
      catalog = { equipment: cat.equipment || {}, items: cat.items || {}, scrolls: cat.scrolls || {}, jobs: cat.jobs || {}, statNames: cat.statNames || {}, mapsById, skillNames, mobNames };
      setTimeout(() => uploadWorld(cat).catch(e => console.warn('[szg-hub world]', e)), 5000);
      return catalog;
    }
    // 把地圖、怪物、掉落表整理後交給中控（面板的「地圖」分頁用）；同一版本只傳一次
    async function uploadWorld(cat) {
      // 版本＝目錄內容的雜湊：遊戲更新地圖、怪物、掉落、裝備時（就算數量沒變）都會重新上傳
      const fnv = str => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
      let hash = ''; try { hash = fnv(JSON.stringify([cat.maps, cat.mobs, cat.drops, cat.mapDrops, cat.equipment, cat.items, cat.scrolls, cat.autoSellDrops])); } catch (_) {}
      const ver = 'w6:' + String(cat.version || '') + ':' + Object.keys(cat.maps || {}).length + ':' + (cat.mobs || []).length + ':' + Object.keys(cat.drops || {}).length + ':' + hash;
      const have = await hub('GET', '/api/world/version');
      if (have && have.version === ver) return;
      const names = {};
      for (const [k, it] of Object.entries(cat.items || {})) { const id = it.id || Number(String(k).replace(/\D/g, '')); if (id) names[id] = [it.name, it.type || '道具']; }
      for (const [k, e] of Object.entries(cat.equipment || {})) { const id = e.itemId || e.id || Number(String(k).replace(/\D/g, '')); if (id && !names[id]) names[id] = [e.name || (e.meta && e.meta.name) || k, '裝備']; }
      for (const [k, sc] of Object.entries(cat.scrolls || {})) { const id = sc.id || sc.itemId || Number(String(k).replace(/\D/g, '')); if (id && !names[id]) names[id] = [sc.name, '卷軸']; }
      const drops = {};
      for (const [mapId, byMob] of Object.entries(cat.mapDrops || {})) {
        const o = drops[mapId] = {};
        for (const [mob, rows] of Object.entries(byMob || {})) o[mob] = (rows || []).map(r => [r.itemId, r.min, r.max, r.chance, r.questId || 0]);
      }
      // 一般掉落（每隻怪通用）；上面的 drops 是少數地圖的專屬掉落，優先使用
      const mobDrops = {};
      for (const [mob, rows] of Object.entries(cat.drops || {})) mobDrops[mob] = (rows || []).map(r => [r.itemId, r.min, r.max, r.chance, r.questId || 0]);
      const skills = (Array.isArray(cat.skills) ? cat.skills : Object.values(cat.skills || {})).filter(s => s.effect && s.effect.party === true)
        .map(s => ({ name: s.name, job: s.job, tier: s.tier, kind: s.effect.kind, text: s.effect.text, top: (s.levels || [])[(s.levels || []).length - 1] || {} }));
      const jobs = {};
      for (const [k, j] of Object.entries(cat.jobs || {})) jobs[k] = { name: j.name, tier: j.tier, parent: j.parent || j.base || j.from || null, branch: j.branch || null };
      const world = {
        version: ver, at: Date.now(), dropScale: cat.dropScale || 1000000, partyExpNotice: cat.partyExpNotice || '',
        maps: Object.values(cat.maps || {}).map(m => ({ id: m.id, msId: m.msId, name: m.name, region: m.region, minLevel: m.minLevel || 0, mobIds: m.mobIds || [], boss: (m.bossSpawns || []).map(b => b.mobId) })),
        mobs: (cat.mobs || []).map(m => ({ id: m.id, msId: m.msId, name: m.name, lv: m.lv, hp: m.hp, xp: m.xp, money: m.money, isBoss: !!m.isBoss, acc: m.meta && m.meta.accuracy, eva: m.meta && m.meta.evasion, def: m.defense })),
        drops, mobDrops, names, skills, jobs,
        // 裝備圖鑑：[id, 名稱, 部位(equipmentType), 分類, 需求等級, 需求職業(位元；0＝全職業), 標準素質{incX}, 可衝次數, 需求能力[力,敏,智,幸]]；不含點裝
        equipment: Object.values(cat.equipment || {}).filter(e => e && (e.id || e.itemId) && !(e.meta && e.meta.cash)).map(e => { const m = e.meta || {}, st = {};
          for (const [k, v] of Object.entries({ ...(e.base || {}), ...m })) if (/^inc[A-Z]/.test(k) && typeof v === 'number' && v) st[k] = v;
          return [e.id || e.itemId, e.name || '', e.equipmentType || '', (e.type && (e.type.subCategory || e.type.category)) || '', m.reqLevel || 0, m.reqJob || 0, st, m.tuc || 0, [m.reqSTR || 0, m.reqDEX || 0, m.reqINT || 0, m.reqLUK || 0]]; }),
        statNames: cat.statNames || {},
        // 道具圖示：遊戲自己用的圖（技能書、商店道具的圖不在 /game/drops/<id>.png）；只放路徑，不放 data: 圖
        icons: (() => { const o = {}; for (const it of [...Object.values(cat.items || {}), ...Object.values(cat.scrolls || {}), ...Object.values(cat.equipment || {})]) {
          const id = it && (it.id || it.itemId); const ic = String((it && it.icon) || '').replace(/^https?:\/\/[^/]+/, '');
          if (id && ic.startsWith('/') && ic !== `/game/drops/${id}.png` && ic.length < 200 && !o[id]) o[id] = ic; } return o; })(),
        // 卷軸：[名稱, 適用部位（對應裝備的 type）, 成功率, 詛咒（失敗時裝備消失機率 %）, 素質]，給強化工坊用
        scrolls: Object.fromEntries(Object.entries(cat.scrolls || {}).map(([k, sc]) => [k, [sc.name, sc.target, Number(sc.rate) || 0, Number(sc.cursed) || 0, sc.stats || {}]])),
        // 每張地圖可設定自動販售的掉落物：[itemId, 種類, 名稱, 商店價, 可賣, 分類, 掉落的怪物 id]
        autoSellDrops: Object.fromEntries(Object.entries(cat.autoSellDrops || {}).map(([mapId, rows]) => [mapId, (rows || []).filter(r => r && r.itemId).map(r => [r.itemId, r.kind, r.name, r.price || 0, r.sellable ? 1 : 0, r.category || '', (r.monsters || []).map(m => m.id)])])),
      };
      await hub('POST', '/api/world', world);
    }

    function jobBranch(jobKey) {
      let j = catalog.jobs[jobKey], guard = 0;
      while (j && j.parent && j.tier > 1 && guard++ < 6) j = catalog.jobs[j.parent];
      return j ? j.name : '';
    }
    function itemInfo(key) {
      const it = catalog.items[key] || catalog.scrolls[key];
      if (!it) return { name: key, kind: '其他', cat: 'etc', sellPrice: 0, itemId: 0 };
      // 技能書在遊戲背包裡屬於「消耗」分頁，中控也一律算消耗（使用者要求）
      const kind = it.type === '技能書' ? '消耗' : it.type || (catalog.scrolls[key] ? '卷軸' : '其他');
      return { name: it.name || key, kind, cat: bagCat(it.id, kind), sellPrice: it.sellPrice || 0, itemId: it.id || 0 };
    }
    // 遊戲背包分類：依物品編號開頭（2 消耗、3 裝飾、4 其他、5 點數）
    function bagCat(id, kind) {
      const head = Math.floor((Number(id) || 0) / 1000000);
      if (head === 2) return 'consume';
      if (head === 3) return 'setup';
      if (head === 4) return 'etc';
      if (head === 5) return 'cash';
      return kind === '消耗' || kind === '卷軸' ? 'consume' : 'etc';
    }

    // 補給中使用的道具（不收集）
    function supplyKeys(c) {
      const s = c.supply || {};
      const keys = new Set();
      for (const k of ['hpItem', 'mpItem']) if (s[k]) keys.add(s[k]);
      for (const k of ['buffPotion', 'buffPotion2', 'buffPotion3', 'extra']) if (s[k] && s[k].item) keys.add(s[k].item);
      if (c.selectedAmmo) keys.add(c.selectedAmmo);
      return keys;
    }
    // 每種道具被鎖定的數量
    function lockedQtyByKey(c) {
      const m = {};
      for (const st of c.inventoryStacks || []) if (st.locked) m[st.key] = (m[st.key] || 0) + (st.qty || 0);
      return m;
    }
    function itemTradableQty(c, key, locked) {
      const qty = (c.inventory || {})[key] || 0;
      if (shared.eligible && !shared.eligible.items.has(key)) return 0;
      return Math.max(0, qty - (locked[key] || 0));
    }
    function gearTradable(g) {
      if (g.locked) return false;
      if (shared.eligible && !shared.eligible.gear.has(g.uid)) return false;
      return true;
    }

    // ---------- 畫面補抓 ----------
    function scrapeDom(charId) {
      const metaKey = 'meta:' + charId;
      const meta = GM_getValue(metaKey, {});
      const text = document.body ? document.body.innerText : '';
      let m;
      if ((m = text.match(/EXP\s*([\d,]+)\s*\[([\d.]+)%\]/))) {
        const xp = Number(m[1].replace(/,/g, '')), pct = Number(m[2]);
        if (pct > 0) meta.expNeed = Math.round(xp / (pct / 100));
      }
      if ((m = text.match(/平均每小時經驗\s*([\d,]+)/))) meta.hourlyExp = Number(m[1].replace(/,/g, ''));
      GM_setValue(metaKey, meta);
      return meta;
    }

    // ---------- 快照 ----------
    function gearRow(g, loc, slotKey) {
      const e = catalog.equipment[g.key] || {};
      const meta = e.meta || {};
      const category = (e.type && e.type.category) || '';
      let slot = slotKey || g.type || e.equipmentType || '';
      if (/Weapon/.test(category)) slot = 'weapon';
      return {
        loc, slot, uid: g.uid,
        weaponType: /Weapon/.test(category) ? (g.type || e.equipmentType) : '', gtype: g.type || e.equipmentType || '',
        itemId: g.itemId, name: g.name, plus: g.successes || 0, slotsLeft: g.slots || 0, maxSlots: g.maxSlots || 0,
        locked: !!g.locked, tradable: loc === '背包' ? gearTradable(g) : false,
        stats: g.stats || {}, cleanStats: g.cleanStats || g.baseStats || {}, baseStats: g.rollVersion && g.baseStats ? g.baseStats : null,
        reqLevel: meta.reqLevel || 0, reqJob: meta.reqJob || 0,
        reqSTR: meta.reqSTR || 0, reqDEX: meta.reqDEX || 0, reqINT: meta.reqINT || 0, reqLUK: meta.reqLUK || 0,
      };
    }

    function buildSnapshot(state) {
      const c = state.character;
      const meta = scrapeDom(c.id);
      const inv = c.inventory || {};
      const sup = c.supply || {};
      const branch = jobBranch(c.job);
      const supKeys = supplyKeys(c);
      const locked = lockedQtyByKey(c);

      const gear = [];
      for (const [slotKey, g] of Object.entries(c.gear || {})) if (g) gear.push(gearRow(g, '穿戴', slotKey));
      for (const g of c.equipmentBag || []) gear.push(gearRow(g, '背包'));
      for (const g of c.warehouseGear || []) gear.push(gearRow(g, '倉庫'));

      const stacksByKey = {};
      for (const st of c.inventoryStacks || []) (stacksByKey[st.key] || (stacksByKey[st.key] = [])).push({ uid: st.uid, qty: st.qty, locked: !!st.locked });
      const items = [];
      for (const [key, qty] of Object.entries(inv)) {
        if (!qty) continue;
        const info = itemInfo(key);
        items.push({ key, name: info.name, kind: info.kind, cat: info.cat, itemId: info.itemId, sellPrice: info.sellPrice, qty, loc: '背包',
          supply: supKeys.has(key), tradableQty: itemTradableQty(c, key, locked), lockedQty: locked[key] || 0, stacks: stacksByKey[key] || [] });
      }
      for (const [key, qty] of Object.entries(c.warehouse || {})) {
        if (!qty) continue;
        const info = itemInfo(key);
        items.push({ key, name: info.name, kind: info.kind, cat: info.cat, qty, loc: '倉庫', supply: false, tradableQty: 0, lockedQty: 0, stacks: [] });
      }

      const chars = (state.characters || []).map(x => ({ id: x.id, name: x.name, lv: x.lv, job: x.job, auto: x.auto }));
      const accountId = chars.length ? chars.map(x => x.id).sort()[0] : c.id;

      return {
        v: 3, at: Date.now(), serverTime: state.serverTime || Date.now(),
        scriptVersion: AGENT_VERSION,
        scriptMode: ctx.mode,
        page: PAGE_ID, hidden: document.hidden,
        accountId, accountChars: chars, statNames: catalog.statNames,
        playerCode: (account && account.playerCode) || rememberedCode() || scrapeCode() || undefined,
        accountError: accountError || undefined,
        activeCharId: account && account.activeCharacterId,
        eligibleKnown: !!shared.eligible,
        char: {
          id: c.id, name: c.name, job: c.job,
          jobName: (catalog.jobs[c.job] && catalog.jobs[c.job].name) || c.job,
          branch, branchBit: JOB_BITS[branch] || 0,
          lv: c.lv, xp: c.xp,
          nextXp: Number(c.nextXp) > 0 ? Number(c.nextXp) : (meta.expNeed || null),
          nextXpExact: Number(c.nextXp) > 0,
          expPct: (Number(c.nextXp) > 0 || meta.expNeed) ? Math.min(100, (c.xp / (Number(c.nextXp) > 0 ? Number(c.nextXp) : meta.expNeed)) * 100) : null,
          hourlyExp: meta.hourlyExp || null,
          tradeId: (account && account.playerCode) || rememberedCode() || undefined,
          money: c.money || 0, warehouseMesos: c.warehouseMesos || 0,
          map: c.map, mapName: catalog.mapsById[String(c.map)] || c.map,
          auto: !!c.auto, until: c.until || null, settingsSlot: Number(c.settingsSlot) || 1,
          hp: c.hp, maxhp: c.maxhp, mp: c.mp, maxmp: c.maxmp, kills: c.kills || 0,
          // 楓幣收入：遊戲主控台的「累計賺得」和本次掛機報告（賺了多少、掛了多久），中控算每小時楓幣用
          earned: Number(c.earned) || 0,
          session: (r => r && typeof r === 'object' ? { money: Number(r.money) || 0, xp: Number(r.xp) || 0, activeMs: Number(r.activeMs) || 0, startedAt: r.startedAt || null, updatedAt: r.updatedAt || null, stoppedAt: r.stoppedAt || null } : null)(c.sessionReport),
          hpItem: sup.hpItem ? itemInfo(sup.hpItem).name : null, hpQty: sup.hpItem ? (inv[sup.hpItem] || 0) : null,
          mpItem: sup.mpItem ? itemInfo(sup.mpItem).name : null, mpQty: sup.mpItem ? (inv[sup.mpItem] || 0) : null,
          stats: c.stats || {},
          gearBagCount: (c.equipmentBag || []).length,
          itemStackCount: (c.inventoryStacks || []).length,
        },
        autoSell: (() => { const a = c.autoSell && c.autoSell.maps; const x = a && a[c.map]; return x ? { map: c.map, enabled: !!x.enabled, itemIds: (x.itemIds || []).slice(0, 400) } : { map: c.map, enabled: false, itemIds: [] }; })(),
        // 所有地圖的自動販售設定（你在遊戲裡手動設過的），給派工看板匯入當範本
        autoSellAll: (() => { const a = (c.autoSell && c.autoSell.maps) || {}; const o = {}; for (const [m, x] of Object.entries(a).slice(0, 60)) if (x) o[m] = { enabled: !!x.enabled, itemIds: (x.itemIds || []).slice(0, 400) }; return o; })(),
        points: (() => { const v = state.cashPoints != null ? state.cashPoints : (c.cashPoints != null ? c.cashPoints : c.points); return typeof v === 'number' ? v : (v && typeof v.balance === 'number' ? v.balance : undefined); })(),
        idleOffline: trackOffline() ? { since: offlineSince } : undefined,
        // 隊伍：只留中控用得到的欄位。以前整包（含隊伍聊天 messages，最多 40 則約 4.5KB）超過 8000 字就整個丟掉，
        // 4 人隊＋聊天紀錄一定超過 → 中控以為大家都是單人，打王只有勾的那隻去（v0.54.1 修正）
        party: (() => { try {
          const p = state.party;
          const mem = m => m && { id: m.id, name: m.name, lv: m.lv, job: m.job, map: m.map, auto: m.auto, hp: m.hp, maxhp: m.maxhp, leader: !!m.leader, self: !!m.self };
          return { party: p ? { code: p.code || null, leader: p.leader || null, members: (Array.isArray(p.members) ? p.members : []).slice(0, 12).map(mem).filter(Boolean) } : null,
            invites: Array.isArray(state.partyInvites) ? state.partyInvites.length : 0, accountParty: state.accountParty || null };
        } catch (_) { return undefined; } })(),
        knowledge: (() => { const k = lastKnowledge || state.knowledge; return k ? { ready: !!k.ready, remaining: k.remaining,
          round: k.round ? { index: k.round.index, done: !!k.round.done, correct: k.round.correct } : null, dbg: { why: quizDbg.why, err: quizDbg.err, step: quizDbg.step, ticks: quizDbg.ticks } } : undefined; })(),
        gear, items,
      };
    }

    function setBadge(status, text) {
      if (!document.body) return;
      let el = document.getElementById('szg-hub-badge');
      if (!el) {
        el = document.createElement('div');
        el.id = 'szg-hub-badge';
        el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;font:12px sans-serif;padding:3px 8px;border-radius:10px;opacity:.9;pointer-events:none;color:#fff;max-width:340px';
        document.body.appendChild(el);
      }
      if (dupTab && !text) { el.textContent = '⚠ 這隻角色已經在另一個分頁開著：這個分頁先不執行中控工作（關掉其中一個就好）'; el.style.background = '#8a2b2b'; return; }
      if (text) { el.textContent = text; el.style.background = '#7a5a12'; return; }
      if (agentBusy) return; // 交易進行中時保留交易狀態文字
      if (status === 'ok') { el.textContent = '中控：已連線'; el.style.background = '#1f7a3a'; }
      else if (status === 'auth') { el.textContent = '中控：伺服器拒絕連線'; el.style.background = '#8a2b2b'; }
      else { el.textContent = '中控：連不到中控伺服器'; el.style.background = '#8a2b2b'; }
    }

    async function tick() {
      try {
        tabBeat();
        if (passive()) return;
        if (!agentBusy) await refreshOwnState(false);
        const state = readState();
        if (!state) return;
        await loadCatalog();
        try { await loadAccount(); } catch (_) {}
        const snap = buildSnapshot(state);
        const hash = JSON.stringify([snap.char, snap.playerCode, snap.eligibleKnown, snap.knowledge, snap.idleOffline, snap.party, snap.points, snap.autoSell, snap.autoSellAll, snap.gear.map(g => g.uid + g.plus + g.loc + g.locked).join('|'), snap.items.map(i => i.key + i.qty + i.loc + i.tradableQty + i.lockedQty).join('|')]);
        const now = Date.now();
        if (hash !== lastHash || now - lastSent > HEARTBEAT_MS) {
          lastHash = hash; lastSent = now;
          await hub('POST', '/api/push', snap);
        }
      } catch (e) { console.warn('[szg-hub]', e); }
    }

    // =====================================================================
    // 交易執行（只做你在面板上按過「確認執行」的工作）
    // =====================================================================
    let agentBusy = false;
    let lastJobAt = 0; // 交易／背包工作最後一次結束的時間（之後 1 分鐘內出現的裝備不自動處理）
    let agentRunning = false;
    const local = {}; // jobId -> { batchIndex, tradeId, stepAt, invites }

    function offerKey(x) {
      if (!x) return '';
      if (x.kind === 'gear' || x.kind === 'cash') return 'g:' + (x.uid || (x.gear && x.gear.uid) || (x.cash && x.cash.uid));
      return 'i:' + (x.item || x.key);
    }

    // 依目前背包重新計算這一批要放的東西（第二次檢查：鎖定、可交易清單、補給品、數量）
    function buildOffer(batch, c) {
      const locked = lockedQtyByKey(c);
      const sup = supplyKeys(c);
      const bag = new Map((c.equipmentBag || []).map(g => [g.uid, g]));
      const items = [];
      const skipped = [];
      for (const it of batch.items || []) {
        if (it.excludeSupply !== false && sup.has(it.key) && it.qty === 'ALL') { skipped.push(it.name + '（補給中）'); continue; }
        const can = itemTradableQty(c, it.key, locked);
        const MAX_PER_SLOT = 9999; // 交易每格最多 9999 個，超過的由後面的批次處理
        const qty = Math.min(MAX_PER_SLOT, it.qty === 'ALL' ? can : Math.min(Number(it.qty) || 0, can));
        if (qty > 0) items.push({ kind: 'item', item: it.key, qty });
        else skipped.push(it.name);
        if (it.qty !== 'ALL' && can < Number(it.qty)) skipped.push(`${it.name} 只剩 ${can}`);
      }
      for (const g of batch.gear || []) {
        const cur = bag.get(g.uid);
        if (!cur || !gearTradable(cur)) { skipped.push(g.name + (cur ? '（已鎖定）' : '（不在背包）')); continue; }
        items.push({ kind: 'gear', uid: g.uid, qty: 1 });
      }
      let money = 0;
      if (batch.money === 'ALL') {
        // 保留 keepPct% 給分身自己買水，其餘扣掉 5% 手續費後轉出
        const keep = Math.min(100, Math.max(0, Number(batch.keepPct) || 0));
        const avail = (c.money || 0) * (1 - keep / 100);
        money = Math.max(0, Math.floor(avail / 1.05) - 1000);
      }
      else if (batch.money) money = Math.min(Number(batch.money) || 0, Math.floor((c.money || 0) / 1.05));
      return { offer: { money, points: 0, items: items.slice(0, 20) }, skipped };
    }

    // 收貨方核對：對方放的東西必須都在這一批的預期清單內
    function verifyIncoming(batch, theirOffer) {
      const allowed = new Map();
      for (const it of batch.items || []) allowed.set('i:' + it.key, it.qty === 'ALL' ? Infinity : Number(it.qty));
      for (const g of batch.gear || []) allowed.set('g:' + g.uid, 1);
      for (const x of (theirOffer && theirOffer.items) || []) {
        const k = offerKey(x);
        if (!allowed.has(k)) return '對方放了不在清單內的東西：' + (x.name || k);
        if ((x.qty || 1) > allowed.get(k)) return '數量超過預期：' + (x.name || k);
      }
      const m = (theirOffer && theirOffer.money) || 0;
      if (batch.money !== 'ALL' && m > (Number(batch.money) || 0)) return '楓幣超過預期';
      if ((theirOffer && theirOffer.points) > 0) return '對方放了點數，與清單不符';
      return null;
    }

    // 收貨方：遊戲裡已經有某帳號的邀請時，問伺服器能不能改成先處理那個帳號的工作
    async function claimIncomingInvite(job, t) {
      try {
        if (!t) { const s = await game({ type: 'sync', tradeOnly: true }); t = s && s.trade; }
        if (!t || t.status !== 'invited' || !t.sides) return false;
        const inviter = t.sides[1 - t.self];
        if (!inviter || !inviter.code || inviter.code === account.playerCode) return false;
        const r = await hub('POST', '/api/agent/claim', { code: account.playerCode, inviterCode: inviter.code });
        return !!(r && r.ok);
      } catch (_) { return false; }
    }
    async function report(job, ev) {
      try { await hub('POST', '/api/agent/report', { jobId: job.id, batchIndex: job.batchIndex, ...ev }); } catch (_) {}
    }


    // ---------- 背包操作：賣出／鎖定／解鎖 ----------
    // 在回應裡找報價單（有 id 與 rows 的物件）
    // 安全報價（2026-11-20 讀遊戲程式碼＋實測）：報價單存在 character.inventoryQuote（{id, category, rows:[{uid, kind, key, name, qty, price}], total, expiresAt}），
    // 賣完也不會清掉。背包剛好在變動（掛機撿東西、堆疊合併）時送出的 id 對不上，遊戲可能不產生新報價，回應裡還是「上一張」報價單 →
    // 以前會拿到舊的那張（項目比選的多）而停止。這裡確認是「剛產生的新報價」、每一列都是選到的東西，不對就重新同步再試一次。
    async function safeQuote(charId, category, ids) {
      const want = new Set(ids);
      let lastErr = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        let before = '';
        try { const s0 = await gameRetry({ type: 'sync', characterId: charId }); before = (s0 && s0.character && s0.character.inventoryQuote && s0.character.inventoryQuote.id) || ''; } catch (_) {}
        const qr = await gameRetry({ type: 'inventoryQuote', category, ids, characterId: charId });
        const q = (qr && qr.character && qr.character.inventoryQuote && Array.isArray(qr.character.inventoryQuote.rows) ? qr.character.inventoryQuote : null) || findQuote(qr);
        if (!q || !q.id) { lastErr = '取得報價失敗'; await sleepP(1500); continue; }
        if (q.id === before || (q.category && q.category !== category)) { lastErr = '拿到的是舊的報價單（背包剛好在變動）'; await sleepP(2000); continue; }
        const extra = q.rows.filter(r => r.uid ? !want.has(r.uid) : false);
        // 有沒選到的東西：可能同一隻角色剛好在做別的賣出（另一張報價單），等一下重新報價；第二次還是這樣才停
        if (extra.length) { lastErr = `報價單裡有沒有選到的東西（${extra.slice(0, 5).map(r => r.name || r.key).join('、')}${extra.length > 5 ? '…' : ''}），為了安全沒有賣`; await sleepP(2500); continue; }
        if (q.rows.some(r => !r.uid) && q.rows.length > ids.length) return { error: `報價單有 ${q.rows.length} 項，比選擇的 ${ids.length} 項多，已停止` };
        const got = new Set(q.rows.map(r => r.uid).filter(Boolean));
        return { q, missing: ids.filter(u => got.size && !got.has(u)).length };
      }
      return { error: lastErr + '，重試後還是不行，請稍後再按重試' };
    }
    function findQuote(o, depth = 0) {
      if (!o || typeof o !== 'object' || depth > 4) return null;
      if (o.id && Array.isArray(o.rows)) return o;
      for (const v of Object.values(o)) { const q = findQuote(v, depth + 1); if (q) return q; }
      return null;
    }
    // ---------- 遊戲的「離線掛機」（60 分鐘沒操作會暫停畫面更新，點一下繼續才領回累積的經驗／楓幣／掉落） ----------
    const isIdleOffline = () => !!document.getElementById('idleOffline');
    let offlineSince = 0;
    function trackOffline() {
      if (isIdleOffline()) { if (!offlineSince) offlineSince = GM_getValue(ck('offlineSince'), 0) || Date.now(); GM_setValue(ck('offlineSince'), offlineSince); }
      else if (offlineSince) { offlineSince = 0; GM_setValue(ck('offlineSince'), 0); }
      return offlineSince;
    }
    // 幫忙按「點一下繼續」，等遊戲把最新資料同步回來
    async function wakePage(why) {
      if (!isIdleOffline()) return false;
      const before = sessionStorage.getItem('mapleSessionView') || '';
      const btn = document.getElementById('idleOfflineResume') || document.getElementById('idleOffline');
      if (!btn) return false;
      setBadge(null, '離線掛機：自動按「繼續」領取…');
      btn.click();
      for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); if (!isIdleOffline() && (sessionStorage.getItem('mapleSessionView') || '') !== before) break; }
      await new Promise(r => setTimeout(r, 1500));
      trackOffline();
      const st = readState();
      hub('POST', '/api/idle-log', { charId: st && st.character && st.character.id, msg: `${why}，已按「繼續」領取離線掛機的收益` }).catch(() => {});
      lastHash = ''; // 下次立刻回報最新資料
      return true;
    }

    const sleepP = ms => new Promise(r => setTimeout(r, ms));
    // 很多帳號同時動作時遊戲常回「存檔忙碌」：多等幾次、每次隨機錯開
    async function gameRetry(action) {
      for (let i = 0; ; i++) {
        try { return await game(action); }
        catch (e) { if (i >= 6 || !/忙碌|稍後重試|稍後再試|busy/i.test(e.message)) throw e; await sleepP(2500 + Math.random() * 3000 + i * 1500); }
      }
    }

    // ---------- 掛機控制 ----------
    const IDLE_LABEL = { start: '開始掛機', stop: '暫停掛機', restart: '重新開始掛機', switch: '切換角色', wake: '領取離線收益', map: '換地圖', autosell: '套用自動販售' };
    async function idleAction(charId, action) {
      if (action === 'restart') {
        await game({ type: 'stop', characterId: charId });
        await new Promise(r => setTimeout(r, 1500));
        await game({ type: 'start', characterId: charId });
      } else {
        await game({ type: action, characterId: charId });
      }
    }
    async function runIdleJob(job) {
      const done = [], failed = [];
      let switchTo = null;
      const oldChar = myChar();
      // 掛機指令先做，切換角色放最後（切換後頁面要重新整理）
      const targets = ((job.batches[0] && job.batches[0].targets) || []).slice().sort((a, b) => (a.action === 'switch') - (b.action === 'switch'));
      for (const t of targets) {
        if (t.action === 'map') {
          try {
            setBadge(null, `${t.name}：前往 ${t.mapName || t.map}…`);
            await gameRetry({ type: 'map', map: t.map, characterId: t.charId });
            done.push(`${t.name} 前往 ${t.mapName || t.map}`);
            if (t.sell) {
              await new Promise(r => setTimeout(r, 1200));
              try { await gameRetry({ type: 'autoSell', characterId: t.charId, map: t.map, config: t.sell }); done.push(`${t.name} 套用自動販售（${t.sell.enabled ? t.sell.itemIds.length + ' 項' : '關閉'}）`); }
              catch (e) { failed.push(`${t.name} 套用自動販售（${e.message}）`); }
            }
          } catch (e) { failed.push(`${t.name} 前往 ${t.mapName || t.map}（${e.message}）`); }
          continue;
        }
        if (t.action === 'autosell') {
          try {
            setBadge(null, `${t.name}：套用自動販售…`);
            await gameRetry({ type: 'autoSell', characterId: t.charId, map: t.map, config: t.sell });
            done.push(`${t.name} 在 ${t.mapName || t.map} 的自動販售已更新（${t.sell.enabled ? t.sell.itemIds.length + ' 項' : '關閉'}）`);
          } catch (e) { failed.push(`${t.name} 自動販售（${/所在地/.test(e.message) ? '角色已不在這張地圖' : e.message}）`); }
          continue;
        }
        if (t.action === 'wake') {
          try { done.push((await wakePage('從面板要求')) ? `${t.name} 已領取離線收益` : `${t.name} 不在離線掛機狀態`); } catch (e) { failed.push(`${t.name} 領取（${e.message}）`); }
          continue;
        }
        if (t.action === 'switch') {
          try {
            // 畫面上是這隻、而且遊戲伺服器記的「目前角色」也是這隻才算已切好（同帳號開兩個分頁時，伺服器記的可能是另一隻）
            accountAt = 0; await loadAccount().catch(() => null);
            const srvActive = account && account.activeCharacterId;
            if (sessionStorage.getItem('mapleCharacter') === t.charId && (!srvActive || srvActive === t.charId)) { done.push(`${t.name} 已經是目前角色`); continue; }
            setBadge(null, `切換到 ${t.name}…`);
            await game({ type: 'switch', characterId: t.charId });
            switchTo = t.charId;
            done.push(`已切換到 ${t.name}`);
          } catch (e) { failed.push(`切換到 ${t.name}（${e.message}）`); }
          continue;
        }
        try {
          setBadge(null, `${t.name}：${IDLE_LABEL[t.action]}…`);
          await idleAction(t.charId, t.action);
          done.push(`${t.name} ${IDLE_LABEL[t.action]}`);
        } catch (e) { failed.push(`${t.name}（${e.message}）`); }
      }
      if (done.length) await report(job, { event: 'log', msg: '完成：' + done.join('、') });
      if (failed.length) await report(job, { event: 'error', msg: '失敗：' + failed.join('、') });
      else await report(job, { event: 'batchDone' });
      if (switchTo) {
        // 讓遊戲頁面以新角色重新載入（跟遊戲內「切換」一樣的結果）。
        // 遊戲每次同步完會把 mapleCharacter 寫回「畫面上的角色」，重新整理前剛好同步一次就會切回舊角色：
        // 這段期間擋掉遊戲寫回舊角色，離開頁面時再寫一次，然後立刻重新整理
        const pin = () => { try { sessionStorage.setItem('mapleCharacter', switchTo); sessionStorage.removeItem('mapleSessionView'); } catch (_) {} };
        try {
          const SP = (W.Storage || Storage).prototype, orig = SP.setItem, ss = W.sessionStorage;
          SP.setItem = function (k, v) { if (this === ss && k === 'mapleCharacter' && v !== switchTo) return; return orig.call(this, k, v); };
        } catch (_) {}
        try { W.addEventListener('pagehide', pin); } catch (_) {}
        pin();
        setBadge(null, '已切換角色，重新整理頁面…');
        // 告訴中控：這個分頁不再負責舊角色（不然要等 90 秒才知道），並放掉舊角色的分頁標記
        try { GM_setValue(tabKey(oldChar), { page: PAGE_ID, at: 0 }); } catch (_) {}
        await hub('POST', '/api/agent/leave', { code: account && account.playerCode, charId: oldChar, page: PAGE_ID }).catch(() => {});
        setTimeout(() => location.reload(), 50);
      }
    }

    // 自動規則（每 30 秒）：
    //  - 掛滿 N 小時自動暫停（N=0 代表不限）
    //  - 自動續掛：到期前 M 分鐘重新開始；已經到期停掉的自動開始。從面板手動暫停的不會被重新開始。
    const H = 3600 * 1000, IDLE_CAP = 24 * H;
    // 死掉自動原地復活（2026-11-21 讀遊戲程式碼）：死亡＝character.hp <= 0，畫面跳「原地復活／暫時等待」；
    // 原地復活＝{type:'revive'}。遊戲自己的自動復活（{type:'autoRevive', config:{enabled, max}}）每輪預設只有 3 次，用完就停在死亡畫面。
    // 每次死亡扣本級升級經驗 5%，所以每隻每小時最多復活 N 次（預設 6），超過就停下來讓你處理（地圖可能太難）
    const reviveAt = {};
    async function reviveTick(state, p, excluded) {
      const c = state.character, cands = [];
      if (Number(c.hp) <= 0) cands.push({ id: c.id, name: c.name, own: true });
      for (const sib of state.characters || []) {
        if (sib.id === c.id || otherTabHas(sib.id)) continue;
        if (sib.hp != null ? Number(sib.hp) <= 0 : !sib.auto) cands.push({ id: sib.id, name: sib.name, check: sib.hp == null });
      }
      const max = Math.max(1, Number(p.reviveMaxPerHour) || 6);
      for (const x of cands) {
        if (excluded[x.id] || Date.now() - (reviveAt[x.id] || 0) < (x.check ? 120000 : 45000)) continue;
        reviveAt[x.id] = Date.now();
        if (x.check) { // 背景角色只知道沒在掛機：同步一次確認是不是死了
          try { const j = await gameRetry({ type: 'sync', characterId: x.id }); if (!(j && j.character && j.character.id === x.id && Number(j.character.hp) <= 0)) continue; } catch (_) { continue; }
        }
        const key = 'revives:' + x.id, list = (GM_getValue(key, []) || []).filter(t => Date.now() - t < H);
        if (list.length >= max) {
          if (Date.now() - (Number(GM_getValue('reviveLimit:' + x.id, 0)) || 0) > H) {
            GM_setValue('reviveLimit:' + x.id, Date.now());
            await hub('POST', '/api/idle-log', { charId: x.id, kind: 'reviveLimit', msg: `一小時內已經自動復活 ${list.length} 次（上限 ${max} 次），這次先不復活（地圖可能太難，請換圖或調整）` }).catch(() => {});
          }
          continue;
        }
        try {
          const j = await gameRetry({ type: 'revive', characterId: x.id });
          list.push(Date.now()); GM_setValue(key, list);
          let started = '';
          const ch = j && j.character;
          if (ch && ch.id === x.id && !ch.auto) { try { await gameRetry({ type: 'start', characterId: x.id }); started = '並重新開始掛機'; } catch (_) {} }
          if (x.own) { try { const dd = document.getElementById('deathDialog'); if (dd && dd.open) dd.close(); } catch (_) {} lastHash = ''; }
          await hub('POST', '/api/idle-log', { charId: x.id, kind: 'revive', msg: `角色死亡，已自動原地復活${started}（這小時第 ${list.length} 次，每次扣本級經驗 5%）` }).catch(() => {});
        } catch (e) { await hub('POST', '/api/idle-log', { charId: x.id, msg: '自動原地復活失敗：' + e.message }).catch(() => {}); }
      }
    }
    async function idleTick() {
      try {
        if (passive()) return;
        const state = readState();
        if (!state || !account || !account.playerCode) return;
        // 先記下同帳號其他角色目前是否在掛機（不論規則有沒有開，才看得出「從掛機變成停止」）
        const sibPrev = {};
        for (const sib of state.characters || []) {
          if (sib.id === state.character.id) continue;
          sibPrev[sib.id] = GM_getValue('sibAuto:' + sib.id, null);
          GM_setValue('sibAuto:' + sib.id, !!sib.auto);
        }
        const r = await hub('GET', '/api/idle-policy');
        const p = r.policy, excluded = r.excluded || {}, last = r.last || {};
        const since = trackOffline();
        if (p.wakeHours > 0 && since && Date.now() - since >= p.wakeHours * H) await wakePage(`離線掛機已 ${p.wakeHours} 小時`);
        if (p.autoRevive) await reviveTick(state, p, excluded);
        if (!p.autoRenew && !p.stopAfterHours) return;
        const skew = (state.serverTime || Date.now()) - Date.now();
        const now = Date.now() + skew;
        const recent = (id, ms) => { const t = GM_getValue('idleAuto:' + id, 0); return Date.now() - t < ms; };
        const mark = id => GM_setValue('idleAuto:' + id, Date.now());
        const panelStopped = id => last[id] && last[id].action === 'stop' && last[id].by === 'panel';
        const act = async (id, name, action, why) => {
          if (recent(id, 5 * 60 * 1000)) return; // 同一隻 5 分鐘內最多自動處理一次
          mark(id);
          try { await idleAction(id, action); await hub('POST', '/api/idle-log', { charId: id, action, msg: `${why}，已自動${IDLE_LABEL[action]}` }); }
          catch (e) { await hub('POST', '/api/idle-log', { charId: id, msg: `自動${IDLE_LABEL[action]}失敗：${e.message}` }).catch(() => {}); }
        };
        // 目前角色：有完整的到期時間
        const c = state.character;
        if (!excluded[c.id]) {
          const startedAt = c.until ? c.until - IDLE_CAP : null;
          if (p.stopAfterHours > 0 && c.auto && startedAt && now >= startedAt + p.stopAfterHours * H) {
            await act(c.id, c.name, 'stop', `已掛滿 ${p.stopAfterHours} 小時`);
          } else if (p.autoRenew && !p.stopAfterHours) {
            if (c.auto && c.until && c.until - now < p.renewBeforeMin * 60 * 1000) await act(c.id, c.name, 'restart', `剩不到 ${p.renewBeforeMin} 分鐘到期`);
            else if (!c.auto && c.until && c.until <= now && !panelStopped(c.id)) await act(c.id, c.name, 'start', '掛機已到期');
          }
        }
        // 同帳號的其他角色：只知道是否在掛機，看到「從掛機變成停止」而且不是從面板暫停的，就重新開始
        for (const sib of state.characters || []) {
          if (sib.id === c.id) continue;
          if (otherTabHas(sib.id)) continue; // 它有自己的分頁，由那個分頁處理
          const prev = sibPrev[sib.id];
          if (excluded[sib.id] || !p.autoRenew || p.stopAfterHours) continue;
          if (prev === true && !sib.auto && !panelStopped(sib.id)) await act(sib.id, sib.name, 'start', '掛機已停止（可能到期）');
        }
      } catch (e) { console.warn('[szg-hub idle]', e); }
    }

    // ---------- 撿到裝備自動處理 ----------
    // 背包「新出現」的裝備：符合規則對象卻不符合保留條件 → 試跑只記錄／自動賣出
    // 一律不動：已鎖定、強化過、衝過卷；交易／背包工作進行中或剛結束 1 分鐘內出現的
    const COND_OPS_FN = { '>': (v, t) => v > t, '>=': (v, t) => v >= t, '<': (v, t) => v < t, '<=': (v, t) => v <= t, '=': (v, t) => v === t, '≠': (v, t) => v !== t };
    // 浮動判斷（跟面板「部位設定」同一套預設；面板改過的由 /api/autosell 帶 rollProfiles 過來）
    let ROLLP = {};
    const RW_PHYS = ['sword', 'twoSword', 'axe', 'twoAxe', 'mace', 'twoMace', 'spear', 'polearm', 'bow', 'crossbow', 'claw', 'dagger', 'knuckle', 'gun'];
    function rollProf(t) {
      const p = ROLLP[t]; if (p && Array.isArray(p.stats)) return { stats: p.stats, min: Number(p.min) || 0 };
      if (t === 'wand' || t === 'staff') return { stats: ['incMAD'], min: 1 };
      if (RW_PHYS.includes(t)) return { stats: ['incPAD'], min: 1 };
      return { stats: ['incSTR', 'incDEX', 'incINT', 'incLUK'], min: 1 };
    }
    function rollScore(g) {
      if (!g.baseStats || !g.cleanStats) return null;
      return rollProf(g.gtype || g.weaponType || g.slot || '').stats.reduce((t, s) => t + (Number(g.cleanStats[s]) || 0) - (Number(g.baseStats[s]) || 0), 0);
    }
    function condVal(g, k) {
      const st = g.stats || {};
      if (k === '_rollScore') { const sc = rollScore(g); return sc == null ? -999 : sc; }
      if (k === '_rollOk') { const sc = rollScore(g); return sc != null && sc >= rollProf(g.gtype || g.weaponType || g.slot || '').min ? 1 : 0; }
      if (k === '_sum4') return (st.incSTR || 0) + (st.incDEX || 0) + (st.incINT || 0) + (st.incLUK || 0);
      if (k === '_plus') return g.plus || 0;
      if (k === '_slotsLeft') return g.slotsLeft || 0;
      if (k === '_maxSlots') return g.maxSlots || 0;
      if (k === '_reqLevel') return g.reqLevel || 0;
      return st[k] || 0;
    }
    function condsPass(g, conds) {
      const valid = (conds || []).filter(c => c.val !== '' && c.val != null && COND_OPS_FN[c.op]);
      if (!valid.length) return null;
      const groups = [[]];
      valid.forEach((c, i) => { if (i > 0 && c.join === 'or') groups.push([]); groups[groups.length - 1].push(c); });
      return groups.some(gr => gr.every(c => COND_OPS_FN[c.op](condVal(g, c.stat), Number(c.val))));
    }
    function ruleTargets(r, g) {
      if (r.slots && r.slots.length && !r.slots.includes(g.slot)) return false;
      if (r.nameInc && !String(g.name).includes(r.nameInc)) return false;
      if (r.jobs && r.jobs.length && !r.jobs.some(b => b === 0 ? g.reqJob === 0 : (g.reqJob & b))) return false;
      return true;
    }
    function sellRuleFor(g, rules) {
      const hits = (rules || []).filter(r => r.on !== false && ruleTargets(r, g) && (r.sellAll || condsPass(g, r.conds) !== null));
      if (!hits.length) return null;
      if (hits.some(r => !r.sellAll && condsPass(g, r.conds))) return null;
      return hits[0];
    }
    const STAT_SHORT = { incPAD: '物攻', incMAD: '魔攻', incSTR: '力', incDEX: '敏', incINT: '智', incLUK: '幸', incPDD: '物防', incMDD: '魔防', incACC: '命中', incEVA: '迴避', incMHP: 'HP', incMMP: 'MP', incSpeed: '速度', incJump: '跳躍' };
    const statText = g => Object.entries(g.stats || {}).filter(([, v]) => v).map(([k, v]) => (STAT_SHORT[k] || k) + v).join(' ');
    let asRunning = false;
    async function autoSellTick() {
      if (asRunning || passive()) return;
      asRunning = true;
      try {
        const state = readState();
        if (!state || !state.character || !catalog) return;
        const c = state.character;
        const key = 'gearSeen:' + c.id;
        const bag = c.equipmentBag || [];
        const cur = bag.map(g => g.uid);
        const seen = GM_getValue(key, null);
        if (!Array.isArray(seen)) { GM_setValue(key, cur); return; } // 第一次：現有的全部當作看過
        const seenSet = new Set(seen);
        const fresh = bag.filter(g => !seenSet.has(g.uid));
        if (!fresh.length) { if (seen.length > cur.length + 100) GM_setValue(key, cur); return; }
        if (agentBusy) return; // 交易／背包工作中先不處理，等結束
        const markAll = () => GM_setValue(key, [...new Set([...cur])]);
        if (Date.now() - lastJobAt < 60 * 1000) { markAll(); return; }
        const cfg = await hub('GET', '/api/autosell?v=' + AGENT_VERSION);
        ROLLP = cfg.rollProfiles || {};
        if (cfg.mode === 'off' || !cfg.chars || !cfg.chars[c.id]) { markAll(); return; }
        const log = msg => hub('POST', '/api/gear-log', { charId: c.id, msg }).catch(() => {});
        const pick = [];
        for (const raw of fresh) {
          const g = gearRow(raw, '背包');
          if (g.locked || g.plus > 0 || (raw.slots || 0) < (raw.maxSlots || 0)) continue;
          const r = sellRuleFor(g, cfg.rules);
          if (r) pick.push({ raw, g, r });
        }
        markAll(); // 不論成功與否，同一件只判斷一次
        if (!pick.length) return;
        const desc = pick.map(x => `${x.g.name}（${statText(x.g) || '無素質'}｜${x.r.name || '規則'}）`).join('、');
        if (cfg.mode !== 'sell') { await log(`試跑：會賣掉 ${pick.length} 件：${desc}`); return; }
        // 賣之前再確認一次：還在背包、沒被鎖
        const now = readState(); const nowBag = new Map(((now && now.character && now.character.equipmentBag) || []).map(g => [g.uid, g]));
        const ids = pick.map(x => x.raw.uid).filter(u => nowBag.has(u) && !nowBag.get(u).locked);
        if (!ids.length) return;
        setBadge(null, `自動賣出 ${ids.length} 件裝備…`);
        const sq = await safeQuote(now.character.id, 'equip', ids);
        if (sq.error) { await log('自動賣出取消：' + sq.error); return; }
        const q = sq.q;
        await game({ type: 'inventorySell', quoteId: q.id, characterId: now.character.id });
        await log(`自動賣出 ${q.rows.length} 件，共 ${(Number(q.total) || 0).toLocaleString()} 楓幣：${desc}`);
      } catch (e) {
        console.warn('[szg-hub autosell]', e);
        hub('POST', '/api/gear-log', { msg: '自動處理出錯：' + e.message }).catch(() => {});
      } finally { asRunning = false; setTimeout(() => setBadge('ok'), 3000); }
    }

    // ---------- 自由市場 ----------
    //  - 掃描：中控排好要查的道具，一次只交給一個頁面；用市場搜尋（依單價由低到高）抓前幾頁
    //  - 攤位：定時回報自己攤位的商品、待領收益、成交紀錄；可自動領收益
    //  - 自動上架：照中控算好的計畫上架（試跑模式只記錄）
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    function mktCat(key) {
      const it = (catalog && catalog.items[key]) || {};
      const prefix = Math.floor((it.id || 0) / 1000000);
      if (it.type === '消耗' || it.type === '卷軸' || it.use || prefix === 2) return 'consume';
      if (prefix === 3) return 'setup';
      if (prefix === 5) return 'cash';
      return 'etc';
    }
    async function marketSync(extra) {
      const j = await game({ type: 'sync', marketOnly: true, includeMarket: true, tradeOnly: false, marketQuery: '', marketPage: 0, marketStall: null, marketCategory: 'all', marketMode: 'browse', ...extra });
      return j && j.market;
    }
    let mktBusy = false;
    // 市場（掃描、攤位、自動上架）是整個帳號的事：同帳號開了兩個分頁時只由其中一個（優先看得到的那個）負責
    async function amLeader() {
      if (passive()) return false;
      const code = account && account.playerCode; if (!code) return false;
      const k = 'lead:' + code, now = Date.now();
      const v = GM_getValue(k, null);
      const mine = v && v.page === PAGE_ID;
      const stale = !v || now - v.at > (v.hidden ? 100000 : 30000);
      const steal = v && !mine && v.hidden && !document.hidden;
      if (!mine && !stale && !steal) return false;
      GM_setValue(k, { page: PAGE_ID, at: now, hidden: document.hidden });
      if (mine) return true;
      await sleep(400 + Math.random() * 400); // 兩個分頁同時搶：等一下再確認誰的寫入留下來
      const w = GM_getValue(k, null);
      return !!(w && w.page === PAGE_ID);
    }
    async function marketScanTick() {
      if (mktBusy || agentBusy || !(await amLeader())) return;
      const state = readState(); if (!state || !state.character || !account) return;
      mktBusy = true;
      try {
        const charId = state.character.id;
        const { items } = await hub('POST', '/api/market/claim', { charId });
        if (!items || !items.length) return; // finally 會放開 mktBusy
        const results = [];
        for (const it of items) {
          if (agentBusy) break;
          const products = []; let more = false;
          for (let page = 0; page < 3; page++) {
            const m = await marketSync({ marketMode: 'search', marketQuery: it.q, marketPage: page });
            const ps = (m && m.products) || [];
            products.push(...ps);
            more = !!(m && m.productsHasMore);
            const hits = products.filter(p => it.key ? p.key === it.key : p.name === it.gear).length;
            // 找到 10 筆以上同物品、或沒有下一頁就停；搜尋結果依單價排序，前面幾頁就是最便宜的
            if (!more || hits >= 10) break;
            await sleep(1200);
          }
          results.push({ ...it, products, more });
          await sleep(1500);
        }
        if (results.length) await hub('POST', '/api/market/report', { charId, results });
      } catch (e) { console.warn('[szg-hub market scan]', e); }
      finally { mktBusy = false; }
    }

    let lastStallAt = 0;
    async function stallTick(force) {
      // 攤位每 5 分鐘回報一次（testStallMs 只給自動測試縮短用）
      if (agentBusy || (!force && Date.now() - lastStallAt < (Number(GM_getValue('testStallMs', 0)) || 5 * 60 * 1000))) return null;
      if (!(await amLeader())) return null;
      const state = readState(); if (!state || !state.character || !account) return null;
      lastStallAt = Date.now();
      const charId = state.character.id;
      const m = await marketSync({});
      if (!m) return null;
      const mine = m.mine;
      const stall = mine ? { exists: true, open: !!mine.open, title: mine.title, count: mine.count || (mine.listings || []).length, proceeds: mine.proceeds || 0,
        listings: (mine.listings || []).map(l => ({ id: l.id, kind: l.kind, key: l.key, uid: l.uid || (l.gear && l.gear.uid) || '', name: l.name, qty: l.qty, price: l.price })), history: mine.history || [] } : { exists: false };
      const r = await hub('POST', '/api/market/stall', { charId, stall });
      if (mine && r && Array.isArray(r.delist) && r.delist.length) await delistOverdue(charId, r.delist);
      if (mine && mine.proceeds > 0 && r && r.autoClaim) {
        try { await game({ type: 'marketClaim', characterId: charId }); await hub('POST', '/api/market/log', { charId, msg: `已領取攤位收益 ${Number(mine.proceeds).toLocaleString()} 楓幣` }); }
        catch (e) { await hub('POST', '/api/market/log', { charId, msg: '領取收益失敗：' + e.message }).catch(() => {}); }
      }
      return m;
    }

    // 逾時下架：中控算好哪些商品放太久沒賣出，這裡用 marketCancel 取回到這隻角色的背包
    async function delistOverdue(charId, rows) {
      const log = msg => hub('POST', '/api/market/log', { charId, msg }).catch(() => {});
      const done = [], failed = [];
      let bag = null;
      try { const j = await game({ type: 'sync', characterId: charId }); bag = new Set(((j.character || {}).equipmentBag || []).map(g => g.uid)); } catch (_) {}
      for (const r of rows) {
        if (agentBusy) break;
        try {
          const j = await gameRetry({ type: 'marketCancel', listingId: r.id, characterId: charId });
          // 裝備取回後的 uid：比對下架前後的背包（商品資料不一定帶 uid）
          const now = ((j && j.character) || {}).equipmentBag;
          if (r.kind === 'gear' && Array.isArray(now) && bag) { const nu = now.map(g => g.uid).find(u => !bag.has(u)); if (nu) r.uid = nu; bag = new Set(now.map(g => g.uid)); }
          done.push(r);
          await sleep(1000);
        } catch (e) { failed.push(`${r.name}（${e.message}）`); }
      }
      if (done.length) {
        await hub('POST', '/api/market/delisted', { charId, rows: done }).catch(() => {});
        await log('逾時下架：' + done.map(r => `${r.name}×${r.qty}（放了 ${r.hours} 小時）`).join('、') + '，已取回背包，之後不再自動上架');
        lastStallAt = 0; lastHash = '';
      }
      if (failed.length) await log('逾時下架失敗：' + failed.join('、'));
    }

    let lastPlanHash = '';
    async function autoListTick() {
      for (let i = 0; i < 20 && mktBusy; i++) await sleep(3000); // 掃描中就等它做完，不要整輪跳過
      if (mktBusy || agentBusy || !(await amLeader())) return;
      const state = readState(); if (!state || !state.character || !account || !catalog) return;
      mktBusy = true;
      const charId = state.character.id;
      const log = msg => hub('POST', '/api/market/log', { charId, msg }).catch(() => {});
      try {
        const p = await hub('GET', '/api/market/plan?charId=' + encodeURIComponent(charId));
        if (!p || p.mode === 'off' || !p.enabled) return;
        if (!p.entries.length) { lastPlanHash = ''; return; }
        const hash = JSON.stringify(p.entries.map(e => [e.key || e.uid, e.qty, e.price]));
        if (p.mode === 'preview') {
          if (hash !== lastPlanHash) await log('試跑：會上架 ' + p.entries.map(e => `${e.name}×${e.qty} @${e.price.toLocaleString()}（${e.why}）`).join('、'));
          lastPlanHash = hash; return;
        }
        // 自動上架：離線掛機中先領回收益，再拿最新的攤位與可上架清單
        if (isIdleOffline()) await wakePage('自動上架前');
        let m = await stallTick(true);
        if (!m) return;
        if (!m.mine) {
          const title = (state.character.name + '的小攤').slice(0, 24);
          await game({ type: 'marketConfig', title, open: true, characterId: charId });
          await log(`還沒有攤位，已自動開設「${title}」`);
          await sleep(1000);
          m = await marketSync({});
          if (!m || !m.mine) { await log('開設攤位失敗，先停止上架'); return; }
        }
        let room = 50 - ((m.mine.listings || []).length);
        const inv = (m.sellInventory && m.sellInventory.inventory) || {};
        const eItems = new Set(m.eligibleItems || []), eGear = new Set(m.eligibleGear || []);
        const done = [], skipped = [];
        for (const e of p.entries) {
          if (room <= 0) { skipped.push(e.name + '（攤位已滿 50 件）'); continue; }
          if (agentBusy) break;
          try {
            if (e.kind === 'item') {
              const have = Math.min(Number(inv[e.key]) || 0, (state.character.inventory || {})[e.key] || 0);
              const qty = Math.min(e.qty, have, 9999);
              if (!eItems.has(e.key) || qty <= 0) { skipped.push(e.name + '（遊戲判定不可上架）'); continue; }
              await game({ type: 'marketList', kind: 'item', category: mktCat(e.key), item: e.key, qty, price: e.price, characterId: charId });
              done.push(`${e.name}×${qty} @${e.price.toLocaleString()}`);
            } else {
              if (!eGear.has(e.uid)) { skipped.push(e.name + '（遊戲判定不可上架）'); continue; }
              await game({ type: 'marketList', kind: 'gear', category: 'equip', uid: e.uid, qty: 1, price: e.price, characterId: charId });
              done.push(`${e.name} @${e.price.toLocaleString()}`);
            }
            room--;
            await sleep(1200);
          } catch (err) { skipped.push(`${e.name}（${err.message}）`); }
        }
        if (done.length) await log('已上架：' + done.join('、'));
        if (skipped.length) await log('略過：' + skipped.join('、'));
        if (done.length) { lastStallAt = 0; await stallTick(true).catch(() => {}); } // 回報最新攤位
      } catch (e) { console.warn('[szg-hub autolist]', e); log('自動上架出錯：' + e.message); }
      finally { mktBusy = false; }
    }

    // ---------- 知識王 ----------
    //  - 不管是你手動作答還是自動作答，答完都會看到正確答案（綠框），一律回報到中控題庫
    //  - 面板開啟「自動作答」時：題庫有答案就直接答；遇到題庫沒有的題目就停下來（作答不限時），
    //    把題目送到面板讓你選答案，選完之後會自動接著答
    const qnorm = s => String(s || '').replace(/[\s　]+/g, '').replace(/[「」『』《》〈〉？?！!。，,、：:；;（）()【】"'“”‘’…·．.]/g, '').toLowerCase();
    const learnedSent = new Set();
    function learnFrom(j) {
      const f = j && j.knowledge && j.knowledge.round && j.knowledge.round.feedback;
      if (!f || !f.text || !Array.isArray(f.options) || typeof f.correctIndex !== 'number' || !f.options[f.correctIndex]) return;
      const key = qnorm(f.text) + '|' + f.correctIndex;
      if (learnedSent.has(key)) return;
      learnedSent.add(key);
      const c = readState() && readState().character;
      hub('POST', '/api/quiz/learn', { q: f.text, options: f.options, answer: f.options[f.correctIndex], charId: c && c.id,
        by: c && c.name, correct: f.selected === f.correctIndex }).catch(() => {});
    }
    // 監看頁面自己的作答請求（你手動作答時也能學）
    (function hookKnowledge() {
      try {
        if (!W || W.__szgKnowHook) return;
        W.__szgKnowHook = true;
        const orig = W.fetch;
        W.fetch = function (input, init) {
          const p = orig.apply(this, arguments);
          try {
            const body = init && typeof init.body === 'string' ? init.body : '';
            if (body.indexOf('"knowledgeAnswer"') >= 0) p.then(r => r.clone().json()).then(learnFrom).catch(() => {});
          } catch (_) {}
          return p;
        };
      } catch (e) { console.warn('[szg-hub] knowledge hook failed', e); }
    })();

    // ---------- 實戰 DPS：旁聽頁面自己的同步回應，統計自己帳號角色打出的傷害（不額外發送任何請求） ----------
    const DPS_BUCKET = 60 * 1000, DPS_KEEP = 60;          // 每分鐘一格，保留 60 分鐘
    const dpsData = {};                                    // charId → { since, buckets: Map(minute → agg), seen: Set }
    function dpsAgg() { return { dmg: 0, eff: 0, attacks: 0, lines: 0, crits: 0, maxLine: 0, kills: 0, dot: 0, skills: {}, mobs: {} }; }
    function dpsIngest(json) {
      const sum = json && json.summary;
      const evs = sum && Array.isArray(sum.events) ? sum.events : null;
      if (!evs || !evs.length) return;
      const st = readState();
      const mine = new Set((st && st.characters || []).map(c => c.id));
      if (st && st.character) mine.add(st.character.id);
      for (const e of evs) {
        if (!e || !mine.has(e.actor)) continue;
        if (e.kind && !['attack', 'burn', 'poison'].includes(e.kind)) continue;
        const d = dpsData[e.actor] || (dpsData[e.actor] = { since: 0, buckets: new Map(), seen: new Set(), map: '' });
        const id = e.eventId || (e.instanceId + ':' + e.order);
        if (d.seen.has(id)) continue;
        d.seen.add(id); if (d.seen.size > 5000) d.seen = new Set([...d.seen].slice(-2500));
        const at = Number(e.at) || Date.now();
        if (!d.since || at < d.since) d.since = at;
        const k = Math.floor(at / DPS_BUCKET);
        let b = d.buckets.get(k); if (!b) { b = dpsAgg(); d.buckets.set(k, b); }
        const dmg = Number(e.damage) || 0, eff = Number(e.effectiveDamage != null ? e.effectiveDamage : e.damage) || 0;
        b.dmg += dmg; b.eff += eff;
        if (e.kind === 'burn' || e.kind === 'poison') b.dot += dmg;
        else {
          b.attacks++;
          const lines = Array.isArray(e.lines) && e.lines.length ? e.lines : [{ damage: dmg, critical: false }];
          b.lines += lines.length;
          for (const l of lines) { if (l.critical) b.crits++; if ((Number(l.damage) || 0) > b.maxLine) b.maxLine = Number(l.damage) || 0; }
        }
        if (e.killed) b.kills++;
        const sk = e.kind === 'burn' || e.kind === 'poison' ? 'dot:' + (e.skill || '') : String(e.skill || 0);
        b.skills[sk] = (b.skills[sk] || 0) + dmg;
        if (e.mob) b.mobs[e.mob] = (b.mobs[e.mob] || 0) + 1;
        if (e.map) d.map = e.map;
      }
      const cut = Math.floor(Date.now() / DPS_BUCKET) - DPS_KEEP;
      for (const d of Object.values(dpsData)) for (const k of d.buckets.keys()) if (k < cut) d.buckets.delete(k);
    }
    // 某段時間內的統計；時間長度只算有在記錄的部分（剛打開分頁時不會被低估）
    function dpsWindow(d, ms) {
      const now = Date.now(), from = Math.max(now - ms, d.since || now);
      // 連續 3 分鐘以上完全沒有資料（分頁關掉、離線掛機暫停同步）不算進時間，避免 DPS 被低估
      let span = 0, gap = 0;
      for (let k = Math.floor(from / DPS_BUCKET); k <= Math.floor(now / DPS_BUCKET); k++) {
        const start = Math.max(from, k * DPS_BUCKET), end = Math.min(now, (k + 1) * DPS_BUCKET), len = Math.max(0, end - start);
        if (d.buckets.has(k)) { span += len + (gap < 3 * DPS_BUCKET ? gap : 0); gap = 0; } else gap += len;
      }
      if (gap < 3 * DPS_BUCKET) span += gap;
      span = Math.max(1000, span);
      const a = dpsAgg();
      for (const [k, b] of d.buckets) {
        if ((k + 1) * DPS_BUCKET <= from) continue;
        a.dmg += b.dmg; a.eff += b.eff; a.attacks += b.attacks; a.lines += b.lines; a.crits += b.crits; a.kills += b.kills; a.dot += b.dot;
        if (b.maxLine > a.maxLine) a.maxLine = b.maxLine;
        for (const [s, v] of Object.entries(b.skills)) a.skills[s] = (a.skills[s] || 0) + v;
        for (const [m, v] of Object.entries(b.mobs)) a.mobs[m] = (a.mobs[m] || 0) + v;
      }
      return { span, ...a };
    }
    async function dpsReport() {
      if (passive()) return;
      const ids = Object.keys(dpsData);
      if (!ids.length) return;
      const cat = await loadCatalog().catch(() => null);
      const sname = k => { if (k.startsWith('dot:')) { const n = cat && cat.skillNames[k.slice(4)]; return (n || '燃燒／中毒') + '（持續）'; } return k === '0' ? '普通攻擊' : (cat && cat.skillNames[k]) || ('技能 ' + k); };
      const pack = w => ({ span: w.span, dps: Math.round(w.dmg / (w.span / 1000)), effDps: Math.round(w.eff / (w.span / 1000)), dmg: w.dmg, eff: w.eff, attacks: w.attacks, lines: w.lines, crits: w.crits, maxLine: w.maxLine, kills: w.kills, dot: w.dot });
      for (const id of ids) {
        const d = dpsData[id];
        const w5 = dpsWindow(d, 5 * 60 * 1000), w60 = dpsWindow(d, 60 * 60 * 1000);
        if (!w60.dmg) continue;
        const skills = Object.entries(w60.skills).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ name: sname(k), dmg: v }));
        const mobs = Object.entries(w60.mobs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => ({ name: (cat && cat.mobNames[k]) || k, n: v }));
        const series = [];
        const nowK = Math.floor(Date.now() / DPS_BUCKET);
        for (let k = nowK - 59; k <= nowK; k++) { const b = d.buckets.get(k); if ((k + 1) * DPS_BUCKET > d.since) series.push(b ? Math.round(b.dmg / 60) : 0); }
        await hub('POST', '/api/dps', { charId: id, at: Date.now(), since: d.since, map: d.map, w5: pack(w5), w60: pack(w60), skills, mobs, series }).catch(() => {});
      }
    }
    // ---------- 掉落紀錄：從同步回應的冒險紀錄抓「撿取」「自動販售」，給工廠圖做掉落動畫（不額外發請求） ----------
    const lootSeen = new Set(), lootQueue = [];
    let lootStart = Date.now();
    function lootIngest(json) {
      const c = json && json.character; if (!c || !Array.isArray(c.log)) return;
      const st = readState(); const mine = new Set((st && st.characters || []).map(x => x.id)); if (st && st.character) mine.add(st.character.id);
      if (!mine.has(c.id)) return;
      const sold = new Set();
      const rows = [];
      for (const e of c.log) {
        if (!e || !e.t || !e.time || e.time < lootStart - 5000) continue;
        const key = c.id + '|' + e.time + '|' + e.t;
        if (lootSeen.has(key)) continue;
        let m = /^自動販售：(.+?) × (\d+)，獲得 ([\d,]+) 楓幣/.exec(e.t);
        if (m) { lootSeen.add(key); sold.add(e.time + '|' + m[1]); rows.push({ at: e.time, name: m[1], qty: Number(m[2]), sold: true, money: Number(m[3].replace(/,/g, '')) }); continue; }
        m = /^撿取：(.+?) × (\d+)/.exec(e.t);
        if (m) { lootSeen.add(key); rows.push({ at: e.time, name: m[1], qty: Number(m[2]), sold: false }); }
      }
      // 同一時間撿到又馬上自動賣掉的，只算賣掉
      for (const r of rows) if (r.sold || !sold.has(r.at + '|' + r.name)) lootQueue.push({ charId: c.id, map: c.map, ...r });
      if (lootSeen.size > 4000) { const keep = [...lootSeen].slice(-2000); lootSeen.clear(); keep.forEach(k => lootSeen.add(k)); }
      if (lootQueue.length > 300) lootQueue.splice(0, lootQueue.length - 300);
    }
    setInterval(() => { if (!lootQueue.length) return; const batch = lootQueue.splice(0, lootQueue.length); hub('POST', '/api/loot', { events: batch }).catch(() => {}); }, 3000);
    (function hookDps() {
      try {
        if (!W || W.__szgDpsHook) return;
        W.__szgDpsHook = true;
        const orig = W.fetch;
        W.fetch = function (input, init) {
          const p = orig.apply(this, arguments);
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.indexOf('/api/game') >= 0) p.then(r => r.clone().json()).then(j => { dpsIngest(j); try { lootIngest(j); } catch (_) {} }).catch(() => {});
          } catch (_) {}
          return p;
        };
      } catch (e) { console.warn('[szg-hub] dps hook failed', e); }
    })();

    let quizRunning = false;
    let lastKnowledge = null, lastKnowledgeDay = '', lastKnowledgeChar = '', lastQuizSyncAt = 0, lastQuizErr = { msg: '', at: 0 }, waitingQ = null;
    const quizDbg = { step: '', at: 0, err: '', ticks: 0, why: '' }; let quizErrAt = 0;
    const qstep = st => { quizDbg.step = st; quizDbg.at = Date.now(); };
    async function quizTick() {
      if (quizRunning) { if (Date.now() - quizDbg.at > 5 * 60 * 1000) { quizDbg.err = '卡在 ' + quizDbg.step + ' 超過 5 分鐘，重設'; quizRunning = false; } return; }
      if (passive()) return;
      quizDbg.ticks++;
      // 只在真的有交易／背包工作時讓路（agentRunning 只是每 3 秒查一次工作，背景分頁會跟這裡同時醒來）
      if (agentBusy) { quizDbg.why = '交易/背包工作中'; return; }
      quizRunning = true; qstep('開始'); quizDbg.why = ''; if (Date.now() - quizErrAt > 30 * 60 * 1000) quizDbg.err = '';
      try {
        const state = readState();
        if (!state || !state.character) return;
        qstep('讀題庫');
        const cfg = await hub('GET', '/api/quiz');
        const charId = state.character.id;
        const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣時間午夜重置
        if (lastKnowledgeDay !== today || lastKnowledgeChar !== charId) { lastKnowledge = null; lastKnowledgeDay = today; lastKnowledgeChar = charId; }
        // 沒開自動作答：只偶爾同步一次讓面板顯示剩餘次數；今天次數已用完：到午夜前都不再同步，減少對遊戲伺服器的請求
        if (!cfg.auto) { quizDbg.why = '未開啟'; if (lastKnowledge && Date.now() - lastQuizSyncAt < 15 * 60 * 1000) return; }
        else if (lastKnowledge && lastKnowledge.remaining === 0 && (!lastKnowledge.round || lastKnowledge.round.done)) { quizDbg.why = '今日次數用完'; return; }
        // 正在等你在面板作答：題庫還沒有答案就不用一直同步（最多 10 分鐘確認一次題目還在）
        if (cfg.auto && waitingQ && waitingQ.char === charId && cfg.answers[waitingQ.k] == null && Date.now() - waitingQ.at < 10 * 60 * 1000) { quizDbg.why = waitingQ.why; return; }
        waitingQ = null;
        qstep('同步');
        lastQuizSyncAt = Date.now();
        let j = await gameRetry({ type: 'sync', characterId: charId });
        let k = j && j.knowledge;
        if (k) lastKnowledge = k;
        qstep('已同步');
        if (!cfg.auto || !k || !k.ready) { quizDbg.why = !cfg.auto ? '未開啟' : !k ? '同步沒有知識王資料' : '知識王未開放'; return; }
        const log = msg => hub('POST', '/api/quiz/log', { charId, msg }).catch(() => {});
        // 同一個帳號開了兩個分頁：一次只讓一個分頁作答（知識王若是整個帳號共用一輪，兩邊同時答會互相打亂）
        const qlk = 'quizLock:' + ((account && account.playerCode) || charId);
        const holdQuiz = () => { const v = GM_getValue(qlk, null); if (v && v.page !== PAGE_ID && Date.now() - v.at < 2 * 60 * 1000) return false; GM_setValue(qlk, { page: PAGE_ID, at: Date.now() }); return true; };
        if (!holdQuiz()) { quizDbg.why = '同帳號另一個分頁正在作答'; return; }
        quizLockHeld = qlk;
        let waitNext = 0;
        for (let guard = 0; guard < 40; guard++) {
          if (!holdQuiz()) { quizDbg.why = '同帳號另一個分頁正在作答'; return; }
          const r = k.round;
          if (!r || r.done) {
            if (!(k.remaining > 0)) { quizDbg.why = '今日次數用完'; return; }
            setBadge(null, `知識王：開始新一輪（今日剩 ${k.remaining} 次）`);
            qstep('開新一輪');
            j = await gameRetry({ type: 'knowledgeStart', characterId: charId });
            k = j.knowledge; if (k) lastKnowledge = k; await log(`開始新一輪（今日剩 ${k && k.remaining}）`);
            continue;
          }
          const q = r.question;
          if (!q) {
            // 剛作答完，遊戲可能先顯示對錯、過一下才給下一題
            if (++waitNext > 8) { quizDbg.err = '等不到下一題：' + JSON.stringify({ i: r.index, done: r.done, fb: !!r.feedback, keys: Object.keys(r) }).slice(0, 150); return; }
            qstep('等下一題'); await new Promise(res => setTimeout(res, 2500));
            j = await gameRetry({ type: 'sync', characterId: charId }); k = j.knowledge; if (k) lastKnowledge = k; continue;
          }
          waitNext = 0;
          const ans = cfg.answers[qnorm(q.text)];
          const idx = ans == null ? -1 : q.options.findIndex(o => qnorm(o) === qnorm(ans));
          if (idx < 0) {
            quizDbg.why = '等你作答第 ' + (r.index + 1) + ' 題';
            waitingQ = { char: charId, k: qnorm(q.text), at: Date.now(), why: quizDbg.why };
            await hub('POST', '/api/quiz/unknown', { q: q.text, options: q.options, charId });
            setBadge(null, `知識王：第 ${r.index + 1} 題題庫沒有，等你在面板選答案`);
            return;
          }
          setBadge(null, `知識王：第 ${r.index + 1} 題 → ${q.options[idx]}`);
          qstep('作答 ' + (r.index + 1));
          j = await gameRetry({ type: 'knowledgeAnswer', round: r.id, index: r.index, answer: idx, characterId: charId });
          learnFrom(j);
          const f = j.knowledge && j.knowledge.round && j.knowledge.round.feedback;
          if (f && typeof f.correctIndex === 'number' && f.selected !== f.correctIndex) await log(`答錯：${q.text}（選 ${q.options[idx]}，正解 ${f.options[f.correctIndex]}），已更正題庫`);
          k = j.knowledge; if (k) lastKnowledge = k;
          if (k && k.round && k.round.done) await log(`本輪結束：答對 ${k.round.correct}/5`);
        }
      } catch (e) {
        console.warn('[szg-hub quiz]', e); quizDbg.err = e.message + '@' + quizDbg.step; quizErrAt = Date.now();
        // 同樣的錯誤 10 分鐘內只記一次，免得紀錄被洗版
        if (e.message !== lastQuizErr.msg || Date.now() - lastQuizErr.at > 10 * 60 * 1000) {
          lastQuizErr = { msg: e.message, at: Date.now() };
          const st = readState();
          hub('POST', '/api/quiz/log', { charId: st && st.character && st.character.id, msg: '自動作答出錯：' + e.message }).catch(() => {});
        }
      } finally {
        quizRunning = false; qstep('閒置');
        if (quizLockHeld) { try { const v = GM_getValue(quizLockHeld, null); if (v && v.page === PAGE_ID) GM_setValue(quizLockHeld, { page: PAGE_ID, at: 0 }); } catch (_) {} quizLockHeld = ''; }
      }
    }
    let quizLockHeld = '';

    async function runBagJob(job, state, charId) {
      if (job.kind === 'idle') return runIdleJob(job);
      if (charId !== job.fromCharId) {
        setBadge(null, `背包工作等待中：「${job.fromName}」要有自己的遊戲分頁（按右下角「＋ 開 ${job.fromName} 的分頁」，或切換過去）`);
        return report(job, { event: 'waiting', msg: `等待 ${job.fromName} 的遊戲分頁（開它自己的分頁，或切換過去）` });
      }
      const c = state.character;
      const stackOk = new Map((c.inventoryStacks || []).map(s => [s.uid, s]));
      const gearOk = new Map((c.equipmentBag || []).map(g => [g.uid, g]));
      const b = job.batches[0];
      const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      if (job.kind === 'lock' || job.kind === 'unlock') {
        const want = job.kind === 'lock';
        const ids = [...(b.items || []).flatMap(i => i.uids || []).filter(u => stackOk.has(u)), ...(b.gear || []).map(g => g.uid).filter(u => gearOk.has(u))];
        if (!ids.length) { await report(job, { event: 'log', msg: '找不到要處理的物品（可能已經不在背包）' }); return report(job, { event: 'batchDone', skippedEmpty: true }); }
        setBadge(null, `${want ? '鎖定' : '解鎖'} ${ids.length} 項…`);
        await game({ type: 'inventoryLock', ids, locked: want, batch: true, requestId: rid() });
        await report(job, { event: 'log', msg: `已${want ? '鎖定' : '解鎖'} ${ids.length} 項` });
        return report(job, { event: 'batchDone' });
      }
      if (job.kind === 'sell') {
        // 第二次檢查：已鎖定、已不在背包、補給中的道具一律不賣
        const sup = supplyKeys(c);
        const groups = {};
        const skipped = [];
        for (const it of b.items || []) {
          if (sup.has(it.key)) { skipped.push(it.name + '（補給中）'); continue; }
          // 堆疊的 uid 是流水號，掛機撿東西會新增／合併堆疊：用剛同步到的背包，依道具重新挑「這樣道具所有沒鎖的堆疊」
          const uids = (c.inventoryStacks || []).filter(st => st.key === it.key && !st.locked && st.qty > 0).map(st => st.uid);
          if (!uids.length) { skipped.push(it.name); continue; }
          (groups[it.cat || 'consume'] || (groups[it.cat || 'consume'] = [])).push(...uids);
        }
        for (const g of b.gear || []) {
          const cur = gearOk.get(g.uid);
          if (!cur || cur.locked) { skipped.push(g.name); continue; }
          (groups.equip || (groups.equip = [])).push(g.uid);
        }
        if (skipped.length) await report(job, { event: 'log', msg: '略過（已鎖定／不在背包／補給中）：' + skipped.join('、') });
        let total = 0, count = 0;
        for (const [category, ids] of Object.entries(groups)) {
          setBadge(null, `賣出 ${ids.length} 項（${category}）…`);
          const r = await safeQuote(c.id, category, ids);
          if (r.error) return report(job, { event: 'error', msg: `${r.error}（${category}）${count ? `；前面已賣出 ${count} 項，共 ${total.toLocaleString()} 楓幣` : ''}` });
          const q = r.q;
          await game({ type: 'inventorySell', quoteId: q.id, characterId: c.id, requestId: rid() });
          total += Number(q.total) || 0; count += q.rows.length;
          if (r.missing) await report(job, { event: 'log', msg: `${r.missing} 疊在報價時已經不在（可能剛被用掉或合併），略過` });
        }
        await report(job, { event: 'log', msg: `已賣出 ${count} 項，共 ${total.toLocaleString()} 楓幣` });
        return report(job, { event: 'batchDone' });
      }
      if (job.kind === 'forge') return runForgeJob(job, c);
      if (job.kind === 'guildDeposit' || job.kind === 'guildWithdraw' || job.kind === 'guildView') return runGuildJob(job, c);
      if (job.kind === 'guildSell') return runGuildSell(job, c);
      if (job.kind === 'guildMoney') return runGuildMoney(job, c);
      if (job.kind === 'boss') return runBossJob(job, c);
      if (job.kind === 'party') return runPartyJob(job, c);
      // 不認得的工作：多半是這個分頁的腳本太舊，重新整理一次拿新版（同一個工作只試一次）
      if (GM_getValue(ck('reloadForJob'), '') !== job.id) {
        GM_setValue(ck('reloadForJob'), job.id);
        await report(job, { event: 'waiting', msg: `${c.name} 的腳本不認得這種工作，重新整理頁面換新腳本…` });
        setTimeout(() => location.reload(), 1500);
        return;
      }
      return report(job, { event: 'error', msg: '未知的工作類型：' + job.kind + '（重新整理後仍然不認得，請手動重新整理遊戲分頁）' });
    }
    // ---------- 角色全身照 ----------
    // 遊戲頁面的 MapleAppearance（appearance.js）：key(角色)＝外觀簽章（URL 參數字串）；站姿 GIF 在 /api/appearance?<key>&action=stand（78×78）。
    // 外觀變了（換裝、換髮型）才重新上傳給中控（存成 data/avatars/<角色>.gif），面板的組隊卡片、流水線用
    const avatarAt = {};
    // 失敗原因回報給中控（GET /api/avatar-diag 看得到），方便查為什麼沒有全身照
    const avatarDiag = (id, step, msg) => hub('POST', '/api/avatar/diag', { charId: id, step, msg: String(msg || '').slice(0, 200) }).catch(() => {});
    async function uploadAvatar(ch) {
      const MA = W.MapleAppearance;
      if (!ch || !ch.id) return;
      if (!MA) return avatarDiag(ch.id, 'noMA', typeof W.MapleAppearance);
      let key = ''; try { key = MA.key(ch, 'attack'); } catch (e) { return avatarDiag(ch.id, 'key', e && e.message); }
      if (GM_getValue('avatarKey:' + ch.id, '') === key) return;
      // 站姿 GIF：直接跟遊戲要（appearance.js 的 fetchPart：/api/appearance?<key>&action=stand）。
      // 不讀 load() 給的 blob 網址：實機頁面的 fetch 讀 blob: 會「Failed to fetch」（v0.47.2 回報）
      let blob;
      try {
        const r = await (W.fetch || fetch).call(W, '/api/appearance?' + key + '&action=stand');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        blob = await r.blob();
      } catch (e) { return avatarDiag(ch.id, 'stand', e && e.message); }
      const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(blob); });
      if (!b64) return avatarDiag(ch.id, 'b64', blob && blob.size);
      try { await hub('POST', '/api/avatar', { charId: ch.id, key, gif: b64 }); } catch (e) { return avatarDiag(ch.id, 'post', e && e.message); }
      GM_setValue('avatarKey:' + ch.id, key);
    }
    async function avatarTick() {
      if (passive() || agentBusy) return;
      const st = readState(); if (!st || !st.character) return;
      try { await uploadAvatar(st.character); } catch (e) { console.warn('[szg-hub avatar]', e); }
      // 同帳號沒有自己分頁的角色：同步一次拿完整的角色資料（30 分鐘一次）
      for (const sib of st.characters || []) {
        if (sib.id === st.character.id || otherTabHas(sib.id) || Date.now() - (avatarAt[sib.id] || 0) < 30 * 60000) continue;
        avatarAt[sib.id] = Date.now();
        try { const j = await gameRetry({ type: 'sync', characterId: sib.id }); if (j && j.character && j.character.id === sib.id) await uploadAvatar(j.character); } catch (_) {}
      }
    }

    // ---------- 組隊（組隊分頁套用）----------
    // 要重組時：離開原本的隊伍 → 隊長 partyCreate、把隊伍代碼回報中控 → 隊員等代碼、partyJoin → 換圖（換圖會停掛機）→ 開始掛機
    async function runPartyJob(job, c) {
      const p = (job.batches[0] || {}).party || {}, id = c.id;
      const log = msg => report(job, { event: 'log', msg });
      const partyCode = j => (j && j.party && j.party.code) || '';
      try {
        if (p.ops) {
          const s0 = await gameRetry({ type: 'sync', characterId: id });
          if (partyCode(s0)) { setBadge(null, '組隊：離開原本的隊伍…'); await gameRetry({ type: 'partyLeave', characterId: id }); await log('已離開原本的隊伍'); await sleepP(800); }
          if (p.role === 'leader') {
            setBadge(null, '組隊：建立隊伍…');
            let j = await gameRetry({ type: 'partyCreate', characterId: id });
            let code = partyCode(j);
            if (!code) { await sleepP(1000); code = partyCode(await gameRetry({ type: 'sync', characterId: id })); }
            if (!code) return report(job, { event: 'error', msg: '建立隊伍後拿不到隊伍代碼' });
            await hub('POST', '/api/party/code', { runId: p.runId, code });
            await log(`已建立隊伍（代碼 ${code}）`);
          } else if (p.role === 'member') {
            let code = '';
            const t0 = Date.now();
            while (Date.now() - t0 < 150000) {
              const r = await hub('GET', '/api/party/run?id=' + encodeURIComponent(p.runId)).catch(() => null);
              if (r && r.error) return report(job, { event: 'error', msg: r.error });
              if (r && r.code) { code = r.code; break; }
              setBadge(null, `組隊：等隊長 ${p.leaderName} 建立隊伍…`);
              await sleepP(3000);
            }
            if (!code) return report(job, { event: 'error', msg: `等了 2 分半，隊長 ${p.leaderName} 還沒建好隊伍（他的遊戲分頁要開著）` });
            setBadge(null, `組隊：加入 ${p.leaderName} 的隊伍…`);
            await gameRetry({ type: 'partyJoin', code, characterId: id });
            await log(`已加入 ${p.leaderName} 的隊伍`);
          }
        }
        const s1 = await gameRetry({ type: 'sync', characterId: id });
        const here = s1 && s1.character && s1.character.map;
        let moved = false;
        if (p.map && here !== p.map) { setBadge(null, `組隊：前往 ${p.mapName}…`); await gameRetry({ type: 'map', map: p.map, characterId: id }); moved = true; await sleepP(1200); }
        // 派工看板上這張圖的自動販售範本（遊戲只接受目前所在地圖的設定，所以換圖後才套用）
        let sellMsg = '';
        if (p.map && p.sell) { try { await gameRetry({ type: 'autoSell', characterId: id, map: p.map, config: p.sell }); sellMsg = `套用自動販售（${p.sell.enabled ? p.sell.itemIds.length + ' 項' : '關閉'}），`; } catch (e) { sellMsg = `自動販售沒套用（${e.message}），`; } }
        let started = true;
        try { await gameRetry({ type: 'start', characterId: id }); } catch (_) { started = false; }
        lastHash = '';
        await log(`${moved ? `已前往 ${p.mapName}，` : ''}${sellMsg}${started ? '已開始掛機' : '開始掛機失敗，請手動開始'}`);
        return report(job, { event: 'batchDone' });
      } catch (e) {
        if (e.gameUpdated) throw e;
        return report(job, { event: 'error', msg: e.message });
      }
    }

    // ---------- 輪流打野王 ----------
    // 王的狀態：同步帶 includeBossRespawns 拿到每隻野王的 deadline／spawned／available，定時回報給中控排程
    // （只有中控設定要這隻角色打王時才查，fullSync 比一般同步重）
    let bossStateAt = 0;
    function bossRowsOf(j) {
      return (j && Array.isArray(j.bossRespawns) ? j.bossRespawns : []).map(r => ({ map: r.map, mapName: r.mapName, mob: r.mob, name: r.name, instanceId: r.instanceId, deadline: r.deadline, spawned: r.spawned, available: r.available }));
    }
    async function postBossState(charId, j) {
      if (!j || !Array.isArray(j.bossRespawns)) return;
      bossStateAt = Date.now();
      await hub('POST', '/api/boss/state', { charId, serverTime: j.serverTime, list: bossRowsOf(j) }).catch(() => {});
    }
    async function bossStateTick(force) {
      if (agentBusy || passive()) return;
      if (!force && Date.now() - bossStateAt < 4 * 60 * 1000) return;
      const id = myChar(); if (!id) return;
      const n = await hub('GET', '/api/boss/need?charId=' + encodeURIComponent(id)).catch(() => null);
      if (!n || !n.need) return;
      try { await postBossState(id, await gameRetry({ type: 'sync', fullSync: true, includeBossRespawns: true, characterId: id })); }
      catch (e) { console.warn('[szg-hub boss state]', e); }
    }
    // 打王：記住原本的地圖 → 前往首領地圖 → 每 4 秒同步看王的血條 → 打死／時間到／倒下／打不動就回原本的地圖
    // 打野王：去王的地圖開始掛機打，看血條。設定「連續打」時，打完一隻直接問中控下一隻（/api/boss/next），
    // 中控回沒有了才回原本的練功圖（使用者要求：全部刷完再回練功圖）。隊伍一起打時，中控讓同隊的人拿到同一個下一隻。
    async function runBossJob(job, c) {
      let b = (job.batches[0] || {}).boss || {};
      const id = c.id, tAll = Date.now();
      const pct = (h, m) => m > 0 ? Math.max(0, Math.round(h / m * 1000) / 10) : 0;
      const fullSync = () => gameRetry({ type: 'sync', fullSync: true, includeBossRespawns: true, characterId: id });
      // 1. 先同步一次：王的狀態、原本的地圖（用剛同步到的；頁面存的狀態可能是舊的）
      let st = await fullSync();
      await postBossState(id, st);
      const bossMaps = new Set((st.bossRespawns || []).map(r => r.map).concat(b.map));
      const now0 = (st.character && st.character.map) || c.map;
      const back = now0 && !bossMaps.has(now0) ? now0 : (b.back || '');
      const backName = (catalog && catalog.mapsById[String(back)]) || b.backName || back;
      // 掛機設定組合（遊戲的 1／2／3，{type:'settingsPreset', slot}；沒設定過＝1）：打王用一套、練功用一套
      const slot0 = Number(st.character && st.character.settingsSlot) || 1;
      let slotNow = slot0;
      const usePreset = async n => {
        n = Number(n) || 0; if (!n || n === slotNow) return '';
        try { await gameRetry({ type: 'settingsPreset', slot: n, characterId: id }); slotNow = n; return `，換成掛機設定 ${n}`; }
        catch (e) { return `（換掛機設定 ${n} 失敗：${e.message}）`; }
      };
      // 真實遊戲換地圖會停止掛機（2026-11-20 實測）：到了就重新開始掛機，角色才會打王
      const startIdle = async () => { try { await gameRetry({ type: 'start', characterId: id }); return true; } catch (e) { return false; } };
      let traveled = false; // 有離開原本的地圖才需要回去（第一隻就在冷卻、沒出發的話不動）
      const result = (r, msg, extra = {}) => hub('POST', '/api/boss/result', { charId: id, mob: b.mob, result: r, msg: `${b.name}：${msg}`, ms: extra.ms || 0, ...extra }).catch(() => {});

      // 打一隻：回傳 {result, text, hp, maxHp, inst}
      const fightOne = async () => {
        const t0 = Date.now(), maxMs = Math.max(1, Number(b.visitMax) || 20) * 60000;
        const row = ((st && st.bossRespawns) || []).find(r => r.mob === b.mob);
        const srvNow = Number(st && st.serverTime) || Date.now();
        if (row && row.available && row.deadline > srvNow) return { result: 'cooling', text: `還在冷卻，約 ${Math.ceil((row.deadline - srvNow) / 60000)} 分鐘後重生，這次不去` };
        const inst = (row && row.instanceId) || b.instanceId;
        setBadge(null, `野王：前往 ${b.mapName} 打 ${b.name}…`);
        try { await gameRetry({ type: 'map', map: b.map, characterId: id }); traveled = true; }
        catch (e) { if (e.gameUpdated) throw e; return { result: 'error', text: `前往 ${b.mapName} 失敗（${e.message}），這次不打`, inst }; }
        await sleepP(1200);
        const presetMsg = await usePreset(b.presetBoss);
        const idleOk = await startIdle();
        await report(job, { event: 'log', msg: `已前往 ${b.mapName}${presetMsg}${idleOk ? '，已開始掛機' : '（開始掛機失敗）'}（打完${b.chain ? '看還有沒有下一隻，沒有就' : ''}回 ${backName || '原地圖'}）` });
        let idleAt = Date.now();
        let cdChecked = false, seen = false, gone = 0, hp = null, maxHp = null, lowest = Infinity, dropAt = Date.now(), postAt = 0, res = '';
        while (!res) {
          await sleepP(4000);
          let j;
          try { j = await gameRetry({ type: 'sync', characterId: id }); }
          catch (e) { if (e.gameUpdated) throw e; if (Date.now() - t0 > maxMs) res = 'timeout'; continue; }
          const ch = j.character || {};
          const e = (j.enemies || []).find(x => x && x.id === b.mob);
          const killedEv = ((j.summary && j.summary.events) || []).some(ev => ev && ev.mob === b.mob && ev.killed);
          if (e) {
            seen = true; gone = 0; hp = Number(e.hp) || 0; maxHp = Number(e.maxHp) || maxHp;
            if (hp < lowest) { lowest = hp; dropAt = Date.now(); }
          } else if (seen) gone++;
          if (ch.auto === false && Date.now() - idleAt > 20000) { idleAt = Date.now(); await startIdle(); }
          if (ch.map && ch.map !== b.map) res = 'moved';
          else if (killedEv || (seen && (gone >= 2 || (e && hp <= 0)))) res = 'killed';
          else if (!seen && !cdChecked && Date.now() - t0 > 12000) {
            cdChecked = true;
            try { const s1 = await fullSync(); const r1 = (s1.bossRespawns || []).find(r => r.mob === b.mob); if (r1 && r1.available && r1.deadline > (Number(s1.serverTime) || Date.now())) res = 'killed'; } catch (_) {}
          }
          else if (!seen && Date.now() - t0 > 45000) res = 'absent';
          else if (ch.hp != null && Number(ch.hp) <= 0) res = 'dead';
          else if (Date.now() - t0 > maxMs) res = 'timeout';
          else if (seen && Date.now() - dropAt > 3 * 60000) res = 'stuck';
          if (!res && hp != null) {
            setBadge(null, `野王：${b.name} 剩 ${pct(hp, maxHp)}%`);
            hub('POST', '/api/boss/hp', { charId: id, instanceId: inst, mob: b.mob, hp, maxHp }).catch(() => {});
            if (Date.now() - postAt > 30000) { postAt = Date.now(); await report(job, { event: 'log', msg: `${b.name} 血量 ${pct(hp, maxHp)}%` }); }
          }
        }
        // 一直沒看到王：可能在第一次同步前就被打死了 → 王的狀態變成冷卻中就算打死
        if (res === 'absent') {
          try { const s1 = await fullSync(); const r1 = (s1.bossRespawns || []).find(r => r.mob === b.mob); if (r1 && r1.available && r1.deadline > (Number(s1.serverTime) || Date.now())) res = 'killed'; } catch (_) {}
        }
        // 打死了＝下次重生是滿血；其他情況記住剩下的血量（遊戲會保留）
        await hub('POST', '/api/boss/hp', { charId: id, instanceId: inst, mob: b.mob, hp: res === 'killed' ? null : hp, maxHp }).catch(() => {});
        const mins = Math.max(1, Math.round((Date.now() - t0) / 60000));
        const left = hp != null && maxHp ? `（王剩 ${pct(hp, maxHp)}%，血量會保留）` : '';
        const text = {
          killed: `打死了，花了約 ${mins} 分鐘`, timeout: `打了 ${mins} 分鐘還沒打死${left}`, dead: `角色倒下${left}`,
          absent: '到了地圖但王不在場上', stuck: `3 分鐘內血量都沒有下降，先放棄${left}`, moved: '中途被換到別的地圖，停止',
        }[res] || res;
        return { result: res, text, hp, maxHp, inst, ms: Date.now() - t0 };
      };

      // 2. 一隻接一隻打
      const killed = [];
      let r, n = 0, posted = false;
      for (;;) {
        n++; posted = false;
        r = await fightOne();
        if (r.result === 'killed') killed.push(b.name);
        if (r.result === 'dead') { try { await gameRetry({ type: 'revive', characterId: id }); } catch (_) {} }
        // 更新王的狀態（下一隻用最新的冷卻判斷）
        try { st = await fullSync(); await postBossState(id, st); } catch (_) { st = null; }
        const cont = b.chain && !['moved', 'dead', 'error'].includes(r.result) && n < 30;
        let nx = null;
        if (cont) {
          await result(r.result, r.text, { hp: r.hp, maxHp: r.maxHp, ms: r.ms }); posted = true;
          try { nx = await hub('POST', '/api/boss/next', { jobId: job.id, charId: id, prev: r.inst || b.instanceId || '', mob: b.mob }); } catch (_) {}
        }
        if (!nx || !nx.boss) break;
        await report(job, { event: 'log', msg: `${b.name}：${r.text}；接著去 ${nx.boss.mapName} 打 ${nx.boss.name}` });
        b = { ...b, ...nx.boss };
      }

      // 3. 回原本的地圖（中途被你換走的就不動）
      let backMsg = '';
      if (!traveled) backMsg = '';
      else if (r.result !== 'moved' && back) {
        let backOk = false;
        try { await gameRetry({ type: 'map', map: back, characterId: id }); backOk = true; }
        catch (e1) {
          try { await gameRetry({ type: 'escapeBoss', characterId: id }); await sleepP(1500); await gameRetry({ type: 'map', map: back, characterId: id }); backOk = true; }
          catch (e2) { backMsg = `，回 ${backName} 失敗（${e2.message}），請手動換圖`; }
        }
        if (backOk) { await sleepP(1200); const pm = await usePreset(b.presetTrain || slot0); backMsg = `，已回到 ${backName}${pm}` + ((await startIdle()) ? '並開始掛機' : '（開始掛機失敗，請手動開始）'); }
      } else if (r.result !== 'moved') { const pm = await usePreset(b.presetTrain || slot0); await startIdle(); backMsg = `，不知道原本的地圖，留在原地繼續掛機${pm}`; }
      lastHash = '';
      if (!traveled && r.result !== 'error') backMsg = '';
      const sum = n > 1 ? `（這一輪連續打了 ${n} 隻，打死 ${killed.length} 隻，共 ${Math.max(1, Math.round((Date.now() - tAll) / 60000))} 分鐘）` : '';
      const lastTold = b.chain && traveled && !['moved', 'dead', 'error'].includes(r.result);
      if (lastTold) await hub('POST', '/api/boss/result', { charId: id, mob: b.mob, logOnly: true, msg: `沒有下一隻了，回練功圖${backMsg.replace(/^，/, '：')}${sum}` }).catch(() => {});
      else if (!posted) await result(r.result, r.text + backMsg + sum, { hp: r.hp, maxHp: r.maxHp, ms: r.ms });
      await report(job, { event: 'log', msg: (lastTold ? `${b.name}：${r.text}；沒有下一隻了` : `${b.name}：${r.text}`) + backMsg + sum });
      return report(job, { event: 'batchDone' });
    }

    // ---------- 強化工坊：用神匠之魂（artisanScroll）批次衝卷 ----------
    // 遊戲規則：每衝 1 次扣 1 張卷軸＋10 萬楓幣（失敗也扣格）；一次最多 10 件，多件時要「名稱相同、剩餘次數相同、沒鎖定」；
    // 單件 {uid}、多件 {uids}；結果在 character.lastArtisan。這裡另外用衝之前／之後的裝備狀態算每件的結果，不依賴結果格式
    const FORGE_FEE = 100000;
    async function runForgeJob(job, c) {
      const b = job.batches[0] || {}, f = b.forge || {};
      const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      if (f.guild && ((f.guild.scrollQty || 0) > 0 || (f.guild.gearUids || []).length)) {
        const rows = [];
        if (f.guild.scrollQty > 0) rows.push({ kind: 'item', item: f.item, qty: f.guild.scrollQty });
        for (const uid of f.guild.gearUids || []) rows.push({ kind: 'gear', uid });
        setBadge(null, '強化工坊：從公會倉庫領出卷軸／裝備…');
        try {
          for (let i = 0; i < rows.length; i += 100) {
            const j = await gameRetry({ type: 'guildWarehouseBatch', op: 'withdraw', items: rows.slice(i, i + 100), characterId: c.id, requestId: rid() });
            postGuild(j, c);
            if (j && j.character && j.character.id === c.id) c = j.character;
          }
          await report(job, { event: 'log', msg: `已從公會倉庫領出：${[f.guild.scrollQty ? (f.itemName || f.item) + ' ×' + f.guild.scrollQty : '', (f.guild.gearUids || []).length ? (f.guild.gearUids.length + ' 件裝備') : ''].filter(Boolean).join('、')}` });
        } catch (e) { return report(job, { event: 'error', msg: '從公會倉庫領取失敗：' + e.message }); }
      }
      const gearOf = ch => new Map([...Object.values(ch.gear || {}).filter(Boolean), ...(ch.equipmentBag || [])].map(g => [g.uid, g]));
      const results = [], skipped = [];
      let fee = 0, stop = '';
      for (const grp of b.groups || f.groups || []) {
        if (stop) break;
        const cur = gearOf(c);
        // 第二次檢查：還在、沒鎖定、剩餘次數跟試跑時一樣
        const ok = grp.uids.filter(u => { const g = cur.get(u); if (!g) { skipped.push(u + '（找不到）'); return false; } if (g.locked) { skipped.push(g.name + '（已鎖定）'); return false; } if ((g.slots || 0) !== grp.slots) { skipped.push(g.name + '（剩餘次數變了）'); return false; } return true; });
        if (!ok.length) continue;
        const count = Math.min(10, grp.slots, f.count === 'all' ? grp.slots : Number(f.count) || 1);
        const have = (c.inventory || {})[f.item] || 0;
        if (have < ok.length) { stop = `卷軸不夠（剩 ${have} 張）`; break; }
        if ((c.money || 0) < FORGE_FEE * ok.length) { stop = '楓幣不夠'; break; }
        const before = new Map(ok.map(u => [u, { ...cur.get(u) }]));
        setBadge(null, `強化工坊：${before.get(ok[0]).name} ×${ok.length}，每件最多 ${count} 次…`);
        const action = { type: 'artisanScroll', item: f.item, count, stopAfterSuccesses: Number(f.stopAfter) || 0, expectedSlots: grp.slots, stopOnFail: !!f.stopOnFail, characterId: c.id, requestId: rid() };
        if (ok.length === 1) action.uid = ok[0]; else action.uids = ok;
        let j;
        try { j = await gameRetry(action); }
        catch (e) { stop = '遊戲拒絕：' + e.message; break; }
        const after = j && j.character && j.character.id === c.id ? j.character : null;
        if (!after) { stop = '遊戲沒有回傳角色資料，停止（請到遊戲裡確認結果）'; break; }
        const now = gearOf(after);
        const la = after.lastArtisan || null;
        ok.forEach((u, i) => {
          const g0 = before.get(u), g1 = now.get(u), it = la && la.multi ? (la.items || [])[i] : la;
          const destroyed = !g1;
          const succ = destroyed ? ((it && it.successes) || 0) : (g1.successes || 0) - (g0.successes || 0);
          const att = destroyed ? ((it && (it.attempts || []).length) || 1) : (g0.slots || 0) - (g1.slots || 0);
          fee += att * FORGE_FEE;
          const gain = {};
          if (!destroyed) for (const k of new Set([...Object.keys(g0.stats || {}), ...Object.keys(g1.stats || {})])) { const v = (Number((g1.stats || {})[k]) || 0) - (Number((g0.stats || {})[k]) || 0); if (v) gain[k] = v; }
          results.push({ uid: u, name: g0.name, attempts: att, successes: succ, destroyed, slotsLeft: destroyed ? 0 : g1.slots, plus: destroyed ? 0 : g1.successes, pass: !destroyed && (g1.successes || 0) >= (Number(f.minSucc) || 0), gain, stats: destroyed ? null : g1.stats });
        });
        c = after;
        await sleepP(800);
      }
      const pass = results.filter(r => r.pass).length, lost = results.filter(r => r.destroyed).length;
      hub('POST', '/api/forge/result', { jobId: job.id, charId: c.id, charName: c.name, item: f.item, itemName: f.itemName, minSucc: Number(f.minSucc) || 0, results, fee, stop }).catch(() => {});
      if (skipped.length) await report(job, { event: 'log', msg: '略過：' + skipped.join('、') });
      const dist = {}; for (const r of results) if (!r.destroyed) dist[r.plus] = (dist[r.plus] || 0) + 1;
      const distTxt = Object.keys(dist).map(Number).sort((a, b) => b - a).map(k => `+${k} ×${dist[k]}`).join('、');
      await report(job, { event: 'log', msg: `衝了 ${results.length} 件：${distTxt}${lost ? `、消失 ${lost} 件` : ''}；及格 ${pass} 件；共 ${results.reduce((t, r) => t + r.attempts, 0)} 次、花費 ${fee.toLocaleString()} 楓幣${stop ? '；' + stop + '，提前停止' : ''}` });
      if (!results.length && stop) return report(job, { event: 'error', msg: stop });
      return report(job, { event: 'batchDone' });
    }
    // ---------- 公會倉庫：存入、領取、查看 ----------
    // 遊戲格式：guildWarehouseBatch {op, items:[{kind:'item', item, qty} | {kind:'gear', uid}]}，一次最多 100 項；回應在 summary.guildWarehouse
    // 楓幣、點數是另外的指令，這裡一律不碰
    const GUILD_MAX = 100;
    function postGuild(j, c) {
      const g = j && j.summary && j.summary.guildWarehouse;
      if (!g) return;
      hub('POST', '/api/guild', { charId: c && c.id, charName: c && c.name, data: g }).catch(() => {});
    }
    async function runGuildJob(job, c) {
      const b = job.batches[0] || {};
      if (job.kind === 'guildView') {
        setBadge(null, '讀取公會倉庫…');
        const j = await gameRetry({ type: 'guildWarehouseView', characterId: c.id });
        if (!(j && j.summary && j.summary.guildWarehouse)) return report(job, { event: 'error', msg: '遊戲沒有回傳公會倉庫內容（可能還沒加入公會）' });
        postGuild(j, c);
        const g = j.summary.guildWarehouse;
        await report(job, { event: 'log', msg: `${g.guildName || '公會倉庫'}：道具 ${Object.keys(g.items || {}).length} 種、裝備 ${(g.gear || []).length} 件` });
        return report(job, { event: 'batchDone' });
      }
      const rows = [], skipped = [];
      if (job.kind === 'guildDeposit') {
        // 第二次檢查：還在背包、沒鎖定、可交易、不是補給中的道具；數量不超過目前可用的
        const locked = lockedQtyByKey(c), sup = supplyKeys(c);
        const bag = new Map((c.equipmentBag || []).map(g => [g.uid, g]));
        for (const it of b.items || []) {
          if (sup.has(it.key)) { skipped.push(it.name + '（補給中）'); continue; }
          const can = itemTradableQty(c, it.key, locked);
          const qty = Math.min(Number(it.qty) || 0, can);
          if (qty > 0) rows.push({ kind: 'item', item: it.key, qty, name: it.name });
          else skipped.push(it.name + '（沒有可存的數量）');
        }
        for (const g of b.gear || []) {
          const cur = bag.get(g.uid);
          if (!cur) skipped.push(g.name + '（不在背包）');
          else if (!gearTradable(cur)) skipped.push(g.name + '（已鎖定或不可交易）');
          else rows.push({ kind: 'gear', uid: g.uid, name: g.name });
        }
      } else {
        for (const it of b.items || []) if (Number(it.qty) > 0) rows.push({ kind: 'item', item: it.key, qty: Number(it.qty), name: it.name });
        for (const g of b.gear || []) rows.push({ kind: 'gear', uid: g.uid, name: g.name });
      }
      if (skipped.length) await report(job, { event: 'log', msg: '略過：' + skipped.join('、') });
      if (!rows.length) { await report(job, { event: 'log', msg: '沒有可以處理的物品' }); return report(job, { event: 'batchDone', skippedEmpty: true }); }
      const op = job.kind === 'guildDeposit' ? 'deposit' : 'withdraw', label = op === 'deposit' ? '存入' : '領取';
      // 遊戲伺服器對單次請求另有上限（實測 98 種、一萬多張卷軸會回「請求過大」，門檻不明）：
      // 被拒就把這一批切半重送；只剩一種道具還太大時，把數量切半
      let done = 0, size = GUILD_MAX, halvings = 0;
      const queue = rows.slice();
      while (queue.length) {
        const chunk = queue.slice(0, size);
        setBadge(null, `公會倉庫${label} ${done + chunk.length}/${done + queue.length}…`);
        try {
          const j = await gameRetry({ type: 'guildWarehouseBatch', op, items: chunk.map(({ name, ...x }) => x), characterId: c.id });
          postGuild(j, c);
        } catch (e) {
          if (/過大|too large/i.test(e.message) && halvings < 40) {
            halvings++;
            if (chunk.length > 1) { size = Math.max(1, Math.floor(chunk.length / 2)); continue; }
            const r = chunk[0];
            if (r.kind === 'item' && r.qty > 1) { const half = Math.floor(r.qty / 2); queue.splice(0, 1, { ...r, qty: half }, { ...r, qty: r.qty - half }); continue; }
          }
          if (done) await report(job, { event: 'log', msg: `已${label} ${done} 批` });
          return report(job, { event: 'error', msg: `${label}失敗：${e.message}` });
        }
        queue.splice(0, chunk.length); done += chunk.length;
        if (queue.length) await sleepP(1200);
      }
      if (halvings) await report(job, { event: 'log', msg: `遊戲限制單次請求大小，分成較小的批次送出（每批最多 ${size} 項）` });
      const names = rows.map(r => r.name + (r.kind === 'item' ? ' ×' + r.qty : ''));
      await report(job, { event: 'log', msg: `已${label} ${rows.length} 項：${names.slice(0, 30).join('、')}${names.length > 30 ? '…' : ''}` });
      return report(job, { event: 'batchDone' });
    }
    // 公倉楓幣／點數：遊戲格式 {type:'guildWarehouseMesos'|'guildWarehouseCash', op:'deposit'|'withdraw', amount, characterId}
    // 金錢動作不自動重試（避免回應遺失時重複執行）；先讀一次公倉，存入檢查身上夠、提領檢查公倉夠，做完比對公倉與身上的餘額（提領會被扣公會稅）
    async function runGuildMoney(job, c) {
      const b = job.batches[0] || {}, op = b.op === 'withdraw' ? 'withdraw' : 'deposit', verb = op === 'withdraw' ? '提領' : '存入';
      const ptsOf = (st, ch) => { const v = st && st.cashPoints != null ? st.cashPoints : (ch && ch.cashPoints != null ? ch.cashPoints : ch && ch.points); return typeof v === 'number' ? v : (v && typeof v.balance === 'number' ? v.balance : null); };
      const mine = st => { const ch = st && st.character && st.character.id === c.id ? st.character : null; return { mesos: ch ? Number(ch.money) || 0 : null, cash: ptsOf(st, ch) }; };
      let have = mine(readState() || {});
      if (have.mesos == null) have.mesos = Number(c.money) || 0;
      let before = null;
      try { const v = await gameRetry({ type: 'guildWarehouseView', characterId: c.id }); before = v && v.summary && v.summary.guildWarehouse; if (before) postGuild(v, c); } catch (_) {}
      if (!before) return report(job, { event: 'error', msg: `讀不到公會倉庫（可能還沒加入公會），沒有${verb}` });
      const done = [], tail = () => done.length ? '（' + done.join('、') + ' 已完成）' : '';
      for (const [field, type, label, gk] of [['mesos', 'guildWarehouseMesos', '楓幣', 'mesos'], ['cash', 'guildWarehouseCash', '點數', 'cashPoints']]) {
        const amt = Math.floor(Number(b[field]) || 0);
        if (!(amt > 0)) continue;
        if (op === 'deposit') {
          if (have[field] == null) return report(job, { event: 'error', msg: `讀不到目前的${label}，沒有存入${tail()}` });
          if (amt > have[field]) return report(job, { event: 'error', msg: `${label}不足：要存 ${amt.toLocaleString()}，${c.name} 只有 ${have[field].toLocaleString()}${tail()}` });
        } else if (amt > (Number(before[gk]) || 0)) return report(job, { event: 'error', msg: `公倉${label}不足：要提領 ${amt.toLocaleString()}，公倉只有 ${(Number(before[gk]) || 0).toLocaleString()}${tail()}` });
        setBadge(null, `${verb}公倉${label} ${amt.toLocaleString()}…`);
        let j;
        try { j = await game({ type, op, amount: amt, characterId: c.id }); }
        catch (e) { return report(job, { event: 'error', msg: `${verb}${label}失敗：${e.message}${tail()}` }); }
        postGuild(j, c);
        const after = j && j.summary && j.summary.guildWarehouse;
        const now = mine(j && j.character ? j : (readState() || {}));
        const g0 = Number(before[gk]) || 0, g1 = after ? Number(after[gk]) || 0 : null;
        const self = have[field] != null && now[field] != null ? `；${label === '點數' ? '帳號' : c.name + ' 身上'}${label} ${have[field].toLocaleString()} → ${now[field].toLocaleString()}` : '';
        done.push(`${verb}${label} ${amt.toLocaleString()}`);
        await report(job, { event: 'log', msg: `已${verb}${label} ${amt.toLocaleString()}${g1 != null ? `：公倉${label} ${g0.toLocaleString()} → ${g1.toLocaleString()}` : ''}${self}${op === 'withdraw' && have[field] != null && now[field] != null && now[field] - have[field] !== amt ? `（實際拿到 ${(now[field] - have[field]).toLocaleString()}，差額是公會稅）` : ''}` });
        if (after) before = after;
        if (now[field] != null) have[field] = now[field];
        await sleepP(800);
      }
      return report(job, { event: 'batchDone' });
    }
    // 公倉的裝備賣給商店：遊戲不能直接從公倉賣，所以由這隻角色每次領出一批、馬上賣掉（避免背包塞滿）
    async function runGuildSell(job, c) {
      const gear = (job.batches[0] || {}).gear || [];
      const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      let sold = 0, total = 0;
      for (let i = 0; i < gear.length; i += 50) {
        const chunk = gear.slice(i, i + 50);
        setBadge(null, `公倉賣出：領出 ${i + chunk.length}/${gear.length}…`);
        let j;
        try { j = await gameRetry({ type: 'guildWarehouseBatch', op: 'withdraw', items: chunk.map(g => ({ kind: 'gear', uid: g.uid })), characterId: c.id, requestId: rid() }); postGuild(j, c); }
        catch (e) { if (sold) await report(job, { event: 'log', msg: `已賣出 ${sold} 件，共 ${total.toLocaleString()} 楓幣` }); return report(job, { event: 'error', msg: '從公倉領出失敗：' + e.message }); }
        const bag = new Map((((j && j.character) || {}).equipmentBag || []).map(g => [g.uid, g]));
        const ids = chunk.map(g => g.uid).filter(u => bag.has(u) && !bag.get(u).locked);
        if (!ids.length) continue;
        setBadge(null, `公倉賣出：賣出 ${ids.length} 件…`);
        try {
          const sq = await safeQuote(c.id, 'equip', ids);
          if (sq.error) return report(job, { event: 'error', msg: `${sq.error}（已領出的 ${ids.length} 件在 ${c.name} 背包，沒有賣）` });
          const q = sq.q;
          await gameRetry({ type: 'inventorySell', quoteId: q.id, characterId: c.id, requestId: rid() });
          sold += q.rows.length; total += Number(q.total) || 0;
        } catch (e) { return report(job, { event: 'error', msg: `賣出失敗：${e.message}（已領出的裝備在 ${c.name} 背包）` }); }
        await sleepP(1000);
      }
      await report(job, { event: 'log', msg: `已賣出 ${sold} 件，共 ${total.toLocaleString()} 楓幣` });
      return report(job, { event: 'batchDone' });
    }
    // 你在遊戲裡自己打開或存取公會倉庫時，也把最新內容交給中控
    (function hookGuild() {
      try {
        if (!W || W.__szgGuildHook) return;
        W.__szgGuildHook = true;
        const orig = W.fetch;
        W.fetch = function (input, init) {
          const p = orig.apply(this, arguments);
          try {
            const body = init && typeof init.body === 'string' ? init.body : '';
            if (body.indexOf('"guildWarehouse') >= 0) p.then(r => r.clone().json()).then(j => { const st = readState(); postGuild(j, st && st.character); }).catch(() => {});
          } catch (_) {}
          return p;
        };
      } catch (e) { console.warn('[szg-hub] guild hook failed', e); }
    })();

    const pollQs = charId => `code=${encodeURIComponent((account && account.playerCode) || '')}&charId=${encodeURIComponent(charId || '')}&page=${PAGE_ID}&hidden=${document.hidden ? 1 : 0}&off=${isIdleOffline() ? 1 : 0}`;
    async function agentTick() {
      if (agentRunning || passive()) return;
      agentRunning = true;
      try {
        await loadAccount().catch(() => null);
        let state = readState();
        if (!account || !state) return;
        const charId = sessionStorage.getItem('mapleCharacter');
        const res = await hub('GET', '/api/agent?' + pollQs(charId));
        const job = res && res.job;
        if (!job && res && res.needUpdate && GM_getValue(ck('reloadForUpdate'), '') !== res.needUpdate) {
          GM_setValue(ck('reloadForUpdate'), res.needUpdate);
          setBadge(null, '有工作需要新版腳本，重新整理頁面…');
          setTimeout(() => location.reload(), 1500);
          return;
        }
        if (!job) { if (agentBusy) { agentBusy = false; lastJobAt = Date.now(); setBadge('ok'); await refreshOwnState(true); } return; }
        agentBusy = true;
        if (job.kind !== 'idle' && isIdleOffline()) { await wakePage('執行「' + ({ collect: '收集', give: '分發', sell: '賣出', lock: '鎖定', unlock: '解鎖' }[job.kind] || '工作') + '」前'); state = readState() || state; }
        // 頁面的背包資料可能是舊的（背景分頁更常見）→ 工作前直接向遊戲要一份最新的
        if (job.kind !== 'idle') { await refreshOwnState(true); state = readState() || state; }
        if (res.role === 'owner') return await runBagJob(job, state, charId);
        const role = res.role; // 'giver' | 'receiver'
        const batch = job.batches[job.batchIndex];
        const L = local[job.id] || (local[job.id] = { batchIndex: -1 });
        if (L.batchIndex !== job.batchIndex) Object.assign(L, { batchIndex: job.batchIndex, tradeId: null, stepAt: Date.now(), invites: 0, step: '' });

        const wantChar = role === 'giver' ? job.fromCharId : job.toCharId;
        if (job.strictChar && wantChar && charId !== wantChar) {
          const nm = role === 'giver' ? job.fromName : job.toName;
          setBadge(null, `交易等待中：「${nm}」要有自己的遊戲分頁（按右下角「＋ 開 ${nm} 的分頁」，或切換過去）`);
          return report(job, { event: 'waiting', msg: `等待 ${nm} 的遊戲分頁（開它自己的分頁，或切換過去）` });
        }
        if (!res.peerReady) {
          // 排隊中（對方正在和別人交易）或對方離線：重設計時，輪到自己時才開始算逾時
          L.step = ''; L.stepAt = Date.now();
          setBadge(null, `交易排隊中：等待 ${role === 'giver' ? job.toName : job.fromName}（對方可能正在和別人交易，或不在線）`);
          if (role === 'receiver') await claimIncomingInvite(job);
          return;
        }

        const sync = await game({ type: 'sync', tradeOnly: true });
        const t = sync && sync.trade;
        const peerCode = role === 'giver' ? job.toCode : job.fromCode;
        const mine = t && t.sides && t.sides[t.self];
        const theirs = t && t.sides && t.sides[1 - t.self];
        const isOurTrade = t && theirs && theirs.code === peerCode && t.status !== 'done' && t.status !== 'cancelled';

        const stepTimedOut = Date.now() - L.stepAt > STEP_TIMEOUT_MS;
        const step = s => { if (L.step !== s) { L.step = s; L.stepAt = Date.now(); } };
        const label = `交易 ${job.batchIndex + 1}/${job.batches.length}`;

        // 這一批已完成
        if (t && L.tradeId && t.id === L.tradeId && t.status === 'done') {
          setBadge(null, `${label}：完成`);
          await report(job, { event: 'batchDone', tradeId: t.id });
          return;
        }

        // 有其他人的交易卡著
        if (t && !isOurTrade && t.status !== 'done' && t.status !== 'cancelled' && theirs) {
          // 收貨方收到的是另一隻分身的邀請：請伺服器改成先處理那一個
          if (role === 'receiver' && t.status === 'invited' && (await claimIncomingInvite(job, t))) return;
          setBadge(null, `交易等待中：目前有和其他人的交易未結束`);
          return report(job, { event: 'waiting', msg: '有其他交易進行中，請先在遊戲裡取消或完成' });
        }

        if (stepTimedOut && L.step) {
          if (isOurTrade) { try { await game({ type: 'tradeCancel', tradeId: t.id }); } catch (_) {} }
          return report(job, { event: 'error', msg: `${label} 在「${L.step}」這一步卡超過 3 分鐘，已取消` });
        }

        if (role === 'giver') {
          if (!isOurTrade) {
            if (L.invites >= 3) return report(job, { event: 'error', msg: `${label}：邀請 3 次都沒有成立` });
            if (L.step === 'invited' && Date.now() - L.stepAt < 30000) return; // 剛邀請，等對方
            const c = state.character;
            const { offer, skipped } = buildOffer(batch, c);
            if (!offer.items.length && !offer.money) {
              await report(job, { event: 'log', msg: `${label}：沒有可交易的東西，略過。${skipped.length ? '略過：' + skipped.join('、') : ''}` });
              return report(job, { event: 'batchDone', tradeId: null, skippedEmpty: true });
            }
            setBadge(null, `${label}：送出邀請給 ${job.toName}`);
            await game({ type: 'tradeInvite', code: job.toCode });
            L.invites++; // 只有成功送出的邀請才算次數
            step('invited');
            return report(job, { event: 'log', msg: `${label}：已送出邀請` });
          }
          L.tradeId = t.id;
          if (t.status === 'invited') { step('invited'); setBadge(null, `${label}：等待 ${job.toName} 接受`); return; }
          if (t.status === 'open') {
            if (!mine.locked) {
              const { offer, skipped } = buildOffer(batch, state.character);
              if (skipped.length) await report(job, { event: 'log', msg: `${label}：略過 ${skipped.join('、')}` });
              step('lock');
              setBadge(null, `${label}：放入 ${offer.items.length} 格＋楓幣 ${offer.money.toLocaleString()}，鎖定`);
              await game({ type: 'tradeOffer', tradeId: t.id, revision: t.revision, offer });
              const s2 = await game({ type: 'sync', tradeOnly: true });
              const t2 = s2.trade;
              await game({ type: 'tradeLock', tradeId: t2.id, revision: t2.revision, offer });
              return report(job, { event: 'log', msg: `${label}：已放入 ${offer.items.length} 格、楓幣 ${offer.money.toLocaleString()} 並鎖定` });
            }
            if (!theirs.locked) { step('waitLock'); setBadge(null, `${label}：等待 ${job.toName} 鎖定`); return; }
            if ((theirs.offer && ((theirs.offer.items || []).length || theirs.offer.money || theirs.offer.points))) {
              await game({ type: 'tradeCancel', tradeId: t.id }).catch(() => {});
              return report(job, { event: 'error', msg: `${label}：收貨方竟然也放了東西，已取消` });
            }
            if (!mine.confirmed) {
              step('confirm');
              setBadge(null, `${label}：確認交易`);
              await game({ type: 'tradeConfirm', tradeId: t.id, revision: t.revision });
              return report(job, { event: 'log', msg: `${label}：已確認，等待對方確認${mine.fees && mine.fees.money ? `（手續費 ${mine.fees.money.toLocaleString()}）` : ''}` });
            }
            step('waitConfirm'); setBadge(null, `${label}：等待 ${job.toName} 確認`);
            return;
          }
          return;
        }

        // ---- 收貨方 ----
        if (!isOurTrade) { step(''); setBadge(null, `${label}：等待 ${job.fromName} 的邀請`); return; }
        L.tradeId = t.id;
        if (t.status === 'invited') {
          // 只接受工作清單上指定的對象
          step('accept');
          setBadge(null, `${label}：接受 ${job.fromName} 的邀請`);
          await game({ type: 'tradeAccept', tradeId: t.id });
          return report(job, { event: 'log', msg: `${label}：已接受邀請` });
        }
        if (t.status === 'open') {
          if (!theirs.locked) { step('waitGiver'); setBadge(null, `${label}：等待 ${job.fromName} 放東西`); return; }
          const bad = verifyIncoming(batch, theirs.offer);
          if (bad) {
            await game({ type: 'tradeCancel', tradeId: t.id }).catch(() => {});
            return report(job, { event: 'error', msg: `${label}：核對失敗，已取消。${bad}` });
          }
          if (!mine.locked) {
            step('lock');
            await game({ type: 'tradeLock', tradeId: t.id, revision: t.revision, offer: { money: 0, points: 0, items: [] } });
            return report(job, { event: 'log', msg: `${label}：核對通過（${(theirs.offer.items || []).length} 格、楓幣 ${(theirs.offer.money || 0).toLocaleString()}），已鎖定` });
          }
          if (!mine.confirmed) {
            step('confirm');
            setBadge(null, `${label}：確認交易`);
            await game({ type: 'tradeConfirm', tradeId: t.id, revision: t.revision });
            return report(job, { event: 'log', msg: `${label}：收貨方已確認` });
          }
          step('waitConfirm'); setBadge(null, `${label}：等待 ${job.fromName} 確認`);
        }
      } catch (e) {
        console.warn('[szg-hub agent]', e);
        setBadge(null, e && e.gameUpdated ? '遊戲有新版本，正在重新整理頁面…' : '交易錯誤：' + e.message);
        try {
          const res = await hub('GET', '/api/agent?' + pollQs(myChar()) + '&peek=1');
          if (res && res.job) await report(res.job, { event: 'log', msg: e && e.gameUpdated ? '遊戲有新版本，頁面自動重新整理中' : '遊戲回應錯誤：' + e.message });
        } catch (_) {}
      } finally {
        agentRunning = false;
      }
    }

    // 「開另一隻角色的分頁」按鈕：同帳號的其他角色都列出來（不會整個消失）——沒有分頁的可以直接開；
    // 看起來已經有分頁的顯示「已開」（關分頁時的標記可能沒寫進去，最多 20～100 秒後自動恢復；點了會先確認再開）
    // （分頁被藏到背景時遊戲會進離線掛機、資料暫停，所以用獨立視窗，兩個視窗都看得到最好）
    function accountCharList(st) {
      const code = (account && account.playerCode) || '';
      let list = ((st && st.characters) || []).filter(c => c && c.id).map(c => ({ id: c.id, name: c.name }));
      if (list.length) { try { GM_setValue('charNames:' + code, list); } catch (_) {} return list; }
      // 頁面資料沒有角色清單時：用帳號的角色 id＋之前記住的名字
      const names = Object.fromEntries((GM_getValue('charNames:' + code, []) || []).map(c => [c.id, c.name]));
      return ((account && account.characterIds) || Object.keys(names)).map(id => ({ id, name: names[id] || id.slice(0, 6) }));
    }
    function renderOpenOther() {
      if (!document.body) return;
      let box = document.getElementById('szg-hub-open');
      const st = readState();
      const me = myChar();
      const others = passive() ? [] : accountCharList(st).filter(c => c.id !== me);
      if (!others.length) { if (box) box.remove(); return; }
      if (!box) {
        box = document.createElement('div');
        box.id = 'szg-hub-open';
        box.style.cssText = 'position:fixed;right:8px;bottom:34px;z-index:99999;font:12px sans-serif;display:flex;gap:4px;align-items:center';
        document.body.appendChild(box);
      }
      const mini = sessionStorage.getItem('szgOpenMini') === '1';
      const btn = 'font:12px sans-serif;padding:3px 8px;border-radius:10px;cursor:pointer;';
      const html = mini
        ? `<button data-szgmini="0" style="${btn}border:1px solid #2c6e8f;background:#163a4d;color:#dff" title="開同帳號其他角色的分頁">＋ 分頁</button>`
        : others.map(c => {
            const v = GM_getValue(tabKey(c.id), null), has = !!(v && !isMe(v) && tabFresh(v));
            const left = has ? Math.max(1, Math.ceil(((v.hidden ? 100000 : 20000) - (Date.now() - v.at)) / 1000)) : 0;
            return has
              ? `<button data-szgopen="${c.id}" data-szghas="1" style="${btn}border:1px solid #444;background:#222;color:#999" title="${c.name} 看起來已經有自己的分頁。如果你剛關掉它，約 ${left} 秒後會恢復成可以開；也可以直接按，確認後開新分頁">${c.name} 已開</button>`
              : `<button data-szgopen="${c.id}" style="${btn}border:1px solid #2c6e8f;background:#163a4d;color:#dff" title="開一個新視窗固定顯示 ${c.name}，兩隻同時在線（同一個帳號開兩個分頁）">＋ 開 ${c.name} 的分頁</button>`;
          }).join('') + `<button data-szgmini="1" style="font:11px sans-serif;padding:2px 6px;border-radius:10px;border:1px solid #555;background:#222;color:#aaa;cursor:pointer" title="收起來（點「＋ 分頁」再展開）">✕</button>`;
      if (box.dataset.h !== html) { box.innerHTML = html; box.dataset.h = html; }
      box.onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.szgmini) { sessionStorage.setItem('szgOpenMini', b.dataset.szgmini); box.dataset.h = ''; renderOpenOther(); return; }
        const id = b.dataset.szgopen;
        if (b.dataset.szghas && !W.confirm('這隻角色看起來已經有自己的分頁（可能在別的視窗）。\n如果剛關掉它，確定就直接開新的；重複開的那個會自動暫停。')) return;
        W.open(location.origin + '/game/?szgChar=' + encodeURIComponent(id), 'szg_' + id, 'popup=yes,width=1280,height=860,noopener');
      };
    }
    // 離開頁面（重新整理、關分頁）時放掉這隻角色的分頁標記，新頁面或另一個分頁可以馬上接手
    W.addEventListener('pagehide', () => {
      try { const v = GM_getValue(tabKey(myChar()), null); if (v && v.page === PAGE_ID) GM_setValue(tabKey(myChar()), { page: PAGE_ID, at: 0 }); } catch (_) {}
      try { const code = account && account.playerCode; const v = code && GM_getValue('lead:' + code, null); if (v && v.page === PAGE_ID) GM_setValue('lead:' + code, { page: PAGE_ID, at: 0 }); } catch (_) {}
    });

    function start() {
      tabBeat();
      setInterval(tabBeat, 5000);
      setInterval(renderOpenOther, 5000);
      setTimeout(renderOpenOther, 6000);
      setTimeout(tick, 3000);
      setInterval(tick, SCAN_MS);
      setInterval(agentTick, AGENT_MS);
      setTimeout(idleTick, 15000);
      setInterval(idleTick, 30000);
      setTimeout(() => stallTick().catch(() => {}), 40000);
      setInterval(() => { if (!mktBusy) stallTick().catch(() => {}); }, 20000);
      setInterval(marketScanTick, 31000);
      setTimeout(autoListTick, 70000);
      setInterval(autoListTick, 3 * 60 * 1000);
      setTimeout(autoSellTick, 20000);
      setInterval(autoSellTick, 20000);
      setInterval(() => dpsReport().catch(() => {}), 30000);
      setTimeout(quizTick, 25000);
      setInterval(quizTick, 45000);
      // 做很久的工作時（agentRunning，不會來問工作）每 20 秒報到一次
      setInterval(() => { if (agentRunning && !passive() && account && account.playerCode) hub('GET', '/api/agent/beat?' + pollQs(myChar())).catch(() => {}); }, 20000);
      setTimeout(() => avatarTick().catch(() => {}), 20000);
      setInterval(() => avatarTick().catch(() => {}), 5 * 60 * 1000);
      setTimeout(() => bossStateTick(true), 15000);
      setInterval(() => bossStateTick(false), 60000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    return { version: AGENT_VERSION, isBusy: () => agentBusy || agentRunning };
}
