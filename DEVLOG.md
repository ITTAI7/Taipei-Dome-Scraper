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

---

## 2026-09-15：台鋼 CSV 明細加入「座位數」欄位，並確認 `seatCount` 是網站寫死的真實資料、非推算值

### 背景

使用者發現台鋼的售票網站能拿到大巨蛋各區真實的座位總數、已售/未售票數，認為這份明細很有參考價值，可以拿來人工校正 `大巨蛋座位.json`（v1）。要求把「下載各區售票明細 CSV」的功能加上座位數欄位。

### 這次牽涉的三個問題點都跟 `ignoreTag`（尚未開放銷售）的分區有關

1. **CSV 新增「座位數」欄位**（[App.tsx](src/App.tsx) `handleExport`）：格式從 `區域,未售出票數,已售出票數,備註` 改成 `區域,座位數,未售出票數,已售出票數,備註`。**只有台鋼**（`activeTeam === 'tsg'`）會多這一欄，其他球團（utiki 三隊、ibon 三隊）沒有這麼權威的座位數資料來源，維持原本 4 欄格式，避免顯示一堆空白。座位數直接讀 `TicketZone.total`，本來就存在（[TsgScraper.ts](src/services/scrapers/TsgScraper.ts) 裡塞的就是 `activity-venues` API 的 `seatCount`），只是原本沒輸出到 CSV。

