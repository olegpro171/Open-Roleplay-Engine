@echo off
setlocal DisableDelayedExpansion
echo ORE - starting your roleplay app
echo We will check for updates, build if needed, then start the app.
echo First-time setup can take several minutes. Progress and any errors appear below.
echo.
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\release\start-windows.ps1" %*
set "ore_status=%errorlevel%"
if not "%ore_status%"=="0" if not defined ORE_NO_PAUSE pause
exit /b %ore_status%
