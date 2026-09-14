/**
 * Direct RakutenScraper test — fetches games then tickets via the full scraper pipeline.
 * No manual interaction required.  Run: npx tsx test_rakuten_scraper.ts
 */
import { RakutenScraper } from './src/services/scrapers/RakutenScraper.js';

async function main() {
  console.log('═══════════════════════════════════');
  console.log('  RakutenScraper 自動測試');
  console.log('═══════════════════════════════════\n');

  const scraper = new RakutenScraper();

  // 1) Fetch game list
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
    console.log(`      ${g.link}`);
  }

  // 2) Pick the first game and scrape tickets
  const target = games[0];
  console.log(`\n─── Step 2: getTickets() for "${target.title}" ───`);

  let tickets;
  try {
    tickets = await scraper.getTickets(target.link, (msg: string) => console.log(`   [進度] ${msg}`));
  } catch (e: any) {
    console.error('❌ getTickets failed:', e.message);
    process.exit(1);
  }

  // 3) Print results
  console.log('\n══════════ 結 果 ══════════');
  console.log(`比賽: ${target.title}`);
  console.log(`總剩餘票: ${tickets.total_unsold}`);
  if (tickets.total_sold !== undefined) console.log(`總已售: ${tickets.total_sold}`);
  if (tickets.total_capacity !== undefined) console.log(`總容量: ${tickets.total_capacity}`);
  console.log(`\n票區明細 (${tickets.details.length} 區):`);
  console.log('票區'.padEnd(30) + '剩餘'.padEnd(10) + '已售'.padEnd(10) + '總數'.padEnd(10) + '備註');
  console.log('─'.repeat(80));

  for (const d of tickets.details) {
    const sold = d.sold !== undefined && d.sold >= 0 ? String(d.sold) : '?';
    const total = d.total !== undefined && d.total >= 0 ? String(d.total) : '?';
    console.log(
      d.zone.padEnd(30) +
      String(d.unsold).padEnd(10) +
      sold.padEnd(10) +
      total.padEnd(10) +
      (d.error || '')
    );
  }
  console.log('─'.repeat(80));
  console.log(`票區數: ${tickets.details.length} | 剩餘票數: ${tickets.total_unsold}`);

  console.log('\n✅ 測試完成，資料抓取正常！');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });