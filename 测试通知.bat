@echo off
chcp 936 >nul
cd /d "%~dp0"
echo 正在发送一条测试通知……
node "%~dp0noymanga-auto-checkin-v2.js" --notify-test
echo.
echo 如果右下角没有弹出通知，把上面的提示发给我。
pause
