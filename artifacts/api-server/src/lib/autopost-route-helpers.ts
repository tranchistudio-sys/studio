import { createHash } from "node:crypto";

/**
 * autopost-route-helpers.ts — PURE helpers cho router AutoPost (Task 5).
 * KHÔNG import db / network. Mọi hàm an toàn, KHÔNG throw.
 */

/** Các trạng thái hợp lệ của một bài AutoPost (autopost_posts.status). */
export const POST_STATUSES = [
  "unused",
  "draft_ai",
  "pending_review",
  "approved",
  "scheduled",
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
