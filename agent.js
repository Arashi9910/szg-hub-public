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
          const last = GM_getValue('gameUpdateReloadAt', 0);
          if (!reloadingForGameUpdate && Date.now() - last > 5 * 60 * 1000) {
            reloadingForGameUpdate = true;
            GM_setValue('gameUpdateReloadAt', Date.now());
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

    function readState() {
      const raw = sessionStorage.getItem('mapleSessionView');
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && v.state && v.state.character ? v.state : null;
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
        account = { playerCode: a.playerCode, activeCharacterId: a.activeCharacterId };
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
      catalog = { equipment: cat.equipment || {}, items: cat.items || {}, scrolls: cat.scrolls || {}, jobs: cat.jobs || {}, statNames: cat.statNames || {}, mapsById };
      return catalog;
    }
    function jobBranch(jobKey) {
      let j = catalog.jobs[jobKey], guard = 0;
      while (j && j.parent && j.tier > 1 && guard++ < 6) j = catalog.jobs[j.parent];
      return j ? j.name : '';
    }
    function itemInfo(key) {
      const it = catalog.items[key] || catalog.scrolls[key];
      if (!it) return { name: key, kind: '其他', cat: 'etc', sellPrice: 0, itemId: 0 };
      const kind = it.type || (catalog.scrolls[key] ? '卷軸' : '其他');
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
        weaponType: /Weapon/.test(category) ? (g.type || e.equipmentType) : '',
        itemId: g.itemId, name: g.name, plus: g.successes || 0, slotsLeft: g.slots || 0, maxSlots: g.maxSlots || 0,
        locked: !!g.locked, tradable: loc === '背包' ? gearTradable(g) : false,
        stats: g.stats || {}, cleanStats: g.cleanStats || g.baseStats || {},
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
          expPct: meta.expNeed ? Math.min(100, (c.xp / meta.expNeed) * 100) : null,
          hourlyExp: meta.hourlyExp || null,
          tradeId: (account && account.playerCode) || rememberedCode() || undefined,
          money: c.money || 0, warehouseMesos: c.warehouseMesos || 0,
          map: c.map, mapName: catalog.mapsById[String(c.map)] || c.map,
          auto: !!c.auto, until: c.until || null,
          hp: c.hp, maxhp: c.maxhp, mp: c.mp, maxmp: c.maxmp, kills: c.kills || 0,
          hpItem: sup.hpItem ? itemInfo(sup.hpItem).name : null, hpQty: sup.hpItem ? (inv[sup.hpItem] || 0) : null,
          mpItem: sup.mpItem ? itemInfo(sup.mpItem).name : null, mpQty: sup.mpItem ? (inv[sup.mpItem] || 0) : null,
          stats: c.stats || {},
          gearBagCount: (c.equipmentBag || []).length,
          itemStackCount: (c.inventoryStacks || []).length,
        },
        knowledge: (() => { const k = lastKnowledge || state.knowledge; return k ? { ready: !!k.ready, remaining: k.remaining,
          round: k.round ? { index: k.round.index, done: !!k.round.done, correct: k.round.correct } : null, dbg: `${quizDbg.step}｜${quizDbg.why}｜${quizDbg.ticks}次｜${quizDbg.at ? Math.round((Date.now() - quizDbg.at) / 1000) + '秒前' : ''}${quizDbg.err ? '｜' + quizDbg.err : ''}` } : undefined; })(),
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
      if (text) { el.textContent = text; el.style.background = '#7a5a12'; return; }
      if (agentBusy) return; // 交易進行中時保留交易狀態文字
      if (status === 'ok') { el.textContent = '中控：已連線'; el.style.background = '#1f7a3a'; }
      else if (status === 'auth') { el.textContent = '中控：伺服器拒絕連線'; el.style.background = '#8a2b2b'; }
      else { el.textContent = '中控：連不到中控伺服器'; el.style.background = '#8a2b2b'; }
    }

    async function tick() {
      try {
        const state = readState();
        if (!state) return;
        await loadCatalog();
        try { await loadAccount(); } catch (_) {}
        const snap = buildSnapshot(state);
        const hash = JSON.stringify([snap.char, snap.playerCode, snap.eligibleKnown, snap.knowledge, snap.gear.map(g => g.uid + g.plus + g.loc + g.locked).join('|'), snap.items.map(i => i.key + i.qty + i.loc + i.tradableQty + i.lockedQty).join('|')]);
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
    function findQuote(o, depth = 0) {
      if (!o || typeof o !== 'object' || depth > 4) return null;
      if (o.id && Array.isArray(o.rows)) return o;
      for (const v of Object.values(o)) { const q = findQuote(v, depth + 1); if (q) return q; }
      return null;
    }
    // ---------- 掛機控制 ----------
    const IDLE_LABEL = { start: '開始掛機', stop: '暫停掛機', restart: '重新開始掛機' };
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
      for (const t of (job.batches[0] && job.batches[0].targets) || []) {
        try {
          setBadge(null, `${t.name}：${IDLE_LABEL[t.action]}…`);
          await idleAction(t.charId, t.action);
          done.push(`${t.name} ${IDLE_LABEL[t.action]}`);
        } catch (e) { failed.push(`${t.name}（${e.message}）`); }
      }
      if (done.length) await report(job, { event: 'log', msg: '完成：' + done.join('、') });
      if (failed.length) return report(job, { event: 'error', msg: '失敗：' + failed.join('、') });
      return report(job, { event: 'batchDone' });
    }

    // 自動規則（每 30 秒）：
    //  - 掛滿 N 小時自動暫停（N=0 代表不限）
    //  - 自動續掛：到期前 M 分鐘重新開始；已經到期停掉的自動開始。從面板手動暫停的不會被重新開始。
    const H = 3600 * 1000, IDLE_CAP = 24 * H;
    async function idleTick() {
      try {
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
    function condVal(g, k) {
      const st = g.stats || {};
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
      if (asRunning) return;
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
        const cfg = await hub('GET', '/api/autosell');
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
        const qr = await game({ type: 'inventoryQuote', category: 'equip', ids });
        const q = findQuote(qr);
        if (!q) { await log('自動賣出失敗：取得報價失敗'); return; }
        if (q.rows.length > ids.length) { await log(`自動賣出取消：報價單 ${q.rows.length} 項比要賣的 ${ids.length} 項多`); return; }
        await game({ type: 'inventorySell', quoteId: q.id });
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
    async function marketScanTick() {
      if (mktBusy || agentBusy) return;
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
      if (agentBusy || (!force && Date.now() - lastStallAt < 5 * 60 * 1000)) return null;
      const state = readState(); if (!state || !state.character || !account) return null;
      lastStallAt = Date.now();
      const charId = state.character.id;
      const m = await marketSync({});
      if (!m) return null;
      const mine = m.mine;
      const stall = mine ? { exists: true, open: !!mine.open, title: mine.title, count: mine.count || (mine.listings || []).length, proceeds: mine.proceeds || 0,
        listings: (mine.listings || []).map(l => ({ id: l.id, kind: l.kind, key: l.key, name: l.name, qty: l.qty, price: l.price })), history: mine.history || [] } : { exists: false };
      const r = await hub('POST', '/api/market/stall', { charId, stall });
      if (mine && mine.proceeds > 0 && r && r.autoClaim) {
        try { await game({ type: 'marketClaim', characterId: charId }); await hub('POST', '/api/market/log', { charId, msg: `已領取攤位收益 ${Number(mine.proceeds).toLocaleString()} 楓幣` }); }
        catch (e) { await hub('POST', '/api/market/log', { charId, msg: '領取收益失敗：' + e.message }).catch(() => {}); }
      }
      return m;
    }

    let lastPlanHash = '';
    async function autoListTick() {
      for (let i = 0; i < 20 && mktBusy; i++) await sleep(3000); // 掃描中就等它做完，不要整輪跳過
      if (mktBusy || agentBusy) return;
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
        // 自動上架：先拿最新的攤位與可上架清單
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

    let quizRunning = false;
    let lastKnowledge = null;
    const quizDbg = { step: '', at: 0, err: '', ticks: 0, why: '' };
    const qstep = st => { quizDbg.step = st; quizDbg.at = Date.now(); };
    async function quizTick() {
      if (quizRunning) { if (Date.now() - quizDbg.at > 5 * 60 * 1000) { quizDbg.err = '卡在 ' + quizDbg.step + ' 超過 5 分鐘，重設'; quizRunning = false; } return; }
      quizDbg.ticks++;
      // 只在真的有交易／背包工作時讓路（agentRunning 只是每 3 秒查一次工作，背景分頁會跟這裡同時醒來）
      if (agentBusy) { quizDbg.why = '交易/背包工作中'; return; }
      quizRunning = true; qstep('開始'); quizDbg.why = '';
      try {
        const state = readState();
        if (!state || !state.character) return;
        qstep('讀題庫');
        const cfg = await hub('GET', '/api/quiz');
        const charId = state.character.id;
        qstep('同步');
        let j = await game({ type: 'sync' });
        let k = j && j.knowledge;
        if (k) lastKnowledge = k;
        qstep('已同步');
        if (!cfg.auto || !k || !k.ready) { quizDbg.why = !cfg.auto ? '未開啟' : !k ? '同步沒有知識王資料' : '知識王未開放'; return; }
        const log = msg => hub('POST', '/api/quiz/log', { charId, msg }).catch(() => {});
        let waitNext = 0;
        for (let guard = 0; guard < 40; guard++) {
          const r = k.round;
          if (!r || r.done) {
            if (!(k.remaining > 0)) { quizDbg.why = '今日次數用完'; return; }
            setBadge(null, `知識王：開始新一輪（今日剩 ${k.remaining} 次）`);
            qstep('開新一輪');
            j = await game({ type: 'knowledgeStart' });
            k = j.knowledge; if (k) lastKnowledge = k; await log(`開始新一輪（今日剩 ${k && k.remaining}）`);
            continue;
          }
          const q = r.question;
          if (!q) {
            // 剛作答完，遊戲可能先顯示對錯、過一下才給下一題
            if (++waitNext > 8) { quizDbg.err = '等不到下一題：' + JSON.stringify({ i: r.index, done: r.done, fb: !!r.feedback, keys: Object.keys(r) }).slice(0, 150); return; }
            qstep('等下一題'); await new Promise(res => setTimeout(res, 2500));
            j = await game({ type: 'sync' }); k = j.knowledge; if (k) lastKnowledge = k; continue;
          }
          waitNext = 0;
          const ans = cfg.answers[qnorm(q.text)];
          const idx = ans == null ? -1 : q.options.findIndex(o => qnorm(o) === qnorm(ans));
          if (idx < 0) {
            quizDbg.why = '等你作答第 ' + (r.index + 1) + ' 題';
            await hub('POST', '/api/quiz/unknown', { q: q.text, options: q.options, charId });
            setBadge(null, `知識王：第 ${r.index + 1} 題題庫沒有，等你在面板選答案`);
            return;
          }
          setBadge(null, `知識王：第 ${r.index + 1} 題 → ${q.options[idx]}`);
          qstep('作答 ' + (r.index + 1));
          j = await game({ type: 'knowledgeAnswer', round: r.id, index: r.index, answer: idx });
          learnFrom(j);
          const f = j.knowledge && j.knowledge.round && j.knowledge.round.feedback;
          if (f && typeof f.correctIndex === 'number' && f.selected !== f.correctIndex) await log(`答錯：${q.text}（選 ${q.options[idx]}，正解 ${f.options[f.correctIndex]}），已更正題庫`);
          k = j.knowledge; if (k) lastKnowledge = k;
          if (k && k.round && k.round.done) await log(`本輪結束：答對 ${k.round.correct}/5`);
        }
      } catch (e) {
        console.warn('[szg-hub quiz]', e); quizDbg.err = e.message + '@' + quizDbg.step;
        hub('POST', '/api/quiz/log', { msg: '自動作答出錯：' + e.message }).catch(() => {});
      } finally { quizRunning = false; qstep('閒置'); }
    }

    async function runBagJob(job, state, charId) {
      if (job.kind === 'idle') return runIdleJob(job);
      if (charId !== job.fromCharId) {
        setBadge(null, `背包工作等待中：請切到「${job.fromName}」`);
        return report(job, { event: 'waiting', msg: `等待切換到 ${job.fromName}` });
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
          const uids = (it.uids || []).filter(u => stackOk.has(u) && !stackOk.get(u).locked);
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
          const qr = await game({ type: 'inventoryQuote', category, ids });
          const q = findQuote(qr);
          if (!q) return report(job, { event: 'error', msg: `取得報價失敗（${category}），回應欄位：${Object.keys(qr || {}).join(',')}` });
          if (q.rows.length > ids.length) return report(job, { event: 'error', msg: `報價單有 ${q.rows.length} 項，比選擇的 ${ids.length} 項多，已停止` });
          await game({ type: 'inventorySell', quoteId: q.id, requestId: rid() });
          total += Number(q.total) || 0; count += q.rows.length;
        }
        await report(job, { event: 'log', msg: `已賣出 ${count} 項，共 ${total.toLocaleString()} 楓幣` });
        return report(job, { event: 'batchDone' });
      }
      return report(job, { event: 'error', msg: '未知的工作類型：' + job.kind });
    }

    async function agentTick() {
      if (agentRunning) return;
      agentRunning = true;
      try {
        await loadAccount().catch(() => null);
        const state = readState();
        if (!account || !state) return;
        const charId = sessionStorage.getItem('mapleCharacter');
        const res = await hub('GET', `/api/agent?code=${encodeURIComponent(account.playerCode)}&charId=${encodeURIComponent(charId)}`);
        const job = res && res.job;
        if (!job) { if (agentBusy) { agentBusy = false; lastJobAt = Date.now(); setBadge('ok'); } return; }
        agentBusy = true;
        if (res.role === 'owner') return await runBagJob(job, state, charId);
        const role = res.role; // 'giver' | 'receiver'
        const batch = job.batches[job.batchIndex];
        const L = local[job.id] || (local[job.id] = { batchIndex: -1 });
        if (L.batchIndex !== job.batchIndex) Object.assign(L, { batchIndex: job.batchIndex, tradeId: null, stepAt: Date.now(), invites: 0, step: '' });

        const wantChar = role === 'giver' ? job.fromCharId : job.toCharId;
        if (job.strictChar && wantChar && charId !== wantChar) {
          setBadge(null, `交易等待中：請切到「${role === 'giver' ? job.fromName : job.toName}」`);
          return report(job, { event: 'waiting', msg: `等待切換到 ${role === 'giver' ? job.fromName : job.toName}` });
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
          const res = await hub('GET', `/api/agent?code=${encodeURIComponent(account && account.playerCode || '')}&charId=`);
          if (res && res.job) await report(res.job, { event: 'log', msg: e && e.gameUpdated ? '遊戲有新版本，頁面自動重新整理中' : '遊戲回應錯誤：' + e.message });
        } catch (_) {}
      } finally {
        agentRunning = false;
      }
    }

    function start() {
      setTimeout(tick, 3000);
      setInterval(tick, SCAN_MS);
      setInterval(agentTick, AGENT_MS);
      setTimeout(idleTick, 15000);
      setInterval(idleTick, 30000);
      setTimeout(() => stallTick().catch(() => {}), 40000);
      setInterval(() => { if (!mktBusy) stallTick().catch(() => {}); }, 60000);
      setInterval(marketScanTick, 31000);
      setTimeout(autoListTick, 70000);
      setInterval(autoListTick, 3 * 60 * 1000);
      setTimeout(autoSellTick, 20000);
      setInterval(autoSellTick, 20000);
      setTimeout(quizTick, 25000);
      setInterval(quizTick, 45000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    return { version: AGENT_VERSION, isBusy: () => agentBusy || agentRunning };
}
