import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { startFollowUpScheduler } from "./follow-up-scheduler";
import { startTestFollowUpScheduler } from "./test-follow-up-scheduler";
import { startDeadlineChecker, startWeddingPrepReminder } from "./routes/notifications";
import { startAutoPostScheduler } from "./autopost-scheduler";

const app: Express = express();

// Cần IP thật của client (xác thực WiFi studio) — tin x-forwarded-for từ proxy (Vite dev / reverse proxy)
app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Nén gzip mọi JSON trả về (payload lớn như /api/customers, /api/staff giảm ~5-10x trên mobile).
// Bỏ qua SSE (text/event-stream ở ai.ts, ai-test.ts, notifications.ts) — nén sẽ buffer làm treo stream.
app.use(
  compression({
    filter: (req, res) => {
      const contentType = String(res.getHeader("Content-Type") || "");
      if (contentType.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }),
);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use("/api", router);

// Local dev: :3000 chỉ là API — trình duyệt mở /pricing,... chuyển sang Vite.
if (process.env.NODE_ENV !== "production") {
  const viteDevUrl = (process.env.VITE_DEV_URL || "http://localhost:5173").replace(/\/$/, "");
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    res.redirect(302, `${viteDevUrl}${req.originalUrl}`);
  });
}


startFollowUpScheduler();
startTestFollowUpScheduler();
startDeadlineChecker();
startWeddingPrepReminder();
startAutoPostScheduler();

export default app;
