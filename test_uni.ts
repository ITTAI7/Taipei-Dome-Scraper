import { ScraperFactory } from './src/services/scrapers/ScraperFactory.js';

async function main() {
  console.log('=== Uni-Lions Scraper Test ===\n');
  
  const scraper = ScraperFactory.getScraper('uni');
  
  // Step 1: Get games
  console.log('Step 1: Fetching games...');
  const games = await scraper.getGames();
  console.log(`\nFound ${games.length} games:\n`);
  games.forEach((g, i) => {
    console.log(`  [${i + 1}] ${g.title}`);
    console.log(`       ${g.link}`);
  });
  
  if (games.length === 0) {
    console.log('No games found. Exiting.');
    return;
  }
  
  // Step 2: Get tickets for the first game
  const firstGame = games[0];
  console.log(`\nStep 2: Fetching tickets for: ${firstGame.title}`);
  console.log(`URL: ${firstGame.link}\n`);
  
  const ticketInfo = await scraper.getTickets(firstGame.link, (msg) => {
    console.log(`  [進度] ${msg}`);
  });
  
  console.log('\n=== Results ===');
  console.log(`Total unsold: ${ticketInfo.total_unsold}`);
  console.log(`Total sold: ${ticketInfo.total_sold ?? 'N/A'}`);
  console.log(`Total capacity: ${ticketInfo.total_capacity}`);
  console.log(`\nZone details (${ticketInfo.details.length} zones):`);
  console.log('='.repeat(80));
  console.log('Zone'.padEnd(25), 'Unsold'.padEnd(10), 'Sold'.padEnd(10), 'Total'.padEnd(10), 'Note');
  console.log('-'.repeat(80));
  
  ticketInfo.details.forEach(z => {
    const soldStr = z.sold !== undefined && z.sold >= 0 ? String(z.sold) : 'N/A';
    const totalStr = z.total !== undefined && z.total >= 0 ? String(z.total) : 'N/A';
    const note = z.error || '';
    console.log(z.zone.padEnd(25), String(z.unsold).padEnd(10), soldStr.padEnd(10), totalStr.padEnd(10), note);
  });
  
  console.log('-'.repeat(80));
  console.log('TOTAL'.padEnd(25), String(ticketInfo.total_unsold).padEnd(10), 
    (ticketInfo.total_sold !== undefined ? String(ticketInfo.total_sold) : 'N/A').padEnd(10),
    String(ticketInfo.total_capacity).padEnd(10));
}

main().catch(err => {
  console.error('\nTest failed:', err);
  process.exit(1);
});