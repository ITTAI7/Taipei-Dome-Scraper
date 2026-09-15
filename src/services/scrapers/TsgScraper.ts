import { ITicketScraper, GameLink, TicketInfo, TicketZone } from './ITicketScraper.js';
import { localSafeFetch } from './localFetch.js';

export class TsgScraper implements ITicketScraper {
  private baseApiUrl = 'https://ticket-platform.newretail.tw/api/v1/public';
  private venueInfoBaseUrl = 'https://ticket-info.newretail.tw/api/v1/activity-venues';
  private headers = {
    'x-company-code': 'tsghawks',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };

  // ─── 場館座位容量（官方權威資料，非推算）──────────────────────────
  // ticket-info.newretail.tw 這支 API 會回傳每個分區代號真正的座位數
  // （seatCount），連前/後拆分區、輪椅席、貴賓包廂都各自有獨立的真實數字，
  // 不需要再像 大巨蛋座位.json 那樣用「樓層＋分區號」回推、也不會有拆分區
  // 不知道怎麼分配的問題。已驗證同一場館在不同場次之間 seatCount 完全一致
  // （純粹是場館固定配置），activity-venues 的 id 就是把 activityId 的
  // "AC_" 前綴換成 "AV_"。
  //
  // 這支 API 同時還會回傳 ignoreTag：實測證實這是「此場次是否開放銷售」
  // 的旗標（同一分區在不同場次之間會變動，例如 9/24 這場 ignoreTag:true
  // 的 L2/L4/L5 分區，9/27 那場變成 false）。分區關閉時，seat-availability
  // 回傳的 availableSeats 不可信（可能被系統歸零或維持某個固定值以避免被
  // 訂購，不代表真實庫存），所以要一併帶出來，關閉的分區不能拿它算已售。
  private async fetchSeatCapacityMap(activityId: string, eventSessionId: string): Promise<Map<string, { seatCount: number; ignoreTag: boolean }>> {
    const map = new Map<string, { seatCount: number; ignoreTag: boolean }>();
    try {
      const venueId = activityId.replace(/^AC_/, 'AV_');
      const url = `${this.venueInfoBaseUrl}/${venueId}?activityId=${activityId}&eventSessionId=${eventSessionId}`;
      const res = await localSafeFetch(url, { headers: this.headers });
      if (!res.ok) {
        console.warn(`[TSG] 無法取得場館座位資料 (HTTP ${res.status})，已售/總容量將顯示未知`);
        return map;
      }
      const data = await res.json();
      (data.activityAreaList || []).forEach((z: any) => {
        if (typeof z.seatCount === 'number') map.set(z.code, { seatCount: z.seatCount, ignoreTag: !!z.ignoreTag });
      });
      console.log(`[TSG] Loaded ${map.size} zone capacities from activity-venues API`);
    } catch (e) {
      console.warn('[TSG] 無法取得場館座位資料，已售/總容量將顯示未知:', (e as Error).message);
    }
    return map;
  }

  async getGames(): Promise<GameLink[]> {
    console.log('Fetching TSG Hawks games via JSON API...');
    
    // As per findings, the spotlight API returns all games with their availability status
    const spotlightUrl = `${this.baseApiUrl}/spotlight`;
    
    const res = await localSafeFetch(spotlightUrl, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Failed to fetch TSG games: ${res.status}`);
    }
    
    const data = await res.json();
    const gameLinks: GameLink[] = [];
    
    if (data.regulars) {
      data.regulars.forEach((g: any) => {
        // Only keep Taipei Dome games; filter out games that are "已結束" (disabled/購票時間已結束)
        const venueName = g.venueName || '';
        if (venueName.includes('大巨蛋') && g.eligibilityStatus !== 'disabled') {
          // Format date to local string or keep ISO substring
          const dateStr = g.gameTime ? g.gameTime.substring(0, 10).replace(/-/g, '/') : '未知日期';
          const title = `${dateStr} - ${g.away}vs${g.home} - ${g.venueName}`;
          
          // Encode activityId & eventSessionId into a custom link URI format or explicit JSON api address
          const queryParams = new URLSearchParams({
            activityId: g.activityId,
            eventSessionId: g.eventSessionId
          });
          const link = `https://ticket-platform.newretail.tw/tsg-api-params?${queryParams.toString()}`;

          gameLinks.push({
            title,
            link
          });
        }
      });
    }

    console.log(`Found ${gameLinks.length} active TSG Hawks games.`);
    return gameLinks;
  }

  async getTickets(gameUrlStr: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    console.log(`Scraping tickets for TSG: ${gameUrlStr}`);
    if (onProgress) onProgress("讀取各區座位資訊...");
    
    // Parse the encoded parameters we passed in getGames
    const urlParams = new URLSearchParams(gameUrlStr.split('?')[1] || '');
    const activityId = urlParams.get('activityId');
    const eventSessionId = urlParams.get('eventSessionId');

    if (!activityId || !eventSessionId) {
      throw new Error('Invalid TSG game format: missing activityId or eventSessionId');
    }

    const availUrl = `${this.baseApiUrl}/seat-availability?activityId=${activityId}&eventSessionId=${eventSessionId}`;

    const [availRes, capacityMap] = await Promise.all([
      localSafeFetch(availUrl, { headers: this.headers }),
      this.fetchSeatCapacityMap(activityId, eventSessionId)
    ]);

    if (!availRes.ok) {
      throw new Error(`Failed to fetch TSG seat availability: ${availRes.status}`);
    }

    const data = await availRes.json();

    const details: TicketZone[] = [];

    if (Array.isArray(data)) {
        data.forEach((zone: any) => {
            const zoneName = zone.name || zone.code;
            const info = capacityMap.get(zone.code);
            if (!info) {
                details.push({ zone: zoneName, unsold: zone.availableSeats || 0, sold: -1, total: -1 });
                return;
            }
            if (info.ignoreTag) {
                // 此場次尚未開放銷售：availableSeats 對關閉的分區不可信，
                // 不計算已售/未售。但座位數（seatCount）是場館固定配置、不受
                // 開賣與否影響，屬於權威資料，仍要寫入 total 供人工校正座位表使用。
                details.push({ zone: zoneName, unsold: -1, sold: -1, total: info.seatCount, error: '此場次尚未開放銷售' });
                return;
            }
            const unsold = zone.availableSeats || 0;
            details.push({
                zone: zoneName,
                unsold,
                sold: Math.max(0, info.seatCount - unsold),
                total: info.seatCount
            });
        });
    }

    let total_unsold = 0;
    let total_sold = 0;
    let total_capacity = 0;
    details.forEach(d => {
        if (d.unsold >= 0) total_unsold += d.unsold;
        if (d.sold !== undefined && d.sold >= 0) total_sold += d.sold;
        // 座位數總計採用場館座位數（total），不受分區是否開賣影響，
        // 才能跟每區座位數的加總對得起來，供人工校正座位表使用。
        if (typeof d.total === 'number' && d.total >= 0) total_capacity += d.total;
    });

    console.log(`Found ${details.length} ticket zones. Total unsold: ${total_unsold}, total sold: ${total_sold}`);
    return { total_unsold, total_sold, total_capacity, details };
  }
}
