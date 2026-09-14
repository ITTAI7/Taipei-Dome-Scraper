# 大巨蛋售票極速查詢 (Taipei Dome Scraper)

中華職棒（CPBL）大巨蛋場次售票即時查詢工具，支援七隊售票系統的票務資料收集與分析。

## 支援球隊

| 球隊 | 售票系統 | 爬蟲模組 | 雲端支援 |
|------|----------|----------|:---:|
| 中信兄弟 (Brothers) | 宏碁資訊 utiki | `BrothersScraper.ts` | ✅ |
| 味全龍 (WeiChuan) | 宏碁資訊 utiki（需登入） | `WeiChuanScraper.ts` | ✅ |
| 富邦悍將 (Fubon) | 宏碁資訊 utiki | `FubonScraper.ts` | ✅ |
| 台鋼雄鷹 (TSG) | 新零售平台（獨立 JSON API） | `TsgScraper.ts` | ✅ |
| 樂天桃猿 (Rakuten) | ibon | `RakutenScraper.ts` | ❌（僅本機） |
| 統一獅 (Uni) | ibon | `UniScraper.ts` | ❌（僅本機） |
| 職棒明星賽 (AllStar) | ibon | `AllStarScraper.ts` | ❌（僅本機） |

各球團實際抓取邏輯的細節（打哪些 API、要不要登入、資料是實測還是回推）請參閱 [NOTE.md](NOTE.md)。

## 功能

- 各隊大巨蛋場次自動抓取（只列出臺北大巨蛋場次）
- 即時票務資料收集（各區未售出 / 已售出 / 總容量）
- 支援人力與疏運時間試算
- CSV 匯出各區售票明細
- 味全龍售票系統驗證碼登入支援
- SSE（Server-Sent Events）即時進度回報
- 雲端部署守門機制（見下方 `CLOUD_MODE` 環境變數）

## 技術架構

```
TAIPEI_DOME_SCRAPER/
├── server.ts                      # Express 後端伺服器（port 3000）
├── start_all.bat                  # 一鍵啟動腳本（server watch 模式 + localtunnel）
├── src/
│   ├── App.tsx                    # React 前端 SPA
│   ├── main.tsx                   # React 進入點
│   ├── index.css                  # Tailwind CSS 樣式
│   └── services/
│       └── scrapers/
│           ├── ITicketScraper.ts  # 爬蟲介面定義
│           ├── ScraperFactory.ts  # 爬蟲工廠（依 platform 建立對應爬蟲）
│           ├── localFetch.ts      # fetch 包裝（處理公司網路 TLS 攔截代理）
│           ├── BrothersScraper.ts
│           ├── WeiChuanScraper.ts
│           ├── FubonScraper.ts
│           ├── TsgScraper.ts
│           ├── IbonBrowser.ts     # 樂天/統一/明星賽共用的瀏覽器控制模組
│           ├── RakutenScraper.ts
│           ├── UniScraper.ts
│           └── AllStarScraper.ts
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .env.example
```

### 主要依賴

- **前端**：React 19、TypeScript、Vite、Tailwind CSS、Lucide React、Motion
- **後端**：Express、tsx（開發模式用 `tsx watch`，存檔自動重啟）
- **爬蟲**：Cheerio（HTML 解析）、playwright-core + 本機 Chrome（樂天/統一/明星賽繞 Cloudflare 用，遇到驗證需人工點一次）、undici（放寬憑證驗證的 dispatcher，只在偵測到公司網路 TLS 攔截時才啟用）
- **網路穿透**：localtunnel / ngrok

## 快速開始

### 前置需求

- Node.js（建議 v18 以上）

### 安裝與執行

```bash
# 1. 安裝依賴
npm install

# 2. 啟動開發伺服器（存檔自動重啟）
npm run dev
```

伺服器預設監聽 `http://localhost:3000`。

### 一鍵啟動（Windows）

```bash
start_all.bat
```

此腳本會依序：
1. 清除殘留的 Node.js 程序
2. 啟動 Scraper Server（port 3000，watch 模式）
3. 啟動 Localtunnel 建立公開網址

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| `GET` | `/api/config` | 取得執行期設定（目前是否為雲端模式） |
| `GET` | `/api/get_games/:platform` | 取得指定平台的所有場次 |
| `GET` | `/api/get_tickets/:platform?url=...` | 取得指定場次的票務資料（支援 SSE） |
| `GET` | `/api/weichuan/captcha` | 取得味全龍驗證碼 |
| `POST` | `/api/weichuan/login` | 味全龍售票系統登入 |

### 支援的 platform 參數

`brothers` | `ctbc` | `weichuan` | `fubon` | `tsg` | `tsghawks` | `rakuten` | `monkeys` | `uni` | `unilions` | `allstar`

## 爬蟲架構原則

本專案採用**模組化爬蟲架構**，各隊爬蟲獨立實作 `ITicketScraper` 介面：

- 中信兄弟、富邦悍將、味全龍使用宏碁資訊 utiki 售票系統（HTML 解析），一律透過 `localFetch.ts` 發送請求。
- 台鋼雄鷹使用新零售平台，直接介接 JSON API（Header 需 `x-company-code: tsghawks`）：`spotlight`／`seat-availability` 取得場次與剩餘票數，另一支 `activity-venues` 則取得每分區官方座位容量，並排除 `ignoreTag`（代表該分區這場比賽尚未開放銷售）的分區，避免誤用不可信的數字。
- 樂天桃猿、統一獅、職棒明星賽使用 ibon，因為有 Cloudflare 防護，先嘗試純 HTTP，失敗才透過 `IbonBrowser.ts` 開啟本機 Chrome 半自動繞過（需要人手動點一次驗證），只能在本機執行；雲端模式（`CLOUD_MODE=true`）下會直接回傳錯誤，不會嘗試啟動瀏覽器。
- 各隊保有獨立的 `getGames()` 與 `getTickets()` 實作，避免互相干擾。

詳細開發指引請參閱 [AGENTS.md](AGENTS.md)、逐隊實作細節請參閱 [NOTE.md](NOTE.md)、開發過程與踩坑紀錄請參閱 [DEVLOG.md](DEVLOG.md)。

## 環境變數

可選的 `.env` 設定（參考 `.env.example`）：

```env
GEMINI_API_KEY="your_api_key"
APP_URL="your_app_url"

# 部署到 AI Studio / Cloud Run 時設為 true：
# 停用樂天/統一/明星賽的瀏覽器繞過機制（雲端沒有本機 Chrome、也沒人能手動過 CF 驗證）
CLOUD_MODE="false"
```
