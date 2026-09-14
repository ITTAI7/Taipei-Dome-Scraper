/**
 * Direct UniScraper test — fetches games then tickets via the full scraper pipeline.
 * Run: npx tsx test_uni_scraper.ts
 */
import { UniScraper } from './src/services/scrapers/UniScraper.js';

async function main() {
  console.log('═══════════════════════════════════');
  console.log('  UniScraper 自動測試');
  console.log('═══════════════════════════════════\n');

  const scraper = new UniScraper();

  console.log('─── Step 1: getGames() ───');
  const games = await scraper.getGames();
  if (!games || !games.length) { console.error('❌ No games'); process.exit(1); }
  console.log(`✅ Found ${games.length} games:`);
  for (const g of games) {
    console.log(`   ${g.title}`);
    console.log(`      ${g.link}`);
  }

  const target = games[0];
  console.log(`\n─── Step 2: getTickets() for "${target.title}" ───`);

  const tickets = await scraper.getTickets(target.link, (msg: string) => console.log(`   [進度] ${msg}`));

  console.log('\n══════════ 結 果 ══════════');
  console.log(`比賽: ${target.title}`);
  console.log(`總剩餘票: ${tickets.total_unsold}`);
  if (tickets.total_sold !== undefined) console.log(`總已售: ${tickets.total_sold}`);
  if (tickets.total_capacity !== undefined) console.log(`總容量: ${tickets.total_capacity}`);
  console.log(`票區數: ${tickets.details.length}`);

  console.log('\n前 5 區:');
  for (const d of tickets.details.slice(0, 5)) {
    const sold = d.sold !== undefined && d.sold >= 0 ? String(d.sold) : '?';
    const total = d.total !== undefined && d.total >= 0 ? String(d.total) : '?';
    console.log(`   ${d.zone.padEnd(28)} unsold=${String(d.unsold).padStart(5)} sold=${sold.padStart(5)} total=${total.padStart(5)} ${d.error || ''}`);
  }

  console.log('\n✅ 測試完成！');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });