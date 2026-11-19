/**
 * 上漲谷中控・共享知識王題庫（Google Apps Script，貼在一份 Google 試算表的「擴充功能 → Apps Script」）
 *
 * 部署：部署 → 新增部署作業 → 類型「網頁應用程式」→ 執行身分「我」、誰可以存取「所有人」→ 部署 → 複製 /exec 結尾的網址
 * 更新程式後：部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署（網址不變）
 *
 * 試算表「題庫」分頁一列一題：
 *   key｜題目｜選項｜答案｜票數｜投票紀錄｜停用｜更新時間
 *   - 每個中控（匿名編號）對同一題只算一票；同一題有不同答案時，以最多不同中控回報的為準，同票就先不提供
 *   - 「停用」欄填任何字（例如 x）＝這題不再提供（題目錯了、被亂答時用）
 * 中控只上傳遊戲公布的正確答案（每題答完遊戲會告訴你正解），不上傳角色名稱、帳號
 */
const SHEET = '題庫';
const HEAD = ['key', '題目', '選項', '答案', '票數', '投票紀錄', '停用', '更新時間'];
const MAX_ITEMS = 300;          // 每次最多收幾題
const RATE = 40;                // 每個中控每 10 分鐘最多送幾次

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) { sh = ss.insertSheet(SHEET); sh.appendRow(HEAD); sh.setFrozenRows(1); sh.setColumnWidth(2, 360); sh.setColumnWidth(6, 200); }
  return sh;
}
const out_ = obj => ContentService.createTextOutput(typeof obj === 'string' ? obj : JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
const str_ = (v, n) => String(v == null ? '' : v).slice(0, n);

// 下載合併後的題庫（快取 5 分鐘）
function doGet() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('bank_n') || 0);
  if (n) { const parts = cache.getAll(Array.from({ length: n }, (_, i) => 'bank_' + i)); if (Object.keys(parts).length === n) return out_(Array.from({ length: n }, (_, i) => parts['bank_' + i]).join('')); }
  const json = JSON.stringify(build_());
  const size = 90000, chunks = {};
  for (let i = 0; i * size < json.length; i++) chunks['bank_' + i] = json.slice(i * size, (i + 1) * size);
  try { cache.putAll(chunks, 300); cache.put('bank_n', String(Object.keys(chunks).length), 300); } catch (e) {}
  return out_(json);
}
function build_() {
  const rows = sheet_().getDataRange().getValues().slice(1), items = [];
  for (const r of rows) {
    if (!r[0] || String(r[6]).trim()) continue;
    const votes = parse_(r[5]), ranked = Object.entries(votes).map(([a, ids]) => [a, ids.length]).sort((x, y) => y[1] - x[1]);
    if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) continue; // 同票：先不提供
    let options = []; try { options = JSON.parse(r[2]); } catch (e) {}
    items.push({ q: String(r[1]), options, answer: ranked[0][0], n: ranked[0][1] });
  }
  return { v: 1, at: Date.now(), count: items.length, items };
}
const parse_ = s => { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } };

// 上傳：{ install, items: [{ key, q, options, answer }] }
function doPost(e) {
  let body; try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  const install = str_(body && body.install, 64);
  if (!/^[a-f0-9]{16,64}$/.test(install)) return out_({ ok: false, error: 'bad install' });
  const cache = CacheService.getScriptCache(), rk = 'rl_' + install, used = Number(cache.get(rk) || 0);
  if (used >= RATE) return out_({ ok: false, error: 'rate limited' });
  cache.put(rk, String(used + 1), 600);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_ITEMS).map(x => ({
    key: str_(x && x.key, 300), q: str_(x && x.q, 300), answer: str_(x && x.answer, 120),
    options: Array.isArray(x && x.options) ? x.options.slice(0, 8).map(o => str_(o, 120)) : [],
  })).filter(x => x.key && x.q && x.answer && x.options.length >= 2 && x.options.includes(x.answer));
  if (!items.length) return out_({ ok: true, added: 0, voted: 0 });
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = sheet_(), data = sh.getDataRange().getValues(), idx = {};
    for (let i = 1; i < data.length; i++) if (data[i][0]) idx[data[i][0]] = i;
    let added = 0, voted = 0; const now = new Date();
    for (const x of items) {
      let i = idx[x.key];
      if (i == null) { data.push([x.key, x.q, JSON.stringify(x.options), '', 0, '{}', '', now]); i = idx[x.key] = data.length - 1; added++; }
      const row = data[i], votes = parse_(row[5]);
      if ((votes[x.answer] || []).includes(install)) continue;
      for (const a of Object.keys(votes)) votes[a] = votes[a].filter(id => id !== install); // 同一個中控改答案：只算最新的
      (votes[x.answer] = votes[x.answer] || []).push(install);
      const ranked = Object.entries(votes).filter(([, ids]) => ids.length).sort((p, q) => q[1].length - p[1].length);
      row[3] = ranked[0][0]; row[4] = ranked[0][1].length; row[5] = JSON.stringify(Object.fromEntries(ranked)); row[7] = now; voted++;
    }
    sh.getRange(1, 1, data.length, HEAD.length).setValues(data.map(r => HEAD.map((_, c) => r[c] == null ? '' : r[c])));
    cache.remove('bank_n');
    return out_({ ok: true, added, voted });
  } finally { lock.releaseLock(); }
}
