# 開發日誌 (Development Log)

## 2026-06-26：WeiChuanScraper 完售時的票數計算邏輯分析

### 背景

味全龍售票系統（宏碁資訊 tix.wdragons.com）在區域完售時，前端頁面上通常不會顯示「立即購買」按鈕，或按鈕變為灰色不可點擊。需釐清爬蟲在此情境下是否仍能計算出票數。

### 資料流架構

`WeiChuanScraper.getTickets()` 的座位計算分成兩階段：

| 階段 | 頁面 | 取得資料 |
|------|------|----------|
| 第一階段 | UTK0204_（場次頁） | 各區 `status`（剩餘票數文字）、`actionStr`（進入座位圖的連結） |
| 第二階段 | UTK0205_（座位圖頁） | `.seat-empty` / `.seat-people` DOM 元素，或 fallback 解析 `seatStr` JavaScript 變數 |

### 完售時的三種結果路徑

#### 路徑 1：actionStr 存在 → UTK0205_ 正常回傳座位資料 ✅

**條件：** 售票系統在完售時**保留了**超連結（例如 `onclick`、`href`、`rel` 屬性仍在 HTML 中）。

**結果：**
- 程式能成功請求 UTK0205_
- DOM 元素 `.seat-empty` 和 `.seat-people` 可能都是 0（前端 JS 未執行）
- 觸發 `seatStr` fallback 機制（L289-313），從原始 HTML 解析完整的座位矩陣
- 精確計算出 `sold`（已售）和 `total`（總容量）

**實例：** B1 117區完售但仍能取得完整數字，就是走這條路徑。

#### 路徑 2：actionStr 不存在 ❌

**條件：** 售票系統在完售時**移除了**所有超連結（`tr` 的 `rel`、`onclick`、子元素 `href` 全部不存在）。

**結果：**
- `addedToQueue = false`
- `unsold = 0`、`sold = -1`（未知）、`total = -1`（未知）
- 該區的已售人數和總容量不會被計入彙總，**數據完全丟失**

#### 路徑 3：actionStr 存在但 UTK0205_ 無 seatStr ⚠️

**條件：** 有連結成功請求 UTK0205_，但回傳 HTML 中既無 DOM 元素也無 `seatStr`。

**結果：**
- `unsold = 0`、`sold = 0`、`total = 0`
- 該區看起來像有 0 個座位，**完全失真**

### seatStr 機制說明

`seatStr` 是嵌入在 UTK0205_ 頁面原始 HTML 中的 JavaScript 字串變數，**server-side 渲染**，格式範例：

```
0:1:A1.A2.A3\t1:1:B1.B2\t2:0:C1.C2.C3.C4\t...
```

- `parts[0]` = 排號 (row)
- `parts[1]` = 狀態碼：`0` = 空位 (unsold)、`1` = 已售 (sold)、`3` = 購物車 (CART)、`4` = 鎖定 (locked)
- `parts[2]` = 座位編號，以 `.` 分隔

程式將 status `1`、`3`、`4` 都視為已售/不可用，status `0` 視為空位。

### 關鍵結論

| 情境 | actionStr | unsold | sold | total | 準確度 |
|------|:---------:|--------|------|-------|:------:|
| 正常有票 | 有 | 正確 | 正確 | 正確 | ✅ |
| 完售（連結殘留） | 有 | 0 | 正確 | 正確 | ✅ |
| 完售（連結清除） | 無 | 0 | -1 | -1 | ❌ |
| 完售（無 seatStr） | 有 | 0 | 0 | 0 | ❌ |

**核心規則：** 完售 ≠ 無法計算數字。**真正的瓶頸是 `actionStr` 是否存在**，而不是票是否賣完。`seatStr` 是 server-side 渲染的備援資料，不依賴瀏覽器 JS，是完售時仍能取得準確數字的關鍵。

---

## 2026-07-01：從 CloakBrowser 遷移到 Playwright + 本機 Chrome（半自動化 CF 繞過）

### 背景

先前使用的 `cloakbrowser` 套件在繞過 Cloudflare Turnstile 時出現無限迴圈問題。即使設定 headless + stealth 參數，CF 驗證仍無法通過。降級到舊版 `0.3.30`（chromium-v146.0.7680.177.5）後問題依舊。

根本原因：新開的獨立 profile（`browser_data_*`）沒有正常使用者的瀏覽器歷史、cookie、登入狀態，CF 視其為可疑的陌生瀏覽器，持續要求驗證。

### 決策

徹底移除 `cloakbrowser` 依賴，改用 `playwright-core` 直接驅動本機實體 Chrome。半自動化模式：使用者先在瀏覽器視窗中手動點擊 CF 驗證打勾，程式自動偵測頁面特徵確認通過後繼續執行。

### 新增：`src/services/scrapers/IbonBrowser.ts`

共享的 ibon 瀏覽器控制模組，提供三個匯出函式：

| 函式 | 用途 |
|------|------|
| `launchIbonBrowser(opts?)` | 啟動本機 Chrome（`chromium.launchPersistentContext`），`headless: false` |
| `warmupIbonBrowser(page, activityPage?)` | 暖機：拜訪 ticket.ibon.com.tw + 活動頁，建立 session |
| `waitForCfBypass(page, timeoutSec)` | CF 繞過等待器：每 3-5 秒輪詢，偵測到 `#aspnetForm` / `#form1` / `table.table` / `window.jsonData` 即視為通過 |

**關鍵設計：**
- Chrome 路徑自動偵測（Windows → `C:\Program Files\Google\Chrome\Application\chrome.exe`）
- persistent context 保留 cookie，確保 CF 通過後在同一個 session 內無需重複驗證
- `waitForCfBypass()` 僅使用**強特徵**（DOM 元素存在性）判斷通過，避免 title 字串提前誤判

### 改寫檔案

