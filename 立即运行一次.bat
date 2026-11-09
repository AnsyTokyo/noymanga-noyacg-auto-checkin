@echo off
chcp 936 >nul
cd /d "%~dp0"
echo 正在结束可能卡住的旧实例……
schtasks /End /TN "Noymanga Daily Check-in" >nul 2>&1
timeout /t 2 /nobreak >nul
echo 正在启动一次签到（无窗口，约 10~40 秒）……
schtasks /Run /TN "Noymanga Daily Check-in"
if errorlevel 1 (
  echo.
  echo 启动失败：请右键本文件，选择「以管理员身份运行」。
) else (
  echo.
  echo 已提交。稍等片刻会弹通知；想看详细日志请双击「查看状态.bat」。
)
pause