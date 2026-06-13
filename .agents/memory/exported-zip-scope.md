---
name: Exported zip scope (Amazing Studio)
description: What a downloaded source zip contains and how to safely re-import it
---
Exported/downloaded source zips from this project are **single-artifact** (e.g. just `artifacts/amazing-studio` frontend: `src/`, `vite.config.ts`, `index.html`, `.replit-artifact`, plus `node_modules`/`dist`/`.env.development`). They are NOT the full monorepo (no `lib/`, no `api-server`, no `pnpm-workspace.yaml`).

**How to apply:** When re-importing such a zip, scope the replacement to the matching artifact dir only. Exclude `node_modules` and `dist` (reinstall + rebuild). Preserve the existing `.replit-artifact/` (platform-managed workflow config), do not overwrite it.

**Why:** Replacing the whole workspace with a single-artifact zip would delete the backend/lib.

Dev API proxy: the new frontend uses a Vite `/api` proxy via `VITE_API_PROXY_TARGET`. The exported `.env.development` ships `http://localhost:3000`, but the api-server in this env listens on the port in its `artifact.toml` (was 8080). Point the proxy at the api-server's actual localPort.

Frontend can be ahead of backend: new frontend may call endpoints the un-updated api-server lacks (e.g. `/api/cms/public/home` → 404), handled via fallback. Updating only one artifact can create such FE/BE gaps.