| 檔案 | 變更 |
|------|------|
| `RakutenScraper.ts` | `import('cloakbrowser')` → `launchIbonBrowser()` |
| `UniScraper.ts` | 同上 |
| `AllStarScraper.ts` | 同上 |
| `package.json` | 移除 `cloakbrowser` 依賴 |

### 踩坑記錄

| # | 問題 | 原因 | 解法 |
|---|------|------|------|
| 1 | CloakBrowser CF 無限迴圈 | 全新 profile 無信任信號 | 棄用 CloakBrowser，改本機 Chrome |
| 2 | 想用 Chrome 原始設定檔 | Chrome 正在執行無法鎖定 + `--disable-web-security` 被 Chrome 拒絕 | 改回獨立設定檔 `browser_data_*` |
| 3 | CF 提前判定通過 | Title 字串 "ibon售票系統" 誤觸發 | 只用 DOM 強特徵（`#aspnetForm`、`table.table`、`jsonData`） |
| 4 | ESM 中 `require('fs')` 失敗 | Node.js ESM 模組不支援 `require` | 改用 `import * as fs from 'fs'` |

### 測試結果（Rakuten 7/24 大巨蛋）

```
Step 1: getGames() → 6 games found ✅
Step 2: getTickets() → CF passed (0s), 92 zones parsed ✅

總剩餘票: 16,277
總已售:   8,995
總容量:  25,454
票區數:   92
```

### 架構圖

```
RakutenScraper / UniScraper / AllStarScraper
        │
   ┌────▼────┐
   │ IbonBrowser.ts   ← 新增共享模組
   │ launchIbonBrowser│
   │ warmupIbonBrowser│
   │ waitForCfBypass  │
   └────┬────┘
        │
   ┌────▼────┐
   │ playwright-core │
   │ + 本機 Chrome   │
   │ (headless: false)│
   └─────────┘
```

### CF 驗證流程

```
launchIbonBrowser()  →  跳出 Chrome 視窗
warmupIbonBrowser()  →  拜訪 ticket.ibon.com.tw
page.goto(UTK0201)   →  可能觸發 CF 驗證頁面
waitForCfBypass()    →  每 3-5s 檢查 (aspnetForm / form1 / table.table / jsonData)
  ├─ CF 頁面 → 提示使用者打勾 → 繼續等待
  └─ 強特徵出現 → ✅ 通過 → 繼續爬取
```

---

## 2026-09-07：中信兄弟／味全龍查無場次 → 定位為公司內網 TLS 攔截代理，非程式邏輯問題

### 症狀

使用者在公司內網環境下查票，中信兄弟、味全龍兩隊都查不到場次列表（明明近日確實有比賽），台鋼雄鷹正常。

### 診斷過程

1. 直接執行 `BrothersScraper.getGames()` / `WeiChuanScraper.getGames()`，兩者都拋出 `fetch failed`；`TsgScraper.getGames()` 正常回傳 9 場。
2. 追查 `error.cause`，訊息為 `Error: CA certificate key too weak`（Node/OpenSSL 在 TLS 交握階段就拒絕，連 HTTP 請求都送不出去）。
3. 用 `openssl s_client -showcerts` 檢查憑證鏈，發現 `tix.ctbcsports.com`、`tix.wdragons.com`，以及 `ibon.com.tw`，收到的憑證都被重新簽發成同一張偽造的「`C=US, O=GlobalTrust Corporation, CN=GlobalTrust Root CA`」憑證，且金鑰只有 **1024-bit**（現代最低標準為 2048-bit），連對照組 `google.com` 也是同一張假憑證 — 確認這是公司網路上的 **TLS 攔截／SSL Inspection 代理**，並非目標網站本身的憑證問題。
4. 對照測試富邦（`guardians.fami.life`）與台鋼（`ticket-platform.newretail.tw`）：兩者收到的都是正常的真實憑證（富邦是 Google Trust Services 簽發、2048-bit），完全沒被攔截。→ 確認攔截代理是**針對特定網域**下手（`tix.ctbcsports.com` / `tix.wdragons.com` / `ibon.com.tw`），推測與這三個網域背後同屬 ibon 售票樣板系統（`UTK0101_`、`__JWtToken` 等特徵一致）有關，而不是隨機或全網攔截。
5. 使用者改用手機熱點後，中信兄弟／味全龍場次列表立即正常顯示，驗證診斷正確。

### 關鍵結論

| 網域 | 平台 | 是否被公司網路攔截 |
|------|------|:---:|
| tix.ctbcsports.com（中信兄弟） | ibon 樣板 | ✅ 攔截，1024-bit 假憑證 |
| tix.wdragons.com（味全龍） | ibon 樣板 | ✅ 攔截，1024-bit 假憑證 |
| ibon.com.tw | ibon 官方 | ✅ 攔截，1024-bit 假憑證 |
| guardians.fami.life（富邦） | FamiPort | ❌ 未攔截，正常憑證 |
| ticket-platform.newretail.tw（台鋼） | 新零售自建 | ❌ 未攔截，正常憑證 |

**核心規則：** 這不是 `BrothersScraper` / `WeiChuanScraper` 的程式邏輯錯誤（PLACE_ID 篩選、日期解析都正常），而是**執行環境的網路層**問題。

### 對「AI 執行診斷指令是否受影響」的釐清

透過 Bash/PowerShell 工具執行的 `node` / `tsx` 指令，是在使用者本機這台電腦上跑，走的是這台電腦當下的實際網路連線 — 所以會跟使用者自己執行 scraper 時遇到一樣的攔截問題。只有走 `WebFetch` / `WebSearch` 這類經 Anthropic 後端基礎設施發出的請求才不受本機網路環境影響。

### 雲端部署的相容性考量與實作

