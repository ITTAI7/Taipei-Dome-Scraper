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
  - 連結還在但頁面既無 DOM 也無 `seatStr` → 以前會誤判成 0/0；2026-10-07 起三隊都改成維持未知（`sold=-1, total=-1`，備註「座位圖解析失敗」），「熱賣中」這類非數字狀態的 `unsold` 也是 `-1`，不再先填 0（見 `DEVLOG.md` 2026-10-07）
  （詳細分析見 `DEVLOG.md` 2026-06-26 那篇）
- **味全龍需要登入**：因為味全龍的訂票系統對某些場次要求會員登入才能看到座位圖，所以 `WeiChuanScraper` 多了一個 `sessionToken` 機制——`server.ts` 提供 `/api/weichuan/captcha`（抓驗證碼圖片）和 `/api/weichuan/login`（帳密+驗證碼登入），登入成功後把 cookie 存進 `WeiChuanScraper.cookieStore`（一個記憶體內的 `Map`，正式環境應該換成 Redis），前端再把 `sessionToken` 帶入 `getTickets` 的 URL 查詢參數。沒有這個 token 就會丟 `UNAUTHORIZED_NO_SESSION`。
- **味全的會員優先購買階段**（2026-10-07 台灣大賽實測）：`PerformanceListControl` 的 `#buy_btn` 是 `VipSellCheck('P1GKL1IE')`（括號內就是 `PERFORMANCE_ID`），不是一般的購票連結。站方 `UTK0201.min.js` 的流程是：要求會員登入 → `POST UTK0201_/VIP_SELL_INFO` 檢查資格 → 通過後才 `DoVIPLogin`。非該階段資格的帳號（例如不是狂龍軍會員）登入後直接開 `UTK0204_` 會被 `top.location.href='/'` 踢回首頁，`VIP_SELL_INFO` 則回「您不符合該階段優先購買資格」。`WeiChuanScraper` 遇到沒有 `PERFORMANCE_ID` 但有 `#buy_btn` 文字時，會丟「⏳ 此場次目前尚未開放一般購票：…」，不會再被 `server.ts` 誤翻成「被 WAF 擋」。目前爬蟲**不**支援走會員優先購買的資格驗證。
- **味全售票網站會限速，讀座位圖會自動踩煞車（2026-10-15 起）**：讀太快時站方回「**429 - 請求頻率過高**」頁（**HTTP 狀態碼仍是 200**，只能看內容判斷），偶爾回「網站有異常情況」頁。實測 10/17：5 區同時讀，約 30 秒讀了 115 區後開始被擋，剩下 56 區全是 429 頁。2026-10-14 那版把它當成「座位圖讀不到」，固定等 2、4 秒各重抓一次，站方擋得久一點就標「座位圖解析失敗」。
  - 現在 `WeiChuanScraper` 用佇列讀：平常最多 5 區同時讀；一偵測到限速頁，全部暫停冷卻（5→10→20→30 秒），之後改成一次一區、間隔 1 秒。被限速的分區放回佇列重讀、不算失敗，讀到開始後 4 分鐘還被擋才標「售票網站持續限速，未讀到座位圖」。頁面正常但沒有座位資料的分區共讀 3 次，還是沒有才標「座位圖解析失敗」。
  - 限速頁的判斷都放在「該有的資料找不到」之後才做（座位圖頁找不到座位、票區表沒有 `saleTr`、場次頁沒有 `PERFORMANCE_ID`），避免正常頁面剛好含有那幾個字被誤判。票區表或場次頁就被限速時，直接顯示「味全售票網站暫時限制查詢頻率，請等 1 分鐘後再查詢」。
  - **連線被切斷也照同樣方式處理**（2026-10-15 同日追加）：站方有時不回 429 頁，而是直接切斷連線（`fetch` 丟例外）。以前一丟例外就設 `wafBlocked` 整個停掉，還沒讀的分區全部沒數字也沒備註（實測 L5 506–510 五區連線錯誤，已售少算一萬多人，畫面只說 5 區讀不到）。現在跟限速一樣冷卻後重讀，放棄時備註「連線被售票網站中斷，未讀到座位圖」；**每一區最後不是讀到，就是有備註**。
  - 伺服器 log：`[Weichuan] 售票網站暫時限速／連線中斷，暫停 N 秒…`、`[Weichuan] 讀取 X 連線錯誤：<錯誤代碼> <訊息>`；真的沒有座位資料時印 `[Weichuan] 座位圖讀不到: … status=… title=… location=…`。進度訊息「限速，等待 N 秒」「連線中斷，等待 N 秒」是前端提醒框的判斷依據，改字要一起改 `App.tsx` 的 `classifyProgress()`。
  - 本機執行時伺服器 log 會同時寫進 `logs/server-YYYY-MM-DD.log`（保留 14 天，見 `server.ts` 的 `mirrorConsoleToFile()`），查問題先看這個檔。
  - **兄弟 2026-10-19 已照同樣寫法改好**（實測確認兩個問題都有，見下一段）；**富邦還沒改**，等有大巨蛋場次可以實測再補。

