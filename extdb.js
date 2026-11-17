// 外部資料庫：上漲谷｜冒險資料庫（https://dong811205.github.io/szg-database/）
// 由中控伺服器在執行時下載，存成精簡版 data/extdb.json；本專案不附帶這份資料。
// 提供：知識王／智慧王題庫（合併進自動作答，優先順序最低）、道具與怪物的圖示、需求、說明。
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'https://dong811205.github.io/szg-database/data/database.json';
const IMG_ITEM = id => `https://play.szg08.com/game/drops/${id}.png`;
const IMG_MOB = id => `https://play.szg08.com/legacy/assets/world/mob_${id}.png`;
const GAME = 'https://play.szg08.com/';
// 圖片位址：遊戲站內的只存相對路徑（面板再補上前綴），其他（內嵌 base64 等）原樣保存
const shortImg = u => !u ? '' : u.startsWith(GAME) ? u.slice(GAME.length) : u;

module.exports = function makeExtDb(dataDir, getSettings, log) {
  const FILE = path.join(dataDir, 'extdb.json');
  let cache = null, cacheText = null, busy = null;

  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { cache = null; }
    return cache;
  }

  function compact(db) {
    const items = {};
    for (const i of db.items || []) {
      if (i == null || i.id == null) continue;
      const o = { n: i.name, t: i.type };
      if (i.detail) o.d = i.detail;
      if (i.level) o.lv = i.level;
      if (i.slots) o.sl = i.slots;
      if (i.job && i.job !== '全職業') o.job = i.job;
      if (i.gender && i.gender !== '男女通用') o.g = i.gender;
      if (i.equipCategory) o.c = i.equipCategory;
      if (i.rate) o.r = i.rate;
      if (i.description) o.desc = String(i.description).slice(0, 300);
      const req = {};
      for (const [k, v] of Object.entries(i.requirements || {})) if (v && k !== 'reqJob') req[k.replace(/^req/, '')] = v;
      if (Object.keys(req).length) o.req = req;
      const img = ((db.images && db.images.items) || {})[i.id] || i.image;
      if (img && img !== IMG_ITEM(i.id)) o.img = shortImg(img); // 不是預設 drops/<id>.png 的才存
      else if (!img) o.noimg = 1;
      items[i.id] = o;
    }
    const mobImg = (db.images && db.images.mobs) || {};
    const mobs = {};
    for (const [id, m] of Object.entries(db.mobs || {})) {
      const o = { n: m.name, lv: m.level, hp: m.hp, xp: m.xp };
      if (m.maps && m.maps.length) o.maps = m.maps.slice(0, 12);
      const img = mobImg[id] || m.image;
      if (img && img !== IMG_MOB(id)) o.img = shortImg(img); else if (!img) o.noimg = 1;
      mobs[id] = o;
    }
    const quiz = [];
    for (const kind of ['knowledge', 'wisdom']) {
      for (const e of ((db.quiz || {})[kind]) || []) {
        if (!Array.isArray(e) || !e[0] || !Array.isArray(e[1])) continue;
        const a = e[1][e[2]];
        if (a == null || e[3] === false) continue; // 沒有答案或標記未驗證的不收
        quiz.push({ q: String(e[0]), options: e[1].map(String), answer: String(a), kind, cat: e[4] || '', note: e[5] || '' });
      }
    }
    return { source: getSettings().extDbUrl || DEFAULT_URL, fetchedAt: Date.now(), meta: db.meta || {}, items, mobs, quiz };
  }

  async function refresh(why = '手動') {
    if (busy) return busy;
    busy = (async () => {
      const url = getSettings().extDbUrl || DEFAULT_URL;
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('下載失敗 HTTP ' + r.status);
      const db = await r.json();
      if (!db || !Array.isArray(db.items)) throw new Error('資料格式不符（沒有 items）');
      const c = compact(db);
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(c));
      fs.renameSync(FILE + '.tmp', FILE);
      cache = c; cacheText = null;
      log && log(`冒險資料庫已更新（${why}）：道具 ${Object.keys(c.items).length}、怪物 ${Object.keys(c.mobs).length}、題目 ${c.quiz.length}`);
      return status();
    })().finally(() => { busy = null; });
    return busy;
  }

  function status() {
    const c = load();
    return c ? { ok: true, source: c.source, fetchedAt: c.fetchedAt, dataDate: c.meta.lastUpdated || c.meta.date || '', items: Object.keys(c.items).length, mobs: Object.keys(c.mobs).length, quiz: c.quiz.length }
      : { ok: false, source: getSettings().extDbUrl || DEFAULT_URL };
  }

  // 給面板用：道具＋怪物（不含題庫，題庫走 /api/quiz）
  function forDashboard() {
    const c = load();
    if (!c) return '{"items":{},"mobs":{}}';
    if (!cacheText) cacheText = JSON.stringify({ fetchedAt: c.fetchedAt, items: c.items, mobs: c.mobs });
    return cacheText;
  }

  function quizList() { const c = load(); return (c && c.quiz) || []; }

  // 啟動後與每 24 小時自動更新一次（沒開就不下載）
  function schedule() {
    const tick = () => {
      if (getSettings().extDbAuto === false) return;
      const c = load();
      if (c && Date.now() - c.fetchedAt < 23.5 * 3600e3) return;
      refresh('自動').catch(e => log && log('冒險資料庫更新失敗：' + e.message));
    };
    setTimeout(tick, 15000);
    setInterval(tick, 3600e3);
  }

  return { refresh, status, forDashboard, quizList, schedule };
};
