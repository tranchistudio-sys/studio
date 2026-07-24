#!/bin/bash
set -e

pnpm install --frozen-lockfile

# ─────────────────────────────────────────────────────────────────────────────
# DEPLOY-GUARD: db push là OPT-IN (fail-closed từ 24/07/2026).
#
# drizzle-kit push reconcile database theo Drizzle schema (lib/db/src/schema) và
# CÓ THỂ sinh lệnh DESTRUCTIVE (DROP TABLE / DROP COLUMN / DROP CONSTRAINT) cho
# bất kỳ bảng nào có trong DB nhưng không khai báo trong schema. Dự án này có
# nhiều bảng "runtime-managed" (wedding_*, cms_home_settings, lulu_*…) nên push
# tự động là footgun — sự cố màn Republish đề xuất DROP TABLE lulu_* CASCADE
# ngày 24/07/2026 là hệ quả của schema drift kiểu này.
#
# Trước đây push chạy MẶC ĐỊNH (opt-out bằng SAFE_PRODUCTION/SKIP_DB_PUSH).
# Bây giờ ĐẢO NGƯỢC: mặc định KHÔNG push; chỉ chạy khi đặt tường minh
# ALLOW_DB_PUSH=1 (và không bị SAFE_PRODUCTION/SKIP_DB_PUSH chặn).
# Schema mới cho DEV DB đi qua migrations.ts ở startup (idempotent, additive).
# ─────────────────────────────────────────────────────────────────────────────
if [ "${ALLOW_DB_PUSH:-0}" = "1" ] && [ "${SAFE_PRODUCTION:-0}" != "1" ] && [ "${SKIP_DB_PUSH:-0}" != "1" ]; then
  echo "[post-merge] ALLOW_DB_PUSH=1 — chạy 'pnpm --filter db push' (drizzle-kit push) vào DEV database..."
  pnpm --filter db push
else
  echo "[post-merge] BỎ QUA drizzle-kit push (mặc định fail-closed — đặt ALLOW_DB_PUSH=1 nếu thực sự cần)."
  echo "[post-merge] Không có schema reconciliation nào chạy; KHÔNG DROP TABLE / DROP COLUMN / DROP CONSTRAINT."
fi
