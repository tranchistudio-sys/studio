#!/usr/bin/env bash
# Đóng gói toàn bộ Amazing Studio (code + DB local + ảnh + .env) để chuyển sang Windows/Mac khác.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:${PATH:-}"

STAMP="$(date +%Y%m%d_%H%M)"
OUT_DIR="$ROOT/exports/migration_pack_${STAMP}"
ARCHIVE="$ROOT/exports/amazing-studio-migration_${STAMP}.tar.gz"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "❌ Thiếu $ROOT/.env — tạo file này trước khi export."
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ROOT/.env"
set +a

DB_NAME="${PGDATABASE:-amazing_studio}"
if [[ -n "${DATABASE_URL:-}" ]]; then
  DB_NAME="$(node -e "
    try {
      const u = new URL(process.env.DATABASE_URL);
      console.log((u.pathname || '').replace(/^\\//, '') || 'amazing_studio');
    } catch { console.log('amazing_studio'); }
  ")"
fi

echo "=== Export migration pack ==="
echo "DB: $DB_NAME"
mkdir -p "$OUT_DIR"

echo "→ Dump database..."
pg_dump -h localhost -p 5432 -U "${PGUSER:-$(whoami)}" -d "$DB_NAME" --no-owner --no-acl \
  -f "$OUT_DIR/database.sql"

echo "→ Copy .env..."
cp "$ROOT/.env" "$OUT_DIR/.env"

echo "→ Copy ảnh (object-storage)..."
if [[ -d "$ROOT/artifacts/data/object-storage" ]]; then
  mkdir -p "$OUT_DIR/artifacts/data"
  cp -R "$ROOT/artifacts/data/object-storage" "$OUT_DIR/artifacts/data/"
else
  echo "   (không có artifacts/data/object-storage — bỏ qua)"
fi

echo "→ Copy source code (bỏ node_modules, dist, cache)..."
mkdir -p "$OUT_DIR/project"
tar -cf - \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.turbo' \
  --exclude='exports' \
  --exclude='attached_assets' \
  --exclude='backup' \
  --exclude='*.tar.gz' \
  --exclude='*.sql' \
  --exclude='.git' \
  -C "$ROOT" \
  . | tar -xf - -C "$OUT_DIR/project"

cp "$ROOT/scripts/setup-windows.ps1" "$OUT_DIR/"
cp "$ROOT/scripts/dev-windows.ps1" "$OUT_DIR/"

cat > "$OUT_DIR/HUONG-DAN-CHUYEN-MAY.md" <<'EOF'
# Chuyển Amazing Studio sang máy Windows

## Trên Mac (đã xong bước export)
File `amazing-studio-migration_*.tar.gz` chứa:
- `project/` — toàn bộ code
- `database.sql` — database local (đơn, khách, ảnh metadata…)
- `artifacts/data/object-storage/` — file ảnh upload
- `.env` — cấu hình (DATABASE_URL, v.v.)
- `setup-windows.ps1`, `dev-windows.ps1`

## Trên Windows — cài 1 lần
1. **Node.js 22 LTS** — https://nodejs.org
2. **PostgreSQL 16** — https://www.postgresql.org/download/windows/
   - Ghi nhớ mật khẩu user `postgres`
3. **Git** (tùy chọn) — https://git-scm.com

## Giải nén & restore
1. Copy file `.tar.gz` sang Windows (USB / Google Drive / OneDrive)
2. Giải nén bằng **7-Zip** hoặc `tar -xzf` trong PowerShell 10+
3. Mở **PowerShell** trong thư mục đã giải nén
4. Chạy:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\setup-windows.ps1
   ```
5. Script sẽ: tạo DB, import SQL, sửa `.env`, `pnpm install`

## Chạy hàng ngày (2 terminal PowerShell)
```powershell
# Terminal 1 — API
cd project
..\dev-windows.ps1 api

# Terminal 2 — Web
cd project
..\dev-windows.ps1 web
```
Mở: http://localhost:5173

## Lưu ý
- **Không copy `node_modules`** — máy Windows tự `pnpm install` lại.
- File `.env` có mật khẩu DB/Neon — giữ kín, không đẩy lên Git công khai.
- Nếu dùng **WSL** thay PowerShell: chạy `bash scripts/dev-local.sh` như trên Mac.
EOF

echo "→ Nén archive..."
mkdir -p "$ROOT/exports"
tar -czf "$ARCHIVE" -C "$(dirname "$OUT_DIR")" "$(basename "$OUT_DIR")"

BYTES=$(wc -c < "$ARCHIVE" | tr -d ' ')
MB=$((BYTES / 1024 / 1024))
echo ""
echo "✅ Xong!"
echo "   Thư mục: $OUT_DIR"
echo "   File nén: $ARCHIVE (${MB} MB)"
echo ""
echo "Copy file .tar.gz sang Windows → giải nén → chạy setup-windows.ps1"