- `rakuten` / `uni` / `allstar` 使用共用 Playwright 瀏覽器（`IbonBrowser.ts`），已有 `CLOUD_UNSUPPORTED_IBON` 機制在 `CLOUD_MODE=true` 時直接停用。
- `brothers` / `weichuan` / `fubon` / `tsg` 都是純 `fetch`，**不在**雲端停用清單（`IBON_TEAMS = ['rakuten','uni','allstar']`），代表雲端本來就預期這四隊能正常查 — 雲端主機的連線路徑不經過使用者公司的攔截代理，理論上憑證驗證正常，不會重現這個錯誤。
- 因此繞過憑證驗證的邏輯必須**限定在本機（`!isCloudMode()`）**，不能寫進共用邏輯讓雲端版本一併放寬憑證驗證。

**第一版實作（僅涵蓋中信兄弟／味全龍）：**

一開始用寫死的網域清單（`Set(['tix.ctbcsports.com', 'tix.wdragons.com'])`），只放行本機模式下命中這兩個 host 的請求改用放寬憑證驗證的 `undici.Agent`。

**後續發現：攔截範圍會變動，改成「偵測到特定錯誤才重試」**

隔天使用者在公司內網重新測試，回報中信兄弟、富邦悍將、台鋼雄鷹三隊**同時**查不到場次（先前對照測試時富邦、台鋼是正常的）。實際重新用 `node -e "fetch(...)"` 測試三個網域（`tix.ctbcsports.com`、`guardians.fami.life`、`ticket-platform.newretail.tw`），全部都出現一樣的 `fetch failed` / `CA certificate key too weak`。代表公司那層 TLS 攔截代理鎖定的網域範圍**會隨時間變動**，寫死網域清單不可靠、需要每次都手動追加。

因此把 `localFetch.ts` 改寫成「先照正常方式打，只有真的遇到 `certificate key too weak` 這個特定錯誤訊號時，才在本機模式下用放寬憑證驗證的 dispatcher 重試一次」，不再需要維護網域清單：

```ts
export async function localSafeFetch(url, init = {}) {
  if (isCloudMode()) return fetch(url, init);
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isWeakCertError(err)) throw err; // 非此特定錯誤，原樣拋出
    return fetch(url, { ...init, dispatcher: getBypassAgent() });
  }
}
```

- `getBypassAgent()` 回傳一個懶初始化、模組層級快取的 `undici.Agent`（`new Agent({ connect: { rejectUnauthorized: false } })`）。
- 雲端模式（`isCloudMode()` 為 true）一律照舊走預設 `fetch`，完全不會進入 catch 分支、也不會附加 dispatcher，行為與修改前一致。
- 非雲端模式下，只有第一次 `fetch` 真的因為這個特定 TLS 錯誤而失敗時才會重試放寬憑證版本；任何其他錯誤（逾時、DNS、真正的網站異常等）一律照原樣拋出，不會被誤吞。
- `undici` 原本只是 playwright-core 的間接依賴，已加為 `package.json` 的直接依賴（`^7.25.0`）避免之後間接依賴版本異動導致找不到套件。
- `BrothersScraper.ts`、`WeiChuanScraper.ts`、`FubonScraper.ts`、`TsgScraper.ts` 內所有原本呼叫 `fetch(...)` 的地方全部改用 `localSafeFetch(...)`。這四隊都是純 HTTP `fetch`（無瀏覽器），適用同一套機制。
- `.js` 版本的 scraper 檔案（`BrothersScraper.js` 等）是舊的、已被 `.gitignore` 排除的殘留編譯產物，實際執行走 `tsx` 直接吃 `.ts`，故不需同步修改。

**驗證：**
- 在使用者回報「公司內網下中信／富邦／台鋼都查不到」當下，直接於同一台機器測試 `BrothersScraper.getGames()`、`WeiChuanScraper.getGames()`、`FubonScraper.getGames()`、`TsgScraper.getGames()`：中信兄弟 4 場、味全龍 2 場、台鋼雄鷹 9 場，皆正確回傳；富邦回傳 0 場（`getGames()` 有成功執行、沒有拋出連線錯誤，只是目前大巨蛋主場賽程本身是空的，屬於資料層面而非連線層面，與這次的修復無關）。
- `npx tsc --noEmit` 確認變更檔案本身沒有型別錯誤（其餘既有的 `cloakbrowser` 相關型別錯誤與本次改動無關，是既有未追蹤測試檔案的殘留問題）。
- 雲端模式（`CLOUD_MODE=true`）分支目前仍只能透過程式碼檢視確認（`isCloudMode()` 為 true 時直接短路，不會進入任何重試/放寬憑證的路徑），還沒有機會在真正的雲端部署 + 公司網路同時重現的情境下端到端驗證過。

**遺漏補完：`server.ts` 內味全龍登入/驗證碼流程也有獨立的 `fetch`**

套用 `localSafeFetch` 後，中信兄弟／味全龍／富邦／台鋼的 `getGames()` 都正常了，但使用者接著在瀏覽器點味全龍登入視窗時，還是看到「無法載入驗證碼: TypeError: fetch failed」。原因是 `server.ts` 的 `/api/weichuan/captcha`（取驗證碼圖片、L15-97）與 `/api/weichuan/login`（送出登入、L100-177）**沒有經過 `WeiChuanScraper` 類別**，而是直接在 route handler 裡打了三個獨立的 `fetch('https://tix.wdragons.com/...')`，所以之前修 `WeiChuanScraper.ts` 完全沒覆蓋到這三個呼叫點。

修法：把這三個 `fetch(` 一併改成 `localSafeFetch(`（`server.ts` L32、L46、L119），並在檔案頂端加上 `import { localSafeFetch } from './src/services/scrapers/localFetch.js'`。

**額外教訓：** 開發用的 `tsx server.ts` process **不會自動重載程式碼**（`package.json` 的 `dev` script 沒有掛 `--watch`），改完 `.ts` 檔案後舊 process 還是跑著舊的編譯結果，必須重啟（`Stop-Process` 掉舊的 PID 再重新 `npx tsx server.ts`）才會生效——第一次驗證這個修法時就因為忘記重啟、打到舊 process 而誤判修復無效。之後改完 server 端程式碼，記得先確認有沒有重啟才下結論。

