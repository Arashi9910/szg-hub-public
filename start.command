#!/bin/bash
# 上漲谷中控（Mac）：雙擊這個檔案啟動。第一次如果被擋，到「系統設定 → 隱私權與安全性」按「強制打開」，
# 或在「終端機」執行：chmod +x start.command 之後再雙擊。
cd "$(dirname "$0")" || exit 1
export SZG_LAUNCHER=start.command
if ! command -v node >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin; do [ -x "$p/node" ] && export PATH="$p:$PATH"; done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[錯誤] 找不到 Node.js，請到 https://nodejs.org 下載安裝 LTS 版後再雙擊一次。"
  read -r -p "按 Enter 關閉…"; exit 1
fi
echo "使用：$(command -v node)（$(node -v)）"
(sleep 2; open "http://127.0.0.1:8787") &
while true; do
  node update.js
  node server.js
  code=$?
  if [ "$code" -eq 3 ]; then echo "已更新，重新啟動…"; continue; fi
  break
done
echo
echo "中控已停止。如果上面有錯誤訊息，請截圖。"
read -r -p "按 Enter 關閉…"
