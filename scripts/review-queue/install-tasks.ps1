# Registers the two Task Scheduler tasks of the local review queue for the current user (not elevated):
#   "EcomManager Review Queue Tick"   every 10 minutes, 30-minute limit, a run still going makes the next one skip
#   "EcomManager Review Queue Server" at logon, restarts on failure (3 times, 1 minute apart), no time limit
# Both run run.ps1 from -AppDir, a dedicated worktree pinned to the merged commit (this script does not create it).
# -Uninstall removes both tasks. Warns (never fails) when the live CLI copies differ from the AppDir copies.
param(
  [string]$AppDir = 'D:\Ecom manager\review-queue-app',
  [string]$Node = '',
  [string]$QueueRoot = 'D:\Ecom manager\review-queue',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$AppDir = $AppDir.TrimEnd('\')
$QueueRoot = $QueueRoot.TrimEnd('\')
$tickName = 'EcomManager Review Queue Tick'
$serverName = 'EcomManager Review Queue Server'

if ($Uninstall) {
  foreach ($n in @($tickName, $serverName)) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Host ('Removed task "{0}"' -f $n)
    } else {
      Write-Host ('No task "{0}"' -f $n)
    }
  }
  exit 0
}

if (-not $Node) {
  $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { Write-Host 'No node on the PATH; pass -Node <path to node.exe>. Nothing registered.'; exit 1 }
  $Node = $cmd.Source
}
$runScript = Join-Path $AppDir 'scripts\review-queue\run.ps1'
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { Write-Host ('Node not found: {0}. Nothing registered.' -f $Node); exit 1 }
if (-not (Test-Path -LiteralPath $runScript -PathType Leaf)) { Write-Host ('Missing {0}: -AppDir must be the review-queue worktree. Nothing registered.' -f $runScript); exit 1 }

$liveRoot = 'D:\Ecom manager\ecommanager-claude-ecommerce-cashflow-tool-XsLzh\.claude\worktrees\peaceful-villani-d3d860'
$copies = @('scripts\lib\api-delivery.mjs', 'scripts\lib\delivery-client.mjs', 'scripts\lib\plan-to-api.mjs', 'scripts\lib\delivery-drive-upload.mjs',
  'scripts\review-queue\store.mjs', 'scripts\review-queue\intake.mjs')
function Get-NormalizedHash([string]$Path) {
  $text = [IO.File]::ReadAllText($Path) -replace "`r`n", "`n"
  $sha = [Security.Cryptography.SHA256]::Create()
  return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))) -replace '-', ''
}
$warnings = @()
foreach ($rel in $copies) {
  $live = Join-Path $liveRoot $rel
  $app = Join-Path $AppDir $rel
  if (-not (Test-Path -LiteralPath $live -PathType Leaf)) { $warnings += ('live copy missing: {0}' -f $live); continue }
  if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { $warnings += ('AppDir copy missing: {0}' -f $app); continue }
  if ((Get-NormalizedHash $live) -ne (Get-NormalizedHash $app)) { $warnings += ('differs (ignoring CRLF/LF): {0}' -f $rel) }
}
if ($warnings.Count) {
  Write-Host 'Warning: the live CLI copies and the AppDir copies are not identical:'
  $warnings | ForEach-Object { Write-Host ('  {0}' -f $_) }
} else {
  Write-Host 'Live CLI copies match the AppDir copies.'
}

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
function New-QueueAction([string]$What) {
  $argLine = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -What {1} -Node "{2}" -QueueRoot "{3}"' -f $runScript, $What, $Node, $QueueRoot
  return New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $AppDir
}

$tickTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$tickSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $tickName -Action (New-QueueAction 'tick') -Trigger $tickTrigger -Settings $tickSettings -Principal $principal `
  -Description 'Local review queue tick (scripts\review-queue\tick.mjs)' -Force | Out-Null

$serverTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$serverSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $serverName -Action (New-QueueAction 'server') -Trigger $serverTrigger -Settings $serverSettings -Principal $principal `
  -Description 'Local review queue server (scripts\review-queue\server.mjs)' -Force | Out-Null

$rep = (Get-ScheduledTask -TaskName $tickName).Triggers[0].Repetition
Write-Host ('Tick repetition read back: Interval {0}, Duration {1}' -f $rep.Interval, $rep.Duration)
Write-Host ('Registered "{0}": every 10 minutes from {1:HH:mm}, 30-minute limit, IgnoreNew, StartWhenAvailable' -f $tickName, (Get-Date).AddMinutes(1))
Write-Host ('Registered "{0}": at logon of {1}, restart 3 times / 1 minute, no time limit, IgnoreNew' -f $serverName, $user)
Write-Host ('  node {0}  app {1}  queue {2}' -f $Node, $AppDir, $QueueRoot)
Write-Host ('  logs {0}\.review-queue\logs' -f $env:USERPROFILE)
