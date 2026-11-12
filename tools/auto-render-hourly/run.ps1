# Entry point for Task Scheduler ("EcomManager Auto Render Hourly"): sets the Python environment and runs auto_render.py.
# The mutex, the log and the summary are auto_render.py's job; this script only reports a Python that cannot be started.
param([string]$Python = 'python', [switch]$DryRun, [switch]$KeepSnapshot)
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONDONTWRITEBYTECODE = '1'
$found = Get-Command $Python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $found) {
  $logDir = Join-Path $env:USERPROFILE '.auto-render\logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $line = '[{0}] không chạy được python: {1}' -f (Get-Date -Format 'HH:mm:ss'), $Python
  Add-Content -LiteralPath (Join-Path $logDir ('{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))) -Value $line -Encoding UTF8
  Write-Host $line
  exit 2
}
$extra = @()
if ($DryRun) { $extra += '--dry-run' }
if ($KeepSnapshot) { $extra += '--keep-snapshot' }
& $found.Source "$PSScriptRoot\auto_render.py" @extra
exit $LASTEXITCODE
