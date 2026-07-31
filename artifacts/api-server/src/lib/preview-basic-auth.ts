/**
 * preview-basic-auth.ts — một lớp mật khẩu phủ TOÀN BỘ bản preview.
 *
 * Repo là public và URL preview (https://pr-<số>-amazing-studio.fly.dev) ai cũng
 * mở được. Dữ liệu trong preview đã che danh tính khách, nhưng vẫn là bản sao cấu
 * trúc kinh doanh thật + còn ~30 endpoint cho ghi ẩn danh (PR #122 chưa merge)
 * → bắt buộc chặn bằng mật khẩu trước khi tới bất cứ route nào.
 *
 * ─── VÌ SAO PHẢI CÓ COOKIE, KHÔNG THỂ CHỈ DÙNG BASIC AUTH ────────────────────
 * App đăng nhập bằng `Authorization: Bearer <token>` (localStorage). Basic Auth
 * cũng dùng ĐÚNG header `Authorization` đó. Khi frontend tự đặt Bearer, trình
 * duyệt KHÔNG gắn kèm Basic nữa → mọi lệnh gọi /api sẽ bị chính lớp này chặn 401
 * và bản xem thử coi như hỏng. (Đã tái hiện được lỗi này khi chạy thử.)
 *
 * Cách xử lý: gõ đúng mật khẩu MỘT LẦN (lúc mở trang) → cấp thêm một cookie phiên.
 * Sau đó request nào cũng qua được nhờ cookie, kể cả khi header Authorization đã
 * bị frontend dùng cho Bearer token.
 *
 * CHỈ bật khi PREVIEW_MODE=1 → production trả về null, KHÔNG mount middleware nào.
 * `/api/healthz` được miễn để health check của Fly không bị 401.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { isPreviewMode, type EnvLike } from "./preview-guard";

/** Path được miễn mật khẩu (health check hạ tầng, không lộ dữ liệu). */
export const PREVIEW_AUTH_EXEMPT_PATHS: readonly string[] = ["/api/healthz"];

/** Tên cookie phiên xem thử. */
export const PREVIEW_COOKIE = "amazing_preview_access";

/** Hạn cookie: 7 ngày — đủ cho một vòng review, hết hạn thì hỏi lại mật khẩu. */
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isExemptPath(path: string): boolean {
  return PREVIEW_AUTH_EXEMPT_PATHS.includes(path);
}

/** Giá trị cookie = HMAC của mật khẩu → đổi mật khẩu là cookie cũ mất hiệu lực ngay. */
export function accessToken(pass: string): string {
  return createHmac("sha256", pass).update("amazing-preview-access-v1").digest("hex");
}

/** So sánh chuỗi kiểu chống dò thời gian, an toàn với độ dài khác nhau. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Vẫn so sánh một lần để thời gian phản hồi không tiết lộ độ dài.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Tách user/pass từ header `Authorization: Basic base64(user:pass)`. */
export function parseBasicAuthHeader(header: string | undefined): { user: string; pass: string } | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

/** Đọc 1 cookie từ header thô — cố tình không phụ thuộc cookie-parser vì lớp này
 *  mount TRƯỚC mọi middleware khác. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return null;
}

export function credentialsMatch(
  given: { user: string; pass: string } | null,
  expected: { user: string; pass: string },
): boolean {
  if (!given) return false;
  // Dùng biến trung gian để luôn chạy cả hai phép so sánh.
  const okUser = safeEqual(given.user, expected.user);
  const okPass = safeEqual(given.pass, expected.pass);
  return okUser && okPass;
}

/**
 * Trả về middleware chặn mật khẩu cho preview, hoặc `null` khi không ở chế độ
 * preview. Gọi ở app.ts và chỉ mount khi khác null → production hoàn toàn không đổi.
 */
export function previewBasicAuth(env: EnvLike = process.env): RequestHandler | null {
  if (!isPreviewMode(env)) return null;

  const expected = {
    user: env.PREVIEW_BASIC_AUTH_USER?.trim() || "amazing",
    pass: env.PREVIEW_BASIC_AUTH_PASS ?? "",
  };
  // enforcePreviewSafety() đã fail-fast nếu thiếu mật khẩu; đây là chốt cuối cùng
  // phòng trường hợp app.ts được import theo đường khác (ví dụ test).
  if (!expected.pass) {
    throw new Error("[preview] Thiếu PREVIEW_BASIC_AUTH_PASS — từ chối phục vụ preview không mật khẩu.");
  }
  const token = accessToken(expected.pass);

  return (req, res, next) => {
    // Không cho công cụ tìm kiếm lập chỉ mục bản preview.
    res.setHeader("X-Robots-Tag", "noindex, nofollow");

    if (isExemptPath(req.path)) return next();

    // 1) Đã có cookie phiên xem thử hợp lệ → cho qua (đường đi của mọi lệnh gọi
    //    /api sau khi frontend đã chiếm header Authorization cho Bearer token).
    const cookie = readCookie(req.headers.cookie, PREVIEW_COOKIE);
    if (cookie && safeEqual(cookie, token)) return next();

    // 2) Chưa có cookie → chấp nhận Basic Auth và cấp cookie cho các request sau.
    if (credentialsMatch(parseBasicAuthHeader(req.headers.authorization), expected)) {
      const https =
        req.protocol === "https" || String(req.headers["x-forwarded-proto"] || "").includes("https");
      res.cookie(PREVIEW_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: https,
        maxAge: COOKIE_MAX_AGE_MS,
        path: "/",
      });
      return next();
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="Amazing Studio Preview", charset="UTF-8"');
    res.status(401).type("text/plain; charset=utf-8").send("Bản xem thử — cần mật khẩu.");
  };
}
