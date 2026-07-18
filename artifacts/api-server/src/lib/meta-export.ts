/**
 * meta-export.ts — logic THUẦN (không DB) cho tính năng XUẤT DANH SÁCH KHÁCH HÀNG
 * CHO META ADS. Tách thuần để test không cần DB và để endpoint chỉ còn ghép dữ liệu.
 *
 * Nguyên tắc bảo mật/riêng tư: CSV chỉ chứa ĐÚNG 9 cột Meta bên dưới — TUYỆT ĐỐI
 * không ghi chú nội bộ, công nợ, địa chỉ chi tiết, lịch sử thanh toán. Số điện thoại
 * chuẩn E.164 +84; số không hợp lệ KHÔNG xuất; trùng (sau chuẩn hoá) gộp về 1.
 */
import type { DemandCategory } from "./customer-demand";

// ─── Cột CSV chuẩn Meta (đối soát nội bộ thêm customer_id + demand_group) ──────
export const META_CSV_COLUMNS = [
  "phone", "fn", "ln", "ct", "st", "country", "value", "customer_id", "demand_group",
] as const;

const CITY = "Tay Ninh";
const STATE = "Tay Ninh";
const COUNTRY = "VN";

// ─── 1) Chuẩn hoá SĐT Việt Nam → E.164 (+84) ──────────────────────────────────
/**
 * Trả "+84XXXXXXXXX" nếu là DI ĐỘNG VN hợp lệ, ngược lại null (không xuất).
 * Chấp nhận mọi cách viết: 0392817079 / 84392817079 / +84 39 281.70-79.
 * Quy tắc: bỏ ký tự định dạng → lấy 9 số quốc gia (bỏ 0 hoặc 84 đầu) → đầu số
 * di động ∈ {3,5,7,8,9}. Cố định/placeholder ("0","000"...) → null.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, ""); // chỉ giữ chữ số (bỏ + space . - ())
  if (!digits) return null;

  let national: string;
  if (digits.startsWith("84")) national = digits.slice(2);
  else if (digits.startsWith("0")) national = digits.slice(1);
  else national = digits; // nhập thiếu 0/84 (vd "392817079")

  if (!/^\d{9}$/.test(national)) return null;       // di động VN = 9 số sau mã vùng
  if (!/^[35789]/.test(national)) return null;      // đầu số di động hợp lệ (03/05/07/08/09)
  return "+84" + national;
}

// ─── 2) Tách họ tên (Meta fn = tên gọi, ln = họ + đệm) ────────────────────────
/**
 * Chỉ tách khi tên "sạch" (chỉ chữ + khoảng trắng, ≥2 từ): quy ước VN từ CUỐI là
 * tên gọi → fn; phần đầu (họ + đệm) → ln. KHÔNG chắc (có số/ký hiệu, 1 từ) → để
 * TOÀN BỘ tên ở fn, ln rỗng — KHÔNG bao giờ làm mất tên.
 */
export function splitName(fullName: string | null | undefined): { fn: string; ln: string } {
  const name = String(fullName ?? "").trim().replace(/\s+/g, " ");
  if (!name) return { fn: "", ln: "" };
  const tokens = name.split(" ");
  const clean = /^[\p{L} ]+$/u.test(name); // chữ Unicode (kể cả tiếng Việt có dấu) + space
  if (!clean || tokens.length < 2) return { fn: name, ln: "" };
  return { fn: tokens[tokens.length - 1], ln: tokens.slice(0, -1).join(" ") };
}

// ─── Nhãn nhóm nhu cầu cho cột demand_group ───────────────────────────────────
export function demandGroupLabel(groups: DemandCategory[] | null | undefined): string {
  const g = groups ?? [];
  const parts: string[] = [];
  if (g.includes("wedding")) parts.push("Wedding");
  if (g.includes("beauty")) parts.push("Beauty");
  return parts.join("|"); // "Wedding" | "Beauty" | "Wedding|Beauty" | ""
}

// ─── 4) Bộ lọc nhu cầu (khớp filter trên màn Khách hàng) ──────────────────────
export type DemandFilter = "" | "wedding" | "beauty" | "both";
export function matchesDemandFilter(groups: DemandCategory[] | null | undefined, filter: DemandFilter): boolean {
  if (!filter) return true;
  const g = groups ?? [];
  if (filter === "both") return g.includes("wedding") && g.includes("beauty");
  return g.includes(filter);
}

// ─── Xây danh sách xuất + thống kê ────────────────────────────────────────────
export type MetaExportInput = {
  /** Khóa nội bộ DUY NHẤT (PK). Dùng cho cột customer_id — customCode "KHxxx"
   *  KHÔNG unique (đã gặp KH079 trùng 2 khách) nên không dùng để đối soát. */
  id: number;
  name: string | null;
  phone: string | null;             // SĐT thô
  value: number;                    // tổng giá trị đơn countable (từ financial-engine)
  countableBookings: number;        // số đơn hợp lệ (để lọc "chỉ khách có đơn")
  demandGroups: DemandCategory[];
};

