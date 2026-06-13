---
name: Wedding-cards & CMS home backend (Amazing Studio)
description: How the new-frontend-only features get their backend; contract + migration conventions
---
The imported frontend ships features whose backend lives in api-server and must match exact JSON contracts in the frontend hooks (camelCase keys). Source of truth for shapes: `artifacts/amazing-studio/src/hooks/use-public-cms.ts`, `use-cms-home-admin.ts`, `use-wedding-cards.ts`, `use-wedding-templates-admin.ts`.

**Migration convention:** api-server creates/extends tables at startup via raw `pool.query("CREATE TABLE IF NOT EXISTS ...")` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` inside an `ensure*Schema()` function (see top of `routes/cms.ts` and `routes/wedding-cards.ts`). Additive only — never drop/alter existing columns, to avoid destroying data. Seeding is guarded by a transaction + `pg_advisory_xact_lock` to avoid duplicate seeds across parallel instances.

**Build/run:** api-server runs from bundled `dist` (esbuild via `build.mjs`), NOT tsx. So source edits require a workflow restart to take effect; `tsc --noEmit` shows many pre-existing project-wide errors (TS7030 "not all code paths return", `galleryAlbumsTable` missing export) that are NOT build blockers — esbuild bundles transpile-only.

**Frontend fallback path pattern:** admin hooks try a primary path then a fallback (e.g. wedding templates try `/api/cms/wedding-templates` first, then `/api/wedding-cards/admin/templates`; home-settings try `/api/cms/home-settings` then `/api/cms/admin/public-home`). Implementing the fallback path is sufficient — frontend handles the first 404 silently.

Wedding template seed slugs MUST be `classic|modern|romantic` (themeKey same) to match `FALLBACK_WEDDING_TEMPLATES` in `components/wedding-card/wedding-card-config.ts` and the renderer templates.
