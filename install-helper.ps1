# 安装 / 卸载「Noymanga 通知助手」
# ============================================================
# 作用：把 notify-helper.ps1 放进「启动」文件夹，让你每次登录时它自动运行，
#       之后签到脚本就能把结果交给它，由它在右下角弹出通知。
#
# 用法（一般通过 启用通知助手.bat 调用）：
#   -ExecutionPolicy Bypass -File install-helper.ps1
#   -ExecutionPolicy Bypass -File install-helper.ps1 -Uninstall

param(
    [switch]$Uninstall,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$root         = Split-Path -Parent $PSCommandPath
$helper       = Join-Path $root 'notify-helper.ps1'
$pidFile      = Join-Path $root 'logs\notify-helper.pid'
$selfLog      = Join-Path $root 'logs\notify-helper.log'
$startupDir   = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'Noymanga Notify Helper.lnk'

function Stop-Helper {
    if (Test-Path -LiteralPath $pidFile) {
        $oldPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($oldPid -match '^\d+$') {
            Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue
            Write-Host '  Stopped the running helper.' -ForegroundColor DarkGray
        }
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
}

if ($Uninstall) {
    Stop-Helper
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
        Write-Host '  Removed the startup shortcut.' -ForegroundColor DarkGray
    }
    Write-Host 'Notification helper removed.' -ForegroundColor Green
    return
}

if (-not (Test-Path -LiteralPath $helper)) {
    Write-Host "notify-helper.ps1 was not found next to this script." -ForegroundColor Red
    exit 1
}

$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source

Write-Host 'Installing the notification helper...' -ForegroundColor Cyan

# 1. 启动文件夹里的快捷方式：每次登录自动拉起助手
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShellPath
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $helper + '"'
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7
$shortcut.Description = 'Noymanga check-in notification helper'
$shortcut.Save()
Write-Host ('  Startup shortcut: ' + $shortcutPath) -ForegroundColor DarkGray

# 2. 立刻启动一个，不用等下次登录
Stop-Helper
Start-Process -FilePath $powerShellPath `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $helper) `
    -WindowStyle Hidden
Start-Sleep -Seconds 2

if (Test-Path -LiteralPath $pidFile) {
    $newPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    Write-Host ('  Helper is running (pid ' + $newPid + ').') -ForegroundColor Green
} else {
    Write-Host '  Helper did not start in time; it will still run at your next sign-in.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Done. Future check-in results will pop up in the bottom-right corner.' -ForegroundColor Green
if (Test-Path -LiteralPath $selfLog) {
    Write-Host ('  Helper log: ' + $selfLog) -ForegroundColor DarkGray
}
