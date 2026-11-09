@echo off
chcp 936 >nul
cd /d "%~dp0"
echo 正在以前台方式运行，可以看到完整日志……
echo （正常运行时是看不到这个窗口的，这里是为了排查问题）
echo.
node "%~dp0noymanga-auto-checkin-v2.js"
echo.
echo 退出码：%ERRORLEVEL%
pause