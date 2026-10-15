import React, { useState, useEffect, useRef } from 'react';
import { Download, Loader2, Search, Ticket, Settings, X, Plus, Trash2, ChevronLeft, ChevronRight, ChevronDown, LayoutGrid, Filter, AlertTriangle } from 'lucide-react';

interface Game {
  title: string;
  link: string;
  platform?: string;
}

interface TicketDetail {
  zone: string;
  unsold: number | string;
  sold?: number;
  total?: number;
}

interface TicketData {
  total_unsold: number;
  total_sold?: number;
  total_capacity?: number;
  details: TicketDetail[];
}

interface StaffRule {
  id: string;
  max: number; // -1 for infinity
  count: number;
}

const IBON_TEAMS = ['rakuten', 'uni', 'allstar'] as const;
const IBON_DISABLED_MESSAGE = '雲端版暫不支援，請洽規劃課分機8699';

// 依分區代碼（如「105區」「208區」的數字部分）排序用；抓不到代碼的分區排到最後。
const extractZoneNum = (zoneName: string): number => {
  const m = zoneName.match(/(\d+)\s*區/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
};

// 每區的座位數／已售／未售，CSV 匯出與畫面上的分區表共用同一套規則：
// 已售優先用爬蟲給的數字，沒有才用「座位數 − 未售」回推；
// 資料不可信（例如尚未開放銷售、回推出負數）時給 null，避免誤導成有效數字。
const resolveZone = (row: TicketDetail) => {
  const total = typeof row.total === 'number' && row.total >= 0 ? row.total : null;
  const u = Number(row.unsold);
  const unsold = Number.isFinite(u) && u >= 0 ? u : null;
  let sold: number | null = null;
  if (typeof row.sold === 'number' && row.sold >= 0) {
    sold = row.sold;
  } else if (total !== null && total > 0 && unsold !== null && total - unsold >= 0) {
    sold = total - unsold;
  }
  return { total, unsold, sold };
};

// 分區表依樓層分組。名稱有樓層就用名稱的（B1內野105區前排、L3左外野…），
// 沒有的話用區號百位數推（1xx→B1、2xx→L2…），兩者都沒有的歸「其他」。
const FLOOR_ORDER = ['B1', 'L2', 'L3', 'L4', 'L5', '其他'];
const floorOf = (zoneName: string): string => {
  const m = zoneName.match(/B1|L[2-5]/i);
  if (m) return m[0].toUpperCase();
  const n = extractZoneNum(zoneName);
  if (n >= 100 && n < 600) return n < 200 ? 'B1' : `L${Math.floor(n / 100)}`;
  return '其他';
};

const useMediaQuery = (query: string) => {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
};

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString());
const fmtTime = (d: Date) => d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

// 進度訊息裡要讓使用者特別注意的狀況。爬蟲只送文字，這裡用關鍵字分類：
// - throttle：味全售票網站 429 限速或中斷連線，訊息帶冷卻秒數（WeiChuanScraper；connReset 區分是哪一種）
// - retry：售票網站回「系統攔截」，自動重試中（兄弟／富邦／ibon 三隊、server.ts）
// - browser：ibon 三隊 HTTP 讀不到改開 Chrome，可能要人工過驗證
// sticky：狀況會持續到查詢結束（限速後一直放慢讀、改用瀏覽器後一直用瀏覽器）；
// 非 sticky 的（重試）只要之後出現一般訊息，代表已經恢復，就不再顯示提醒。
type ProgressAlertKind = 'throttle' | 'retry' | 'browser';
const classifyProgress = (text: string): { kind: ProgressAlertKind; seconds?: number; attempt?: number; connReset?: boolean; sticky: boolean } | null => {
  const throttle = text.match(/(限速|連線中斷)，等待 (\d+) 秒/);
  if (throttle) return { kind: 'throttle', seconds: parseInt(throttle[2], 10), connReset: throttle[1] === '連線中斷', sticky: true };
  if (text.includes('系統攔截')) {
    const n = text.match(/(\d+)/);
    return { kind: 'retry', attempt: n ? parseInt(n[1], 10) : undefined, sticky: false };
  }
  if (text.includes('嘗試瀏覽器方式')) return { kind: 'browser', sticky: true };
  return null;
};

// 場次標題多為「日期 時間 - 對戰組合」，拆成兩行顯示；沒有「 - 」的就整串當對戰組合
const splitGameTitle = (title: string) => {
  const [when, ...rest] = title.split(' - ');
  return rest.length > 0 ? { when, matchup: rest.join(' - ') } : { when: '', matchup: title };
};

