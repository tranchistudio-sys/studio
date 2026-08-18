import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import router from "./routes";
import { mountMcp } from "./lib/mcp/server";
import { mountFrontend } from "./lib/serve-frontend";
import { previewBasicAuth } from "./lib/preview-basic-auth";
import { logger } from "./lib/logger";
import { startFollowUpScheduler } from "./follow-up-scheduler";
import { startTestFollowUpScheduler } from "./test-follow-up-scheduler";
import { startDeadlineChecker, startWeddingPrepReminder } from "./routes/notifications";
import { startAutoPostScheduler } from "./autopost-scheduler";

export interface CreateAppOptions {
  startSchedulers?: boolean;
  mountMcpServer?: boolean;
  mountBuiltFrontend?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Express {
const application: Express = express();

// Production hiện đi qua đúng một reverse proxy (Nginx/Fly). Không tin chuỗi
// X-Forwarded-For tùy ý vì IP còn được dùng cho rate-limit và chấm công.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? "1");
application.set("trust proxy", Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);

// BẢN PREVIEW THEO PR (Fly.io review app): chặn toàn site sau 1 mật khẩu, TRƯỚC
// mọi middleware khác. Production KHÔNG đặt PREVIEW_MODE=1 → trả null → không
// mount gì cả, hành vi prod không đổi một chút nào.
const previewGate = previewBasicAuth();
if (previewGate) application.use(previewGate);

application.use(
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
const configuredOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
if (process.env.PUBLIC_APP_URL) configuredOrigins.add(process.env.PUBLIC_APP_URL.replace(/\/$/, ""));
if (process.env.NODE_ENV === "production") configuredOrigins.add("https://tranchistudio.com");
application.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(null, configuredOrigins.has(origin));
  },
}));
application.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});
// Nén gzip mọi JSON trả về (payload lớn như /api/customers, /api/staff giảm ~5-10x trên mobile).
// Bỏ qua SSE (text/event-stream ở ai.ts, ai-test.ts, notifications.ts) — nén sẽ buffer làm treo stream.
application.use(
  compression({
    filter: (req, res) => {
      const contentType = String(res.getHeader("Content-Type") || "");
      if (contentType.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }),
);
// Facebook cần raw bytes để kiểm HMAC trước khi parse JSON. Route-specific
// 1 MB limit ngăn request công khai giữ hàng chục MB trong bộ nhớ.
application.use("/api/webhook/facebook", express.raw({ type: "application/json", limit: "1mb" }));
application.use(express.json({ limit: "20mb" }));
application.use(express.urlencoded({ extended: true, limit: "20mb" }));
application.use(cookieParser());

application.use("/api", router);

// MCP server (ChatGPT Custom Connector) — mount cạnh /api, TRƯỚC redirect-dev vì
// OAuth dùng path gốc (/authorize, /.well-known/...). Đường kết nối độc lập,
// read-only, có OAuth + role + audit; không đụng /api hiện có.
if (options.mountMcpServer !== false) mountMcp(application);

// Cách C (single origin): backend phục vụ luôn frontend đã build → /mcp + OAuth
// discovery ở ROOT do backend trả JSON (ChatGPT Connector kết nối được). Mount SAU
// /api + MCP nên các path backend luôn thắng; route giao diện còn lại → index.html.
const frontendMounted = options.mountBuiltFrontend === false ? false : mountFrontend(application);

// Local dev (chưa build frontend): :3000 chỉ là API — chuyển route giao diện sang Vite.
if (!frontendMounted && process.env.NODE_ENV !== "production") {
  const viteDevUrl = (process.env.VITE_DEV_URL || "http://localhost:5173").replace(/\/$/, "");
  application.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    res.redirect(302, `${viteDevUrl}${req.originalUrl}`);
  });
}


if (options.startSchedulers !== false) {
  startFollowUpScheduler();
  startTestFollowUpScheduler();
  startDeadlineChecker();
  startWeddingPrepReminder();
  startAutoPostScheduler();
}

return application;
}

const app = createApp({ startSchedulers: process.env.NODE_ENV !== "test" });
export default app;
