@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem Python: prefer the bundled interpreter, fall back to PATH
set "PY=C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PY%" set "PY=python"

echo ============================================================
echo   CHD charger - grab fresh credential
echo ============================================================
echo.
echo   Order matters. Fiddler must be up BEFORE the mini
echo   program sends its request:
echo.
echo     1. wait ~10 s for Fiddler to take over the proxy
echo     2. in WeChat, CLOSE the mini program window (top-right X)
echo     3. re-open it, then pull down to refresh
echo.
echo   Waiting up to 900 s. Closing this window aborts.
echo   If this window dies and the network breaks, run:
echo       python tools\cred_grab.py --fixproxy
echo ============================================================
echo.

"%PY%" tools\cred_grab.py --renew --timeout 900

echo.
echo exit code = %ERRORLEVEL%
echo.
pause
