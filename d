/**
 * 樂天購票頁面 Playwright 測試 (使用系統真實 Chrome)
 * - 使用 channel: 'chrome' 啟動真實 Chrome，避免 Cloudflare 偵測
 * - Cloudflare 通過後診斷頁面狀態
 */
import { chromium } from 'playwright-core';

// ─── Type Definition ───────────────────────────────────────────────
interface TicketZone {
  zoneId: string;
  zoneName: string;
  price: number;
  statusText: string;
  isSoldOut: boolean;
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║    樂天購票 Playwright 測試 (真實 Chrome)   ║');
  console.log('╚══════════════════════════════════════════════╝');

  console.log('[進度] 啟動真實 Chrome (channel: chrome, headless: false)...');
  console.log('       ⚠️ 請先關閉所有現有 Chrome 視窗');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const targetUrl =
    'https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=B0APWNAL&PRODUCT_ID=B0ANR12P';

  try {
    // ─── Step 1: 導航到目標頁面 ──────────────────────────
    console.log(`[進度] 導航到目標頁面...`);
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'step1_initial.png' }).catch(() => {});

    // ─── Step 2: Cloudflare 驗證等待 ────────────────────
    console.log('');
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║  ⚠️  請在彈出瀏覽器勾選「我不是機器人」  ║');
    console.log('╚═══════════════════════════════════════════╝');

    let cfPassed = false;
    for (let i = 0; i < 120; i++) {
      const title = await page.evaluate(() => document.title).catch(() => '');
      if (title.length > 0 && !title.toLowerCase().includes('請稍候') && !title.toLowerCase().includes('驗證')) {
        cfPassed = true;
        console.log(`✅ Cloudflare 通過！title="${title}"`);
        break;
      }
      if (i % 10 === 0) console.log(`  ⏳ (${i + 1}s) title="${title}"`);
      await page.waitForTimeout(1000);
    }

    if (!cfPassed) throw new Error('Cloudflare 未通過');

    // ─── Step 3: 診斷 Cloudflare 通過後的頁面 ──────────
    await page.waitForTimeout(5000); // 等頁面穩定

    // 完整診斷
    const diag = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyPreview: (document.body?.innerText || '').substring(0, 500),
      htmlPreview: (document.documentElement?.innerHTML || '').substring(0, 3000),
      // 檢測所有可能的 zone 元素
      selectors: {
        'td[data-title="票區"]': document.querySelectorAll('td[data-title="票區"]').length,
        'tr.saleTr': document.querySelectorAll('tr.saleTr').length,
        'tbody tr': document.querySelectorAll('tbody tr').length,
        'table tr': document.querySelectorAll('table tr').length,
        '#aspnetForm': document.querySelectorAll('#aspnetForm').length,
        '#ctl00_ContentPlaceHolder1_BUY_TYPE_0': document.querySelectorAll('#ctl00_ContentPlaceHolder1_BUY_TYPE_0').length,
        '#ctl00_ContentPlaceHolder1_BUY_TYPE_1': document.querySelectorAll('#ctl00_ContentPlaceHolder1_BUY_TYPE_1').length,
        'input[type=radio]': document.querySelectorAll('input[type=radio]').length,
        '.saleTr': document.querySelectorAll('.saleTr').length,
        'tr': document.querySelectorAll('tr').length,
      },
    }));

    console.log('\n📋 Cloudflare 通過後頁面診斷:');
    console.log(`  URL: ${diag.url}`);
    console.log(`  Title: "${diag.title}"`);
    console.log(`  Body preview: "${diag.bodyPreview}"`);
    console.log(`\n  元素選擇器檢測:`);
    for (const [sel, count] of Object.entries(diag.selectors)) {
      console.log(`    ${sel}: ${count}`);
    }

    await page.screenshot({ path: 'step2_after_cf.png', fullPage: true });

    // 輸出完整 HTML 前 1000 chars
    console.log(`\n  HTML preview (first 1000):`);
    console.log(`  ${diag.htmlPreview.substring(0, 1000)}`);
    console.log(`  ... (truncated)`);

    // 看是否有檢核碼 / 障礙頁面
    const bodyText = diag.bodyPreview.toLowerCase();
    if (bodyText.includes('驗證') || bodyText.includes('請稍候')) {
      console.log('\n⚠️  頁面仍處於驗證狀態！');
    }

    // ─── 如果頁面有 BUY_TYPE radio，自動選取 ─────────
    if (diag.selectors['#ctl00_ContentPlaceHolder1_BUY_TYPE_1'] > 0) {
      console.log('\n✅ 找到 BUY_TYPE 選項！點擊「自行選位」...');
      
      // 點擊 BUY_TYPE_1（自行選位）
      await page.click('#ctl00_ContentPlaceHolder1_BUY_TYPE_1');
      await page.waitForTimeout(1000);
      
      // 點擊確認按鈕
      const btn = await page.$('#ctl00_ContentPlaceHolder1_btnSure, input[value="選擇座位"], input[type=submit]');
      if (btn) {
        await btn.click();
        console.log('已點擊確認按鈕，等待頁面導航...');
        await page.waitForTimeout(5000);
        
        // 導航後再次診斷
        const diag2 = await page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
          bodyPreview: (document.body?.innerText || '').substring(0, 300),
          'td[data-title="票區"]': document.querySelectorAll('td[data-title="票區"]').length,
          'tbody tr': document.querySelectorAll('tbody tr').length,
        }));
        
        console.log(`\n📋 導航後診斷:`);
        console.log(`  URL: ${diag2.url}`);
        console.log(`  title: "${diag2.title}"`);
        console.log(`  td[data-title="票區"]: ${diag2['td[data-title="票區"]']}`);
        console.log(`  tbody tr: ${diag2['tbody tr']}`);
        console.log(`  body: "${diag2.bodyPreview}"`);
      }
    }

    // 嘗試等待更多時間看 AJAX 是否載入
    if (diag.selectors['td[data-title="票區"]'] === 0) {
      console.log('\n⏳ 等待 AJAX 載入 zone 資料 (30s)...');
      let found = false;
      for (let i = 0; i < 30; i++) {
        const count = await page.evaluate(() => document.querySelectorAll('td[data-title="票區"]').length);
        if (count > 0) {
          found = true;
          console.log(`✅ 在 ${i + 1} 秒後找到 ${count} 個票區`);
          
          // 提取資料
          const zones: TicketZone[] = await page.$$eval('tbody tr', (rows) =>
            rows.map((row) => ({
              zoneId: row.getAttribute('id') || '',
              zoneName: (row.querySelector('td[data-title="票區"]') as HTMLElement)?.innerText?.trim() || '',
              price: parseInt(((row.querySelector('td[data-title="票價(NT$)"]') as HTMLElement)?.innerText?.trim() || '0').replace(/[^\d]/g, ''), 10) || 0,
              statusText: (row.querySelector('td[data-title="空位"] span') as HTMLElement)?.innerText?.trim() || '',
              isSoldOut: row.classList.contains('disabled'),
            }))
          );
          
          console.log(`\n✅ 成功抓取 ${zones.length} 個票區！\n`);
          zones.forEach((z) => {
            console.log(`  ${z.zoneId.padEnd(12)} ${z.zoneName.padEnd(16)} ${String(z.price).padStart(4)}元 ${z.statusText.padEnd(10)} ${z.isSoldOut ? '⚠️已售完' : '✓'}`);
          });
          break;
        }
        await page.waitForTimeout(1000);
      }
      if (!found) console.log('❌ 等待 30 秒後仍未找到票區');
    }

    console.log('\n✅ 測試完成！瀏覽器將在 20 秒後關閉');
    await new Promise((r) => setTimeout(r, 20000));
  } catch (error) {
    console.error('\n❌ 測試失敗:', error);
    await new Promise((r) => setTimeout(r, 30000));
  } finally {
    await browser.close();
    console.log('🟢 瀏覽器已關閉');
  }
}

main();
