import { ITicketScraper, GameLink, TicketInfo, TicketZone } from './ITicketScraper.js';
import * as cheerio from 'cheerio';
import { localSafeFetch } from './localFetch.js';

export class BrothersScraper implements ITicketScraper {
  private baseUrl = 'https://tix.ctbcsports.com/BROTHERS/';

  async getGames(): Promise<GameLink[]> {
    console.log('Fetching games via pure HTTP...');
    
    // Initial request to get cookies
    const initRes = await localSafeFetch(new URL('UTK0101_', this.baseUrl));
    if (!initRes.ok) throw new Error('Failed to load UTK0101_');
    
    let cookies: string[] = [];
    if (typeof initRes.headers.getSetCookie === 'function') {
      cookies = initRes.headers.getSetCookie();
    }
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    
    const html = await initRes.text();
    if (html.includes('網站有異常情況')) {
        throw new Error("⚠️ 系統偵測到售票系統異常 (可能是IP限制、Session遺失或過於頻繁)，請重新整理畫面(F5)或稍後再試。");
    }
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
        'Origin': 'https://tix.ctbcsports.com'
      },
      body: '' 
    });
    
    const evText = await evRes.text();
    if (evText.includes('網站有異常情況')) {
        throw new Error("⚠️ 系統偵測到售票系統異常 (可能是IP限制、Session遺失或過於頻繁)，請重新整理畫面(F5)或稍後再試。");
    }
    const match = evText.match(/_cevent\s*=\s*(\[[\s\S]*\])/);
    console.log('Events parsed', !!match);
    const gameLinks: GameLink[] = [];
    
    if (match && match[1]) {
      const events = JSON.parse(match[1]);
      events.forEach((ev: any) => {
        if (ev.PLACE_ID === 'P18PM5NV') { // 臺北大巨蛋
          const startDate = ev.S_SHOW_START_DATETIME.substring(0, 10);
          gameLinks.push({
             title: `${ev.S_SHOW_START_DATETIME} - ${ev.BATTLE_TEAM_NAME}vs中信兄弟`,
             link: `${this.baseUrl}UTK0201_?PRODUCT_ID=${ev.PRODUCT_ID}&STARTDATE=${startDate}`
          });
        }
      });
    }
    
    console.log(`Found ${gameLinks.length} games.`);
    return gameLinks;
  }

  async getTickets(gameUrlStr: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    console.log(`Scraping tickets for: ${gameUrlStr}`);
    const gameUrl = new URL(gameUrlStr);
    const uProductId = gameUrl.searchParams.get('PRODUCT_ID');
    const uStartDate = gameUrl.searchParams.get('STARTDATE');
    
    if (!uProductId || !uStartDate) {
       throw new Error("Invalid game url");
    }

    let allCookies = new Map<string, string>();
    let reqVer = '';
    let auth = '';

    const fetchHtml = async (url: string, referer: string | null = null, asAjax: boolean = false) => {
       const cookieStr = Array.from(allCookies.entries()).map(([k,v])=>`${k}=${v}`).join('; ');
       let opts: any = { 
           headers: { 
               'Cookie': cookieStr, 
               'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
           }, redirect: 'manual' 
       };
       if(referer) opts.headers['Referer'] = referer;
       if(asAjax) {
           opts.headers['X-Requested-With'] = 'XMLHttpRequest';
           if (reqVer) opts.headers['RequestVerificationToken'] = reqVer;
           if (auth) opts.headers['Authorization'] = auth;
       }
       
       let retries = 0;
       while (retries < 5) {
           const res = await localSafeFetch(new URL(url, this.baseUrl).href, opts);
           let setCookies = res.headers.getSetCookie();
           if(setCookies){
               setCookies.forEach(c => {
                   let pair = c.split(';')[0];
                   let sepIdx = pair.indexOf('=');
                   if (sepIdx !== -1) {
                       let k = pair.substring(0, sepIdx);
                       let v = pair.substring(sepIdx + 1);
                       allCookies.set(k, v);
                   }
               });
           }
           const htmlText = await res.text();
           if (htmlText.includes('網站有異常情況')) {
               retries++;
               if (onProgress) onProgress(`系統攔截... 自動重試中 (${retries}/5)...`);
               await new Promise(r => setTimeout(r, 2000));
               continue;
           }
           return {status: res.status, html: htmlText};
       }
       throw new Error("⚠️ 系統偵測到售票系統異常 (可能是IP限制、Session遺失或過於頻繁)，請重新整理畫面(F5)或稍後再試。");
    };

    console.log('Navigating and extracting...');
    await fetchHtml('UTK0101_');
    const page1Html = await fetchHtml(`UTK0201_?PRODUCT_ID=${uProductId}&STARTDATE=${uStartDate}`, this.baseUrl + 'UTK0101_');
    
    const $1 = cheerio.load(page1Html.html);
    reqVer = $1('input[name="__RequestVerificationToken"]').attr('value') || '';
    auth = $1('input[name="__JWtToken"]').attr('value') || '';

    const pListUrl = `PerformanceListControl?PRODUCT_ID=${uProductId}&STARTDATE=${encodeURIComponent(uStartDate)}&SEASON_TICKET_ID=&ItemMaxNumber=4`;
    const pListRes = await localSafeFetch(new URL(pListUrl, this.baseUrl).href, {
       headers: {
           'Cookie': Array.from(allCookies.entries()).map(([k,v])=>`${k}=${v}`).join('; '),
           'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
           'X-Requested-With': 'XMLHttpRequest',
           'RequestVerificationToken': reqVer,
           'Authorization': auth,
           'Referer': this.baseUrl + `UTK0201_?PRODUCT_ID=${uProductId}&STARTDATE=${uStartDate}`
       }
    });
    const pListHtml = await pListRes.text();
    if (pListHtml.includes('網站有異常情況')) {
        throw new Error("⚠️ 系統偵測到售票系統異常 (可能是IP限制、Session遺失或過於頻繁)，請重新整理畫面(F5)或稍後再試。");
    }
    let mPerf = pListHtml.match(/PERFORMANCE_ID=([A-Z0-9]+)/);
    if(!mPerf) {
        // No purchase link yet usually means the game hasn't gone on sale
        // (e.g. season-ticket priority window not open), not a WAF block.
        const $pList = cheerio.load(pListHtml);
        const buyBtnText = $pList('#buy_btn').text().trim();
        if (buyBtnText) {
            throw new Error(`⏳ 此場次尚未開賣：${buyBtnText}`);
        }
        console.error("pListHtml preview:", pListHtml.substring(0, 1000));
        throw new Error("Could not find PERFORMANCE_ID on performance list API");
    }
    const performanceId = mPerf[1];
    console.log("Got PERFORMANCE_ID:", performanceId);

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
          if (!m && zoneName.includes('輪椅')) {
              // 
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
    console.log(`Explicit unsold: ${total_unsold}. Fetching ${hotZones.length} hot zones...`);
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
                       if (e.message && e.message.includes('售票系統異常') && retries < 2) {
                           retries++;
                           console.log(`Retrying hot zone ${tz.name} (attempt ${retries + 1})...`);
                           await new Promise(r => setTimeout(r, 2000));
                       } else {
                           console.log(`Zone ${tz.name} encountered WAF block.`);
                           details[tz.index].error = "遭防爬蟲阻擋(WAF)";
                           throw new Error("WAF_BLOCKED");
                       }
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

    console.log(`Found ${details.length} ticket zones. Total unsold: ${total_unsold}`);
    return { 
        total_unsold, 
        total_sold: sum_sold,
        total_capacity: sum_capacity,
        details 
    };
  }
}