2. **`ignoreTag: true`（尚未開放銷售）的分區，`total` 原本也被寫成 `-1`**：因為前一篇（`ignoreTag` 才是真正的銷售旗標）修復時，把整個分區的 `unsold`/`sold`/`total` 一起標記成 `-1`（未知）。但 `seatCount` 是**場館固定配置**，跟這場比賽有沒有開賣完全無關（已在前一篇驗證過：同場館不同場次 `seatCount` 逐一比對一致）。所以改成只有 `unsold`/`sold` 維持 `-1`，`total` 照樣填入真實的 `info.seatCount`（[TsgScraper.ts:124-129](src/services/scrapers/TsgScraper.ts#L124-L129)）。連帶把 `total_capacity` 的加總邏輯（[TsgScraper.ts:140-147](src/services/scrapers/TsgScraper.ts#L140-L147)）從「靠 `unsold+sold` 反推」改成「直接加總每區的 `total`」，這樣未開賣分區的座位數才會被算進 CSV 總計列的座位數，跟各區加總對得起來。

3. **CSV 對未開賣分區的未售/已售數字有誤導性 bug**：使用者截圖發現，`此場次尚未開放銷售` 的分區在 CSV 裡，「未售出票數」欄位直接印出 `-1`，「已售出票數」欄位卻顯示一個很奇怪的正數（例如座位數 60、已售出卻寫 61）。追查發現是 [App.tsx](src/App.tsx) 舊邏輯 `sold = total - unsold`，當 `unsold` 是 `-1`（未知，不是真的 0）時算成 `total - (-1) = total + 1`，把「不可信」的佔位值當成真數字去運算，湊出一個看似合理、實則完全錯誤的已售票數。已售出票數欄位這樣的誤導性極大——`-1` 看起來像資料異常會有警覺，但 `total+1` 看起來就是個普通數字，容易被誤讀成真實已售票數。修法：`unsold`/`sold` 只要是負值就輸出空白字串，不印出 `-1` 也不拿去做運算；只有座位數欄位維持顯示真實數字。

### 最後確認：`seatCount` 是不是我們推算出來的？

使用者最後要求做一次確認：台鋼的座位容量是不是網站/API 直接給的資料，而不是我們程式自己算出來的。

直接對正式環境的兩支 API 各打一次驗證（`node -e "fetch(...)"`）：
1. `GET .../api/v1/public/spotlight` 抓一場大巨蛋的 `activityId`/`eventSessionId`。
2. `GET ticket-info.newretail.tw/api/v1/activity-venues/{AV_xxx}?...` 直接印出原始回應的前三筆，確認 `seatCount` 欄位本來就在裡面（例：B1 102區 189、B1 103區 576、B1 104區 724），伺服器端直接回傳的數字。
3. 對照 [TsgScraper.ts:36-38](src/services/scrapers/TsgScraper.ts#L36-L38)：`fetchSeatCapacityMap()` 只是把 `z.seatCount` 原封不動存進 `Map`，後面寫進 CSV 的 `total` 也只是這個值本身，中間沒有任何加總、拆分、或用樓層/分區號回推的計算邏輯。

**結論：台鋼的座位數是網站/API 寫死的權威資料，不是推算值**，可以放心拿來人工校正 `大巨蛋座位.json`。

---

## 2026-09-16：`大巨蛋座位v3.json` 上線，中信兄弟成為第一個接上台鋼權威容量表的其他球團

### 背景

使用者確認台鋼的 `seatCount` 是全部球團裡最準確的座位容量資料（見上面兩篇），提出兩個要求：
1. 把 `大巨蛋座位v2.json`（人工比對用的分析檔，結構是物件、含 `_說明`／`diff`／`tsg_codes` 等欄位）改版成 `v3`，結構比照 `v1`（純 `[floor, zoneNum, capacity]` tuple 陣列），這樣才能像 v1 一樣被程式直接讀取，而且要設計成「未來各球團都能共用」。
2. 先幫中信兄弟的「下載各區售票明細」CSV 加上座位數欄位（跟台鋼一樣），因為目前只有兄弟隊有大巨蛋場次可以實測；其餘球團之後再說。

### `大巨蛋座位v3.json` 怎麼生出來的

逐區比對 `v2.zones` 陣列：**優先採用 `tsg_total`**（台鋼官方數字），只有台鋼完全查無此分區時才 fallback 回 `capacity_v1`（v1 舊數字）。另外發現 `v2.tsg_only_zones_not_in_v1` 清單裡的 `TP143`（魔王席143區，`seatCount: 185`）其實就是 v1 的 `B1 143 區`（`capacity_v1` 也是 185，只是先前比對腳本沒把它跟 143 區對起來），所以也一併用台鋼數字補上，不用 fallback。

結果：102 個分區裡 90 個直接採用台鋼官方數字，12 個（`B1 213`、`L2 233~244`）台鋼沒賣、沿用 v1 舊數字。`L3` 的三個貴賓包廂跟 `L2` 外野貴賓席（台鋼有賣但 v1 完全沒有對應樓層/分區號）因為不符合任何現有球團的分區命名規則，v3 沒有收錄，純粹留在 v2 當參考。

檔案本身維持純陣列、無註解（JSON 不支援），改版說明寫在這裡跟 `NOTE.md`，不寫進檔案本身，避免破壞「跟 v1 一樣可以直接 `JSON.parse` 成 tuple 陣列」的相容性。

### 共用容量表工具：`src/services/scrapers/domeSeatMap.ts`

新增檔案，把 `loadSeatCapacityMap()`（讀檔＋轉 `Map<"floor-zoneNum", capacity>`）、`extractFloorZone()`（從中文分區名稱 regex 出樓層＋分區號，沿用 ibon 三隊 `RakutenScraper`/`UniScraper` 既有的判斷式）獨立出來，讓未來要接上這份容量表的球團都能直接 import，不用像 ibon 三隊那樣三隻檔案各自複製貼上一份幾乎一樣的程式碼。

另外提供 `patchMissingTotalsFromCapacity(details, capacityMap)`：**只在該分區完全沒有真實 `total` 時才用容量表回填**，已經抓到真實資料的分區一律保留原值不覆蓋，輪椅／陪伴席（v3 沒有涵蓋）略過不補。這跟 ibon 三隊的 `patchDomeCapacity()` 邏輯類似但更單純——因為中信兄弟目前沒有「同一分區拆前/後排分開賣」的情況（見 2026-09-14 那篇的分析），不需要 ibon 那套「同區多列、缺值那列要跟已知列合併回推」的 blockMap 邏輯，一分區一列直接查表即可。

**依 `AGENTS.md` 的隔離修改原則，這次只讓 `BrothersScraper.ts` 接上這個新模組**，樂天／統一／明星賽三隊的 `loadDomeSeatMap()`／`patchDomeCapacity()` 仍讀舊的 `大巨蛋座位.json`（v1），味全龍／富邦也還沒接，都刻意維持原狀，避免同時牽動多隊行為、增加排查風險。

### `BrothersScraper.ts` 的改動

建構子多載入 `this.domeSeatMap = loadSeatCapacityMap(DOME_SEAT_MAP_V3_FILE)`；`getTickets()` 在組完 `details`、加總 `sum_sold`/`sum_capacity` 之前，插入一行 `patchMissingTotalsFromCapacity(details, this.domeSeatMap)`。原本「連結被清除」（完售但抓不到數字）或「遭 WAF 阻擋」的分區，`total` 會從 `-1` 變成 v3 裡的真實座位數，`total_sold`/`total_capacity` 的加總也會連帶變得更完整（原本這些分區因為 `sold < 0` 被跳過不計）。

### `App.tsx` 的改動

`handleExport()` 的 `includeSeatCount` 從只判斷 `activeTeam === 'tsg'` 改成 `activeTeam === 'tsg' || activeTeam === 'brothers'`，CSV 就會多印出「座位數」欄，讀的一樣是 `TicketZone.total`（不用另外改欄位讀取邏輯，因為前面 `patchMissingTotalsFromCapacity` 已經把該填的 `total` 填好了）。

### 待辦

味全龍／富邦悍將日後若也要加這個欄位，直接比照 `BrothersScraper.ts` 的兩行改動接上 `domeSeatMap.ts` 即可；ibon 三隊（樂天／統一／明星賽）則等它們真的開賣、能實測 ibon 座位圖的前/後拆分區命名規則後（見 2026-09-14 的待辦），再評估要不要把 `loadDomeSeatMap()` 從 v1 換成 v3。

---

## 2026-09-16（續）：使用者查核發現「兄弟隊不會拆前/後排」的假設是錯的，`patchMissingTotalsFromCapacity` 改寫成 `patchDomeCapacity`

### 背景

上面那篇實作完成後，使用者看著 `大巨蛋座位v2.json` 裡台鋼的前/後排拆分資料（`tsg_codes` 的 `TP106B`/`TP106F` 這類），反問：「v3 版要如何分別前後排，而且兄弟也有在賣前後排，你要先查核一下」。

這個提問直接戳破了上一篇沿用 2026-09-14 那篇分析（「兄弟／味全龍／富邦目前沒有同一分區拆前/後排分開賣的情況」）所做的假設——**那篇分析是 2026-09-14 當下的觀察，不是永久不變的事實，這次沒有重新查核就直接套用，是這次的疏失**。

### 查核方式

直接跑 `npx tsx test_brothers_scraper.ts`（對正式環境發真實請求），把 `[進度] 讀取分區:` 這行 log 全部列出來看分區名稱。結果**兄弟隊確實會拆前/後排**：

```
B1內野105區前排 / B1內野105區後排
B1內野106區前排 / B1內野106區後排
B1內野107區前排 / B1內野107區後排
B1內野108區前排 / B1內野108區後排
B1內野109區前排 / B1內野109區後排
B1內野110區前排 / B1內野110區後排
B1內野112區前排 / B1內野112區後排
B1內野113區前排 / B1內野113區後排
B1內野114區前排 / B1內野114區後排
B1內野116區前排 / B1內野116區後排
B1內野117區前排 / B1內野117區後排
B1內野118區前排 / B1內野118區後排
B1內野119區前排 / B1內野119區後排
B1內野120區前排 / B1內野120區後排
B1內野121區前排 / B1內野121區後排
```

而 111、115 區跟所有 B1 外野（131~146）、所有 L2 分區都是單一列，沒有拆。

**更關鍵的發現：兄弟的拆法跟台鋼不完全一樣。** 對照 `大巨蛋座位v2.json`，台鋼只有 106、107、108、109、110、112、113、114、116、117、118、119、120 這 13 區有拆（`TP106B`/`TP106F` 這種代號），**105 區跟 121 區台鋼是單一代號**（`TP105`、`TP121`，各自 795 個座位，沒有前/後之分）——但兄弟隊自己的網站，105 跟 121 這兩區也拆成前/後排在賣。代表兩個售票系統對「哪裡是前後排分界線」的認定不完全相同（跟 DEVLOG 更早篇幅提到「台鋼跟 v1 對走道/無障礙席/視角受阻座位的認定不完全相同」是同一類問題），不能直接假設兩邊的分區結構一致。

### 為什麼這對原本的實作是個問題

`v3` 容量表每個 `floor-zoneNum` 存的是**整區合計**（前+後加總），沒有前/後排各自的容量。上一篇寫的 `patchMissingTotalsFromCapacity()` 是「每一列各自查表、直接把整區容量塞進去」——如果兄弟前排跟後排剛好都抓失敗、都是缺值，這個函式會把整區容量（例如 105 區 795）**分別塞給前排跟後排兩列**，等於整區容量被算了兩次，`total_capacity` 會被灌水。

### 修正：改用跟 ibon 三隊一樣的「同區歸戶」策略

把 `domeSeatMap.ts` 的函式從 `patchMissingTotalsFromCapacity()` 改寫成 `patchDomeCapacity()`，邏輯比照 `RakutenScraper.ts` 的版本：

1. 用 `extractFloorZone()`（只看樓層＋分區號，不管有沒有「前排」「後排」字樣）把 `details` 依 `floor-zoneNum`分組——同一分區不管拆成幾列，都會被分到同一組。
2. 組內任何一列已經有真實 `total`，就計入 `knownTotal` 並標記 `hasRealData = true`；沒有的列記錄索引待補。
3. **有其他列已知（`hasRealData`）**：剩餘容量 = 整區容量 − 已知列合計，塞給第一個缺值列；如果同一組還有第二個以上缺值列，因為已經沒有依據再繼續拆，維持未知並註記「容量已併入同區」，避免重複計算。
4. **這一組只有一列（該分區本來就沒拆前/後）且這一列本身缺值**：因為不存在「跟另一列重複計算」的風險，直接用整區容量回填。
5. **這一組有 2 列以上、但全部缺值**（例如整區被 WAF 擋、105 前排後排都抓失敗）：不知道容量該怎麼分配給前/後排，兩列都維持未知，不亂猜。

### 驗證

寫了一個一次性腳本（跑完即刪除，不留在專案裡）用合成資料直接呼叫 `patchDomeCapacity()` 測四種情況：
- 拆分區、一列已知一列缺值 → 缺值列正確補上「整區容量 − 已知列」的剩餘量。
- 拆分區、兩列都缺值 → 兩列都維持 `-1`，不亂猜。
- 單一列分區缺值 → 直接補上整區容量。
- 輪椅席缺值 → 略過不動。

四種情況都符合預期。另外也重新對正式環境跑一次 `BrothersScraper.getTickets()`，這次剛好兩排都有抓到真實資料（例如 108前排 180、108後排 368），沒有觸發任何回推分支，`patchDomeCapacity()` 直接放行不覆蓋，驗證「已有真實資料的分區不會被容量表誤蓋掉」這件事也成立。

### 教訓

- **「目前觀察到 X 沒有 Y 情況」是某個時間點的觀察，不是永久保證**，套用舊分析前，尤其是牽涉到會不會重複計算容量這種容易出錯的地方，應該重新對正式環境查核一次，而不是直接引用幾天前的 DEVLOG 結論。
- 這次問題被使用者一句「你要先查核一下」點出來，代表**「先實作、事後才查核」的順序是錯的**——牽涉到容量分配這種有「重複計算」風險的邏輯，應該在寫回推邏輯之前，就先用測試腳本驗證真實資料的分區結構，而不是照抄別的球團或別的資料來源的既有假設。

---

## 2026-10-07：依外部健檢報告（`系統健檢報告.md`）逐條查核後的修正

使用者請 DeepSeek 產了一份健檢報告，逐條對照實際程式碼後，只採納確實成立、且不違反 `AGENTS.md` 隔離原則的項目。

### 已修正

| 報告編號 | 問題 | 修正 |
|---|---|---|
| #8 | utiki 三隊座位圖頁「既無 DOM 也無 `seatStr`」時寫成 `sold=0`，變成看似真實的 0/0（即 2026-06-26 篇的「路徑 3」） | 兄弟／富邦／味全**各自檔案內**修改：改為 `sold=-1, total=-1`、備註「座位圖解析失敗」；「熱賣中」等非數字狀態排入熱區時 `unsold` 先填 `-1`（原本填 0）。`unsold=-1` 不計入 `total_unsold`，加總容量時也不再把 `-1` 加進去 |
| #1 | `server.ts` 把味全龍登入的 RVT／JWT／Cookie／Set-Cookie／登入回應本文、以及含 `sessionToken` 的完整 URL 印進 log | 移除；登入只記狀態碼與 Set-Cookie 數量 |
| #6 | SSE 查詢中使用者關掉分頁，server 仍會重試並持續寫入 | 用 `res.on('close')` 標記斷線，之後不再重試、不再寫事件（報告建議的 `req.on('close')` 在 Node 16+ 會在請求本文讀完時就觸發，不能用）。進行中的那一次抓取仍會跑完，沒有往各隊 scraper 內部傳取消訊號 |
| #9 | `npm run clean` 用 `rm -rf`，Windows cmd 沒有這個指令 | 改用 `node -e "require('fs').rmSync(...)"` |
| #10 | `start_all.bat` 用 `taskkill /IM node.exe` 會殺掉整台機器所有 node（實測當下就有一個別的工具的 MCP server 在跑） | 改成只關「命令列含本專案路徑」的 node（tsx watch、server、localtunnel） |
| #11 | `.venv/` 沒有列在 `.gitignore` | 補上 |
| #12 | 未使用的依賴 `@google/genai`、`iconv-lite`、`motion`、`ngrok` | `npm uninstall`（express／cheerio 自己需要的 iconv-lite 仍以間接依賴存在） |
| #16 | `App.tsx` 用了已棄用的 `substr` | 改 `slice(2, 11)` |

**#8 的影響**：中信兄弟有 `patchDomeCapacity()`，舊行為下 WAF 中斷或解析失敗的「熱賣中」分區 `unsold=0`，會被回推成「已售＝整區容量」（看起來整區賣光）。現在這種分區 `unsold=-1`，只回填 `total`（座位數），已售維持未知；`total_capacity` 也會把這種「容量已知、已售未知」的分區算進去。富邦／味全沒接容量表，只是不再顯示假的 0/0。

**驗證**：寫了一次性離線測試（不留在專案裡），把 `globalThis.fetch` 換成假的售票站回應（4 個熱區＋1 個輪椅席，其中 3 個座位圖頁是空白頁），三隊都跑過：正常分區（有 `seatStr`）結果跟修改前完全一致，解析失敗的分區改為未知。實際場次無法驗證：當天兄弟、富邦都查無大巨蛋場次，味全需登入。另外實際啟動 server 驗證：`/api/config`、首頁正常；SSE 中途斷線會記錄 `Client disconnected`、之後不再送事件；沒斷線時錯誤事件照常送達；新的 `start_all.bat` 清理指令只關掉本專案的 node，其他工具的 node 沒被動到。

### 不採納（及理由）

- **#2 味全 `cookieStore` 加 TTL**：每次載入驗證碼只多一筆幾百 bytes 的字串，實際用量下成長可忽略；前端收到 401 已會清掉 `localStorage` 的 token。
- **#3 `localFetch` 放寬憑證**：已經只在「本機模式＋偵測到弱金鑰錯誤」時才放寬；網域白名單是刻意不做的（攔截代理鎖的網域會變，見 2026-09-07 篇）；偵測漏判時是「直接失敗」而不是「放寬」，方向是安全的。
- **#4 `uncaughtException` 改成直接結束程序**：本機用 `tsx watch` 跑，結束後要等下次存檔才會重啟，等於 server 直接掛掉，反而更糟。
- **#5 Port 改讀 `process.env.PORT`**：AI Studio 部署目前用 3000 正常運作，改了沒有好處、反而多一個不確定性。
- **#7 抽共用 `UtikiScraperBase`**：違反 `AGENTS.md` 的各隊獨立原則。報告提到味全缺「網站有異常情況」重試，但味全需登入，目前無法實測，先不動。
- **#13／#14／#17／#18／#19／#20**：都是不影響功能的小事（沒用到的 path alias、啟動時同步讀小檔案、sleep 常數、台鋼的假 URL 傳參數、味全逐場館查 `og:title`、`metadata.json` 名稱重複），改了的效益低於風險。
- **#15 根目錄 debug 截圖**：不必照報告建議改搬到 `debug/` 目錄。目前程式已沒有任何地方會產生這些檔案，是舊版殘留，經使用者同意後直接刪除（125 張；其中 `s1_initial.png` 有進版控，用 `git rm`）。`.venv/`（約 140MB）也一併刪除。

處理結果另以回覆段落寫回 `系統健檢報告.md` 文末，作為跟 DeepSeek 下一輪健檢的溝通介面。

### 報告本身的錯誤

- 報告說「驗證碼路由也 log 了 RVT／JWT／Cookie」——實際上是登入路由，驗證碼路由沒有。
- 報告說三隊的 `getTickets` 都包含 `patchDomeCapacity`——實際上只有中信兄弟有接。
- 報告說斷線後 `res.write` 會 throw——Node 不會 throw，只是寫入無效。

---

## 2026-10-07（續）：味全龍台灣大賽實測——會員優先購買期間被誤顯示成「被 WAF 擋」

### 背景

味全打進台灣大賽，大巨蛋有 10/17、10/18、10/23、10/24、10/25 五場（`PRODUCT_ID=P1G9BHCY`）。使用者回報「現在有身分驗證，無法查」，並提供帳號讓 Claude 實測。

### 查到的事

- `PerformanceListControl` 回傳的 `#buy_btn` 是 `VipSellCheck('P1GKL1IE')`，按鈕文字「2026狂龍軍會員優先訂購》」，HTML 裡沒有任何 `PERFORMANCE_ID=` 連結。
- 對照站方 `UTK0201.min.js`：`VipSellCheck(i)` 的參數 `i` 就是 `PERFORMANCE_ID`。流程是「需會員登入 → `POST UTK0201_/VIP_SELL_INFO` 檢查資格 → 通過才 `DoVIPLogin`」。
- 不登入直接開 `UTK0204_?PERFORMANCE_ID=P1GKL1IE` → 頁面只有 `top.location.href = '/'`，被踢回首頁。
- 用使用者帳號登入（驗證碼由 Claude 讀圖輸入）成功，但 `VIP_SELL_INFO` 回 `ACTION_ERROR: "很抱歉！您不符合該階段優先購買資格！"`，`AUTH_TIME: 2026/10/7 下午 11:59:00`（這一階段到當天 23:59 結束），`UTK0204_` 仍被踢回首頁。→ 帳號不是狂龍軍會員，這個階段本來就查不到，**不是程式問題**。

### 修正

原本 `WeiChuanScraper` 丟 `Could not find PERFORMANCE_ID ... Maybe login session expired?`，`server.ts` 看到 `PERFORMANCE_ID` 字樣又翻成「Blocked by WAF/Cloudflare or structure changed」，使用者會以為被擋。改成跟 `BrothersScraper` 一樣：沒有 `PERFORMANCE_ID` 但有 `#buy_btn` 文字時，丟「⏳ 此場次目前尚未開放一般購票：2026狂龍軍會員優先訂購》」。只改 `WeiChuanScraper.ts`。用同一個登入 session 實際重跑 10/17、10/18 兩場，訊息正確。

### 尚未支援

爬蟲不會自動走會員優先購買的資格驗證（`VIP_SELL_INFO` → `DoVIPLogin`）。會員階段要查，需要符合資格的帳號，再另外實作這段流程。一般販售開始後，按鈕應該會變回一般購票連結，屆時再實測「網站有異常情況」重試與 0/0 修正。

---

## 2026-10-14：`大巨蛋座位v3.json` 補上 L3 內野 Lounge 區與 L3 左/右外野（FamilyZone）

### 背景

味全台灣大賽 G1（10/17）CSV 出現 `FamilyZoneL3右外野`、`FamilyZoneL3左外野` 兩列，完售，已售欄空白。使用者要求：FamilyZone 是大巨蛋原本就有的區域，不是球團另外劃出來的，應該收進 v3；以後只要有 v3 沒收錄、但有開賣的區域，也一樣補進去，目標是收錄大巨蛋所有座位。

### 查到的事

- 台鋼 `activity-venues` 的 160 個分區**沒有任何 L3 外野**。L3 只有 `TP3FB`／`TP3SB`／`TP3TB` 三個貴賓席，`hasSeatPlan=false`，`seatCount` 是 1000／300／1000 的佔位數字。連 L3 301–304、314–317 也沒有，所以 L3 沒辦法拿台鋼比對。
- 味全商品頁（`P1G9BHCY`）說明：Family Zone 是外野 L3 貴賓樓層的親子專區，有沙發座椅和兒童遊戲區，左右外野設施不同。從 Gate 11 專屬通道搭電梯上 L3，**自由入座**。官方沒公布席數。自由入座就沒有座位圖，所以爬蟲數不到座位，不是程式問題。
- 維基百科「臺北大巨蛋」分層席數（無註腳）對照 v3：內野下層 13,423 ≈ B1 內野 13,266；中層 9,209 ≈ L2 內野 9,069；上層 7,179 ≈ L4+L5 7,101。所以維基的「VIP 層」就是 L3。外野 VIP 層 334 席是 FamilyZone 左右合計的上限。

### 修改

- `大巨蛋座位v3.json`：L2 與 L4 之間新增 L3 共 10 筆。
  - 301–304、314–317：座位數取自味全 10/17 座位圖的已售＋未售，左右對稱，合計 1,300。
  - `["L3", "左外野", null]`、`["L3", "右外野", null]`：座位數未知填 `null`，不填估計值。
- `domeSeatMap.ts`：型別放寬為 `[string, number | string, number | null]`，`loadSeatCapacityMap()` 略過非數字的座位數，避免 `null` 在回推時被當成 0。`extractFloorZone()` 仍只認 B1/L2/L4/L5，中信兄弟的回推行為不變（已用 B1 107 單區回填、L3 301、FamilyZone 三種列實測）。
- `NOTE.md` 記下 v3 的收錄規則與這批資料的來源。

### 同日追加：輪椅／陪同席也收進 v3

使用者問：輪椅／陪同席當初為什麼不計入？如果有實際數字和區域，應該也能收。

**以前不收的原因**（不是刻意排除，是資料與格式限制）：
- 5 月 ibon 時期，輪椅席沒有座位圖連結（`error: '無座位圖連結'`），ibon 公告也寫「需使用輪椅之身障者請至現場購票」，網路上的數字本來就不完整。v1 是從 ibon 座位圖回推的，所以沒有輪椅數字。
- v3 沿用 v1 的「樓層-數字區號」鍵值。`B1內野108區輪椅席` 解析出來也是 `B1-108`，會跟本區撞在一起，所以 `patchDomeCapacity()` 直接跳過輪椅列。
- 9 月接上台鋼 `activity-venues` 之後，每個輪椅、陪同席都有獨立代號與 `seatCount`（`TP108W`／`TP108WF`…），但 v3 當時只照 v1 的範圍換數字，沒有擴充。

**對照**：台鋼 52 個輪椅／陪同代號合計 248 席。味全 10/17 雙方都有的 48 個代號裡 43 個一致，5 個味全較少（109W 4/6、110W 1/3、110WF 1/3、117W 5/6、117WF 5/6）。採台鋼數字。（更正：原本推測這 5 個是單場保留，但同日 13:36 重抓時全部跟台鋼一致，見下一段。）

**修改**：`大巨蛋座位v3.json` 在各本區後面插入 `["B1", "108輪椅席", 7]`、`["B1", "108輪椅陪同席", 7]` 格式的條目，共 56 筆、264 席（台鋼 248 席＋味全 L3 304／314 各 4＋4）。用 `JSON.stringify(_, null, 2)` 重寫前已先確認原檔格式完全一致。重跑讀表：166 筆有數字，合計 38,384；兄弟回推結果不變。

### 同日追加：味全龍接上 v3 容量表回填

使用者確認這次台灣大賽只有味全、兄弟兩隊在賣，所以味全先接 v3，富邦等有開賣再接。

**修改**
- `WeiChuanScraper.ts`：跟兄弟一樣，在讀完所有座位圖後呼叫 `patchDomeCapacity(details, this.domeSeatMap)`。總容量計算加上「剩餘數未知、但 total 已回填」的分支。
- `domeSeatMap.ts` 的 `patchDomeCapacity()`：同區只有一列、而且名稱帶「前排／後排」時不回填。原因是味全 10/17 只列「B1內野104區前排」（259 席），沒有後排；如果這列抓取失敗，舊邏輯會把它當成沒拆前後排的整區，填入 v3 的 724 席。這條防護也套用在兄弟，只會讓原本會填錯的情況改成維持未知。
- `App.tsx`：CSV 的「座位數」欄加入味全。

**驗證**（味全 getTickets 需要登入，所以用 10/17 實際 CSV 做離線測試，腳本沒有留在專案裡）
- 原始資料直接跑 `patchDomeCapacity()`：0 列被改動（10/17 每個分區都有抓到座位圖）。
- 模擬失敗：104 前排單獨失敗 → 維持未知；105 後排失敗、前排已知 352 → 後排補 443；107 完售且連結被拿掉 → 補 732；108 輪椅席、L3 301、FamilyZone → 不動。
- `tsc --noEmit` 通過。

**誤差範圍**：回填用的是場館固定容量，可能跟單場實際開賣的座位差幾席（107 區味全座位圖 720 席，v3 732 席）。使用者確認這屬於誤差範圍：v3 的目的是記大巨蛋本身的座位數，台鋼後台暫且視為最接近完整的來源，球團開賣時的保留或調整不拿來改 v3。

## 2026-10-14（續）：實測拓元 (tixcraft) 大巨蛋演唱會爬蟲（寫完後決定不爬，程式已移除）

### 背景

使用者要查 F✦FOREVER（F4）11/28、11/29 大巨蛋演唱會，售票平台是拓元。專案之前沒有抓過拓元，`ScraperFactory.ts` 只留了一行「之後可加 tixcraft」的註解。

### 實測結果

| 項目 | 結果 |
|------|------|
| 防護 | Ticketmaster 自家的 EPS（`/eps-mgr`、`/epsf/…/eps.js`、`iamNotaRobot.js`），前面是 Fastly CDN，**不是 Cloudflare** |
| 節目列表 `/activity` | 純 HTTP 200，卡片上有場地欄，可直接篩「臺北大巨蛋」 |
| 場次頁、選區頁 | 純 HTTP 401 `{"response":"identify"}`（回應標頭帶 `ebid`／`esid`） |
| headless Chrome | 403，過不了 |
| 有視窗的本機 Chrome | 自動通過：401 → `identify.json` → `POST /epsf/gec/v3/TAActivity` → 重新載入 200，全新設定檔約 6.5 秒，不用手動點 |
| 通過後的頁內 `fetch()` | 選區頁直接 200，不必重新渲染整頁 |
| 選區頁 | 不用登入，每區顯示「剩餘 N／已售完」，依票價分組（`.zone-label` ＋ `ul#group_N`） |
| 自行選位座位圖 `/ticket/select-seat/…` | 沒登入會被導回首頁 → 不使用 |
| 【台新Richart卡友專區】場次 | 選區頁被導到 `/ticket/verify/…`，要輸入卡號前 8 碼 → 不查 |
| 已售完／截止場次（Stray Kids 12/12） | 選區頁被導回 `/activity`，拓元不再公開分區資料 |

### 設計

- **找場次**：節目列表用純 HTTP（`localSafeFetch`）抓，篩場地含「大巨蛋」、排除返鄉專車。沒有大巨蛋演唱會時完全不開 Chrome。各活動的場次頁再走瀏覽器，只留場地是大巨蛋、日期未過的場次；一般場次排在【…】限定專區前面。
- **共用瀏覽器 session**（`TixcraftBrowserSession`，模組層級單例）：借用 `launchIbonBrowser()` 開有視窗的本機 Chrome，設定檔放 `%TEMP%\.tixcraft-browser-data`（`eps_sid` 效期 30 天，下次開通常不用再驗證）。通過 EPS 後一律用頁內 `fetch()` 抓 HTML，遇到 401 identify 才導頁重新驗證（最多等 120 秒，期間可手動處理互動式驗證）。所有請求排隊、間隔至少 1.5 秒；閒置 2 分鐘自動關 Chrome。
- **已售出回推**：看台區名稱（`B1看台104區`、`L3看台301區`…）對到 v3 的 `樓層-區號`，已售 = v3 座位數 − 剩餘張數。同一看台區若拆成多種票價，整區容量放第一列、用整區剩餘回推，其餘列不重複計算。搖滾區、身障區沒有可靠座位數，維持未知（身障區對不上 v3 的輪椅席／陪同席，因為不確定一張身障票含不含陪同席）。
- **資料說明 `notes`**：`TicketInfo` 新增選填欄位 `notes`，前端在結果下方列出：搖滾區等沒算進已售出（實際會更多）、看台保留座會被算成已售出、同場另有限定專區（其剩票會被算成已售出）、資料時間。
- **查不到的場次**：卡友驗證、已售完、截止、要登入 → 丟 `TIXCRAFT_INFO:` 開頭的錯誤，`server.ts` 改回 409，前端只顯示訊息，不附「可能被 WAF 擋」的通用說明。
- **前端**：新增「大巨蛋演唱會」分頁。拓元場次要開 Chrome 才抓得到，所以**點到分頁才載入**，不在開網頁時一起抓。雲端模式跟 ibon 三隊一樣停用（`IBON_TEAMS` 改名 `LOCAL_CHROME_TEAMS` 並加入 tixcraft）。CSV 加入座位數欄。

### 驗證（2026-10-14）

- `npx tsx test_tixcraft_scraper.ts`：找到 2 檔大巨蛋活動、7 個場次。
  - F✦FOREVER 11/28 一般場：110 區、剩 1,106 張；79 個看台區對到 v3，容量 28,283、已售 27,403；31 區（搖滾＋身障）未知，剩 226 張。
  - F✦FOREVER 11/29 一般場：110 區、剩 1,148 張、看台已售 27,338。
  - 兩個 Richart 專區 → 「需卡號驗證」訊息；Stray Kids 一般場 → 「已售完」訊息；兩個會員專區 → 「2026/09/19 11:00 截止」訊息。
- dev server：`/api/get_games/tixcraft`、`/api/get_tickets/tixcraft`（JSON 與 SSE）正常；已售完場次回 409。
- 前端（headless 驅動 localhost）：點分頁才載入 7 個場次，查詢後四張卡片與資料說明正常顯示，已售完場次只顯示訊息。
- `tsc --noEmit` 通過。

### 已知限制

- 「剩餘 N」目前看到的最大值是 45。還不確定拓元是照實顯示，還是張數多時會封頂或改顯示「熱賣中」；程式已處理「熱賣中」（列為未知），之後開賣初期再觀察。
- 已售完的場次拿不到分區資料，算不出已售出。若要支援，需要在開賣期間先存下分區清單，之後再用 v3 座位數回推。

### 同日決定：不爬演唱會，程式已移除

使用者看過結果後決定不爬演唱會，上面的程式（`TixcraftScraper.ts`、測試腳本、前端「大巨蛋演唱會」分頁、`server.ts` 的 409 處理、`TicketInfo.notes`）全部移除，沒有 commit 過。這篇留著當實測紀錄，以後要重做可以照著做。

**理由**
- **搖滾區推算不出來**：搖滾區在場地中央，不在大巨蛋正常的座位範圍，大小取決於舞台設計、坐席或站席、劃幾個區塊，每場都不一樣（F✦FOREVER 有 A1–A11、B1–B8 共 19 區）。拿其他演唱會的數字來推估，誤差可能是好幾千人，也違反「不填估計值」的原則。「搖滾區最早完售」只說明它賣完了，沒說它有多大。
- **完售場次拿不到資料**：大巨蛋演唱會一般都會完售（實測當天 Stray Kids 已售完、F✦FOREVER 看台只剩約 1,100 張），但完售後拓元會關掉選區頁。最常見的情況剛好爬不到。
- **數字會誤導人力試算**：F✦FOREVER 11/28 畫面顯示已售出 27,402、支援人力 20 人，但這只算了看台。加上搖滾區後很可能跨到下一個級距（30,000～40,000 → 29 人）。

**以後要估演唱會人力時**：不要靠爬蟲，直接當滿場，人數用主辦單位或新聞公布的規模，每場自己填。

### 同日追加：13:36 重抓 10/17（L2 外野開賣後）

- **輪椅／陪同席**：52 列都是從座位圖讀出來的（沒有任何備註），共 252 席，未售 207、已售 45，全部跟 v3（台鋼）一致。早上少掉的 109／110／117 那幾席，這次都變成「已售」，所以早上不是單場保留。比較可能是那幾席正在交易中，`seatStr` 的狀態碼不在 0／1／3／4 裡，沒被數到。這個狀態碼要登入後看到實際資料才能確認，目前先不改程式。
- **總計有算進輪椅席**：CSV 總計（座位 35,080／未售 287／已售 34,693）跟逐列加總完全相同。剩下的 287 張未售票裡有 207 張是輪椅／陪同席。
- **L2 外野 233–244**：全部是 v3 已有的分區，不用新增。台鋼沒有這幾區，v3 數字來自 v1。味全合計 3,864 席，v3 是 4,040 席，跟 L2 內野味全每區比台鋼少 18–25 席的模式一致，依「v3 記大巨蛋本身座位數」的原則維持不改。
- **回填實際觸發**：B1 外野 131 區這次「座位圖解析失敗」，由 v3 回填 100 席。早上同一區的座位圖是 75 席，所以這筆回填多了 25 席，屬於使用者接受的誤差範圍。L4／L5 味全比 v3 少得更多（例：503 區 69 對 115），這些區如果抓取失敗，回填也會偏高。

### 同日追加：FamilyZone 在 CSV 備註寫出說明

使用者擔心時間久了會忘記 FamilyZone 是什麼，也會忘記座位數為什麼是空白，要求寫在 CSV 備註。`WeiChuanScraper.ts` 在回填之後，對名稱含 `FamilyZone` 的列加上說明：外野 L3 貴賓樓層的親子專區、自由入座沒有座位圖、官方沒公布席數所以留白不估、剛開賣時的未售張數就是總席數、參考上限 334 席（維基外野 VIP 層，左右合計）。網頁畫面不逐區顯示，這段只出現在 CSV。說明沿用 `error` 欄位，跟「自動補齊同區剩餘總數」一樣。因為 CSV 會把備註包在雙引號裡，文字裡不能有半形雙引號。

### 同日追加：味全座位圖讀不到時改成會重抓

**問題**：13:53 重抓 10/17，「座位圖解析失敗」從 1 區增加到 11 區：B1 外野 131–135、L5 511–515 各連續 5 區，加上 L3 304 輪椅陪同席。味全每次同時讀 5 區，整批一起失敗比較像站方對同時送出的請求限速，不是座位圖本身的問題。

**原因**：舊程式雖然有 `while (retries < 3 && !success)`，但讀到沒有座位資料的頁面會直接標「座位圖解析失敗」並設 `success = true`，`retries` 也從沒遞增，所以實際上一次都沒重試。

**修改**（只改 `WeiChuanScraper.ts`）
- 讀座位圖拆成 `readSeatMap()`，讀不到時回傳 `null`，並在 log 印出狀態碼、長度、是否為 WAF 頁、頁面標題（不印 cookie）。
- 第一輪照舊 5 區同時讀。讀不到的先記下來，第一輪結束後等 2 秒，一區一區、間隔 0.8 秒重抓；第二輪等 4 秒再重抓一次。還是讀不到才標「座位圖解析失敗」，交給 v3 回填。
- `total_unsold` 改成每區確定結果時才加（`finishZone()`），避免重抓成功時重複計算。
- 連線錯誤（`WAF_BLOCKED`）照舊中斷整體讀取，那種情況不重抓。

**驗證**：假的售票站（`globalThis.fetch` 換成假回應，腳本沒有留在專案裡）。131–135 第一次回錯誤頁、第二次正常 → 第一輪重抓全部讀到；137 一直回錯誤頁 → 共試 3 次後標失敗，v3 回填 291；總計（未售 13／已售 60／座位 364）正確。`tsc --noEmit` 通過。實際效果要登入後跑真的場次才能確認。

### 版本 v0.92

這次 push 包含：v3 收錄 L3、FamilyZone、輪椅／陪同席，味全接上 v3 回填，FamilyZone CSV 備註，味全座位圖讀不到時會重抓。首頁標題由 v0.91 進到 v0.92，同時在 `AGENTS.md` 第 6 節訂出版本號規則。
