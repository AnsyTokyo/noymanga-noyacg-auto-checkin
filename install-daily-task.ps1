# Run this once in PowerShell. It creates a daily task at 00:00 for the
# currently signed-in Windows account.

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $PSCommandPath
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $scriptDir 'noymanga-auto-checkin.js'
$taskName = 'Noymanga Daily Check-in'

if (-not (Test-Path -LiteralPath $script)) { throw "Script not found: $script" }

# schtasks creates a normal task for the current account. Register-ScheduledTask
# with an Interactive principal can be rejected on some Windows installations.
$taskCommand = '"{0}" "{1}"' -f $node, $script
$result = & schtasks.exe /Create /TN $taskName /TR $taskCommand /SC DAILY /ST 00:00 /F 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host $result -ForegroundColor Red
    Write-Host ''
    Write-Host 'Windows refused to create the task for this account.' -ForegroundColor Yellow
    Write-Host 'Please right-click this file and choose “Run with PowerShell as administrator”, then run it once more.' -ForegroundColor Yellow
    exit 1
}

Write-Host "Created task: $taskName" -ForegroundColor Green
Write-Host 'First, double-click noymanga-auto-checkin.js and sign in to Noymanga in the Chrome window if asked.'
