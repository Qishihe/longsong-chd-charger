@echo off
setlocal
cd /d "%~dp0.."

echo ==========================================
echo  Worker tests (offline, no real requests)
echo ==========================================
echo.

echo [1/2] pile budget / demotion / recovery
node scratch\test_pile_budget.mjs
set RC1=%ERRORLEVEL%
echo.

echo [2/2] server-side credential routing
node scratch\test_worker_servercred.mjs
set RC1B=%RC1%
set RC2=%ERRORLEVEL%
echo.

if "%RC1B%"=="0" if "%RC2%"=="0" goto PASS
echo ------------------------------------------
echo  SOME TESTS FAILED   budget=%RC1B%  cred=%RC2%
echo  Do NOT deploy until these are fixed.
echo ------------------------------------------
echo.
pause
exit /b 1

:PASS
echo ------------------------------------------
echo  ALL PASSED   (exit code 0)
echo ------------------------------------------
echo.
pause
exit /b 0
