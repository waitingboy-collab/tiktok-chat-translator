@echo off
chcp 65001 >nul
title Live Chat Translator
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Download the LTS version from https://nodejs.org and run start.bat again.
  echo.
  pause
  exit /b
)
if not exist "node_modules" (
  echo.
  echo  Installing - first run only, about a minute...
  call npm install --no-fund --no-audit
  if errorlevel 1 ( echo npm install failed - check your internet connection. & pause & exit /b )
)
if not exist ".env" copy ".env.example" ".env" >nul
set OPEN_BROWSER=1
node server.js
pause