### 兄弟／富邦下次有比賽時要檢查的事（2026-10-15 整理）

味全 2026-10-15 遇到的問題，兄弟、富邦的程式都還是舊寫法（兩隊讀座位圖的迴圈幾乎一字不差）。照 AGENTS.md 第 1 節不能假設跟味全一樣，所以**先實測、確認後才改**，改的時候兩隊各自改。

> **中信兄弟：2026-10-19 已確認並改好。** 實測 10/20（一般販售剛開始）：讀到第 120 區左右開始回 429 頁（跟味全同一頁，1126 bytes），舊寫法不重試，36 區標「座位圖解析失敗」；接著 L4 412 區 `ECONNRESET`，舊寫法整個停掉，16 區沒讀又沒備註。已照味全寫法改 `BrothersScraper.ts`（見 DEVLOG 2026-10-19）。改後實測 167 區全部讀到。
> **富邦：還沒改**，下表的「現況」仍適用。下次富邦有大巨蛋場次時照下表檢查，確認後照兄弟／味全的寫法改。

| # | 問題 | 富邦程式現況（兄弟改之前也一樣） | 下次怎麼看 |
|---|---|---|---|
| 1 | **連線被切斷就整個停掉**：後面還沒讀的分區沒數字也沒備註，總數少算，畫面只說「N 區讀不到」 | 有：`fetchHtml` 丟例外，或「網站有異常情況」重試用完，就 `throw WAF_BLOCKED` → 外層 `break` | `logs/server-日期.log` 搜 `encountered WAF block`；有出現就把 `complete` 的 `total_sold` 跟前後幾次查詢比，差很多就是漏讀 |
| 2 | **認不得「429 - 請求頻率過高」頁**（HTTP 狀態碼是 200，只能看內容） | 有：`fetchHtml` 只認「網站有異常情況」；收到 429 頁會直接標「座位圖解析失敗」，**一次都不重試** | 畫面上一批連續分區（常是同時讀的 5 區一組）標「座位圖解析失敗」；兩隊目前讀不到時**沒有 log**，要先補一行像味全的 `座位圖讀不到: … status= len= title=` 才看得出是不是 429 頁 |
| 3 | 售票站登入過期被誤報 | 不適用：兩隊查票不用登入 | — |

