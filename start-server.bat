@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing server packages for the first time...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
call npm start
pause
