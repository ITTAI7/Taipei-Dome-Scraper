/**
 * 樂天購票 Playwright 測試
 * 
 * 策略：
 * - 使用真實系統 Chrome (channel: 'chrome') → Cloudflare 可正常通過 ✅
 * - Cloudflare 通過後診斷頁面，找到各區資料
 */
import { chromium } from 'playwright-core';

interface TicketZone {
  zoneId: string;
  zoneName: string;
  price: number;
  statusText: string;
  isSoldOut: boolean;
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  樂天購票測試 (真實 Chrome + CF 處理)      ║');
  console.log('╚══════════════════════════════════════════════╝');

  // ─── 使用系統真 Chrome（Cloudflare 可通過）────────
  console.log('[進度] 啟動真實 Chrome (channel: chrome)...');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const performanceId = 'B0APWNAL';
  const productId = 'B0ANR12P';

  try {
    // ─── Step 1: 導航到 UTK0201 ────────────────────────
    const utk0201Url = `https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${productId}`;
    console.log(`[進度] 導航 ${utk0201Url}`);
    await page.goto(utk0201Url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);

    // ─── Step 2: 等待 Cloudflare ──────────────────────
    console.log('\n⚠️  請在彈出瀏覽器中勾選「我不是機器人」');
    console.log('   （勾一次即可，最長等 120 秒）\n');

    let cfPassed = false;
    for (let i = 0; i < 120; i++) {
      const title = await page.evaluate(() => document.title).catch(() => '');
      if (title.length > 0 && !title.includes('請稍候') && !title.includes('驗證')) {
        cfPassed = true;
        console.log(`✅ CF 通過! title="${title}"`);
        break;
      }
      if (i % 10 === 0) console.log(`  ⏳ (${i + 1}s) title="${title}"`);
      await page.waitForTimeout(1000);
    }
    if (!cfPassed) throw new Error('CF 未通過');

    await page.waitForTimeout(3000);

    // ─── Step 3: 完整頁面診斷 ────────────────────────
    const diag = await page.evaluate(() => {
      const forms = document.forms;
      const formArray: { id: string; action: string; inputs: string[] }[] = [];
      for (let f = 0; f < forms.length; f++) {
        const form = forms[f];
        const inputs: string[] = [];
        for (let i = 0; i < form.elements.length; i++) {
          const el = form.elements[i] as HTMLInputElement;
          inputs.push(`${el.id || el.name || '(no name)'}=${el.value?.substring(0, 50) || ''}`);
        }
        formArray.push({ id: form.id, action: form.action?.substring(0, 100), inputs });
      }

      return {
        url: window.location.href,
        title: document.title,
        forms: formArray,
        'td[data-title="票區"]': document.querySelectorAll('td[data-title="票區"]').length,
        'tr.saleTr': document.querySelectorAll('tr.saleTr').length,
        'table': document.querySelectorAll('table').length,
        'tbody tr': document.querySelectorAll('tbody tr').length,
        'aspnetForm': document.querySelectorAll('#aspnetForm').length,
        '#ctl00_ContentPlaceHolder1_BUY_TYPE_0': document.querySelectorAll('#ctl00_ContentPlaceHolder1_BUY_TYPE_0').length,
        '#ctl00_ContentPlaceHolder1_BUY_TYPE_1': document.querySelectorAll('#ctl00_ContentPlaceHolder1_BUY_TYPE_1').length,
        '#ctl00_ContentPlaceHolder1_btnSure': document.querySelectorAll('#ctl00_ContentPlaceHolder1_btnSure').length,
        'input[type=submit]': document.querySelectorAll('input[type=submit]').length,
        'input[type=radio]': document.querySelectorAll('input[type=radio]').length,
        bodyPreview: (document.body?.innerText || '').substring(0, 500),
      };
    });

    console.log('\n📋 CF 通過後頁面診斷:');
    console.log(JSON.stringify(diag, null, 2));

    await page.screenshot({ path: 'step_after_cf.png', fullPage: true });

    // ─── Step 4: 從表單解析各區（直接從頁面 HTML）───
    // 檢查 tbody tr （根據你提供的 HTML 結構）
    const zoneRows = await page.$$eval('tbody tr', (rows) =>
      rows.map(row => ({
        id: row.getAttribute('id') || '',
        className: row.className,
        html: row.innerHTML.substring(0, 500),
        zoneName: (row.querySelector('td[data-title="票區"]') as HTMLElement)?.innerText?.trim() || '',
      }))
    );
    console.log(`\ntbody tr 共 ${zoneRows.length} 行`);
    zoneRows.slice(0, 5).forEach((r, i) => console.log(`  [${i}] id=${r.id} class=${r.className} name=${r.zoneName}`));

    // ─── Step 5: 嘗試多種方式找到各區 ──────────────
    const allZoneSelectors = [
      'td[data-title="票區"]',
      'tr.saleTr',
      '#ctl00_ContentPlaceHolder1_gvSeatAreaList tr',
      'table[class] tr',
      '.saleTr',
      '[id*="B0A"]',           // 從你的資料，zone ID 以 B0A 開頭
    ];

    for (const sel of allZoneSelectors) {
      const count = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
      console.log(`  ${sel}: ${count} matches`);
    }

    // ─── Step 6: 如果在 UTK0201 有 BUY_TYPE 就提交 ──
    if (diag['#ctl00_ContentPlaceHolder1_BUY_TYPE_1'] > 0) {
      console.log('\n✅ 找到 BUY_TYPE_1! 點選「自行選位」...');
      await page.click('#ctl00_ContentPlaceHolder1_BUY_TYPE_1');
      await page.waitForTimeout(500);
      
      // 點確認鈕
      const btn = await page.$('#ctl00_ContentPlaceHolder1_btnSure, input[type=submit]');
      if (btn) {
        await btn.click();
        console.log('✅ 已提交表單，等待 UTK0204...');
        await page.waitForTimeout(5000);
        
        // 確認是否在 UTK0204
        const url = await page.evaluate(() => window.location.href);
        console.log(`  目前 URL: ${url}`);
        
        if (url.includes('UTK0204')) {
          // 在 UTK0204 上等 AJAX 載入各區
          console.log('⏳ 等各區資料載入 (最多 30 秒)...');
          let found = false;
          for (let i = 0; i < 30; i++) {
            const count = await page.evaluate(() => document.querySelectorAll('td[data-title="票區"]').length);
            if (count > 0) {
              found = true;
              const zones: TicketZone[] = await page.$$eval('tbody tr', (rows) =>
                rows.map((row) => ({
                  zoneId: row.getAttribute('id') || '',
                  zoneName: (row.querySelector('td[data-title="票區"]') as HTMLElement)?.innerText?.trim() || '',
                  price: parseInt(((row.querySelector('td[data-title="票價(NT$)"]') as HTMLElement)?.innerText?.trim() || '0').replace(/[^\d]/g, ''), 10) || 0,
                  statusText: (row.querySelector('td[data-title="空位"] span') as HTMLElement)?.innerText?.trim() || '',
                  isSoldOut: row.classList.contains('disabled'),
                }))
              );
              
              console.log(`\n✅ 成功抓取 ${zones.length} 個票區!\n`);
              zones.forEach((z, idx) => {
                console.log(`  ${idx+1}. ${z.zoneId.padEnd(12)} ${z.zoneName.padEnd(16)} ${String(z.price).padStart(4)}元 ${z.statusText.padEnd(10)} ${z.isSoldOut ? '⚠️已售完' : '✓'}`);
              });
              break;
            }
            await page.waitForTimeout(1000);
          }
          if (!found) {
            const htmlSnippet = await page.evaluate(() => (document.documentElement?.innerHTML || '').substring(0, 3000));
            console.log('❌ 未找到各區，HTML:', htmlSnippet.substring(0, 1000));
          }
        }
      }
    }

    // ─── Step 7: 嘗試直接導航到 UTK0204 ──────────────
    if (diag['#ctl00_ContentPlaceHolder1_BUY_TYPE_1'] === 0) {
      console.log('\n⚠️  沒有 BUY_TYPE 選項，嘗試直接到 UTK0204...');
      const utk0204Url = `https://orders.ibon.com.tw/application/UTK02/UTK0204_000.aspx?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${productId}`;
      await page.goto(utk0204Url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(5000);
      
      console.log(`目前 URL: ${await page.evaluate(() => window.location.href)}`);
      const diag2 = await page.evaluate(() => ({
        title: document.title,
        'td[data-title="票區"]': document.querySelectorAll('td[data-title="票區"]').length,
        'tbody tr': document.querySelectorAll('tbody tr').length,
        bodyStart: (document.body?.innerText || '').substring(0, 300),
      }));
      console.log('UTK0204 診斷:', JSON.stringify(diag2, null, 2));
      await page.screenshot({ path: 'step_utk0204.png' });
    }

    console.log('\n✅ 測試完成，瀏覽器將在 20 秒後關閉');
    await new Promise(r => setTimeout(r, 20000));
  } catch (error) {
    console.error('\n❌ 測試失敗:', error);
    await new Promise(r => setTimeout(r, 30000));
  } finally {
    await browser.close();
    console.log('🟢 瀏覽器已關閉');
  }
}

main();
