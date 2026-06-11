# Restore Amazing Studio migration pack trên Windows
# Chạy trong thư mục đã giải nén (có database.sql, project/, .env)
param(
  [string]$DbName = "amazing_studio",
  [string]$DbUser = "postgres",
  [string]$DbHost = "localhost",
  [int]$DbPort = 5432
)

$ErrorActionPreference = "Stop"
$PackRoot = $PSScriptRoot
$ProjectRoot = Join-Path $PackRoot "project"
$EnvFile = Join-Path $PackRoot ".env"
$SqlFile = Join-Path $PackRoot "database.sql"
$StorageSrc = Join-Path $PackRoot "artifacts\data\object-storage"
$StorageDst = Join-Path $ProjectRoot "artifacts\data\object-storage"

function Require-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Thiếu lệnh '$name'. Cài Node.js / PostgreSQL / pnpm trước."
  }
}

Write-Host "=== Amazing Studio — Windows setup ===" -ForegroundColor Cyan

Require-Cmd "node"
Require-Cmd "psql"
Require-Cmd "createdb"

if (-not (Test-Path $ProjectRoot)) { throw "Không thấy thư mục project/" }
if (-not (Test-Path $SqlFile)) { throw "Không thấy database.sql" }
if (-not (Test-Path $EnvFile)) { throw "Không thấy .env" }

# Copy .env vào project
Copy-Item $EnvFile (Join-Path $ProjectRoot ".env") -Force

# Copy ảnh
if (Test-Path $StorageSrc) {
  New-Item -ItemType Directory -Force -Path (Split-Path $StorageDst) | Out-Null
  if (Test-Path $StorageDst) { Remove-Item $StorageDst -Recurse -Force }
  Copy-Item $StorageSrc $StorageDst -Recurse -Force
  Write-Host "✓ Đã copy object-storage" -ForegroundColor Green
}

# Sửa DATABASE_URL trong .env cho Windows (user postgres)
$envPath = Join-Path $ProjectRoot ".env"
$pass = Read-Host "Nhập mật khẩu PostgreSQL user '$DbUser' (Enter nếu không có)"
$dbUrl = if ($pass) {
  "postgresql://${DbUser}:$([uri]::EscapeDataString($pass))@${DbHost}:${DbPort}/${DbName}"
} else {
  "postgresql://${DbUser}@${DbHost}:${DbPort}/${DbName}"
}
$content = Get-Content $envPath -Raw
if ($content -match "(?m)^DATABASE_URL=") {
  $content = $content -replace "(?m)^DATABASE_URL=.*", "DATABASE_URL=$dbUrl"
} else {
  $content += "`nDATABASE_URL=$dbUrl`n"
}
if ($content -notmatch "(?m)^LOCAL_OBJECT_STORAGE_DIR=") {
  $storageUnix = ($StorageDst -replace '\\', '/')
  $content += "LOCAL_OBJECT_STORAGE_DIR=$storageUnix`n"
}
Set-Content $envPath $content -NoNewline

# Tạo DB + import
$env:PGPASSWORD = $pass
$dbExists = & psql -h $DbHost -p $DbPort -U $DbUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'" 2>$null
if ($dbExists -ne "1") {
  & createdb -h $DbHost -p $DbPort -U $DbUser $DbName
  Write-Host "✓ Đã tạo database $DbName" -ForegroundColor Green
} else {
  Write-Host "Database $DbName đã tồn tại — import đè schema public..." -ForegroundColor Yellow
  & psql -h $DbHost -p $DbPort -U $DbUser -d $DbName -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" | Out-Null
}

& psql -h $DbHost -p $DbPort -U $DbUser -d $DbName -f $SqlFile
Write-Host "✓ Đã import database.sql" -ForegroundColor Green

# pnpm install
Set-Location $ProjectRoot
Require-Cmd "npx"
Write-Host "→ pnpm install (có thể vài phút)..." -ForegroundColor Cyan
& npx --yes pnpm@10 install

Write-Host ""
Write-Host "✅ Setup xong!" -ForegroundColor Green
Write-Host "Chạy API:  ..\dev-windows.ps1 api"
Write-Host "Chạy Web:  ..\dev-windows.ps1 web"
Write-Host "Mở:        http://localhost:5173"