**驗證：** 重啟 server 後直接 `curl http://localhost:3000/api/weichuan/captcha`，回傳 HTTP 200 與正常的驗證碼 base64 圖片（不再是 500 + `fetch failed`）。

### 附錄：各球團爬蟲的雲端相容性總覽

專案除了本機執行，也會部署到 Google AI Studio（`CLOUD_MODE=true`，見 `.env.example`）。以下整理每個球團目前的抓取方式與雲端可用性，供之後排查「查不到場次」類問題時快速定位是程式問題、環境問題、還是本來就設計成雲端不支援：

| 球團 | Scraper | 資料來源網域 | 抓取方式 | 雲端支援 | 備註 / 已知限制 |
|------|---------|------|----------|:---:|------|
| 中信兄弟 | `BrothersScraper` | tix.ctbcsports.com | 純 `fetch`（無瀏覽器），已改用 `localSafeFetch` | ✅ | 本機在使用者公司網路環境下曾被 TLS 攔截代理擋下（見上），已透過 `localFetch.ts` 針對此 host、僅本機模式放寬憑證驗證修復；雲端主機不受影響、也不受此繞過邏輯影響 |
| 味全龍 | `WeiChuanScraper` + `server.ts` 的 `/api/weichuan/captcha`、`/api/weichuan/login` | tix.wdragons.com | 純 `fetch` + 帳密/驗證碼登入，session 存在 server 記憶體 `WeiChuanScraper.cookieStore`（`Map`），全部已改用 `localSafeFetch`（含 `server.ts` 內原本獨立於 scraper 類別之外的 3 個 fetch） | ✅ | 同上的 TLS 問題與修復方式；另外 session 是 process 內記憶體 Map，若雲端部署改成多實例或會重啟的架構，登入狀態會遺失、需重新登入 — 目前 AI Studio 是單一持續運行的 process，暫無此問題 |
| 富邦悍將 | `FubonScraper` | guardians.fami.life | 純 `fetch`，已改用 `localSafeFetch` | ✅ | 第一次對照測試時未被攔截，隔天再測就被同一層公司代理鎖了 → 攔截範圍會變動，已改用「偵測到錯誤才重試」機制修復；雲端不受影響 |
| 台鋼雄鷹 | `TsgScraper` | ticket-platform.newretail.tw（JSON API，非 ibon 樣板） | 純 `fetch`，打官方 REST API，已改用 `localSafeFetch` | ✅ | 平台架構與其他隊完全不同，但一樣曾被公司網路攔截過，已用同一套機制修復；`getGames()` 目前**沒有**過濾主場館，回傳清單包含澄清湖、嘉義等非大巨蛋場次，只有標題會標示球場名稱 |
| 樂天桃猿 | `RakutenScraper` | ticket.ibon.com.tw / orders.ibon.com.tw | Playwright + **本機實體 Chrome**，需使用者手動過 Cloudflare Turnstile | ❌ 雲端停用（`CLOUD_UNSUPPORTED_IBON`） | 雲端容器沒有本機 Chrome、也沒人能手動點 CF 驗證；前端 `IBON_TEAMS` 清單會直接標示「雲端版暫不支援，請洽規劃課分機8699」並跳過請求 |
| 統一獅 | `UniScraper` | 同上 | 同上 | ❌ 雲端停用 | 同上 |
| 全明星賽 | `AllStarScraper` | 同上 | 同上 | ❌ 雲端停用 | 同上 |

**判斷原則：**
- 中信兄弟／味全龍／富邦／台鋼四隊都是純 HTTP `fetch`，理論上本機、雲端都該正常，若查不到場次，優先懷疑**目前所在網路環境**（如今天發現的公司網路攔截代理），而不是先改程式碼。
- 樂天／統一／全明星賽三隊本來就**設計成只能在本機跑**（需要真實瀏覽器 + 人工過 CF），雲端版查不到場次是預期行為，不是 bug。
- 如果之後要新增球隊或改動 `ScraperFactory`／`IbonBrowser`，記得同步更新 `App.tsx` 的 `IBON_TEAMS` 清單與這張表，避免兩邊兜不起來。

---

## 2026-09-07（續）：開發伺服器改用 `tsx watch`，存檔自動重啟不用手動關重開

### 背景

使用者原本用 `.\start_all.bat` 啟動本機伺服器（`npx tsx server.ts`），每次改 `server.ts` 或 `src/services/scrapers/*.ts` 之後，都要手動關掉、重新執行 `.bat` 才會生效——這也是前面味全龍驗證碼那次修復一開始被誤判無效的原因（改完程式碼、舊 process 還在跑）。使用者問有沒有辦法改完程式碼後只要重整瀏覽器就好，不用重啟整個 server。

### 做法

`tsx`（專案已有的依賴，`^4.21.0`）本身內建 `watch` 子指令，會監看進入點檔案及其完整 import 圖（不只 `server.ts` 本身，`src/services/scrapers/*.ts` 這些被它間接 import 的檔案改了也算），存檔後自動重新啟動整個 Node process。

- `package.json`：`"dev": "tsx server.ts"` → `"dev": "tsx watch server.ts"`。
- `start_all.bat`：`npx tsx server.ts` → `npx tsx watch server.ts`。

前端（`src/App.tsx` 等 React 檔案）本來就是透過 `server.ts` 裡 Vite 的 `middlewareMode` 在跑，已經有獨立的 HMR，改前端檔案本來就不需要重啟 server；這次的改動解決的是後端／爬蟲程式碼的部分。

### 驗證

