// 去處規則（v0.71）：每樣掉落物要去哪裡——背包（留著）、商店（撿到就賣）、公倉（留著，之後自動存入）、強化（留著給強化工坊）
// 伺服器（require）和面板（<script src="/dest.js">）共用同一份計算，兩邊算出來的結果一定一樣。
//
// settings.dest = {
//   board: 派工地圖要不要套用（套用派工時把結果設成遊戲的自動販售）,
//   boss:  野王地圖要不要套用（打王的角色到了王的地圖時套用）,
//   rule:  共用規則 { gear, scroll, book, other: 'shop'|'keep', boss: 'keep'|'rule' }（boss＝王會掉的東西一律留著，或照上面的規則）,
//   over:  地圖覆寫 { 地圖: { game: true }＝這張圖沿用遊戲裡自己的設定（中控不動）
//                     | { items: { 道具編號: 'shop'|'keep' }, rest?: 'shop'|'keep' }＝個別調整（rest＝沒列到的道具；舊版的「整張圖個別勾選」轉過來的） },
//   forge: [道具編號]＝送去強化（全部地圖共用，一律留著）,
// }
// 公倉：沿用公倉的存入規則 settings.guildDep（cats 整類、ids 道具編號——派工指定的存在 ids），全部地圖共用，一律留著。
(function (root) {
  const RULE_DEF = { gear: 'shop', scroll: 'keep', book: 'keep', other: 'shop', boss: 'keep' };
  const CATS = ['gear', 'scroll', 'book', 'other'];
  const CAT_NAME = { gear: '裝備', scroll: '卷軸', book: '技能書', other: '其他道具' };
  // 公倉存入規則的整類名稱（跟背包的種類一樣）
  const GUILD_CAT = { gear: '裝備', scroll: '卷軸', book: '技能書' };
  const isScroll = id => Math.floor(Number(id) / 10000) === 204;
  const obj = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const num = a => (Array.isArray(a) ? a.map(Number).filter(n => n > 0) : []);

  function cfg(settings) {
    const d = obj(obj(settings).dest);
    return { board: !!d.board, boss: !!d.boss, rule: { ...RULE_DEF, ...obj(d.rule) }, over: obj(d.over), forge: num(d.forge) };
  }
  function catOf(row, world) {
    if (row[1] === 'gear' || row[1] === 'equip' || Math.floor(Number(row[0]) / 1000000) === 1) return 'gear'; // 裝備的編號是 1 開頭
    if (isScroll(row[0])) return 'scroll';
    const n = (obj(world).names || {})[Number(row[0])];
    if (n && n[1] === '技能書') return 'book';
    return 'other';
  }
  // 每份 world 建一次索引（地圖、怪物、掉落）
  const cache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function index(world) {
    if (cache && cache.has(world)) return cache.get(world);
    const maps = {}, mobs = {};
    for (const m of world.maps || []) maps[String(m.id)] = m;
    for (const m of world.mobs || []) mobs[m.id] = m;
    const ix = { maps, mobs };
    if (cache) cache.set(world, ix);
    return ix;
  }
  function dropsFor(world, map, mob) {
    const md = (world.drops || {})[map.id] || (world.drops || {})[String(map.msId)];
    const special = md && (md[String(mob.msId)] || md[mob.id]);
    return special || (world.mobDrops || {})[String(mob.msId)] || (world.mobDrops || {})[mob.id] || [];
  }
  // 王會掉的道具
  function bossDrops(world, mapId) {
    const ix = index(world), m = ix.maps[String(mapId)], set = new Set();
    if (!m || !(m.boss || []).length) return set;
    const boss = new Set(m.boss);
    for (const r of rowsOf(world, mapId)) if (Array.isArray(r[6]) && r[6].some(id => boss.has(id))) set.add(Number(r[0]));
    for (const id of m.boss) { const mob = ix.mobs[id]; if (mob) for (const r of dropsFor(world, m, mob)) if (Number(r[0])) set.add(Number(r[0])); }
    return set;
  }
  const rowsOf = (world, mapId) => (obj(world).autoSellDrops || {})[String(mapId)] || [];
  const isBossMap = (world, mapId) => { const m = index(world).maps[String(mapId)]; return !!(m && (m.boss || []).length); };
  function guildOf(settings) {
    const g = obj(obj(settings).guildDep);
    return { ids: new Set(num(g.ids)), cats: new Set(Array.isArray(g.cats) ? g.cats : []) };
  }
  // 一張圖每樣掉落物的去處
  // 回傳 { rows, cats:{id:cat}, dest:{id:'bag'|'shop'|'guild'|'forge'}, from:{id:'rule'|'map'|'guild'|'forge'|'boss'}, sell:[可以賣、要賣的], game, over, bd }
  function calc(world, settings, mapId) {
    const c = cfg(settings), g = guildOf(settings), forge = new Set(c.forge);
    const rows = rowsOf(world, mapId), ov = obj(c.over[String(mapId)]);
    const bd = isBossMap(world, mapId) ? bossDrops(world, mapId) : new Set();
    const items = obj(ov.items), dest = {}, from = {}, cats = {}, sell = [];
    for (const r of rows) {
      const id = Number(r[0]), cat = catOf(r, world); cats[id] = cat;
      let keep, src;
      if (forge.has(id)) { dest[id] = 'forge'; from[id] = 'forge'; continue; }
      if (g.ids.has(id)) { dest[id] = 'guild'; from[id] = 'guild'; continue; }
      if (items[id] === 'shop' || items[id] === 'keep') { keep = items[id] === 'keep'; src = 'map'; }
      else if (ov.rest === 'shop' || ov.rest === 'keep') { keep = ov.rest === 'keep'; src = 'map'; }
      else if (bd.has(id) && c.rule.boss === 'keep') { keep = true; src = 'boss'; }
      else { keep = c.rule[cat] !== 'shop'; src = 'rule'; }
      if (!keep && !r[4]) keep = true; // 不能賣的東西一定留著
      if (keep) dest[id] = GUILD_CAT[cat] && g.cats.has(GUILD_CAT[cat]) ? 'guild' : 'bag';
      else { dest[id] = 'shop'; sell.push(id); }
      from[id] = src;
    }
    return { rows, cats, dest, from, sell, bd, game: !!ov.game, over: !!(ov.game || ov.rest || Object.keys(items).length) };
  }
  // 要送給遊戲的自動販售設定；null＝不動遊戲裡那張圖的設定（沒開、這張圖沿用遊戲設定、沒有掉落資料）
  // ctx：'board'（套用派工）或 'boss'（打王到了王的地圖）
  function sellOf(world, settings, mapId, ctx) {
    const c = cfg(settings);
    if (!mapId || !(ctx === 'boss' ? c.boss : c.board)) return null;
    const x = calc(world, settings, mapId);
    if (x.game || !x.rows.length) return null;
    const ids = x.sell.slice(0, 500);
    return { enabled: ids.length > 0, itemIds: ids };
  }
  // 舊設定轉過來（v0.71 第一次啟動）：野王掉落篩選、派工每張圖的販售範本 → 去處規則；結果跟原本會賣的東西一樣
  // 原本沒設定販售範本的派工地圖 → 沿用遊戲設定（中控不會動它）
  function migrate(settings, now) {
    const s = obj(settings), b = obj(s.boss), bs = obj(b.sell), over = {};
    const explicit = ids => ({ items: Object.fromEntries(num(ids).map(id => [id, 'shop'])), rest: 'keep' });
    for (const [m, x] of Object.entries(obj(bs.over))) if (x && Array.isArray(x.itemIds)) over[m] = explicit(x.itemIds);
    const boards = { A: obj(s.board), ...obj(s.boards) };
    let boardHas = false;
    for (const g of ['A', 'B']) for (const [m, x] of Object.entries(obj(obj(boards[g]).sell))) {
      if (!x) continue; boardHas = true;
      over[m] = x.enabled ? explicit(x.itemIds) : { items: {}, rest: 'keep' };
    }
    for (const g of ['A', 'B']) for (const l of Object.values(obj(obj(boards[g]).lanes))) for (const m of Array.isArray(l) ? l : []) if (!over[m]) over[m] = { game: true };
    const r = obj(bs.rule), rule = { ...RULE_DEF };
    for (const k of CATS) if (r[k] === 'sell' || r[k] === 'keep') rule[k] = r[k] === 'sell' ? 'shop' : 'keep';
    if (r.boss === 'keep' || r.boss === 'rule') rule.boss = r.boss;
    return { board: boardHas, boss: !!bs.on, rule, over, forge: [], migratedAt: now || Date.now() };
  }
  const api = { RULE_DEF, CATS, CAT_NAME, GUILD_CAT, cfg, calc, sellOf, migrate, catOf, bossDrops, isBossMap, guildOf };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.SZGDest = api;
})(typeof window !== 'undefined' ? window : this);
