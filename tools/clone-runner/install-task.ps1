# Registers the Task Scheduler task "EcomManager Clone Runner" for the current user, interactive and not elevated: a
# real python.exe (3.12 or newer, never the WindowsApps alias stub) runs runner.py at logon with this folder as its
# working directory, no time limit, and the restart-on-failure settings Task Scheduler documents (RestartCount and
# RestartInterval on the settings object). Its console window shows the runner's log; <job root>\runner.log keeps it.
# Run it yourself, once, after the supervised first run and only with the owner's OK.
param([string]$Python = 'python', [string]$TaskName = 'EcomManager Clone Runner')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $here 'runner.py'
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
$restartCount = 999
$restartEvery = New-TimeSpan -Minutes 1
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $exe -Argument ('"{0}"' -f $runner) -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -RestartCount $restartCount -RestartInterval $restartEvery `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Ecom Manager clone queue runner (tools\clone-runner\runner.py)' -Force | Out-Null
Write-Host ('Registered task "{0}" for {1} (interactive, not elevated):' -f $TaskName, $user)
Write-Host ('  program            {0}' -f $exe)
Write-Host ('  arguments          "{0}"' -f $runner)
Write-Host ('  working directory  {0}' -f $here)
Write-Host ('  trigger            at logon of {0}' -f $user)
Write-Host ('  on failure         restart every {0} minute(s), up to {1} times; no time limit' -f $restartEvery.TotalMinutes, $restartCount)
Write-Host 'Whether Task Scheduler restarts it after a plain non-zero exit of runner.py is unverified: check after the first one.'
Write-Host ('Start it now with: Start-ScheduledTask -TaskName "{0}"' -f $TaskName)
