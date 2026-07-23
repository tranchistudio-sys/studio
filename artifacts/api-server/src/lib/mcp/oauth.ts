/**
 * oauth.ts — OAuth 2.1 (Authorization Code + PKCE) cho MCP server, theo chuẩn
 * MCP authorization spec (ChatGPT Custom Connector dùng chuẩn này). KHÔNG tự phát
 * minh auth: dựa `mcpAuthRouter` của SDK (lo metadata/DCR/PKCE/token endpoint),
 * ta chỉ cấp `OAuthServerProvider`.
 *
 * - Đăng nhập: TÁI DÙNG tài khoản staff Amazing Studio (username + bcrypt), map ra
 *   role admin/staff hiện có → nhúng vào access token.
 * - Access/refresh token = JWT HS256 ký bằng SESSION_SECRET (KHÔNG lưu client-side,
 *   KHÔNG token nhúng frontend). Client DCR + auth code lưu qua settings KV (không DDL).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  getStoredClient,
  putStoredClient,
  putAuthCode,
  peekAuthCode,
  consumeAuthCode,
} from "./oauth-store.js";

// ─── Bí mật + URL cơ sở ────────────────────────────────────────────────────────

function jwtSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET chưa cấu hình ở production — từ chối khởi động MCP OAuth.");
  }
  return "amazing-studio-secret-2025"; // chỉ dev, đồng bộ auth.ts
}

/** URL công khai gốc của app (issuer OAuth). Ưu tiên ENV, dev fallback localhost. */
export function publicBaseUrl(): string {
  const raw = process.env.MCP_PUBLIC_URL || process.env.PUBLIC_APP_URL || "http://localhost:3000";
  return raw.replace(/\/$/, "");
}

export const MCP_PATH = "/mcp";
export const LOGIN_PATH = "/mcp/oauth/login";
export const SCOPE = "amazing:read";

// ─── JWT tối giản (HS256, base64url) — đồng bộ cách ký của routes/auth.ts ───────

type TokenKind = "access" | "refresh";
type TokenClaims = { sub: number; role: "admin" | "staff"; scope: string; cid: string; typ: TokenKind; exp: number };

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function signJwt(claims: TokenClaims): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", jwtSecret()).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, sig] = parts;
  const expected = createHmac("sha256", jwtSecret()).update(`${h}.${b}`).digest("base64url");
  const a = Buffer.from(sig);
  const e = Buffer.from(expected);
  if (a.length !== e.length || !timingSafeEqual(a, e)) return null;
  let claims: TokenClaims;
  try { claims = JSON.parse(Buffer.from(b, "base64url").toString()); } catch { return null; }
  if (!claims || typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
  return claims;
}

const ACCESS_TTL = 12 * 3600;      // 12 giờ
const REFRESH_TTL = 30 * 24 * 3600; // 30 ngày

function issueTokens(staffId: number, role: "admin" | "staff", clientId: string): OAuthTokens {
  const now = Math.floor(Date.now() / 1000);
  const access = signJwt({ sub: staffId, role, scope: SCOPE, cid: clientId, typ: "access", exp: now + ACCESS_TTL });
  const refresh = signJwt({ sub: staffId, role, scope: SCOPE, cid: clientId, typ: "refresh", exp: now + REFRESH_TTL });
  return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, scope: SCOPE, refresh_token: refresh };
}

// ─── Xác thực staff (tái dùng bảng staff + bcrypt như routes/auth.ts) ──────────

export type StaffAuthResult =
  | { ok: true; staffId: number; role: "admin" | "staff"; name: string }
  | { ok: false };

export async function authenticateStaff(username: string, password: string): Promise<StaffAuthResult> {
  const u = (username ?? "").trim();
  const p = password ?? "";
  if (!u || !p) return { ok: false };
  const r = await pool.query(
    `SELECT id, name, role, roles, password_hash FROM staff WHERE username = $1 AND is_active = 1 LIMIT 1`,
    [u],
  );
  if (!r.rows.length) return { ok: false };
  const row = r.rows[0] as { id: number; name: string | null; role: string; roles: unknown; password_hash: string | null };
  if (!row.password_hash) return { ok: false };
  const match = await bcrypt.compare(p, row.password_hash);
  if (!match) return { ok: false };
  const isAdmin = row.role === "admin" || (Array.isArray(row.roles) && row.roles.includes("admin"));
  return { ok: true, staffId: Number(row.id), role: isAdmin ? "admin" : "staff", name: row.name?.trim() || `#${row.id}` };
}