export default function App() {
  const [activeTeam, setActiveTeam] = useState<'brothers' | 'weichuan' | 'fubon' | 'tsg' | 'rakuten' | 'uni' | 'allstar'>('brothers');
  const [cloudMode, setCloudMode] = useState(false);
  const isIbonDisabled = (team: string) => cloudMode && (IBON_TEAMS as readonly string[]).includes(team);

  const tabsRef = useRef<HTMLDivElement>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      // 電腦版球隊按鈕改成換行排列、沒有橫向捲動，此時不能攔截滾輪，否則整頁捲不動
      if (el.scrollWidth <= el.clientWidth) return;
      if (e.deltaY !== 0) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  const scrollTabs = (direction: 'left' | 'right') => {
    if (tabsRef.current) {
      const scrollAmount = 200;
      tabsRef.current.scrollBy({ left: direction === 'left' ? -scrollAmount : scrollAmount, behavior: 'smooth' });
    }
  };

  const [allGames, setAllGames] = useState<{ brothers: Game[], weichuan: Game[], fubon: Game[], tsg: Game[], rakuten: Game[], uni: Game[], allstar: Game[] }>({ brothers: [], weichuan: [], fubon: [], tsg: [], rakuten: [], uni: [], allstar: [] });
  const [selectedGame, setSelectedGame] = useState<string>('');
  const [loadingGames, setLoadingGames] = useState(true);

  const [ticketData, setTicketData] = useState<TicketData | null>(null);
  // 結果是哪一場、幾點查的：查完後下拉選單換場次，結果區仍標得出是哪一場的資料
  const [resultMeta, setResultMeta] = useState<{ title: string; at: Date } | null>(null);
  // 樓層分區表的展開狀態；沒手動切換過的樓層，電腦版預設展開、手機版預設收合
  const [floorOpen, setFloorOpen] = useState<Record<string, boolean>>({});
  // 「只看有票」：快完售的場次一百多區裡只剩幾區有票，濾掉其餘的比較好找
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [loadingTickets, setLoadingTickets] = useState(false);
  // 每筆進度訊息記下收到的時間（以前是畫面重繪時才取現在時間，所有訊息都顯示同一個時間）
  const [scrapingProgress, setScrapingProgress] = useState<{ text: string; at: Date }[]>([]);
  const [queryingTitle, setQueryingTitle] = useState('');
  const [error, setError] = useState('');

  // 進度區的狀況提醒：找最後一則狀況訊息；非 sticky 的狀況在之後出現一般訊息時視為已恢復
  const activeAlert = (() => {
    if (!loadingTickets) return null;
    for (let i = scrapingProgress.length - 1; i >= 0; i--) {
      const c = classifyProgress(scrapingProgress[i].text);
      if (!c) continue;
      if (!c.sticky && i < scrapingProgress.length - 1) return null;
      return { ...c, at: scrapingProgress[i].at };
    }
    return null;
  })();
  // 限速冷卻倒數：只在倒數中每秒更新一次畫面
  const [nowTick, setNowTick] = useState(Date.now());
  const cooldownLeft = activeAlert?.seconds ? Math.ceil((activeAlert.at.getTime() + activeAlert.seconds * 1000 - nowTick) / 1000) : 0;
  useEffect(() => {
    if (!activeAlert?.seconds) return;
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeAlert?.at.getTime(), activeAlert?.seconds]);

  useEffect(() => {
    if (progressEndRef.current) {
      progressEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [scrapingProgress]);
  
  const [isStaffConfigOpen, setIsStaffConfigOpen] = useState(false);
  const [staffRules, setStaffRules] = useState<StaffRule[]>([
    { id: '1', max: 15000, count: 4 },
    { id: '2', max: 20000, count: 8 },
    { id: '3', max: 25000, count: 15 },
    { id: '4', max: 30000, count: 20 },
    { id: '5', max: 40000, count: 29 },
    { id: '6', max: -1, count: 40 }
  ]);

  const handleRuleChange = (id: string, field: 'max' | 'count', value: string) => {
    setStaffRules(prev => prev.map(r => {
      if (r.id === id) {
        const numVal = parseInt(value, 10);
        return { ...r, [field]: isNaN(numVal) ? 0 : numVal };
      }
      return r;
    }));
  };

  const addRule = () => {
    const newId = Math.random().toString(36).slice(2, 11);
    setStaffRules(prev => {
      // Find the last rule that might be -1
      const lastRule = prev[prev.length - 1];
      if (lastRule && lastRule.max === -1) {
        // Insert before it
        const newArr = [...prev];
        newArr.splice(newArr.length - 1, 0, { id: newId, max: 40000, count: 0 });
        return newArr;
      }
      return [...prev, { id: newId, max: 40000, count: 0 }];
    });
  };

  const removeRule = (id: string) => {
    setStaffRules(prev => prev.filter(r => r.id !== id));
  };

  useEffect(() => {
    const init = async () => {
      let cloud = false;
      try {
        const cfgRes = await fetch('/api/config');
        const cfg = await cfgRes.json();
        cloud = !!cfg.cloudMode;
      } catch {}
      setCloudMode(cloud);

      const fetchGames = (platform: string) => cloud && (IBON_TEAMS as readonly string[]).includes(platform)
        ? Promise.resolve([])
        : fetch(`/api/get_games/${platform}`).then(res => res.json()).then(d => (d.games || []).map((g: Game) => ({...g, platform}))).catch(() => []);

      const [brothersGames, weichuanGames, fubonGames, tsgGames, rakutenGames, uniGames, allstarGames] = await Promise.all([
        fetchGames('brothers'),
        fetchGames('weichuan'),
        fetchGames('fubon'),
        fetchGames('tsg'),
        fetchGames('rakuten'),
        fetchGames('uni'),
        fetchGames('allstar')
      ]);
      setAllGames({ brothers: brothersGames, weichuan: weichuanGames, fubon: fubonGames, tsg: tsgGames, rakuten: rakutenGames, uni: uniGames, allstar: allstarGames });
      if (brothersGames.length > 0) {
         setSelectedGame(brothersGames[0].link);
      }
      setLoadingGames(false);
    };
    init();
  }, []);

  const [gameMenuOpen, setGameMenuOpen] = useState(false);

  useEffect(() => {
    // When activeTeam changes, reset selectedGame to the first game of that team
    const currentTeamGames = allGames[activeTeam] || [];
    if (currentTeamGames.length > 0) {
      setSelectedGame(currentTeamGames[0].link);
    } else {
      setSelectedGame('');
    }
    setGameMenuOpen(false);
  }, [activeTeam, allGames]);

  const currentGamesForTeam = allGames[activeTeam] || [];

  // 手機版場次下拉選單：點選單外面或按 Esc 就收起來
  const gameMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!gameMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!gameMenuRef.current?.contains(e.target as Node)) setGameMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGameMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [gameMenuOpen]);

  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: '', password: '', captcha: '' });
  const [captchaData, setCaptchaData] = useState<{base64: string, sessionToken: string, _rvt: string, _jwt: string} | null>(null);
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);
  const [loginError, setLoginError] = useState('');
  
  const fetchCaptcha = async () => {
    setLoadingCaptcha(true);
    setLoginError('');
    try {
      const res = await fetch('/api/weichuan/captcha');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCaptchaData({
        base64: data.captchaBase64,
        sessionToken: data.sessionToken,
        _rvt: data._rvt,
        _jwt: data._jwt
      });
    } catch (e: any) {
      setLoginError('無法載入驗證碼: ' + e.message);
    } finally {
      setLoadingCaptcha(false);
    }
  };

  const handleQueryClick = () => {
    if (!selectedGame) return;
    const game = currentGamesForTeam.find(g => g.link === selectedGame);
    if (game?.platform === 'weichuan') {
      const weichuanToken = localStorage.getItem('weichuanSessionToken');
      if (weichuanToken) {
         executeQuery(weichuanToken);
      } else {
         setIsLoginModalOpen(true);
         fetchCaptcha();
      }
    } else {
      executeQuery();
    }
  };

  const executeQuery = (sessionToken?: string) => {
    if (!selectedGame) return;
    setLoadingTickets(true);
    setError('');
    setScrapingProgress([{ text: '開始連線...', at: new Date() }]);
    setTicketData(null);
    const game = currentGamesForTeam.find(g => g.link === selectedGame);
    setQueryingTitle(game?.title || '');
    const platform = game?.platform || activeTeam;
    
    let url = `/api/get_tickets/${platform}?url=${encodeURIComponent(selectedGame)}`;
    if (sessionToken) {
       url += `&sessionToken=${encodeURIComponent(sessionToken)}`;
    }

    const eventSource = new EventSource(url);

    eventSource.addEventListener('progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.message) {
            setScrapingProgress(prev => [...prev, { text: data.message, at: new Date() }]);
        }
      } catch (err) {}
    });

    eventSource.addEventListener('complete', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.error) throw new Error(data.error);
        setTicketData(data);
        setResultMeta({ title: game?.title || '', at: new Date() });
        setFloorOpen({});
      } catch (err: any) {
        setError(err.message || '查詢失敗，請再試一次。');
      }
      setLoadingTickets(false);
      setScrapingProgress([]);
      eventSource.close();
    });

    eventSource.addEventListener('error', (e: any) => {
      const genericReasons = 'API 發生錯誤，可能原因如下：\n• 環境限制（IP 或雲端環境被限制）\n• 目標網站阻擋（WAF / Cloudflare 防護）\n• 售票網站結構異動';
      let errStr = genericReasons;
      try {
        if (e.data) {
          const data = JSON.parse(e.data);
          if (data.code === 401 && platform === 'weichuan') {
             localStorage.removeItem('weichuanSessionToken');
             setIsLoginModalOpen(true);
             fetchCaptcha();
             errStr = '登入狀態已過期，請重新登入';
          } else if (data.error) {
             errStr = `${data.error}\n\n${genericReasons}`;
          }
        }
      } catch (err) {}

      setError(errStr);
      setLoadingTickets(false);
      setScrapingProgress([]);
      eventSource.close();
    });
  };
  
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!captchaData) return;
    setLoginError('');
    setLoadingTickets(true);
    
    try {
      const res = await fetch('/api/weichuan/login', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            username: loginForm.username,
            password: loginForm.password,
            captcha: loginForm.captcha,
            sessionToken: captchaData.sessionToken,
            _rvt: captchaData._rvt,
            _jwt: captchaData._jwt
         })
      });
      const data = await res.json();
      if (data.success) {
         localStorage.setItem('weichuanSessionToken', captchaData.sessionToken);
         setIsLoginModalOpen(false);
         setLoginForm({ ...loginForm, captcha: '' });
         executeQuery(captchaData.sessionToken);
      } else {
         throw new Error(data.error || '登入失敗');
      }
    } catch (err: any) {
      setLoginError(err.message || '登入失敗');
      setLoadingTickets(false);
      fetchCaptcha(); // reload captcha after failed attempt
    }
  };
  
  const handleExport = () => {
    if (!ticketData || !ticketData.details) return;
    
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF"; // \uFEFF for BOM (Excel UTF-8 support)
    
    // 台鋼的售票平台會回傳每個分區真實的座位數（seatCount），是最準確的權威資料
    // （見 大巨蛋座位v3.json），因此多加一欄「座位數」；中信兄弟、味全龍已改用 v3 容量表
    // 回填缺值分區的 total，故一併加入。其餘球團尚未接上容量表，維持原本欄位
    // 以免顯示一堆空白/未知值。
    const includeSeatCount = activeTeam === 'tsg' || activeTeam === 'brothers' || activeTeam === 'weichuan';

    csvContent += includeSeatCount
      ? "區域,座位數,未售出票數,已售出票數,備註\n"
      : "區域,未售出票數,已售出票數,備註\n";

    // 依分區代碼由小到大排序，方便閱讀；同代碼的前/後排、輪椅席等
    // 保留原本抓取順序（sort 為 stable sort）。
    const sortedDetails = [...ticketData.details].sort((a, b) => extractZoneNum(a.zone) - extractZoneNum(b.zone));

    sortedDetails.forEach(row => {
      const zoneName = row.zone.includes(',') ? `"${row.zone}"` : row.zone;
      const { total, unsold, sold } = resolveZone(row);

      // 未售出/已售出在資料不可信時（例如尚未開放銷售）保持空白，避免誤導成有效數字。
      let unsoldStr = unsold !== null ? unsold.toString() : "";
      let soldStr = sold !== null ? sold.toString() : "";
      let errorStr = (row as any).error ? `"${(row as any).error}"` : "";
      if (includeSeatCount) {
        const totalStr = total !== null ? total.toString() : "";
        csvContent += `${zoneName},${totalStr},${unsoldStr},${soldStr},${errorStr}\n`;
      } else {
        csvContent += `${zoneName},${unsoldStr},${soldStr},${errorStr}\n`;
      }
    });

    const globalSold = ticketData.total_sold ?? 0;
    if (includeSeatCount) {
      const globalCapacity = ticketData.total_capacity ?? '';
      csvContent += `總計,${globalCapacity},${ticketData.total_unsold},${globalSold}\n`;
    } else {
      csvContent += `總計,${ticketData.total_unsold},${globalSold}\n`;
    }
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.href = encodedUri;
    
    // 用查詢當時的場次名稱：查完後下拉選單換了場次，檔名才不會變成另一場
    const safeTitle = (resultMeta?.title || "賽事").replace(/\s|:|vs/g, '_');
    link.download = activeTeam === 'tsg' ? `未售票明細_${safeTitle}.csv` : `售票明細_${safeTitle}.csv`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getSupportStaffCount = (soldTickets: number) => {
    const sortedRules = [...staffRules].sort((a, b) => {
       if (a.max === -1) return 1;
       if (b.max === -1) return -1;
       return a.max - b.max;
    });
    
    for (const rule of sortedRules) {
       if (rule.max === -1 || soldTickets <= rule.max) {
          return rule.count;
       }
    }
    return 0;
  };

  // 分區表：依樓層分組、組內依區號排序，並算出樓層小計（只加總有可信數字的分區）
  const floorGroups = ticketData ? FLOOR_ORDER.map(floor => {
    const rows = ticketData.details
      .filter(d => floorOf(d.zone) === floor)
      .sort((a, b) => extractZoneNum(a.zone) - extractZoneNum(b.zone))
      .map(d => {
        const note = (d as any).error as string | undefined;
        const z = resolveZone(d);
        // 有票：未售確定 > 0。完售：未售 0 且有已售或座位數佐證（有些爬蟲讀不到時也先填 0，
        // 單憑未售 0 不能斷定完售）。其餘（尚未開放、讀取失敗）都算未知，畫面上淡化。
        const status: 'available' | 'soldout' | 'unknown' =
          z.unsold !== null && z.unsold > 0 ? 'available'
          : z.unsold === 0 && (z.sold !== null || z.total !== null || note === '已售完') ? 'soldout'
          : 'unknown';
        return { zone: d.zone, note, status, ...z };
      });
    let sold = 0, unsold = 0, rateSold = 0, rateTotal = 0;
    for (const r of rows) {
      if (r.sold !== null) sold += r.sold;
      if (r.unsold !== null) unsold += r.unsold;
      if (r.sold !== null && r.total) { rateSold += r.sold; rateTotal += r.total; }
    }
    // 輪椅席／陪同席每區只有個位數座位，另外排在樓層最後，不跟一般分區混在一起
    const isAccessible = (zone: string) => /輪椅|陪同|陪伴/.test(zone);
    const shown = onlyAvailable ? rows.filter(r => r.status === 'available') : rows;
    return {
      floor, count: rows.length, sold, unsold, rate: rateTotal > 0 ? rateSold / rateTotal : null,
      availableCount: rows.filter(r => r.status === 'available').length,
      soldOutCount: rows.filter(r => r.status === 'soldout').length,
      sections: [
        { label: '', rows: shown.filter(r => !isAccessible(r.zone)) },
        { label: '輪椅／陪同席', rows: shown.filter(r => isAccessible(r.zone)) },
      ].filter(s => s.rows.length > 0),
    };
  }).filter(g => g.count > 0) : [];
  const totalAvailable = floorGroups.reduce((n, g) => n + g.availableCount, 0);

  const selectedGameInfo = currentGamesForTeam.find(g => g.link === selectedGame);
  const selectedGameTitle = selectedGameInfo ? splitGameTitle(selectedGameInfo.title) : null;

  // 查詢中的狀況提醒（橘色框）：電腦版放在右側進度框標題下，手機版放在小進度框最上面
  const renderProgressAlert = () => {
    if (!activeAlert) return null;
    const { title, body } =
      activeAlert.kind === 'throttle' ? {
        title: activeAlert.connReset ? '售票網站連線中斷' : '售票網站暫時限速',
        body: cooldownLeft > 0
          ? `${activeAlert.connReset ? '網站中斷了連線' : '網站嫌讀取太快'}，已自動暫停，約 ${cooldownLeft} 秒後放慢速度繼續。被擋的分區會重新讀取，查詢會比較久，請稍候。`
          : '已放慢速度，一次讀一區；被擋的分區會重新讀取，查詢會比較久，請稍候。',
      } : activeAlert.kind === 'retry' ? {
        title: '售票網站回應異常',
        body: `網站回「系統攔截」，正在自動重試${activeAlert.attempt ? `（第 ${activeAlert.attempt} 次）` : ''}，請稍候。`,
      } : {
        title: '改用瀏覽器讀取',
        body: '直接讀取失敗，改開 Chrome 讀取，速度比較慢。如果跳出 Chrome 視窗要求驗證，請在視窗裡完成驗證。',
      };
    return (
      <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-800">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-bold">{title}</div>
          <div className="text-xs mt-0.5 leading-relaxed">{body}</div>
        </div>
      </div>
    );
  };

  // 查完後只提醒會影響結果的事：有分區讀不到座位圖，總數可能不完整。
  // 過程中的狀況（限速、重試、改用瀏覽器）只在查詢中的提醒框顯示，查完就不再提。
  const unreadZoneCount = ticketData?.details.filter(d => /座位圖解析失敗|未讀到座位圖|遭防爬蟲阻擋/.test((d as any).error || '')).length ?? 0;
  const resultNotices = unreadZoneCount > 0 ? [`有 ${unreadZoneCount} 區讀不到座位圖，總數可能不完整（見各區灰色虛線方塊的備註）。`] : [];

  // 場次清單：電腦版直接列在側欄，手機版放在下拉選單裡，兩邊共用
  const renderGameOptions = (onPick?: () => void) => currentGamesForTeam.length === 0 ? (
    <div className="text-sm text-gray-400 text-center py-4 rounded-xl border border-dashed border-gray-300">無資料或尚未開賣</div>
  ) : currentGamesForTeam.map((g, i) => {
    const { when, matchup } = splitGameTitle(g.title);
    const selected = g.link === selectedGame;
    return (
      <button
        key={i}
        onClick={() => { setSelectedGame(g.link); onPick?.(); }}
        role="option"
        aria-selected={selected}
        className={`flex items-center gap-3 text-left rounded-xl border px-3 py-2 transition-colors ${selected ? 'border-gray-900 bg-gray-50 ring-1 ring-gray-900' : 'border-gray-200 bg-white hover:border-gray-400'}`}
      >
        <span className={`shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${selected ? 'border-gray-900' : 'border-gray-300'}`}>
          {selected && <span className="w-2 h-2 rounded-full bg-gray-900" />}
        </span>
        <span className="min-w-0">
          {when && <span className="block text-xs text-gray-500 tabular-nums">{when}</span>}
          <span className="block text-sm font-bold text-gray-900">{matchup}</span>
        </span>
      </button>
    );
  });

  return (
    <div className="min-h-screen bg-gray-50 flex justify-center text-gray-900 font-sans">
      {/* 手機：置中窄版；電腦（lg 以上）：左側操作欄 + 右側結果區的寬版 */}
      <div className="w-full max-w-md lg:max-w-none bg-white lg:bg-transparent min-h-screen shadow-xl lg:shadow-none overflow-x-clip flex flex-col">
        {/* Header */}
        <header className={`p-4 sticky top-0 z-10 flex items-center justify-center gap-2 transition-colors ${activeTeam === 'brothers' ? 'bg-yellow-400 border-b border-yellow-500' : activeTeam === 'weichuan' ? 'bg-red-600 outline-none border-b border-red-700' : activeTeam === 'tsg' ? 'bg-[#00604A] border-b border-[#004A3A]' : activeTeam === 'rakuten' ? 'bg-[#BE1E2D] border-b border-[#9E1824]' : activeTeam === 'uni' ? 'bg-[#EC6A1A] border-b border-[#C55A16]' : activeTeam === 'allstar' ? 'bg-[#D4AF37] border-b border-[#B8960F]' : 'bg-[#004A9C] border-b border-[#003875]'}`}>
          <Ticket className={`w-6 h-6 ${activeTeam === 'brothers' ? 'text-gray-900' : 'text-white'}`} />
          <h1 className={`text-xl font-bold tracking-tight ${activeTeam === 'brothers' ? 'text-gray-900' : 'text-white'}`}>大巨蛋售票極速查詢 v0.94</h1>
        </header>
        
        {/* Main Content */}
        <main className="flex-1 w-full p-5 space-y-6 pb-10 lg:max-w-[1600px] lg:mx-auto lg:p-8 lg:grid lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-8 lg:items-start lg:space-y-0">

          <aside className="space-y-6 lg:sticky lg:top-[calc(61px+2rem)] lg:bg-white lg:border lg:border-gray-200 lg:rounded-2xl lg:shadow-sm lg:p-5">
          {/* Team Selection Tabs - 手機橫向捲動，電腦兩欄排列 */}
          <div className="relative group -mx-5 px-5">
            <button
              className="hidden md:flex lg:hidden absolute left-2 top-1/2 -translate-y-1/2 -mt-1 z-10 w-8 h-8 items-center justify-center bg-white/90 backdrop-blur-sm shadow border border-gray-200 rounded-full text-gray-500 hover:text-gray-900 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-0"
              onClick={() => scrollTabs('left')}
              aria-label="Scroll left"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div 
              ref={tabsRef}
              className="flex overflow-x-auto whitespace-nowrap snap-x gap-2 pb-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] lg:grid lg:grid-cols-2 lg:overflow-visible lg:pb-0"
            >
              <button
                 className={`snap-start shrink-0 px-8 lg:px-3 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'brothers' ? 'bg-yellow-400 text-gray-900 border-yellow-500 shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('brothers'); setTicketData(null); setError(''); }}
              >
                 中信兄弟
              </button>
              <button
                 className={`snap-start shrink-0 px-8 lg:px-3 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'weichuan' ? 'bg-red-600 text-white border-red-700 shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('weichuan'); setTicketData(null); setError(''); }}
              >
                 味全龍
              </button>
              <button
                 className={`snap-start shrink-0 px-8 lg:px-3 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'fubon' ? 'bg-[#004A9C] text-white border-[#003875] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('fubon'); setTicketData(null); setError(''); }}
              >
                 富邦悍將
              </button>
              <button
                 className={`snap-start shrink-0 px-8 lg:px-3 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'tsg' ? 'bg-[#00604A] text-white border-[#004A3A] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('tsg'); setTicketData(null); setError(''); }}
              >
                 台鋼雄鷹
              </button>
              <button
                 className={`snap-start shrink-0 px-8 lg:px-3 py-3 text-sm font-bold rounded-full transition-all border ${isIbonDisabled('rakuten') ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed opacity-60' : activeTeam === 'rakuten' ? 'bg-[#BE1E2D] text-white border-[#9E1824] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { if (isIbonDisabled('rakuten')) return; setActiveTeam('rakuten'); setTicketData(null); setError(''); }}
                 disabled={isIbonDisabled('rakuten')}
                 title={isIbonDisabled('rakuten') ? IBON_DISABLED_MESSAGE : undefined}
              >
                  樂天
              </button>
              <button
                 className={`snap-start shrink-0 px-8 lg:px-3 py-3 text-sm font-bold rounded-full transition-all border ${isIbonDisabled('uni') ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed opacity-60' : activeTeam === 'uni' ? 'bg-[#EC6A1A] text-white border-[#C55A16] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { if (isIbonDisabled('uni')) return; setActiveTeam('uni'); setTicketData(null); setError(''); }}
                 disabled={isIbonDisabled('uni')}
                 title={isIbonDisabled('uni') ? IBON_DISABLED_MESSAGE : undefined}
              >
                  統一獅
              </button>
              <button
                 className={`snap-start shrink-0 px-8 lg:px-3 py-3 text-sm font-bold rounded-full transition-all border ${isIbonDisabled('allstar') ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed opacity-60' : activeTeam === 'allstar' ? 'bg-[#D4AF37] text-white border-[#B8960F] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { if (isIbonDisabled('allstar')) return; setActiveTeam('allstar'); setTicketData(null); setError(''); }}
                 disabled={isIbonDisabled('allstar')}
                 title={isIbonDisabled('allstar') ? IBON_DISABLED_MESSAGE : undefined}
              >
                  職棒明星賽
              </button>
            </div>
            <button
              className="hidden md:flex lg:hidden absolute right-2 top-1/2 -translate-y-1/2 -mt-1 z-10 w-8 h-8 items-center justify-center bg-white/90 backdrop-blur-sm shadow border border-gray-200 rounded-full text-gray-500 hover:text-gray-900 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-0"
              onClick={() => scrollTabs('right')}
              aria-label="Scroll right"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          {/* Query Section */}
          <section className="space-y-4">

            <div className="relative border-b border-gray-100 pb-2 lg:border-b-0 lg:pb-0">
              {loadingGames ? (
                 <div className="w-full bg-gray-100 border border-gray-200 text-gray-500 rounded-xl p-4 flex items-center justify-center gap-2 animate-pulse">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>載入賽事中...</span>
                 </div>
              ) : (
                <div className="space-y-4">
                  {/* 電腦版：場次直接列出來點選，完整顯示日期與對戰組合（下拉選單在側欄寬度下會被截斷） */}
                  <div role="listbox" className="hidden lg:flex flex-col gap-1.5 max-h-[45vh] overflow-y-auto -mx-1 px-1 py-1">
                    {renderGameOptions()}
                  </div>

                  {/* 手機版：自製下拉選單。原生 <select> 只能顯示一行、長的對戰組合會被截斷，
                      這裡收合時就用「日期在上、對戰組合在下」兩行顯示，展開後的清單跟電腦版同一套 */}
                  <div ref={gameMenuRef} className="relative lg:hidden">
                    <button
                      onClick={() => setGameMenuOpen(o => !o)}
                      disabled={currentGamesForTeam.length === 0}
                      aria-haspopup="listbox"
                      aria-expanded={gameMenuOpen}
                      className={`w-full flex items-center gap-3 text-left bg-gray-50 border text-gray-900 rounded-xl px-4 py-3 shadow-sm focus:outline-none focus:ring-2 disabled:text-gray-400 ${activeTeam === 'brothers' ? 'border-gray-300 focus:ring-yellow-400 focus:border-yellow-400' : activeTeam === 'weichuan' ? 'border-gray-300 focus:ring-red-500 focus:border-red-500' : activeTeam === 'tsg' ? 'border-gray-300 focus:ring-[#00604A] focus:border-[#00604A]' : activeTeam === 'rakuten' ? 'border-gray-300 focus:ring-[#BE1E2D] focus:border-[#BE1E2D]' : 'border-gray-300 focus:ring-[#004A9C] focus:border-[#004A9C]'}`}
                    >
                      <span className="min-w-0 flex-1">
                        {selectedGameTitle ? (
                          <>
                            {selectedGameTitle.when && <span className="block text-xs text-gray-500 tabular-nums">{selectedGameTitle.when}</span>}
                            <span className="block text-[15px] font-bold">{selectedGameTitle.matchup}</span>
                          </>
                        ) : (
                          <span className="block text-[15px] font-semibold py-2">無資料或尚未開賣</span>
                        )}
                      </span>
                      <ChevronDown className={`shrink-0 w-4 h-4 text-gray-500 transition-transform ${gameMenuOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {gameMenuOpen && (
                      <div role="listbox" className="absolute left-0 right-0 top-full mt-2 z-30 bg-white border border-gray-200 rounded-xl shadow-xl p-2 flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto">
                        {renderGameOptions(() => setGameMenuOpen(false))}
                      </div>
                    )}
                  </div>
                  
                  <button 
                    onClick={handleQueryClick}
                    disabled={loadingTickets || !selectedGame}
                    className="w-full bg-gray-900 text-white font-bold text-lg rounded-xl p-4 flex items-center justify-center gap-2 active:scale-[0.98] transition-all disabled:opacity-50 shadow-md hover:bg-gray-800"
                  >
                    {loadingTickets ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span>執行資料收集中...</span>
                      </>
                    ) : (
                      <>
                        <Search className="w-5 h-5" />
                        <span>執行資料收集</span>
                      </>
                    )}
                  </button>
                  
                  {/* Scraping Progress Tracker（手機版；電腦版改顯示在右側結果區） */}
                  {!isDesktop && loadingTickets && scrapingProgress.length > 0 && (
                   <div className="mt-4 space-y-2">
                     {/* 狀況提醒放在小進度框外面，不會跟著紀錄捲走 */}
                     {renderProgressAlert()}
                     <div className="p-4 rounded-xl bg-gray-50 border border-gray-200 shadow-inner flex flex-col gap-2 max-h-48 overflow-y-auto">
                        <div className="text-xs font-bold text-gray-400 mb-1 flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
                          系統狀態
                        </div>
                        {scrapingProgress.map((msg, idx) => {
                           const isAlert = !!classifyProgress(msg.text);
                           const last = idx === scrapingProgress.length - 1;
                           return (
                             <div key={idx} className="flex gap-2 text-sm text-gray-700 animate-in fade-in slide-in-from-left-2 duration-300">
                               <span className="text-gray-400 font-mono flex-shrink-0">{fmtTime(msg.at)}</span>
                               <span className={isAlert ? 'font-medium text-amber-700' : last ? 'font-medium text-gray-900' : ''}>{msg.text}</span>
                             </div>
                           );
                        })}
                        <div ref={progressEndRef} />
                     </div>
                   </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Error Message（手機版；電腦版改顯示在右側結果區） */}
          {!isDesktop && error && (
            <div className="p-4 bg-red-50 border-l-4 border-red-500 text-red-700 rounded-lg text-sm font-medium whitespace-pre-line">
               {error}
            </div>
          )}
          </aside>

          <div className="space-y-6 min-w-0">
          {/* 電腦版右側結果區在查到結果之前：收集中顯示進度紀錄、失敗顯示錯誤、其餘顯示提示。
              提示框與進度框用同一個外框：頂端跟左側操作欄對齊（都黏在「標題列 61px＋上方留白 2rem」），
              高度跟著螢幕高度走、底下留跟左右一樣的 2rem 空白；紀錄多了在框內捲動，整頁不跟著變長 */}
          {isDesktop && !ticketData && (
            loadingTickets ? (
              <div className="sticky top-[calc(61px+2rem)] flex flex-col h-[calc(100dvh-61px-4rem)] min-h-[360px] rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <div className="flex-none flex items-center gap-3 px-5 py-4 border-b border-gray-100">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
                  <div className="min-w-0">
                    <div className="font-bold text-gray-800">資料收集中</div>
                    {queryingTitle && <div className="text-sm text-gray-500 truncate">{queryingTitle}</div>}
                  </div>
                  <span className="ml-auto flex items-center gap-2 text-xs font-bold text-gray-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                    系統狀態
                  </span>
                </div>
                {/* 狀況提醒（限速、重試、改用瀏覽器）固定在標題下方，不跟著紀錄捲動 */}
                {activeAlert && <div className="flex-none px-5 pt-4">{renderProgressAlert()}</div>}
                {/* 頂端 1rem 淡出：捲上去被切到一半的那行看起來是淡出，不像文字被截斷 */}
                <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-1.5 [mask-image:linear-gradient(to_bottom,transparent,black_1rem)]">
                  {scrapingProgress.map((msg, idx) => {
                    const last = idx === scrapingProgress.length - 1;
                    // 爬蟲訊息結尾的「...」是「進行中」的意思，在寬版面看起來像文字被截斷，
                    // 這裡拿掉，改用最後一行的轉圈圖示表示進行中。前面幾行只標點、不打勾：
                    // 同一批 5 區是同時讀的，出現下一行不代表上一區已經讀完。
                    const text = msg.text.replace(/(\.\.\.|…)$/, '');
                    // 狀況訊息（限速、重試、改用瀏覽器）用橘色＋警告圖示標出來
                    const isAlert = !!classifyProgress(msg.text);
                    return (
                      <div key={idx} className="flex items-center gap-3 text-sm">
                        <span className="text-gray-400 font-mono flex-shrink-0">{fmtTime(msg.at)}</span>
                        {isAlert
                          ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                          : last
                          ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-gray-500" />
                          : <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center"><span className="w-1 h-1 rounded-full bg-gray-300" /></span>}
                        <span className={isAlert ? 'font-semibold text-amber-700' : last ? 'font-semibold text-gray-900' : 'text-gray-600'}>{text}</span>
                      </div>
                    );
                  })}
                  <div ref={progressEndRef} />
                </div>
              </div>
            ) : error ? (
              <div className="p-5 bg-red-50 border-l-4 border-red-500 text-red-700 rounded-lg font-medium whitespace-pre-line">
                {error}
              </div>
            ) : (
              <div className="sticky top-[calc(61px+2rem)] flex flex-col items-center justify-center gap-3 h-[calc(100dvh-61px-4rem)] min-h-[360px] rounded-2xl border-2 border-dashed border-gray-200 text-gray-400">
                <LayoutGrid className="w-10 h-10" />
                <p className="font-medium">選擇場次後按「執行資料收集」，各區票數會顯示在這裡</p>
              </div>
            )
          )}

          {/* Results Section */}
          {ticketData && (
            <section className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                    <span className="w-1.5 h-6 bg-yellow-400 rounded-full inline-block"></span>
                    預估動態數據
                  </h2>
                  {resultMeta && (
                    <p className="text-sm text-gray-500 mt-1 pl-3.5">
                      {resultMeta.title}
                      <span className="text-gray-400"> · 查詢時間 {resultMeta.at.toLocaleTimeString('zh-TW', { hour12: false })}</span>
                    </p>
                  )}
                  {/* 這次查詢遇到的狀況（限速、重試、改用瀏覽器、讀不到的分區） */}
                  {resultNotices.map((n, i) => (
                    <p key={i} className="text-xs text-amber-700 mt-1 pl-3.5 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                      <span>{n}</span>
                    </p>
                  ))}
                </div>
                <button
                  onClick={handleExport}
                  className="hidden lg:flex items-center gap-2 bg-white border border-gray-300 text-gray-800 hover:bg-gray-50 font-bold text-sm rounded-xl px-4 py-2.5 shadow-sm transition-colors"
                >
                  <Download className="w-4 h-4 text-gray-600" />
                  下載 CSV
                </button>
              </div>

              {/* 全頁票況配色（卡片、樓層小計、分區方塊一致）：
                  藍＝已售／完售、綠＝未售／有票、灰虛線＝未開放或讀不到；營運試算兩張卡各用一色：紫＝支援人力、橘＝疏運時間 */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {/* Card 1: Sold */}
                <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 p-5 rounded-2xl flex flex-col justify-between shadow-sm relative group">
                  <div className="flex justify-between items-center">
                    <span className="text-blue-700 text-sm font-bold tracking-wide opacity-90">已售出(人)</span>
                  </div>
                  <span className="text-4xl font-black text-blue-900 mt-2">
                    {(ticketData.total_sold ?? 0).toLocaleString()}
                  </span>
                </div>
                
                {/* Card 2: Unsold */}
                <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 border border-emerald-200 p-5 rounded-2xl flex flex-col justify-between shadow-sm">
                  <span className="text-emerald-700 text-sm font-bold tracking-wide opacity-90">未售出(張)</span>
                  <span className="text-4xl font-black text-emerald-900 mt-2">
                    {ticketData.total_unsold.toLocaleString()}
                  </span>
                </div>

                {/* Card 3: Support Staff */}
                <div className="bg-gradient-to-br from-purple-50 to-purple-100 border border-purple-200 p-5 rounded-2xl flex flex-col justify-between shadow-sm relative group">
                  <div className="flex justify-between items-center">
                    <span className="text-purple-700 text-sm font-bold tracking-wide opacity-90">支援人力(人)</span>
                    <button
                      onClick={() => setIsStaffConfigOpen(true)}
                      className="p-1.5 text-purple-600 hover:bg-purple-200 hover:text-purple-800 rounded-full transition-colors"
                      title="設定支援人力規則"
                    >
                      <Settings className="w-4 h-4" />
                    </button>
                  </div>
                  <span className="text-4xl font-black text-purple-900 mt-2">
                    {getSupportStaffCount(ticketData.total_sold ?? 0)}
                  </span>
                </div>

                {/* Card 4: Clearing Time */}
                <div className="bg-gradient-to-br from-orange-50 to-orange-100 border border-orange-200 p-5 rounded-2xl flex flex-col justify-between shadow-sm">
                  <span className="text-orange-700 text-sm font-bold tracking-wide opacity-90">疏運時間(分)</span>
                  <span className="text-4xl font-black text-orange-900 mt-2">
                    {10 + Math.ceil((ticketData.total_sold ?? 0) / 500)}
                  </span>
                </div>
              </div>
              <div className="text-xs text-center text-gray-500 mt-2 font-medium">
                 * 上述總數與試算已包含所有區塊（含「熱賣中」區塊）的未售出精確計算
              </div>

              {/* 各區票數：依樓層分組，電腦版預設展開、手機版預設收合 */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-bold text-gray-800 flex items-center gap-2">
                    <LayoutGrid className="w-4 h-4 text-gray-500" />
                    各區票數
                    <span className="text-xs font-medium text-gray-400">共 {ticketData.details.length} 區</span>
                    <span className="text-xs font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">{totalAvailable} 區有票</span>
                  </h3>
                  <div className="flex items-center gap-4">
                    <div className="hidden sm:flex items-center gap-3 text-xs text-gray-500">
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded border border-emerald-400 bg-emerald-50" />有票可買</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded border border-blue-200 bg-blue-50" />完售</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded border border-dashed border-gray-300 bg-gray-50" />未開放／讀不到</span>
                    </div>
                    <button
                      onClick={() => setOnlyAvailable(v => !v)}
                      aria-pressed={onlyAvailable}
                      className={`flex items-center gap-1.5 text-xs font-bold rounded-full px-3 py-1.5 border transition-colors ${onlyAvailable ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
                    >
                      <Filter className="w-3.5 h-3.5" />
                      只看有票
                    </button>
                  </div>
                </div>
                <div className="space-y-3">
                  {floorGroups.map(g => {
                    const open = floorOpen[g.floor] ?? isDesktop;
                    return (
                      <div key={g.floor} className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
                        <button
                          onClick={() => setFloorOpen(prev => ({ ...prev, [g.floor]: !open }))}
                          className="w-full flex items-center gap-2 sm:gap-3 px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
                        >
                          <span className="text-xl font-black text-gray-900 w-8 sm:w-10">{g.floor}</span>
                          {g.availableCount > 0 ? (
                            <span className="text-xs font-bold rounded-full px-2 py-0.5 whitespace-nowrap text-emerald-700 bg-emerald-100">{g.availableCount} 區有票</span>
                          ) : g.soldOutCount === g.count ? (
                            <span className="text-xs font-bold rounded-full px-2 py-0.5 whitespace-nowrap text-blue-700 bg-blue-100">全區完售</span>
                          ) : (
                            <span className="text-xs font-bold rounded-full px-2 py-0.5 whitespace-nowrap text-gray-400 bg-gray-100">0 區有票</span>
                          )}
                          {/* 樓層小計：小標在上、大數字在下；已售藍、未售綠，跟上方卡片與分區方塊一致 */}
                          <span className="ml-auto flex items-end gap-3 sm:gap-6 tabular-nums whitespace-nowrap">
                            <span className="flex flex-col items-end">
                              <span className="text-[11px] font-medium text-gray-500 leading-tight">已售</span>
                              <span className="text-lg sm:text-xl font-black text-blue-800 leading-tight">{g.sold.toLocaleString()}</span>
                            </span>
                            <span className="flex flex-col items-end">
                              <span className="text-[11px] font-medium text-gray-500 leading-tight">未售</span>
                              <span className="text-lg sm:text-xl font-black leading-tight text-emerald-600">{g.unsold.toLocaleString()}</span>
                            </span>
                            {g.rate !== null && (
                              <span className="hidden sm:flex flex-col items-end w-32">
                                <span className="text-[11px] font-medium text-gray-500 leading-tight">售出率</span>
                                <span className="flex items-center gap-2 w-full">
                                  <span className="flex-1 h-1.5 rounded-full bg-emerald-200 overflow-hidden">
                                    <span className="block h-full rounded-full bg-blue-500" style={{ width: `${Math.min(100, g.rate * 100)}%` }} />
                                  </span>
                                  <span className="text-xl font-black text-gray-800 leading-tight">{Math.floor(g.rate * 100)}%</span>
                                </span>
                              </span>
                            )}
                          </span>
                          <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
                        </button>
                        {open && (
                          <div className="border-t border-gray-200 p-3 space-y-3">
                            {g.sections.length === 0 && (
                              <p className="text-sm text-gray-400 text-center py-2">此樓層目前沒有可購票的分區</p>
                            )}
                            {g.sections.map(s => (
                              <div key={s.label}>
                                {s.label && <div className="text-xs font-bold text-gray-400 mb-2">{s.label}</div>}
                                <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
                                  {s.rows.map((r, i) => {
                                    const rate = r.sold !== null && r.total ? r.sold / r.total : null;
                                    // 有票：綠框綠底最醒目；完售：白底藍框、數字用藍（＝全部已售）但淡一點；
                                    // 未開放／讀不到：灰色虛線。進度條一律「藍＝已售、綠＝剩下」
                                    const look = {
                                      available: { box: 'border-emerald-400 bg-emerald-50 shadow-sm hover:border-emerald-600', name: 'font-bold text-gray-900', sold: 'text-blue-700', track: 'bg-emerald-200', fill: 'bg-blue-500' },
                                      soldout: { box: 'border-blue-100 bg-white', name: 'font-medium text-gray-500', sold: 'text-blue-600', track: 'bg-blue-100', fill: 'bg-blue-300' },
                                      unknown: { box: 'border-dashed border-gray-300 bg-gray-50', name: 'font-medium text-gray-400', sold: 'text-gray-400', track: 'bg-gray-200', fill: 'bg-gray-300' },
                                    }[r.status];
                                    return (
                                      <div
                                        key={i}
                                        title={[r.zone, r.total !== null ? `座位數 ${r.total.toLocaleString()}` : '', r.note || ''].filter(Boolean).join('\n')}
                                        className={`rounded-xl border px-3 py-2 tabular-nums transition-colors ${look.box}`}
                                      >
                                        <div className={`text-xs truncate ${look.name}`}>{r.zone}</div>
                                        <div className="flex items-baseline justify-between gap-2 mt-1 text-xs">
                                          <span className="text-gray-400">已售 <b className={`text-sm font-semibold ${look.sold}`}>{fmt(r.sold)}</b></span>
                                          {r.status === 'available' ? (
                                            <span className="text-emerald-700">未售 <b className="text-lg font-black leading-none">{fmt(r.unsold)}</b></span>
                                          ) : r.status === 'soldout' ? (
                                            <span className="text-[11px] font-bold text-blue-700 bg-blue-100 rounded px-1.5 py-0.5">完售</span>
                                          ) : (
                                            <span className="text-gray-400">未售 <b className="text-sm font-semibold">{fmt(r.unsold)}</b></span>
                                          )}
                                        </div>
                                        {rate !== null && (
                                          <div className="flex items-center gap-2 mt-1.5">
                                            <div className={`flex-1 h-1.5 rounded-full overflow-hidden ${look.track}`}>
                                              <div className={`h-full rounded-full ${look.fill}`} style={{ width: `${Math.min(100, rate * 100)}%` }} />
                                            </div>
                                            {/* 用 floor 取整：只要還有剩票就不會顯示成 100% */}
                                            <span className="text-[11px] w-8 text-right text-gray-400">{Math.floor(rate * 100)}%</span>
                                          </div>
                                        )}
                                        {r.note && <div className="text-[11px] text-amber-600 truncate mt-1">{r.note}</div>}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Export Button（電腦版改放在結果標題右側） */}
              <div className="pt-2 lg:hidden">
                <button 
                  onClick={handleExport}
                  className="w-full bg-white border-2 border-gray-200 text-gray-800 hover:bg-gray-50 active:bg-gray-100 font-bold text-base rounded-xl p-4 flex items-center justify-center gap-2 transition-colors active:scale-[0.98] shadow-sm"
                >
                  <Download className="w-5 h-5 text-gray-600" />
                  <span>下載各區售票明細 (CSV)</span>
                </button>
              </div>
            </section>
          )}
          </div>

          {/* Staff Config Dialog */}
          {isStaffConfigOpen && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in duration-200">
              <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
                {/* Header */}
                <div className="bg-purple-500 p-4 flex justify-between items-center text-white">
                  <h2 className="font-bold text-lg flex items-center gap-2"><Settings className="w-5 h-5"/> 支援人力設定</h2>
                  <button onClick={() => setIsStaffConfigOpen(false)} className="hover:bg-purple-600 p-1.5 rounded-full transition-colors"><X className="w-5 h-5" /></button>
                </div>
                
                {/* Body */}
                <div className="p-5 overflow-y-auto space-y-4 flex-1 bg-purple-50/30">
                  <p className="text-sm text-gray-500 pb-2 border-b border-gray-100 font-medium">
                    請由小到大依序設定規則。若人數門檻設為 <span className="font-bold text-purple-600">-1</span>，則代表「剩餘的其他數量(無上限)」。
                  </p>
                  
                  <div className="space-y-3">
                    {staffRules.map((rule, index) => (
                      <div key={rule.id} className="flex items-center gap-2 bg-white p-3 rounded-xl border border-gray-200 shadow-sm">
                        <div className="flex-1">
                          <label className="text-xs font-bold text-gray-500 block mb-1">已售出人數 (以內)</label>
                          <input 
                            type="number" 
                            className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-purple-400 focus:outline-none"
                            value={rule.max}
                            onChange={(e) => handleRuleChange(rule.id, 'max', e.target.value)}
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs font-bold text-gray-500 block mb-1">需要支援人力</label>
                          <input 
                            type="number" 
                            className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-purple-400 focus:outline-none"
                            value={rule.count}
                            onChange={(e) => handleRuleChange(rule.id, 'count', e.target.value)}
                          />
                        </div>
                        <button 
                          onClick={() => removeRule(rule.id)}
                          className="mt-5 p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          title="刪除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button 
                    onClick={addRule}
                    className="w-full py-3 border-2 border-dashed border-purple-300 text-purple-600 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-purple-50 active:bg-purple-100 transition-colors mt-2"
                  >
                    <Plus className="w-4 h-4" /> 新增門檻
                  </button>
                </div>
                
                {/* Footer */}
                <div className="p-4 border-t border-gray-100 bg-white">
                   <button 
                     onClick={() => setIsStaffConfigOpen(false)}
                     className="w-full bg-purple-500 text-white font-bold py-3 rounded-xl hover:bg-purple-600 active:scale-[0.98] transition-all"
                   >
                     完成設定
                   </button>
                </div>
              </div>
            </div>
          )}

          {/* Login Modal for WeiChuan */}
          {isLoginModalOpen && (
             <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in duration-200">
                <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden flex flex-col">
                  <div className="bg-red-600 p-4 flex justify-between items-center text-white">
                    <h2 className="font-bold text-lg">請登入味全龍售票系統</h2>
                    <button onClick={() => {setIsLoginModalOpen(false); setLoadingTickets(false);}} className="hover:bg-red-700 p-1.5 rounded-full transition-colors"><X className="w-5 h-5" /></button>
                  </div>

                  <form onSubmit={handleLoginSubmit} className="p-6 space-y-4">
                    {loginError && (
                      <div className="p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
                        {loginError}
                      </div>
                    )}

                    <div className="space-y-1">
                      <label className="text-sm font-bold text-gray-700">帳號</label>
                      <input 
                         required
                         type="text" 
                         value={loginForm.username}
                         onChange={e => setLoginForm({...loginForm, username: e.target.value})}
                         className="w-full border border-gray-300 rounded-xl p-3 focus:ring-2 focus:ring-red-400 focus:outline-none"
                         placeholder="請輸入帳號"
                      />
                    </div>
                    
                    <div className="space-y-1">
                      <label className="text-sm font-bold text-gray-700">密碼</label>
                      <input 
                         required
                         type="password" 
                         value={loginForm.password}
                         onChange={e => setLoginForm({...loginForm, password: e.target.value})}
                         className="w-full border border-gray-300 rounded-xl p-3 focus:ring-2 focus:ring-red-400 focus:outline-none"
                         placeholder="請輸入密碼"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-sm font-bold text-gray-700">驗證碼</label>
                      <div className="flex items-center gap-2">
                        <input 
                           required
                           type="text" 
                           value={loginForm.captcha}
                           onChange={e => setLoginForm({...loginForm, captcha: e.target.value})}
                           className="flex-1 w-full border border-gray-300 rounded-xl p-3 focus:ring-2 focus:ring-red-400 focus:outline-none"
                           placeholder="驗證碼"
                        />
                        {loadingCaptcha ? (
                           <div className="w-24 h-12 bg-gray-100 flex items-center justify-center rounded-xl border border-gray-200">
                             <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                           </div>
                        ) : captchaData?.base64 ? (
                           <div className="relative">
                             <img src={captchaData.base64} alt="captcha" className="h-[48px] w-auto max-w-[100px] object-contain rounded-xl border border-gray-200 bg-white" />
                             <button type="button" onClick={fetchCaptcha} className="absolute -top-2 -right-2 bg-white rounded-full shadow border border-gray-200 p-1 text-gray-500 hover:text-gray-700">
                               <Loader2 className="w-3 h-3" />
                             </button>
                           </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="pt-4">
                      <button 
                         type="submit"
                         disabled={loadingCaptcha || !captchaData || loadingTickets}
                         className="w-full bg-red-600 text-white font-bold py-3 pl-4 pr-4 rounded-xl hover:bg-red-700 active:scale-[0.98] transition-all disabled:opacity-50 shadow-md"
                      >
                         {loadingTickets ? '登入中...' : '送出登入'}
                      </button>
                    </div>
                  </form>
                </div>
             </div>
          )}
        </main>
      </div>
    </div>
  );
}

