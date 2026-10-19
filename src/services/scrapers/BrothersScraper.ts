import { ITicketScraper, GameLink, TicketInfo, TicketZone } from './ITicketScraper.js';
import * as cheerio from 'cheerio';
import { localSafeFetch } from './localFetch.js';
import { loadSeatCapacityMap, patchDomeCapacity, DOME_SEAT_MAP_V3_FILE } from './domeSeatMap.js';

// 兄弟售票網站的限速頁：讀太快會回「429 - 請求頻率過高」（HTTP 狀態碼仍是 200，只能看內容），
// 偶爾回「網站有異常情況」頁。2026-10-19 實測 10/20：讀到第 120 區左右開始回 429 頁（跟味全同一頁，1126 bytes）。
const isThrottledPage = (html: string) =>
    html.includes('請求頻率過高') || html.includes('HTTP 429') || html.includes('網站有異常情況');
const THROTTLED_MESSAGE = '⏳ 中信兄弟售票網站暫時限制查詢頻率（429 請求頻率過高），請等 1 分鐘後再查詢。';

export class BrothersScraper implements ITicketScraper {
  private baseUrl = 'https://tix.ctbcsports.com/BROTHERS/';
  private domeSeatMap = loadSeatCapacityMap(DOME_SEAT_MAP_V3_FILE);

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

