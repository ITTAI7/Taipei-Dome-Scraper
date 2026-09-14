import * as cheerio from 'cheerio';
import { ITicketScraper, GameLink, TicketInfo, TicketZone } from './ITicketScraper.js';
import { localSafeFetch } from './localFetch.js';

export class WeiChuanScraper implements ITicketScraper {
  private baseUrl = 'https://tix.wdragons.com/';

  // To support session tokens, we can use a store. In a scalable app, this should be Redis.
  static cookieStore: Map<string, string> = new Map();
  
  // Scraper factory logic can call `getTickets` without session token, we'll pass the session token via a custom parameter or store it in context.
  // We'll augment the query URL to pass the sessionToken: /api/get_tickets/weichuan?url=...&sessionToken=...
  
  async getGames(): Promise<GameLink[]> {
    console.log('Fetching WeiChuan games...');
    const initRes = await localSafeFetch(new URL('UTK0101_', this.baseUrl));
    if (!initRes.ok) throw new Error('Failed to load UTK0101_');
    
    let cookies: string[] = [];
    if (typeof initRes.headers.getSetCookie === 'function') {
      cookies = initRes.headers.getSetCookie();
    }
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    
    const html = await initRes.text();
    const $ = cheerio.load(html);
    
    const reqVer = $('input[name="__RequestVerificationToken"]').attr('value') || '';
    const auth = $('input[name="__JWtToken"]').attr('value') || '';

    const evRes = await localSafeFetch(new URL('UTK0101_/GET_CALENDAR_EVENTS', this.baseUrl), {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Cookie': cookieStr,
        'RequestVerificationToken': reqVer,
        'Authorization': auth,
        'Referer': this.baseUrl + 'UTK0101_',
        'Origin': 'https://tix.wdragons.com'
      },
      body: '' 
    });
    
    const evText = await evRes.text();
    const match = evText.match(/_cevent\s*=\s*(\[[\s\S]*\])/);
    const gameLinks: GameLink[] = [];
    
    if (match && match[1]) {
      const events = JSON.parse(match[1]);
      
      // Determine which PLACE_IDs belong to Taipei Dome
      const placeIds = Array.from(new Set(events.map((ev: any) => ev.PLACE_ID))) as string[];
      const placeIsDome = new Map<string, boolean>();
      
      await Promise.all(placeIds.map(async (placeId) => {
         const tEvent = events.find((ev: any) => ev.PLACE_ID === placeId);
         if (!tEvent) return;
         try {
            const startDate = tEvent.S_SHOW_START_DATETIME.substring(0, 10);
            const res = await localSafeFetch(new URL(`UTK0201_?PRODUCT_ID=${tEvent.PRODUCT_ID}&STARTDATE=${startDate}`, this.baseUrl).href, {
               headers: {
                 'Cookie': cookieStr,
                 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
               }
            });
            const html2 = await res.text();
            const $2 = cheerio.load(html2);
            const title = $2('meta[property="og:title"]').attr('content') || '';
            const isDome = title.includes('大巨蛋');
            placeIsDome.set(placeId, isDome);
         } catch (e) {
            console.error(`Failed to fetch place info for ${placeId}:`, e);
            placeIsDome.set(placeId, false);
         }
      }));

      events.forEach((ev: any) => {
        if (!placeIsDome.get(ev.PLACE_ID)) {
           return; // skip non-Dome games
        }
        const startDate = ev.S_SHOW_START_DATETIME.substring(0, 10);
        gameLinks.push({
           title: `${ev.S_SHOW_START_DATETIME} - ${ev.BATTLE_TEAM_NAME} (味全龍大巨蛋主場)`,
           link: `${this.baseUrl}UTK0201_?PRODUCT_ID=${ev.PRODUCT_ID}&STARTDATE=${startDate}`
        });
      });
    }
    
