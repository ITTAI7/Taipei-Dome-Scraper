/**
 * Direct BrothersScraper test — fetches games then tickets via the full scraper pipeline.
 * No manual interaction required.  Run: npx tsx test_brothers_scraper.ts
 */
import { BrothersScraper } from './src/services/scrapers/BrothersScraper.js';

async function main() {
  console.log('═══════════════════════════════════');
  console.log('  BrothersScraper 自動測試');
  console.log('═══════════════════════════════════\n');

  const scraper = new BrothersScraper();

  console.log('─── Step 1: getGames() ───');
  let games;
  try {
    games = await scraper.getGames();
  } catch (e: any) {
    console.error('❌ getGames failed:', e.message);
    process.exit(1);
  }

  if (!games || games.length === 0) {
    console.error('❌ No games returned');
    process.exit(1);
  }

  console.log(`✅ Found ${games.length} games:`);
  for (const g of games) {
    console.log(`   ${g.title}`);
  }

  const target = games[0];
  console.log(`\n─── Step 2: getTickets() for "${target.title}" ───`);

  let tickets;
  try {
    tickets = await scraper.getTickets(target.link, (msg: string) => console.log(`   [進度] ${msg}`));
  } catch (e: any) {
    console.error('❌ getTickets failed:', e.message);
    process.exit(1);
  }

  console.log('\n══════════ 結 果 ══════════');
  console.log(`比賽: ${target.title}`);
  console.log(`總剩餘票: ${tickets.total_unsold}`);
  if (tickets.total_sold !== undefined) console.log(`總已售: ${tickets.total_sold}`);
  if (tickets.total_capacity !== undefined) console.log(`總容量: ${tickets.total_capacity}`);
  console.log(`票區數: ${tickets.details.length}`);

  console.log('\n✅ 測試完成，資料抓取正常！');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
