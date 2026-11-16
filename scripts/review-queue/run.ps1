# Runs one review-queue script (tick or server) with REVIEW_QUEUE_ROOT set and appends its output to
# %USERPROFILE%\.review-queue\logs\<what>-<yyyy-MM-dd>.log. Started by the tasks that install-tasks.ps1 registers.
param(
  [Parameter(Mandatory = $true)][ValidateSet('tick', 'server')][string]$What,
  [string]$Node = 'node',
  [string]$QueueRoot = 'D:\Ecom manager\review-queue'
)
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $env:USERPROFILE '.review-queue\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('{0}-{1:yyyy-MM-dd}.log' -f $What, (Get-Date))
$env:REVIEW_QUEUE_ROOT = $QueueRoot
Set-Location -LiteralPath $appDir
$script = Join-Path $appDir ('scripts\review-queue\{0}.mjs' -f $What)
$ErrorActionPreference = 'Continue'
& $Node $script 2>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 -LiteralPath $log
exit $LASTEXITCODE
