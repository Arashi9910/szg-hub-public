// 上漲谷中控 - 自動更新（從 GitHub 下載最新版）
// 直接執行：node update.js        → 有新版就更新
// 被 server.js 載入：check() / apply()
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OWNER_REPO = 'Arashi9910/szg-hub-public';
const TEST_URL = process.env.SZG_UPDATE_URL || ''; // 測試用：指定一個本機網址取代 GitHub
const API_HEAD = `https://api.github.com/repos/${OWNER_REPO}/commits/main`;
const rawBase = ref => TEST_URL || `https://raw.githubusercontent.com/${OWNER_REPO}/${ref}/`;
const DIR = __dirname;
const LOCAL_MANIFEST = path.join(DIR, 'version.json');
// .bat 不自動更新：Windows 執行中的 .bat 被覆蓋會出錯
const NEVER_UPDATE = new Set(['start.bat']);

function localVersion() {
  try { return JSON.parse(fs.readFileSync(LOCAL_MANIFEST, 'utf8')).version || '0.0.0'; } catch (_) { return '0.0.0'; }
}

function newer(a, b) { // a > b ?
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// 先向 GitHub API 取得 main 最新的提交編號（不受快取影響），再用編號下載檔案，避免拿到快取中的舊版。
// API 失敗（例如每小時次數用完）時退回直接下載 main。
async function latestRef() {
  if (TEST_URL) return 'main';
  try {
    const r = await fetch(API_HEAD, { headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'szg-hub-updater' }, cache: 'no-store' });
    if (r.ok) { const sha = (await r.text()).trim(); if (/^[0-9a-f]{40}$/.test(sha)) return sha; }
  } catch (_) {}
  return 'main';
}

async function get(file, ref) {
  const r = await fetch(rawBase(ref) + file + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(`下載 ${file} 失敗（HTTP ${r.status}）`);
  return Buffer.from(await r.arrayBuffer());
}

async function check() {
  const ref = await latestRef();
  const remote = JSON.parse((await get('version.json', ref)).toString('utf8'));
  const current = localVersion();
  return { current, latest: remote.version, notes: remote.notes || '', hasUpdate: newer(remote.version, current), remote, ref };
}

async function apply() {
  const info = await check();
  if (!info.hasUpdate) return { updated: false, ...info };
  const files = (info.remote.files || []).filter(f => !NEVER_UPDATE.has(f) && !f.includes('..') && !path.isAbsolute(f));
  const stage = path.join(DIR, '.update-tmp');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  // 1) 全部下載到暫存資料夾
  for (const f of files) {
    const buf = await get(f, info.ref);
    if (!buf.length) throw new Error(`${f} 是空檔案，取消更新`);
    fs.writeFileSync(path.join(stage, f), buf);
  }
  // 2) JS 檔先做語法檢查，有錯就不套用
  for (const f of files.filter(f => f.endsWith('.js') && !f.endsWith('.user.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(stage, f)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${f} 語法檢查失敗，取消更新：${(r.stderr || '').split('\n')[0]}`);
  }
  // 3) 備份目前版本
  const backup = path.join(DIR, 'backup', info.current);
  fs.mkdirSync(backup, { recursive: true });
  for (const f of [...files, 'version.json']) {
    const src = path.join(DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backup, f));
  }
  // 4) 覆蓋
  for (const f of files) fs.copyFileSync(path.join(stage, f), path.join(DIR, f));
  fs.writeFileSync(LOCAL_MANIFEST, JSON.stringify(info.remote, null, 2));
  fs.rmSync(stage, { recursive: true, force: true });
  return { updated: true, ...info };
}

module.exports = { check, apply, localVersion };

if (require.main === module) {
  (async () => {
    try {
      const r = await apply();
      if (r.updated) console.log(`已更新：${r.current} → ${r.latest}${r.notes ? '\n更新內容：' + r.notes : ''}`);
      else console.log(`目前是最新版（${r.current}）`);
    } catch (e) {
      console.log('略過自動更新：' + e.message);
    }
  })();
}
