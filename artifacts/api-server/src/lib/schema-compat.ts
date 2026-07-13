/**
 * schema-compat.ts — kiểm tra DB có đủ schema của tính năng thuê đồ/ngày phụ chưa.
 *
 * Bài học sự cố 2026-07-13: deploy code mới (main 29695b5) lên prod đặt
 * SKIP_STARTUP_MIGRATIONS=1 → DB thiếu bảng/cột → GET /api/bookings 500 →
 * /calendar sập trắng. Code PHẢI chịu được schema cũ: query bỏ qua phần
 * schema chưa có, tính năng mới tạm tắt (fallback an toàn) thay vì 500.
 *
 * Cache: khi đã ĐỦ schema thì không hỏi lại (không tốn query); còn thiếu thì
 * hỏi lại mỗi lần — migration chạy xong là tự bật tính năng, KHÔNG cần restart.
 */
import { pool } from "@workspace/db";
import { getTableColumns } from "drizzle-orm";
import { bookingsTable } from "@workspace/db/schema";

export type SchemaFlags = {
  /** Bảng booking_occurrences (PR #79 — ngày thực hiện phụ). */
  occurrences: boolean;
  /** 2 cột bookings.dress_warn_pickup_days/return_days (PR #81 — setting nhắc). */
  dressWarnCols: boolean;
  /** Cột service_packages.warn_upcoming_show (PR #81 — nút gạt Thuê đồ). */
  warnToggleCol: boolean;
  /** 5 cột lifecycle booking_dresses, đại diện actual_return_date (PR #80). */
  lifecycleCols: boolean;
};

let cached: SchemaFlags | null = null;

function allOn(f: SchemaFlags): boolean {
  return f.occurrences && f.dressWarnCols && f.warnToggleCol && f.lifecycleCols;
}

export async function getSchemaFlags(): Promise<SchemaFlags> {
  if (cached && allOn(cached)) return cached;
  const r = await pool.query(`
    SELECT
      to_regclass('public.booking_occurrences') IS NOT NULL AS occ,
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='bookings'
                AND column_name='dress_warn_pickup_days') AS dw,
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='service_packages'
                AND column_name='warn_upcoming_show') AS wt,
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='booking_dresses'
                AND column_name='actual_return_date') AS lc
  `);
  const row = r.rows[0] ?? {};
  cached = {
    occurrences: row.occ === true,
    dressWarnCols: row.dw === true,
    warnToggleCol: row.wt === true,
    lifecycleCols: row.lc === true,
  };
  return cached;
}

/** Reset cache — chỉ dùng cho test. */
export function _resetSchemaFlagsCache(): void {
  cached = null;
}

/**
 * Bộ cột bookings theo schema THỰC TẾ của DB — thay cho db.select().from(bookingsTable)
 * (select() không tham số lấy MỌI cột theo schema code → DB chưa migrate là 500).
 * Thiếu cột dress_warn_* → loại khỏi SELECT; field tương ứng thành undefined (an toàn).
 */
export async function bookingColumnsCompat() {
  const flags = await getSchemaFlags();
  const cols: Record<string, unknown> = { ...getTableColumns(bookingsTable) };
  if (!flags.dressWarnCols) {
    delete cols.dressWarnPickupDays;
    delete cols.dressWarnReturnDays;
  }
  return cols as ReturnType<typeof getTableColumns<typeof bookingsTable>>;
}
