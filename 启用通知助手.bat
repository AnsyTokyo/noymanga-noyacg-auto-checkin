@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ============================================================
echo   安装「Noymanga 通知助手」
echo ============================================================
echo.
echo 作用：签到完成后在右下角弹出通知（计划任务自己弹不出来，只能由助手代发）。
echo 安装后它会在每次登录时自动运行，不显示任何窗口。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-helper.ps1"
echo.
pause