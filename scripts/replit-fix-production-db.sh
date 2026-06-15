#!/usr/bin/env bash
# Khôi phục tranchistudio.com trỏ đúng Production DB (không dùng DB dev/test)
# Chạy TRONG Replit Shell — cần PRODUCTION_DATABASE_URL từ Publishing → Database → Settings
set -euo pipefail

echo "=== Amazing Studio — Fix Production DATABASE ==="
echo ""

if [[ -z "${PRODUCTION_DATABASE_URL:-}" ]]; then
  echo "❌ Thiếu PRODUCTION_DATABASE_URL"
  echo ""
  echo "Lấy connection string:"
  echo "  Publishing → Production → Database → Manage → Settings"
  echo "  Copy DATABASE_URL (production) — KHÔNG dùng URL của Shell/dev"
  echo ""
  echo "Rồi chạy:"
  echo '  export PRODUCTION_DATABASE_URL="postgresql://..."'
  echo "  bash scripts/replit-fix-production-db.sh"
  exit 1
fi

echo "1) Kiểm tra số đơn trên PRODUCTION DB..."
BOOKINGS=$(psql "$PRODUCTION_DATABASE_URL" -t -c "SELECT COUNT(*) FROM bookings WHERE status != 'cancelled';" 2>/dev/null | tr -d ' ')
CUSTOMERS=$(psql "$PRODUCTION_DATABASE_URL" -t -c "SELECT COUNT(*) FROM customers;" 2>/dev/null | tr -d ' ')
echo "   bookings: ${BOOKINGS:-?}"
echo "   customers: ${CUSTOMERS:-?}"

if [[ "${BOOKINGS:-0}" -lt 10 ]]; then
  echo ""
  echo "⚠️  Production DB có vẻ ít data — có thể cần RESTORE từ backup."
  echo "   Xem: bash scripts/replit-restore-production-dump.sh"
  exit 2
fi

echo ""
echo "✅ Production DB còn data thật."
echo ""
echo "2) Bước tiếp theo (trên Replit UI — KHÔNG chạy lệnh):"
echo "   Publishing → Production → Settings / Secrets"
echo "   Đặt DATABASE_URL = PRODUCTION_DATABASE_URL (connection string ở trên)"
echo "   KHÔNG dùng DATABASE_URL của Development workspace"
echo "   Republish (TẮT copy dev DB → prod)"
echo ""
echo "3) Kiểm tra: mở tranchistudio.com/calendar → Tháng 05/2026"
