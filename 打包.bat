@echo off
rem ============================================================
rem  打包：生成 noymanga-auto-checkin.zip
rem    - 在 git 仓库里运行：用 git archive，只打包已提交的文件
rem    - 在普通文件夹里运行：直接压缩当前文件夹
rem    - 两种情况都会排除 browser-profile/logs/status.txt/config.json
rem ============================================================
chcp 936 >nul
setlocal
cd /d "%~dp0"

set "OUT=%~dp0noymanga-auto-checkin.zip"
set "GIT=git"

if exist ".git" (
    "%GIT%" --version >nul 2>nul
    if errorlevel 1 (
        if exist "D:\Git\cmd\git.exe" set "GIT=D:\Git\cmd\git.exe"
        if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
        if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
    )
    "%GIT%" --version >nul 2>nul
    if not errorlevel 1 (
        echo 正在打包（git archive，只含已提交的文件）...
        "%GIT%" archive --format=zip -o "%OUT%" HEAD
        if not errorlevel 1 goto done
    )
)

echo 当前文件夹不是 git 仓库，改为直接压缩这个文件夹...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(Get-Location).Path; $o=Join-Path $s 'noymanga-auto-checkin.zip'; Remove-Item -LiteralPath $o -Force -ErrorAction SilentlyContinue; $x=@('browser-profile','logs','status.txt','config.json','noymanga-auto-checkin.zip'); $i=Get-ChildItem -LiteralPath $s -Force | Where-Object { $x -notcontains $_.Name }; if (-not $i) { exit 1 }; Compress-Archive -LiteralPath $i.FullName -DestinationPath $o -Force"
if errorlevel 1 (
    echo.
    echo [ERROR] 压缩失败。
    pause
    exit /b 1
)

:done
echo.
echo 打包完成：%OUT%
echo 上传到 GitHub Releases 后，别人点一下就能下载完整包。
pause