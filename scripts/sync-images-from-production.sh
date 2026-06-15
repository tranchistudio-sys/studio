#!/usr/bin/env bash
# Download object-storage images from production into local dev storage.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Bundled API (dist/index.mjs) resolves storage to artifacts/data/object-storage
UPLOADS="$ROOT/artifacts/data/object-storage/uploads"
PROD_BASE="${PROD_IMAGE_BASE:-https://tranchistudio.com/api/storage/objects/uploads}"
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:${PATH:-}"

mkdir -p "$UPLOADS"

if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  echo "PostgreSQL not running on localhost:5432"
  exit 1
fi

UUID_FILE="$(mktemp)"
psql amazing_studio -t -A -c "
SELECT DISTINCT uuid FROM (
  SELECT regexp_replace(image_url, '.*/', '') AS uuid FROM dresses WHERE image_url LIKE '/objects/uploads/%'
  UNION SELECT regexp_replace(cover_image_url, '.*/', '') FROM dresses WHERE cover_image_url LIKE '/objects/uploads/%'
  UNION SELECT regexp_replace(public_image_url, '.*/', '') FROM dresses WHERE public_image_url LIKE '/objects/uploads/%'
  UNION SELECT regexp_replace(elem, '.*/', '') FROM dresses, jsonb_array_elements_text(COALESCE(NULLIF(extra_images,'')::jsonb, '[]'::jsonb)) AS elem WHERE elem LIKE '%/objects/uploads/%'
  UNION SELECT regexp_replace(cover_image_url, '.*/', '') FROM cms_categories WHERE cover_image_url LIKE '/objects/uploads/%'
  UNION SELECT regexp_replace(cover_image_url, '.*/', '') FROM gallery_albums WHERE cover_image_url LIKE '/objects/uploads/%'
  UNION SELECT regexp_replace(image_url, '.*/', '') FROM gallery_photos WHERE image_url LIKE '/objects/uploads/%'
) t WHERE uuid ~ '^[0-9a-f-]{36}\$' ORDER BY 1;
" > "$UUID_FILE"

total=$(wc -l < "$UUID_FILE" | tr -d ' ')
ok=0
skip=0
fail=0

while IFS= read -r uuid; do
  [[ -z "$uuid" ]] && continue
  dest="$UPLOADS/$uuid"
  meta="$UPLOADS/$uuid.meta.json"
  if [[ -f "$dest" && -f "$meta" ]]; then
    skip=$((skip + 1))
    continue
  fi

  url="$PROD_BASE/$uuid"
  headers="$(mktemp)"
  if ! curl -fsSL -D "$headers" -o "$dest" "$url"; then
    rm -f "$dest"
    echo "FAIL $uuid"
    fail=$((fail + 1))
    rm -f "$headers"
    continue
  fi

  ctype="$(awk 'BEGIN{IGNORECASE=1} /^content-type:/ {sub(/^content-type:[[:space:]]*/,""); gsub(/\r/,""); print; exit}' "$headers")"
  [[ -z "$ctype" ]] && ctype="application/octet-stream"
  printf '%s\n' "{\"contentType\":\"$ctype\",\"name\":\"$uuid\",\"savedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$meta"
  rm -f "$headers"
  ok=$((ok + 1))
  echo "OK $uuid"
done < "$UUID_FILE"

rm -f "$UUID_FILE"
echo "Done: $ok downloaded, $skip skipped, $fail failed (of $total UUIDs)"
