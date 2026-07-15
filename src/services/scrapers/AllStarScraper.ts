import { ITicketScraper, GameLink, TicketInfo, TicketZone } from './ITicketScraper.js';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { launchIbonBrowser, warmupIbonBrowser, waitForCfBypass, isCfChallengePage, waitForCfClear, getCachedGames, setCachedGames } from './IbonBrowser.js';

type SeatMapEntry = [string, number, number];

export class AllStarScraper implements ITicketScraper {
  private baseUrl = 'https://ticket.ibon.com.tw';
  private ordersBaseUrl = 'https://orders.ibon.com.tw';
  private domeSeatMap: Map<string, number>;

  constructor() {
    this.domeSeatMap = this.loadDomeSeatMap();
  }

  private loadDomeSeatMap(): Map<string, number> {
    const map = new Map<string, number>();
    try {
      const jsonPath = path.resolve(process.cwd(), '大巨蛋座位.json');
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const entries: SeatMapEntry[] = JSON.parse(raw);
      for (const [floor, zoneNum, capacity] of entries) {
        map.set(`${floor}-${zoneNum}`, capacity);
      }
    } catch {}
    return map;
  }

  private extractFloorZone(zoneName: string): { floor: string; zoneNum: number } | null {
    const floorMatch = zoneName.match(/(B1|L2|L4|L5)/i);
    const zoneMatch = zoneName.match(/(\d+)\s*區/);
    if (!floorMatch || !zoneMatch) return null;
    return { floor: floorMatch[1].toUpperCase(), zoneNum: parseInt(zoneMatch[1], 10) };
  }

  private patchDomeCapacity(details: TicketZone[]): void {
    const blockMap = new Map<string, { knownTotal: number; missingIndices: number[] }>();
    details.forEach((d, index) => {
      const fz = this.extractFloorZone(d.zone);
      if (!fz) return;
      const key = `${fz.floor}-${fz.zoneNum}`;
      if (!blockMap.has(key)) blockMap.set(key, { knownTotal: 0, missingIndices: [] });
      const block = blockMap.get(key)!;
      if (d.sold !== undefined && d.sold >= 0) {
        block.knownTotal += (d.unsold || 0) + d.sold;
      } else {
        block.missingIndices.push(index);
      }
    });
    for (const [key, block] of blockMap.entries()) {
      const capacity = this.domeSeatMap.get(key);
      if (capacity === undefined) continue;
      if (block.missingIndices.length > 0) {
        const remainingCapacity = Math.max(0, capacity - block.knownTotal);
        block.missingIndices.forEach((detailIndex, i) => {
          const d = details[detailIndex];
          if (i === 0) {
            d.sold = Math.max(0, remainingCapacity - (d.unsold || 0));
            d.total = remainingCapacity;
          } else {
            d.sold = -1; d.total = -1;
          }
        });
      }
    }
  }

  // ─── Browser helpers ─────────────────────────────────────────
  private get userDataDir(): string {
    return path.resolve(process.cwd(), 'browser_data_allstar');
  }

  // ─── getGames (瀏覽器模式 — ticket.ibon.com.tw 阻擋純 HTTP) ──
  async getGames(): Promise<GameLink[]> {
    const cached = getCachedGames('allstar');
    if (cached) { console.log('使用快取的職棒明星賽場次清單'); return cached; }

    const ACTIVITY_URL = 'https://ticket.ibon.com.tw/ActivityInfo/Details/39701';
    console.log('Fetching All-Star Game games via browser...');
    let headless = true;
    let { context, page } = await launchIbonBrowser({ userDataDir: this.userDataDir, headless });

    let apiResponse: string | null = null;
    const responseHandler = async (resp: any) => {
      if (resp.url().includes('/api/ActivityInfo/GetGameInfoList')) {
        try { apiResponse = await resp.text(); console.log('API response intercepted'); }
        catch (e) {}
      }
    };
    page.on('response', responseHandler);

    try {
      await warmupIbonBrowser(page, ACTIVITY_URL);
      await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));

      if (!apiResponse && await isCfChallengePage(page)) {
        console.log('⚠️ Headless 模式遭遇驗證頁，改用有視窗模式讓使用者手動驗證...');
        page.removeListener('response', responseHandler);
        await context.close().catch(() => {});
        headless = false;
        ({ context, page } = await launchIbonBrowser({ userDataDir: this.userDataDir, headless }));
        page.on('response', responseHandler);
        await warmupIbonBrowser(page, ACTIVITY_URL);
        await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await waitForCfClear(page, 180);
        await new Promise(r => setTimeout(r, 5000));
      }

