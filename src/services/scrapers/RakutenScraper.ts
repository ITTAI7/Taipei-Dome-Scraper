import { ITicketScraper, GameLink, TicketInfo, TicketZone } from './ITicketScraper.js';
import * as cheerio from 'cheerio';

async function getCloakBrowser() {
  const cb = await import('cloakbrowser');
  return cb;
}

export class RakutenScraper implements ITicketScraper {
  private baseUrl = 'https://ticket.ibon.com.tw';
  private ordersBaseUrl = 'https://orders.ibon.com.tw';

  // ─── getGames ──────────────────────────────────────────────────────────
  async getGames(): Promise<GameLink[]> {
    console.log('Fetching Rakuten games via CloakBrowser (API intercept)...');
    const cb = await getCloakBrowser();

    const browser = await cb.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    let apiResponse: string | null = null;

    page.on('response', async (resp: any) => {
      const url = resp.url();
      if (url.includes('/api/ActivityInfo/GetGameInfoList')) {
        try {
          apiResponse = await resp.text();
          console.log('API response intercepted successfully');
        } catch (e) {
          console.log('Failed to read API response:', e);
        }
      }
    });

    try {
      const url = 'https://ticket.ibon.com.tw/ActivityInfo/Details/39428';
      console.log(`Navigating to ${url}...`);

      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await new Promise((r) => setTimeout(r, 5000));

      if (!apiResponse) {
        console.log('Waiting for API response...');
        await new Promise((r) => setTimeout(r, 5000));
      }

      if (apiResponse) {
        console.log('Parsing API response...');
        const games = this.parseGamesFromApi(apiResponse);
        if (games.length > 0) {
          console.log(`Found ${games.length} games from API.`);
          return games;
        }
      }

      throw new Error('Could not fetch games from API: no response captured');
    } catch (error) {
      console.error('Error fetching Rakuten games:', error);
      throw error;
    } finally {
      await browser.close();
    }
  }

  private parseGamesFromApi(jsonStr: string): GameLink[] {
    const games: GameLink[] = [];
    try {
      const parsed = JSON.parse(jsonStr);
      const items = parsed.Item?.GIHtmls || [];
      for (const item of items) {
        const date = (item.ShowSaleDate || '').trim();
        const matchup = (item.GameInfoName || '').trim();
        const venue = (item.VenueRegion || '').trim();
        const href = item.Href || '';
        let ordersUrl = '';
        const goUrlMatch = href.match(/GoUrl=([^&]+)/);
        if (goUrlMatch) ordersUrl = decodeURIComponent(goUrlMatch[1]);
        const fullUrl = ordersUrl || (href.startsWith('http') ? href : `${this.baseUrl}${href}`);
        games.push({ title: `${date} ${matchup} @ ${venue}`, link: fullUrl });
      }
    } catch (e) {
      console.error('Failed to parse API response:', e);
    }
    return games;
  }

