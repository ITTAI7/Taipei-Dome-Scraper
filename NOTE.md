# 各球團票數抓取邏輯筆記

給自己回憶用的速查表。每個球團的爬蟲都在 `src/services/scrapers/`，統一透過 `ScraperFactory.getScraper(platform)` 建立。

## 總覽表

| 球團 | 售票系統 | 抓法 | 是否需要瀏覽器 | 是否需要登入 |
|---|---|---|---|---|
| 中信兄弟 Brothers | utiki（`tix.ctbcsports.com`） | 純 HTTP | 否 | 否 |
| 味全龍 WeiChuan | utiki（`tix.wdragons.com`） | 純 HTTP | 否 | **是**（帳密+驗證碼） |
| 富邦悍將 Fubon | utiki（`guardians.fami.life`） | 純 HTTP | 否 | 否 |
| 台鋼雄鷹 TSG Hawks | 自家 JSON API（`ticket-platform.newretail.tw` + `ticket-info.newretail.tw`） | 純 JSON API | 否 | 否 |
| 樂天桃猿 Rakuten | ibon（`ticket.ibon.com.tw` / `orders.ibon.com.tw`） | 先試 HTTP，失敗才開瀏覽器 | 視情況 | 否 |
| 統一獅 Uni | ibon（同上） | 同上 | 視情況 | 否 |
| 職棒明星賽 AllStar | ibon（同上） | 同上 | 視情況 | 否 |

共用邏輯：`ITicketScraper.ts` 定義介面（`getGames()` / `getTickets()`），`ScraperFactory.ts` 依球團字串挑選對應 class，`localFetch.ts` 包了一層 `fetch`。

---

## utiki 系統三隊：中信兄弟 / 味全龍 / 富邦悍將

這三隊用的是同一套售票系統（utiki，只是網域和隊徽不同），程式邏輯幾乎一模一樣，是三份幾乎複製貼上的檔案。

**流程：**
1. `GET UTK0101_` 取得 `__RequestVerificationToken`、`__JWtToken` 和 cookie。
2. `POST UTK0101_/GET_CALENDAR_EVENTS` 取得場次清單（回傳格式是 `_cevent = [...]` 這種 JS 賦值字串，要用 regex 挖出 JSON）。
3. 篩選出「臺北大巨蛋」場次：
   - 兄弟：用 `PLACE_ID === 'P18PM5NV'` 精準比對。
   - 味全龍：**沒有固定 PLACE_ID**，是先把每個 PLACE_ID 對應的場次頁抓下來、看 `og:title` 有沒有「大巨蛋」字樣，用這個方式反推——因為味全龍主場不固定（新莊/天母/大巨蛋都有可能）。
   - 富邦：直接看 `PLACE_NAME` 字串是否包含「大巨蛋」，最簡單。
4. 進入 `UTK0201_?PRODUCT_ID=...&STARTDATE=...` 場次頁，再呼叫 `PerformanceListControl` 拿到真正的 `PERFORMANCE_ID`（如果還沒到開賣時間，這裡會抓不到，要看 `#buy_btn` 文字判斷「尚未開賣」，不要誤判成被擋）。
5. 進 `UTK0204_` 票區列表頁，解析每個 `tr.saleTr` 列。同時抓座位圖 `.map` 檔（`imgs2.utiki.com.tw/*_live.map`），把票區名稱對應到 `<area>` 元素的座位圖連結。
6. 「熱賣中」的分區沒有直接數字，要點進 `UTK0205_` 座位圖頁，數 `.seat-empty` / `.seat-people` 的 DOM 數量；如果 DOM 是空的（前端 JS 沒跑），fallback 去解析內嵌的 `seatStr` 變數（格式：`排號:狀態碼:座位.座位.座位`，狀態 0=空位，1/3/4=已售/購物車/鎖定）。

