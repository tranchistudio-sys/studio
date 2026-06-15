import crypto from "node:crypto";

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

/**
 * Biến đường dẫn tương đối thành URL tuyệt đối dựa trên PUBLIC_APP_URL.
 * Best-effort: nếu không có base thì trả nguyên input.
 */
export function resolvePublicUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = (process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
  if (!base) return pathOrUrl;
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${path}`;
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
