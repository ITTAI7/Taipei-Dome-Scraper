# 大巨蛋售票極速查詢 (Taipei Dome Scraper)

中華職棒（CPBL）大巨蛋場次售票即時查詢工具，支援六隊售票系統的票務資料收集與分析。

## 支援球隊

| 球隊 | 售票系統 | 爬蟲模組 |
|------|----------|----------|
| 中信兄弟 (Brothers) | 宏碁資訊 | `BrothersScraper.ts` |
| 味全龍 (WeiChuan) | 宏碁資訊（需登入） | `WeiChuanScraper.ts` |
| 富邦悍將 (Fubon) | 宏碁資訊 | `FubonScraper.ts` |
| 台鋼雄鷹 (TSG) | 新零售平台（獨立 API） | `TsgScraper.ts` |
| 樂天桃猿 (Rakuten) | — | `RakutenScraper.ts` |
| 統一獅 (Uni) | — | `UniScraper.ts` |

## 功能

- 各隊大巨蛋場次自動抓取
- 即時票務資料收集（各區未售出 / 已售出票數）
- 動態總票數設定（根據球場自動帶入預設值）
- 支援人力與疏運時間試算
- CSV 匯出各區售票明細
- 味全龍售票系統驗證碼登入支援
- SSE（Server-Sent Events）即時進度回報

## 技術架構

```
TAIPEI_DOME_SCRAPER/
├── server.ts                      # Express 後端伺服器（port 3000）
├── start_all.bat                  # 一鍵啟動腳本（server + localtunnel）
├── src/
│   ├── App.tsx                    # React 前端 SPA
│   ├── main.tsx                   # React 進入點
│   ├── index.css                  # Tailwind CSS 樣式
│   └── services/
│       └── scrapers/
│           ├── ITicketScraper.ts  # 爬蟲介面定義
│           ├── ScraperFactory.ts  # 爬蟲工廠（依 platform 建立對應爬蟲）
│           ├── BrothersScraper.ts
│           ├── WeiChuanScraper.ts
│           ├── FubonScraper.ts
│           ├── TsgScraper.ts
│           ├── RakutenScraper.ts
│           └── UniScraper.ts
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .env.example
```

### 主要依賴

- **前端**：React 19、TypeScript、Vite、Tailwind CSS、Lucide React、Motion
- **後端**：Express、tsx
- **爬蟲**：Cheerio（HTML 解析）、playwright-core（瀏覽器自動化）、cloakbrowser（反偵測）
- **網路穿透**：localtunnel / ngrok

## 快速開始

### 前置需求

- Node.js（建議 v18 以上）

### 安裝與執行

```bash
# 1. 安裝依賴
npm install

# 2. 啟動開發伺服器
npm run dev
```

伺服器預設監聽 `http://localhost:3000`。

### 一鍵啟動（Windows）

```bash
start_all.bat
```

此腳本會依序：
1. 清除殘留的 Node.js 程序
2. 啟動 Scraper Server（port 3000）
3. 啟動 Localtunnel 建立公開網址

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| `GET` | `/api/get_games/:platform` | 取得指定平台的所有場次 |
| `GET` | `/api/get_tickets/:platform?url=...` | 取得指定場次的票務資料（支援 SSE） |
| `GET` | `/api/weichuan/captcha` | 取得味全龍驗證碼 |
| `POST` | `/api/weichuan/login` | 味全龍售票系統登入 |

### 支援的 platform 參數

`brothers` | `ctbc` | `weichuan` | `fubon` | `tsg` | `tsghawks` | `rakuten` | `monkeys` | `uni` | `unilions`

## 台鋼雄鷹（TSG）球場預設總票數

台鋼的比賽場地較為多樣，系統會根據場地名稱動態設定全場預設總票數：

| 球場 | 預設總票數 |
|------|-----------|
| 澄清湖棒球場 | 20,000 |
| 嘉義市立棒球場 | 10,000 |
| 臺北大巨蛋 | 37,000 |
| 其它球場 | 37,000 |

使用者可在前端介面手動修改總票數設定。

## 爬蟲架構原則

本專案採用**模組化爬蟲架構**，各隊爬蟲獨立實作 `ITicketScraper` 介面：

- 中信兄弟、富邦悍將、味全龍使用宏碁資訊售票系統（HTML 解析）
- 台鋼雄鷹使用新零售平台（直接介接 JSON API，Header 需 `x-company-code: tsghawks`）
- 各隊保有獨立的 `getGames()` 與 `getTickets()` 實作，避免互相干擾

詳細開發指引請參閱 [AGENTS.md](AGENTS.md)。

## 環境變數

可選的 `.env` 設定（參考 `.env.example`）：

```env
GEMINI_API_KEY="your_api_key"
APP_URL="your_app_url"