export type MetaAudience = "all" | "with_orders" | "min_value";
export type MetaExportOptions = { audience: MetaAudience; minValue?: number };

export type MetaRow = {
  phone: string; fn: string; ln: string; ct: string; st: string; country: string;
  value: number; customerId: string; demandGroup: string;
};

export type MetaExportStats = {
  /** Tổng khách tìm thấy sau bộ lọc màn hình. */
  totalFound: number;
  /** Khách có SĐT hợp lệ (E.164), TRƯỚC khi gộp trùng. */
  withValidPhone: number;
  /** Bị loại vì thiếu/sai số. */
  excludedNoPhone: number;
  /** Bị loại thêm do bộ lọc đối tượng (có đơn / ngưỡng value). */
  excludedByAudience: number;
  /** Số trùng (cùng SĐT chuẩn hoá) đã gộp về 1. */
  duplicatesMerged: number;
  /** Số dòng thực xuất ra CSV. */
  exported: number;
};

export type MetaExportResult = { rows: MetaRow[]; stats: MetaExportStats };

function passesAudience(c: MetaExportInput, opts: MetaExportOptions): boolean {
  if (opts.audience === "with_orders") return c.countableBookings > 0;
  if (opts.audience === "min_value") return c.value >= (opts.minValue ?? 0);
  return true; // "all"
}

/**
 * Lọc đối tượng → chuẩn hoá SĐT → gộp trùng → dựng dòng CSV + thống kê.
 * Gộp trùng: cùng SĐT chuẩn hoá thì GIỮ bản có value LỚN hơn (tie: id nhỏ hơn) để
 * value/customer_id xuất ra ổn định và đầy đủ nhất.
 */
export function buildMetaExport(input: readonly MetaExportInput[], opts: MetaExportOptions): MetaExportResult {
  const totalFound = input.length;

  // Chuẩn hoá SĐT một lần cho tất cả.
  const withPhone = input.map((c) => ({ c, e164: normalizePhoneE164(c.phone) }));
  const validAll = withPhone.filter((x): x is { c: MetaExportInput; e164: string } => x.e164 != null);
  const withValidPhone = validAll.length;
  const excludedNoPhone = totalFound - withValidPhone;

  // Bộ lọc đối tượng áp trên tập có SĐT hợp lệ.
  const afterAudience = validAll.filter((x) => passesAudience(x.c, opts));
  const excludedByAudience = withValidPhone - afterAudience.length;

  // Gộp trùng theo SĐT chuẩn hoá.
  const byPhone = new Map<string, { c: MetaExportInput; e164: string }>();
  for (const x of afterAudience) {
    const cur = byPhone.get(x.e164);
    if (!cur) { byPhone.set(x.e164, x); continue; }
    const better = x.c.value > cur.c.value || (x.c.value === cur.c.value && x.c.id < cur.c.id);
    if (better) byPhone.set(x.e164, x);
  }
  const duplicatesMerged = afterAudience.length - byPhone.size;

  const rows: MetaRow[] = [...byPhone.values()].map(({ c, e164 }) => {
    const { fn, ln } = splitName(c.name);
    return {
      phone: e164,
      fn, ln,
      ct: CITY, st: STATE, country: COUNTRY,
      value: Number.isFinite(c.value) ? c.value : 0,
      customerId: String(c.id),
      demandGroup: demandGroupLabel(c.demandGroups),
    };
  });

  return {
    rows,
    stats: {
      totalFound, withValidPhone, excludedNoPhone, excludedByAudience,
      duplicatesMerged, exported: rows.length,
    },
  };
}

// ─── CSV (UTF-8 BOM, chống formula-injection) ─────────────────────────────────
function csvEscape(v: string | number): string {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
/** Ô chữ từ dữ liệu người dùng: chặn Excel chạy công thức (=,+,-,@,tab đầu dòng). */
function csvText(v: string): string {
  const s = String(v ?? "");
  return csvEscape(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
}
function csvNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** Sinh nội dung CSV Meta. BOM để Excel đọc đúng UTF-8 tiếng Việt; xuống dòng CRLF. */
export function metaRowsToCsv(rows: readonly MetaRow[]): string {
  const lines: string[] = [META_CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push([
      r.phone,                 // +84... an toàn, không cần escape
      csvText(r.fn), csvText(r.ln),
      csvText(r.ct), csvText(r.st), csvText(r.country),
      csvNum(r.value),
      csvText(r.customerId),
      r.demandGroup,           // giá trị cố định Wedding/Beauty
    ].join(","));
  }
  return "﻿" + lines.join("\r\n");
}

/** Tên file: amazing-studio-meta-customers-YYYY-MM-DD.csv (theo ngày truyền vào). */
export function metaExportFilename(date: Date | string): string {
  const d = typeof date === "string" ? date.slice(0, 10) : date.toISOString().slice(0, 10);
  return `amazing-studio-meta-customers-${d}.csv`;
}
