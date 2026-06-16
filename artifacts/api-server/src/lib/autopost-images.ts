import crypto from "node:crypto";
import { getPublicBaseUrl } from "./publicUrl";

// Loại media được Facebook chấp nhận cho ảnh đính kèm.
const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Chuẩn hóa content-type về một trong ALLOWED_MEDIA, hoặc suy ra từ phần mở
 * rộng URL. Trả về null khi không nằm trong whitelist (để bỏ qua an toàn).
 */
export function normalizeMediaType(contentType: string | null, url: string): string | null {
  if (contentType) {
    let mt = contentType.toLowerCase().trim();
    const semi = mt.indexOf(";");
    if (semi >= 0) mt = mt.slice(0, semi).trim();
    if (mt === "image/jpg") mt = "image/jpeg";
    if (ALLOWED_MEDIA.includes(mt)) return mt;
  }
  // Suy ra từ phần mở rộng của URL.
  const lower = (url || "").toLowerCase();
  // Cắt query/hash trước khi đọc đuôi file.
  const clean = lower.split("?")[0].split("#")[0];
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".webp")) return "image/webp";
  return null;
}

/** SHA1 hex của chuỗi URL (dùng để chống đăng trùng ảnh). */
export function hashImageUrl(url: string): string {
  return crypto.createHash("sha1").update(url).digest("hex");
}

// Domain công khai mặc định khi không lấy được từ env/Replit (vd chạy local,
// hoặc chỉ có domain *.replit.dev mà Facebook không tải ảnh được).
const PRODUCTION_PUBLIC_URL = "https://tranchistudio.com";

/**
 * Origin công khai để Facebook tải ảnh: ưu tiên PUBLIC_APP_URL, kế đến domain
 * production Replit cấp (REPLIT_DOMAINS qua getPublicBaseUrl), cuối cùng fallback
 * PRODUCTION_PUBLIC_URL. KHÔNG bao giờ trả localhost / *.replit.dev vì Facebook
 * (và mọi máy chủ bên ngoài) không fetch được các domain đó.
 */
function publicOrigin(): string {
  const base = getPublicBaseUrl();
  if (!base || /localhost|127\.0\.0\.1|\.replit\.dev/i.test(base)) return PRODUCTION_PUBLIC_URL;
  return base.replace(/\/+$/, "");
}

/** Map path tương đối sang path phục vụ thật — mirror frontend getImageSrc. */
function mapStoragePath(path: string): string {
  // /objects/<x> và /public-objects/<x> được phục vụ qua route /api/storage/...
  if (path.startsWith("/objects/") || path.startsWith("/public-objects/")) {
    return `/api/storage${path}`;
  }
  // /uploads/... (gồm /uploads/cms/...) phục vụ tĩnh ở gốc domain → giữ nguyên.
  return path;
}

/**
 * Biến đường dẫn ảnh đã lưu thành URL TUYỆT ĐỐI công khai để gửi cho Facebook
 * Graph API (FB tải ảnh từ URL nên phải truy cập được từ Internet). Mirror logic
 * frontend getImageSrc:
 *  - URL tuyệt đối http(s) không phải localhost → giữ nguyên.
 *  - URL localhost/127.0.0.1 → thay origin bằng domain công khai (giữ path).
 *  - /objects/... · /public-objects/... → ghép origin + /api/storage/...
 *  - /uploads/... và path khác → ghép thẳng origin.
 */
export function resolvePublicUrl(pathOrUrl: string): string {
  const raw = (pathOrUrl || "").trim();
  if (!raw) return raw;
  const origin = publicOrigin();

  // URL tuyệt đối: localhost → đổi origin; còn lại giữ nguyên.
  const m = raw.match(/^https?:\/\/([^/]+)(\/.*)?$/i);
  if (m) {
    const host = m[1].toLowerCase();
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      return origin + mapStoragePath(m[2] || "/");
    }
    return raw;
  }

  // Đường dẫn tương đối → bảo đảm có "/" đầu rồi map sang route phục vụ thật.
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return origin + mapStoragePath(path);
}

export type FetchedImage = { mediaType: string; dataBase64: string };

/**
 * Tải ảnh và trả về base64 + mediaType. KHÔNG BAO GIỜ throw — mọi lỗi đều
 * trả về null để vòng sync không bị gãy. Bỏ qua ảnh ngoài whitelist hoặc > 5MB.
 */
export async function fetchImageAsBase64(url: string): Promise<FetchedImage | null> {
  try {
    if (!url) return null;
    const res = await fetch(resolvePublicUrl(url));
    if (!res.ok) return null;
    const mediaType = normalizeMediaType(res.headers.get("content-type"), url);
    if (!mediaType) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    return { mediaType, dataBase64: Buffer.from(buf).toString("base64") };
  } catch {
    return null;
  }
}