**確認之後怎麼改**：照味全 `WeiChuanScraper.ts` 2026-10-15 的寫法——`isThrottledPage()`（只在找不到該有的資料時才判斷）、佇列讀座位圖、被限速或連線中斷就全部冷卻（5→10→20→30 秒）後改慢速、4 分鐘後才放棄並寫備註、每一區不是讀到就是有備註。前端的狀況提醒框靠進度訊息「限速，等待 N 秒」「連線中斷，等待 N 秒」判斷，兩隊送出的文字要一樣。驗證可以沿用味全的假售票站做法（DEVLOG 2026-10-15，情境 A～D），並用修正前的版本對照。
- 輪椅席（`輪椅`/`陪伴`關鍵字）通常沒有獨立座位圖連結，會標記 `error: "無座位圖連結(無法計算)"`，不計入熱區抓取。
- 抓分區：**兄弟、味全**用佇列讀（最多 5 區同時、請求間隔 240ms；被限速或連線中斷就全部冷卻後改慢速，每一區不是讀到就是有備註，見上方）。**富邦**還是舊寫法：5 併發（`concurrency = 5`），每批之間 sleep 1.2 秒；連續遇到 WAF 就直接跳出迴圈放棄剩下的分區（會漏讀又沒備註，待改）。
- **中信兄弟已接上 `大巨蛋座位v3.json` 容量表回填缺值分區**（2026-09-16，`src/services/scrapers/domeSeatMap.ts` 的 `loadSeatCapacityMap` / `patchDomeCapacity`）。⚠️ 一開始誤以為兄弟隊分區不會拆前/後排，實測 `test_brothers_scraper.ts` 才發現**兄弟其實會拆**（`B1內野105/106/107/108/109/110/112/113/114/116/117/118/119/120/121區` 都拆成「前排」「後排」兩列分開賣，跟台鋼的拆法還不完全一樣——台鋼只拆 106~120 之間 13 區，105、121 這兩區台鋼沒拆但兄弟拆了）。所以改用跟 ibon 三隊 `patchDomeCapacity()` 相同的「同區歸戶」策略：用 `extractFloorZone()` 把同一 floor-zoneNum 的所有列（不管有沒有拆前/後）分組，只有「組內至少一列已有真實資料」時才把整區容量扣掉已知部分、剩餘塞給未知那列；如果整組全部抓失敗，只有「這區本來就沒拆、只有一列」時才直接用整區容量回填，有拆前/後但兩列都失敗則兩列都維持未知（不亂猜怎麼分配）。輪椅／陪伴席容量表沒有涵蓋，略過不補。**味全龍 2026-10-14 跟進接上**（台灣大賽大巨蛋場次可驗證），CSV 也輸出「座位數」欄。富邦**尚未**接上，理由同 `AGENTS.md` 的隔離修改原則：等有大巨蛋場次可以驗證再接。
  - 三隊雖然是同一套系統，賣法不一定一樣。例：味全 10/17 只列「B1內野104區前排」，沒有後排那列。所以 `patchDomeCapacity()` 遇到「同區只有一列、名稱又帶前排／後排」時不回填，否則會把整區 724 席塞給只有 259 席的前排。
  - 回填用的是場館固定容量，可能跟單場實際開賣的座位差幾席（例：味全 10/17 的 107 區座位圖是 720 席，v3 是 732 席）。使用者確認這屬於誤差範圍：球團開賣時可能保留或調整少數座位，v3 不跟著改（見下方 v3 段落的「來源優先順序」）。

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
- **`activity-venues` 回應裡的 `ignoreTag` 欄位＝「這一區這一場有沒有開放銷售」**，跟 `seatCount` 不同，是每場比賽各自變動的（同一分區在不同場次之間 `ignoreTag` 會不一樣，親自跨場次比對過），不是場館固定屬性。`ignoreTag: true` 的分區在網頁上點下去會顯示「此區域不開放」，這種分區的 `seat-availability` 回傳的 `availableSeats` **不可信**（可能被系統歸零/鎖住，不是真實成交數字），`TsgScraper.ts` 會把這種分區的 `unsold`/`sold` 標記為 `-1`（未知，附 `error: "此場次尚未開放銷售"`），不計入 `total_unsold`/`total_sold` 總計。**但 `total`（座位數）照樣填入真實的 `seatCount`**——座位數是場館固定配置，跟這場有沒有開賣無關，`total_capacity` 也是直接加總每區的 `total` 算出來的，不受 `ignoreTag` 影響。只有 `ignoreTag: false` 的分區才會正常計算已售/未售。
- **CSV 匯出（`App.tsx` `handleExport`）台鋼跟中信兄弟會多一欄「座位數」**（`區域,座位數,未售出票數,已售出票數,備註`，`includeSeatCount = activeTeam === 'tsg' || activeTeam === 'brothers'`）。台鋼是因為有這麼權威的座位數來源，已驗證過 `seatCount` 是 API 直接回傳的欄位、不是程式推算出來的（2026-09-15，見 `DEVLOG.md`）；中信兄弟則是 2026-09-16 起改用 `大巨蛋座位v3.json`（見上面 utiki 三隊段落）補齊缺值分區的 `total`。其餘球團（味全龍、富邦、ibon 三隊）尚未接上權威容量來源，維持原本 4 欄格式。未開賣或未知分區的未售/已售欄位在 CSV 裡會顯示空白，不會印出 `-1`、也不會拿 `-1` 去做 `total - unsold` 這種運算湊出一個看似正常實則錯誤的數字。

### ⚠️ 台鋼的 CSV 座位數跟 `大巨蛋座位v3.json` 完全無關（2026-09-16 釐清）

容易搞混的地方：`v3.json` 是拿台鋼的 `seatCount` 整理出來的靜態快照，會讓人誤以為台鋼自己的 CSV 座位數也是「查 v3 表」得到的——**不是**。

