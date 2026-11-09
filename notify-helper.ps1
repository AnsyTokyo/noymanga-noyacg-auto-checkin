# Noymanga 通知助手
# ============================================================
# 为什么需要它：
#   由「计划任务」启动的进程没有桌面窗口站，Windows 会丢弃它发出的通知。
#   这个助手在你自己登录时由「启动」文件夹拉起，一直待在桌面会话里，
#   所以它弹出的通知一定能显示在右下角。
#
# 工作方式：
#   签到脚本把要弹的内容写进 logs\notify-queue.log（每行「标题|内容」），
#   助手每 2 秒检查一次，取走并弹出来。
#
# 这个文件不需要你手动运行，由 启用通知助手.bat 安装。

$ErrorActionPreference = 'SilentlyContinue'

$root     = Split-Path -Parent $PSCommandPath
$logDir   = Join-Path $root 'logs'
$queue    = Join-Path $logDir 'notify-queue.log'
$pidFile  = Join-Path $logDir 'notify-helper.pid'
$selfLog  = Join-Path $logDir 'notify-helper.log'
$appId    = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-SelfLog([string]$text) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $text
    Add-Content -LiteralPath $selfLog -Value $line -Encoding UTF8
}

function Show-Toast([string]$title, [string]$message) {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] > $null

    $safeTitle   = [System.Security.SecurityElement]::Escape($title)
    $safeMessage = [System.Security.SecurityElement]::Escape($message)
    $xml = '<toast><visual><binding template="ToastGeneric"><text>' + $safeTitle + '</text><text>' + $safeMessage + '</text></binding></visual></toast>'

    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
    $notifier.Show($toast)
}

# 同一个助手只留一个：如果 pid 文件里的旧助手还活着，先请它退场
if (Test-Path -LiteralPath $pidFile) {
    $oldPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($oldPid -match '^\d+$' -and [int]$oldPid -ne $PID) {
        $existing = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
        if ($existing) {
            Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }
}
Set-Content -LiteralPath $pidFile -Value $PID -Encoding ASCII
Write-SelfLog "Helper started (pid $PID)."

while ($true) {
    if (Test-Path -LiteralPath $queue) {
        $lines = @(Get-Content -LiteralPath $queue -Encoding UTF8)
        Remove-Item -LiteralPath $queue -Force -ErrorAction SilentlyContinue
        foreach ($line in $lines) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line.Split('|', 2)
            $title = if ($parts.Count -ge 1) { $parts[0] } else { 'Noymanga' }
            $body  = if ($parts.Count -ge 2) { $parts[1] } else { '' }
            try {
                Show-Toast $title $body
                Write-SelfLog "Shown: $title - $body"
            } catch {
                Write-SelfLog ('Failed: ' + $_.Exception.Message)
            }
            Start-Sleep -Milliseconds 800
        }
    }
    Start-Sleep -Seconds 2
}
