#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// DEPLOY GUARD — fail-closed, chạy ĐẦU mỗi lần build api-server (local lẫn
// Replit production build qua artifact.toml). Sinh ra từ sự cố 24/07/2026:
// màn Replit Publishing đề xuất DROP TABLE lulu_* CASCADE trên production.
//
// Nguyên tắc: deploy là CODE-ONLY. Guard DỪNG build (exit 1) nếu phát hiện
// bất kỳ dấu hiệu nào có thể dẫn tới DDL/migration tự động trong deploy path:
//   1. File migration lạ (generated ngoài kế hoạch) trong lib/db/migrations
//   2. SQL destructive (DROP TABLE/COLUMN/…, TRUNCATE, ALTER … DROP) trong đó
//   3. Lệnh drizzle-kit push / db push trong config deploy (.replit, artifact.toml)
//      hoặc trong các build script
//   4. scripts/post-merge.sh mất guard opt-in (ai đó revert về push-mặc-định)
//   5. startup-ddl.ts mất fail-closed production
//
// LƯU Ý: bước "Database migrations" trong màn Publishing là của PLATFORM Replit
// (diff schema DEV DB ↔ PROD DB) — không script nào trong repo tắt được. Guard
// này chặn mọi nguồn DDL từ phía repo; phần platform xử lý bằng cách giữ
// DEV DB = PROD DB (migrations.ts áp additive lên dev) + quy tắc sắt:
// màn migration còn BẤT KỲ dòng DROP nào → Cancel, không Approve.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const ok = [];

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// ── 1+2. lib/db/migrations: allowlist + không destructive ────────────────────
const MIGRATIONS_DIR = "lib/db/migrations";
const MIGRATION_ALLOWLIST = new Set([
  "0001_additional_services.sql",
  "0002_autopost_facebook.sql",
  "0003_wedding_card_media_rsvp.sql",
  "0003_wedding_gift_programs.sql",
  "0004_seed_amazing_wedding_gifts.sql",
  "0005_analytics_attribution.sql",
  "0006_cms_home_wedding_intro.sql",
  "0007_tenant_metadata.sql",
]);
const DESTRUCTIVE_SQL =
  /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|SCHEMA|INDEX|SEQUENCE|VIEW)\b|\bTRUNCATE\b|\bALTER\s+TABLE\b[^;]*\bDROP\b/i;

if (exists(MIGRATIONS_DIR)) {
  const entries = fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR));
  for (const entry of entries) {
    if (!MIGRATION_ALLOWLIST.has(entry)) {
      errors.push(
        `${MIGRATIONS_DIR}/${entry}: file/thư mục migration NGOÀI allowlist — có thể là migration generated ngoài kế hoạch (drizzle-kit generate?). Xoá đi hoặc chủ động thêm vào allowlist trong scripts/deploy-guard.mjs sau khi review.`,
      );
      continue;
    }
    const sql = read(`${MIGRATIONS_DIR}/${entry}`);
    const m = sql.match(DESTRUCTIVE_SQL);
    if (m) {
      errors.push(`${MIGRATIONS_DIR}/${entry}: chứa SQL destructive ("${m[0]}") — cấm tuyệt đối trong deploy path.`);
    }
  }
  if (!errors.length) ok.push(`migrations folder: ${entries.length} file, đúng allowlist, không destructive`);
}

// Platform DB có migration riêng, nhưng chỉ được chạy bằng lệnh explicit
// `pnpm --filter @workspace/platform-db migrate`. Build/start production tuyệt
// đối không được tự gọi. Guard vẫn review allowlist + SQL additive ở đây.
const PLATFORM_MIGRATIONS_DIR = "lib/platform-db/migrations";
const PLATFORM_MIGRATION_ALLOWLIST = new Set([
  "0001_platform_foundation.sql",
  "0002_membership_session_revocation.sql",
  "0003_tenant_database_registry_isolation.sql",
  "0004_staff_access_requests.sql",
  "0005_commercial_saas_foundation.sql",
]);
if (exists(PLATFORM_MIGRATIONS_DIR)) {
  const entries = fs.readdirSync(path.join(ROOT, PLATFORM_MIGRATIONS_DIR));
  for (const entry of entries) {
    if (!PLATFORM_MIGRATION_ALLOWLIST.has(entry)) {
      errors.push(`${PLATFORM_MIGRATIONS_DIR}/${entry}: platform migration ngoài allowlist.`);
      continue;
    }
    const statementsOnly = read(`${PLATFORM_MIGRATIONS_DIR}/${entry}`).replace(/--.*$/gm, "");
    const destructive = statementsOnly.match(DESTRUCTIVE_SQL);
    if (destructive) {
      errors.push(
        `${PLATFORM_MIGRATIONS_DIR}/${entry}: chứa SQL destructive ("${destructive[0]}").`,
      );
    }
  }
  if (!errors.length) ok.push(`platform migrations: ${entries.length} file additive, chạy explicit-only`);
}

