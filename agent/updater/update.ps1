$ErrorActionPreference = "Stop"

$ROOT = "C:\agent"
$VERSION_FILE = "C:\agent\version.txt"
$TOKEN_FILE = "C:\agent\.update_token"

if (!(Test-Path $TOKEN_FILE)) { throw "Lipseste token: $TOKEN_FILE" }
$token = (Get-Content $TOKEN_FILE -Raw).Trim()

$UPDATE_JSON_URL = "https://pris-com.ro/agent-updates/update.json?token=$token"

$current = "0.0.0"
if (Test-Path $VERSION_FILE) { $current = (Get-Content $VERSION_FILE -Raw).Trim() }

Write-Host "1) Citesc update.json..."
$meta = Invoke-RestMethod -Uri $UPDATE_JSON_URL
$latest = ($meta.version | Out-String).Trim()
$zipUrl = ($meta.zip | Out-String).Trim() + "?token=" + $token

if ($latest -eq $current) {
  Write-Host "Deja la zi: $current"
  exit 0
}

$tmp = Join-Path $env:TEMP ("agent_update_" + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
$zipPath = Join-Path $tmp "agent_bundle.zip"

Write-Host "2) Oprire servicii PM2..."
pm2 stop agent | Out-Null
pm2 stop case  | Out-Null
pm2 stop pos   | Out-Null

Write-Host "3) Download ZIP..."
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

Write-Host "4) Extract..."
$extract = Join-Path $tmp "extract"
New-Item -ItemType Directory -Path $extract | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $extract -Force

Write-Host "5) Copiez peste C:\agent..."
Copy-Item -Path (Join-Path $extract "*") -Destination $ROOT -Recurse -Force

Write-Host "6) npm install (daca e nevoie)..."
$services = @("agent","case","pos")
foreach ($s in $services) {
  $p = Join-Path $ROOT $s
  if (Test-Path (Join-Path $p "package.json")) {
    Push-Location $p
    npm install | Out-Null
    Pop-Location
  }
}

Write-Host "7) Repornesc PM2..."
pm2 start C:\agent\ecosystem.config.js | Out-Null

Write-Host "8) Salvez versiunea..."
Set-Content -Path $VERSION_FILE -Value $latest -Encoding ASCII

Write-Host "UPDATE OK: $current -> $latest"