- `TsgScraper.ts` 完全沒有 `import fs`、沒有讀任何本地 JSON 檔（`v1`/`v2`/`v3` 都沒用到），台鋼 CSV 上的座位數是**每次查詢都即時打 `ticket-info.newretail.tw/api/v1/activity-venues/{AV_xxx}` 這支官方 API**拿到的 `seatCount`，原封不動印出來，中間沒有任何查表、加總、拆分的計算。
- 反過來，`v3.json` 是**從台鋼的 API 資料回頭整理出來的靜態快照**，設計目的是給「沒有自己權威資料來源」的其他球團（目前是中信兄弟）在抓取失敗時查表回填用（見 `domeSeatMap.ts`），台鋼自己完全用不到——因為台鋼永遠問自己的即時 API，比任何靜態快照都新、都準。
- **v1 → v2 → v3 的演進與參考價值**：v1（`大巨蛋座位.json`）是早期從 ibon 座位圖回推的數字；v2 以 v1 為基礎，逐區比對台鋼 `activity-venues` 的真實 `seatCount`，並標出差異（`match`、`tsg_codes`）；v3 則以台鋼 `seatCount` 為主要來源，查無資料的少數分區才退回 v1。台鋼的售票系統公開了大巨蛋每個分區的座位數，所以 v3 是目前最可靠的大巨蛋容量參考，**各隊在抓取票數、需要座位數或回推缺值時都應以 v3 為依據**。其他球團（味全、富邦、ibon 三隊）之後若要接容量表，也應改用 v3，不要再用 v1。
- **v3 的定位與來源優先順序（2026-10-14 使用者確認）**：v3 記的是大巨蛋本身的座位數，不是某一場、某一隊實際開賣的數字。台鋼後台（`activity-venues` 的 `seatCount`）暫且視為最接近完整大巨蛋座位的來源，優先採用；台鋼沒有的分區（例如 L3）才用其他球團座位圖的已售＋未售。各球團開賣時跟台鋼差幾席，視為誤差範圍，不拿來改 v3。
- **v3 要收錄大巨蛋所有分區（2026-10-14 起）**：只要任何球團開賣了 v3 沒有的分區，就補進 v3。收錄的是大巨蛋原本規劃就有的區域，用樓層＋位置命名，不用球團自己的票區品牌名。座位數有實測依據才填，沒有就填 `null`，之後量到再補，不要填估計值。`loadSeatCapacityMap()` 會略過 `null`。
  - L3 內野 301–304、314–317（Lounge 區）：台鋼沒賣 L3，座位數取自味全 2026-10-17 台灣大賽座位圖的已售＋未售（不含輪椅席）。左右對稱（301=317=204、302=316=181、303=315=165、304=314=100）。
  - `["L3", "左外野", null]`、`["L3", "右外野", null]`：外野 L3 貴賓樓層，味全以「FamilyZone 親子專區」名義販售。這區是自由入座、沒有座位圖，完售後數不到座位。要取得總數，只能在某場剛開賣、還沒人買時讀剩餘張數。可參考的上限是維基百科「外野 VIP 層 334 席」（左右合計，可能包含外野包廂）。味全 CSV 的 FamilyZone 列會在備註寫出這區是什麼、為什麼座位數留白（`WeiChuanScraper.ts` 的 `familyZoneNote`）。
  - 輪椅／陪同席：以 `["B1", "108輪椅席", 7]`、`["B1", "108輪椅陪同席", 7]` 的格式插在本區後面，共 56 筆、264 席。B1／L2／L4 取台鋼 `TPxxxW`／`TPxxxWF` 的 `seatCount`（52 筆，248 席）。L3 304／314 台鋼沒賣，取味全 10/17 座位圖（各 4＋4）。區號用字串，`loadSeatCapacityMap()` 的鍵是 `B1-108輪椅席`，不會跟本區 `B1-108` 撞到。`patchDomeCapacity()` 仍然跳過輪椅列，行為不變。
    - 以前沒收的原因：ibon 時期輪椅席沒有座位圖連結，ibon 也規定需要輪椅的身障者要現場購票，v1 因此完全沒有輪椅數字；v3 沿用 v1 的「樓層-數字區號」鍵值，輪椅列會跟本區撞在一起。其實台鋼 API 從 9 月起就有每個輪椅席的獨立數字。
    - 2026-10-14 早上匯出的味全 10/17 有 5 個代號比台鋼少（109 輪椅席 4 對 6、110 輪椅／陪同各 1 對 3、117 輪椅／陪同各 5 對 6）。原本推測是單場保留，**這個推測是錯的**：同日 13:36 重抓時，52 列輪椅／陪同席全部跟台鋼一致，少掉的那幾席都變成「已售」。比較可能的原因是：早上那幾席正在交易中，`seatStr` 的狀態碼不在爬蟲認得的 0／1／3／4 裡，所以沒被數到。
  - L2 外野 233–244：台鋼沒有這幾區，v3 的數字來自 v1（ibon 座位圖）。味全 10/17 合計 3,864 席，v3 是 4,040 席，每區少 10–27 席。這跟 L2 內野（台鋼來源）味全每區少 18–25 席的模式一致，所以 v3 維持不改。
  - 尚未收錄：B1 138/139、L3 包廂（內野 20 間、外野 16 間）。
- **台鋼座位表本身的來源**：只能確認到「這是 API 直接回傳的資料，程式端沒做任何計算」這個層次；已驗證過同一場館、不同比賽場次打這支 API，160 個分區的 `seatCount` 逐一比對完全一致（場館固定配置，不是每場臨時算出來的），可以放心信任。但再往上追溯到新零售平台／大巨蛋官方原始座位藍圖的最初來源，沒有管道查證，只能信任台鋼系統本身提供的這份資料。

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
