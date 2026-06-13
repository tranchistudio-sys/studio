## Publish destructive-diff fix (dev must be superset of prod)
Replit publish computes a dev↔prod schema diff; prod objects missing in dev → DROP (blocks publish on destructive changes). To clear it WITHOUT touching prod or copying data: make the **dev DB** a superset of prod (ADD ONLY — never drop/rename). Apply additively where each table's schema lives: Drizzle-managed tables → add cols/tables to `lib/db/src/schema/*` AND apply the same `ALTER/CREATE ... IF NOT EXISTS` directly to the dev DB (do NOT run `drizzle-kit push` — it would DROP the runtime-managed wedding_* tables not in Drizzle); runtime-managed wedding tables → extend `ensureWeddingSchema()` in `artifacts/api-server/src/routes/wedding-cards.ts`. Match prod constraint names exactly (e.g. `*_pkey`, `*_fkey`, `*_unique`). Validate by re-querying: prod tables/cols/constraints all present in dev → no destructive diff. Prod had stale renamed-away wedding tables (wedding_card_templates/wedding_card_guest_entries + wedding_cards FK/extra cols) and attendance_month_closures + attendance_logs.checkin/checkout_photo_url not in dev.

---
name: Runtime-managed DB tables vs Drizzle / publish
description: Why some tables live outside the Drizzle schema, and how that interacts with drizzle-kit push (post-merge) and Replit's publish-time dev→prod diff.
---

# Runtime-managed tables (outside the Drizzle schema)

Some tables in this project are created by **additive/idempotent startup DDL in the
API server** (e.g. `ensureWeddingSchema()` → `wedding_templates`, `wedding_cards`,
`wedding_guest_entries`; `ensureCmsSchema()` → `cms_home_settings`; plus
`ai_follow_up_logs`, `ai_unknown_questions`). These are **intentionally NOT** in the
Drizzle schema (`lib/db/src/schema`). Most other runtime `CREATE TABLE IF NOT EXISTS`
tables are *dual-managed* (also defined in Drizzle), so they are safe.

**Why this matters:** `drizzle-kit push` (run by `scripts/post-merge.sh` as
`pnpm --filter db push`) reconciles the DB to the Drizzle schema. Any table present
in the DB but absent from the Drizzle schema is a **DROP** candidate — that is the
source of `ALTER TABLE wedding_cards DROP CONSTRAINT ..._template_id_fkey` (first step
of dropping the table).

**Guard:** `scripts/post-merge.sh` skips the push when `SAFE_PRODUCTION=1` or
`SKIP_DB_PUSH=1` are set. Default (unset) behavior is unchanged.

**Two SEPARATE schema-application paths — do not conflate:**
1. Post-merge → **development** DB via `drizzle-kit push` (controlled by the guard above).
2. Publish → **production** DB via **Replit's own dev↔prod introspection diff**
   (NOT drizzle-kit, NOT affected by post-merge.sh). It surfaces destructive changes
   in the Publish UI for confirmation.

**How to apply:** To stop a destructive *production* publish, you generally cannot fix
it from post-merge.sh — make the dev schema match prod (additively) or confirm/decline
in the Publish UI. Per the database skill, do NOT write scripts/startup-DDL to migrate
prod. Note the wedding feature was **renamed** at some point: prod still had the old
`wedding_card_templates` / `wedding_card_guest_entries`; dev has `wedding_templates` /
`wedding_guest_entries`. All wedding tables were empty (only seed templates), so the
publish diff's wedding-only drops are harmless; business tables (booking, payments,
customers, attendance, CRM) are Drizzle-managed and identical dev↔prod.

## Publish "copy dev DB → prod" fails on C-language functions
Symptom: deployment BUILD fails (status=failed) at step "Copying development database to production database" with `pg_restore: error: ... ERROR: permission denied for language c` on `CREATE FUNCTION public.immutable_unaccent(...) LANGUAGE c AS '$libdir/unaccent'`. App build/tests are fine — this is the DB-copy-on-publish toggle, not code. Dev has a hand-created C-language wrapper `immutable_unaccent` (around the unaccent extension, for VN accent-insensitive search) NOT owned by an extension, so pg_restore dumps it as raw CREATE FUNCTION; managed Postgres prod role can't create C functions (superuser-only). Fix: publish WITHOUT "Copy development database to production" (schema is already a superset of prod, so no copy needed — this is also what the user wanted). The DB-copy toggle is a Publish-UI setting, not changeable in code.
