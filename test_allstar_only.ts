import { AllStarScraper } from './src/services/scrapers/AllStarScraper.js';

async function main() {
  try {
    const games = await new AllStarScraper().getGames();
    console.log('games:', JSON.stringify(games, null, 2));
  } catch (e: any) {
    console.error('ERR', e.message);
  }
}
main();
