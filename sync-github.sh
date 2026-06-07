#!/bin/bash
set -e

REPO="https://github.com/mrvanlong2020/studio.git"
TMP="/tmp/studio-sync"
WORKSPACE="/home/runner/workspace"

echo "=== Đang tải code từ GitHub ==="
rm -rf "$TMP"
git clone --depth=1 --no-tags "$REPO" "$TMP"
echo "✓ Clone thành công"

echo ""
echo "=== Đồng bộ source files ==="

sync_dir() {
  local src="$1"
  local dst="$2"
  local label="$3"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    cp -rf "$src/." "$dst/"
    echo "✓ $label"
  else
    echo "⚠ Bỏ qua $label (không tìm thấy trong GitHub)"
  fi
}

# amazing-studio: chỉ sync src/ và public/
# (giữ nguyên vite.config.ts và package.json do Replit cần cấu hình riêng)
sync_dir "$TMP/artifacts/amazing-studio/src" \
         "$WORKSPACE/artifacts/amazing-studio/src" \
         "amazing-studio/src"

sync_dir "$TMP/artifacts/amazing-studio/public" \
         "$WORKSPACE/artifacts/amazing-studio/public" \
         "amazing-studio/public"

# api-server: sync toàn bộ src/
sync_dir "$TMP/artifacts/api-server/src" \
         "$WORKSPACE/artifacts/api-server/src" \
         "api-server/src"

# lib/db: sync schema và code
sync_dir "$TMP/lib/db/src" \
         "$WORKSPACE/lib/db/src" \
         "lib/db/src"

# Kiểm tra và sửa nếu routes/index.ts bị trùng import fbInboxRouter
INDEX="$WORKSPACE/artifacts/api-server/src/routes/index.ts"
if [ -f "$INDEX" ]; then
  INBOX_COUNT=$(grep -c 'import fbInboxRouter' "$INDEX" 2>/dev/null || echo 0)
  if [ "$INBOX_COUNT" -gt "1" ]; then
    echo ""
    echo "⚠ Phát hiện import trùng lặp trong index.ts — đang sửa..."
    node -e "
const fs = require('fs');
let c = fs.readFileSync('$INDEX', 'utf8');
// Xóa dòng import trùng
const imp = \"import fbInboxRouter from \\\"./fb-inbox\\\";\\n\";
while ((c.match(new RegExp(imp.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\' + '\$&'), 'g')) || []).length > 1) {
  const idx = c.lastIndexOf(imp);
  c = c.slice(0, idx) + c.slice(idx + imp.length);
}
// Xóa dòng use trùng
const use = \"router.use(fbInboxRouter);\\n\";
while ((c.match(new RegExp(use.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\' + '\$&'), 'g')) || []).length > 1) {
  const idx = c.lastIndexOf(use);
  c = c.slice(0, idx) + c.slice(idx + use.length);
}
fs.writeFileSync('$INDEX', c);
console.log('✓ Đã sửa import trùng lặp');
"
  fi
fi

echo ""
echo "=== Dọn dẹp ==="
rm -rf "$TMP"

echo ""
echo "✅ Hoàn tất! Code đã được cập nhật từ GitHub."
echo ""
echo "Để áp dụng thay đổi: restart workflows trong Replit (API Server + web)."
