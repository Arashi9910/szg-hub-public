// 上漲谷中控 - 自由市場：行情紀錄、掃描排程、自動上架的定價計畫
// 由 server.js 載入：const market = require('./market')(getDb, save, charName)
'use strict';

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const KEEP_MS = 8 * DAY;          // 行情保留 8 天
const LEASE_MS = 2 * 60 * 1000;   // 掃描工作租期：拿到工作的頁面 2 分鐘內沒回報就換別人
const BATCH = 6;                  // 每次交給頁面的查詢數
const MAX_LISTINGS = 50;          // 每個攤位最多 50 件

module.exports = function (getDb, save, charName, rollProfile) {
  function M() {
    const db = getDb();
    const m = db.market || (db.market = {});
    m.hist = m.hist || {};          // key → [{t, min, med, n, q}]（道具，key 是 i2000003 這種）
    m.gearHist = m.gearHist || {};  // 裝備名稱 → [{t, min, n}]
    m.latest = m.latest || {};      // key 或 'g:名稱' → { t, rows: [{price, qty, seller, mine, stats?, plus?, slots?}] }
    m.queue = m.queue || [];        // 待掃描：[{q: 搜尋字, key?, gear?}]
    m.lease = m.lease || null;      // { charId, at, items }
    m.lastFull = m.lastFull || 0;
    m.stalls = m.stalls || {};      // charId → { at, open, count, listings, proceeds, history }
    m.sales = m.sales || [];        // 自己攤位成交紀錄（去重）
    m.listLog = m.listLog || [];
    return m;
  }
  function cfg() {
    const s = getDb().settings.market || {};
    return {
      scanHours: Number(s.scanHours) || 3,
      sanityMult: Number(s.sanityMult) || 1000, // 市場最低價超過商店收購價幾倍算「疑似亂掛」
      autoClaim: s.autoClaim !== false,
      mode: s.mode || 'off',               // off | preview | auto
      chars: s.chars || {},
      rules: s.rules || [],
      stallTitle: s.stallTitle || '',
    };
  }
  // 我方所有角色名稱（算行情時排除自己的掛單，避免跟自己比價）
  function ownNames() {
    const set = new Set();
    for (const s of Object.values(getDb().chars)) { set.add(s.char.name); for (const c of s.accountChars || []) set.add(c.name); }
    return set;
  }
  function log(entry) {
    const m = M();
    m.listLog.push({ at: Date.now(), ...entry, name: entry.charId ? charName(entry.charId) : '' });
    if (m.listLog.length > 300) m.listLog.splice(0, m.listLog.length - 300);
  }

  // ---------- 要掃描哪些東西 ----------
  // 道具：所有帳號背包裡有的；裝備：符合自動上架裝備規則的背包裝備名稱；再加上手動關注清單
  function watchList() {
    const db = getDb();
    const items = new Map(), gear = new Set();
    for (const s of Object.values(db.chars)) {
      for (const i of s.items || []) if (i.loc === '背包' && !items.has(i.key)) items.set(i.key, i.name);
    }
    for (const w of (db.settings.market && db.settings.market.watch) || []) if (w.key && w.name) items.set(w.key, w.name);
    const gearRules = cfg().rules.filter(r => r.on !== false && r.target === 'gear');
    if (gearRules.length) for (const s of Object.values(db.chars)) for (const g of s.gear || []) {
      if (g.loc === '背包' && gearRules.some(r => gearRuleMatch(r, g))) gear.add(g.name);
    }
    return { items, gear };
  }
  function enqueueAll(front) {
    const m = M(), { items, gear } = watchList();
    const have = new Set(m.queue.map(x => x.key || 'g:' + x.gear));
    const add = [];
    for (const [key, name] of items) if (!have.has(key)) add.push({ q: name, key });
    for (const name of gear) if (!have.has('g:' + name)) add.push({ q: name, gear: name });
    m.queue = front ? [...add, ...m.queue] : [...m.queue, ...add];
    return add.length;
  }
  function tick() {
    const m = M(), c = cfg();
    if (Date.now() - m.lastFull > c.scanHours * HOUR && !m.queue.length) { m.lastFull = Date.now(); enqueueAll(false); save(); }
    if (m.lease && Date.now() - m.lease.at > LEASE_MS) { m.queue = [...m.lease.items, ...m.queue]; m.lease = null; }
  }

  // 頁面來領掃描工作（同一時間只給一個頁面，避免重複查詢）
  function claim(charId) {
    tick();
    const m = M();
    if (m.lease && m.lease.charId !== charId) return { items: [] };
    if (m.lease && m.lease.charId === charId) m.queue = [...m.lease.items, ...m.queue];
    const items = m.queue.splice(0, BATCH);
    m.lease = items.length ? { charId, at: Date.now(), items } : null;
    save();
    return { items };
  }

  // 頁面回報查詢結果：products 是市場搜尋回來的掛單（依單價由低到高）
  function report(charId, results) {
    const m = M(), own = ownNames(), now = Date.now();
    for (const r of results || []) {
      if (!r || (!r.key && !r.gear)) continue;
      const rows = (r.products || []).filter(p => r.key ? p.key === r.key : (p.kind === 'gear' && p.name === r.gear))
        .map(p => ({ price: Number(p.price) || 0, qty: Number(p.qty) || 1, seller: p.sellerName || '', mine: !!p.mine || own.has(p.sellerName),
          ...(p.gear ? { stats: p.gear.stats || {}, plus: p.gear.successes || 0, slots: p.gear.slots, maxSlots: p.gear.maxSlots } : {}) }))
        .filter(p => p.price > 0).sort((a, b) => a.price - b.price);
      const others = rows.filter(p => !p.mine);
      const id = r.key || 'g:' + r.gear;
      m.latest[id] = { t: now, rows: rows.slice(0, 20), partial: !!r.more };
      const point = { t: now, min: others.length ? others[0].price : null, med: medianByQty(others, 50), n: others.length, q: others.reduce((a, p) => a + p.qty, 0) };
      const h = r.key ? (m.hist[r.key] || (m.hist[r.key] = [])) : (m.gearHist[r.gear] || (m.gearHist[r.gear] = []));
      h.push(point);
      while (h.length && now - h[0].t > KEEP_MS) h.shift();
    }
    if (m.lease && m.lease.charId === charId) {
      const done = new Set((results || []).map(r => r.key || 'g:' + r.gear));
      m.lease.items = m.lease.items.filter(x => !done.has(x.key || 'g:' + x.gear));
      if (!m.lease.items.length) m.lease = null; else m.lease.at = Date.now();
    }
    save();
  }
  // 前 N 件（依數量）的中位數單價，比單看最低價不容易被一件特價影響
  function medianByQty(rows, n) {
    const arr = [];
    for (const p of rows) { for (let i = 0; i < p.qty && arr.length < n; i++) arr.push(p.price); if (arr.length >= n) break; }
    if (!arr.length) return null;
    return arr[Math.floor((arr.length - 1) / 2)];
  }

  // ---------- 行情整理（給面板與定價用） ----------
  function stats(id) {
    const m = M();
    const h = id.startsWith('g:') ? (m.gearHist[id.slice(2)] || []) : (m.hist[id] || []);
    const now = Date.now();
    const last = h[h.length - 1];
    const week = h.filter(p => now - p.t <= 7 * DAY && p.min != null);
    const mins = week.map(p => p.min);
    const old = week.find(p => now - p.t >= 20 * HOUR) ? week[0] : null; // 至少有接近一天前的資料才算漲跌
    // 每天一個點（取當天最低），畫走勢用
    const days = {};
    for (const p of week) { const d = new Date(p.t + 8 * HOUR).toISOString().slice(0, 10); if (days[d] == null || p.min < days[d]) days[d] = p.min; }
    return {
      at: last ? last.t : 0,
      min: last ? last.min : null, med: last ? last.med : null, n: last ? last.n : 0, q: last ? last.q : 0,
      min7: mins.length ? Math.min(...mins) : null,
      max7: mins.length ? Math.max(...mins) : null,
      avg7: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
      change: old && last && last.min != null && old.min ? (last.min - old.min) / old.min : null,
      since: week.length ? week[0].t : 0,
      daily: Object.entries(days).sort().map(([d, v]) => ({ d, v })),
    };
  }

  // ---------- 攤位 ----------
  function reportStall(charId, s) {
    const m = M();
    m.stalls[charId] = { at: Date.now(), exists: !!s.exists, open: !!s.open, title: s.title || '', count: s.count || 0, proceeds: s.proceeds || 0,
      listings: (s.listings || []).slice(0, 60), history: (s.history || []).slice(0, 30) };
    const seen = new Set(m.sales.map(x => x.charId + '|' + x.time + '|' + x.name + '|' + x.buyer));
    for (const h of s.history || []) {
      const k = charId + '|' + h.time + '|' + h.name + '|' + h.buyer;
      if (!seen.has(k)) { m.sales.push({ charId, ...h }); seen.add(k); }
    }
    m.sales = m.sales.filter(x => Date.now() - x.time < 30 * DAY).slice(-1000);
    save();
  }

  // ---------- 自動上架：定價 ----------
  function priceFor(rule, id, npcPrice, kind) {
    const p = rule.price || {};
    const st = stats(id);
    let base = null, why = '';
    if (p.base === 'fixed') { base = Number(p.fixed) || null; why = '固定價'; }
    else if (p.base === 'median') { base = st.med; why = '市場中位數'; }
    else if (p.base === 'avg7') { base = st.avg7; why = '7 日平均最低價'; }
    else { base = st.min; why = '市場最低價'; }
    if (base == null) {
      if (p.noData === 'floor' && Number(p.floor) > 0) { base = Number(p.floor); why = '查不到行情，用底價'; }
      else return { skip: st.at ? '市場上沒有其他人在賣' : '還沒有行情資料（等掃描）' };
    } else if (p.base !== 'fixed') {
      base = base * (1 + (Number(p.adjPct) || 0) / 100) + (Number(p.adjAbs) || 0);
      if (st.at && Date.now() - st.at > 12 * HOUR) return { skip: '行情超過 12 小時沒更新' };
    }
    // 很多人把消耗品／雜物掛天價（例如紅藥水一個 100 萬），拿來當參考會定出賣不掉的價格
    const mult = cfg().sanityMult;
    if (p.base !== 'fixed' && kind !== '卷軸' && npcPrice > 0 && base > npcPrice * mult) return { skip: `市場掛價 ${Math.round(base).toLocaleString()} 是商店收購價的 ${Math.round(base / npcPrice).toLocaleString()} 倍，疑似亂掛，不自動上架（真的要賣請改用固定價）` };
    let price = Math.floor(base);
    const floor = Number(p.floor) || 0;
    if (floor > 0 && price < floor) { price = floor; why += '（低於底價，改用底價）'; }
    if (!(price > 0)) return { skip: '價格無效' };
    if (npcPrice && price <= npcPrice) return { skip: `定價 ${price} 不高於商店收購價 ${npcPrice}，賣商店比較划算` };
    return { price, why, st };
  }

  // 裝備規則的對象判斷（與面板的裝備篩選組合相同語意：部位、名稱、職業、等級、強化、素質條件）
  function gearRuleMatch(r, g) {
    const f = r.gearFilter || {};
    if (f.slots && f.slots.length && !f.slots.includes(g.slot)) return false;
    if (f.name && !String(g.name).includes(f.name)) return false;
    if (f.jobs && f.jobs.length && !f.jobs.some(b => b === 0 ? g.reqJob === 0 : (g.reqJob & b))) return false;
    if (f.lvMin !== '' && f.lvMin != null && g.reqLevel < Number(f.lvMin)) return false;
    if (f.lvMax !== '' && f.lvMax != null && g.reqLevel > Number(f.lvMax)) return false;
    if (f.plus !== '' && f.plus != null && g.plus < Number(f.plus)) return false;
    if (f.slotsLeft !== '' && f.slotsLeft != null && g.slotsLeft < Number(f.slotsLeft)) return false;
    return condsPass(g, f.conds) !== false;
  }
  function condVal(g, k) {
    const st = g.stats || {};
    if (k === '_sum4') return (st.incSTR || 0) + (st.incDEX || 0) + (st.incINT || 0) + (st.incLUK || 0);
    if (k === '_plus') return g.plus || 0;
    if (k === '_slotsLeft') return g.slotsLeft || 0;
    if (k === '_maxSlots') return g.maxSlots || 0;
    if (k === '_reqLevel') return g.reqLevel || 0;
    if (k === '_rollOk' || k === '_rollScore') { // 依部位設定的浮動判斷
      if (!g.baseStats || !g.cleanStats || !rollProfile) return k === '_rollOk' ? 0 : -999;
      const p = rollProfile(g.gtype || g.weaponType || g.slot || ''), sc = p.stats.reduce((t, s) => t + (Number(g.cleanStats[s]) || 0) - (Number(g.baseStats[s]) || 0), 0);
      return k === '_rollOk' ? (sc >= p.min ? 1 : 0) : sc;
    }
    return st[k] || 0;
  }
  const OPS = { '>': (v, t) => v > t, '>=': (v, t) => v >= t, '<': (v, t) => v < t, '<=': (v, t) => v <= t, '=': (v, t) => v === t, '≠': (v, t) => v !== t };
  function condsPass(g, conds) {
    const valid = (conds || []).filter(c => c.val !== '' && c.val != null && OPS[c.op]);
    if (!valid.length) return null;
    const groups = [[]];
    valid.forEach((c, i) => { if (i > 0 && c.join === 'or') groups.push([]); groups[groups.length - 1].push(c); });
    return groups.some(gr => gr.every(c => OPS[c.op](condVal(g, c.stat), Number(c.val))));
  }
  function itemRuleMatch(r, i) {
    const f = r.ff || {};
    if ((f.kinds || []).length && !f.kinds.includes(i.kind)) return false;
    if ((f.incKeys || []).length && !f.incKeys.includes(i.key)) return false;
    if ((f.excKeys || []).includes(i.key)) return false;
    return true;
  }

  // 某隻角色現在會上架哪些東西（面板預覽與頁面執行共用）
  function plan(charId) {
    const db = getDb(), c = cfg(), s = db.chars[charId];
    if (!s) return { entries: [], skipped: [] };
    const entries = [], skipped = [];
    // 沒有指定對象的規則不生效（避免「全部上架」）
    const hasTarget = r => r.target === 'gear'
      ? (() => { const f = r.gearFilter || {}; return (f.slots || []).length || f.name || (f.jobs || []).length || condsPass({ stats: {} }, f.conds) !== null || f.lvMin || f.lvMax || f.plus; })()
      : ((r.ff || {}).kinds || []).length || ((r.ff || {}).incKeys || []).length;
    const rules = c.rules.filter(r => r.on !== false && hasTarget(r) && Number((r.price || {}).floor) > 0);
    const used = new Set();
    for (const r of rules) {
      if (r.target === 'gear') {
        for (const g of s.gear || []) {
          if (g.loc !== '背包' || used.has('g:' + g.uid) || !gearRuleMatch(r, g)) continue;
          if (g.locked) { skipped.push({ name: g.name, why: '已鎖定', rule: r.name }); continue; }
          if (g.tradable === false) { skipped.push({ name: g.name, why: '不可交易', rule: r.name }); continue; }
          used.add('g:' + g.uid);
          const pr = priceFor(r, 'g:' + g.name, 0);
          if (pr.skip) { skipped.push({ name: g.name, why: pr.skip, rule: r.name }); continue; }
          entries.push({ kind: 'gear', uid: g.uid, name: g.name, qty: 1, price: pr.price, why: pr.why, rule: r.name, ref: pr.st && pr.st.min });
        }
      } else {
        for (const i of s.items || []) {
          if (i.loc !== '背包' || used.has(i.key) || !itemRuleMatch(r, i)) continue;
          used.add(i.key);
          if (i.supply) { skipped.push({ name: i.name, why: '補給使用中', rule: r.name }); continue; }
          const can = Math.max(0, (i.tradableQty || 0) - Math.max(0, Number(r.keepQty) || 0));
          if (!can) { skipped.push({ name: i.name, why: r.keepQty ? `保留 ${r.keepQty} 個後沒有可上架數量` : '沒有可交易數量', rule: r.name }); continue; }
          const pr = priceFor(r, i.key, i.sellPrice || 0, i.kind);
          if (pr.skip) { skipped.push({ name: i.name, why: pr.skip, rule: r.name }); continue; }
          const per = Math.min(9999, Math.max(1, Number(r.perListing) || 9999));
          entries.push({ kind: 'item', key: i.key, cat: i.cat, name: i.name, qty: Math.min(can, per), price: pr.price, why: pr.why, rule: r.name, ref: pr.st && pr.st.min });
        }
      }
    }
    const st = M().stalls[charId];
    const room = st ? Math.max(0, MAX_LISTINGS - (st.count || 0)) : MAX_LISTINGS;
    return { mode: c.mode, enabled: !!c.chars[charId], stall: st || null, room, entries: entries.slice(0, room), overflow: Math.max(0, entries.length - room), skipped };
  }

  function summary() {
    tick();
    const m = M(), { items, gear } = watchList();
    const rows = [];
    for (const [key, name] of items) rows.push({ id: key, name, ...stats(key), latest: m.latest[key] || null });
    for (const name of gear) rows.push({ id: 'g:' + name, name, gear: true, ...stats('g:' + name), latest: m.latest['g:' + name] || null });
    return {
      cfg: cfg(), rows,
      scan: { queue: m.queue.length, lease: m.lease ? { name: charName(m.lease.charId), at: m.lease.at, n: m.lease.items.length } : null, lastFull: m.lastFull },
      stalls: Object.entries(m.stalls).map(([cid, s]) => ({ charId: cid, name: charName(cid), ...s })),
      sales: m.sales.slice(-200), log: m.listLog.slice(-100),
    };
  }

  return { claim, report, reportStall, plan, summary, enqueueAll: f => { const n = enqueueAll(f); save(); return n; }, log: e => { log(e); save(); }, cfg };
};
