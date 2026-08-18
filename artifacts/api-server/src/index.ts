// PHẢI là import ĐẦU TIÊN: chốt an toàn cho bản preview theo PR phải chạy trước
// khi ./app (và các route đọc env lúc import) được nạp. No-op khi không phải preview.
import "./preview-boot";
// Must be evaluated before ./app and its legacy routes/schedulers.
import "./lib/install-runtime-log-redaction";
import app from "./app";
import { logger } from "./lib/logger";
import runMigrations from "./migrations";
import { assertPreviewDatabaseMarker } from "./lib/preview-db-marker";
import { PreviewGuardError } from "./lib/preview-guard";
import { isPlatformDatabaseConfigured } from "@workspace/platform-db";
import { withTenantDatabaseBySlug, closeTenantDatabaseRouter } from "./platform/tenant-database-router";
import { runDeferredTenantStartupDdl } from "./lib/startup-ddl";

// Validate OpenAI integration on startup
if (!process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"]) {
  logger.warn("AI_INTEGRATIONS_OPENAI_BASE_URL chưa cấu hình — Trợ lý AI chạy chế độ Copilot (dữ liệu DB).");
}

const rawPort = Number(process.env.PORT);
const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 3000;

// Preview: xác thực chính DATABASE có dấu hiệu "database preview" TRƯỚC mọi DDL.
// Production: hàm này trả về ngay, không chạm database.
const prepareBusinessDatabase = async () => {
  const prepare = async () => {
    await assertPreviewDatabaseMarker();
    await runMigrations();
    await runDeferredTenantStartupDdl();
  };
  if (!isPlatformDatabaseConfigured()) {
    await prepare();
    return;
  }
  // PR2 only maps the existing Amazing database. Future tenant migrations are
  // performed by the provisioning engine in PR3, never by process fallback.
  const slug = process.env.STARTUP_TENANT_SLUG?.trim().toLowerCase() || "amazing-studio";
  await withTenantDatabaseBySlug(slug, prepare);
};

prepareBusinessDatabase()
  .catch((err) => {
    if (err instanceof PreviewGuardError) {
      logger.error({ err }, `[preview-guard] ${err.message}`);
    } else {
      logger.error({ err }, "Migration failed, aborting startup");
    }
    process.exit(1);
  })
  .then(() => {
    const server = app.listen(port, (err?: Error) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });

    const shutdown = () => server.close(() => {
      void closeTenantDatabaseRouter().finally(() => process.exit(0));
    });
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