**特別之處 / 踩過的坑：**
- **WAF 判斷邏輯**：只要回應內容包含「網站有異常情況」就視為被擋，會自動重試（最多 3~5 次，間隔 2 秒）。**注意**：中信兄弟爬蟲曾經誤判「尚未開賣」為 WAF 阻擋——真正原因是季票優先訂購期還沒開始，`PerformanceListControl` 本來就抓不到 `PERFORMANCE_ID`，跟被擋無關（見 commit `3790667`）。
- **完售 ≠ 抓不到數字**：完售時能不能算出精確數字，關鍵在於 HTML 裡的購票連結（`onclick`/`href`/`rel`）有沒有被移除：
  - 連結還在 → 能透過 `seatStr` fallback 精確算出已售/總容量 ✅
  - 連結被清除 → 該區數據直接遺失（`sold=-1, total=-1`）❌
  - 連結還在但頁面既無 DOM 也無 `seatStr` → 會誤判成 0/0，完全失真 ⚠️
  （詳細分析見 `DEVLOG.md` 2026-06-26 那篇）
- **味全龍需要登入**：因為味全龍的訂票系統對某些場次要求會員登入才能看到座位圖，所以 `WeiChuanScraper` 多了一個 `sessionToken` 機制——`server.ts` 提供 `/api/weichuan/captcha`（抓驗證碼圖片）和 `/api/weichuan/login`（帳密+驗證碼登入），登入成功後把 cookie 存進 `WeiChuanScraper.cookieStore`（一個記憶體內的 `Map`，正式環境應該換成 Redis），前端再把 `sessionToken` 帶入 `getTickets` 的 URL 查詢參數。沒有這個 token 就會丟 `UNAUTHORIZED_NO_SESSION`。
- 輪椅席（`輪椅`/`陪伴`關鍵字）通常沒有獨立座位圖連結，會標記 `error: "無座位圖連結(無法計算)"`，不計入熱區抓取。
- 抓分區用 5 併發（`concurrency = 5`），每批之間 sleep 1.2 秒，避免打太快被擋；連續遇到 WAF 就直接跳出迴圈放棄剩下的分區。

---

## 台鋼雄鷹 TSG Hawks

跟其他隊完全不同，**是唯一一個有乾淨 JSON API 的球團**，不用管 cookie、token、HTML 解析。也是目前資料最完整的球團之一——這點是後來才挖到的，一開始其實比其他隊都更看不到已售/總容量。

- `getGames()`：打 `GET /api/v1/public/spotlight`，回傳 `data.regulars` 陣列，用 `venueName.includes('大巨蛋')` 只留大巨蛋場次、`eligibilityStatus !== 'disabled'` 過濾掉已結束的場次。
- `getTickets()` 同時打兩支 API（`Promise.all` 平行執行）：
  1. `GET ticket-platform.newretail.tw/api/v1/public/seat-availability?activityId=...&eventSessionId=...` → 每區的 `code`、`name`、`availableSeats`（剩餘票數，實測值）。
  2. `GET ticket-info.newretail.tw/api/v1/activity-venues/{AV_xxx}?activityId=...&eventSessionId=...` → 每區的 `code` 對應官方座位容量 `seatCount`。**這是完全不同的一台主機**，一開始完全沒發現，是使用者自己在瀏覽器 F5 看網路請求才挖到的。
