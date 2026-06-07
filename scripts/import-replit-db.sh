#!/usr/bin/env bash
# Import dump PostgreSQL từ Replit vào Postgres local (Postgres.app)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:${PATH:-}"

DUMP="${1:-}"
DB_NAME="${2:-amazing_studio_prod}"

if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Cách dùng:"
  echo "  ./scripts/import-replit-db.sh /đường/dẫn/replit_prod_dump.sql"
  echo ""
  echo "Ví dụ:"
  echo "  ./scripts/import-replit-db.sh ~/Downloads/replit_prod_dump.sql"
  exit 1
fi

if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  echo "PostgreSQL chưa chạy. Mở Postgres.app → Start."
  exit 1
fi

echo "=== Import Replit DB → local ==="
echo "File: $DUMP"
echo "DB:   $DB_NAME"
echo ""

dropdb --if-exists "$DB_NAME" 2>/dev/null || true
createdb "$DB_NAME"

psql "$DB_NAME" < "$DUMP"

LOCAL_URL="postgresql://${USER}@localhost:5432/${DB_NAME}"
echo ""
echo "Import xong."
echo "Sửa .env:"
echo "  DATABASE_URL=$LOCAL_URL"
echo ""
echo "Restart dev:"
echo "  ./scripts/dev-local.sh api"
echo "  ./scripts/dev-local.sh web"
