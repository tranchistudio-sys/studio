import { createHash } from "node:crypto";

/**
 * autopost-route-helpers.ts — PURE helpers cho router AutoPost (Task 5).
 * KHÔNG import db / network. Mọi hàm an toàn, KHÔNG throw.
 */

/** Các trạng thái hợp lệ của một bài AutoPost (autopost_posts.status). */
export const POST_STATUSES = [
  "unused",
  "draft_ai",
  "generating",      // đang viết caption ở nền (queue) — chưa có caption
  "pending_review",
  "caption_failed",  // viết caption thất bại — cho phép bấm "Tạo lại"
  "approved",
  "scheduled",
  "posting",
  "posted",
  "failed",
  "skipped",
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

/** true nếu s là một trong POST_STATUSES. */
export function isValidStatus(s: unknown): boolean {
  return typeof s === "string" && (POST_STATUSES as readonly string[]).includes(s);
}

/** sha1 hex của chuỗi (chuỗi rỗng/null → hash của ""). */
export function sha1(s: string): string {
  return createHash("sha1").update(s || "").digest("hex");
}

export type CaptionItemLike = {
  contentType: string;
  title: string;
  images: string[];
  price: number | null;
  salePrice: number | null;
  goldenHourPercent: number | null;
  goldenHourName: string | null;
  category: string | null;
  badge: string | null;
  publicLink: string | null;
};

/** Parse trường images: mảng → dùng luôn; chuỗi JSON → parse an toàn; khác → []. */
function parseImages(raw: unknown): string[] {
  try {
    let arr: unknown = raw;
    if (typeof raw === "string") arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** Number(...) || null — NaN/0/null → null. */
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** string hoặc null. */
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length > 0 ? s : null;
}

/**
 * Map 1 dòng pool (camelCase HOẶC snake_case) → CaptionItem. Đọc thủ phòng cả
 * hai kiểu tên cột. KHÔNG BAO GIỜ throw.
 */
export function poolRowToCaptionItem(row: any): CaptionItemLike {
  const r = row ?? {};
  return {
    contentType: String(r.contentType ?? r.content_type ?? ""),
    title: String(r.title ?? ""),
    images: parseImages(r.images),
    price: num(r.price),
    salePrice: num(r.salePrice ?? r.sale_price),
    goldenHourPercent: num(r.goldenHourPercent ?? r.golden_hour_percent),
    goldenHourName: str(r.goldenHourName ?? r.golden_hour_name),
    category: str(r.category),
    badge: str(r.badge),
    publicLink: str(r.publicLink ?? r.public_link),
  };
}

/**
 * Lấy tối đa max(1, count) URL ảnh hợp lệ (string không rỗng sau trim) đầu tiên.
 */
export function clampImages(images: string[], count: number): string[] {
  const max = Math.max(1, count || 1);
  const valid = (Array.isArray(images) ? images : []).filter(
    (u): u is string => typeof u === "string" && u.trim().length > 0,
  );
  return valid.slice(0, max);
}

/**
 * Số ảnh MẶC ĐỊNH cho 1 bài đăng khi không có giới hạn cụ thể (admin tạo bài thủ
 * công, hoặc slot lịch chưa đặt số ảnh). Trước đây mặc định = 1 → bài rớt còn ảnh
 * bìa dù item có nhiều ảnh. Đặt = 10 theo yêu cầu "2–10 ảnh/bài" — đủ cho 1 album
 * thường mà không spam 50 ảnh. Trần tuyệt đối vẫn là MAX_PHOTOS (50) ở publisher.
 */
export const DEFAULT_POST_IMAGES = 10;

/**
 * Số ảnh hiệu lực cho 1 slot lịch tự sinh. TÔN TRỌNG khi admin đặt rõ >=2;
 * còn 0/1/null (vốn là giá trị mặc định CŨ gây rớt còn 1 ảnh) → DEFAULT_POST_IMAGES.
 */
export function resolveSlotImageCount(slotImageCount: unknown): number {
  const n = Number(slotImageCount);
  return Number.isFinite(n) && n >= 2 ? n : DEFAULT_POST_IMAGES;
}
