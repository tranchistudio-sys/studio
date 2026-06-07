#!/bin/bash
set -e

pnpm install --frozen-lockfile

# ─────────────────────────────────────────────────────────────────────────────
# drizzle-kit push reconciles the database to the Drizzle schema
# (lib/db/src/schema). It can emit DESTRUCTIVE statements
# (DROP TABLE / DROP COLUMN / DROP CONSTRAINT) for any table that exists in the
# database but is NOT declared in the Drizzle schema.
#
# Several tables in this project are intentionally "runtime-managed": they are
# created additively & idempotently by the API server at startup
# (e.g. ensureWeddingSchema() -> wedding_templates / wedding_cards /
# wedding_guest_entries, and ensureCmsSchema() -> cms_home_settings). These
# tables are NOT in the Drizzle schema on purpose, so `drizzle-kit push` would
# try to DROP them. We must never let that happen.
#
# Guard: set SAFE_PRODUCTION=1 or SKIP_DB_PUSH=1 to skip the push entirely.
# Booking, payments, customers, attendance and CRM tables are unaffected either
# way — skipping push simply performs no schema reconciliation at all.
# ─────────────────────────────────────────────────────────────────────────────
if [ "${SAFE_PRODUCTION:-0}" = "1" ] || [ "${SKIP_DB_PUSH:-0}" = "1" ]; then
  echo "[post-merge] SAFE_PRODUCTION/SKIP_DB_PUSH is set — skipping 'pnpm --filter db push'."
  echo "[post-merge] No schema reconciliation will run; NO DROP TABLE / DROP COLUMN / DROP CONSTRAINT."
  echo "[post-merge] Runtime-managed tables (wedding_*, cms_home_settings) are created by the API server at startup."
else
  echo "[post-merge] Applying Drizzle schema to the DEVELOPMENT database via 'pnpm --filter db push'..."
  echo "[post-merge] (set SAFE_PRODUCTION=1 or SKIP_DB_PUSH=1 to skip this step)"
  pnpm --filter db push
fi
