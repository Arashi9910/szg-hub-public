// ==UserScript==
// @name         上漲谷中控 - 資料回報
// @namespace    szg-hub
// @version      0.7.0
// @description  回報角色資料到中控面板；執行你在面板上確認過的工作（交易、背包）。功能程式由中控伺服器提供。
// @match        https://play.szg08.com/game/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-start
// @require      http://127.0.0.1:8787/agent.js
// @updateURL    http://127.0.0.1:8787/szg-hub.user.js
// @downloadURL  http://127.0.0.1:8787/szg-hub.user.js
// ==/UserScript==

// 結構：
//   這個檔案只是「載入器」，真正的功能在 agent.js，由 Tampermonkey 用 @require 從中控伺服器下載。
//   把 Tampermonkey 設定「Externals → Update Interval」改成「Always」後，
//   每次載入頁面都會拿到伺服器上最新的 agent.js；伺服器有新版時，頁面會自動重新整理。

(function () {
  'use strict';

  const HUB = 'http://127.0.0.1:8787';
  const TOKEN = ''; // 保留欄位，不需要填
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  const shared = { eligible: null }; // 伺服器給的可交易清單 { items:Set, gear:Set }

  // ---------- 攔截遊戲自己的同步回應，取得「可交易清單」（要在 document-start 就裝好） ----------
  try {
    const origFetch = W.fetch;
    W.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const u = String((input && input.url) || input);
        if (u.includes('/api/game')) {
          p.then(r => r.clone().json()).then(j => {
            if (j && j.tradeEligible && Array.isArray(j.tradeEligible.items)) {
              shared.eligible = { items: new Set(j.tradeEligible.items), gear: new Set(j.tradeEligible.gear || []), at: Date.now() };
            }
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };
  } catch (e) { console.warn('[szg-hub] fetch hook failed', e); }

  // 功能程式沒載入（例如 Tampermonkey 剛好在伺服器重啟時下載失敗）：顯示紅色提示，60 秒後自動重整，最多 3 次
  if (typeof agentMain !== 'function') {
    const tries = GM_getValue('missingAgentTries', 0);
    const show = text => {
      const put = () => {
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;font:12px sans-serif;padding:3px 8px;border-radius:10px;background:#8a2b2b;color:#fff;max-width:360px';
        el.textContent = text;
        document.body.appendChild(el);
      };
      if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
    };
    if (tries < 3) {
      GM_setValue('missingAgentTries', tries + 1);
      show(`中控：功能程式沒載入，60 秒後自動重試（${tries + 1}/3）`);
      setTimeout(() => location.reload(), 60 * 1000);
    } else {
      show('中控：功能程式一直載入失敗。請確認中控伺服器有開，並打開 http://127.0.0.1:8787/szg-hub.user.js 重新安裝腳本');
    }
    console.warn('[szg-hub] 沒有載入到 agent.js');
    return;
  }
  GM_setValue('missingAgentTries', 0);

  // 每次重整都沒拿到新版時，記錄下來回報給面板（代表 Tampermonkey 的 @require 還在用快取）
  const hdr = TOKEN ? { 'X-Hub-Token': TOKEN } : {};
  const pendingKey = 'reloadFor';
  const pending = GM_getValue(pendingKey, null); // { version, tries }
  const runningVersion = (String(agentMain).match(/const AGENT_VERSION = '([^']+)'/) || [])[1] || '?';
  let mode = 'require';
  if (pending && pending.version !== runningVersion && pending.tries >= 2) mode = 'stale';
  if (pending && pending.version === runningVersion) GM_setValue(pendingKey, null);

  const running = agentMain({ GM_xmlhttpRequest, GM_getValue, GM_setValue, W, HUB, TOKEN, shared, mode });

  // 每 2 分鐘檢查伺服器上的版本；有新版而且沒有工作在跑，就重新整理頁面（同一版最多試 2 次）
  setInterval(() => {
    GM_xmlhttpRequest({
      method: 'GET', url: HUB + '/api/agent-version?t=' + Date.now(), headers: hdr, timeout: 5000,
      onload: r => {
        try {
          const v = JSON.parse(r.responseText).version;
          if (!v || v === running.version || running.isBusy()) return;
          const p = GM_getValue(pendingKey, null);
          const tries = p && p.version === v ? p.tries : 0;
          if (tries >= 2) return; // Tampermonkey 還在用快取，不要一直重整
          GM_setValue(pendingKey, { version: v, tries: tries + 1 });
          console.log(`[szg-hub] 偵測到新版 ${v}，重新整理頁面（第 ${tries + 1} 次）`);
          location.reload();
        } catch (_) {}
      },
    });
  }, 2 * 60 * 1000);
})();
