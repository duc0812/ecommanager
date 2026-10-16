# The daily auto-render (Windows Task Scheduler "EcomManager Auto Render", 07:00).
# Asks Ecom Manager to queue print renders for new orders whose product has a READY artwork, renders them, then exits.
# Settings come from %USERPROFILE%\.artwork-worker\prod.env (written by set-token.ps1); output goes to logs\auto-render-<date>.log.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$workerHome = if ($env:ARTWORK_WORKER_HOME) { $env:ARTWORK_WORKER_HOME } else { Join-Path $env:USERPROFILE '.artwork-worker' }
$envFile = Join-Path $workerHome 'prod.env'
$logDir = Join-Path $workerHome 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('auto-render-{0:yyyy-MM-dd}.log' -f (Get-Date))
Get-ChildItem $logDir -Filter 'auto-render-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force

if (-not (Test-Path $envFile)) {
  Add-Content -Path $log -Encoding UTF8 -Value "[$(Get-Date -Format HH:mm:ss)] missing $envFile - run tools\artwork-worker\set-token.ps1"
  exit 2
}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*(ECOM_URL|DESIGN_WORKER_TOKEN)\s*=\s*(.+?)\s*$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
}
$env:PYTHONIOENCODING = 'utf-8'
$python = Join-Path $here '.venv\Scripts\python.exe'
$worker = Join-Path $here 'worker.py'
# cmd does the redirect so the log stays UTF-8 (PowerShell 5.1 would write UTF-16 and wrap stderr lines).
cmd /c "`"$python`" `"$worker`" --auto-render --drain >> `"$log`" 2>&1"
exit $LASTEXITCODE
