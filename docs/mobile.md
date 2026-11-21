# 手機版安裝教學（上漲谷中控 v0.53 起）

這份教學說明怎麼讓手機連回家裡電腦上的「上漲谷中控」，用手機看角色狀態、開始／暫停掛機、換圖、確認工作、切換打王、套用組隊。

> 可以自己照著做，也可以把這一頁的網址貼給 AI 助手（ChatGPT、Claude 等），請它一步一步帶你做。最下面有一段「給 AI 助手的說明」。

---

## 它是怎麼運作的

```
手機（瀏覽器／主畫面圖示）
   │  HTTPS，只在你自己的 Tailscale 私人網路裡
   ▼
家裡電腦：Tailscale（tailscale serve）──轉送──▶ 中控 http://127.0.0.1:8787
                                                     ▲
                                          遊戲分頁（Chrome＋Tampermonkey）照常回報
```

- **遊戲、掛機、腳本都還是在家裡電腦跑**，手機只是遙控器。電腦要開著、中控視窗要開著。
- 手機透過 **Tailscale** 連回家裡電腦。Tailscale 是免費的私人網路服務：只有登入**同一個 Tailscale 帳號**的裝置能互相連線，**中控不會開放到網際網路上**。
- 每支手機配對時會拿到自己的一組配對碼，可以在電腦上個別移除。

## 你需要準備

| 項目 | 說明 |
|---|---|
| 家裡電腦 | 中控已經能正常使用（瀏覽器打開 `http://127.0.0.1:8787` 看得到面板），版本 v0.53 以上 |
| 手機 | iPhone（iOS 16.4 以上較好）或 Android |
| Tailscale 帳號 | 免費。可以用 Google、Microsoft、Apple、GitHub 帳號登入 |
| 時間 | 第一次大約 10～15 分鐘 |

---

## 步驟 1：電腦安裝 Tailscale

1. 到 <https://tailscale.com/download> 下載電腦版。
   - **Windows**：下載 Windows 版安裝檔，一直按下一步安裝。
   - **macOS**：建議下載官網的「Standalone」版本（指令比較好用）；App Store 版也可以。
2. 安裝完會跳出登入畫面（或點右下角／右上角工作列的 Tailscale 圖示 →「Log in」），選一種帳號登入。**記住你用的是哪個帳號，手機要用同一個。**
3. 登入後工作列的 Tailscale 圖示會變成「Connected（已連線）」。

**確認**：打開命令提示字元（Windows：按開始鍵，輸入 `cmd`，按 Enter）輸入：

```
tailscale status
```

看到第一行有你這台電腦的名稱和一個 `100.x.x.x` 的位址，就代表成功。

> 如果顯示「'tailscale' 不是內部或外部命令」：Windows 請改用完整路徑 `"C:\Program Files\Tailscale\tailscale.exe" status`；macOS 用 `/Applications/Tailscale.app/Contents/MacOS/Tailscale status`。後面所有 `tailscale` 指令都一樣可以這樣換。

## 步驟 2：手機安裝 Tailscale

1. **iPhone**：App Store 搜尋「Tailscale」安裝。**Android**：Google Play 搜尋「Tailscale」安裝。
2. 打開 App，用**和電腦同一個帳號**登入。
3. 第一次會問「要不要新增 VPN 設定」，請按**允許**（Tailscale 是用 VPN 的方式連線，只會轉送到你自己的裝置，不會影響一般上網）。
4. App 裡的開關打開（Connected），清單裡應該看得到你家裡電腦的名稱。

## 步驟 3：在 Tailscale 後台開啟 HTTPS

手機要「加到主畫面」像 App 一樣使用，需要 HTTPS 網址。Tailscale 可以免費自動幫你的電腦申請 HTTPS 憑證。

1. 用電腦打開 Tailscale 後台的 DNS 頁面：<https://login.tailscale.com/admin/dns>
2. 確認 **MagicDNS** 是開啟的（Enabled）。沒開的話按「Enable MagicDNS」。
3. 往下找到 **HTTPS Certificates**，按 **Enable HTTPS**，看完說明後確認。
   - 新建立的 Tailscale 帳號通常這兩項已經是開的。
   - 開啟後，你電腦的名稱會出現在 Tailscale 的憑證公開紀錄裡（例如 `my-pc.tailxxxx.ts.net`）。這只是名稱，別人還是連不進你的網路；介意的話可以先到 <https://login.tailscale.com/admin/machines> 把電腦改成不透露身分的名稱。

## 步驟 4：讓中控用 HTTPS 給手機連（tailscale serve）

