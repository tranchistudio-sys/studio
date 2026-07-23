/**
 * oauth-store.ts — Lưu trữ OAuth (client đăng ký động DCR + authorization code)
 * cho MCP server. DÙNG LẠI bảng key-value `settings` SẴN CÓ (ai-provider.ts đang
 * dùng) → KHÔNG tạo bảng, KHÔNG DDL, KHÔNG migration.
 *
 * - Client (DCR): key `mcp:oauth:client:<client_id>` → JSON OAuthClientInformationFull.
 * - Auth code:    key `mcp:oauth:code:<code>` → JSON { …, exp } — DÙNG MỘT LẦN.
 * Access/refresh token KHÔNG lưu ở đây (JWT stateless ký bằng SESSION_SECRET).
 *
 * Bảo mật: code dùng một lần (xoá khi đổi lấy token) + hết hạn ngắn; lazy expiry
 * khi đọc. Không lưu secret/PII ngoài mức cần cho luồng OAuth.
 */
import { pool } from "@workspace/db";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const CLIENT_PREFIX = "mcp:oauth:client:";
const CODE_PREFIX = "mcp:oauth:code:";

async function kvGet(key: string): Promise<unknown | null> {
  const r = await pool.query(`SELECT value FROM settings WHERE key = $1 LIMIT 1`, [key]);
  if (!r.rows.length) return null;
  const raw = (r.rows[0] as { value: unknown }).value;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw ?? null;
}

async function kvSet(key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

async function kvDel(key: string): Promise<void> {
  await pool.query(`DELETE FROM settings WHERE key = $1`, [key]);
}

// ─── Client (Dynamic Client Registration) ─────────────────────────────────────

export async function getStoredClient(
  clientId: string,
): Promise<OAuthClientInformationFull | undefined> {
  const v = await kvGet(CLIENT_PREFIX + clientId);
  return (v as OAuthClientInformationFull | null) ?? undefined;
}

export async function putStoredClient(client: OAuthClientInformationFull): Promise<void> {
  await kvSet(CLIENT_PREFIX + client.client_id, client);
}

// ─── Authorization code (dùng một lần) ────────────────────────────────────────

export type StoredAuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  staffId: number;
  role: "admin" | "staff";
  scopes: string[];
  /** epoch giây hết hạn. */
  exp: number;
};

export async function putAuthCode(code: string, data: StoredAuthCode): Promise<void> {
  await kvSet(CODE_PREFIX + code, data);
}

/** Đọc code (KHÔNG xoá) — dùng cho challengeForAuthorizationCode (PKCE do SDK so). */
export async function peekAuthCode(code: string): Promise<StoredAuthCode | null> {
  const v = (await kvGet(CODE_PREFIX + code)) as StoredAuthCode | null;
  if (!v) return null;
  if (typeof v.exp !== "number" || v.exp * 1000 < Date.now()) {
    await kvDel(CODE_PREFIX + code);
    return null;
  }
  return v;
}

/** Đọc + XOÁ (dùng một lần) — dùng khi đổi code lấy token. */
export async function consumeAuthCode(code: string): Promise<StoredAuthCode | null> {
  const v = await peekAuthCode(code);
  await kvDel(CODE_PREFIX + code);
  return v;
}
