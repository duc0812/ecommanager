# Registers the Task Scheduler task "EcomManager Clone Runner": starts `python runner.py` when the current user logs
# on, restarts it a minute after it fails, and never stops it for running too long. Its console window shows the
# runner's log. Run it yourself, once, after the supervised first run and only with the owner's OK.
param([string]$Python = 'python', [string]$TaskName = 'EcomManager Clone Runner')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $here 'runner.py'
$exe = (Get-Command $Python -CommandType Application | Select-Object -First 1).Source
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $exe -Argument ('"{0}"' -f $runner) -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Ecom Manager clone queue runner (tools\clone-runner\runner.py)' -Force | Out-Null
Write-Host ('Registered task "{0}" for {1}: {2} "{3}" at logon, restarted every minute on failure (up to 999 times), no time limit.' -f $TaskName, $user, $exe, $runner)
Write-Host ('Start it now with: Start-ScheduledTask -TaskName "{0}"' -f $TaskName)
