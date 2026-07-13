/**
 * 共享的 ibon 瀏覽器控制模組。
 *
 * 使用本機實體 Google Chrome（透過 playwright-core executablePath），
 * 以 headless: false 模式開啟視窗。預設使用你本機 Chrome 的原始設定檔
 * （包含登入狀態、cookie、擴充功能），讓 CF 驗證可以信任這個瀏覽器。
 *
 * 遇到 Cloudflare Turnstile 時由使用者手動打勾，程式自動偵測通過後繼續執行。
 *
 * 取代先前對 cloakbrowser 套件的依賴。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';

// ─── Chrome 路徑偵測 ──────────────────────────────────────────
function findChromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    for (const c of candidates) {
      try { fs.accessSync(c); return c; } catch {}
    }
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  // Linux
  const linuxCandidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of linuxCandidates) {
    try { fs.accessSync(c); return c; } catch {}
  }
  throw new Error('找不到本機 Chrome 瀏覽器。請設定 CHROME_PATH 環境變數。');
}

// ─── 預設 Chrome 使用者設定檔目錄 ─────────────────────────────
function defaultUserDataDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return path.join(process.env.HOME || '', '.config', 'google-chrome');
}

const CHROME_PATH = findChromePath();

// ─── 瀏覽器啟動選項 ───────────────────────────────────────────
const SHARED_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=TranslateUI',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process',
];

export interface IbonBrowserOptions {
  /**
   * 使用者資料目錄（cookie / localStorage 持久化）。
   * 若未提供，預設放在系統暫存目錄（不在專案內，避免 Vite 熱重載）。
   * 傳入 team 名稱（如 'rakuten'）自動產生路徑。
   */
  team?: string;
  userDataDir?: string;
}

export interface IbonBrowserInstance {
  context: BrowserContext;
  page: Page;
}

/**
 * 啟動瀏覽器並建立 persistent context。
 *
 * 預設使用你本機 Chrome 的原始使用者設定檔（包含登入狀態、cookie、擴充功能），
 * 這樣 CF 驗證只需要打勾一次，不會無限循環。
 *
 * ⚠️ 重要：啟動前請先關閉所有正在執行的 Chrome 視窗，
 *         否則 Playwright 無法鎖定設定檔。
 *
 * @param opts.userDataDir - 若想使用獨立的乾淨設定檔（如 browser_data_rakuten），
 *                           可傳入自訂路徑（保留向下相容）
 */
export async function launchIbonBrowser(opts: IbonBrowserOptions = {}): Promise<IbonBrowserInstance> {
  const profileDir = opts.userDataDir ||
    (opts.team ? path.join(os.tmpdir(), '.ibon-browser-data', opts.team) : defaultUserDataDir());
  console.log(`🚀 啟動本機 Chrome: ${CHROME_PATH}`);
  console.log(`   設定檔目錄: ${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME_PATH,
    headless: false,
    args: SHARED_ARGS,
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();
  return { context, page };
}

/**
 * 暖機：先拜訪 ticket.ibon.com.tw 建立穩定 session。
 * 第二步順便拜訪活動頁以確保 cookie 一致性。
 */
export async function warmupIbonBrowser(page: Page, activityPage?: string): Promise<void> {
  console.log('🔥 Warming up session on ticket.ibon.com.tw...');

  for (let i = 0; i < 3; i++) {
    try {
      await page.goto('https://ticket.ibon.com.tw', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await sleep(3000 + Math.random() * 2000);
      const title = await page.evaluate(() => document.title).catch(() => '');
      console.log(`   Warmup (${i + 1}/3): title="${title}"`);
      if (title && title.length > 0) break;
    } catch (e: any) {
      console.log(`   Warmup attempt ${i + 1} failed: ${e.message}`);
      if (i < 2) await sleep(5000);
    }
  }

  // 活動頁預熱
  if (activityPage) {
    try {
      console.log(`   預熱活動頁: ${activityPage}`);
      await page.goto(activityPage, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(3000 + Math.random() * 2000);
    } catch (_) {}
  } else {
    try {
      await page.goto('https://ticket.ibon.com.tw', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
    } catch (_) {}
  }
}

/**
 * CF Turnstile 繞過等待器。
 *
 * 當需要手動驗證時，會在 console 提示使用者去瀏覽器視窗打勾。
 * 每 3-5 秒檢查一次頁面狀態，偵測到 ibon 頁面強特徵即視為通過。
 *
 * @param timeoutSec 最長等待秒數（預設 300 秒）
 * @returns true 表示通過，false 表示超時
 */
export async function waitForCfBypass(page: Page, timeoutSec = 300): Promise<boolean> {
  const start = Date.now();
  const deadline = start + timeoutSec * 1000;
  console.log(`   ⏳ 等待 CF Turnstile 驗證（請在瀏覽器視窗中打勾，最多 ${timeoutSec}s）...`);

  let lastPromptSec = -10;

  while (Date.now() < deadline) {
    try {
      const check = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        const title = document.title || '';

        // CF / 驗證頁面特徵
        const isCfBlock =
          body.includes('Just a moment') ||
          body.includes('Checking your browser') ||
          body.includes('請稍候') ||
          body.includes('DDoS') ||
          body.includes('驗證您是否是人類') ||
          body.includes('正在檢查您的瀏覽器') ||
          body.includes('cf-browser-verification') ||
          title.includes('Just a moment') ||
          title.includes('請稍候');

        // 成功繞過的特徵（只用強特徵，避免 title 字串提前誤判）
        const hasAspnetForm = !!document.querySelector('#aspnetForm');
        const hasForm1 = !!document.querySelector('#form1');
        const hasZoneTable = !!document.querySelector('table.table');
        const hasJsonData = !!((window as any).jsonData);

        return {
          isCfBlock,
          hasAspnetForm,
          hasForm1,
          hasZoneTable,
          hasJsonData,
          title,
          bodyPreview: body.substring(0, 100),
        };
      }).catch(() => ({
        isCfBlock: true, hasAspnetForm: false, hasForm1: false,
        hasZoneTable: false, hasJsonData: false,
        title: '(error)', bodyPreview: '(error)',
      }));

      // 偵測到成功繞過（僅用強特徵：aspnetForm / form1 / zoneTable / jsonData）
      if (check.hasAspnetForm || check.hasForm1 || check.hasZoneTable || check.hasJsonData) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`   ✅ CF 驗證通過！(耗時 ${elapsed}s) title="${check.title}"`);
        return true;
      }

      // 定期提示使用者
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed - lastPromptSec >= 15) {
        if (check.isCfBlock) {
          console.log(`   ⏳ 請在瀏覽器視窗中點擊驗證打勾 (${elapsed}s)...`);
        } else {
          console.log(`   ⏳ 等待頁面載入中... (${elapsed}s) "${check.bodyPreview.substring(0, 50)}"`);
        }
        lastPromptSec = elapsed;
      }

      await sleep(3000 + Math.random() * 2000);
    } catch (e: any) {
      console.log(`   ⚠️ CF check error: ${e.message}`);
      await sleep(5000);
    }
  }

  console.log(`   ❌ CF 驗證等待超時 (${timeoutSec}s)`);
  return false;
}

/** 輔助延遲函式 */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}