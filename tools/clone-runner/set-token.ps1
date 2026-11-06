# Saves the clone runner's settings as user environment variables: ECOM_URL and CLONE_WORKER_TOKEN (the token from
# "Clone tu link" > settings, SUPERADMIN, shown once). Run it yourself and paste the token at the prompt; it is not
# echoed and never printed.
param([string]$Url = 'https://pod.thecrafthousellc.com')
$Url = $Url.Trim().TrimEnd('/')
if ($Url -notmatch '^https://[A-Za-z0-9.-]+(:\d+)?$' -and $Url -notmatch '^http://(localhost|127\.0\.0\.1)(:\d+)?$') {
  Write-Host 'ECOM_URL must be https://<host> (http:// only for localhost or 127.0.0.1). Nothing saved.'
  exit 1
}
$secure = Read-Host 'Clone worker token (cqw_...)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ($token -notmatch '^cqw_[A-Za-z0-9_-]{20,}$') {
  Write-Host 'That does not look like a clone worker token (cqw_ and at least 20 letters, digits, _ or -). Nothing saved.'
  exit 1
}
[Environment]::SetEnvironmentVariable('CLONE_WORKER_TOKEN', $token, 'User')
[Environment]::SetEnvironmentVariable('ECOM_URL', $Url, 'User')
$token = $null
Write-Host "Saved ECOM_URL=$Url and CLONE_WORKER_TOKEN (not shown) as user environment variables."
Write-Host 'Open a new terminal before running runner.py; the Task Scheduler task reads them at its next start.'