- 兩邊資料用 `code` 對起來，直接 `已售 = seatCount - availableSeats`，不需要任何推算或猜測。
- **這支 `seatCount` 連前/後拆分區、輪椅席、貴賓包廂都各自有獨立的真實數字**（例如 `TP106B` 跟 `TP106F` 分別是 453、402，兩者相加剛好等於整個 106 區），完全解決「同一分區拆成前/後兩次賣，不知道各自容量」的問題，不用像 ibon 那樣用容量表回推、也不會有「其中一半永遠算不出來」的狀況。
- `activity-venues` 的 id 規則：直接把 `activityId` 的 `AC_` 前綴換成 `AV_`（例：`AC_260729TP2888` → `AV_260729TP2888`），不需要另外查。已驗證同一場館在不同場次之間 `seatCount`完全一致，是場館固定配置、不是每場重新計算。
- 兩支 API 都要帶 `x-company-code: tsghawks` header，否則回 400。
- 沒有座位圖二階段抓取（不需要，因為容量是查表拿到的，不是靠數座位格子）。
- **`activity-venues` 回應裡的 `ignoreTag` 欄位＝「這一區這一場有沒有開放銷售」**，跟 `seatCount` 不同，是每場比賽各自變動的（同一分區在不同場次之間 `ignoreTag` 會不一樣，親自跨場次比對過），不是場館固定屬性。`ignoreTag: true` 的分區在網頁上點下去會顯示「此區域不開放」，這種分區的 `seat-availability` 回傳的 `availableSeats` **不可信**（可能被系統歸零/鎖住，不是真實成交數字），`TsgScraper.ts` 會把這種分區的 `unsold`/`sold`/`total` 全部標記為 `-1`（未知，附 `error: "此場次尚未開放銷售"`），完全不計入總計。只有 `ignoreTag: false` 的分區才會正常計算已售/未售。

---

## ibon 三隊：樂天桃猿 / 統一獅 / 職棒明星賽

這三隊都掛在 ibon（`ticket.ibon.com.tw` 場次頁 + `orders.ibon.com.tw` 訂票頁），是全部球團中最複雜的，因為 **ibon 有 Cloudflare 防護**，純 HTTP 常常會被擋。

**架構分兩層：**

1. **`getTickets()` 會先嘗試純 HTTP**（`getTicketsViaHttp`），失敗才 fallback 開瀏覽器（`getTicketsViaBrowser`）。HTTP 版流程跟 utiki 系統類似：拿 token → 進場次頁 → 抓 `PerformanceListControl` → 抓 `UTK0204_000.aspx` 票區表格 → 熱賣分區逐一打 `UTK0205_000.aspx` 數座位。如果偵測到「驗證」字樣或拿不到 `PERFORMANCE_ID` 就直接丟出錯誤觸發瀏覽器 fallback。

2. **瀏覽器模式**（`IbonBrowser.ts`，三隊共用）：
   - 用 **`playwright-core` 開啟本機真實安裝的 Google Chrome**（不是 headless 內建瀏覽器），因為全新的自動化瀏覽器指紋很容易被 Cloudflare Turnstile 判定為機器人、陷入無限驗證迴圈（這是踩過的坑，見 `DEVLOG.md` 2026-07-01：原本用 `cloakbrowser` 套件，後來整個換掉）。
   - 每個球團有自己的 persistent profile 目錄（在系統暫存資料夾，不放在專案內，避免 Vite 熱重載把它清掉）。
   - 遇到 Cloudflare 驗證頁時是**半自動**：程式會跳出瀏覽器視窗，人要手動點一下驗證框，程式在背景輪詢頁面特徵（`#aspnetForm`／`#form1`／`table.table`／`window.jsonData` 任一出現即視為通過），偵測到就繼續往下跑。**這不是全自動的爬蟲**，本機執行時偶爾需要人在旁邊點一下。
   - 票區資料優先從頁面內嵌的 `window.jsonData`（或 regex 從 `<script>` 挖出）取得，包含 `PERFORMANCE_PRICE_AREA_ID`、`GROUP_ID`、`AMOUNT`（狀態）等欄位；如果都抓不到才 fallback 用 DOM table 逐列解析（`parseZoneTableFromBrowser`）。
   - 座位圖頁一樣是數 `.seat-icon-empyt`/`.seat-empty`（空位）與 `.seat-icon-sold`/`.seat-people`（已售）DOM 元素數量，讀到 0/0 會判定為「還沒渲染完成」而重試（最多輪詢幾次），而不是直接當成這區沒人。

