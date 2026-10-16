@echo off
rem Runs the sidekick CLI with SideKick's own runtime. The installer puts this folder on PATH.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\SideKick.exe" "%~dp0..\resources\app.asar\out\main\cli.js" %*
exit /b %ERRORLEVEL%
