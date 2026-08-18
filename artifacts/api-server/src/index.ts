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

// Validate OpenAI integration on startup
if (!process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"]) {
  logger.warn("AI_INTEGRATIONS_OPENAI_BASE_URL chưa cấu hình — Trợ lý AI chạy chế độ Copilot (dữ liệu DB).");
}

const rawPort = Number(process.env.PORT);
const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 3000;

// Preview: xác thực chính DATABASE có dấu hiệu "database preview" TRƯỚC mọi DDL.
// Production: hàm này trả về ngay, không chạm database.
assertPreviewDatabaseMarker()
  .then(() => runMigrations())
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

    const shutdown = () => server.close(() => process.exit(0));
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
