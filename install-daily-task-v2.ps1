#
# Noymanga 每日自动签到 —— 安装 / 修改 / 登录 / 查看 / 取消 / 卸载
#
# 用法（双击 bat 更省事）：
#   .\install-daily-task-v2.ps1                   交互式安装向导
#   .\install-daily-task-v2.ps1 -Time 08:30       指定签到时间
#   .\install-daily-task-v2.ps1 -Time 07:15 -NoCatchUp
#   .\install-daily-task-v2.ps1 -Status           查看上次结果
#   .\install-daily-task-v2.ps1 -Login            重新登录
#   .\install-daily-task-v2.ps1 -RemoveTask       取消自动签到（保留脚本和登录态）
#   .\install-daily-task-v2.ps1 -Uninstall        卸载（删任务 + 删通知协议）
#
[CmdletBinding()]
param(
    [string]$Time,
    [switch]$NoCatchUp,
    [switch]$Status,
    [switch]$Uninstall,
    [switch]$RemoveTask,
    [switch]$Login,
    [switch]$Quiet,
    [switch]$DryRun,
    [switch]$ElevatedOk
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $PSCommandPath
$scriptPath = Join-Path $scriptDir 'noymanga-auto-checkin-v2.js'
$profileDir = Join-Path $scriptDir 'browser-profile'
$statusFile = Join-Path $scriptDir 'status.txt'
$logDir = Join-Path $scriptDir 'logs'
$taskName = 'Noymanga Daily Check-in'

# ---------------------------------------------------------------
# 管理员权限：安装 / 取消签到 / 卸载 需要写计划任务，Windows 会要求提权。
# 这里自动判断并弹一次 UAC，所以「双击 → 点『是』」就够了，不用右键。
# ---------------------------------------------------------------
function Test-IsElevated {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

$needsAdmin = $RemoveTask -or $Uninstall -or (-not ($Status -or $Login -or $DryRun))
if ($needsAdmin -and -not $ElevatedOk -and -not (Test-IsElevated)) {
    $forward = @()
    if ($Time) { $forward += @('-Time', $Time) }
    if ($NoCatchUp) { $forward += '-NoCatchUp' }
    if ($RemoveTask) { $forward += '-RemoveTask' }
    if ($Uninstall) { $forward += '-Uninstall' }
    if ($Quiet) { $forward += '-Quiet' }
    $argumentList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-ElevatedOk') + $forward

    Write-Host ''
    Write-Host '  正在请求管理员权限……' -ForegroundColor Yellow
    Write-Host '  如果弹出「你要允许此应用对你的设备进行更改吗？」，点「是」即可。' -ForegroundColor DarkGray
    Write-Host '  同意后，接下来的操作会在新窗口里继续进行。' -ForegroundColor DarkGray
    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -Verb RunAs | Out-Null
        Start-Sleep -Milliseconds 600
    } catch {
        Write-Host ''
        Write-Host '  提权被取消（或者系统不允许），安装没有完成。' -ForegroundColor Red
        Write-Host ('  详情：' + $_.Exception.Message)
        if (-not $Quiet) { Read-Host ' 按回车键关闭' | Out-Null }
        exit 1
    }
    exit 0
}
function Write-Head($text) {
    Write-Host ''
    Write-Host ('=' * 60) -ForegroundColor DarkCyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host ('=' * 60) -ForegroundColor DarkCyan
}

# schtasks 出错时会把错误写到 stderr，而 $ErrorActionPreference='Stop' 会把它
# 当成终止性错误。这里统一包一层：合并 stderr、容忍非零退出码，由调用方判断。
function Invoke-Schtasks {
    param([string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & schtasks.exe @Arguments 2>&1
        $code = $LASTEXITCODE
    } catch {
        $output = @($_.Exception.Message)
        $code = 1
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{
        Code   = $code
        Output = @($output | ForEach-Object { "$_" })
    }
}

function Find-Node {    try {
        return (Get-Command node -ErrorAction Stop).Source
    } catch {
        $candidates = @(
            'D:\node\node.exe',
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
        )
        foreach ($candidate in $candidates) {
            if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
        }
        return $null
    }
}

function ConvertTo-TaskTime([string]$text) {
    # 接受 8:30 / 08:30 / 8：30（全角冒号）等写法，返回 HH:mm
    $clean = $text.Trim() -replace '：', ':'
    if ($clean -notmatch '^([01]?\d|2[0-3]):([0-5]\d)$') { return $null }
    $parts = $clean.Split(':')
    return ('{0:00}:{1:00}' -f [int]$parts[0], [int]$parts[1])
}

function Get-TaskXml([string]$startTime, [bool]$catchUp) {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $start = (Get-Date).ToString('yyyy-MM-dd') + 'T' + $startTime + ':00'
    $catchUpText = if ($catchUp) { 'true' } else { 'false' }
    $escapedScript = [System.Security.SecurityElement]::Escape($scriptPath)
    $escapedDir = [System.Security.SecurityElement]::Escape($scriptDir)

    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Noymanga（Noyacg）每日自动签到：$startTime 运行一次，失败会写日志并通知。</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$sid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>$catchUpText</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$([System.Security.SecurityElement]::Escape($node))</Command>
      <Arguments>"$escapedScript"</Arguments>
      <WorkingDirectory>$escapedDir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

function Show-Status {
    Write-Head 'Noymanga 签到状态'

    $existing = Invoke-Schtasks @('/Query', '/TN', $taskName)
    if ($existing.Code -ne 0) {
        Write-Host '  计划任务：未安装' -ForegroundColor Yellow
        Write-Host '  运行「安装.bat」即可创建。'
        return
    }
    Write-Host '  计划任务：已安装'

    $detail = (Invoke-Schtasks @('/Query', '/TN', $taskName, '/V', '/FO', 'LIST')).Output
    foreach ($line in $detail) {
        if ($line -match '^\s*(下次运行时间|上次运行时间|上次结果|状态|要运行的任务|Next Run Time|Last Run Time|Last Result|Status|Task To Run)\s*[:：]\s*(.+)$') {
            Write-Host ('  {0}：{1}' -f $Matches[1].Trim(), $Matches[2].Trim())
        }
    }

    Write-Host ''
    if (Test-Path -LiteralPath $statusFile) {
        $raw = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8
        $label = switch -Wildcard ((Get-Content -LiteralPath $statusFile -Raw)) {
            '*"CHECKED_IN"*'         { '今天已签到（脚本完成的）'; break }
            '*"ALREADY_CHECKED_IN"*' { '今天已经签到过了'; break }
            '*"LOGIN_TIMEOUT"*'      { '需要重新登录（上次登录超时）'; break }
            '*"LOGIN_REQUIRED"*'     { '需要重新登录'; break }
            '*"CHECKIN_FAILED"*'     { '签到请求失败'; break }
            '*"NO_BUTTON"*'          { '页面上找不到签到按钮'; break }
            '*"ERROR"*'              { '运行出错'; break }
            default                  { '未知状态' }
        }
        Write-Host "  最近结果：$label" -ForegroundColor Green
        Write-Host '  原始内容：'
        foreach ($line in ($raw -split "`r?`n")) {
            if ($line.Trim()) { Write-Host "    $line" }
        }
    } else {
        Write-Host '  最近结果：还没有运行过' -ForegroundColor Yellow
    }

    Write-Host ''
    if (Test-Path -LiteralPath $logDir) {
        $latest = Get-ChildItem -LiteralPath $logDir -Filter *.log -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime | Select-Object -Last 1
        if ($latest) {
            Write-Host ("  最新日志：{0}" -f $latest.Name)
            Get-Content -LiteralPath $latest.FullName -Encoding UTF8 -Tail 15 | ForEach-Object {
                Write-Host "    $_" -ForegroundColor DarkGray
            }
        }
    }
    Write-Host ''
    Write-Host ("  日志目录：{0}" -f $logDir)
}

# ---------------------------------------------------------------
# 自定义协议：noymanga://login → 本脚本的 --login
# 作用：签到失败/需要登录时，点一下 Windows 通知就能打开登录窗口。
# 只写 HKCU，不需要管理员权限；卸载时会删掉。
# ---------------------------------------------------------------
$protocolScheme = 'noymanga'

function Register-LoginProtocol([string]$nodePath, [string]$targetScript) {
    $root = "HKCU:\Software\Classes\$protocolScheme"
    $commandKey = Join-Path $root 'shell\open\command'
    $command = '"{0}" "{1}" --login' -f $nodePath, $targetScript
    New-Item -Path $root -Force | Out-Null
    Set-ItemProperty -Path $root -Name '(default)' -Value 'URL:Noymanga Auto Check-in Login'
    New-ItemProperty -Path $root -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    New-Item -Path $commandKey -Force | Out-Null
    Set-ItemProperty -Path $commandKey -Name '(default)' -Value $command
    return $command
}

function Unregister-LoginProtocol {
    Remove-Item -Path "HKCU:\Software\Classes\$protocolScheme" -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-Login([string]$nodePath) {
    Write-Head '登录 Noymanga'
    Write-Host '  即将打开一个浏览器窗口。请在里面完成登录（含验证码），登录后窗口会自动关闭。'
    Write-Host '  漏签最常见的原因就是登录态过期，重新登录一次即可恢复。'
    Write-Host ''
    & $nodePath $scriptPath '--login'
    $code = $LASTEXITCODE
    Write-Host ''
    if ($code -eq 0) {
        Write-Host '  登录成功，登录态已保存。' -ForegroundColor Green
    } elseif ($code -eq 2) {
        Write-Host '  没有在限定时间内完成登录。' -ForegroundColor Yellow
        Write-Host '  可以再运行一次「登录.bat」。'
    } else {
        Write-Host "  登录流程出错（退出码 $code），请查看 logs 目录。" -ForegroundColor Red
    }
    return $code
}

# ---------------------------------------------------------------
# 只取消自动签到（删任务，保留脚本 / 登录态 / 日志）
# ---------------------------------------------------------------
if ($RemoveTask) {
    Write-Head '取消每日自动签到'
    Write-Host '  将删除计划任务「Noymanga Daily Check-in」。'
    Write-Host '  脚本文件、登录态（browser-profile）和日志都会保留。'
    Write-Host ''
    if (-not $Quiet) {
        $answer = Read-Host '  确认取消自动签到吗？输入 y 确认，直接回车退出 [y/N]'
        if (($answer -as [string]).Trim().ToLower() -notin @('y', 'yes')) {
            Write-Host '  已取消，什么都没改。' -ForegroundColor Yellow
            Read-Host '  按回车键关闭' | Out-Null
            return
        }
    }
    $removed = Invoke-Schtasks @('/Delete', '/TN', $taskName, '/F')
    if ($removed.Code -eq 0) {
        Write-Host '  计划任务已删除，以后不会再自动签到了。' -ForegroundColor Green
    } else {
        Write-Host '  计划任务本来就不存在（可能之前已经取消过）。' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '  想恢复自动签到：双击「安装.bat」，按提示重来一遍即可（登录态还在，不用重新登录）。'
    Write-Host '  想手动立刻签一次：node .\noymanga-auto-checkin-v2.js'
    if (-not $Quiet) { Read-Host '  按回车键关闭' | Out-Null }
    return
}

# ---------------------------------------------------------------
# 卸载
# ---------------------------------------------------------------
if ($Uninstall) {
    Write-Head '卸载 Noymanga 自动签到'
    $deleted = Invoke-Schtasks @('/Delete', '/TN', $taskName, '/F')
    if ($deleted.Code -eq 0) {
        Write-Host '  计划任务已删除。' -ForegroundColor Green
    } else {
        Write-Host '  计划任务本来就不存在。' -ForegroundColor Yellow
    }
    Unregister-LoginProtocol
    Write-Host '  通知点击用的 noymanga:// 协议已移除。' -ForegroundColor Green
    Write-Host ''
    Write-Host '  登录态、日志、脚本文件都还在，需要的话可以手动删除整个文件夹。'
    if (-not $Quiet) { Read-Host '  按回车键关闭' | Out-Null }
    return
}

# ---------------------------------------------------------------
# 查看状态 / 登录
# ---------------------------------------------------------------
if ($Status) {
    Show-Status
    if (-not $Quiet) { Read-Host '  按回车键关闭' | Out-Null }
    return
}

$node = Find-Node

if ($Login) {
    if (-not $node) { Write-Host '  找不到 Node.js，请先安装。' -ForegroundColor Red; return }
    Register-LoginProtocol $node $scriptPath | Out-Null
    Invoke-Login $node | Out-Null
    if (-not $Quiet) { Read-Host '  按回车键关闭' | Out-Null }
    return
}

# ---------------------------------------------------------------
# 安装 / 修改
# ---------------------------------------------------------------
Write-Head 'Noymanga 每日自动签到 · 安装向导'
Write-Host '  提示：直接双击即可；创建计划任务时会自动弹出一次 UAC，点「是」。' -ForegroundColor DarkGray
Write-Host '        （创建的是「只在你登录时运行」的个人任务，写的是你自己的注册表项。）' -ForegroundColor DarkGray

if (-not (Test-Path -LiteralPath $scriptPath)) {
    Write-Host "  找不到脚本：$scriptPath" -ForegroundColor Red
    if (-not $Quiet) { Read-Host '  按回车键关闭' | Out-Null }
    exit 1
}

if (-not $node) {
    Write-Host '  没有找到 Node.js。' -ForegroundColor Red
    Write-Host '  请先安装 Node.js（https://nodejs.org/，选 LTS 版本），装完重新双击本文件。'
    if (-not $Quiet) { Read-Host '  按回车键关闭' | Out-Null }
    exit 1
}
Write-Host ("  Node.js：{0}  ({1})" -f $node, (& $node -v))

# 1) 签到时间
$existingTask = $null
$probe = Invoke-Schtasks @('/Query', '/TN', $taskName)
if ($probe.Code -eq 0) {
    $existingTask = ((Invoke-Schtasks @('/Query', '/TN', $taskName, '/V', '/FO', 'LIST')).Output) -join "`n"
}

$startTime = $null
if ($Time) {
    $startTime = ConvertTo-TaskTime $Time
    if (-not $startTime) {
        Write-Host "  时间格式不对：$Time（应该像 08:30 这样）" -ForegroundColor Red
        exit 1
    }
} else {
    $defaultTime = '00:00'
    if ($existingTask -and $existingTask -match '(?:下次运行时间|Next Run Time)\s*[:：]\s*\d{4}/\d{1,2}/\d{1,2}\s+(\d{1,2}):(\d{2})') {
        $defaultTime = ('{0:00}:{1:00}' -f [int]$Matches[1], [int]$Matches[2])
    }
    while (-not $startTime) {
        Write-Host ''
        Write-Host "  ① 每天几点签到？（24 小时制，直接回车用默认值 $defaultTime）" -ForegroundColor White
        $answer = Read-Host '     时间'
        if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $defaultTime }
        $startTime = ConvertTo-TaskTime $answer
        if (-not $startTime) { Write-Host '     格式不对，请重新输入，比如 08:30 或 23:45' -ForegroundColor Yellow }
    }
}

# 2) 是否开机补签
$catchUp = -not $NoCatchUp
if (-not $Time -and -not $NoCatchUp) {
    Write-Host ''
    Write-Host '  ② 如果电脑在签到时间关机/休眠，开机后要自动补签吗？' -ForegroundColor White
    Write-Host '     （推荐开启：错过了会在开机后尽快补一次）'
    $answer = Read-Host '     开启补签？[Y/n]'
    if ($answer -match '^\s*[nN]') { $catchUp = $false }
}

# 3) 写计划任务
Write-Host ''
Write-Host ("  正在创建计划任务：每天 {0} 运行，补签 {1} ..." -f $startTime, $(if ($catchUp) { '开启' } else { '关闭' }))
$xml = Get-TaskXml $startTime $catchUp

if ($DryRun) {
    Write-Host ''
    Write-Host '  -DryRun：只打印任务定义，不真正创建。' -ForegroundColor Yellow
    Write-Host $xml
    Write-Host ''
    Write-Host ('  通知点击：{0}://login → "{1}" "{2}" --login' -f $protocolScheme, $node, $scriptPath) -ForegroundColor Yellow
    return
}

$xmlPath = Join-Path ([System.IO.Path]::GetTempPath()) ("noymanga-task-{0}.xml" -f ([guid]::NewGuid().ToString('N')))
[System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)

try {
    $created = Invoke-Schtasks @('/Create', '/TN', $taskName, '/XML', $xmlPath, '/F')
    $result = $created.Output
    $createCode = $created.Code
} finally {
    Remove-Item -LiteralPath $xmlPath -ErrorAction SilentlyContinue
}

if ($createCode -ne 0) {
    Write-Host '  创建计划任务失败：' -ForegroundColor Red
    $result | ForEach-Object { Write-Host "    $_" }
    Write-Host ''
    Write-Host '  常见原因：这台电脑的策略不允许普通权限创建计划任务。' -ForegroundColor Yellow
    Write-Host '  解决办法：右键「安装.bat」→ 以管理员身份运行。' -ForegroundColor Yellow
    if (-not $Quiet) { Read-Host '  按回车键关闭' | Out-Null }
    exit 1
}

Write-Host '  计划任务创建成功。' -ForegroundColor Green
Write-Host ("    任务名称：{0}" -f $taskName)
Write-Host ("    运行命令：`"{0}`" `"{1}`"" -f $node, $scriptPath)
Write-Host ("    运行时间：每天 {0}" -f $startTime)

# 3.5) 注册通知点击协议（点通知 → 打开登录窗口）
try {
    $protocolCommand = Register-LoginProtocol $node $scriptPath
    Write-Host ("    通知点击：{0}://login → {1}" -f $protocolScheme, $protocolCommand)
} catch {
    Write-Host ("    通知点击协议注册失败（不影响签到）：{0}" -f $_.Exception.Message) -ForegroundColor Yellow
}

# 4) 是否现在登录
Write-Host ''
if (-not (Test-Path -LiteralPath $profileDir)) {
    Write-Host '  ⚠ 还没有登录过一次，现在登录最省事。' -ForegroundColor Yellow
} else {
    Write-Host '  浏览器登录态已存在。只有换了账号或长期没用才需要重新登录。'
}
$doLogin = $true
if (-not $Quiet) {
    $answer = Read-Host '  ③ 现在就登录一次 Noymanga 吗？[Y/n]'
    if ($answer -match '^\s*[nN]') { $doLogin = $false }
}

if ($doLogin) {
    Invoke-Login $node | Out-Null
}

Write-Host ''
Write-Host '  安装完成 ✅' -ForegroundColor Green
Write-Host '  · 双击「查看状态.bat」随时看今天签没签'
Write-Host '  · 双击「登录.bat」可以重新登录'
Write-Host '  · 双击「卸载.bat」删除计划任务'
Write-Host ('  · 想改时间：重新运行「安装.bat」，或执行 install-daily-task-v2.ps1 -Time 08:30')
if (-not $Quiet) { Read-Host '  按回车键关闭' | Out-Null }
