@echo off
chcp 65001 >nul
title FlowCanvas
cd /d "%~dp0"
echo.
echo   FlowCanvas - Starting Electron App...
echo.
npm run electron:dev
