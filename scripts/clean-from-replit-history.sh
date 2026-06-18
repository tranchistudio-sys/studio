#!/usr/bin/env bash
#
# clean-from-replit-history.sh
# ---------------------------------------------------------------------------
# Xoá SECRET khỏi TOÀN BỘ lịch sử branch `from-replit` rồi force-push CHỈ
# branch `from-replit`. Tuyệt đối KHÔNG đụng `main`.
#
# Secret cần xoá nằm trong thư mục backup đã lỡ commit:
#   - BACKUP_FULL_TRANCHISTUDIO/                (chứa database_production_latest.sql
#                                                -> OpenAI API key + 18 Facebook token)
#   - BACKUP_FULL_TRANCHISTUDIO_*.tar.gz        (gói nén 309MB chứa cùng dữ liệu)
#
# Cách chạy:
#   git checkout from-replit
#   bash scripts/clean-from-replit-history.sh
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

# --- Guard 1: phải đang ở branch from-replit -------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "from-replit" ]; then
  echo "DỪNG: đang ở branch '$BRANCH', không phải 'from-replit'."
  echo "Chạy: git checkout from-replit   rồi chạy lại script."
  exit 1
fi

# --- Guard 2: origin phải đúng repo GitHub ---------------------------------
ORIGIN_URL="$(git remote get-url origin)"
echo "origin = $ORIGIN_URL"
case "$ORIGIN_URL" in
  *github.com*tranchistudio-sys/studio*) : ;;
  *) echo "DỪNG: origin không phải repo GitHub mong đợi. Hãy kiểm tra lại."; exit 1 ;;
esac

# --- Bước 0: backup an toàn trước khi viết lại lịch sử ----------------------
BK="../from-replit-backup-$(date +%Y%m%d_%H%M%S).bundle"
git bundle create "$BK" from-replit
echo "Đã backup branch hiện tại vào: $BK (có thể khôi phục nếu cần)"

# --- Bước 1: bỏ theo dõi backup + commit .gitignore ------------------------
git rm -r --cached --quiet BACKUP_FULL_TRANCHISTUDIO 2>/dev/null || true
git rm --cached --quiet BACKUP_FULL_TRANCHISTUDIO_*.tar.gz 2>/dev/null || true
git add .gitignore
git commit -m "chore: stop tracking full backup folder; gitignore backups" || true

# --- Bước 2: cài git-filter-repo (nếu chưa có) -----------------------------
if ! python3 -c "import git_filter_repo" 2>/dev/null && ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "Đang cài git-filter-repo..."
  pip install --quiet git-filter-repo
fi

# --- Bước 3: xoá backup khỏi TOÀN BỘ lịch sử -------------------------------
python3 -m git_filter_repo --force \
  --invert-paths \
  --path BACKUP_FULL_TRANCHISTUDIO \
  --path-glob 'BACKUP_FULL_TRANCHISTUDIO_*.tar.gz'

# --- Bước 4: filter-repo gỡ remote origin -> thêm lại ----------------------
git remote add origin "$ORIGIN_URL" 2>/dev/null || git remote set-url origin "$ORIGIN_URL"

# --- Bước 5: quét lại TOÀN BỘ lịch sử from-replit --------------------------
echo "=== Quét lại secret trong toàn bộ lịch sử (OpenAI / Anthropic / Facebook) ==="
FOUND=""
for c in $(git rev-list HEAD); do
  HIT="$(git grep -I -l -E 'sk-proj-|sk-svcacct-|sk-ant-|sk-[A-Za-z0-9_-]{24,}|EAA[A-Za-z0-9]{20,}' "$c" 2>/dev/null || true)"
  if [ -n "$HIT" ]; then FOUND="$FOUND"$'\n'"$HIT"; fi
done
# .env trong lịch sử (trừ .env.example)
ENVHIT="$(git log --pretty=format: --name-only | grep -E '(^|/)\.env($|\.)' | grep -v '\.example' | sort -u || true)"

if [ -n "$FOUND" ] || [ -n "$ENVHIT" ]; then
  echo "DỪNG: vẫn còn secret/.env trong lịch sử — KHÔNG push."
  echo "$FOUND"
  echo "$ENVHIT"
  exit 1
fi
echo "SẠCH: không còn OpenAI/Anthropic/Facebook token hay .env trong lịch sử."

# --- Bước 6: force-push CHỈ from-replit (KHÔNG đụng main) -------------------
git push -u origin HEAD:from-replit --force
echo "XONG: đã force-push branch 'from-replit' lên GitHub. main KHÔNG bị đụng tới."
