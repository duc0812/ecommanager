# Registers the Task Scheduler task "EcomManager Design Agent Runner" for the current user, interactive and not elevated.
# A real python.exe (3.12 or newer, never the WindowsApps alias stub) runs runner.py with this folder as its working
# directory, no time limit, at logon and again every 5 minutes (a second copy is ignored: MultipleInstances IgnoreNew,
# and runner.py holds its own lock), so a runner that died comes back. python.exe, not pythonw.exe: the sessions are
# console programs and share the runner's console; closing that window stops the runner.
# Only the owner runs this, after the supervised first run (runner.py --once). -PrintOnly shows the plan and registers nothing.
param([string]$Python = 'python', [string]$TaskName = 'EcomManager Design Agent Runner', [switch]$PrintOnly)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $here 'runner.py'
$envFile = Join-Path $env:USERPROFILE '.design-agent\runner.env'
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
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  Write-Host ('{0} does not exist. Create it first (see README.md, section Cai dat). Nothing registered.' -f $envFile)
  exit 1
}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$every = New-TimeSpan -Minutes 5
$action = New-ScheduledTaskAction -Execute $exe -Argument ('"{0}"' -f $runner) -WorkingDirectory $here
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval $every
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Write-Host ('Task "{0}" for {1} (interactive, not elevated):' -f $TaskName, $user)
Write-Host ('  program            {0}' -f $exe)
Write-Host ('  arguments          "{0}"' -f $runner)
Write-Host ('  working directory  {0}' -f $here)
Write-Host ('  trigger 1          at logon of {0}' -f $user)
Write-Host ('  trigger 2          every {0} minutes (restarts a runner that died)' -f $every.TotalMinutes)
Write-Host '  policy             no time limit; MultipleInstances IgnoreNew; start when available; run on battery'
if ($PrintOnly) {
  Write-Host 'Nothing registered (-PrintOnly).'
  exit 0
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $repeat) -Settings $settings -Principal $principal `
  -Description 'Ecom Manager Design Agent runner (tools\design-agent-runner\runner.py)' -Force | Out-Null
Write-Host ('Registered task "{0}".' -f $TaskName)
Write-Host ('Start it now with: Start-ScheduledTask -TaskName "{0}"' -f $TaskName)
