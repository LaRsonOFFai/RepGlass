@echo off
setlocal

cd /d "%~dp0\.."

if not exist "%LOCALAPPDATA%\RepGlass" mkdir "%LOCALAPPDATA%\RepGlass"

npm start >> "%LOCALAPPDATA%\RepGlass\repglass-hidden.log" 2>&1
