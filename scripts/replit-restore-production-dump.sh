#!/usr/bin/env bash
# Restore dump SQL vào Production DB (khi prod bị trống / nhầm data test)
# CẢNH BÁO: ghi đè data hiện tại trên DB đích. Chỉ dùng khi prod thật sự mất.
set -euo pipefail

DUMP="${1:-}"
PROD_URL="${PRODUCTION_DATABASE_URL:-}"

if [[ -z "$PROD_URL" ]]; then
  echo 'Cần: export PRODUCTION_DATABASE_URL="postgresql://..."'
  exit 1
fi

if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Cách dùng:"
  echo "  export PRODUCTION_DATABASE_URL=\"...\""
  echo "  bash scripts/replit-restore-production-dump.sh /path/to/production_REAL.sql"
  echo ""
  echo "File gợi ý trên Mac: exports/production_REAL.sql (upload lên Replit Files trước)"
  exit 1
fi

echo "⚠️  RESTORE vào Production DB — sẽ ghi đè schema + data hiện tại."
echo "Dump: $DUMP"
read -r -p "Gõ YES để tiếp tục: " confirm
[[ "$confirm" == "YES" ]] || exit 0

echo "Đang restore..."
psql "$PROD_URL" -v ON_ERROR_STOP=1 -f "$DUMP"
echo "✅ Restore xong. Republish app (DATABASE_URL = production) rồi kiểm tra tranchistudio.com"
