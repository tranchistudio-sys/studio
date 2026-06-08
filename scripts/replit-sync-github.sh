#!/usr/bin/env bash
# Chạy script này TRONG Replit Shell (project Amazing-Studio-Manager)
# Mục tiêu: kéo code mới nhất từ GitHub → build → sẵn sàng Publish
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/tranchistudio-sys/studio.git}"
BRANCH="${BRANCH:-main}"

echo "==> Sync GitHub → Replit ($BRANCH)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git remote -v | head -3 || true
  git fetch origin "$BRANCH" || git fetch "$REPO_URL" "$BRANCH"
  git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH"
  git reset --hard "origin/$BRANCH" 2>/dev/null || git pull "$REPO_URL" "$BRANCH" --ff-only
else
  echo "Không phải git repo — import thủ công từ $REPO_URL"
  exit 1
fi

echo "==> pnpm install"
pnpm install --frozen-lockfile

echo "==> Build app (api + web, bỏ qua typecheck)"
pnpm run build:deploy

echo ""
echo "✅ Code đã sync + build xong."
echo ""
echo "Bước tiếp theo (trên Replit UI):"
echo "  1. Mở tab Publishing / Deploy"
echo "  2. TẮT 「Copy development database to production」"
echo "  3. Bấm Publish / Deploy"
echo ""
echo "Nếu post-merge hỏi DB push: đặt SAFE_PRODUCTION=1 trong Secrets trước khi merge."