1. 用 `tsx watch server.ts` 啟動，`curl http://localhost:3000/api/weichuan/captcha` 正常回傳 200。
2. 對 `TsgScraper.ts` 做一個小改動（加一行註解）存檔，觀察到終端機輸出：
   ```
   [tsx] change in ./src\services\scrapers\TsgScraper.ts Restarting...
   Server running on http://localhost:3000
   ```
   確認整個 process（含裡面的 Vite middleware）都重新啟動了，port 3000 上的 PID 也換了一個。
3. 把剛剛的測試註解改回來，同樣觸發了第二次自動重啟，驗證是持續生效、不是只有第一次。

### 使用須知

- 這是**重啟整個 Node process**，不是單純的模組熱替換（HMR）——重啟期間 port 3000 會有短暫瞬斷，瀏覽器分頁需要**手動重新整理一次**才會看到最新結果（不會自動跳轉），符合使用者原本要的「改完檔案、重整瀏覽器即可」。
- 觀察到一個連帶效應：如果重啟當下瀏覽器分頁還開著、且該分頁會在載入時打 `/api/get_games/rakuten` 等會啟動真實 Chrome 視窗的端點（樂天／統一／全明星賽用 `IbonBrowser` 的視窗模式繞 Cloudflare），重啟可能連帶讓這些請求重新觸發，跳出實體 Chrome 視窗。這是既有的爬蟲行為，不是 watch 模式造成的新問題，但改完後端程式碼、預期只是「靜靜重啟」時，也可能會看到 Chrome 視窗跳出來，提醒使用者不用意外。

---

## 2026-09-14：utiki 三隊（兄弟／味全龍／富邦）與台鋼雄鷹——哪些票數是實測、哪些只是「有欄位就當真」

### 背景

前面 2026-06-26 那篇只分析了 `WeiChuanScraper` 完售時的計票邏輯。實際上 `BrothersScraper.ts`、`FubonScraper.ts` 跟 `WeiChuanScraper.ts` 三份檔案是**幾乎逐行相同的複製貼上**（同一套 utiki 售票樣板系統，只換了 base URL 跟少數篩選邏輯），所以 2026-06-26 那篇的三種完售路徑分析（連結殘留 ✅ / 連結清除 ❌ / 無 seatStr ⚠️）**同樣適用於兄弟跟富邦**，這裡補齊說明並釐清三隊之間實際存在的差異，另外把台鋼雄鷹（完全不同架構）也一併記錄。

### utiki 三隊：資料流完全一致，差異只在「篩選大巨蛋場次」跟「要不要登入」

三隊的 `getTickets()` 都是同一套兩階段邏輯：

| 階段 | 頁面 | 取得資料 | 是否為實測 |
|------|------|----------|:---:|
| 第一階段 | `UTK0204_`（票區列表頁） | 表格上直接顯示的數字（如「剩餘 23」）、`已售完` 文字 | ✅ 售票系統自己算好回傳的，直接信任 |
| 第二階段（僅「熱賣中」分區） | `UTK0205_`（座位圖頁） | `.seat-empty`/`.seat-people` DOM 元素數量，或 fallback 解析 `seatStr` | ✅ 逐座位數出來的實測值 |
| 抓取失敗（WAF 擋、逾時、連結被清除） | — | `sold=-1, total=-1` | ⚠️ **未知**，不是猜的、也不會補 |

**三隊唯一的實質差異：**

| 差異點 | 中信兄弟 | 味全龍 | 富邦悍將 |
|---|---|---|---|
| 大巨蛋場次篩選 | `PLACE_ID === 'P18PM5NV'` 精準比對 | 主場不固定，需先個別打開每個 PLACE_ID 對應的場次頁看 `og:title` 是否含「大巨蛋」反推 | 直接看 `PLACE_NAME` 字串是否含「大巨蛋」 |
| 是否需要登入 | 否 | **是**（`sessionToken` + 帳密 + 驗證碼，見 `server.ts` `/api/weichuan/captcha`、`/api/weichuan/login`） | 否 |
| 「尚未開賣」誤判防呆 | 有（看 `#buy_btn` 文字判斷，見 commit `3790667`） | 無 | 無 |

**驗證方式：** 直接對照三份檔案的 `getTickets()` 主體（`tr.saleTr` 解析、`.map` 座位圖比對、`seatStr` fallback 那一整段），逐行 diff 下來除了 class 名稱、`baseUrl`、`Origin` header 之外幾乎沒有差異，確認 2026-06-26 篇的完售分析（連結殘留/清除/無 seatStr 三種路徑）對三隊同樣成立。

### 關鍵：utiki 三隊**沒有**容量表回推機制

樂天／統一／明星賽（ibon 三隊）都有 `patchDomeCapacity()`，靠 `大巨蛋座位.json` 的固定容量在某分區抓失敗時回推剩餘票數。**兄弟／味全龍／富邦這三隊完全沒有這段邏輯**（`BrothersScraper.ts`、`WeiChuanScraper.ts`、`FubonScraper.ts` 裡都搜不到 `patchDomeCapacity` 或任何讀 `大巨蛋座位.json` 的程式碼）。

意味著：
- 這三隊的分區只要抓失敗（`error: "遭防爬蟲阻擋(WAF)"`），該分區的 `sold`/`total` 就是 `-1`（未知），**永遠不會被容量表補齊**。
- 最終加總 `total_capacity` 時，失敗的分區直接被跳過（`details.forEach` 裡 `sold >= 0` 才計入 `sum_capacity`），結果是**總容量會偏少（漏算），而不是被錯誤的猜測數字蓋掉**——跟 ibon 三隊「用容量表硬湊出一個看似完整的數字」相比，utiki 三隊的失敗更誠實，但代價是總數字本身可能不完整，需要看有沒有 `error` 欄位才知道是否要打折看待。
- 如果之後兄弟／味全龍／富邦哪一隊也開始玩「同一分區前/後分兩次賣」，目前這三隊的程式碼**不會自動合併容量**（沒有 `extractFloorZone`/`patchDomeCapacity` 這類分區代號歸併邏輯），前後兩列會被當成完全獨立的兩個分區，各自的抓取結果各自成立、互不影響，也不會有 ibon 三隊那種「用容量回推分配給缺資料那一列」的行為。