// ── 3. Config deploy + build script: không được gọi push/migrate ─────────────
const PUSH_CMD = /(drizzle[-\s]?kit|--filter\s+db\s+push|\bdb\s+push\b|push-force|\bdrizzle\s+push\b)/i;

const DEPLOY_CONFIGS = [
  ".replit",
  "artifacts/api-server/.replit-artifact/artifact.toml",
  "artifacts/amazing-studio/.replit-artifact/artifact.toml",
  "artifacts/mockup-sandbox/.replit-artifact/artifact.toml",
];
for (const f of DEPLOY_CONFIGS) {
  if (!exists(f)) continue;
  const m = read(f).match(PUSH_CMD);
  if (m) errors.push(`${f}: chứa lệnh push/migrate ("${m[0]}") trong config deploy — deploy phải CODE-ONLY.`);
  else ok.push(`${f}: sạch (không push/migrate)`);
}

const BUILD_SCRIPTS = [
  ["package.json", ["build", "build:deploy", "build:ci", "postinstall"]],
  ["artifacts/api-server/package.json", ["build", "start"]],
  ["artifacts/amazing-studio/package.json", ["build"]],
  ["lib/platform-db/package.json", ["build", "start", "postinstall"]],
];
for (const [f, keys] of BUILD_SCRIPTS) {
  if (!exists(f)) continue;
  const scripts = JSON.parse(read(f)).scripts ?? {};
  for (const k of keys) {
    const cmd = scripts[k];
    if (cmd && PUSH_CMD.test(cmd)) {
      errors.push(`${f} → scripts.${k}: gọi push/migrate ("${cmd}") — cấm trong build path.`);
    }
  }
  ok.push(`${f}: build scripts sạch`);
}

const API_ENTRYPOINT = "artifacts/api-server/src/index.ts";
if (exists(API_ENTRYPOINT)) {
  const entrypoint = read(API_ENTRYPOINT);
  if (/platform-db\/src\/migrate|@workspace\/platform-db[^\n]*migrate/i.test(entrypoint)) {
    errors.push(`${API_ENTRYPOINT}: không được import platform migration vào startup.`);
  } else {
    ok.push(`${API_ENTRYPOINT}: không auto-run platform migration`);
  }
}

// ── 4. post-merge.sh phải giữ guard opt-in ───────────────────────────────────
const POST_MERGE = "scripts/post-merge.sh";
if (exists(POST_MERGE)) {
  const sh = read(POST_MERGE);
  if (!sh.includes("DEPLOY-GUARD: db push là OPT-IN") || !sh.includes("ALLOW_DB_PUSH")) {
    errors.push(
      `${POST_MERGE}: mất guard opt-in (marker "DEPLOY-GUARD: db push là OPT-IN" / ALLOW_DB_PUSH) — ai đó đã revert về drizzle-kit push mặc định?`,
    );
  } else {
    ok.push(`${POST_MERGE}: db push là opt-in (ALLOW_DB_PUSH=1)`);
  }
}

// ── 5. startup-ddl.ts phải giữ fail-closed production ────────────────────────
const STARTUP_DDL = "artifacts/api-server/src/lib/startup-ddl.ts";
if (exists(STARTUP_DDL)) {
  if (!read(STARTUP_DDL).includes("ALLOW_STARTUP_DDL_IN_PRODUCTION")) {
    errors.push(`${STARTUP_DDL}: mất fail-closed production (ALLOW_STARTUP_DDL_IN_PRODUCTION) — DDL có thể tự chạy trên prod nếu quên env.`);
  } else {
    ok.push(`${STARTUP_DDL}: production fail-closed`);
  }
}

// ── Kết quả ──────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error("\n❌ [deploy-guard] BUILD DỪNG — phát hiện nguy cơ DDL/migration trong deploy path:\n");
  for (const e of errors) console.error("  • " + e);
  console.error("\n[deploy-guard] Deploy phải CODE-ONLY. Sửa các mục trên rồi build lại.\n");
  process.exit(1);
}
console.log("✅ [deploy-guard] PASS — deploy path sạch (code-only):");
for (const line of ok) console.log("  ✓ " + line);
