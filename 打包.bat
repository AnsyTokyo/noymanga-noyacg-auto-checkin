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

rem 先试 PATH 里的 git
"%GIT%" --version >nul 2>nul
if errorlevel 1 (
    rem 再试常见的安装位置
    if exist "D:\Git\cmd\git.exe" (
        set "GIT=D:\Git\cmd\git.exe"
    ) else if exist "%ProgramFiles%\Git\cmd\git.exe" (
        set "GIT=%ProgramFiles%\Git\cmd\git.exe"
    ) else if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" (
        set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
    ) else (
        echo [ERROR] 找不到 git。
        echo         请先安装 Git for Windows：https://git-scm.com/download/win
        echo         或者直接手动把整个文件夹压缩成 zip。
        pause
        exit /b 1
    )
)

echo 正在打包...
"%GIT%" archive --format=zip -o "%OUT%" HEAD
if errorlevel 1 (
    echo.
    echo [ERROR] 打包失败。
    echo         请确认：这个文件夹是 git 仓库（有 .git 目录），并且已有提交。
    echo         如果你是从 GitHub 下载的 zip 解压出来的，里面没有 .git，无法打包。
    echo         直接压缩整个文件夹是一样的效果。
    pause
    exit /b 1
)

echo.
echo 打包完成：%OUT%
echo 上传到 GitHub Releases 后，别人点一下就能下载完整包。
pause