      if (!apiResponse) { console.log('Waiting for API...'); await new Promise(r => setTimeout(r, 5000)); }
      if (apiResponse) {
        const games = this.parseGamesFromApi(apiResponse);
        if (games.length > 0) {
          console.log(`Found ${games.length} games.`);
          setCachedGames('allstar', games);
          return games;
        }
      }
      throw new Error('Could not fetch games');
    } catch (error) {
      console.error('Error fetching All-Star Game games:', error);
      throw error;
    } finally {
      page.removeListener('response', responseHandler);
      await context.close().catch(() => {});
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
        games.push({ title: `${date} ${matchup} @ ${venue}`, link: ordersUrl || href });
      }
    } catch {}
    return games;
  }

  async getTickets(gameUrlStr: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    console.log(`Scraping AllStar tickets for: ${gameUrlStr}`);
    const parsedUrl = new URL(gameUrlStr);
    const performanceId = parsedUrl.searchParams.get('PERFORMANCE_ID');
    const productId = parsedUrl.searchParams.get('PRODUCT_ID');
    if (!performanceId || !productId) throw new Error('Missing IDs');
    if (onProgress) onProgress('正在嘗試 HTTP 方式讀取...');
    try { return await this.getTicketsViaHttp(performanceId, productId, onProgress); }
    catch {
      if (onProgress) onProgress('HTTP 方式失敗，嘗試瀏覽器方式...');
      return this.getTicketsViaBrowser(performanceId, productId, onProgress);
    }
  }

  private async getTicketsViaHttp(performanceId: string, productId: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    const baseUrl = 'https://orders.ibon.com.tw/';
    const cookies = new Map<string, string>();
    let reqVer = '', auth = '';
    const fetchHtml = async (url: string, referer?: string, asAjax?: boolean) => {
      const opts: any = {
        headers: { Cookie: [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '), 'User-Agent': 'Mozilla/5.0' },
        redirect: 'manual',
      };
      if (referer) opts.headers['Referer'] = new URL(referer, baseUrl).href;
      if (asAjax) { opts.headers['X-Requested-With'] = 'XMLHttpRequest'; if (reqVer) opts.headers['RequestVerificationToken'] = reqVer; if (auth) opts.headers['Authorization'] = auth; }
      for (let retry = 0; retry < 3; retry++) {
        const res = await fetch(new URL(url, baseUrl).href, opts);
        (res.headers.getSetCookie?.() || []).forEach((c: string) => { const [k, v] = c.split(';')[0].split('='); if (k && v) cookies.set(k, v); });
        const html = await res.text();
        if (html.includes('網站有異常情況') || html.includes('驗證') || res.status >= 403) { await new Promise(r => setTimeout(r, 2000)); continue; }
        return html;
      }
      throw new Error('WAF block');
    };
    await fetchHtml('application/UTK02/UTK0201_000.aspx');
    const ordersUrl = `application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${productId}`;
    const r1 = await fetchHtml(ordersUrl, 'application/UTK02/UTK0201_000.aspx');
    const $1 = cheerio.load(r1);
    if ($1('body').text().includes('驗證')) throw new Error('CF fallback');
    reqVer = $1('input[name="__RequestVerificationToken"]').attr('value') || '';
    auth = $1('input[name="__JWtToken"]').attr('value') || '';
    const pRes = await fetchHtml(`application/UTK02/UTK0201_000.aspx/PerformanceListControl?PRODUCT_ID=${productId}`, ordersUrl, true);
    let pid = performanceId;
    const m = pRes.match(/PERFORMANCE_ID=([A-Z0-9]+)/);
    if (m) pid = m[1];
    const zUrl = `application/UTK02/UTK0204_000.aspx?PERFORMANCE_ID=${pid}&PRODUCT_ID=${productId}`;
    const r3 = await fetchHtml(zUrl, ordersUrl);
    return this.parseZoneTableHttp(r3, baseUrl, zUrl, onProgress);
  }

  private async parseZoneTableHttp(html: string, baseUrl: string, refererUrl: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    const $ = cheerio.load(html);
    const details: TicketZone[] = [];
    const hotZones: { idx: number; name: string; url: string }[] = [];
    let total_unsold = 0;
    $('table.table tbody tr').each((_, el) => {
      const name = $(el).find('td[data-title="票區"]').text().trim();
      const status = $(el).find('td[data-title="空位"] span').text().trim();
      if (!name) return;
      if (/^\d+$/.test(status)) { const u = parseInt(status); total_unsold += u; details.push({ zone: name, unsold: u, sold: -1, total: -1 }); return; }
      if ($(el).hasClass('disabled') || status === '已售完') { details.push({ zone: name, unsold: 0, sold: -1, total: -1, error: '已售完' }); return; }
      if (status === '熱賣中' || status === '') {
        const act = $(el).attr('onclick') || '';
        let parts = act.match(/['"]0205['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/);
        if (!parts) { const pid = act.match(/PERFORMANCE_ID=([^&'"]+)/i); const gid = act.match(/GROUP_ID=([^&'"]+)/i); const paid = act.match(/PERFORMANCE_PRICE_AREA_ID=([^&'"]+)/i); if (pid && gid && paid) parts = ['', paid[1], pid[1], gid[1]] as any; }
        if (parts) hotZones.push({ idx: details.length, name, url: `application/UTK02/UTK0205_000.aspx?PERFORMANCE_ID=${parts[2]}&GROUP_ID=${parts[3]}&PERFORMANCE_PRICE_AREA_ID=${parts[1]}` });
        details.push({ zone: name, unsold: 0, sold: -1, total: -1 });
      } else details.push({ zone: name, unsold: 0, sold: -1, total: -1 });
    });
    for (const tz of hotZones) {
      let u = 0, s = 0;
      for (let r = 0; r < 3; r++) {
        try {
          const res = await fetch(new URL(tz.url, baseUrl).href, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': refererUrl } });
          const $s = cheerio.load(await res.text());
          u = $s('.seat-icon-empyt').length; s = $s('.seat-icon-sold').length; break;
        } catch { await new Promise(r => setTimeout(r, 2000)); }
      }
      total_unsold += u; details[tz.idx].unsold = u; details[tz.idx].sold = s; details[tz.idx].total = u + s;
      await new Promise(r => setTimeout(r, 800));
    }
    this.patchDomeCapacity(details);
    let sum_s = 0, sum_c = 0;
    details.forEach(d => { if (d.sold !== undefined && d.sold >= 0) { sum_s += d.sold; sum_c += (d.unsold || 0) + d.sold; } else sum_c += d.unsold || 0; });
    return { total_unsold, total_sold: sum_s, total_capacity: sum_c, details };
  }

  private async getTicketsViaBrowser(performanceId: string, productId: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    const { context, page } = await launchIbonBrowser({ userDataDir: this.userDataDir });
    await warmupIbonBrowser(page);
    const ordersBase = 'https://orders.ibon.com.tw/';
    try {
      const utk0201Url = `${ordersBase}application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${productId}`;
      let cfPassed = false;
      for (let navRetry = 0; navRetry < 3 && !cfPassed; navRetry++) {
        if (navRetry > 0) {
          try { await page.goto('https://ticket.ibon.com.tw', { waitUntil: 'domcontentloaded', timeout: 45000 }); await new Promise(r => setTimeout(r, 4000)); } catch (_) {}
        }
        await page.goto(utk0201Url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 5000));
        cfPassed = await waitForCfBypass(page, 180);
        if (cfPassed) break;
      }
      if (!cfPassed) throw new Error('CF persisted');

      let zoneData: any[] = [];
      try {
        const jsZoneData = await page.evaluate(() => {
          const w = window as any;
          return w.jsonData && Array.isArray(w.jsonData) ? JSON.stringify(w.jsonData) : null;
        });
        if (jsZoneData) zoneData = JSON.parse(jsZoneData);
      } catch {}
      if (!zoneData.length) {
        const html = await page.content();
        const m = html.match(/const\s+jsonData\s*=\s*'([\s\S]*?)(?<!\\)'\s*;/);
        if (m) { try { zoneData = JSON.parse(m[1].replace(/\\'/g, "'")); } catch {} }
        if (!zoneData.length) return await this.parseZoneTableFromBrowser(page, utk0201Url, performanceId, productId, ordersBase);
      }

      const details: TicketZone[] = [];
      let total_unsold = 0;
      for (const z of zoneData) {
        const zn = z.NAME; const st = z.AMOUNT;
        const disabled = z.BACKGROUND_COLOR === 'disabled' || st === '已售完';
        const areaId = z.PERFORMANCE_PRICE_AREA_ID;
        const gids = z.GROUP_ID.split(' ').map((g: string) => g.replace(/^a/, ''));
        if (disabled) { details.push({ zone: zn, unsold: 0, sold: -1, total: -1, error: '已售完' }); continue; }
        if (/^\d+$/.test(st) || st === '熱賣中') {
          const tu = /^\d+$/.test(st) ? parseInt(st) : 0;
          if (zn.includes('輪椅')) { details.push({ zone: zn, unsold: tu, sold: -1, total: -1 }); continue; }
          let u = 0, s = 0;
          try {
            const seatUrl = `${ordersBase}application/UTK02/UTK0205_.aspx?PERFORMANCE_ID=${performanceId}&GROUP_ID=${gids[0]}&PERFORMANCE_PRICE_AREA_ID=${areaId}`;
            await page.goto(seatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await new Promise(r => setTimeout(r, 3000));
            const sr = await page.evaluate(() => ({
              unsold: document.querySelectorAll('.seat-icon-empyt, .seat-empty').length,
              sold: document.querySelectorAll('.seat-icon-sold, .seat-people').length,
            })).catch(() => ({ unsold: 0, sold: 0 }));
            u = sr.unsold || tu; s = sr.sold;
          } catch { u = tu; }
          total_unsold += u;
          await page.goto(utk0201Url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 2000));
          details.push({ zone: zn, unsold: u, sold: s, total: u + s });
          continue;
        }
        details.push({ zone: zn, unsold: 0, sold: -1, total: -1 });
      }
      this.patchDomeCapacity(details);
      let sum_s = 0, sum_c = 0;
      details.forEach(d => { if (d.sold !== undefined && d.sold >= 0) { sum_s += d.sold; sum_c += (d.unsold || 0) + d.sold; } else sum_c += d.unsold || 0; });
      return { total_unsold, total_sold: sum_s, total_capacity: sum_c, details };
    } catch (e) { console.error(e); throw e; }
    finally { await context.close(); }
  }

  private async parseZoneTableFromBrowser(page: any, utk0201Url: string, performanceId: string, productId: string, ordersBase: string): Promise<TicketInfo> {
    const rows = await page.evaluate(() => {
      const r: any[] = [];
      document.querySelectorAll('table.table tbody tr, tr').forEach((tr: any) => {
        const name = (tr.querySelector('[data-title="票區"], td:first-child')?.textContent || '').trim();
        const status = (tr.querySelector('[data-title="空位"] span, [data-title="空位"], td:nth-child(3)')?.textContent || '').trim();
        if (!name) return;
        r.push({ name, status, disabled: tr.classList.contains('disabled'), onclick: tr.getAttribute('onclick') || '' });
      });
      return r;
    });
    const details: TicketZone[] = [];
    let total_unsold = 0;
    const tasks: any[] = [];
    for (const row of rows) {
      if (/^\d+$/.test(row.status)) { const u = parseInt(row.status); total_unsold += u; details.push({ zone: row.name, unsold: u, sold: -1, total: -1 }); continue; }
      if (row.disabled || row.status === '已售完') { details.push({ zone: row.name, unsold: 0, sold: -1, total: -1, error: '已售完' }); continue; }
      if (row.status === '熱賣中' || row.status === '') {
        const pid = row.onclick.match(/PERFORMANCE_ID=([^&'"]+)/i); const gid = row.onclick.match(/GROUP_ID=([^&'"]+)/i); const paid = row.onclick.match(/PERFORMANCE_PRICE_AREA_ID=([^&'"]+)/i);
        if (pid && gid && paid && !row.name.includes('輪椅')) { tasks.push({ idx: details.length, areaId: paid[1], groupId: gid[1] }); details.push({ zone: row.name, unsold: 0, sold: -1, total: -1 }); }
        else { details.push({ zone: row.name, unsold: 0, sold: -1, total: -1 }); }
        continue;
      }
      details.push({ zone: row.name, unsold: 0, sold: -1, total: -1 });
    }
    for (const t of tasks) {
      let u = 0, s = 0;
      try {
        const seatUrl = `${ordersBase}application/UTK02/UTK0205_.aspx?PERFORMANCE_ID=${performanceId}&GROUP_ID=${t.groupId}&PERFORMANCE_PRICE_AREA_ID=${t.areaId}`;
        await page.goto(seatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));
        const sr = await page.evaluate(() => ({ unsold: document.querySelectorAll('.seat-icon-empyt, .seat-empty').length, sold: document.querySelectorAll('.seat-icon-sold, .seat-people').length })).catch(() => ({ unsold: 0, sold: 0 }));
        u = sr.unsold; s = sr.sold;
      } catch {}
      total_unsold += u; details[t.idx].unsold = u; details[t.idx].sold = s; details[t.idx].total = u + s;
      await page.goto(utk0201Url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    }
    this.patchDomeCapacity(details);
    let sum_s = 0, sum_c = 0;
    details.forEach(d => { if (d.sold !== undefined && d.sold >= 0) { sum_s += d.sold; sum_c += (d.unsold || 0) + d.sold; } else sum_c += d.unsold || 0; });
    return { total_unsold, total_sold: sum_s, total_capacity: sum_c, details };
  }
}