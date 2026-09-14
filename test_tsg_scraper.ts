/**
 * Direct TsgScraper test — fetches games then tickets via the full scraper pipeline
 * (seat-availability + activity-venues, with ignoreTag-closed zones excluded).
 * No manual interaction required.  Run: npx tsx test_tsg_scraper.ts
 */
import { TsgScraper } from './src/services/scrapers/TsgScraper.js';

async function main() {
  console.log('═══════════════════════════════════');
  console.log('  TsgScraper 自動測試');
  console.log('═══════════════════════════════════\n');

  const scraper = new TsgScraper();

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

  const closed = tickets.details.filter(d => d.error === '此場次尚未開放銷售').length;

  console.log('\n══════════ 結 果 ══════════');
  console.log(`比賽: ${target.title}`);
  console.log(`總剩餘票: ${tickets.total_unsold}`);
  console.log(`總已售: ${tickets.total_sold}`);
  console.log(`總容量: ${tickets.total_capacity}`);
  console.log(`票區數: ${tickets.details.length}（其中 ${closed} 區尚未開放銷售，已排除於總計外）`);

  console.log('\n✅ 測試完成，資料抓取正常！');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
