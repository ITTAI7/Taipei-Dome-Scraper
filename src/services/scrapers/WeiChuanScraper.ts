import * as cheerio from 'cheerio';
import { ITicketScraper, GameLink, TicketInfo, TicketZone } from './ITicketScraper.js';
import { localSafeFetch } from './localFetch.js';
import { loadSeatCapacityMap, patchDomeCapacity, DOME_SEAT_MAP_V3_FILE } from './domeSeatMap.js';

// 味全售票網站的限速頁：讀太快會回「429 - 請求頻率過高」（HTTP 狀態碼仍是 200，只能看內容），
// 偶爾回「網站有異常情況」頁。兩種都是等一下就會恢復，不是頁面結構或登入的問題。
const isThrottledPage = (html: string) =>
    html.includes('請求頻率過高') || html.includes('HTTP 429') || html.includes('網站有異常情況');
const THROTTLED_MESSAGE = '⏳ 味全售票網站暫時限制查詢頻率（429 請求頻率過高），請等 1 分鐘後再查詢。';

export class WeiChuanScraper implements ITicketScraper {
  private baseUrl = 'https://tix.wdragons.com/';
  private domeSeatMap = loadSeatCapacityMap(DOME_SEAT_MAP_V3_FILE);

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
       return {status: res.status, html: htmlText, location: res.headers.get('location') || ''};
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
    if(!mPerf) {
        // 一開始就被限速（例如剛查完又馬上再查）：直接說清楚，不要落到下面被當成「找不到 PERFORMANCE_ID」。
        // 限速判斷都放在「該有的資料找不到」之後才做，避免正常頁面剛好含有那幾個字被誤判。
        if (isThrottledPage(page1Html.html) || isThrottledPage(pListHtml)) throw new Error(THROTTLED_MESSAGE);
        // 沒有購票連結通常代表這個階段還沒開放一般購票，不是登入失效或被擋。
        // 例：2026-10-07 台灣大賽「狂龍軍會員優先訂購」期間，#buy_btn 是
        // VipSellCheck('...')（要先通過會員資格驗證），而不是 PERFORMANCE_ID 連結；
        // 非會員帳號會被站方回「您不符合該階段優先購買資格」。
        const $pList = cheerio.load(pListHtml);
        // 站方的登入已失效（伺服器還留著舊 cookie，但味全那邊 session 過期了）時，
        // 購買鈕是 alert1('請先登入！')，按鈕文字仍是「購買」。這要回報成登入失效
        // （錯誤字串含 UNAUTHORIZED，server 會回 401，前端會清掉 token 並跳出登入框），
        // 不能落到下面被誤報成「尚未開放一般購票：購買」。（2026-10-15 實測）
        if (($pList('#buy_btn').attr('onclick') || '').includes('請先登入')) {
            WeiChuanScraper.cookieStore.delete(sessionToken);
            throw new Error("UNAUTHORIZED_SITE_SESSION_EXPIRED");
        }
        const buyBtnText = $pList('#buy_btn').text().trim();
        if (buyBtnText) {
            throw new Error(`⏳ 此場次目前尚未開放一般購票：${buyBtnText}`);
        }
        throw new Error("Could not find PERFORMANCE_ID on performance list API. Maybe login session expired?");
    }
    const performanceId = mPerf[1];

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

          if(m) {
              const tUrl = `UTK0205_?PERFORMANCE_ID=${m[1]}&GROUP_ID=${m[3]}&PERFORMANCE_PRICE_AREA_ID=${m[2]}`;
              
              // 「熱賣中」等非數字狀態在讀到座位圖前剩餘數是未知（-1），不要先填 0：
              // 若之後座位圖讀不到（WAF 中斷、解析失敗），0 會被當成「剩 0 張」。
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
        const r4 = await fetchHtml(tz.url, this.baseUrl + `UTK0204_?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${uProductId}`);
        const $zone = cheerio.load(r4.html);

        let unsold = $zone('.seat-empty').length;
        let sold = $zone('.seat-people').length;
        if (unsold > 0 || sold > 0) return { kind: 'ok', unsold, sold };

        // Fallback: If DOM elements are absent due to client-side rendering, count statuses directly from the matrix payload
        const seatStrMatch = r4.html.match(/seatStr\s*=\s*'([^']*)'/);
        if (!seatStrMatch || !seatStrMatch[1]) {
            // 找不到座位資料時才判斷是不是限速頁（正常座位圖頁就算含有那幾個字也不會誤判）
            if (isThrottledPage(r4.html)) return { kind: 'throttled' };
            // 只記狀態碼、長度、頁面標題與轉址目標，方便判斷失敗原因；不記 cookie。
            const title = $zone('title').text().trim().slice(0, 40);
            console.log(`[Weichuan] 座位圖讀不到: ${tz.name} status=${r4.status} len=${r4.html.length} title="${title}" location="${r4.location}"`);
            return { kind: 'empty' };
        }
        unsold = 0;
        sold = 0;
        const groups = seatStrMatch[1].split('\t');
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