**場次清單抓取的特殊優化（`getGames`）：**
- 三隊的活動頁都在同一個網域 `ticket.ibon.com.tw`，Cloudflare 核發的 `cf_clearance` cookie 是綁在網域上、不是綁在單一活動頁。所以三隊**共用同一個瀏覽器 context**（`acquireSharedGamesContext` / `releaseSharedGamesContext`）：只有第一個呼叫的球團會真的開瀏覽器過 CF，其餘球團直接在同一個 context 開新分頁沿用 session，省掉重複跳窗、重複驗證（見 commit `a9d3cb2`）。
- 有 10 分鐘的場次清單快取（`getCachedGames`/`setCachedGames`），避免每次重新整理頁面都重開瀏覽器跳窗。
- 有併發去重機制（`dedupeGamesFetch`）：React StrictMode 開發模式下同一個 team 的 `getGames()` 可能被叫兩次，避免兩個 `launchPersistentContext` 搶同一個 profile 目錄互炸（見 commit `a3a7e3d`）。

**大巨蛋座位容量補齊（`patchDomeCapacity`，樂天/統一/明星賽都有，寫法微調過）：**
- 專案根目錄有一份 `大巨蛋座位.json`（格式 `[樓層, 分區號, 容量]` 陣列，例：`["L4", 12, 300]`），用來補齊「抓不到已售數字」的分區。
- 邏輯：同一個「樓層+分區」如果有其他列已經抓到真實座位圖資料（`hasRealData`），就用容量表反推剩餘容量該分給哪一列；樂天版本比統一/明星賽多一層保護——**只有在同區確實有真實資料，或同區全部缺值都已判定「已售完」時才用容量表回推**，避免「單純抓取失敗」被誤當成「已售完」而用假數字蓋掉（統一/明星賽版本沒有這層保護，相對粗糙）。
- 輪椅席（`輪椅`關鍵字）不併入同區容量統計，獨立列出。

**平台差異細節：**
- 樂天／統一／明星賽三個 class 幾乎是複製貼上（`RakutenScraper.ts` / `UniScraper.ts` / `AllStarScraper.ts`），差異主要在活動頁 ID（`ActivityInfo/Details/39689`＝樂天、`39760`＝統一、`39701`＝明星賽）以及 `patchDomeCapacity` 的嚴謹程度（樂天版本最新、最嚴謹；明星賽版本邏輯最精簡，連 log 都被拿掉了）。
- 明星賽因為是跨隊比賽（非固定主場球團），`launchIbonBrowser` 用的是固定的 `userDataDir: browser_data_allstar`，沒有走 team 共用 profile 的路徑（`fetchGamesUncached` 場次清單仍走共用 context，但 `getTicketsViaBrowser` 是獨立 profile）。

---

## 跨球團共用的底層設計

- **`localFetch.ts`**：包一層 `fetch`，專門處理某些公司網路的 TLS 攔截代理用 1024-bit 弱金鑰重簽憑證、導致 Node 內建 `fetch` 直接 TLS 交握失敗的問題（錯誤訊息含 `certificate key too weak`）。策略是正常 `fetch` 先試，只有真的撞到這個特定錯誤才切換成放寬憑證驗證的 `undici.Agent` 重試。**只在非雲端模式生效**（`CLOUD_MODE=true` 時一律用預設 fetch，雲端主機不會經過使用者端的公司代理）。
- **`CLOUD_MODE` 環境變數**：雲端部署（例如 AI Studio）沒有本機 Chrome、也沒人可以手動點 Cloudflare 驗證，所以 ibon 三隊在雲端模式下會直接拒絕啟動瀏覽器，回傳 `CLOUD_UNSUPPORTED_IBON` 錯誤，前端顯示「雲端版暫不支援此球隊查詢，請使用本機版」。也就是說：**樂天/統一/明星賽這三隊，雲端部署版本是抓不到票的，只有本機版能跑**。utiki 三隊（兄弟/味全龍/富邦）和台鋼因為是純 HTTP，雲端跟本機都能跑。
- **重試機制共通模式**：`server.ts` 的 `/api/get_games` 和 `/api/get_tickets` 都有最多 3 次的外層重試，專門針對訊息含「售票系統異常」的錯誤；`get_tickets` 支援 SSE（`text/event-stream`）即時推送進度訊息（`onProgress` callback），前端可以看到「讀取分區: XX區...」這種即時狀態。
