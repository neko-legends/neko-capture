@echo off
rem neko-capture: double-click to run. First run installs dependencies (~150 MB, needs Node.js).
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies, first run only...
  call npm install || goto :fail
)
call npx electron .
exit /b 0
:fail
echo.
echo *** npm install failed - is Node.js installed? (https://nodejs.org) ***
pause
exit /b 1
