@echo off

set PROJECT_DIR=d:\Python\TAIPEI_DOME_SCRAPER

echo ============================================
echo   Taipei Dome Scraper - Startup Script
echo ============================================
echo.

echo [1/3] Cleaning up lingering Node.js processes...
taskkill /F /IM node.exe /T 2>nul
echo.

echo [2/3] Starting Scraper Server on port 3000...
start "Scraper Server" cmd /k "cd /d %PROJECT_DIR% && npx tsx server.ts 2>&1"
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