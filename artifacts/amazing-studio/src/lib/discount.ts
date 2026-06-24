// Helper giảm giá phía FRONTEND — MIRROR thuần của backend
// artifacts/api-server/src/lib/pricing-discount.ts (giữ logic GIỐNG HỆT: ưu tiên
// giảm-gói > giảm-nhóm, KHÔNG cộng dồn, clamp >= 0, cửa sổ ngày).
//
// Backend ĐÃ tính sẵn `discount` cho mỗi gói (GET /service-packages, public
// packages) nên card/website chỉ HIỂN THỊ. Mirror này chỉ dùng cho:
//   - Live preview trong modal khi admin đang gõ (giá trị CHƯA lưu).
//   - Nhãn trạng thái "Sắp áp dụng / Đã hết hạn" cho dữ liệu chưa lưu.
//   - Sinh chữ badge từ DiscountResult backend trả về.
import { formatVND } from "@/lib/utils";

export type DiscountType = "percent" | "fixed";
export type DiscountSource = "package" | "group" | "none";
export type DiscountWindowStatus = "off" | "scheduled" | "active" | "expired";

export interface DiscountConfig {
  enabled?: boolean | number | null;
  type?: string | null;
  value?: number | string | null;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  name?: string | null;
  description?: string | null;
}

export interface DiscountResult {
  basePrice: number;
  finalPrice: number;
  discountApplied: boolean;
  discountSource: DiscountSource;
  discountName: string | null;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountStartDate: string | null;
  discountEndDate: string | null;
  discountDescription: string | null;
  savedAmount: number;
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function toMs(v: string | Date | null | undefined): number | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}
function normType(t?: string | null): DiscountType | null {
  return t === "fixed" ? "fixed" : t === "percent" ? "percent" : null;
}
function truthy(v: boolean | number | null | undefined): boolean {
  return v === true || v === 1;
}

export function applyDiscount(basePrice: number, type: DiscountType | null, value: number | null): number {
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  if (!type || value == null || value <= 0) return base;
  let final = base;
  if (type === "percent") final = base - (base * value) / 100;
  else if (type === "fixed") final = base - value;
  return Math.max(0, Math.round(final));
}

export function discountWindowStatus(cfg: DiscountConfig | null | undefined, now: Date = new Date()): DiscountWindowStatus {
  if (!cfg || !truthy(cfg.enabled)) return "off";
  const type = normType(cfg.type);
  const value = toNum(cfg.value);
  if (!type || value == null || value <= 0) return "off";
  const nowMs = now.getTime();
  const start = toMs(cfg.startDate);
  const end = toMs(cfg.endDate);
  if (start != null && nowMs < start) return "scheduled";
  if (end != null && nowMs > end) return "expired";
  return "active";
}

/** Tính giá sau giảm khi đang preview trong modal (1 cấp). Trả về số tiền sau giảm. */
export function previewFinalPrice(basePrice: number, cfg: DiscountConfig, now: Date = new Date()): number {
  if (discountWindowStatus(cfg, now) !== "active") return Math.max(0, Math.round(Number(basePrice) || 0));
  return applyDiscount(basePrice, normType(cfg.type), toNum(cfg.value));
}

// ── Helper hiển thị ─────────────────────────────────────────────────────────
export function statusLabel(s: DiscountWindowStatus): string {
  return s === "active" ? "Đang giảm" : s === "scheduled" ? "Sắp áp dụng" : s === "expired" ? "Đã hết hạn" : "Tắt";
}

/** Chữ badge ngắn trên card từ DiscountResult: "Đang giảm 10%" / "Giảm 100.000đ". */
export function discountBadgeText(d: DiscountResult): string {
  if (!d?.discountApplied) return "";
  if (d.discountType === "percent") return `Đang giảm ${d.discountValue}%`;
  // savedAmount = số tiền giảm THỰC (đã clamp về giá gốc) → không thổi phồng khi
  // admin lỡ đặt mức giảm cố định > giá gốc.
  return `Giảm ${formatVND(d.savedAmount)}`;
}

/** Nguồn giảm để FE phân biệt badge "riêng gói" vs "theo nhóm". */
export function discountSourceLabel(d: DiscountResult): string {
  return d.discountSource === "package" ? "Giảm riêng gói" : d.discountSource === "group" ? "Giảm theo nhóm" : "";
}
