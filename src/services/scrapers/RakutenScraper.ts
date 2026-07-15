import { ITicketScraper, GameLink, TicketInfo, TicketZone } from './ITicketScraper.js';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { launchIbonBrowser, warmupIbonBrowser, waitForCfBypass, isCfChallengePage, waitForCfClear, getCachedGames, setCachedGames } from './IbonBrowser.js';

type SeatMapEntry = [string, number, number];

export class RakutenScraper implements ITicketScraper {
  private baseUrl = 'https://ticket.ibon.com.tw';
  private ordersBaseUrl = 'https://orders.ibon.com.tw';
  private domeSeatMap: Map<string, number>;

  constructor() {
    this.domeSeatMap = this.loadDomeSeatMap();
  }

  // ─── Dome Seat Map Loader & Patcher ──────────────────────────────────
  private loadDomeSeatMap(): Map<string, number> {
    const map = new Map<string, number>();
    try {
      const jsonPath = path.resolve(process.cwd(), '大巨蛋座位.json');
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const entries: SeatMapEntry[] = JSON.parse(raw);
      for (const [floor, zoneNum, capacity] of entries) {
        const key = `${floor}-${zoneNum}`;
        map.set(key, capacity);
      }
      console.log(`Loaded ${map.size} dome seat entries from 大巨蛋座位.json`);
    } catch (e) {
      console.warn('無法載入大巨蛋座位.json，已售完分區將顯示 N/A:', (e as Error).message);
    }
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
            if (d.error) d.error += ' (自動補齊同區剩餘總數)';
            else d.error = '(自動補齊同區剩餘總數)';
            console.log(`  [大巨蛋補齊] ${d.zone} -> 剩餘容量 ${remainingCapacity} 分配至此區`);
          } else {
            d.sold = -1; d.total = -1;
            if (d.error) d.error += ' (容量已併入同區)';
            else d.error = '(容量已併入同區)';
            console.log(`  [大巨蛋補齊] ${d.zone} -> 容量已併入同區`);
          }
        });
      }
    }
  }

  // ─── Browser helpers ─────────────────────────────────────────
  // Chrome profile 自動存在系統暫存區，避免 Vite 熱重載

  // ─── getGames (瀏覽器模式 — ticket.ibon.com.tw 阻擋純 HTTP) ──
  async getGames(): Promise<GameLink[]> {
    const cached = getCachedGames('rakuten');
    if (cached) { console.log('使用快取的樂天場次清單'); return cached; }

    const ACTIVITY_URL = 'https://ticket.ibon.com.tw/ActivityInfo/Details/39689';
    console.log('Fetching Rakuten games via browser...');
    let headless = true;
    let { context, page } = await launchIbonBrowser({ team: 'rakuten', headless });

    let apiResponse: string | null = null;
    const responseHandler = async (resp: any) => {
      const url = resp.url();
      if (url.includes('/api/ActivityInfo/GetGameInfoList')) {
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
        ({ context, page } = await launchIbonBrowser({ team: 'rakuten', headless }));
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
          setCachedGames('rakuten', games);
          return games;
        }
      }
      throw new Error('Could not fetch games');
    } catch (error) {
      console.error('Error fetching Rakuten games:', error);
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
        const fullUrl = ordersUrl || (href.startsWith('http') ? href : `${this.baseUrl}${href}`);
        games.push({ title: `${date} ${matchup} @ ${venue}`, link: fullUrl });
      }
    } catch (e) { console.error('Failed to parse API response:', e); }
    return games;
  }

  // ─── getTickets ────────────────────────────────────────────────────
  async getTickets(gameUrlStr: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    console.log(`Scraping Rakuten tickets for: ${gameUrlStr}`);
    const parsedUrl = new URL(gameUrlStr);
    const performanceId = parsedUrl.searchParams.get('PERFORMANCE_ID');
    const productId = parsedUrl.searchParams.get('PRODUCT_ID');
    if (!performanceId || !productId) throw new Error('Missing PERFORMANCE_ID or PRODUCT_ID in URL');
    if (onProgress) onProgress('正在嘗試 HTTP 方式讀取...');
    try { return await this.getTicketsViaHttp(performanceId, productId, onProgress); }
    catch (httpError: any) {
      console.log('HTTP approach failed:', httpError.message);
      if (onProgress) onProgress('HTTP 方式失敗，嘗試瀏覽器方式...');
      return this.getTicketsViaBrowser(performanceId, productId, onProgress);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  HTTP approach
  // ══════════════════════════════════════════════════════════════════
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
        }, redirect: 'manual',
      };
      if (referer) opts.headers['Referer'] = new URL(referer, baseUrl).href;
      if (asAjax) { opts.headers['X-Requested-With'] = 'XMLHttpRequest'; if (reqVer) opts.headers['RequestVerificationToken'] = reqVer; if (auth) opts.headers['Authorization'] = auth; }
      for (let retry = 0; retry < 3; retry++) {
        const res = await fetch(new URL(url, baseUrl).href, opts);
        (res.headers.getSetCookie() || []).forEach((c: string) => { const [k, v] = c.split(';')[0].split('='); if (k && v !== undefined) cookies.set(k, v); });
        const html = await res.text();
        if (html.includes('網站有異常情況') || html.includes('驗證') || res.status === 403 || res.status === 503) {
          if (onProgress) onProgress(`系統攔截... 自動重試中 (${retry + 1}/3)...`);
          await new Promise(r => setTimeout(r, 2000)); continue;
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
        if (!parts) { const pid = act.match(/PERFORMANCE_ID=([^&'"]+)/i); const gid = act.match(/GROUP_ID=([^&'"]+)/i); const paid = act.match(/PERFORMANCE_PRICE_AREA_ID=([^&'"]+)/i); if (pid && gid && paid) parts = ['', paid[1], pid[1], gid[1]] as any; }
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
          u = $s('.seat-icon-empyt').length; s = $s('.seat-icon-sold').length; break;
        } catch (e: any) { err = e.message; await new Promise(r => setTimeout(r, 2000)); }
      }
      total_unsold += u; details[tz.idx].unsold = u; details[tz.idx].sold = s; details[tz.idx].total = u + s;
      if (err && !u && !s) details[tz.idx].error = err;
      await new Promise(r => setTimeout(r, 800));
    }
    this.patchDomeCapacity(details);
    let sum_s = 0, sum_c = 0;
    details.forEach(d => { if (d.sold !== undefined && d.sold >= 0) { sum_s += d.sold; sum_c += (d.unsold || 0) + d.sold; } else sum_c += d.unsold || 0; });
    return { total_unsold, total_sold: sum_s, total_capacity: sum_c, details };
  }

  // ══════════════════════════════════════════════════════════════════
  //  Browser approach
  // ══════════════════════════════════════════════════════════════════
  private async getTicketsViaBrowser(performanceId: string, productId: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    const { context, page } = await launchIbonBrowser({ team: 'rakuten' });
    await warmupIbonBrowser(page);
    const ordersBase = 'https://orders.ibon.com.tw/';
    try {
      if (onProgress) onProgress('正在透過瀏覽器連線...');
      const utk0201Url = `${ordersBase}application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=${performanceId}&PRODUCT_ID=${productId}`;
      console.log(`Navigating to UTK0201: ${utk0201Url}`);
      let cfPassed = false;
      for (let navRetry = 0; navRetry < 3 && !cfPassed; navRetry++) {
        if (navRetry > 0) {
          console.log(`  🔄 Retrying UTK0201 navigation (attempt ${navRetry + 1}/3)...`);
          try {
            await page.goto('https://ticket.ibon.com.tw', { waitUntil: 'domcontentloaded', timeout: 45000 });
            await new Promise(r => setTimeout(r, 4000));
          } catch (_) {}
        }
        await page.goto(utk0201Url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 5000));

        cfPassed = await waitForCfBypass(page, 180);
        if (cfPassed) break;
        console.log(`  ⚠️ CF wait exhausted for attempt ${navRetry + 1}`);
      }
      if (!cfPassed) throw new Error('CF challenge persisted');

      const actualGameTitle = await page.evaluate(() => {
        const timeEl = document.querySelector('#ctl00_ContentPlaceHolder1_PERFORMANCE_TXT');
        const nameEl = document.querySelector('#ctl00_ContentPlaceHolder1_PERFORMANCE_NANE');
        const time = timeEl ? timeEl.textContent?.trim() : '';
        const name = nameEl ? nameEl.textContent?.trim() : '';
        if (time || name) { return `${time} | ${name}`; }
        return document.title || '(無法取得標題)';
      });
      console.log(`[樂天桃猿爬蟲] 瀏覽器當前實際載入的場次為: ${actualGameTitle}`);

      let zoneData: Array<{ PERFORMANCE_PRICE_AREA_ID: string; GROUP_ID: string; NAME: string; PRICE: number; AMOUNT: string; BACKGROUND_COLOR?: string; }> = [];
      try {
        const jsZoneData = await page.evaluate(() => {
          const w = window as any;
          if (w.jsonData && Array.isArray(w.jsonData)) return JSON.stringify(w.jsonData);
          if (w.zoneData && Array.isArray(w.zoneData)) return JSON.stringify(w.zoneData);
          if (w.areaData && Array.isArray(w.areaData)) return JSON.stringify(w.areaData);
          return null;
        });
        if (jsZoneData) { zoneData = JSON.parse(jsZoneData); console.log(`Found ${zoneData.length} zones via window.jsonData eval`); }
      } catch (e: any) { console.log('page.evaluate jsonData failed:', e.message); }

      if (!zoneData.length) {
        const html = await page.content();
        const patterns = [
          /const\s+jsonData\s*=\s*'(.*?)(?<!\\)'\s*;/s, /var\s+jsonData\s*=\s*'(.*?)(?<!\\)'\s*;/s,
          /window\.jsonData\s*=\s*'(.*?)(?<!\\)'\s*;/s, /jsonData\s*=\s*'(.*?)(?<!\\)'\s*;/s,
          /const\s+jsonData\s*=\s*"(.*?)(?<!\\)"\s*;/s, /var\s+jsonData\s*=\s*"(.*?)(?<!\\)"\s*;/s,
          /jsonData\s*=\s*JSON\.parse\('(.*?)'\)/s, /jsonData\s*=\s*(\[[\s\S]*?\])\s*;/s,
          /\[\s*\{[^}]*PERFORMANCE_PRICE_AREA_ID[^}]*\}[\s\S]*?\][\s]*;?/,
        ];
        let matched = false;
        for (const pattern of patterns) {
          const jsonMatch = html.match(pattern);
          if (jsonMatch && jsonMatch[0]) {
            let candidate = '';
            if (pattern.source.includes('PERFORMANCE_PRICE_AREA_ID')) { candidate = jsonMatch[0].replace(/;\s*$/, '').trim(); }
            else if (jsonMatch[1]) { candidate = jsonMatch[1]; }
            if (candidate) {
              try {
                const cleaned = candidate.replace(/\\'/g, "'").replace(/\\"/g, '"');
                const parsed = JSON.parse(cleaned);
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].PERFORMANCE_PRICE_AREA_ID) {
                  zoneData = parsed; console.log(`Found ${zoneData.length} zones via regex pattern`); matched = true; break;
                }
              } catch (_) {}
            }
          }
        }
        if (!matched) {
          const scriptMatch = html.match(/<script[^>]*>([\s\S]*?(?:jsonData|zoneData|areaData)[\s\S]*?)<\/script>/i);
          if (scriptMatch) {
            const arrayMatch = scriptMatch[1].match(/(?:jsonData|zoneData|areaData)\s*=\s*(\[[\s\S]*?\])\s*;?/);
            if (arrayMatch && arrayMatch[1]) {
              try { zoneData = JSON.parse(arrayMatch[1]); console.log(`Found ${zoneData.length} zones via script tag extraction`); matched = true; }
              catch (_) {}
            }
          }
        }
        if (!matched) {
          console.log('jsonData extraction failed, falling back to DOM table parsing...');
          return await this.parseZoneTableFromBrowser(page, utk0201Url, performanceId, productId, ordersBase, onProgress);
        }
      }

      console.log(`Processing ${zoneData.length} zones from extracted data`);
      const details: TicketZone[] = [];
      let total_unsold = 0;
      for (const z of zoneData) {
        const zoneName = z.NAME;
        const status = z.AMOUNT;
        const isDisabled = z.BACKGROUND_COLOR === 'disabled' || status === '已售完';
        const areaId = z.PERFORMANCE_PRICE_AREA_ID;
        const groupIds = z.GROUP_ID.split(' ').map(g => g.replace(/^a/, ''));
        if (isDisabled) { details.push({ zone: zoneName, unsold: 0, sold: -1, total: -1, error: '已售完' }); continue; }
        const isNumeric = /^\d+$/.test(status);
        const needsSeatMap = isNumeric || status === '熱賣中';
        if (needsSeatMap) {
          const tableUnsold = isNumeric ? parseInt(status) : 0;
          if (zoneName.includes('輪椅')) { details.push({ zone: zoneName, unsold: tableUnsold, sold: -1, total: -1, error: '無座位圖' }); continue; }
          if (onProgress) onProgress(`讀取分區: ${zoneName}...`);
          console.log(`\n🖱️ Fetching seat map for "${zoneName}" (status="${status}")...`);
          let u = 0, s = 0, err: string | undefined;
          const gid = groupIds[0];
          const seatUrl = `${ordersBase}application/UTK02/UTK0205_.aspx?PERFORMANCE_ID=${performanceId}&GROUP_ID=${gid}&PERFORMANCE_PRICE_AREA_ID=${areaId}`;
          try {
            console.log(`  Navigating to UTK0205: GROUP_ID=${gid}`);
            await page.goto(seatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await new Promise(r => setTimeout(r, 3000));
            for (let w = 0; w < 30; w++) {
              const q = await page.evaluate(() => (document.body?.innerText || '').includes('購票人數眾多')).catch(() => false);
              if (!q) break; if (w % 5 === 0) console.log(`    ⏳ Queue (${w*2}s)...`);
              await new Promise(r => setTimeout(r, 2000));
            }
            const sr = await page.evaluate(() => ({
              unsold: document.querySelectorAll('.seat-icon-empyt, .seat-empty').length,
              sold: document.querySelectorAll('.seat-icon-sold, .seat-people').length,
            })).catch(() => ({ unsold: 0, sold: 0 }));
            u = sr.unsold || tableUnsold; s = sr.sold;
            console.log(`    🪑 ${zoneName}: empty=${u} sold=${s}`);
          } catch (e: any) { err = e.message; u = tableUnsold; console.log(`    ⚠️ ${e.message}`); }
          total_unsold += u;
          await page.goto(utk0201Url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 2000));
          details.push({ zone: zoneName, unsold: u, sold: s, total: u + s, error: err && !u && !s ? err : undefined });
          continue;
        }
        details.push({ zone: zoneName, unsold: 0, sold: -1, total: -1 });
      }
      this.patchDomeCapacity(details);
      let sum_s = 0, sum_c = 0;
      details.forEach(d => { if (d.sold !== undefined && d.sold >= 0) { sum_s += d.sold; sum_c += (d.unsold || 0) + d.sold; } else sum_c += d.unsold || 0; });
      console.log(`\n✅ Complete! ${details.length} zones, unsold=${total_unsold} sold=${sum_s}`);
      return { total_unsold, total_sold: sum_s, total_capacity: sum_c, details };
    } catch (error) {
      console.error('Browser scraping failed:', error);
      throw error;
    } finally { await context.close(); console.log('🟢 Browser closed'); }
  }

  // ══════════════════════════════════════════════════════════════════
  //  DOM-based table parsing fallback
  // ══════════════════════════════════════════════════════════════════
  private async parseZoneTableFromBrowser(page: any, utk0201Url: string, performanceId: string, productId: string, ordersBase: string, onProgress?: (msg: string) => void): Promise<TicketInfo> {
    console.log('Parsing zone table directly from browser DOM...');
    if (onProgress) onProgress('正在透過 DOM 解析票區表格...');
    const rows = await page.evaluate(() => {
      const results: Array<{ name: string; status: string; disabled: boolean; onclick: string; }> = [];
      const tables = document.querySelectorAll('table.table, table[class*="table"], table');
      for (const table of tables) {
        const trs = table.querySelectorAll('tbody tr, tr');
        for (const tr of trs) {
          const nameEl = tr.querySelector('[data-title="票區"], td:first-child');
          const statusEl = tr.querySelector('[data-title="空位"] span, [data-title="空位"], td:nth-child(3)');
          const name = (nameEl?.textContent || '').trim();
          const status = (statusEl?.textContent || '').trim();
          if (!name) continue;
          results.push({ name, status, disabled: tr.classList.contains('disabled'), onclick: tr.getAttribute('onclick') || '' });
        }
        if (results.length > 0) break;
      }
      return results;
    });
    console.log(`Found ${rows.length} zone rows from DOM`);
    if (!rows.length) throw new Error('No zone rows found in browser DOM table');
    const details: TicketZone[] = [];
    let total_unsold = 0;
    const seatMapTasks: Array<{ idx: number; areaId: string; groupId: string }> = [];
    for (const row of rows) {
      const { name, status, disabled } = row;
      if (/^\d+$/.test(status)) { const u = parseInt(status); total_unsold += u; details.push({ zone: name, unsold: u, sold: -1, total: -1 }); continue; }
      if (disabled || status === '已售完') { details.push({ zone: name, unsold: 0, sold: -1, total: -1, error: '已售完' }); continue; }
      if (status === '熱賣中' || status === '') {
        const act = row.onclick;
        const pid = act.match(/PERFORMANCE_ID=([^&'"]+)/i); const gid = act.match(/GROUP_ID=([^&'"]+)/i); const paid = act.match(/PERFORMANCE_PRICE_AREA_ID=([^&'"]+)/i);
        if (pid && gid && paid && !name.includes('輪椅')) { seatMapTasks.push({ idx: details.length, areaId: paid[1], groupId: gid[1] }); details.push({ zone: name, unsold: 0, sold: -1, total: -1 }); }
        else { details.push({ zone: name, unsold: 0, sold: -1, total: -1, error: name.includes('輪椅') ? '無座位圖連結' : undefined }); }
        continue;
      }
      details.push({ zone: name, unsold: 0, sold: -1, total: -1 });
    }
    if (seatMapTasks.length && onProgress) onProgress(`正在讀取 ${seatMapTasks.length} 個熱賣中分區...`);
    for (const task of seatMapTasks) {
      if (onProgress) onProgress(`讀取分區: ${details[task.idx].zone}...`);
      console.log(`\n🖱️ [DOM] Fetching seat map for "${details[task.idx].zone}"`);
      const seatUrl = `${ordersBase}application/UTK02/UTK0205_.aspx?PERFORMANCE_ID=${performanceId}&GROUP_ID=${task.groupId}&PERFORMANCE_PRICE_AREA_ID=${task.areaId}`;
      let u = 0, s = 0, err: string | undefined;
      try {
        console.log(`  Navigating to UTK0205: GROUP_ID=${task.groupId}`);
        await page.goto(seatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));
        for (let w = 0; w < 30; w++) {
          const q = await page.evaluate(() => (document.body?.innerText || '').includes('購票人數眾多')).catch(() => false);
          if (!q) break; if (w % 5 === 0) console.log(`    ⏳ Queue (${w*2}s)...`);
          await new Promise(r => setTimeout(r, 2000));
        }
        const sr = await page.evaluate(() => ({ unsold: document.querySelectorAll('.seat-icon-empyt, .seat-empty').length, sold: document.querySelectorAll('.seat-icon-sold, .seat-people').length, })).catch(() => ({ unsold: 0, sold: 0 }));
        u = sr.unsold; s = sr.sold; console.log(`    🪑 ${details[task.idx].zone}: empty=${u} sold=${s}`);
      } catch (e: any) { err = e.message; console.log(`    ⚠️ ${e.message}`); }
      total_unsold += u; details[task.idx].unsold = u; details[task.idx].sold = s; details[task.idx].total = u + s;
      if (err && !u && !s) details[task.idx].error = err;
      await page.goto(utk0201Url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    }
    this.patchDomeCapacity(details);
    let sum_s = 0, sum_c = 0;
    details.forEach(d => { if (d.sold !== undefined && d.sold >= 0) { sum_s += d.sold; sum_c += (d.unsold || 0) + d.sold; } else sum_c += d.unsold || 0; });
    console.log(`\n✅ [DOM] Complete! ${details.length} zones, unsold=${total_unsold} sold=${sum_s}`);
    return { total_unsold, total_sold: sum_s, total_capacity: sum_c, details };
  }
}