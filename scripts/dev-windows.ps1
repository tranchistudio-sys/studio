# Chạy API / Web trên Windows (tương đương scripts/dev-local.sh trên Mac)
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("api", "web", "check")]
  [string]$Target
)

$ErrorActionPreference = "Stop"
$ProjectRoot = if (Test-Path (Join-Path $PSScriptRoot "project")) {
  Join-Path $PSScriptRoot "project"
} else {
  (Split-Path $PSScriptRoot -Parent)
}

$EnvFile = Join-Path $ProjectRoot ".env"
if (-not (Test-Path $EnvFile)) {
  throw "Thiếu $EnvFile — chạy setup-windows.ps1 trước."
}

# Load .env (đơn giản)
Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
    $name = $matches[1]
    $val = $matches[2].Trim().Trim('"').Trim("'")
    Set-Item -Path "env:$name" -Value $val
  }
}

$env:NODE_ENV = if ($env:NODE_ENV) { $env:NODE_ENV } else { "development" }
if (-not $env:LOCAL_OBJECT_STORAGE_DIR) {
  $env:LOCAL_OBJECT_STORAGE_DIR = (Join-Path $ProjectRoot "artifacts\data\object-storage")
}

Set-Location $ProjectRoot

switch ($Target) {
  "api" {
    $env:PORT = if ($env:PORT) { $env:PORT } else { "3000" }
    Write-Host "API PORT=$($env:PORT)" -ForegroundColor Cyan
    & npx --yes pnpm@10 --filter @workspace/api-server run dev
  }
  "web" {
    if (-not $env:PORT) { $env:PORT = "5173" }
    Write-Host "Web PORT=$($env:PORT)" -ForegroundColor Cyan
    & npx --yes pnpm@10 --filter @workspace/amazing-studio run dev
  }
  "check" {
    if (Test-Path (Join-Path $ProjectRoot "scripts\verify-stack.mjs")) {
      & node (Join-Path $ProjectRoot "scripts\verify-stack.mjs")
    } else {
      Write-Host "Postgres + .env OK (verify-stack.mjs không có trong pack)"
    }
  }
}
