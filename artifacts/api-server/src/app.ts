import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import router from "./routes";
import { mountMcp } from "./lib/mcp/server";
import { mountFrontend } from "./lib/serve-frontend";
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

// MCP server (ChatGPT Custom Connector) — mount cạnh /api, TRƯỚC redirect-dev vì
// OAuth dùng path gốc (/authorize, /.well-known/...). Đường kết nối độc lập,
// read-only, có OAuth + role + audit; không đụng /api hiện có.
mountMcp(app);

// Cách C (single origin): backend phục vụ luôn frontend đã build → /mcp + OAuth
// discovery ở ROOT do backend trả JSON (ChatGPT Connector kết nối được). Mount SAU
// /api + MCP nên các path backend luôn thắng; route giao diện còn lại → index.html.
const frontendMounted = mountFrontend(app);

// Local dev (chưa build frontend): :3000 chỉ là API — chuyển route giao diện sang Vite.
if (!frontendMounted && process.env.NODE_ENV !== "production") {
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