    // retryOnWaf：遇到「網站有異常情況」頁時自己等 2 秒重試。讀座位圖時傳 false，
    // 改由下面的讀取佇列統一冷卻、放慢（不然一個請求自己重試時，其他請求還在全速讀）。
    const fetchHtml = async (url: string, referer: string | null = null, asAjax: boolean = false, retryOnWaf: boolean = true) => {
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
           if (retryOnWaf && htmlText.includes('網站有異常情況')) {
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
        // 一開始就被限速（例如剛查完又馬上再查）：直接說清楚，不要落到下面被當成「找不到 PERFORMANCE_ID」。
        // 限速判斷都放在「該有的資料找不到」之後才做，避免正常頁面剛好含有那幾個字被誤判。
        if (isThrottledPage(pListHtml)) throw new Error(THROTTLED_MESSAGE);
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
    // 票區表被限速的話整張表是空的，會變成「0 區」的錯誤結果
    if ($('tr.saleTr').length === 0 && isThrottledPage(r3.html)) throw new Error(THROTTLED_MESSAGE);

    
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
              
              // 「熱賣中」等非數字狀態在讀到座位圖前剩餘數是未知（-1），不要先填 0：
              // 若之後座位圖讀不到（WAF 中斷、解析失敗），0 會被 patchDomeCapacity
              // 當成「剩 0 張」而回推成整區售完。
              let baseUnsold = -1;
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
    
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    type HotZone = typeof hotZones[number];
    type SeatMapResult = { kind: 'ok'; unsold: number; sold: number } | { kind: 'throttled' } | { kind: 'empty' };

    // 讀一區座位圖。
    // - throttled：售票網站限速頁（429 / 網站有異常情況），跟座位圖本身無關，冷卻後重讀即可。
    // - empty：頁面正常，但既沒有座位 DOM 也沒有 seatStr。
    const readSeatMap = async (tz: HotZone): Promise<SeatMapResult> => {
        const r4 = await fetchHtml(tz.url, this.baseUrl + `UTK0204_?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${uProductId}`, false, false);
        const $zone = cheerio.load(r4.html);

        let unsold = $zone('.seat-empty').length;
        let sold = $zone('.seat-people').length;
        if (unsold > 0 || sold > 0) return { kind: 'ok', unsold, sold };

        // Fallback: If DOM elements are absent due to client-side rendering, count statuses directly from the matrix payload
        const seatStrMatch = r4.html.match(/seatStr\s*=\s*'([^']*)'/);
        if (!seatStrMatch || !seatStrMatch[1]) {
            // 找不到座位資料時才判斷是不是限速頁（正常座位圖頁就算含有那幾個字也不會誤判）
            if (isThrottledPage(r4.html)) return { kind: 'throttled' };
            // 讀不到時記下原因（狀態碼、長度、標題），方便判斷；不記 cookie
            const title = $zone('title').text().trim().slice(0, 40);
            console.log(`[Brothers] 座位圖讀不到: ${tz.name} status=${r4.status} len=${r4.html.length} title="${title}"`);
            return { kind: 'empty' };
        }
        unsold = 0;
        sold = 0;
        for (const group of seatStrMatch[1].split('\t')) {
            const parts = group.split(':');
            // Only count if there's actual seat data
            if (parts.length >= 3 && parts[2].trim().length > 0) {
                const count = parts[2].split('.').length;
                if (parts[1] === '0') unsold += count;
                // '1' is sold, '3' is CART, '4' is locked. Treat 1, 3, 4 as sold/unavailable.
                else if (parts[1] === '1' || parts[1] === '3' || parts[1] === '4') sold += count;
            }
        }
        return { kind: 'ok', unsold, sold };
    };

    // result 為 null 時 failNote 說明讀不到的原因（寫進 CSV 備註／分區方塊）
    const finishZone = (tz: HotZone, result: { unsold: number; sold: number } | null, failNote = "座位圖解析失敗") => {
        const d = details[tz.index];
        if (result) {
            d.unsold = result.unsold;
            d.sold = result.sold;
            d.total = result.unsold + result.sold;
        } else {
            // 讀不到座位圖：這區實際賣況未知。維持未知（unsold 保留票區表上的數字），
            // 不要寫 sold=0（會變成看似真實的 0/0，見 DEVLOG 2026-06-26 路徑 3）。
            d.sold = -1;
            d.total = -1;
            d.error = failNote;
        }
        if (d.unsold >= 0) total_unsold += d.unsold;
    };

    // 讀座位圖：兄弟售票網站有請求頻率限制。2026-10-19 實測 10/20：5 區一批同時讀，讀到第 120 區左右
    // 開始回「429 - 請求頻率過高」頁，舊寫法不重試，36 區直接標「座位圖解析失敗」；接著 L4 412 區
    // 連線被切斷（ECONNRESET），舊寫法整個停掉，後面 16 區沒讀也沒備註。照味全 2026-10-15 的做法改成：
    // - 平常最多 5 區同時讀；一被限速或連線中斷，全部暫停冷卻（5→10→20→30 秒，連續被擋才加長），
    //   之後改成一次一區、每區間隔 1 秒。
    // - 慢速連續讀成功 20 區就恢復原本速度（2026-10-19 實測 10/20：才讀 13 區就斷線一次，之後再也沒被擋，
    //   但剩下 154 區全部慢速讀，花了 213 秒）。恢復後又被擋就再放慢，這次查詢不再加速，避免來回跳。
    // - 被擋的分區放回佇列最前面，冷卻後重讀，不算失敗；讀到開始後 4 分鐘還被擋才放棄並寫備註。
    // - 頁面正常但沒有座位資料（empty）的分區排到最後再讀，共讀 3 次還是沒有才標「座位圖解析失敗」。
    // - 每一區最後不是讀到，就是有備註，不會有沒讀又沒說的分區。
    if (onProgress) onProgress(`分析座位圖...`);
    console.log(`Explicit unsold: ${total_unsold}. Fetching ${hotZones.length} hot zones...`);
    const FAST_CONCURRENCY = 5;
    const FAST_INTERVAL_MS = 240;   // 兩次請求開始之間的最小間隔（約等於原本 5 區一批、批間 1.2 秒）
    const SLOW_INTERVAL_MS = 1000;
    const GIVE_UP_AFTER_MS = 4 * 60 * 1000;
    const EMPTY_MAX_TRIES = 3;
    const startedAt = Date.now();
    const queue: HotZone[] = [...hotZones];
    const tries = new Map<HotZone, number>();
    const emptyTries = new Map<HotZone, number>();
    // 每區最近一次沒讀到是因為限速還是連線中斷，放棄時用來寫備註
    const lastBlock = new Map<HotZone, 'throttled' | 'connError'>();
    const BLOCK_NOTE = { throttled: "售票網站持續限速，未讀到座位圖", connError: "連線被售票網站中斷，未讀到座位圖" };
    const gaveUp: { tz: HotZone; note: string }[] = [];
    let inFlight = 0;
    let slowMode = false;
    let cooldownUntil = 0;
    let nextStartAt = 0;
    let throttleStreak = 0;
    const RECOVER_AFTER_OK = 20;
    let slowOkStreak = 0;       // 慢速時連續讀成功幾區
    let recoveredOnce = false;  // 這次查詢已經恢復過一次速度

    const worker = async () => {
        while (true) {
            const waitMs = Math.max(cooldownUntil, nextStartAt) - Date.now();
            if (waitMs > 0) { await sleep(waitMs); continue; }
            if (queue.length === 0) {
                // 其他區還在讀的話先等：它們被限速時會放回佇列
                if (inFlight === 0) return;
                await sleep(200);
                continue;
            }
            if (inFlight >= (slowMode ? 1 : FAST_CONCURRENCY)) { await sleep(100); continue; }

            const tz = queue.shift()!;
            if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
                gaveUp.push({ tz, note: BLOCK_NOTE[lastBlock.get(tz) ?? 'throttled'] });
                continue;
            }
            // 檢查與設定 nextStartAt 之間沒有 await，多個 worker 不會同時通過
            nextStartAt = Date.now() + (slowMode ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS);
            const n = (tries.get(tz) ?? 0) + 1;
            tries.set(tz, n);
            if (onProgress) onProgress(n === 1 ? `讀取分區: ${tz.name}...` : `重新讀取分區: ${tz.name}（第 ${n} 次）...`);

            inFlight++;
            let result: SeatMapResult | { kind: 'connError' };
            try {
                result = await readSeatMap(tz);
            } catch (e: any) {
                // 只記錯誤代碼與訊息，不記 cookie
                console.log(`[Brothers] 讀取 ${tz.name} 連線錯誤：${e?.cause?.code ?? ''} ${e?.message ?? e}`);
                result = { kind: 'connError' };
            } finally {
                inFlight--;
            }

            if (result.kind === 'ok') {
                throttleStreak = 0;
                finishZone(tz, result);
                if (slowMode && !recoveredOnce && ++slowOkStreak >= RECOVER_AFTER_OK) {
                    slowMode = false;
                    recoveredOnce = true;
                    // 前端看到「恢復原本速度」就收起限速提醒框，改字要一起改 App.tsx
                    console.log(`[Brothers] 慢速連續讀成功 ${RECOVER_AFTER_OK} 區，恢復原本速度`);
                    if (onProgress) onProgress(`售票網站已恢復，恢復原本速度繼續讀取...`);
                }
            } else if (result.kind === 'throttled' || result.kind === 'connError') {
                slowOkStreak = 0;
                lastBlock.set(tz, result.kind);
                queue.unshift(tz);
                // 同時在讀的幾區一起被擋，只算一次、只冷卻一次
                if (Date.now() >= cooldownUntil) {
                    throttleStreak++;
                    const coolMs = Math.min(30000, 5000 * 2 ** (throttleStreak - 1));
                    cooldownUntil = Date.now() + coolMs;
                    slowMode = true;
                    // 前端用「限速，等待 N 秒」／「連線中斷，等待 N 秒」這兩種文字顯示提醒框，改字要一起改 App.tsx
                    const reason = result.kind === 'throttled' ? '暫時限速' : '連線中斷';
                    console.log(`[Brothers] 售票網站${reason}，暫停 ${coolMs / 1000} 秒後放慢速度繼續`);
                    if (onProgress) onProgress(`售票網站${reason}，等待 ${coolMs / 1000} 秒後放慢速度繼續...`);
                }
            } else {
                const m = (emptyTries.get(tz) ?? 0) + 1;
                emptyTries.set(tz, m);
                if (m < EMPTY_MAX_TRIES) queue.push(tz);
                else gaveUp.push({ tz, note: "座位圖解析失敗" });
            }
        }
    };
    await Promise.all(Array.from({ length: FAST_CONCURRENCY }, () => worker()));
    gaveUp.forEach(({ tz, note }) => finishZone(tz, null, note));
    
    patchDomeCapacity(details, this.domeSeatMap);

    let sum_sold = 0;
    let sum_capacity = 0;
    details.forEach(z => {
        if (z.sold !== undefined && z.sold >= 0) {
            sum_sold += z.sold;
            sum_capacity += ((z.unsold || 0) + z.sold);
        } else if (typeof z.total === 'number' && z.total >= 0) {
            // 剩餘數未知、但容量已由 patchDomeCapacity 從 v3 容量表回填
            sum_capacity += z.total;
        } else if (z.unsold > 0) {
            sum_capacity += z.unsold;
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
