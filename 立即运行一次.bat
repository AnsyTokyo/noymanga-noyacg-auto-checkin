@echo off
chcp 936 >nul
cd /d "%~dp0"
echo 正在手动触发一次计划任务（等于让系统现在就跑一遍每天 3:33 的那个任务）……
echo.
schtasks /Run /TN "Noymanga Daily Check-in"
if errorlevel 1 (
  echo.
  echo 触发失败。请右键本文件，选“以管理员身份运行”，再试一次。
  pause
  exit /b 1
)
echo.
echo 已触发。等 10 到 20 秒，右下角应该弹出签到结果通知。
echo 之后可以双击“查看状态.bat”确认结果。
pause
