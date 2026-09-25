@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Game.ps1"
set "ROTW_EXIT=%errorlevel%"
if not "%ROTW_EXIT%"=="0" (
  echo.
  echo Launcher pozostanie otwarty, aby mozna bylo przeczytac blad.
  pause
)
exit /b %ROTW_EXIT%
