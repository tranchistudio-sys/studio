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
 * ─── VÌ SAO CÓ TRANG NHẬP MẬT KHẨU HTML, KHÔNG DÙNG HỘP CỦA TRÌNH DUYỆT ──────
 * Trình duyệt nhúng trong ứng dụng iPhone (in-app browser) KHÔNG hiện hộp hỏi
 * Basic Auth — chủ chỉ thấy màn hình trắng (đã gặp thật 31/07 khi mở link từ
 * app chat). Vì vậy: request điều hướng của trình duyệt (GET, Accept: text/html)
 * nhận một TRANG NHẬP MẬT KHẨU tử tế; nhập đúng → cấp cookie → vào app.
 * Basic Auth qua header vẫn được chấp nhận (curl/CI), và request không phải
 * trình duyệt vẫn nhận 401 + WWW-Authenticate như chuẩn.
 *
 * CHỈ bật khi PREVIEW_MODE=1 → production trả về null, KHÔNG mount middleware nào.
 * `/api/healthz` được miễn để health check của Fly không bị 401.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { isPreviewMode, type EnvLike } from "./preview-guard";

/** Path được miễn mật khẩu (health check hạ tầng, không lộ dữ liệu). */
export const PREVIEW_AUTH_EXEMPT_PATHS: readonly string[] = ["/api/healthz"];

/** Tên cookie phiên xem thử. */
export const PREVIEW_COOKIE = "amazing_preview_access";

/** Path nhận form nhập mật khẩu (chỉ tồn tại trong preview, xử lý ngay trong middleware này). */
export const PREVIEW_LOGIN_PATH = "/__preview-login";

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

/** Request là điều hướng của trình duyệt (mở trang) — không phải gọi API/tài nguyên. */
export function wantsHtml(method: string, acceptHeader: string | undefined): boolean {
  return method === "GET" && (acceptHeader ?? "").includes("text/html");
}

/** Chỉ cho quay về path nội bộ — chặn open-redirect kiểu `//ke-xau.com`. */
export function sanitizeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

/** Tách password + next từ body form urlencoded. */
export function parseLoginForm(body: string): { password: string; next: string } {
  const params = new URLSearchParams(body);
  return { password: params.get("password") ?? "", next: sanitizeNext(params.get("next") ?? "/") };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Trang nhập mật khẩu — thay cho hộp Basic Auth của trình duyệt (trình duyệt
 * nhúng trong app iPhone không hiện hộp đó → màn hình trắng).
 */
export function renderLoginPage(next: string, showError = false): string {
  const err = showError
    ? `<p style="color:#b3261e;margin:0 0 12px">Mật khẩu chưa đúng, thử lại nhé.</p>`
    : "";
  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Bản xem thử — Amazing Studio</title>
</head>
<body style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#faf7f2;display:flex;min-height:100vh;align-items:center;justify-content:center">
<form method="post" action="${PREVIEW_LOGIN_PATH}" style="background:#fff;border:1px solid #eadfd3;border-radius:16px;padding:28px 24px;width:min(92vw,360px);box-shadow:0 8px 30px rgba(0,0,0,.06)">
  <h1 style="font-size:20px;margin:0 0 4px">📱 Bản xem thử</h1>
  <p style="color:#6b6257;margin:0 0 16px">Amazing Studio — nhập mật khẩu xem thử để vào app.</p>
  ${err}
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <input type="password" name="password" autofocus autocomplete="current-password" placeholder="Mật khẩu xem thử"
    style="width:100%;box-sizing:border-box;font-size:17px;padding:12px 14px;border:1px solid #d8cbbb;border-radius:10px;margin-bottom:12px">
  <button type="submit"
    style="width:100%;font-size:17px;font-weight:600;padding:12px;border:0;border-radius:10px;background:#b8860b;color:#fff">
    Vào xem app
  </button>
  <p style="color:#a49a8d;font-size:12px;margin:14px 0 0">Dữ liệu trong bản xem thử đã che thông tin khách hàng. Không phải hệ thống thật.</p>
</form>
</body></html>`;
}

/** Đọc body của request (form đăng nhập) — middleware này chạy TRƯỚC express.urlencoded. */
function readBody(req: Request, limit = 8192): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body qua lon"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

    const issueCookie = () => {
      const https =
        req.protocol === "https" || String(req.headers["x-forwarded-proto"] || "").includes("https");
      res.cookie(PREVIEW_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: https,
        maxAge: COOKIE_MAX_AGE_MS,
        path: "/",
      });
    };

    // 0) Form đăng nhập gửi lên → kiểm tra mật khẩu, cấp cookie, quay về trang cũ.
    if (req.method === "POST" && req.path === PREVIEW_LOGIN_PATH) {
      readBody(req)
        .then((body) => {
          const { password, next: back } = parseLoginForm(body);
          if (safeEqual(password, expected.pass)) {
            issueCookie();
            res.redirect(303, back);
          } else {
            res.status(401).type("html").send(renderLoginPage(back, true));
          }
        })
        .catch(() => res.status(400).type("text/plain; charset=utf-8").send("Yêu cầu không hợp lệ."));
      return;
    }

    // 1) Đã có cookie phiên xem thử hợp lệ → cho qua (đường đi của mọi lệnh gọi
    //    /api sau khi frontend đã chiếm header Authorization cho Bearer token).
    const cookie = readCookie(req.headers.cookie, PREVIEW_COOKIE);
    if (cookie && safeEqual(cookie, token)) return next();

    // 2) Chưa có cookie → vẫn chấp nhận Basic Auth (curl/CI) và cấp cookie.
    if (credentialsMatch(parseBasicAuthHeader(req.headers.authorization), expected)) {
      issueCookie();
      return next();
    }

    // 3) Trình duyệt mở trang → TRẢ TRANG NHẬP MẬT KHẨU (in-app browser trên
    //    iPhone không hiện hộp Basic Auth — chỉ thấy màn hình trắng).
    //    Trả 200 (không phải 401): một số webview nhúng xử lý mã lỗi khác thường
    //    — 200 + HTML là tổ hợp mọi trình duyệt đều render chắc chắn.
    if (wantsHtml(req.method, req.headers.accept)) {
      res.status(200).type("html").send(renderLoginPage(sanitizeNext(req.originalUrl)));
      return;
    }

    // 4) Còn lại (API, curl không -u…) → 401 chuẩn.
    res.setHeader("WWW-Authenticate", 'Basic realm="Amazing Studio Preview", charset="UTF-8"');
    res.status(401).type("text/plain; charset=utf-8").send("Bản xem thử — cần mật khẩu.");
  };
}
