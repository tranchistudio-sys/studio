import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { isLlmConfigured } from "../lib/studio-copilot";
import { pool } from "@workspace/db";
import { getPlatformPool, isPlatformDatabaseConfigured } from "@workspace/platform-db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Authenticated readiness check. The public liveness endpoint stays cheap;
// this route verifies both control-plane schema and the selected tenant DB.
router.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    if (isPlatformDatabaseConfigured()) {
      const result = await getPlatformPool().query<{
        foundation_migration_applied: boolean;
        membership_revocation_migration_applied: boolean;
        registry_isolation_migration_applied: boolean;
        membership_auth_version: string | null;
        membership_sessions_revoked_at: string | null;
        platform_users: string | null;
        tenants: string | null;
        sessions: string | null;
        database_registry: string | null;
        database_registry_unique_index: string | null;
      }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM platform_schema_migrations
             WHERE filename = '0001_platform_foundation.sql'
               AND checksum_sha256 IS NOT NULL
           ) AS foundation_migration_applied,
           EXISTS (
             SELECT 1 FROM platform_schema_migrations
             WHERE filename = '0002_membership_session_revocation.sql'
               AND checksum_sha256 IS NOT NULL
           ) AS membership_revocation_migration_applied,
           EXISTS (
             SELECT 1 FROM platform_schema_migrations
             WHERE filename = '0003_tenant_database_registry_isolation.sql'
               AND checksum_sha256 IS NOT NULL
           ) AS registry_isolation_migration_applied,
           (
             SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'tenant_memberships'
               AND column_name = 'auth_version'
           ) AS membership_auth_version,
           (
             SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'tenant_memberships'
               AND column_name = 'sessions_revoked_at'
           ) AS membership_sessions_revoked_at,
           to_regclass('public.platform_users')::text AS platform_users,
           to_regclass('public.tenants')::text AS tenants,
           to_regclass('public.sessions')::text AS sessions,
           to_regclass('public.tenant_database_registry')::text AS database_registry,
           to_regclass('public.tenant_database_registry_physical_database_unique')::text
             AS database_registry_unique_index`,
      );
      const schema = result.rows[0];
      if (
        !schema?.foundation_migration_applied ||
        !schema.membership_revocation_migration_applied ||
        !schema.registry_isolation_migration_applied ||
        !schema.membership_auth_version ||
        !schema.membership_sessions_revoked_at ||
        !schema.platform_users ||
        !schema.tenants ||
        !schema.sessions ||
        !schema.database_registry ||
        !schema.database_registry_unique_index
      ) throw new Error("platform schema is not migrated");
    }
    res.set("Cache-Control", "no-store");
    res.json({ status: "ready", platformEnabled: isPlatformDatabaseConfigured() });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

router.get("/check-ai-key", (_req, res) => {
  // Dùng CHUNG isLlmConfigured() với backend chat: trước đây endpoint này chỉ
  // check OpenAI env → máy có ANTHROPIC_API_KEY vẫn bị báo "chưa có AI",
  // frontend hiện banner sai sự thật.
  const llmReady = isLlmConfigured();
  res.json({
    configured: true,
    mode: llmReady ? "llm" : "copilot",
    llmReady,
  });
});

export default router;
