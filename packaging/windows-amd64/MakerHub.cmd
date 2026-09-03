@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0makerhub.ps1" %*
if errorlevel 1 (
  echo.
  echo MakerHub command failed. Press any key to close.
  pause >nul
  exit /b 1
)
endlocal