### 台鋼雄鷹：資料來源架構完全不同，且**系統性沒有「已售」與「總容量」欄位**

`TsgScraper.ts` 打的是自家 REST JSON API（`ticket-platform.newretail.tw`），不是 utiki 也不是 ibon，沒有 HTML 解析、沒有座位圖、沒有 WAF 重試：

```
GET /api/v1/public/seat-availability?activityId=...&eventSessionId=...
→ [{ name/code, availableSeats, ... }, ...]
```

`getTickets()` 只讀了 `availableSeats` 這一個欄位塞進 `unsold`，回傳值是 `{ total_unsold, details }`——**`sold`、`total`、`total_sold`、`total_capacity` 全部沒有賦值**（`TicketZone.sold`/`total` 是 optional 欄位，這裡就是留空，不是漏寫）。也就是說：

- 台鋼雄鷹的「未售票數」是 API 直接吐出來的**實測值**，可信。
- 但台鋼**沒有任何管道知道已售出多少張、或整區總容量是多少**——不是程式沒寫、是這個 API 本身根本不回傳這兩個欄位，前端顯示台鋼的資料時不該預期看到「已售/總容量」這類數字。
- 另外 `getGames()` 目前也**沒有**過濾主場館（見 2026-09-07 附錄表格），回傳清單會混雜大巨蛋以外的場次（澄清湖、嘉義等），只有標題文字會標示球場名稱，篩選要靠使用者自己看標題。

### 給下次回來看的人的總結

| 球團 | 已售/剩餘是否實測 | 抓失敗時怎麼處理 | 容量回推機制 |
|---|:---:|---|:---:|
| 中信兄弟 | 是（含 seatStr fallback） | 該分區標記未知，總數跳過不補 | 無 |
| 味全龍 | 是（含 seatStr fallback） | 同上 | 無 |
| 富邦悍將 | 是（含 seatStr fallback） | 同上 | 無 |
| 台鋼雄鷹 | 「剩餘」是實測；「已售/總容量」API 根本不提供 | 無失敗重試機制（單純 API 呼叫失敗就整個拋錯） | 無（也無法補，沒有容量資料來源） |
| 樂天／統一／明星賽 | 是（含 seatStr/DOM 計數），缺值時才用容量表回推 | 部分缺值用 `大巨蛋座位.json` 回推填補，全缺且非「已售完」則維持未知 | 有（`patchDomeCapacity`） |

> **⚠️ 2026-09-14 後續更新**：上面「台鋼雄鷹」那一列已經過時。後來挖到 `ticket-info.newretail.tw` 這支官方 API 後，台鋼現在**每一區都能算出真實已售數字**，是全部球團裡資料最完整的一個（見下面新的一篇）。這裡保留原文不改，是為了留下「一開始台鋼真的什麼都沒有」這個判斷過程的紀錄；要看現況請直接看下一篇。

---

## 2026-09-14（續）：意外挖到台鋼的官方座位容量 API，前/後拆分區問題徹底解決

### 背景

前一篇才剛把台鋼的計票邏輯歸類成「全部球團裡資料最不完整的一個」——只有剩餘票數，已售/總容量完全沒有資料來源，只能用 `大巨蛋座位.json` 的「樓層＋分區號」去回推，而且同一分區被拆成前/後兩列賣時（例如 `TP106B`／`TP106F`），因為不知道前後兩排各自的容量，只能兩個都標記未知，沒辦法解決。

使用者自己在台鋼訂票網站上按 F5、翻瀏覽器開發者工具的網路請求，發現一支我們完全沒查過的 API：

```
https://ticket-info.newretail.tw/api/v1/activity-venues/AV_260729TP2888?activityId=AC_260729TP2888&eventSessionId=TSGHAWKS_2627_REG_346
```

**注意主機名稱**：這是 `ticket-info.newretail.tw`，跟原本一直在用的 `ticket-platform.newretail.tw`（`spotlight`、`seat-availability` 這兩支）完全是不同的兩台主機。前面「方案二」查隱藏端點時（見更早的對話紀錄），只在 `ticket-platform.newretail.tw` 這台主機上用各種路徑名稱亂猜，猜了十幾個都 404，因為根本沒去查還有另一台主機存在——這是純粹靠使用者自己動手翻網路請求才找到的，不是靠猜路徑名稱能找到的。

### 這支 API 回傳什麼

回傳 `activityAreaList` 陣列，每個分區一筆，包含 `name`、`code`、`seatCount`（官方座位數）、`bookingStatus`、`path`（座位圖 SVG 路徑）等欄位。重點是 **`seatCount` 這個欄位連拆分區、輪椅席、貴賓包廂都各自有獨立的真實數字**：

```json
{ "name": "B1 106區-20排後", "code": "TP106B", "seatCount": 453, ... }
{ "name": "B1 106區-19排前", "code": "TP106F", "seatCount": 402, ... }
{ "name": "魔王席143區", "code": "TP143", "seatCount": 185, ... }
{ "name": "L3 一壘貴賓席", "code": "TP3FB", "seatCount": 1000, ... }
```

### 驗證過程

