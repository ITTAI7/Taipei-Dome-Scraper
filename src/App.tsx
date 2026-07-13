import React, { useState, useEffect, useRef } from 'react';
import { Download, Loader2, Search, Ticket, Settings, X, Plus, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';

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

export default function App() {
  const [activeTeam, setActiveTeam] = useState<'brothers' | 'weichuan' | 'fubon' | 'tsg' | 'rakuten' | 'uni' | 'allstar'>('brothers');

  const tabsRef = useRef<HTMLDivElement>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
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
  
  const [showTaipeiDomeOnly, setShowTaipeiDomeOnly] = useState(true);
  
  const [ticketData, setTicketData] = useState<TicketData | null>(null);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [scrapingProgress, setScrapingProgress] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (progressEndRef.current) {
      progressEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [scrapingProgress]);
  
  const [totalSeats, setTotalSeats] = useState(37000);
  const [isTotalSeatsConfigOpen, setIsTotalSeatsConfigOpen] = useState(false);
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
    const newId = Math.random().toString(36).substr(2, 9);
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
    Promise.all([
      fetch('/api/get_games/brothers').then(res => res.json()).then(d => (d.games || []).map((g: Game) => ({...g, platform: 'brothers'}))).catch(() => []),
      fetch('/api/get_games/weichuan').then(res => res.json()).then(d => (d.games || []).map((g: Game) => ({...g, platform: 'weichuan'}))).catch(() => []),
      fetch('/api/get_games/fubon').then(res => res.json()).then(d => (d.games || []).map((g: Game) => ({...g, platform: 'fubon'}))).catch(() => []),
      fetch('/api/get_games/tsg').then(res => res.json()).then(d => (d.games || []).map((g: Game) => ({...g, platform: 'tsg'}))).catch(() => []),
      fetch('/api/get_games/rakuten').then(res => res.json()).then(d => (d.games || []).map((g: Game) => ({...g, platform: 'rakuten'}))).catch(() => []),
      fetch('/api/get_games/uni').then(res => res.json()).then(d => (d.games || []).map((g: Game) => ({...g, platform: 'uni'}))).catch(() => []),
      fetch('/api/get_games/allstar').then(res => res.json()).then(d => (d.games || []).map((g: Game) => ({...g, platform: 'allstar'}))).catch(() => [])
    ]).then(([brothersGames, weichuanGames, fubonGames, tsgGames, rakutenGames, uniGames, allstarGames]) => {
        setAllGames({ brothers: brothersGames, weichuan: weichuanGames, fubon: fubonGames, tsg: tsgGames, rakuten: rakutenGames, uni: uniGames, allstar: allstarGames });
        if (brothersGames.length > 0) {
           setSelectedGame(brothersGames[0].link);
        }
        setLoadingGames(false);
    });
  }, []);

  useEffect(() => {
    // When activeTeam changes, reset selectedGame to the first game of that team
    const currentTeamGamesRaw = allGames[activeTeam] || [];
    const currentTeamGames = activeTeam === 'tsg' && showTaipeiDomeOnly 
        ? currentTeamGamesRaw.filter(g => g.title.includes('大巨蛋'))
        : currentTeamGamesRaw;
        
    if (currentTeamGames.length > 0) {
      setSelectedGame(currentTeamGames[0].link);
    } else {
      setSelectedGame('');
    }
  }, [activeTeam, allGames, showTaipeiDomeOnly]);

  useEffect(() => {
    if (!selectedGame) return;
    const currentTeamGamesRaw = allGames[activeTeam] || [];
    const game = currentTeamGamesRaw.find(g => g.link === selectedGame);
    if (game) {
      if (game.title.includes('大巨蛋')) {
        setTotalSeats(37000);
      } else if (game.title.includes('澄清湖')) {
        setTotalSeats(20000);
      } else if (game.title.includes('嘉義市')) {
        setTotalSeats(10000);
      } else {
        setTotalSeats(37000); // 預設其它
      }
    }
  }, [selectedGame, allGames, activeTeam]);

  const currentGamesForTeamRaw = allGames[activeTeam] || [];
  const currentGamesForTeam = activeTeam === 'tsg' && showTaipeiDomeOnly
    ? currentGamesForTeamRaw.filter(g => g.title.includes('大巨蛋'))
    : currentGamesForTeamRaw;

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
    setScrapingProgress(['開始連線...']);
    setTicketData(null);
    const game = currentGamesForTeam.find(g => g.link === selectedGame);
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
            setScrapingProgress(prev => [...prev, data.message]);
        }
      } catch (err) {}
    });

    eventSource.addEventListener('complete', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.error) throw new Error(data.error);
        setTicketData(data);
      } catch (err: any) {
        setError(err.message || '查詢失敗，請再試一次。');
      }
      setLoadingTickets(false);
      setScrapingProgress([]);
      eventSource.close();
    });

    eventSource.addEventListener('error', (e: any) => {
      let errStr = 'API 發生錯誤，可能因為環境限制或目標網站阻擋';
      try {
        if (e.data) {
          const data = JSON.parse(e.data);
          if (data.code === 401 && platform === 'weichuan') {
             localStorage.removeItem('weichuanSessionToken');
             setIsLoginModalOpen(true);
             fetchCaptcha();
             errStr = '登入狀態已過期，請重新登入';
          } else if (data.error) {
             errStr += `\n詳情: ${data.error}`;
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
    
    csvContent += "區域,未售出票數,已售出票數,備註\n";
    ticketData.details.forEach(row => {
      const zoneName = row.zone.includes(',') ? `"${row.zone}"` : row.zone;
      const total = typeof row.total === 'number' ? row.total : -1;
      const unsold = row.unsold;
      let sold = -1;
      if (typeof row.sold === 'number' && row.sold >= 0) {
         sold = row.sold;
      } else if (total > 0) {
         sold = total - unsold;
      }
      
      let soldStr = sold >= 0 ? sold.toString() : "";
      let errorStr = (row as any).error ? `"${(row as any).error}"` : "";
      csvContent += `${zoneName},${unsold},${soldStr},${errorStr}\n`;
    });

    const globalSold = ticketData.total_sold !== undefined ? ticketData.total_sold : (totalSeats - ticketData.total_unsold);
    csvContent += `總計,${ticketData.total_unsold},${globalSold}\n`;
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.href = encodedUri;
    
    const game = currentGamesForTeam.find(g => g.link === selectedGame);
    const safeTitle = (game?.title || "賽事").replace(/\s|:|vs/g, '_');
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
  
  return (
    <div className="min-h-screen bg-gray-50 flex justify-center text-gray-900 font-sans">
      <div className="w-full max-w-md bg-white min-h-screen shadow-xl overflow-hidden flex flex-col">
        {/* Header */}
        <header className={`p-4 sticky top-0 z-10 flex items-center justify-center gap-2 transition-colors ${activeTeam === 'brothers' ? 'bg-yellow-400 border-b border-yellow-500' : activeTeam === 'weichuan' ? 'bg-red-600 outline-none border-b border-red-700' : activeTeam === 'tsg' ? 'bg-[#00604A] border-b border-[#004A3A]' : activeTeam === 'rakuten' ? 'bg-[#BE1E2D] border-b border-[#9E1824]' : activeTeam === 'uni' ? 'bg-[#EC6A1A] border-b border-[#C55A16]' : activeTeam === 'allstar' ? 'bg-[#D4AF37] border-b border-[#B8960F]' : 'bg-[#004A9C] border-b border-[#003875]'}`}>
          <Ticket className={`w-6 h-6 ${activeTeam === 'brothers' ? 'text-gray-900' : 'text-white'}`} />
          <h1 className={`text-xl font-bold tracking-tight ${activeTeam === 'brothers' ? 'text-gray-900' : 'text-white'}`}>大巨蛋售票極速查詢</h1>
        </header>
        
        {/* Main Content */}
        <main className="flex-1 p-5 space-y-6 pb-10">
          
          {/* Team Selection Tabs - Horizontal Scrollable */}
          <div className="relative group -mx-5 px-5">
            <button
              className="hidden md:flex absolute left-2 top-1/2 -translate-y-1/2 -mt-1 z-10 w-8 h-8 items-center justify-center bg-white/90 backdrop-blur-sm shadow border border-gray-200 rounded-full text-gray-500 hover:text-gray-900 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-0"
              onClick={() => scrollTabs('left')}
              aria-label="Scroll left"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div 
              ref={tabsRef}
              className="flex overflow-x-auto whitespace-nowrap snap-x gap-2 pb-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
            >
              <button
                 className={`snap-start shrink-0 px-8 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'brothers' ? 'bg-yellow-400 text-gray-900 border-yellow-500 shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('brothers'); setTicketData(null); setError(''); }}
              >
                 中信兄弟
              </button>
              <button
                 className={`snap-start shrink-0 px-8 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'weichuan' ? 'bg-red-600 text-white border-red-700 shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('weichuan'); setTicketData(null); setError(''); }}
              >
                 味全龍
              </button>
              <button
                 className={`snap-start shrink-0 px-8 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'fubon' ? 'bg-[#004A9C] text-white border-[#003875] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('fubon'); setTicketData(null); setError(''); }}
              >
                 富邦悍將
              </button>
              <button
                 className={`snap-start shrink-0 px-8 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'tsg' ? 'bg-[#00604A] text-white border-[#004A3A] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('tsg'); setTicketData(null); setError(''); }}
              >
                 台鋼雄鷹
              </button>
              <button
                 className={`snap-start shrink-0 px-8 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'rakuten' ? 'bg-[#BE1E2D] text-white border-[#9E1824] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('rakuten'); setTicketData(null); setError(''); }}
              >
                  樂天
              </button>
              <button
                 className={`snap-start shrink-0 px-8 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'uni' ? 'bg-[#EC6A1A] text-white border-[#C55A16] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('uni'); setTicketData(null); setError(''); }}
              >
                  統一獅
              </button>
              <button
                 className={`snap-start shrink-0 px-8 py-3 text-sm font-bold rounded-full transition-all border ${activeTeam === 'allstar' ? 'bg-[#D4AF37] text-white border-[#B8960F] shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                 onClick={() => { setActiveTeam('allstar'); setTicketData(null); setError(''); }}
              >
                  職棒明星賽
              </button>
            </div>
            <button
              className="hidden md:flex absolute right-2 top-1/2 -translate-y-1/2 -mt-1 z-10 w-8 h-8 items-center justify-center bg-white/90 backdrop-blur-sm shadow border border-gray-200 rounded-full text-gray-500 hover:text-gray-900 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-0"
              onClick={() => scrollTabs('right')}
              aria-label="Scroll right"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          {/* Query Section */}
          <section className="space-y-4">
            
            {activeTeam === 'tsg' && (
              <label className="flex items-center space-x-2 text-sm text-gray-700 select-none cursor-pointer">
                 <input 
                   type="checkbox" 
                   checked={showTaipeiDomeOnly}
                   onChange={(e) => setShowTaipeiDomeOnly(e.target.checked)}
                   className="w-4 h-4 text-[#00604A] border-gray-300 rounded focus:ring-[#00604A]"
                 />
                 <span>僅顯示臺北大巨蛋場次</span>
              </label>
            )}

            <div className="relative border-b border-gray-100 pb-2">
              {loadingGames ? (
                 <div className="w-full bg-gray-100 border border-gray-200 text-gray-500 rounded-xl p-4 flex items-center justify-center gap-2 animate-pulse">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>載入賽事中...</span>
                 </div>
              ) : (
                <div className="space-y-4">
                  <div className="relative">
                    <select 
                      value={selectedGame}
                      onChange={(e) => setSelectedGame(e.target.value)}
                      className={`w-full bg-gray-50 border text-gray-900 rounded-xl p-4 appearance-none focus:outline-none focus:ring-2 font-semibold text-[15px] shadow-sm pr-10 ${activeTeam === 'brothers' ? 'border-gray-300 focus:ring-yellow-400 focus:border-yellow-400' : activeTeam === 'weichuan' ? 'border-gray-300 focus:ring-red-500 focus:border-red-500' : activeTeam === 'tsg' ? 'border-gray-300 focus:ring-[#00604A] focus:border-[#00604A]' : activeTeam === 'rakuten' ? 'border-gray-300 focus:ring-[#BE1E2D] focus:border-[#BE1E2D]' : 'border-gray-300 focus:ring-[#004A9C] focus:border-[#004A9C]'}`}
                    >
                      {currentGamesForTeam.length === 0 ? (
                        <option disabled value="">無資料或尚未開賣</option>
                      ) : (
                        currentGamesForTeam.map((g, i) => (
                          <option key={i} value={g.link}>{g.title}</option>
                        ))
                      )}
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-gray-500">
                      <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
                    </div>
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
                  
                  {/* Scraping Progress Tracker */}
                  {loadingTickets && scrapingProgress.length > 0 && (
                     <div className="mt-4 p-4 rounded-xl bg-gray-50 border border-gray-200 shadow-inner flex flex-col gap-2 max-h-48 overflow-y-auto">
                        <div className="text-xs font-bold text-gray-400 mb-1 flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
                          系統狀態
                        </div>
                        {scrapingProgress.map((msg, idx) => (
                           <div key={idx} className="flex gap-2 text-sm text-gray-700 animate-in fade-in slide-in-from-left-2 duration-300">
                             <span className="text-gray-400 font-mono flex-shrink-0">
                               {new Date().toLocaleTimeString('en-US', {hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit'})}
                             </span>
                             <span className={idx === scrapingProgress.length - 1 ? "font-medium text-gray-900" : ""}>{msg}</span>
                           </div>
                        ))}
                        <div ref={progressEndRef} />
                     </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Error Message */}
          {error && (
            <div className="p-4 bg-red-50 border-l-4 border-red-500 text-red-700 rounded-lg text-sm font-medium">
               {error}
            </div>
          )}

          {/* Results Section */}
          {ticketData && (
            <section className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <span className="w-1.5 h-6 bg-yellow-400 rounded-full inline-block"></span>
                預估動態數據
              </h2>
              
              <div className="grid grid-cols-2 gap-3">
                {/* Card 1: Sold */}
                <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 p-5 rounded-2xl flex flex-col justify-between shadow-sm relative group">
                  <div className="flex justify-between items-center">
                    <span className="text-blue-700 text-sm font-bold tracking-wide opacity-90">已售出(人)</span>
                    {ticketData.total_sold === undefined && (
                      <button 
                        onClick={() => setIsTotalSeatsConfigOpen(true)}
                        className="p-1.5 text-blue-600 hover:bg-blue-200 hover:text-blue-800 rounded-full transition-colors"
                        title="設定總票數"
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <span className="text-4xl font-black text-blue-900 mt-2">
                    {(ticketData.total_sold !== undefined ? ticketData.total_sold : (totalSeats - ticketData.total_unsold)).toLocaleString()}
                  </span>
                </div>
                
                {/* Card 2: Unsold */}
                <div className="bg-gradient-to-br from-gray-50 to-gray-200 border border-gray-300 p-5 rounded-2xl flex flex-col justify-between shadow-sm">
                  <span className="text-gray-600 text-sm font-bold tracking-wide opacity-90">未售出(張)</span>
                  <span className="text-4xl font-black text-gray-800 mt-2">
                    {ticketData.total_unsold.toLocaleString()}
                  </span>
                </div>

                {/* Card 3: Support Staff */}
                <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 border border-emerald-200 p-5 rounded-2xl flex flex-col justify-between shadow-sm relative group">
                  <div className="flex justify-between items-center">
                    <span className="text-emerald-700 text-sm font-bold tracking-wide opacity-90">支援人力(人)</span>
                    <button 
                      onClick={() => setIsStaffConfigOpen(true)}
                      className="p-1.5 text-emerald-600 hover:bg-emerald-200 hover:text-emerald-800 rounded-full transition-colors"
                      title="設定支援人力規則"
                    >
                      <Settings className="w-4 h-4" />
                    </button>
                  </div>
                  <span className="text-4xl font-black text-emerald-900 mt-2">
                    {getSupportStaffCount(ticketData.total_sold !== undefined ? ticketData.total_sold : (totalSeats - ticketData.total_unsold))}
                  </span>
                </div>

                {/* Card 4: Clearing Time */}
                <div className="bg-gradient-to-br from-orange-50 to-orange-100 border border-orange-200 p-5 rounded-2xl flex flex-col justify-between shadow-sm">
                  <span className="text-orange-700 text-sm font-bold tracking-wide opacity-90">疏運時間(分)</span>
                  <span className="text-4xl font-black text-orange-900 mt-2">
                    {10 + Math.ceil((ticketData.total_sold !== undefined ? ticketData.total_sold : (totalSeats - ticketData.total_unsold)) / 500)}
                  </span>
                </div>
              </div>
              <div className="text-xs text-center text-gray-500 mt-2 font-medium">
                 * 上述總數與試算已包含所有區塊（含「熱賣中」區塊）的未售出精確計算
              </div>

              {/* Export Button */}
              <div className="pt-2">
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
          {/* Total Seats Config Dialog */}
          {isTotalSeatsConfigOpen && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in duration-200">
              <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden flex flex-col">
                {/* Header */}
                <div className="bg-blue-500 p-4 flex justify-between items-center text-white">
                  <h2 className="font-bold text-lg flex items-center gap-2"><Ticket className="w-5 h-5"/> 總票數設定</h2>
                  <button onClick={() => setIsTotalSeatsConfigOpen(false)} className="hover:bg-blue-600 p-1.5 rounded-full transition-colors"><X className="w-5 h-5" /></button>
                </div>
                
                {/* Body */}
                <div className="p-6 space-y-4 bg-blue-50/30">
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700 block">全場座位總數</label>
                    <input 
                      type="number" 
                      className="w-full border border-gray-300 rounded-xl p-3 text-lg font-bold focus:ring-2 focus:ring-blue-400 focus:outline-none shadow-sm"
                      value={totalSeats}
                      onChange={(e) => setTotalSeats(parseInt(e.target.value, 10) || 0)}
                      autoFocus
                    />
                    <p className="text-xs text-gray-500">
                      此數值將用於計算「已售出人數」、「支援人力」以及「疏運時間」。
                    </p>
                  </div>
                </div>
                
                {/* Footer */}
                <div className="p-4 border-t border-gray-100 bg-white">
                   <button 
                     onClick={() => setIsTotalSeatsConfigOpen(false)}
                     className="w-full bg-blue-500 text-white font-bold py-3 rounded-xl hover:bg-blue-600 active:scale-[0.98] transition-all shadow-md"
                   >
                     完成設定
                   </button>
                </div>
              </div>
            </div>
          )}

          {/* Staff Config Dialog */}
          {isStaffConfigOpen && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in duration-200">
              <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
                {/* Header */}
                <div className="bg-emerald-500 p-4 flex justify-between items-center text-white">
                  <h2 className="font-bold text-lg flex items-center gap-2"><Settings className="w-5 h-5"/> 支援人力設定</h2>
                  <button onClick={() => setIsStaffConfigOpen(false)} className="hover:bg-emerald-600 p-1.5 rounded-full transition-colors"><X className="w-5 h-5" /></button>
                </div>
                
                {/* Body */}
                <div className="p-5 overflow-y-auto space-y-4 flex-1 bg-emerald-50/30">
                  <p className="text-sm text-gray-500 pb-2 border-b border-gray-100 font-medium">
                    請由小到大依序設定規則。若人數門檻設為 <span className="font-bold text-emerald-600">-1</span>，則代表「剩餘的其他數量(無上限)」。
                  </p>
                  
                  <div className="space-y-3">
                    {staffRules.map((rule, index) => (
                      <div key={rule.id} className="flex items-center gap-2 bg-white p-3 rounded-xl border border-gray-200 shadow-sm">
                        <div className="flex-1">
                          <label className="text-xs font-bold text-gray-500 block mb-1">已售出人數 (以內)</label>
                          <input 
                            type="number" 
                            className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-emerald-400 focus:outline-none"
                            value={rule.max}
                            onChange={(e) => handleRuleChange(rule.id, 'max', e.target.value)}
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs font-bold text-gray-500 block mb-1">需要支援人力</label>
                          <input 
                            type="number" 
                            className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-emerald-400 focus:outline-none"
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
                    className="w-full py-3 border-2 border-dashed border-emerald-300 text-emerald-600 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-emerald-50 active:bg-emerald-100 transition-colors mt-2"
                  >
                    <Plus className="w-4 h-4" /> 新增門檻
                  </button>
                </div>
                
                {/* Footer */}
                <div className="p-4 border-t border-gray-100 bg-white">
                   <button 
                     onClick={() => setIsStaffConfigOpen(false)}
                     className="w-full bg-emerald-500 text-white font-bold py-3 rounded-xl hover:bg-emerald-600 active:scale-[0.98] transition-all"
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