這一步只要做**一次**，之後重開機也會一直有效。

**Windows**
1. 按開始鍵，輸入 `cmd`。
2. 在「命令提示字元」上按右鍵 →「**以系統管理員身分執行**」。
3. 輸入下面這行，按 Enter：
   ```
   tailscale serve --bg 8787
   ```

**macOS**（終端機）
```
tailscale serve --bg 8787
```
（Standalone 版沒有 `tailscale` 指令時，用 `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 8787`）

**會看到什麼**
- 成功時會顯示類似：
  ```
  Available within your tailnet:

  https://my-pc.tailxxxx.ts.net/
  |-- proxy http://127.0.0.1:8787

  Serve started and running in the background.
  ```
  記下這個 `https://…ts.net` 網址。
- 如果顯示一個 `https://login.tailscale.com/...` 的網址並停住：代表步驟 3 還沒完成。打開那個網址按同意（Enable），回到命令視窗它就會繼續。

**確認**
1. 在電腦輸入 `tailscale serve status`，應該看到 `https://…ts.net` 轉到 `http://127.0.0.1:8787`。
2. 用電腦或手機的瀏覽器打開 `https://你的電腦名稱.tailxxxx.ts.net/m`，看到「📱 還沒有配對」的畫面就代表連線成功（這時候還看不到資料是正常的）。

> ⚠️ 請用 `tailscale serve`，**不要**用 `tailscale funnel`。funnel 會把中控公開到整個網際網路。

## 步驟 5：配對手機

1. 在家裡電腦打開中控面板（`http://127.0.0.1:8787`），按右上角的「**📱 手機**」。
2. 「手機要連的網址」應該已經自動填好 `https://你的電腦名稱.tailxxxx.ts.net`，並顯示「✓ 已設定 HTTPS（tailscale serve）」。
   - 如果顯示「還沒偵測到 tailscale serve」，回到步驟 4。
   - 網址是空的或不對，可以自己貼上步驟 4 看到的網址。
3. 填一個裝置名稱（例如「我的 iPhone」），按「**新增這支手機**」。
4. 畫面出現 QR code。用**手機的相機**對準它，點跳出來的網址。
   - QR code 只顯示這一次，關掉就看不到了。沒掃到的話再按一次「新增這支手機」，多出來的那筆在下面清單按「移除」。
5. 手機瀏覽器打開後，應該看到你所有角色的卡片。

## 步驟 6：加到主畫面

在**剛剛掃 QR code 打開的那個頁面**操作：

- **iPhone**：要用 **Safari** 打開（用其他瀏覽器的話，把網址複製到 Safari）。按下方的「分享」按鈕 →「**加入主畫面**」→「新增」。
- **Android**：用 **Chrome** 打開，按右上角「⋮」→「**加到主畫面**」（或「安裝應用程式」）→「新增」。

之後從主畫面的「上漲谷」圖示打開，就會像 App 一樣全螢幕顯示。

---

## 日常使用

底部有五個分頁：

| 分頁 | 可以做的事 |
|---|---|
| 角色 | 每隻角色的全身照、等級、地圖、近 3 分鐘經驗、掛機剩多久；最上面列出需要處理的事（倒下、沒在掛機、待確認或失敗的工作）。點角色：開始／暫停／重新開始掛機、領取離線收益、換圖、切換為目前角色。「多選」可以一次操作好幾隻 |
| 工作 | 待確認的工作可以確認或取消；失敗的可以重試或刪除；全部確認、清除已完成 |
| 打王 | 切換關閉／試跑／自動出發；看正在打的王血條；幫每隻角色勾要打的王 |
| 組隊 | 看隊伍是「已就位」還是「要套用」，一鍵套用（隊伍成員要先在電腦的「組隊」分頁排好） |
| 更多 | 版本、最近的掛機紀錄、開電腦版面板、登出這支手機 |

- 畫面在前景時每 10 秒自動更新，右上角 ↻ 可以馬上更新。
- 停止掛機、換圖、確認工作、開啟自動打王這類操作，都會先跳出確認。

## 安全

- 只有登入你 Tailscale 帳號的裝置連得到；中控本身只接受本機連線，Tailscale 是幫它轉送。
- 每支手機各自一組配對碼。電腦面板的「📱 手機」可以看到每支最後使用的時間，**手機遺失就按「移除」**，那支手機馬上就不能用了。
- 新增／移除手機、更新中控，只能在家裡電腦上操作，手機做不到。
- 不要把 QR code 下面那串網址傳給別人，它就是那支手機的配對碼。

---

## 疑難排解

