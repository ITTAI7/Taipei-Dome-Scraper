@echo off

set PROJECT_DIR=d:\Python\TAIPEI_DOME_SCRAPER

echo ============================================
echo   Taipei Dome Scraper - Startup Script
echo ============================================
echo.

echo [1/3] Cleaning up lingering Node.js processes of this project...
REM 只關掉「命令列含本專案路徑」的 node（tsx watch、server，以及舊版留下的 localtunnel），
REM 不再 taskkill 全部 node.exe，避免誤殺其他專案或工具的 node 程序。
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*%PROJECT_DIR%\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo.

echo [2/3] Starting Scraper Server on port 3000 (watch mode: 存檔即自動重啟)...
start "Scraper Server" cmd /k "cd /d %PROJECT_DIR% && npx tsx watch server.ts 2>&1"
echo.

echo [3/3] Waiting for the server, then opening http://localhost:3000 ...
REM 不再開 localtunnel 對外網址（2026-10-15 起只在本機使用）。
REM 改成等伺服器的 port 3000 真的接得通才開瀏覽器（最多等 60 秒），不用固定等幾秒猜；
REM 用 TCP 連線檢查，不走 HTTP，避免被公司 proxy 設定影響。用截止時間算 60 秒（Windows 連不上的 port
REM 每次要 2～3 秒才失敗，用次數算會拖到好幾分鐘）。逾時也照樣開，頁面沒出來就重新整理。
powershell -NoProfile -Command "$end = (Get-Date).AddSeconds(60); while ((Get-Date) -lt $end) { try { (New-Object Net.Sockets.TcpClient('127.0.0.1', 3000)).Close(); exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if errorlevel 1 echo   Server not ready after 60 seconds - refresh the page once it starts.
start "" http://localhost:3000
echo.

echo ============================================
echo   Ready: http://localhost:3000
echo ============================================
echo.
echo Close this window or press any key to exit...
pause >nul
