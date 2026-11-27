@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0recover-windows.ps1" %*
set "ore_status=%errorlevel%"
if not "%ore_status%"=="0" if not defined ORE_NO_PAUSE pause
exit /b %ore_status%