// ─── Trang đăng nhập (HTML tối giản, không JS, không lộ secret) ────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderLoginPage(params: {
  clientId: string; redirectUri: string; codeChallenge: string; state?: string; scopes: string[]; error?: string;
}): string {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kết nối ChatGPT · Amazing Studio</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f5f7;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;padding:28px;max-width:360px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:18px;margin:0 0 4px}p{color:#666;font-size:13px;margin:0 0 18px}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:11px;border:1px solid #ddd;border-radius:9px;font-size:15px}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:9px;background:#111;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#c0392b;font-size:13px;margin-top:10px}.scope{background:#f0f4ff;border-radius:8px;padding:8px 10px;font-size:12px;color:#334;margin-top:14px}</style>
</head><body><div class="card">
<h1>✨ Amazing Studio</h1>
<p>Cho phép <b>ChatGPT</b> đọc dữ liệu studio của bạn (chỉ đọc).</p>
<form method="post" action="${LOGIN_PATH}">
${hidden("client_id", params.clientId)}${hidden("redirect_uri", params.redirectUri)}
${hidden("code_challenge", params.codeChallenge)}${hidden("state", params.state ?? "")}
${hidden("scope", params.scopes.join(" "))}
<label>Tên đăng nhập</label><input type="text" name="username" autocomplete="username" autofocus>
<label>Mật khẩu</label><input type="password" name="password" autocomplete="current-password">
<div class="scope">Quyền cấp: đọc tình hình kinh doanh, công nợ, lịch chụp. KHÔNG cho phép sửa/xoá.</div>
${params.error ? `<div class="err">${escapeHtml(params.error)}</div>` : ""}
<button type="submit">Đăng nhập &amp; kết nối</button>
</form></div></body></html>`;
}

// ─── OAuthServerProvider ───────────────────────────────────────────────────────

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    return getStoredClient(clientId);
  },
  async registerClient(client) {
    // SDK đã sinh client_id/client_id_issued_at; ta chỉ lưu lại (DCR public client + PKCE).
    const full = client as OAuthClientInformationFull;
    await putStoredClient(full);
    return full;
  },
};

export const mcpOAuthProvider: OAuthServerProvider = {
  clientsStore,

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // SDK đã validate redirect_uri thuộc client trước khi gọi đây → render form login.
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderLoginPage({
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scopes: params.scopes ?? [SCOPE],
      }),
    );
  },

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = await peekAuthCode(authorizationCode);
    if (!code) throw new Error("invalid_grant: authorization code không hợp lệ hoặc đã hết hạn");
    return code.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE đã được SDK so với challengeForAuthorizationCode
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const stored = await consumeAuthCode(authorizationCode); // DÙNG MỘT LẦN
    if (!stored) throw new Error("invalid_grant: code không hợp lệ hoặc đã dùng");
    if (stored.clientId !== client.client_id) throw new Error("invalid_grant: client không khớp");
    if (redirectUri && redirectUri !== stored.redirectUri) throw new Error("invalid_grant: redirect_uri không khớp");
    return issueTokens(stored.staffId, stored.role, client.client_id);
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const claims = verifyJwt(refreshToken);
    if (!claims || claims.typ !== "refresh") throw new Error("invalid_grant: refresh token không hợp lệ");
    if (claims.cid !== client.client_id) throw new Error("invalid_grant: client không khớp");
    // Xác nhận staff còn hoạt động + lấy role mới nhất (thu hồi quyền tức thì nếu bị khoá).
    const r = await pool.query(`SELECT role, roles FROM staff WHERE id = $1 AND is_active = 1`, [claims.sub]);
    if (!r.rows.length) throw new Error("invalid_grant: tài khoản không còn hoạt động");
    const u = r.rows[0] as { role: string; roles: unknown };
    const role: "admin" | "staff" = u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin")) ? "admin" : "staff";
    return issueTokens(claims.sub, role, client.client_id);
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = verifyJwt(token);
    if (!claims || claims.typ !== "access") throw new Error("invalid_token");
    return {
      token,
      clientId: claims.cid,
      scopes: (claims.scope ?? "").split(" ").filter(Boolean),
      expiresAt: claims.exp,
      extra: { staffId: claims.sub, role: claims.role },
    };
  },
};

// ─── Sinh authorization code (dùng bởi login handler) ──────────────────────────

export async function createAuthorizationCode(input: {
  clientId: string; redirectUri: string; codeChallenge: string; staffId: number; role: "admin" | "staff"; scopes: string[];
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await putAuthCode(code, {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    staffId: input.staffId,
    role: input.role,
    scopes: input.scopes,
    exp: Math.floor(Date.now() / 1000) + 10 * 60, // 10 phút
  });
  return code;
}

/** Chỉ để test nội bộ: cấp access token trực tiếp (MCP Inspector/bearer). KHÔNG dùng ở luồng thật. */
export function issueTestAccessToken(staffId: number, role: "admin" | "staff", clientId = "test-client"): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: staffId, role, scope: SCOPE, cid: clientId, typ: "access", exp: now + ACCESS_TTL });
}

export { verifyJwt as _verifyJwtForTest };
