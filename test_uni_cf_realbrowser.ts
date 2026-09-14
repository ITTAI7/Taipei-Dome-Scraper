/**
 * 用真正被 Playwright 控制的本機 Chrome（跟 IbonBrowser.ts 完全一樣的啟動方式）
 * 開統一活動頁，跟純 curl 的結果做對照，藉此確認：
 * 是「非瀏覽器請求」才會被 CF 擋，還是「被自動化控制的瀏覽器」也一樣會被擋。
 */
import { launchIbonBrowser, isCfChallengePage } from './src/services/scrapers/IbonBrowser.js';

const ACTIVITY_URL = 'https://ticket.ibon.com.tw/ActivityInfo/Details/39760';

async function run(headless: boolean) {
  console.log(`\n=== headless=${headless} ===`);
  const { context, page } = await launchIbonBrowser({ team: 'uni-difftest', headless });
  try {
    const start = Date.now();
    await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto error:', e.message));
    await new Promise(r => setTimeout(r, 4000));
    const blocked = await isCfChallengePage(page);
    const title = await page.title().catch(() => '(err)');
    const elapsed = Date.now() - start;
    console.log(`title="${title}"  isCfChallengePage=${blocked}  elapsed=${elapsed}ms`);
    return blocked;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const blockedHeadless = await run(true);
  if (blockedHeadless) {
    console.log('\nheadless=true 被擋，改用 headless=false（會跳出真實視窗）再測一次...');
    await run(false);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
