# =============================================================================
# QurbaniHat — production authentication end-to-end verification
#
# Checks, in order:
#   1. /api/health            database + secret + Google credentials + probe
#   2. Google OAuth start     the exact redirect_uri Better Auth sends to Google
#   3. Google consent page    Google accepts client_id + redirect_uri (no
#                             redirect_uri_mismatch / invalid_client)
#   4. session persistence    register -> get-session -> delete-user round trip
#
# Usage:  powershell -File e2e-auth-check.ps1 [-Base https://qurbanihat-next.vercel.app]
# =============================================================================
param([string]$Base = "https://qurbanihat-next.vercel.app")

$ErrorActionPreference = "Continue"
$cookieJar = Join-Path $PSScriptRoot "cookies.txt"
if (Test-Path $cookieJar) { Remove-Item $cookieJar -Force }

function Section($title) { Write-Host "`n===== $title =====" -ForegroundColor Cyan }

# PowerShell-version agnostic query-string reader (avoids System.Web).
function Get-QueryParam([string]$Url, [string]$Name) {
  $query = ([Uri]$Url).Query.TrimStart("?")
  foreach ($pair in $query -split "&") {
    $kv = $pair -split "=", 2
    if ($kv.Count -eq 2 -and $kv[0] -eq $Name) {
      return [System.Uri]::UnescapeDataString($kv[1])
    }
  }
  return $null
}

Section "1. /api/health"
$healthRaw = curl.exe -s --max-time 60 "$Base/api/health"
Write-Host $healthRaw
$health = $null
try { $health = $healthRaw | ConvertFrom-Json } catch { Write-Host "health is not JSON" -ForegroundColor Red }

Section "2. Google OAuth start (sign-in/social)"
$payload = '{"provider":"google","callbackURL":"' + $Base + '/","redirect":true}'
$socialRaw = curl.exe -s --max-time 60 -X POST "$Base/api/auth/sign-in/social" `
  -H "Content-Type: application/json" `
  -H "Origin: $Base" `
  -d $payload
Write-Host $socialRaw
$social = $null
try { $social = $socialRaw | ConvertFrom-Json } catch { Write-Host "social response is not JSON" -ForegroundColor Red }

if ($social -and $social.url) {
  $authUrl = $social.url
  $clientId = Get-QueryParam $authUrl "client_id"
  $redirectUri = Get-QueryParam $authUrl "redirect_uri"
  $chromeExt = Get-QueryParam $authUrl "code_challenge"
  Write-Host "`nclient_id      : $clientId"
  Write-Host "redirect_uri   : $redirectUri"
  Write-Host "scope          : $(Get-QueryParam $authUrl 'scope')"
  Write-Host "code_challenge : $(if ($chromeExt) { 'present' } else { 'MISSING' })"
  Write-Host "state          : $(if (Get-QueryParam $authUrl 'state') { 'present' } else { 'MISSING' })"

  $expected = "$Base/api/auth/callback/google"
  if ($redirectUri -eq $expected) {
    Write-Host "redirect_uri matches the value that must be registered in Google Cloud" -ForegroundColor Green
  } else {
    Write-Host "redirect_uri MISMATCH: expected $expected" -ForegroundColor Red
  }
} else {
  Write-Host "No authorization URL returned - Google sign-in cannot start" -ForegroundColor Red
}

Section "3. Google consent page reachable with that redirect_uri"
if ($social -and $social.url) {
  $consent = curl.exe -s -L --max-time 60 -A "Mozilla/5.0" -w "`nHTTP_STATUS:%{http_code}`n" $social.url
  $status = ($consent | Select-String -Pattern "HTTP_STATUS:(\d+)").Matches.Groups[1].Value
  Write-Host "HTTP status: $status"
  foreach ($needle in @("redirect_uri_mismatch", "invalid_client", "invalid_request", "Error 400")) {
    if ($consent -match [regex]::Escape($needle)) {
      Write-Host "FOUND PROBLEM: $needle" -ForegroundColor Red
      $hit = ($consent -split "`n" | Select-String -Pattern $needle -SimpleMatch | Select-Object -First 1).Line
      Write-Host ("  " + $hit)
    }
  }
  if ($consent -match "accounts.google.com|Sign in|Choose an account") {
    Write-Host "Google served its sign-in/consent page (client_id and redirect_uri accepted)" -ForegroundColor Green
  } else {
    Write-Host "Could not confirm the Google consent page" -ForegroundColor Yellow
  }
}

Section "4. Session persistence (email/password round trip)"
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$email = "e2e-probe-$stamp@qurbanihat-test.invalid"
$password = "QurbaniHat-E2E-$stamp"
$name = "E2E Probe"

$signUp = curl.exe -s -i --max-time 60 -c $cookieJar -X POST "$Base/api/auth/sign-up/email" `
  -H "Content-Type: application/json" -H "Origin: $Base" `
  -d ("{""email"":""$email"",""password"":""$password"",""name"":""$name""}")
Write-Host ($signUp | Select-String -Pattern "^HTTP/" | Select-Object -First 1).Line
Write-Host ($signUp | Select-String -Pattern "set-cookie" | Select-Object -First 1).Line

$session = curl.exe -s --max-time 60 -b $cookieJar -H "Origin: $Base" "$Base/api/auth/get-session"
Write-Host "get-session: $session"
if ($session -match [regex]::Escape($email)) {
  Write-Host "Session persisted in MongoDB and is readable with the cookie" -ForegroundColor Green
} else {
  Write-Host "Session NOT persisted / not readable" -ForegroundColor Red
}

$delete = curl.exe -s -i --max-time 60 -b $cookieJar -X POST "$Base/api/auth/delete-user" `
  -H "Content-Type: application/json" -H "Origin: $Base" -d "{}"
Write-Host "delete-user: $(($delete | Select-String -Pattern '^HTTP/' | Select-Object -First 1).Line)"

$after = curl.exe -s --max-time 60 -b $cookieJar -H "Origin: $Base" "$Base/api/auth/get-session"
Write-Host "get-session after delete: $after"

Write-Host "`nDone."
