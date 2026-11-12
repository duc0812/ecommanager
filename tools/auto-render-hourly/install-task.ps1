# Registers the Task Scheduler task "EcomManager Auto Render Hourly" for the current user, interactive and not elevated:
# every hour from the next full hour, 55-minute limit, a run still going makes the next one skip (IgnoreNew), a missed hour
# runs as soon as the PC is on (StartWhenAvailable). The action is powershell.exe -> run.ps1 -> a real python.exe (3.12 or
# newer, never the WindowsApps alias stub). Only the owner runs this (or the agent on his word); -PrintOnly registers nothing.
param([string]$Python = 'python', [string]$TaskName = 'EcomManager Auto Render Hourly', [switch]$PrintOnly)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runScript = Join-Path $here 'run.ps1'
$config = Join-Path $env:USERPROFILE '.auto-render\config.env'
$found = Get-Command $Python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $found) {
  Write-Host ('No "{0}" on the PATH. Nothing registered.' -f $Python)
  exit 1
}
if ($found.Source -like '*\WindowsApps\*') {
  Write-Host ('"{0}" is the Microsoft Store alias stub, not an interpreter. Install Python 3.12 from python.org or pass -Python <path to python.exe>. Nothing registered.' -f $found.Source)
  exit 1
}
$probe = @(& $found.Source -c 'import sys; print(sys.executable); print(sys.version_info >= (3, 12))')
$exe = if ($probe.Count -ge 2) { "$($probe[0])".Trim() } else { '' }
$recent = ($probe.Count -ge 2) -and ("$($probe[1])".Trim() -eq 'True')
if (-not $exe -or -not $recent -or $exe -like '*\WindowsApps\*' -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) {
  Write-Host ('"{0}" does not lead to a Python 3.12 python.exe outside WindowsApps (it said: {1}). Nothing registered.' -f $found.Source, ($probe -join ' '))
  exit 1
}
$hasConfig = Test-Path -LiteralPath $config -PathType Leaf
if (-not $hasConfig -and -not $PrintOnly) {
  Write-Host ('No config file {0} (see README.md, "Cài đặt"). Nothing registered.' -f $config)
  exit 1
}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$now = Get-Date
$start = $now.Date.AddHours($now.Hour + 1)
$program = 'powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Python "{1}"' -f $runScript, $exe
$limit = New-TimeSpan -Minutes 55
$every = New-TimeSpan -Hours 1

function Show-Plan([string]$Head) {
  Write-Host $Head
  Write-Host ('  program            {0}' -f $program)
  Write-Host ('  arguments          {0}' -f $arguments)
  Write-Host ('  working directory  {0}' -f $here)
  Write-Host ('  trigger            once at {0:yyyy-MM-dd HH:mm}, then every {1} hour(s), no end' -f $start, $every.TotalHours)
  Write-Host ('  limit              {0} minutes per run' -f $limit.TotalMinutes)
  Write-Host  '  policy             IgnoreNew (a run still going makes the next one skip), StartWhenAvailable, runs on battery'
  Write-Host ('  user               {0} (interactive, not elevated)' -f $user)
}

if ($PrintOnly) {
  if (-not $hasConfig) { Write-Host ('Warning: {0} does not exist yet; without -PrintOnly this script refuses to register.' -f $config) }
  Show-Plan ('Would register task "{0}":' -f $TaskName)
  Write-Host 'Nothing registered (-PrintOnly).'
  exit 0
}

$action = New-ScheduledTaskAction -Execute $program -Argument $arguments -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval $every
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit $limit -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Ecom Manager hourly auto render (tools\auto-render-hourly\run.ps1)' -Force | Out-Null
Show-Plan ('Registered task "{0}":' -f $TaskName)
Write-Host ('Run it once now with: Start-ScheduledTask -TaskName "{0}"' -f $TaskName)
