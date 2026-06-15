#!/usr/bin/env bash
# Export ĐẦY ĐỦ: Production DB + tất cả ảnh upload → 1 file .tar.gz
# Chạy TRONG Replit Shell
set -euo pipefail

STAMP="$(date +%Y%m%d_%H%M)"
PACK="Amazing_Studio_Export_DB_Images_${STAMP}"
ARCHIVE="${PACK}.tar.gz"
IMG_BASE="${PROD_IMAGE_BASE:-https://tranchistudio.com/api/storage/objects/uploads}"
DB_URL="${PRODUCTION_DATABASE_URL:-${DATABASE_URL:-}}"

if [[ -z "$DB_URL" ]]; then
  echo "❌ Thiếu PRODUCTION_DATABASE_URL hoặc DATABASE_URL"
  echo "Lấy từ: Database → Production → Manage → Settings"
  echo '  export PRODUCTION_DATABASE_URL="postgresql://..."'
  exit 1
fi

mkdir -p "$PACK/artifacts/data/object-storage/uploads"

echo "=== Amazing Studio — Export DB + Images ==="
echo ""

echo "1) Dump database..."
pg_dump "$DB_URL" --no-owner --no-acl -f "$PACK/database.sql"
BOOKINGS=$(psql "$DB_URL" -t -c "SELECT COUNT(*) FROM bookings WHERE status != 'cancelled';" 2>/dev/null | tr -d ' ' || echo "?")
CUSTOMERS=$(psql "$DB_URL" -t -c "SELECT COUNT(*) FROM customers;" 2>/dev/null | tr -d ' ' || echo "?")
echo "   bookings: ${BOOKINGS} | customers: ${CUSTOMERS}"

echo ""
echo "2) Copy ảnh local (nếu có)..."
if [[ -d artifacts/data/object-storage/uploads ]]; then
  cp -n artifacts/data/object-storage/uploads/* "$PACK/artifacts/data/object-storage/uploads/" 2>/dev/null || true
  LOCAL_N=$(find artifacts/data/object-storage/uploads -type f ! -name '*.meta.json' 2>/dev/null | wc -l | tr -d ' ')
  echo "   local files: ${LOCAL_N}"
else
  echo "   (không có thư mục local — tải từ production)"
fi

echo ""
echo "3) Tải ảnh từ production theo DB..."
UUID_FILE="$(mktemp)"
psql "$DB_URL" -t -A -c "
SELECT DISTINCT uuid FROM (
  SELECT regexp_replace(image_url, '.*/', '') AS uuid FROM dresses WHERE image_url LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(cover_image_url, '.*/', '') FROM dresses WHERE cover_image_url LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(public_image_url, '.*/', '') FROM dresses WHERE public_image_url LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(elem, '.*/', '') FROM dresses, jsonb_array_elements_text(COALESCE(NULLIF(extra_images,'')::jsonb, '[]'::jsonb)) AS elem WHERE elem LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(cover_image_url, '.*/', '') FROM cms_categories WHERE cover_image_url LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(cover_image_url, '.*/', '') FROM gallery_albums WHERE cover_image_url LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(image_url, '.*/', '') FROM gallery_photos WHERE image_url LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(elem, '.*/', '') FROM bookings, jsonb_array_elements(COALESCE(items,'[]'::jsonb)) AS item, jsonb_array_elements_text(COALESCE(item->'conceptImages','[]'::jsonb)) AS elem WHERE elem::text LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(payment_proof_url, '.*/', '') FROM payments WHERE payment_proof_url LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(avatar_url, '.*/', '') FROM staff WHERE avatar_url LIKE '%/objects/uploads/%'
) t WHERE uuid ~ '^[0-9a-f-]{36}$' ORDER BY 1;
" > "$UUID_FILE" || true

TOTAL=$(wc -l < "$UUID_FILE" | tr -d ' ')
OK=0; SKIP=0; FAIL=0
DEST="$PACK/artifacts/data/object-storage/uploads"

while IFS= read -r uuid; do
  [[ -z "$uuid" ]] && continue
  out="$DEST/$uuid"
  meta="$DEST/$uuid.meta.json"
  if [[ -f "$out" ]]; then
    SKIP=$((SKIP + 1))
    continue
  fi
  headers="$(mktemp)"
  if curl -fsSL -D "$headers" -o "$out" "$IMG_BASE/$uuid"; then
    ctype="$(awk 'BEGIN{IGNORECASE=1} /^content-type:/ {sub(/^content-type:[[:space:]]*/,""); gsub(/\r/,""); print; exit}' "$headers")"
    [[ -z "$ctype" ]] && ctype="application/octet-stream"
    printf '%s\n' "{\"contentType\":\"$ctype\",\"name\":\"$uuid\",\"savedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$meta"
    OK=$((OK + 1))
    echo "   OK $uuid"
  else
    rm -f "$out"
    FAIL=$((FAIL + 1))
    echo "   FAIL $uuid"
  fi
  rm -f "$headers"
done < "$UUID_FILE"
rm -f "$UUID_FILE"

echo "   downloaded: $OK | skipped: $SKIP | failed: $FAIL | total UUIDs: $TOTAL"

echo ""
echo "4) Đóng gói..."
tar -czf "$ARCHIVE" "$PACK"
rm -rf "$PACK"
BYTES=$(wc -c < "$ARCHIVE" | tr -d ' ')
MB=$((BYTES / 1024 / 1024))

echo ""
echo "✅ XONG: $ARCHIVE (${MB} MB)"
echo ""
echo "Tải về máy:"
echo "  Files (trái) → $ARCHIVE → ⋮ → Download"
echo ""
echo "Trong file có:"
echo "  - database.sql"
echo "  - artifacts/data/object-storage/uploads/ (ảnh)"
