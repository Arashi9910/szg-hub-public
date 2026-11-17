@echo off
cd /d "%~dp0"
set PORT=8787
set "NODE=node"
where node >NUL 2>NUL && goto found
if exist "%ProgramFiles%\nodejs\node.exe" (set "NODE=%ProgramFiles%\nodejs\node.exe" & goto found)
if exist "%ProgramFiles(x86)%\nodejs\node.exe" (set "NODE=%ProgramFiles(x86)%\nodejs\node.exe" & goto found)
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe" & goto found)
echo.
echo [ERROR] Node.js not found. Please restart your PC after installing Node.js LTS, then run this file again.
echo.
pause
exit /b
:found
echo Using: %NODE%
start "" http://127.0.0.1:%PORT%
:run
"%NODE%" update.js
"%NODE%" server.js
if %ERRORLEVEL%==3 (echo Restarting after update... & goto run)
echo.
echo Server stopped. If you see an error above, take a screenshot.
pause
