/**
 * autopost-sanitize.ts — Hàm THUẦN (không DB, không network) để XOÁ thông tin liên
 * hệ LẠ khỏi caption / bài mẫu: số điện thoại, website/domain, link/handle mạng xã hội.
 *
 * Mục đích: bài mẫu lấy từ nhiều nguồn → không để lẫn hotline/website/tên tiệm khác
 * vào caption mới. Thông tin chính chủ Amazing Studio CHỈ đến từ footer cố định
 * (autopost-brand.ts), được gắn SAU khi đã sanitize.
 *
 * Thận trọng: chỉ bắt số ĐT bắt đầu bằng 0 / +84 (giá tiền "1.500.000" không khớp).
 */

const URL_SCHEME = /\bhttps?:\/\/\S+/gi;
const URL_WWW = /\bwww\.\S+/gi;
// domain trần phổ biến (kèm path tuỳ chọn): shop.com, abc.vn/xyz...
const BARE_DOMAIN = /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|vn|info|shop|store|biz|me|io|co|xyz|page)(?:\.[a-z]{2,3})?(?:\/\S*)?/gi;
// handle/nhãn mạng xã hội + giá trị theo sau: "fb: abc", "tiktok @xyz", "zalo 09..."
const SOCIAL = /\b(?:fb|facebook|tiktok|tik tok|zalo|instagram|insta|ig)\b\s*[:.\-]?\s*\S+/gi;
// số điện thoại VN: +84 / 0 ở đầu, 8–11 chữ số (cho phép . - khoảng trắng xen giữa).
const VN_PHONE = /(?:\+?84|0)\d(?:[\s.\-]?\d){7,10}/g;

/**
 * Trả về text đã xoá liên hệ lạ. KHÔNG đụng giá tiền/hashtag chữ. Không throw.
 * thử vài vòng nhỏ để dọn phần dính nhau (vd "Zalo 09xx" → bỏ cả nhãn + số).
 */
export function stripContacts(text: string): string {
  if (!text || typeof text !== "string") return text ?? "";
  let t = text;
  t = t.replace(SOCIAL, " ");
  t = t.replace(URL_SCHEME, " ");
  t = t.replace(URL_WWW, " ");
  t = t.replace(BARE_DOMAIN, " ");
  t = t.replace(VN_PHONE, " ");
  // Dọn nhãn liên hệ rỗng còn sót (vd "Hotline:", "SĐT -", "Địa chỉ:" đứng cuối dòng).
  t = t.replace(/^[ \t>•\-]*(?:hotline|sđt|sdt|số điện thoại|liên hệ|inbox|website|web|page|fanpage|địa chỉ|add|address)\s*[:.\-]?\s*$/gim, "");
  // Gọn khoảng trắng & dòng trống thừa.
  t = t.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Có chứa liên hệ lạ không — suy ra từ việc sanitize có làm đổi text hay không
 * (tránh bug lastIndex của regex /g khi dùng .test). */
export function hasForeignContact(text: string): boolean {
  if (!text) return false;
  return stripContacts(text) !== text.trim();
}
