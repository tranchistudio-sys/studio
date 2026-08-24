import { createHmac, timingSafeEqual } from "node:crypto";

export interface LegacyTokenPayload {
  id: number;
  exp?: number;
  iat?: number;
  sid?: string;
  tenantRole?: "OWNER" | "ADMIN" | "STAFF";
}

function resolveJwtSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET chưa được cấu hình ở production. Từ chối khởi động thay vì dùng secret mặc định.",
    );
  }
  return "amazing-studio-secret-2025";
}

const JWT_SECRET = resolveJwtSecret();

function decodePayload(token: string): LegacyTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, signature] = parts;
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString()) as {
      alg?: string;
      typ?: string;
    };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;

    const expected = createHmac("sha256", JWT_SECRET)
      .update(`${encodedHeader}.${encodedBody}`)
      .digest("base64url");
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) return null;

    const payload = JSON.parse(Buffer.from(encodedBody, "base64url").toString()) as LegacyTokenPayload;
    if (!Number.isInteger(payload.id) || payload.id <= 0) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    if (payload.sid !== undefined && typeof payload.sid !== "string") return null;
    if (
      payload.tenantRole !== undefined &&
      payload.tenantRole !== "OWNER" &&
      payload.tenantRole !== "ADMIN" &&
      payload.tenantRole !== "STAFF"
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readLegacyToken(header: string | undefined): LegacyTokenPayload | null {
  if (!header?.startsWith("Bearer ")) return null;
  return decodePayload(header.slice(7));
}

export function verifyLegacyToken(header: string | undefined): number | null {
  return readLegacyToken(header)?.id ?? null;
}

/** Tenant membership is the authority ceiling; legacy staff.role is only used
 * when running without a platform-session bridge. */
export function capLegacyAdmin(
  header: string | undefined,
  legacyIsAdmin: boolean,
): boolean {
  const tenantRole = readLegacyToken(header)?.tenantRole;
  return tenantRole ? tenantRole === "OWNER" || tenantRole === "ADMIN" : legacyIsAdmin;
}

export const DEFAULT_LEGACY_SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;

export function signLegacyToken(
  staffId: number,
  sessionId?: string,
  ttlSeconds = DEFAULT_LEGACY_SESSION_TTL_SECONDS,
  tenantRole?: "OWNER" | "ADMIN" | "STAFF",
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload: LegacyTokenPayload = {
    id: staffId,
    iat: now,
    exp: now + ttlSeconds,
    ...(sessionId ? { sid: sessionId } : {}),
    ...(tenantRole ? { tenantRole } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}
