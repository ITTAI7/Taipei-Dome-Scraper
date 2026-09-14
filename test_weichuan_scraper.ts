/**
 * Direct WeiChuanScraper test — only exercises getGames(), because getTickets()
 * requires a logged-in sessionToken (see server.ts /api/weichuan/captcha + /login),
 * which this standalone script has no way to obtain non-interactively.
 * Run: npx tsx test_weichuan_scraper.ts
 */
import { WeiChuanScraper } from './src/services/scrapers/WeiChuanScraper.js';

async function main() {
  console.log('═══════════════════════════════════');
  console.log('  WeiChuanScraper 自動測試（僅 getGames）');
  console.log('═══════════════════════════════════\n');

  const scraper = new WeiChuanScraper();

  console.log('─── getGames() ───');
  let games;
  try {
    games = await scraper.getGames();
  } catch (e: any) {
    console.error('❌ getGames failed:', e.message);
    process.exit(1);
  }

  console.log(`✅ Found ${games.length} Taipei Dome games:`);
  for (const g of games) {
    console.log(`   ${g.title}`);
  }

  console.log('\n✅ 測試完成（getTickets 需登入，請透過網頁介面手動測試）。');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
