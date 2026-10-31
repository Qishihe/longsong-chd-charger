@echo off
REM ============================================================
REM  Cloudflare Pages one-click deploy (added 2026-10-29)
REM
REM  WHY NOT THE WEB UI:
REM  The dashboard drag-and-drop upload keeps stalling at
REM  "3/24 files uploaded". It is not bandwidth: the same machine
REM  pushes 1.5 MB to api.cloudflare.com in 3 s via curl. The
REM  browser multipart channel just gives up mid-flight.
REM  Wrangler goes through the Pages API instead and finishes in
REM  about 4 seconds.
REM
REM  Also: drag-and-drop only accepts ONE zip or ONE folder.
REM  Dropping 24 loose files plus a zip silently fails.
REM
REM  PREREQ: OAuth token in %APPDATA%\xdg.config\.wrangler
REM          (run "wrangler login --device" once to create it)
REM ============================================================

setlocal
set KIT=%~dp0..
set WR=C:\Users\Administrator\.wrangler-cli\node_modules\.bin\wrangler.cmd

if not exist "%WR%" (
  echo [ERROR] wrangler not found at %WR%
  echo Install it with:
  echo   npm i wrangler --prefix "C:\Users\Administrator\.wrangler-cli" --registry=https://registry.npmmirror.com
  pause
  exit /b 1
)

cd /d "%KIT%"

echo [1/3] Repacking dist-cloudflare.zip ...
python tools\make_cloudflare.py
if errorlevel 1 goto fail

echo.
echo [2/3] Deploying to production (branch=main) ...
"%WR%" pages deploy dist-cloudflare --project-name=chd-charge --branch=main --commit-dirty=true
if errorlevel 1 goto fail

echo.
echo [3/3] Verifying live version ...
curl -sSL "https://chd-charge.pages.dev/?_t=%RANDOM%" | findstr /C:"version v" >nul
echo Done. Open https://chd-charge.pages.dev/ and hard-refresh.
pause
exit /b 0

:fail
echo.
echo [FAILED] See the error above.
pause
exit /b 1
