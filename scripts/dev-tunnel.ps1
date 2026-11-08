# Run WeParkit on a phone when the network blocks phone<->laptop traffic (eduroam, UB Secure).
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-tunnel.ps1
#
# 1. Opens a Cloudflare quick tunnel to the backend (http://localhost:8000).
# 2. Starts Expo in tunnel mode with EXPO_PUBLIC_API_URL pointing at that tunnel.
# Scan the QR code it prints with Expo Go. Ctrl+C stops Expo and closes the backend tunnel.
#
# WARNING: while this runs the backend is reachable at a random public https://*.trycloudflare.com
# URL. Anyone with that URL can call the API, including the Gemini and ElevenLabs endpoints that
# spend your credits. Stop it when you're done.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

try { Invoke-RestMethod "http://localhost:8000/api/health" -TimeoutSec 3 | Out-Null }
catch {
  Write-Host "The backend isn't running on port 8000. Start it in another terminal first:" -ForegroundColor Yellow
  Write-Host "  cd backend; .venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 2 --timeout-keep-alive 75"
  exit 1
}

$cf = Join-Path ${env:ProgramFiles(x86)} "cloudflared\cloudflared.exe"
if (-not (Test-Path $cf)) { $cf = "cloudflared" }

# Expo's tunnel needs @expo/ngrok; install it once if missing.
if (-not (npm ls -g @expo/ngrok 2>$null | Select-String "ngrok")) {
  Write-Host "Installing @expo/ngrok (one time)..."
  npm install -g "@expo/ngrok@^4.1.0"
}

$log = Join-Path $env:TEMP "weparkit-cloudflared.log"
$out = Join-Path $env:TEMP "weparkit-cloudflared.out"
Remove-Item $log, $out -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $cf -ArgumentList "tunnel", "--no-autoupdate", "--url", "http://localhost:8000" `
  -RedirectStandardError $log -RedirectStandardOutput $out -PassThru -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
}
if (-not $url) {
  Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
  throw "cloudflared didn't report a tunnel URL within 60 s. Details: $log"
}

# Wait until the tunnel actually forwards to the backend.
for ($i = 0; $i -lt 20; $i++) {
  try { Invoke-RestMethod "$url/api/health" -TimeoutSec 5 | Out-Null; break } catch { Start-Sleep -Seconds 2 }
}
Write-Host ""
Write-Host "Backend tunnel: $url" -ForegroundColor Green
Write-Host "(public while this runs; Ctrl+C to stop)" -ForegroundColor DarkYellow
Write-Host ""

$env:EXPO_PUBLIC_API_URL = $url
try {
  Set-Location (Join-Path $root "mobile")
  # --clear: EXPO_PUBLIC_* values are baked into the bundle, so drop any cached LAN-URL bundle.
  npx expo start --tunnel --clear
}
finally {
  Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
  Write-Host "Backend tunnel closed."
}