1. **要不要授權**：跟 `ticket-platform.newretail.tw` 一樣，只需要 `x-company-code: tsghawks` header，沒有 header 會回 400（`headers must have required property 'x-company-code'`）。不需要額外登入或 cookie。
2. **`seatCount` 是不是每場都不一樣**：拿同一個場館、兩場不同日期的比賽（9/24 跟 9/25，`activityId` 相同、`eventSessionId` 不同）分別打這支 API，160 個分區的 `seatCount` **逐一比對完全一致，零差異**——證實這是場館固定配置，不是每場臨時算出來的，可以放心快取/信任。
3. **`AV_` 這個 id 哪裡來的**：觀察到 `activity-venues` 路徑上的 id（`AV_260729TP2888`）就是把 `getGames()` 已經拿得到的 `activityId`（`AC_260729TP2888`）的 `AC_` 前綴換成 `AV_`，其他字元不變。拿另一個完全不同的活動（主場澄清湖，`AC_260105GC4999` → `AV_260105GC4999`）測試，一樣正確回傳 32 個分區資料，確認這個轉換規則是通用的，不是巧合，不需要額外去哪裡查詢 venue id。
4. **跟既有 `大巨蛋座位.json` 對照**：把同一批分區依「樓層＋分區號」歸戶加總（把拆開的前/後排相加），跟 `大巨蛋座位.json` 比對，160 個分區裡有 60 個完全一致、30 組（合併後）有小差異（差距大約在 -16 ～ +51 之間，例如 B1-108：`大巨蛋座位.json` 記錄 562，台鋼官方數字 613）。差異不算離譜，但確實存在——代表**台鋼自己的官方座位數，跟從 ibon 座位圖回推出來的 `大巨蛋座位.json` 並不是同一份資料**，兩邊可能對走道、無障礙席、視角受阻座位等邊界的認定不完全相同。既然台鋼自己的售票就該用台鋼自己的官方數字，不應該借用別的售票系統回推出來的數字。

### 實作：整個 `大巨蛋座位.json` 回推機制對台鋼來說直接作廢

`TsgScraper.ts` 的 `getTickets()` 改成平行打兩支 API：

```ts
const [availRes, capacityMap] = await Promise.all([
  localSafeFetch(availUrl, { headers: this.headers }),          // 剩餘票數（seat-availability）
  this.fetchSeatCapacityMap(activityId, eventSessionId)          // 官方容量（activity-venues）
]);
```

兩邊資料用 `code` 直接對起來：`已售 = seatCount - availableSeats`，`總容量 = seatCount`。不再需要：

- `extractFloorZone()`：用中文分區名稱猜「樓層＋分區號」的 regex，整段刪除。
- `patchDomeCapacity()`：處理拆分區時「不知道前後排各自容量、只能整包塞給其中一列、另一列維持未知」的容量歸戶邏輯，整段刪除。
- 讀取 `大巨蛋座位.json` 的 `loadDomeSeatMap()`，整段刪除（台鋼現在完全不依賴這份共用檔案）。

### 結果

實際對 9/24 台鋼 vs 富邦這場重新測試：

| | 舊方法（容量表回推，只能算出部分分區） | 新方法（官方 seatCount，全部分區皆可算） |
|---|---:|---:|
| 已知已售 | 3,936 | 8,442 |
| 未知分區數 | 100 / 160 | **0 / 160** |
| 拆分區（如 106/112 區） | 前後排都標記未知 | 前後排各自有真實已售數字 |
| 輪椅席、貴賓包廂 | 未知 | 有真實數字 |

前後拆分區問題（使用者最早提出的疑慮）在台鋼這邊等於是徹底解決，不再是「盡量不要用假數字掩蓋抓取失敗」的妥協，而是真的有官方數字可以用。

### 附帶清理

因為現在每個球團的 `getTickets()` 都會回傳明確的 `total_sold`（不會是 `undefined`），原本只為了台鋼而存在的「設定總票數」齒輪按鈕與彈窗（`totalSeats`／`isTotalSeatsConfigOpen` 狀態）已經是死程式碼，一併從 `App.tsx` 移除，三個原本要三元判斷 `total_sold !== undefined ? ... : (totalSeats - ...)` 的地方（已售出卡片、支援人力、疏運時間、CSV 匯出）都直接簡化成 `ticketData.total_sold ?? 0`。

### 附加產出：`大巨蛋座位v2.json`

以 `大巨蛋座位.json`（v1）為基礎，逐區比對台鋼官方 `seatCount`，結果存成新檔案 `大巨蛋座位v2.json`（不影響現有程式邏輯，純粹是給人工比對用的參考檔）。102 個 v1 分區裡 60 個數字一致、30 個不同（附 `diff`），另外 12 個 v1 有但台鋼沒賣（主要是 `L2 233~244`），5 個台鋼有賣但 v1 沒收錄（魔王席143區、L3 三個貴賓包廂、L2外野貴賓席）。拆前/後排的分區（如 `TP106B`/`TP106F`）在 `tsg_codes` 欄位裡有各自真實的座位數，可以直接拿來對照。

---

## 待辦：下次 ibon（樂天／統一／明星賽）開賣時，要用台鋼的官方數字回頭更新 v1

### 背景

`大巨蛋座位.json`（v1）原本是從 ibon（樂天／統一／明星賽）的座位圖回推建立的，`patchDomeCapacity()` 至今都還在用它。這次意外挖到台鋼官方的 `seatCount` API 後，比對發現 **v1 有 30 個分區的數字跟台鋼官方數字對不起來**（見上面「意外挖到台鋼的官方座位容量 API」那篇），差距大約 -16～+51 之間。既然台鋼是直接從場館拿到的官方座位數，理論上比 v1「用 ibon 座位圖數格子回推」更可信。

### 使用者的決定

下次樂天／統一／明星賽任一隊在大巨蛋有場次開賣時（見前面待辦：三個活動目前都是 `Enable:false`，還沒到開賣時間），要：

