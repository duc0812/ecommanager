# Points the worker at the NAS folder that holds the PSDs (e.g. \\Tmteam\Design\PSD Design). Run it yourself on the worker PC.
# Writes ARTWORK_NAS_ROOT into %USERPROFILE%\.artwork-worker\prod.env, next to the worker token set by set-token.ps1.
param([Parameter(Mandatory = $true)][string]$Path)
$workerHome = if ($env:ARTWORK_WORKER_HOME) { $env:ARTWORK_WORKER_HOME } else { Join-Path $env:USERPROFILE '.artwork-worker' }
$file = Join-Path $workerHome 'prod.env'
if ($Path -match '[^\x20-\x7E]') { Write-Host 'Use a NAS path without accented letters (prod.env is ASCII). Nothing saved.'; exit 1 }
if (-not (Test-Path $file)) { Write-Host "Missing $file - run set-token.ps1 first."; exit 1 }
if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Write-Host "Cannot reach $Path - connect to the NAS (sign in once in Explorer) and try again. Nothing saved."; exit 1 }
$lines = @(Get-Content $file | Where-Object { $_ -notmatch '^\s*ARTWORK_NAS_ROOT\s*=' }) + "ARTWORK_NAS_ROOT=$Path"
Set-Content -Path $file -Encoding ASCII -Value $lines
Write-Host "Saved ARTWORK_NAS_ROOT=$Path to $file"
