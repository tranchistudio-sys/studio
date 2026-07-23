/**
 * server.ts — Lắp MCP server READ-ONLY vào Express (mount cạnh /api, KHÔNG mở DB
 * trực tiếp). Luồng: ChatGPT → OAuth (mcpAuthRouter) → /mcp (requireBearerAuth) →
 * tool (role check) → engine → DB → JSON có cấu trúc.
 *
 * Stateless transport (không giữ session in-memory) — hợp Replit autoscale.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { registerReadTools } from "./tools.js";
import {
  mcpOAuthProvider,
  authenticateStaff,
  createAuthorizationCode,
  renderLoginPage,
  publicBaseUrl,
  MCP_PATH,
  LOGIN_PATH,
  SCOPE,
} from "./oauth.js";

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "amazing-studio", version: "1.0.0" },
    { instructions: "MCP đọc dữ liệu Amazing Studio (kinh doanh, công nợ, lịch chụp). Chỉ đọc." },
  );
  registerReadTools(server);
  return server;
}

// ─── Rate limit theo IP (chống lạm dụng) ───────────────────────────────────────
const RL_WINDOW_MS = 60_000;
const RL_MAX = 60;
// LƯU Ý (review #127): các bộ đếm dưới là in-memory PER-INSTANCE. Trên Replit
// autoscale nhiều instance, giới hạn thực nới theo số instance — chấp nhận cho
// Phase 1 (đã tốt hơn nhiều so với KHÔNG có); Phase 2 chuyển store chia sẻ nếu cần.
type Bucket = { count: number; resetAt: number };
function sweep(map: Map<string, Bucket>, now: number): void {
  if (map.size < 5000) return; // chỉ quét khi map to (bound bộ nhớ, chống rò rỉ)
  for (const [k, v] of map) if (v.resetAt < now) map.delete(k);
}
/** Đếm+chặn theo key trong cửa sổ; trả true nếu VƯỢT ngưỡng (đã chặn). */
function hitLimit(map: Map<string, Bucket>, key: string, max: number, windowMs: number, now: number): boolean {
  const e = map.get(key);
  if (!e || e.resetAt < now) { map.set(key, { count: 1, resetAt: now + windowMs }); return false; }
  if (e.count >= max) return true;
  e.count++;
  return false;
}

const rlMap = new Map<string, Bucket>();
function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  sweep(rlMap, now);
  if (hitLimit(rlMap, req.ip || "unknown", RL_MAX, RL_WINDOW_MS, now)) {
    res.status(429).json({ error: "rate_limited", message: "Quá nhiều yêu cầu, thử lại sau ít giây." });
    return;
  }
  next();
}

// ─── B1 (review #127): chống brute-force MẬT KHẨU ở /mcp/oauth/login ────────────
// Khoá theo USERNAME (chính — vì trust proxy=true nên IP giả mạo được qua XFF) +
// theo IP (phụ). Ngưỡng thấp; đếm MỌI lần thử, reset username khi đăng nhập đúng.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_USER = 8;
const LOGIN_MAX_PER_IP = 40;
const loginByUser = new Map<string, Bucket>();
const loginByIp = new Map<string, Bucket>();
function loginGuard(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  sweep(loginByUser, now); sweep(loginByIp, now);
  const username = String((req.body as Record<string, unknown> | undefined)?.username ?? "").trim().toLowerCase();
  const ip = req.ip || "unknown";
  const blocked =
    (username && hitLimit(loginByUser, username, LOGIN_MAX_PER_USER, LOGIN_WINDOW_MS, now)) ||
    hitLimit(loginByIp, ip, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS, now);
  if (blocked) {
    res.status(429).setHeader("Retry-After", "900");
    res.send("Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau 15 phút.");
    return;
  }
  next();
}
/** Đăng nhập ĐÚNG → xoá bộ đếm username (không khoá oan người dùng thật). */
function clearLoginAttempts(username: string): void {
  loginByUser.delete(username.trim().toLowerCase());
}

// ─── Handler /mcp (POST, stateless) ────────────────────────────────────────────
async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    // req.auth (do requireBearerAuth gắn) được transport chuyển vào extra.authInfo của tool.
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Lỗi máy chủ MCP" }, id: null });
    }
  }
}

// ─── Login handler cho OAuth authorize (POST từ trang đăng nhập) ───────────────
async function handleLogin(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const clientId = String(body.client_id ?? "");
  const redirectUri = String(body.redirect_uri ?? "");
  const codeChallenge = String(body.code_challenge ?? "");
  const state = body.state ? String(body.state) : undefined;
  const scopes = (body.scope ? String(body.scope).split(" ") : [SCOPE]).filter(Boolean);

  const client = await mcpOAuthProvider.clientsStore.getClient(clientId);
  if (!client) { res.status(400).send("client_id không hợp lệ"); return; }
  // Defense-in-depth: redirect_uri PHẢI thuộc client đã đăng ký (chống open redirect).
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    res.status(400).send("redirect_uri không hợp lệ"); return;
  }
  if (!codeChallenge) { res.status(400).send("thiếu code_challenge (PKCE)"); return; }

  const username = String(body.username ?? "");
  const auth = await authenticateStaff(username, String(body.password ?? ""));
  if (!auth.ok) {
    res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderLoginPage({ clientId, clientName: client.client_name, redirectUri, codeChallenge, state, scopes, error: "Sai tên đăng nhập hoặc mật khẩu." }));
    return;
  }
  clearLoginAttempts(username); // đăng nhập đúng → gỡ khoá brute-force cho username này

  const code = await createAuthorizationCode({
    clientId, redirectUri, codeChallenge, staffId: auth.staffId, role: auth.role, scopes,
  });
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
}

/**
 * Mount toàn bộ MCP + OAuth vào app. GỌI TRƯỚC middleware redirect-dev (vì OAuth
 * dùng các path gốc GET /authorize, /.well-known/...).
 */
export function mountMcp(app: Express): void {
  const base = publicBaseUrl();
  const issuerUrl = new URL(base);
  const resourceServerUrl = new URL(base + MCP_PATH);

  // OAuth 2.1 AS: metadata + DCR + /authorize + /token + revoke (SDK lo PKCE/spec).
  app.use(
    mcpAuthRouter({
      provider: mcpOAuthProvider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl,
      scopesSupported: [SCOPE],
      resourceName: "Amazing Studio",
    }),
  );

  // Trang đăng nhập studio (bước consent của authorize) POST về đây — có chống brute-force (B1).
  app.post(LOGIN_PATH, loginGuard, handleLogin);

  // Endpoint MCP — bắt buộc Bearer token hợp lệ + scope; 401 kèm link protected-resource metadata.
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  app.post(MCP_PATH, rateLimit, requireBearerAuth({ verifier: mcpOAuthProvider, requiredScopes: [SCOPE], resourceMetadataUrl }), handleMcpPost);
  // Stateless: không hỗ trợ GET/DELETE session.
  app.get(MCP_PATH, (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
  app.delete(MCP_PATH, (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
}