1. **拿台鋼的官方數字回頭更新 v1**（`大巨蛋座位.json`），而不是保留 ibon 回推出來的舊數字——已經確認台鋼的資料比較權威，方向是「台鋼 → 更新 v1」，不是反過來。
2. **確認前/後拆分區在 ibon 那邊的實際命名方式**：台鋼是用 `TP106B`／`TP106F`（代號）+「B1 106區-20排後」／「B1 106區-19排前」（名稱）這種方式拆分區，但 ibon 自己的座位圖上，同一個物理分區會不會也拆成前/後兩塊來賣、拆法是否跟台鋼一致、命名規則是否相同——**這件事現在無法確認，必須等 ibon 真的有場次開賣、能實際打開座位圖看到真實資料才知道**。目前的 `extractFloorZone()` regex 理論上不管中間文字是什麼都能正確歸戶（見更早的分析），但沒有實測過 ibon 自己是否真的用同樣的前/後拆分方式在賣。
3. `大巨蛋座位v2.json` 已經把 30 個有差異的分區跟台鋼各自的 `tsg_codes` 拆解列出來，到時候可以直接拿來對照 ibon 座位圖上的實際排數分界，反推 v1 該怎麼改。

### 目前卡住的點

三個 ibon 活動（`ActivityInfo/Details/39689` 樂天、`39760` 統一、`39701` 明星賽）截至目前查詢都是 `"Enable":false`、場次清單是空的，沒有任何一個管道可以現在就驗證。純粹記錄下來，等下次有人回報「樂天/統一/明星賽開賣了」再回來處理。

---

## 2026-09-14（再續）：`ignoreTag` 才是真正的「此場次是否開放銷售」旗標，修正前一篇的誤判

### 背景

前一篇（意外挖到台鋼的官方座位容量 API）只顧著驗證 `seatCount`，對同一份 `activity-venues` 回應裡的 `ignoreTag` 欄位只是憑欄位名稱猜測「可能是畫面顯示用的旗標」，還用 `availableSeats` 反推「有沒有在賣」去驗證，結論是「`ignoreTag` 跟銷售狀態無關」——**這個結論後來被證明是錯的**，記錄一下怎麼發現、怎麼修正。

### 使用者提供的關鍵證據

使用者實際在台鋼訂票網頁上點了好幾個 L2／L4／L5 分區（211區、408區、505區、508區），每一個點下去都顯示：

```
此區域不開放
```

這幾區在 `activity-venues` 的資料裡，`ignoreTag` 全部都是 `true`。

### 重新驗證：拿「同一場館、不同比賽」比對 ignoreTag 本身

前一篇驗證 `seatCount` 時，用的是「同場館不同比賽的數字要一致」這個邏輯，而且真的驗證出 `seatCount` 完全一致（場館固定配置）。這次反過來對 `ignoreTag` 做同樣的跨場次比對（9/24 台鋼 vs 富邦 `REG_346`，對比 9/27 台鋼 vs 統一 `REG_355`）：

```
TP201、TP211、TP220...等 35 個分區（幾乎都是 L2）：
  REG_346（9/24）：ignoreTag = true
  REG_355（9/27）：ignoreTag = false
```

**同一個分區，兩場比賽的 `ignoreTag` 不一樣**——這跟 `seatCount`「跨場次固定不變」的特性完全相反，證明 `ignoreTag` 是**每一場比賽各自控制的銷售開關**，不是場館固定屬性。使用者截圖的四個「不開放」分區，跟 9/24 這場的 `ignoreTag:true` 清單完全吻合。

### 前一篇的驗證方法錯在哪

前一篇用 `sold = seatCount - availableSeats` 算出某些 `ignoreTag:true` 的分區「已經 100% 賣完」（例如 `TP201` 剩餘 0、`TP408`/`TP409`/`TP410` 剩餘都是 0），就以為這代表「有在賣」。現在看來，**分區關閉時，`availableSeats` 這個欄位本身就不可信**——很可能是售票系統為了不讓人訂購，把關閉分區的 `availableSeats` 歸零（或維持在某個固定值）當作一種「鎖住」的手段，不是真實成交數字。拿一個本來就不可信的數字去反推「有沒有在賣」，方向從一開始就錯了。

### 修正：`TsgScraper.ts` 排除 `ignoreTag:true` 的分區

`fetchSeatCapacityMap()` 回傳型別從 `Map<string, number>` 改成 `Map<string, { seatCount: number; ignoreTag: boolean }>`，一併把 `ignoreTag` 帶出來。`getTickets()` 裡遇到 `ignoreTag === true` 的分區：

```ts
details.push({ zone: zoneName, unsold: -1, sold: -1, total: -1, error: '此場次尚未開放銷售' });
```

不使用 `availableSeats` 去計算，`unsold`/`sold`/`total` 全部標記為 `-1`（未知），並在加總 `total_unsold`/`total_sold`/`total_capacity` 時完全跳過這些分區——只有 `ignoreTag:false`（真正開放銷售）的分區才會被計入。

### 驗證結果（9/24 台鋼 vs 富邦）

| | 修正前（誤用 availableSeats） | 修正後（排除未開放分區） |
|---|---:|---:|
| 開放中分區數 | 160（全部當作有在賣） | 70 |
| 已知未售 | 26,693 | 10,536 |
| 已知已售 | 8,442 | 6,170 |
| 總容量 | 35,135 | 16,706 |

使用者截圖的四個分區（L2 211區、L4 408區、L5 505區、L5 508區）在修正後都正確顯示 `error: "此場次尚未開放銷售"`，不再被誤算進已售/未售。

### 給下次回來看的人的教訓

- **欄位名稱不能用來猜功能**，`ignoreTag` 字面上看起來像「忽略某個標籤／畫面顯示用」，實際上是銷售開關；真正該做的是像這次一樣，拿同一份資料源「跨場次比對」找出哪些欄位會隨場次變動（動態、跟銷售狀態有關）、哪些欄位固定不變（靜態、場館配置）。
- **不能拿不確定可信度的欄位去驗證另一個欄位**——前一篇就是拿本身可能不可信的 `availableSeats` 去驗證 `ignoreTag`，兩個都是「猜」，互相驗證不出真相。真正的答案來自使用者實際操作網頁介面的真實回饋（「此區域不開放」的文字），這是任何 API 資料比對都無法取代的。