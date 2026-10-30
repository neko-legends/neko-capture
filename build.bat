@echo off
rem Package neko-capture into a standalone app: dist\neko-capture-win32-x64\neko-capture.exe
rem (Not needed to run it - start.bat runs straight from source. Use this for a double-clickable .exe.)
cd /d "%~dp0"
echo Installing/updating dependencies...
call npm install || goto :fail
echo Packaging...
call npm run build || goto :fail
echo.
echo Done: %~dp0dist\neko-capture-win32-x64\neko-capture.exe
start "" "%~dp0dist\neko-capture-win32-x64"
exit /b 0
:fail
echo.
echo *** Build failed - copy the error above and send it to Claude. ***
pause
exit /b 1
