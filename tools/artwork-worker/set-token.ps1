# Saves the Design Studio worker token for run-daily.ps1. Run it yourself and paste the token at the prompt;
# it is written to %USERPROFILE%\.artwork-worker\prod.env and never printed.
param([string]$Url = 'https://pod.thecrafthousellc.com')
$workerHome = if ($env:ARTWORK_WORKER_HOME) { $env:ARTWORK_WORKER_HOME } else { Join-Path $env:USERPROFILE '.artwork-worker' }
New-Item -ItemType Directory -Force $workerHome | Out-Null
$secure = Read-Host 'Worker token (Design Studio > Settings, dsw_...)' -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ($token -notmatch '^dsw_[A-Za-z0-9_-]{20,}$') { Write-Host 'That does not look like a worker token (dsw_...). Nothing saved.'; exit 1 }
$file = Join-Path $workerHome 'prod.env'
Set-Content -Path $file -Encoding ASCII -Value @("ECOM_URL=$Url", "DESIGN_WORKER_TOKEN=$token")
Write-Host "Saved to $file"
