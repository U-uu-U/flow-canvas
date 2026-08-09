@echo off
setlocal EnableExtensions

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  if "%~1"=="" pause
  exit /b 1
)

set "EXT_ID=%~1"
if "%EXT_ID%"=="" (
  echo Open chrome://extensions, enable Developer mode, and load this folder.
  set /p EXT_ID="Extension ID: "
)
if "%EXT_ID%"=="" (
  echo [ERROR] Extension ID is required.
  pause
  exit /b 1
)

set "HOST_DIR=%~dp0native-host"
set "HOST_MANIFEST=%HOST_DIR%\com.flow.canvas_sync.json"
set "HOST_RUNNER=%HOST_DIR%\run_host.bat"

powershell -NoProfile -Command "$manifest=@{name='com.flow.canvas_sync';description='Flow Canvas browser task sync and download archive host';path='%HOST_RUNNER%';type='stdio';allowed_origins=@('chrome-extension://%EXT_ID%/')} | ConvertTo-Json -Depth 4; [IO.File]::WriteAllText('%HOST_MANIFEST%', $manifest, [Text.UTF8Encoding]::new($false))"
if errorlevel 1 (
  echo [ERROR] Failed to write the Native Host manifest.
  if "%~1"=="" pause
  exit /b 1
)

reg add "HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.flow.canvas_sync" /ve /t REG_SZ /d "%HOST_MANIFEST%" /f >nul
if errorlevel 1 (
  echo [ERROR] Failed to register the Native Host.
  if "%~1"=="" pause
  exit /b 1
)

echo [OK] Native Host registered. Reload the extension in Chrome.
if "%~1"=="" pause
