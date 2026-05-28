import express from 'express';
import path from 'path';
import fs from 'fs';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import { ScraperFactory } from './src/services/scrapers/ScraperFactory.js';
import { WeiChuanScraper } from './src/services/scrapers/WeiChuanScraper.js';

async function startServer() {
  const app = express();
  app.use(express.json());
  const PORT = 3000;

  // API Route: WeiChuan Captcha
  app.get('/api/weichuan/captcha', async (req, res) => {
    let maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const baseUrl = 'https://tix.wdragons.com/';
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-TW,zh;q=0.8,en-US;q=0.5,en;q=0.3',
            'Sec-Fetch-Dest': 'document', // usually required by bot protection
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        };
        
        const initRes = await fetch(new URL('UTK0102_', baseUrl), { headers });
        let cookies: string[] = [];
        if (typeof initRes.headers.getSetCookie === 'function') {
          cookies = initRes.headers.getSetCookie();
        }
        const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
        
        const html = await initRes.text();
        const $ = cheerio.load(html);
        
        const rvt = $('input[name="__RequestVerificationToken"]').val() as string || '';
        const jwt = $('input[name="__JWtToken"]').val() as string || '';
        
        // Fetch captcha image (ERA systems usually use CaptchaImage.aspx or similar)
        const captRes = await fetch(new URL(`/Home/pic?TYPE=UTK1306&ts=${Date.now()}`, baseUrl).href, {
            headers: { 
                ...headers,
                'Cookie': cookieStr,
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Sec-Fetch-Dest': 'image',
                'Sec-Fetch-Site': 'same-origin',
                'Referer': `${baseUrl}UTK0102_`
            }
        });
        // The exact Weichuan captcha URL might be 'MakeCaptchaCode' or something else.
        // We will read as arrayBuffer to convert to base64
        let buffer = await captRes.arrayBuffer();
        let base64 = Buffer.from(buffer).toString('base64');
        
        let finalCookieStr = cookieStr;
        if (typeof captRes.headers.getSetCookie === 'function') {
           const captCookies = captRes.headers.getSetCookie();
           if (captCookies.length > 0) {
              finalCookieStr = finalCookieStr + '; ' + captCookies.map(c => c.split(';')[0]).join('; ');
           }
        }
        
        // If it fails to return an image, we provide a placeholder
        if (!captRes.headers.get('content-type')?.toLowerCase().includes('image')) {
            console.error('Failed to load captcha. Status:', captRes.status, 'Content-Type:', captRes.headers.get('content-type'));
            base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAZdEVYdFNvZnR3YXJlAHBhaW50Lm5ldCA0LjAuMTnU1rJkAAAADUlEQVQYV2P4//8/AwAI/AL+X6BzIAAAAABJRU5ErkJggg=="; // 1x1 transparent
        }

        const sessionToken = Math.random().toString(36).substring(2, 15);
        WeiChuanScraper.cookieStore.set(sessionToken, finalCookieStr);

        return res.json({
          captchaBase64: `data:image/png;base64,${base64}`,
          sessionToken,
          _rvt: rvt,
          _jwt: jwt
        });

      } catch (e) {
        attempt++;
        const errStr = String(e);
        if (errStr.includes("售票系統異常") && attempt < maxRetries) {
           console.log(`Retrying captcha... (attempt ${attempt + 1})`);
           await new Promise(r => setTimeout(r, 2000));
           continue;
        }
        console.error(e);
        return res.status(500).json({ error: String(e) });
      }
    }
  });

  // API Route: WeiChuan Login
  app.post('/api/weichuan/login', async (req, res) => {
    try {
      const { username, password, captcha, sessionToken, _rvt, _jwt } = req.body;
      if (!sessionToken || !WeiChuanScraper.cookieStore.has(sessionToken)) {
         return res.status(401).json({ error: 'Session expired' });
      }
      let cookieStr = WeiChuanScraper.cookieStore.get(sessionToken) || '';
      
      console.log('--- LOGIN ATTEMPT ---');
      console.log('RVT:', _rvt);
      console.log('JWT:', _jwt);
      console.log('Cookie:', cookieStr);
      
      const loginParams = new URLSearchParams();
      loginParams.append('ACCOUNT', username);
      loginParams.append('PASSWORD', password);
      // Wait we need encodeURIComponent? URLSearchParams does it.
      loginParams.append('CHK', captcha);
      
      const loginRes = await fetch('https://tix.wdragons.com/Action/Login', {
         method: 'POST',
         headers: {
             'Accept': '*/*',
             'Accept-Language': 'zh-TW,zh;q=0.8,en-US;q=0.5,en;q=0.3',
             'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
             'Cookie': cookieStr,
             'Origin': 'https://tix.wdragons.com',
             'Referer': 'https://tix.wdragons.com/UTK0102_',
             'RequestVerificationToken': _rvt || '',
             'Authorization': _jwt || '',
             'X-Requested-With': 'XMLHttpRequest',
             'Sec-Fetch-Dest': 'empty',
             'Sec-Fetch-Mode': 'cors',
             'Sec-Fetch-Site': 'same-origin',
             'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
         },
         body: loginParams.toString(),
         redirect: 'manual'
      });

      let newCookies = [];
      if (typeof loginRes.headers.getSetCookie === 'function') {
         newCookies = loginRes.headers.getSetCookie();
      }
      
      const text = await loginRes.text();
      console.log('Login Status:', loginRes.status);
      console.log('Login Set-Cookies:', newCookies);
      console.log('Login Text:', text);
      
      if (loginRes.status === 302 || loginRes.status === 301 || text.includes('UTK') || text.includes('location.href') || text.includes('location.reload') || text.includes('GoBack') || !text.includes('alert')) {
         // Update cookies with new session details
         let allCookies = new Map<string, string>();
         cookieStr.split(';').forEach(c => {
             const [k, v] = c.trim().split('=');
             if (k && v) allCookies.set(k, v);
         });
         newCookies.forEach(c => {
             let pair = c.split(';')[0];
             let sepIdx = pair.indexOf('=');
             if (sepIdx !== -1) {
                 allCookies.set(pair.substring(0, sepIdx), pair.substring(sepIdx + 1));
             }
         });
         const finalCookieStr = Array.from(allCookies.entries()).map(([k,v])=>`${k}=${v}`).join('; ');
         WeiChuanScraper.cookieStore.set(sessionToken, finalCookieStr);

         res.json({ success: true, sessionToken });
      } else {
         // Login failed
         res.json({ success: false, error: 'Login failed, incorrect credentials or captcha' });
      }

    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e) });
    }
  });

  // API Route: Get Games for a specific platform
  app.get('/api/get_games/:platform', async (req, res) => {
    let maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const platform = req.params.platform;
        const scraper = ScraperFactory.getScraper(platform);
        const gameLinks = await scraper.getGames();
        return res.json({ games: gameLinks });
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries || !String(error).includes('售票系統異常')) {
          console.error('Error fetching games:', error);
          return res.status(500).json({ error: String(error) });
        }
        console.log(`Retrying get_games for ${req.params.platform}... (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  });

  // API Route: Get Tickets for a specific game on a specific platform
  app.get('/api/get_tickets/:platform', async (req, res) => {
    let gameUrlStr = req.query.url;
    const platform = req.params.platform;
    const sessionToken = req.query.sessionToken;

    if (!gameUrlStr || typeof gameUrlStr !== 'string') {
      return res.status(400).json({ error: 'Missing game url parameter.' });
    }
    
    console.log(`[server] /api/get_tickets/${platform} 收到請求, url="${gameUrlStr}"`);
    
    if (sessionToken && typeof sessionToken === 'string') {
        const u = new URL(gameUrlStr);
        u.searchParams.set('sessionToken', sessionToken);
        gameUrlStr = u.toString();
        console.log(`[server] 已附加 sessionToken, 最終 url="${gameUrlStr}"`);
    }
    
    // Check if client expects SSE
    const accept = req.headers.accept || '';
    if (accept.indexOf('text/event-stream') !== -1) {
        console.log(`[SSE] Client connected for ${platform} tickets. url:`, gameUrlStr);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        // Tell client to flush headers
        res.flushHeaders?.();
        
        // Send initial padding so that reverse proxies (like nginx) which buffer up to 4KB flush the headers.
        res.write(':' + ' '.repeat(4096) + '\n\n');

        const sendEvent = (type: string, data: any) => {
            console.log(`[SSE] Sending ${type} event:`, typeof data === 'object' ? JSON.stringify(data).substring(0, 50) + '...' : data);
            res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
            if (typeof (res as any).flush === 'function') {
                (res as any).flush();
            }
        };

        
        let maxRetries = 3;
        let attempt = 0;
        
        const runScrape = async () => {
            while (attempt < maxRetries) {
              try {
                const scraper = ScraperFactory.getScraper(platform);
                const ticketInfo = await scraper.getTickets(gameUrlStr, (msg) => {
                    sendEvent('progress', { message: msg });
                });
                sendEvent('complete', ticketInfo);
                res.end();
                return;
              } catch (error) {
                attempt++;
                const errStr = String(error);
                console.error(`[SSE] Error during scrape attempt ${attempt}:`, error);
                
                if (errStr.includes("售票系統異常") && attempt < maxRetries) {
                   console.log(`Retrying get_tickets for ${platform}... (attempt ${attempt + 1})`);
                   sendEvent('progress', { message: `系統攔截，正進行第 ${attempt + 1} 次重試...` });
                   await new Promise(r => setTimeout(r, 2000));
                   continue;
                }
        
                console.error('Error fetching tickets:', error);
                
                let errResponse = errStr;
                if (errStr.includes("UNAUTHORIZED")) {
                    errResponse = 'Session expired or not logged in';
                }
                if (errStr.includes("PERFORMANCE_ID")) {
                    errResponse = 'Could not fetch tickets from the ticketing system (Blocked by WAF/Cloudflare or structure changed).';
                }
                sendEvent('error', { error: errResponse, code: errStr.includes("UNAUTHORIZED") ? 401 : 500 });
                res.end();
                return;
              }
            }
        };
        runScrape();
        return;
    }

    // Default JSON fallback
    let maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const scraper = ScraperFactory.getScraper(platform);
        const ticketInfo = await scraper.getTickets(gameUrlStr);
        return res.json(ticketInfo);
      } catch (error) {
        attempt++;
        const errStr = String(error);
        
        if (errStr.includes("售票系統異常") && attempt < maxRetries) {
           console.log(`Retrying get_tickets for ${platform}... (attempt ${attempt + 1})`);
           await new Promise(r => setTimeout(r, 2000));
           continue;
        }

        console.error('Error fetching tickets:', error);
        if (errStr.includes("UNAUTHORIZED")) {
            return res.status(401).json({ error: 'Session expired or not logged in' });
        }
        if (errStr.includes("PERFORMANCE_ID")) {
            return res.status(502).json({ error: 'Could not fetch tickets from the ticketing system (Blocked by WAF/Cloudflare or structure changed).' });
        }
        return res.status(500).json({ error: errStr });
      }
    }
  });

  // Vite middleware for development or Static server for production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Fatal error starting server:", err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
