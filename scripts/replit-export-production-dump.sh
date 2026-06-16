#!/usr/bin/env bash
# Export database từ Replit → file .sql (backup trước khi deploy)
# Chạy TRONG Replit Shell (tab Shell)
set -euo pipefail

STAMP="$(date +%Y%m%d_%H%M)"
OUT="backup_replit_${STAMP}.sql"

# Ưu tiên Production DB (data thật trên tranchistudio.com)
DB_URL="${PRODUCTION_DATABASE_URL:-${DATABASE_URL:-}}"

if [[ -z "$DB_URL" ]]; then
  echo "❌ Không thấy DATABASE_URL hoặc PRODUCTION_DATABASE_URL"
  echo ""
  echo "Lấy connection string:"
  echo "  Tab Database (bên phải) → Production → Manage → Settings"
  echo "  Copy URL, rồi chạy:"
  echo '    export PRODUCTION_DATABASE_URL="postgresql://..."'
  echo "    bash scripts/replit-export-production-dump.sh"
  exit 1
fi

echo "=== Export Replit database ==="
echo "File: $OUT"
echo ""

# Thống kê nhanh
BOOKINGS=$(psql "$DB_URL" -t -c "SELECT COUNT(*) FROM bookings WHERE status != 'cancelled';" 2>/dev/null | tr -d ' ' || echo "?")
CUSTOMERS=$(psql "$DB_URL" -t -c "SELECT COUNT(*) FROM customers;" 2>/dev/null | tr -d ' ' || echo "?")
echo "   bookings: ${BOOKINGS}"
echo "   customers: ${CUSTOMERS}"
echo ""

pg_dump "$DB_URL" --no-owner --no-acl -f "$OUT"

BYTES=$(wc -c < "$OUT" | tr -d ' ')
MB=$((BYTES / 1024 / 1024))
echo ""
echo "✅ Export xong: $OUT (${MB} MB)"
echo ""
echo "Tải về máy:"
echo "  1. Mở tab Files (trái) → tìm file $OUT"
echo "  2. Bấm ⋮ → Download"
echo ""
echo "Giữ file này an toàn trước khi Publish code mới!"
