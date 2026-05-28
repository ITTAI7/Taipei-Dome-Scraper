import { ITicketScraper } from './ITicketScraper.js';
import { BrothersScraper } from './BrothersScraper.js';
import { WeiChuanScraper } from './WeiChuanScraper.js';
import { FubonScraper } from './FubonScraper.js';
import { TsgScraper } from './TsgScraper.js';
import { RakutenScraper } from './RakutenScraper.js';
import { UniScraper } from './UniScraper.js';

export class ScraperFactory {
  static getScraper(platform: string): ITicketScraper {
    switch (platform.toLowerCase()) {
      case 'brothers':
      case 'ctbc':
        return new BrothersScraper();
      case 'weichuan':
        return new WeiChuanScraper();
      case 'fubon':
        return new FubonScraper();
      case 'tsg':
      case 'tsghawks':
        return new TsgScraper();
      case 'rakuten':
      case 'monkeys':
        return new RakutenScraper();
      case 'uni':
      case 'unilions':
        return new UniScraper();
      // Add more platforms like tixcraft, kktix below as needed
      default:
        throw new Error(`Platform ${platform} is not supported yet.`);
    }
  }
}
