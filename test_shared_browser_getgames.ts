/**
 * 驗證修改後的 getGames()：三個 ibon 球團平行呼叫，應該只跳出「一個」
 * Chrome 視窗（第一個過 CF），其餘沿用同一個 context 開分頁抓資料。
 */
import { RakutenScraper } from './src/services/scrapers/RakutenScraper.js';
import { UniScraper } from './src/services/scrapers/UniScraper.js';
import { AllStarScraper } from './src/services/scrapers/AllStarScraper.js';

async function main() {
  console.log('同時呼叫 rakuten / uni / allstar 的 getGames()...\n');
  const start = Date.now();
  const [rakuten, uni, allstar] = await Promise.allSettled([
    new RakutenScraper().getGames(),
    new UniScraper().getGames(),
    new AllStarScraper().getGames(),
  ]);
  const elapsed = Date.now() - start;

  for (const [name, result] of [['Rakuten', rakuten], ['Uni', uni], ['AllStar', allstar]] as const) {
    if (result.status === 'fulfilled') {
      console.log(`✅ ${name}: ${result.value.length} 場`);
    } else {
      console.log(`❌ ${name}: ${result.reason?.message || result.reason}`);
    }
  }
  console.log(`\n總耗時: ${elapsed}ms`);
}

main().catch(e => { console.error(e); process.exit(1); });