    // 讀座位圖：味全售票網站有請求頻率限制。2026-10-15 實測 10/17：5 區同時讀，約 30 秒讀了
    // 115 區後開始回「429 - 請求頻率過高」頁，剩下 56 區全部被擋（多是輪椅／陪同席、L2 外野）。
    // 以前把限速頁當成「座位圖讀不到」，固定等 2、4 秒各重抓一次，網站擋得久一點就標失敗。
    // 現在改成：
    // - 平常最多 5 區同時讀；一被限速，全部暫停冷卻（5→10→20→30 秒，連續被擋才加長），
    //   之後改成一次一區、每區間隔 1 秒。
    // - 被限速的分區放回佇列最前面，冷卻後重讀，不算失敗；讀到開始後 4 分鐘還被擋才放棄。
    // - 頁面正常但沒有座位資料（empty）的分區排到最後再讀，共讀 3 次還是沒有才標「座位圖解析失敗」。
    // - 連線被中斷（fetch 丟例外）跟限速一樣冷卻後重讀。以前一丟例外就整個停掉：2026-10-15 實測
    //   L5 506–510 五區同時連線錯誤，後面還沒讀的分區全部沒數字、也沒備註，已售少算一萬多人。
    // - 每一區最後不是讀到，就是有備註，不會有沒讀又沒說的分區。
    if (onProgress) onProgress(`分析座位圖...`);
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
                console.log(`[Weichuan] 讀取 ${tz.name} 連線錯誤：${e?.cause?.code ?? ''} ${e?.message ?? e}`);
                result = { kind: 'connError' };
            } finally {
                inFlight--;
            }

            if (result.kind === 'ok') {
                throttleStreak = 0;
                finishZone(tz, result);
            } else if (result.kind === 'throttled' || result.kind === 'connError') {
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
                    console.log(`[Weichuan] 售票網站${reason}，暫停 ${coolMs / 1000} 秒後放慢速度繼續`);
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

    // 座位圖讀不到的分區（被限速／連線中斷到放棄、完售後連結被拿掉）用 v3 容量表回填 total。
    // 味全只在大巨蛋才有 v3 可用；非大巨蛋分區名稱對不到 v3，patchDomeCapacity 不會動。
    patchDomeCapacity(details, this.domeSeatMap);

    // FamilyZone 自由入座、沒有座位圖，座位數一定是空白。在 CSV 備註寫清楚這區是什麼、
    // 為什麼不補數字，避免時間久了誤以為是抓取失敗（見 NOTE.md 的 v3 段落）。
    // 備註會被 CSV 包在雙引號裡，文字裡不要出現半形雙引號。
    const familyZoneNote = '外野 L3 貴賓樓層的親子專區（沙發座椅＋兒童遊戲區，從 Gate 11 專屬通道搭電梯上樓）。'
        + '自由入座、沒有座位圖，官方也沒公布席數，所以座位數和已售數留白，不填估計值。'
        + '剛開賣還沒人買時，未售張數就是這區的總席數。參考上限：維基百科外野 VIP 層 334 席（左右外野合計）。';
    details.forEach(z => {
        if (/FamilyZone/i.test(z.zone)) {
            z.error = z.error ? `${z.error} ${familyZoneNote}` : familyZoneNote;
        }
    });

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

    return { 
        total_unsold, 
        total_sold: sum_sold,
        total_capacity: sum_capacity,
        details 
    };
  }
}
