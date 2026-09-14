# Project Guidelines: Modular Scraper Architecture

## 1. 獨立的爬蟲模組 (Team-Specific Independence)
雖然中信兄弟 (Brothers)、富邦悍將 (Fubon) 和味全龍 (WeiChuan) 皆使用相同的售票系統(宏碁資訊)，但其網頁結構、防爬蟲機制 (WAF)、以及特殊球區 (如輪椅席、活動席) 的設定可能會有些微差異。另外，**台鋼雄鷹 (TSG)** 使用的是完全不同的售票系統 (新零售平台)，採用不同的 API 結構。
- **不要假設各隊完全一樣**：當在某一隊的系統中發現問題並修復時，不要自動假設其他隊伍也需要完全相同的修復方式。特別是台鋼雄鷹，其系統架構與其他三隊截然不同。
- **隔離修改 (Isolated Modifications)**：當處理特定隊伍的 Bug 或功能調整時，請**嚴格限制**修改範圍在該隊伍專屬的爬蟲模組內 (例如 `src/services/scrapers/WeiChuanScraper.ts` 或 `src/services/scrapers/TsgScraper.ts`)，避免互相干擾。

## 2. 爬蟲邏輯的獨立性
- 各隊伍的爬蟲雖然繼承或實作相同的介面，但各自保有獨立的 `getGames()` 與 `getTickets()` 實作。
- 各球隊若有特定的 Headers (`referer`) 要求、不同的正則表達式解析規則，或是座位圖 (Image Map) 的特殊行為，都請寫在各自的模組中，落實「模組化切割」。台鋼雄鷹則有自己專屬的 API headers (如 `x-company-code`)。

## 3. 開發及測試流程
- 當正在針對特定球隊進行測試與開發時，請專注於該隊的特殊情境。專案根目錄的 `test_*.ts`（如 `test_rakuten_scraper.ts`、`test_uni_scraper.ts`、`test_allstar_only.ts`）是直接呼叫對應 Scraper 類別的驗證腳本，可用 `npx tsx test_xxx.ts` 執行。遇到阻礙時，以該隊伍的解決方案優先。

## 4. 台鋼雄鷹 (TSG) 專屬開發提示
- **不要用預設值猜總票數**：台鋼**不需要**、也**不應該**再用「依場地名稱帶入固定總票數（例：大巨蛋 37,000）」這種猜測式做法——這是舊版設計，已經拿掉。現行做法是 `getTickets()` 平行呼叫兩支官方 API：`seat-availability` 取得每分區真實剩餘票數，`activity-venues` 取得每分區真實座位容量（`seatCount`，連前/後拆分區、輪椅席、貴賓包廂都各自有獨立數字），兩邊用 `code` 對起來直接算出已售，不需要也不應該回頭改用猜測值。
- **`ignoreTag` 才是「此場次是否開放銷售」的旗標**：`activity-venues` 回傳的 `ignoreTag` 欄位是每場比賽各自獨立控制的（同一分區在不同場次會不一樣），`ignoreTag: true` 代表該分區這場比賽尚未開放銷售，此時 `seat-availability` 的 `availableSeats` 不可信，不能拿來計算已售/未售，必須排除在總計之外。
- **獨立售票 API 架構**：台鋼使用新零售平台，所以爬蟲不需要使用 cheerio 分析 HTML，而是直接介接 JSON API：`ticket-platform.newretail.tw`（`spotlight`、`seat-availability`）與 `ticket-info.newretail.tw`（`activity-venues`，注意是**不同主機**）。所有請求都必須在 Header 加入 `x-company-code: tsghawks` 才能正常發送。