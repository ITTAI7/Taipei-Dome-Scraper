@echo off

set PROJECT_DIR=d:\Python\TAIPEI_DOME_SCRAPER

echo ============================================
echo   Taipei Dome Scraper - Startup Script
echo ============================================
echo.

echo [1/3] Cleaning up lingering Node.js processes of this project...
REM 只關掉「命令列含本專案路徑」的 node（tsx watch、server、localtunnel），
REM 不再 taskkill 全部 node.exe，避免誤殺其他專案或工具的 node 程序。
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*%PROJECT_DIR%\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo.

echo [2/3] Starting Scraper Server on port 3000 (watch mode: 存檔即自動重啟)...
start "Scraper Server" cmd /k "cd /d %PROJECT_DIR% && npx tsx watch server.ts 2>&1"
echo.

echo Waiting 5 seconds for Vite to optimize dependencies and server to initialize...
timeout /t 5 /nobreak >nul
echo.

echo [3/3] Starting Localtunnel (mapping port 3000)...
start "Localtunnel" cmd /k "cd /d %PROJECT_DIR% && npx lt --port 3000"
echo.

echo ============================================
echo   All services launched!
echo   - Scraper Server: http://localhost:3000
echo   - Localtunnel:    (check its window for the public URL)
echo ============================================
echo.
echo Close this window or press any key to exit...
pause >nul