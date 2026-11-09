@echo off
chcp 936 >nul
cd /d "%~dp0"
echo 正在结束卡住的计划任务实例……
schtasks /End /TN "Noymanga Daily Check-in" >nul 2>&1
echo.
echo 正在查找上一次运行留下的浏览器进程……
node "%~dp0noymanga-auto-checkin-v2.js" --cleanup
echo.
echo 完成后，请双击「立即运行一次.bat」再试。
pause