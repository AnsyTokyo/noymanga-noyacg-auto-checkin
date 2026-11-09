@echo off
rem ============================================================
rem  把当前已提交的版本打成 zip，用来上传到 GitHub Releases
rem  生成的 noymanga-auto-checkin.zip 只包含仓库里的文件，
rem  不会带上 browser-profile（登录态）、logs、status.txt、config.json。
rem ============================================================
chcp 936 >nul
setlocal
cd /d "%~dp0"

set "OUT=%~dp0noymanga-auto-checkin.zip"
set "GIT=git"
where git >nul 2>nul
if errorlevel 1 set "GIT=D:\Git\cmd\git.exe"
if not exist "%GIT%" (
    echo [ERROR] 找不到 git。请先安装 Git for Windows，或手工打包。
    pause
    exit /b 1
)

echo 正在打包...
"%GIT%" archive --format=zip -o "%OUT%" HEAD
if errorlevel 1 (
    echo.
    echo [ERROR] 打包失败。请确认当前目录是 git 仓库，且已有提交。
    pause
    exit /b 1
)

echo.
echo 打包完成：%OUT%
echo 上传到 GitHub Releases 后，别人点一下就能下载完整包。
pause
