param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$RepoRoot = "D:\Defectra"
$BackendDir = Join-Path $RepoRoot "backend"
$FrontendDir = Join-Path $RepoRoot "frontend"
$NginxDir = "C:\Users\srivarshini.n\AppData\Local\Microsoft\WinGet\Packages\nginxinc.nginx_Microsoft.Winget.Source_8wekyb3d8bbwe\nginx-1.29.8"
$NginxExe = Join-Path $NginxDir "nginx.exe"

function Write-Step($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Test-PortListening([int]$Port) {
  try {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop
    return $null -ne $conn
  } catch {
    return $false
  }
}

function Ensure-Backend {
  if (Test-PortListening 8010) {
    Write-Host "Backend already listening on 127.0.0.1:8010"
    return
  }
  Write-Step "Starting backend (uvicorn on 127.0.0.1:8010)"
  Start-Process -FilePath "powershell.exe" -WorkingDirectory $BackendDir -ArgumentList @(
    "-NoExit",
    "-Command",
    "uvicorn main:app --host 127.0.0.1 --port 8010"
  ) | Out-Null
  Start-Sleep -Seconds 3
  if (-not (Test-PortListening 8010)) {
    throw "Backend did not start on port 8010. Check backend terminal."
  }
}

function Ensure-FrontendBuild {
  if ($SkipBuild) {
    Write-Host "Skipping frontend build (-SkipBuild)."
    return
  }
  $distIndex = Join-Path $FrontendDir "dist\index.html"
  if (Test-Path $distIndex) {
    Write-Host "Frontend dist already exists."
    return
  }
  Write-Step "Building frontend (npm run build)"
  Push-Location $FrontendDir
  try {
    npm run build
  } finally {
    Pop-Location
  }
  if (-not (Test-Path $distIndex)) {
    throw "Frontend build failed or dist/index.html not found."
  }
}

function Ensure-Nginx {
  if (-not (Test-Path $NginxExe)) {
    throw "nginx.exe not found at $NginxExe"
  }
  Write-Step "Validating NGINX config"
  Push-Location $NginxDir
  try {
    & $NginxExe -t | Out-Host
    Write-Step "Starting/reloading NGINX"
    try {
      & $NginxExe -s reload | Out-Null
    } catch {
      & $NginxExe | Out-Null
    }
  } finally {
    Pop-Location
  }
}

function Start-NgrokAndGetUrl {
  Write-Step "Starting ngrok tunnel to http://127.0.0.1:8080"
  $logBase = Join-Path $env:TEMP ("defectra-ngrok-" + [guid]::NewGuid().ToString("N"))
  $stdoutLogPath = "$logBase.stdout.log"
  $stderrLogPath = "$logBase.stderr.log"
  $proc = Start-Process -FilePath "ngrok.exe" -ArgumentList @(
    "http",
    "http://127.0.0.1:8080",
    "--log",
    "stdout"
  ) -PassThru -RedirectStandardOutput $stdoutLogPath -RedirectStandardError $stderrLogPath

  $deadline = (Get-Date).AddSeconds(20)
  $url = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $stdoutLogPath) {
      $content = Get-Content $stdoutLogPath -Raw
      if ($content -match "url=(https://[^\s]+ngrok[^\s]*)") {
        $url = $matches[1]
        break
      }
    }
  }

  if (-not $url) {
    throw "ngrok started but no public URL detected. See logs: $stdoutLogPath and $stderrLogPath"
  }

  return @{ Url = $url; Pid = $proc.Id; Log = $stdoutLogPath; ErrLog = $stderrLogPath }
}

Write-Step "Defectra secure share bootstrap"
Ensure-Backend
Ensure-FrontendBuild
Ensure-Nginx

$ngrok = Start-NgrokAndGetUrl

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "Share this URL:" -ForegroundColor Green
Write-Host $ngrok.Url -ForegroundColor Yellow
Write-Host ""
Write-Host "ngrok PID : $($ngrok.Pid)"
Write-Host "ngrok stdout log : $($ngrok.Log)"
Write-Host "ngrok stderr log : $($ngrok.ErrLog)"
Write-Host "==============================================" -ForegroundColor Green

