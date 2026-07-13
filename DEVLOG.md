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