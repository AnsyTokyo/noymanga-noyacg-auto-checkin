# Run this once in PowerShell. It creates (or replaces) a daily 00:00 task that
# runs noymanga-auto-checkin-v2.js for the currently signed-in Windows account.
#
# This is the installer for the v2 script (default-browser version).
# install-daily-task.ps1 still exists for the old Chrome-only v1 script.
# Both installers use the same task name, so running this one switches the
# existing daily task over to v2 instead of creating a second task.

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $PSCommandPath
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $scriptDir 'noymanga-auto-checkin-v2.js'
$profileDir = Join-Path $scriptDir 'browser-profile'
$taskName = 'Noymanga Daily Check-in'

if (-not (Test-Path -LiteralPath $script)) { throw "Script not found: $script" }

if (-not (Test-Path -LiteralPath $profileDir)) {
    Write-Host 'Note: browser-profile\ does not exist yet.' -ForegroundColor Yellow
    Write-Host 'Run the script once by hand and sign in to Noymanga before relying on this task.' -ForegroundColor Yellow
}

# schtasks creates a normal task for the current account. Register-ScheduledTask
# with an Interactive principal can be rejected on some Windows installations.
$taskCommand = '"{0}" "{1}"' -f $node, $script
$result = & schtasks.exe /Create /TN $taskName /TR $taskCommand /SC DAILY /ST 00:00 /F 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host $result -ForegroundColor Red
    Write-Host ''
    Write-Host 'Windows refused to create the task for this account.' -ForegroundColor Yellow
    Write-Host 'Please right-click this file and choose "Run with PowerShell as administrator", then run it once more.' -ForegroundColor Yellow
    exit 1
}

Write-Host "Created task: $taskName" -ForegroundColor Green
Write-Host "Command: $taskCommand"
Write-Host ''
Write-Host 'It runs every day at 00:00 under the current account.'
Write-Host 'Run it once from Task Scheduler to confirm it works.'
Write-Host ''
Write-Host 'To remove it later:'
Write-Host ("  schtasks /Delete /TN `"{0}`" /F" -f $taskName)