    return gameLinks;
  }

  async getTickets(gameUrlStr: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    const parsedUrl = new URL(gameUrlStr);
    const uProductId = parsedUrl.searchParams.get('PRODUCT_ID');
    const uStartDate = parsedUrl.searchParams.get('STARTDATE');
    // Using custom searchParam for session token injected by controller
    const sessionToken = parsedUrl.searchParams.get('sessionToken') || '';
    
    if (!uProductId || !uStartDate) {
       throw new Error("Invalid game url");
    }
    
    if (!sessionToken || !WeiChuanScraper.cookieStore.has(sessionToken)) {
       throw new Error("UNAUTHORIZED_NO_SESSION");
    }

    let cookieStr = WeiChuanScraper.cookieStore.get(sessionToken) || '';

    // Simulate cookie jar
    let allCookies = new Map<string, string>();
    cookieStr.split(';').forEach(c => {
       const [k, v] = c.trim().split('=');
       if (k && v) allCookies.set(k, v);
    });

    const updateCookies = (cookies: string[]) => {
       cookies.forEach(c => {
           let pair = c.split(';')[0];
           let sepIdx = pair.indexOf('=');
           if (sepIdx !== -1) {
               let k = pair.substring(0, sepIdx);
               let v = pair.substring(sepIdx + 1);
               allCookies.set(k, v);
           }
       });
       cookieStr = Array.from(allCookies.entries()).map(([k,v])=>`${k}=${v}`).join('; ');
       WeiChuanScraper.cookieStore.set(sessionToken, cookieStr);
    };

    const fetchHtml = async (url: string, referer: string | null = null) => {
       let opts: any = { 
           headers: { 
               'Cookie': cookieStr, 
               'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
           }, redirect: 'manual' 
       };
       if(referer) opts.headers['Referer'] = referer;
       
       const res = await localSafeFetch(new URL(url, this.baseUrl).href, opts);
       if (typeof res.headers.getSetCookie === 'function') {
           updateCookies(res.headers.getSetCookie());
       }
       const htmlText = await res.text();
       return {status: res.status, html: htmlText};
    };

    console.log('[Weichuan] Navigating and extracting...');
    // In Weichuan, we already logged in, so we just navigate to the event directly
    // Let's go to UTK0201 to get the JWT tokens for the XMLHttpRequests
    const page1Html = await fetchHtml(`UTK0201_?PRODUCT_ID=${uProductId}&STARTDATE=${uStartDate}`, this.baseUrl + 'UTK0101_');
    
    const $1 = cheerio.load(page1Html.html);
    const reqVer = $1('input[name="__RequestVerificationToken"]').attr('value') || '';
    const auth = $1('input[name="__JWtToken"]').attr('value') || '';

    const pListUrl = `PerformanceListControl?PRODUCT_ID=${uProductId}&STARTDATE=${encodeURIComponent(uStartDate)}&SEASON_TICKET_ID=&ItemMaxNumber=4`;
    const pListRes = await localSafeFetch(new URL(pListUrl, this.baseUrl).href, {
       headers: {
           'Cookie': cookieStr,
           'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
           'X-Requested-With': 'XMLHttpRequest',
           'RequestVerificationToken': reqVer,
           'Authorization': auth,
           'Referer': this.baseUrl + `UTK0201_?PRODUCT_ID=${uProductId}&STARTDATE=${uStartDate}`
       }
    });
    
    if (typeof pListRes.headers.getSetCookie === 'function') {
        updateCookies(pListRes.headers.getSetCookie());
    }

    const pListHtml = await pListRes.text();
    let mPerf = pListHtml.match(/PERFORMANCE_ID=([A-Z0-9]+)/);
    if(!mPerf) throw new Error("Could not find PERFORMANCE_ID on performance list API. Maybe login session expired?");
    const performanceId = mPerf[1];

    const r3 = await fetchHtml(`UTK0204_?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${uProductId}`, this.baseUrl + `UTK0201_?PRODUCT_ID=${uProductId}&STARTDATE=${uStartDate}`);
    
    const $ = cheerio.load(r3.html);
    
    let mapObjUrlMatch = r3.html.match(/imgs2\.utiki\.com\.tw.*?_live\.map/);
    let mapDoc: any = null;
    if (mapObjUrlMatch) {
        const rMap = await fetchHtml('https://' + mapObjUrlMatch[0]);
        mapDoc = cheerio.load(rMap.html);
    }

    let total_unsold = 0;
    const details: TicketZone[] = [];
    const hotZones: {index: number, name: string, url: string}[] = [];

    $('tr.saleTr').each((i, el) => {
       const zoneName = $(el).find('td[data-title="票區："]').text().trim();
       const status = $(el).find('span#SEAT').text().trim();
       
       let addedToQueue = false;
       let actionStr = '';
       
       let rel = $(el).attr('rel');
       if(rel && mapDoc) {
           let aID = rel.replace('s', 'a');
           let areaEl = mapDoc('#' + aID);
           actionStr = areaEl.attr('href') || areaEl.attr('onclick') || '';
       }
       
       if (!actionStr && mapDoc) {
           let searchName = zoneName.replace(/\s+/g, "");
           let areaEl = mapDoc(`area[title*="${searchName}"]`);
           if(areaEl.length === 0) {
              // Try exact match or just start/end
              areaEl = mapDoc('area').filter((idx, el) => {
                  let t = $(el).attr('title') || '';
                  return t.replace(/\s+/g,"").includes(searchName);
              });
           }
           if (areaEl.length > 0) {
               actionStr = areaEl.first().attr('href') || areaEl.first().attr('onclick') || '';
           }
       }
       
       if (!actionStr) {
           actionStr = $(el).find('button, a, input, [onclick]').map((j, child) => $(child).attr('onclick') || $(child).attr('href')).get().join(' | ');
       }
       if (!actionStr) {
           actionStr = $(el).attr('onclick') || '';
       }
       if (!actionStr) {
           actionStr = $(el).html() || '';
       }
       
       if(actionStr) {
          let m = actionStr.match(/['"]0205['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/);
          if(!m) {
              const pidMatch = actionStr.match(/PERFORMANCE_ID=([^&'"]+)/i);
              const gidMatch = actionStr.match(/GROUP_ID=([^&'"]+)/i);
              const paidMatch = actionStr.match(/PERFORMANCE_PRICE_AREA_ID=([^&'"]+)/i);
              if (pidMatch && gidMatch && paidMatch) {
                  m = [ "", pidMatch[1], paidMatch[1], gidMatch[1] ] as any;
              }
          }

          if(m) {
              const tUrl = `UTK0205_?PERFORMANCE_ID=${m[1]}&GROUP_ID=${m[3]}&PERFORMANCE_PRICE_AREA_ID=${m[2]}`;
              
              let baseUnsold = 0;
              if (/^\d+$/.test(status)) {
                  baseUnsold = parseInt(status, 10);
              }
              
              hotZones.push({index: details.length, name: zoneName, url: tUrl});
              
              // If we are queuing it, we will override from the map page!
              details.push({ zone: zoneName, unsold: baseUnsold, sold: -1, total: -1 });
              addedToQueue = true;
          }
       }
       if (!addedToQueue) {
           let baseUnsold = 0;
           if (/^\d+$/.test(status)) {
               baseUnsold = parseInt(status, 10);
           }
           total_unsold += baseUnsold;
           const newZone: TicketZone = { zone: zoneName, unsold: baseUnsold, sold: -1, total: -1 };
           if (zoneName.includes('輪椅') || zoneName.includes('陪伴')) {
               newZone.error = "無座位圖連結(無法計算)";
           }
           details.push(newZone); 
       }
    });

    if (onProgress) onProgress(`分析座位圖...`);
    const concurrency = 5; // optimized concurrency to speed up fetching and avoid proxy timeouts
    for (let i = 0; i < hotZones.length; i += concurrency) {
        const batch = hotZones.slice(i, i + concurrency);
        try {
            await Promise.all(batch.map(async (tz) => {
                if (onProgress) onProgress(`讀取分區: ${tz.name}...`);
                let retries = 0;
                let success = false;
                while (retries < 3 && !success) {
                    try {
                       let r4 = await fetchHtml(tz.url, this.baseUrl + `UTK0204_?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${uProductId}`);
                       const $zone = cheerio.load(r4.html);
                       
                       let unsold = $zone('.seat-empty').length;
                       let sold = $zone('.seat-people').length;
                       
                       if (unsold === 0 && sold === 0) {
                           // Fallback: If DOM elements are absent due to client-side rendering, count statuses directly from the matrix payload
                           let seatStrMatch = r4.html.match(/seatStr\s*=\s*'([^']*)'/);
                           if (seatStrMatch && seatStrMatch[1]) {
                               const matrix = seatStrMatch[1];
                               unsold = 0;
                               sold = 0;
                               const groups = matrix.split('\t');
                               for (const group of groups) {
                                   const parts = group.split(':');
                                   if (parts.length >= 3) {
                                       const status = parts[1];
                                       // Only count if there's actual seat data
                                       if (parts[2].trim().length > 0) {
                                           const count = parts[2].split('.').length;
                                           if (status === '0') unsold += count;
                                           // '1' is sold, '3' is CART, '4' is locked. Treat 1, 3, 4 as sold/unavailable.
                                           else if (status === '1' || status === '3' || status === '4') sold += count;
                                       }
                                   }
                               }
                           } else {
                               unsold = details[tz.index].unsold;
                               sold = 0;
                           }
                       }
                       const total = sold !== -1 ? unsold + sold : -1;
            
                       total_unsold += unsold;
            
                       details[tz.index].unsold = unsold;
                       details[tz.index].sold = sold;
                       details[tz.index].total = total;
                       success = true;
                    } catch(e: any) {
                        console.log(`Zone ${tz.name} encountered WAF block.`);
                        details[tz.index].error = "遭防爬蟲阻擋(WAF)";
                        throw new Error("WAF_BLOCKED");
                    }
                }
            }));
        } catch (e: any) {
            if (e.message === "WAF_BLOCKED") {
                break;
            }
            throw e;
        }
        await new Promise(r => setTimeout(r, 1200)); // sleep to avoid firing too fast
    }
    
    let sum_sold = 0;
    let sum_capacity = 0;
    details.forEach(z => {
        if (z.sold !== undefined && z.sold >= 0) {
            sum_sold += z.sold;
            sum_capacity += ((z.unsold || 0) + z.sold);
        } else {
            sum_capacity += (z.unsold || 0);
        }
    });

    return { 
        total_unsold, 
        total_sold: sum_sold,
        total_capacity: sum_capacity,
        details 
    };
  }
}