| 狀況 | 可能原因 | 解決方法 |
|---|---|---|
| 手機打開網址轉圈圈、顯示無法連線 | 手機的 Tailscale 沒開；電腦關機或睡眠；中控視窗沒開 | 手機打開 Tailscale App 確認是 Connected；電腦開著、中控視窗開著；電腦的睡眠設定改成不睡眠 |
| 手機顯示「還沒有配對」 | 還沒掃 QR；或配對已被移除 | 回到步驟 5 新增一次 |
| **加到主畫面後**顯示「還沒有配對」 | 主畫面的 App 和瀏覽器是分開的儲存空間 | 刪掉主畫面圖示，重新掃 QR 後在瀏覽器裡再加一次；或在「還沒有配對」畫面下方貼上電腦 QR code 下面的網址按「配對」 |
| 「📱 手機」顯示「還沒偵測到 tailscale serve」 | 步驟 4 沒成功 | 用系統管理員身分重新執行 `tailscale serve --bg 8787`，再用 `tailscale serve status` 確認 |
| `tailscale serve` 一直停在 login.tailscale.com 網址 | HTTPS 還沒開 | 打開那個網址按同意，或照步驟 3 開啟 |
| 「找不到 Tailscale 的機器名稱」 | 電腦的 Tailscale 沒登入，或 `tailscale` 指令找不到 | 確認工作列的 Tailscale 是 Connected；或直接把步驟 4 的網址貼進「手機要連的網址」 |
| 瀏覽器顯示憑證錯誤 | 憑證剛申請、還沒好 | 等 1～2 分鐘再重新整理 |
| 角色卡片沒有全身照 | 遊戲分頁還沒上傳 | 遊戲分頁開著約 1 分鐘後就會有 |
| 手機上看得到但按了沒反應 | 那隻角色沒有自己的遊戲分頁 | 在電腦開那隻角色的分頁，或在手機上先「切換為目前角色」 |

## 不想用了、要關掉

1. 在電腦執行（Windows 用系統管理員身分）：
   ```
   tailscale serve reset
   ```
   這會關掉 HTTPS 轉送，手機就連不到了。
2. 中控面板「📱 手機」把所有裝置按「移除」。
3. 手機刪掉主畫面圖示，要的話也可以刪掉 Tailscale App。

---

## 給 AI 助手的說明

> 如果你是協助使用者安裝的 AI 助手，以下是這個專案的事實，請依此引導，不要另外發明做法。

- 專案：上漲谷中控（szg-hub-public），Node.js 單檔伺服器 `server.js`，**只聽 `127.0.0.1:8787`**（不要改成 0.0.0.0，也不要開路由器的連接埠）。
- 手機版網址路徑是 `/m`（檔案 `m.html`）。手機連線方式**只支援** Tailscale 的 `tailscale serve --bg 8787`（HTTPS 反向代理到 127.0.0.1:8787），**不要**用 `tailscale funnel`（會公開到網際網路）。
- 伺服器用 `X-Forwarded-For`／`X-Forwarded-Proto`／`Tailscale-User-Login` 標頭判斷請求是經過 serve 轉送的，這類請求一律要帶手機配對碼（`X-Hub-Token` 標頭或 `?token=`）。本機直接連線不用。
- 配對只能在家裡電腦的面板做：右上角「📱 手機」→「新增這支手機」→ 產生 QR code，內容是 `https://<電腦的 MagicDNS 名稱>/m#t=<配對碼>`。配對碼存在電腦的 `data/state.json`（`mDevices`），可在同一個地方移除。
- `tailscale serve` 的前提：tailnet 開啟 MagicDNS 與 HTTPS Certificates（<https://login.tailscale.com/admin/dns>）。`--bg` 會寫入設定，重開機後仍有效；`tailscale serve status` 查看，`tailscale serve reset` 移除。Windows 指令要用系統管理員身分的命令提示字元，找不到指令時用 `"C:\Program Files\Tailscale\tailscale.exe"`。
- 驗證順序：① 電腦 `http://127.0.0.1:8787` 看得到面板 → ② `tailscale status` 有 100.x 位址 → ③ `tailscale serve status` 有轉到 127.0.0.1:8787 → ④ 手機（Tailscale 已連線）打開 `https://<名稱>.ts.net/m` 看到「還沒有配對」→ ⑤ 掃 QR 後看到角色卡片。
- 常見問題見上面「疑難排解」。iPhone「加到主畫面」要用 Safari。
- 官方參考：Tailscale Serve <https://tailscale.com/kb/1312/serve>、啟用 HTTPS <https://tailscale.com/kb/1153/enabling-https>。
