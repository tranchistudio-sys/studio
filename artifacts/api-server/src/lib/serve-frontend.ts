/**
 * serve-frontend.ts — Cách C: backend Express phục vụ luôn frontend đã build
 * (artifacts/amazing-studio/dist/public) làm SINGLE ORIGIN, để /mcp + OAuth
 * discovery ở ROOT do backend trả JSON (ChatGPT Custom Connector kết nối được).
 *
 * QUAN TRỌNG: mount SAU /api và MCP/OAuth → các path backend luôn thắng; chỉ route
 * giao diện còn lại mới rơi vào SPA fallback (index.html) cho React Router.
 * KHÔNG đụng DB, KHÔNG migration.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { logger } from "./logger.js";

/** Path backend — TUYỆT ĐỐI không trả index.html cho các path này (để chúng trả JSON/handler thật). */
const BACKEND_PREFIXES = ["/api", "/mcp", "/.well-known", "/authorize", "/token", "/register"];

export function isBackendPath(p: string): boolean {
  return BACKEND_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/") || p.startsWith(pre + "?"));
}

/**
 * Tìm thư mục frontend dist trong production. Thử nhiều vị trí để bền với cwd khác
 * nhau (repo root / artifacts/api-server) + bundle location; cho phép ENV override.
 * Trả null nếu chưa build (dev) → khi đó KHÔNG serve static.
 */
export function resolveFrontendDist(): string | null {
  const here = (() => {
    try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
  })();
  const cwd = process.cwd();
  const candidates = [
    process.env.FRONTEND_DIST,
    // bundle chạy ở artifacts/api-server/dist → ../../amazing-studio/dist/public
    path.resolve(here, "../../amazing-studio/dist/public"),
    path.resolve(here, "../amazing-studio/dist/public"),
    // cwd = repo root
    path.resolve(cwd, "artifacts/amazing-studio/dist/public"),
    // cwd = artifacts/api-server
    path.resolve(cwd, "../amazing-studio/dist/public"),
  ].filter((c): c is string => !!c);

  for (const dir of candidates) {
    if (existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

/**
 * Mount phục vụ frontend (static + SPA fallback) nếu tìm thấy bản build.
 * @returns true nếu đã mount (production), false nếu không có dist (dev).
 */
export function mountFrontend(app: Express): boolean {
  const dist = resolveFrontendDist();
  if (!dist) {
    logger.warn("[frontend] Không tìm thấy dist/public — KHÔNG serve frontend (chế độ dev dùng Vite).");
    return false;
  }
  logger.info({ dist }, "[frontend] Serve frontend static + SPA fallback từ backend (single origin).");

  // Static assets (JS/CSS/ảnh…). index:false để SPA fallback tự trả index.html cho "/".
  app.use(express.static(dist, { index: false, maxAge: "1h", fallthrough: true }));

  // SPA fallback — CHỈ cho GET/HEAD route giao diện; KHÔNG nuốt path backend.
  const indexHtml = path.join(dist, "index.html");
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (isBackendPath(req.path)) return next(); // /api, /mcp, /.well-known, /authorize, /token, /register
    res.sendFile(indexHtml, (err) => { if (err) next(err); });
  });
  return true;
}
