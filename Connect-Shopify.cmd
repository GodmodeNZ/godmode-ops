@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 LTS or newer, then run this file again.
  pause
  exit /b 1
)
node scripts/connect-shopify.mjs
pause
