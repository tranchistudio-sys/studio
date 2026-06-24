/**
 * Helper tính GIÁ SAU GIẢM cho module Bảng giá — NGUỒN SỰ THẬT DUY NHẤT.
 *
 * Mọi nơi hiển thị/đọc giá ưu đãi (API admin /pricing, Sale AI Lulu qua
 * sale-context.ts, website public qua cms.ts) PHẢI gọi resolveDiscount() —
 * KHÔNG tự tính rải rác để tránh sai giá / lỗ tiền.
 *
 * Giảm giá 2 cấp:
 *   - Cấp NHÓM (service_groups.discount_*): áp cho mọi gói active trong nhóm.
 *   - Cấp GÓI  (service_packages.discount_*): chỉ áp cho gói đó.
 * LUẬT ƯU TIÊN (bắt buộc): giảm-GÓI > giảm-NHÓM. KHÔNG cộng dồn (hiện tại không có
 * setting cho phép cộng dồn — để tránh lỗ tiền).
 *
 * Một ưu đãi chỉ ÁP (active) khi: bật + có loại + value > 0 + ngày hiện tại nằm
 * trong [startDate, endDate] (để trống = không giới hạn đầu/cuối). Chưa tới ngày
 * bắt đầu = "scheduled" (admin: "Sắp áp dụng"); quá hạn = "expired" (admin:
 * "Đã hết hạn"). Cả 2 đều KHÔNG áp giá giảm cho khách/website/Lulu.
 */

export type DiscountType = "percent" | "fixed";
export type DiscountSource = "package" | "group" | "none";
export type DiscountWindowStatus = "off" | "scheduled" | "active" | "expired";

/** Cấu hình giảm giá thô (lấy từ DB hoặc form), chấp nhận nhiều kiểu input. */
export interface DiscountConfig {
  enabled?: boolean | number | null;
  type?: string | null; // 'percent' | 'fixed'
  value?: number | string | null;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  name?: string | null;
  description?: string | null;
}

/** Kết quả đã tính — dùng cho mọi nơi hiển thị + Lulu context. */
export interface DiscountResult {
  basePrice: number;
  finalPrice: number;
  discountApplied: boolean;
  discountSource: DiscountSource;
  discountName: string | null;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountStartDate: string | null; // ISO
  discountEndDate: string | null; // ISO
  discountDescription: string | null;
  savedAmount: number; // basePrice - finalPrice (>= 0)
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

function toIso(v: string | Date | null | undefined): string | null {
  const ms = toMs(v);
  return ms == null ? null : new Date(ms).toISOString();
}

function normType(t?: string | null): DiscountType | null {
  if (t === "fixed") return "fixed";
  if (t === "percent") return "percent";
  return null;
}

function truthy(v: boolean | number | null | undefined): boolean {
  return v === true || v === 1;
}

/** Giá sau giảm (làm tròn, clamp >= 0). type/value không hợp lệ → giữ giá gốc. */
export function applyDiscount(basePrice: number, type: DiscountType | null, value: number | null): number {
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  if (!type || value == null || value <= 0) return base;
  let final = base;
  if (type === "percent") final = base - (base * value) / 100;
  else if (type === "fixed") final = base - value;
  return Math.max(0, Math.round(final));
}

/**
 * Trạng thái 1 ưu đãi tại thời điểm `now`:
 *  - off       : tắt / chưa cấu hình / value <= 0 → không phải ưu đãi.
 *  - scheduled : đã bật & hợp lệ nhưng chưa tới startDate ("Sắp áp dụng").
 *  - active    : đang áp.
 *  - expired   : đã qua endDate ("Đã hết hạn").
 */
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

function buildResult(base: number, source: DiscountSource, cfg: DiscountConfig): DiscountResult {
  const type = normType(cfg.type);
  const value = toNum(cfg.value);
  const finalPrice = applyDiscount(base, type, value);
  const saved = Math.max(0, base - finalPrice);
  return {
    basePrice: base,
    finalPrice,
    discountApplied: saved > 0,
    discountSource: saved > 0 ? source : "none",
    discountName: (cfg.name ?? "").trim() || null,
    discountType: type,
    discountValue: value,
    discountStartDate: toIso(cfg.startDate),
    discountEndDate: toIso(cfg.endDate),
    discountDescription: (cfg.description ?? "").trim() || null,
    savedAmount: saved,
  };
}

/**
 * Tính ưu đãi hiệu lực cho 1 gói. Ưu tiên giảm-GÓI > giảm-NHÓM, KHÔNG cộng dồn.
 * `pkg`/`group` là cấu hình giảm giá thô (có thể null nếu không cấu hình).
 */
export function resolveDiscount(args: {
  basePrice: number | string;
  pkg?: DiscountConfig | null;
  group?: DiscountConfig | null;
  now?: Date;
}): DiscountResult {
  const now = args.now ?? new Date();
  const base = Math.max(0, Math.round(Number(args.basePrice) || 0));
  const none: DiscountResult = {
    basePrice: base,
    finalPrice: base,
    discountApplied: false,
    discountSource: "none",
    discountName: null,
    discountType: null,
    discountValue: null,
    discountStartDate: null,
    discountEndDate: null,
    discountDescription: null,
    savedAmount: 0,
  };
  if (base <= 0) return none; // giá "liên hệ" → không áp giảm
  // Ưu tiên gói trước, nhóm sau.
  const candidates: Array<[DiscountSource, DiscountConfig | null | undefined]> = [
    ["package", args.pkg],
    ["group", args.group],
  ];
  for (const [source, cfg] of candidates) {
    if (!cfg) continue;
    if (discountWindowStatus(cfg, now) !== "active") continue;
    const res = buildResult(base, source, cfg);
    if (res.discountApplied) return res;
  }
  return none;
}