  // ─── getTickets ────────────────────────────────────────────────────────
  async getTickets(gameUrlStr: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    console.log(`Scraping Rakuten tickets for: ${gameUrlStr}`);
    const parsedUrl = new URL(gameUrlStr);
    const performanceId = parsedUrl.searchParams.get('PERFORMANCE_ID');
    const productId = parsedUrl.searchParams.get('PRODUCT_ID');
    if (!performanceId || !productId) throw new Error('Missing PERFORMANCE_ID or PRODUCT_ID in URL');

    if (onProgress) onProgress('正在嘗試 HTTP 方式讀取...');
    try {
      return await this.getTicketsViaHttp(performanceId, productId, onProgress);
    } catch (httpError: any) {
      console.log('HTTP approach failed:', httpError.message);
      if (onProgress) onProgress('HTTP 方式失敗，嘗試瀏覽器方式...');
      return this.getTicketsViaBrowser(performanceId, productId, onProgress);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  HTTP approach (for reference – same as before, works for utiki)
  // ═══════════════════════════════════════════════════════════════════════
  private async getTicketsViaHttp(performanceId: string, productId: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    const baseUrl = 'https://orders.ibon.com.tw/';
    const cookies = new Map<string, string>();
    let reqVer = '', auth = '';
    type Ret = { status: number; html: string };

    const fetchHtml = async (url: string, referer?: string, asAjax?: boolean): Promise<Ret> => {
      const opts: any = {
        headers: {
          Cookie: [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        redirect: 'manual',
      };
      if (referer) opts.headers['Referer'] = new URL(referer, baseUrl).href;
      if (asAjax) {
        opts.headers['X-Requested-With'] = 'XMLHttpRequest';
        if (reqVer) opts.headers['RequestVerificationToken'] = reqVer;
        if (auth) opts.headers['Authorization'] = auth;
      }
      for (let retry = 0; retry < 3; retry++) {
        const res = await fetch(new URL(url, baseUrl).href, opts);
        (res.headers.getSetCookie() || []).forEach((c: string) => {
          const [k, v] = c.split(';')[0].split('=');
          if (k && v !== undefined) cookies.set(k, v);
        });
        const html = await res.text();
        if (html.includes('網站有異常情況') || html.includes('驗證') || res.status === 403 || res.status === 503) {
          if (onProgress) onProgress(`系統攔截... 自動重試中 (${retry + 1}/3)...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return { status: res.status, html };
      }
      throw new Error('⚠️ 系統偵測到售票系統異常 (可能是IP限制、Session遺失或過於頻繁)');
    };

    if (onProgress) onProgress('正在初始化連線...');
    await fetchHtml('application/UTK02/UTK0201_000.aspx');
    if (onProgress) onProgress('正在進入訂票頁面...');
    const ordersUrl = `application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${productId}`;
    const r1 = await fetchHtml(ordersUrl, 'application/UTK02/UTK0201_000.aspx');
    const $1 = cheerio.load(r1.html);
    if ($1('body').text().includes('驗證')) throw new Error('Cloudflare – fallback to browser');
    reqVer = $1('input[name="__RequestVerificationToken"]').attr('value') || '';
    auth = $1('input[name="__JWtToken"]').attr('value') || '';

    if (onProgress) onProgress('正在取得場次資訊...');
    const pRes = await fetchHtml('application/UTK02/UTK0201_000.aspx/PerformanceListControl', ordersUrl, true);
    let pid = performanceId;
    const m = pRes.html.match(/PERFORMANCE_ID=([A-Z0-9]+)/);
    if (m) pid = m[1];

    if (onProgress) onProgress('正在讀取各區資料...');
    const zUrl = `application/UTK02/UTK0204_000.aspx?PERFORMANCE_ID=${pid}&PRODUCT_ID=${productId}`;
    const r3 = await fetchHtml(zUrl, ordersUrl);
    return this.parseZoneTableHttp(r3.html, baseUrl, zUrl, onProgress);
  }

  private async parseZoneTableHttp(html: string, baseUrl: string, refererUrl: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    const $ = cheerio.load(html);
    const details: TicketZone[] = [];
    const hotZones: { idx: number; name: string; url: string }[] = [];
    let total_unsold = 0;

    $('table.table tbody tr').each((_, el) => {
      const name = $(el).find('td[data-title="票區"]').text().trim();
      const status = $(el).find('td[data-title="空位"] span').text().trim();
      const disabled = $(el).hasClass('disabled');
      if (!name) return;

      if (/^\d+$/.test(status)) { const u = parseInt(status); total_unsold += u; details.push({ zone: name, unsold: u, sold: -1, total: -1 }); return; }
      if (disabled || status === '已售完') { details.push({ zone: name, unsold: 0, sold: -1, total: -1, error: '已售完' }); return; }
      if (status === '熱賣中' || status === '') {
        const act = $(el).attr('onclick') || '';
        let parts: RegExpMatchArray | null = act.match(/['"]0205['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/);
        if (!parts) {
          const pid = act.match(/PERFORMANCE_ID=([^&'"]+)/i);
          const gid = act.match(/GROUP_ID=([^&'"]+)/i);
          const paid = act.match(/PERFORMANCE_PRICE_AREA_ID=([^&'"]+)/i);
          if (pid && gid && paid) parts = ['', paid[1], pid[1], gid[1]] as any;
        }
        if (parts) hotZones.push({ idx: details.length, name, url: `application/UTK02/UTK0205_000.aspx?PERFORMANCE_ID=${parts[2]}&GROUP_ID=${parts[3]}&PERFORMANCE_PRICE_AREA_ID=${parts[1]}` });
        details.push({ zone: name, unsold: 0, sold: -1, total: -1, error: name.includes('輪椅') ? '無座位圖連結' : undefined });
      } else details.push({ zone: name, unsold: 0, sold: -1, total: -1 });
    });
    if (!details.length) throw new Error('No zone data');

    if (hotZones.length && onProgress) onProgress(`正在讀取 ${hotZones.length} 個熱賣中分區...`);
    for (const tz of hotZones) {
      if (onProgress) onProgress(`讀取分區: ${tz.name}...`);
      let u = 0, s = 0, err: string | undefined;
      for (let r = 0; r < 3; r++) {
        try {
          const res = await fetch(new URL(tz.url, baseUrl).href, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': refererUrl } });
          const $s = cheerio.load(await res.text());
          u = $s('.seat-icon-empyt').length;
          s = $s('.seat-icon-sold').length;
          break;
        } catch (e: any) { err = e.message; await new Promise(r => setTimeout(r, 2000)); }
      }
      total_unsold += u;
      details[tz.idx].unsold = u;
      details[tz.idx].sold = s;
      details[tz.idx].total = u + s;
      if (err && !u && !s) details[tz.idx].error = err;
      await new Promise(r => setTimeout(r, 800));
    }

    let sum_s = 0, sum_c = 0;
    details.forEach(d => {
      if (d.sold !== undefined && d.sold >= 0) { sum_s += d.sold; sum_c += (d.unsold || 0) + d.sold; }
      else sum_c += d.unsold || 0;
    });
    return { total_unsold, total_sold: sum_s, total_capacity: sum_c, details };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Browser approach (CloakBrowser + Playwright)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Flow:
  //   1. Navigate to UTK0201 → CloakBrowser bypasses Cloudflare
  //   2. Extract embedded jsonData from the page HTML (no DOM clicking needed)
  //   3. Parse zones from JSON: name, status (熱賣中/已售完/number), areaId, groupIds
  //   4. For zones with numeric status: just count the number
  //   5. For 熱賣中 zones: navigate to UTK0205 seat map → count seat-icon-empyt → goBack()

  private async getTicketsViaBrowser(performanceId: string, productId: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    const cb = await getCloakBrowser();
const browser = await cb.launch({ headless: true });
    const page = await browser.newPage();
    const ordersBase = 'https://orders.ibon.com.tw/';

    try {
      if (onProgress) onProgress('正在透過瀏覽器連線...');

      // ── 1. UTK0201 + CF bypass ──────────────────────────────────────
      const utk0201Url = `${ordersBase}application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${productId}`;
      console.log(`Navigating to UTK0201: ${utk0201Url}`);
      await page.goto(utk0201Url, { waitUntil: 'load', timeout: 120000 });

      console.log('Waiting for Cloudflare bypass...');
      let cfPassed = false;
      for (let i = 0; i < 60; i++) {
        const t = await page.evaluate(() => document.title).catch(() => '');
        const f = await page.evaluate(() => !!document.querySelector('#aspnetForm')).catch(() => false);
        if (f || t === 'ibon售票系統') { cfPassed = true; console.log(`✅ CF passed! title="${t}"`); break; }
        if (i % 4 === 0) console.log(`  ⏳ (${(i+1)*5+5}s)`);
        await new Promise(r => setTimeout(r, 5000));
      }
      if (!cfPassed) throw new Error('CF challenge persisted');

      // ── 2. Extract jsonData from page HTML ───────────────────────────
      const html = await page.content();
      const jsonMatch = html.match(/const\s+jsonData\s*=\s*'(.*?)(?<!\\)'\s*;/s);
      if (!jsonMatch || !jsonMatch[1]) {
        // Debug: look for jsonData pattern in HTML
        const idx = html.indexOf('jsonData');
        if (idx >= 0) {
          console.log('found "jsonData" at position', idx, 'surrounding:', html.substring(Math.max(0, idx - 50), idx + 200));
        } else {
          console.log('"jsonData" not found in HTML. Body text:', (await page.evaluate(() => document.body?.innerText || '')).substring(0, 300));
        }
        throw new Error('Could not find jsonData in page HTML');
      }
      const jsonStr = jsonMatch[1].replace(/\\'/g, "'"); // unescape single quotes
      console.log('Extracted jsonData, parsing...');
      const zoneData: Array<{
        PERFORMANCE_PRICE_AREA_ID: string;
        GROUP_ID: string;
        NAME: string;
        PRICE: number;
        AMOUNT: string;
        BACKGROUND_COLOR?: string;  // "disabled" means sold out
      }> = JSON.parse(jsonStr);

      console.log(`Found ${zoneData.length} zones from jsonData`);

      // ── 3. Process each zone ────────────────────────────────────────
      const details: TicketZone[] = [];
      let total_unsold = 0;

      for (const z of zoneData) {
        const zoneName = z.NAME;
        const status = z.AMOUNT;
        const isDisabled = z.BACKGROUND_COLOR === 'disabled' || status === '已售完';
        const areaId = z.PERFORMANCE_PRICE_AREA_ID;
        // GROUP_ID can be space-separated (e.g. "a103 a115"), strip "a" prefix from each
        const groupIds = z.GROUP_ID.split(' ').map(g => g.replace(/^a/, ''));

        if (isDisabled) {
          details.push({ zone: zoneName, unsold: 0, sold: -1, total: -1, error: '已售完' });
          continue;
        }

        const isNumeric = /^\d+$/.test(status);
        const needsSeatMap = isNumeric || status === '熱賣中';

        if (needsSeatMap) {
          const tableUnsold = isNumeric ? parseInt(status) : 0;
          if (onProgress) onProgress(`讀取分區: ${zoneName}...`);
          console.log(`\n🖱️ Fetching seat map for "${zoneName}" (status="${status}")...`);
          let u = 0, s = 0, err: string | undefined;

          // Navigate to UTK0205 — only first groupId needed (multi-group zones share the same seat page)
          const gid = groupIds[0];
          const seatUrl = `${ordersBase}application/UTK02/UTK0205_.aspx?PERFORMANCE_ID=${performanceId}&GROUP_ID=${gid}&PERFORMANCE_PRICE_AREA_ID=${areaId}`;
          try {
            console.log(`  Navigating to UTK0205: GROUP_ID=${gid}`);
            await page.goto(seatUrl, { waitUntil: 'load', timeout: 60000 });
            await new Promise(r => setTimeout(r, 3000));

            // Handle possible queue
            for (let w = 0; w < 30; w++) {
              const q = await page.evaluate(() => (document.body?.innerText || '').includes('購票人數眾多')).catch(() => false);
              if (!q) break;
              if (w % 5 === 0) console.log(`    ⏳ Queue (${w*2}s)...`);
              await new Promise(r => setTimeout(r, 2000));
            }

            // Try both selector variants: ibon uses .seat-icon-empyt, utiki uses .seat-empty / .seat-people
            const sr = await page.evaluate(() => ({
              unsold: document.querySelectorAll('.seat-icon-empyt, .seat-empty').length,
              sold: document.querySelectorAll('.seat-icon-sold, .seat-people').length,
            })).catch(() => ({ unsold: 0, sold: 0 }));

            u = sr.unsold || tableUnsold; // fallback to table number if seat map gives 0
            s = sr.sold;
            console.log(`    🪑 ${zoneName}: empty=${u} sold=${s}`);
          } catch (e: any) {
            err = e.message;
            u = tableUnsold; // keep table count on error
            console.log(`    ⚠️ ${e.message}`);
          }

          total_unsold += u;
          // Go back to UTK0201 for next zone navigation
          await page.goto(utk0201Url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 2000));

          details.push({ zone: zoneName, unsold: u, sold: s, total: u + s, error: err && !u && !s ? err : undefined });
          continue;
        }
        details.push({ zone: zoneName, unsold: 0, sold: -1, total: -1 });
      }

      let sum_s = 0, sum_c = 0;
      details.forEach(d => {
        if (d.sold !== undefined && d.sold >= 0) { sum_s += d.sold; sum_c += (d.unsold || 0) + d.sold; }
        else sum_c += d.unsold || 0;
      });
      console.log(`\n✅ Complete! ${details.length} zones, unsold=${total_unsold} sold=${sum_s}`);
      return { total_unsold, total_sold: sum_s, total_capacity: sum_c, details };

    } catch (error) {
      console.error('Browser scraping failed:', error);
      throw error;
    } finally {
      await browser.close();
      console.log('🟢 Browser closed');
    }
  }
}
