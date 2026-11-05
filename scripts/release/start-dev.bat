@echo off
setlocal DisableDelayedExpansion
echo ORE - building and starting the current working tree
echo.
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0start-dev-windows.ps1" %*
set "ore_status=%errorlevel%"
if not "%ore_status%"=="0" if not defined ORE_NO_PAUSE pause
exit /b %ore_status%
