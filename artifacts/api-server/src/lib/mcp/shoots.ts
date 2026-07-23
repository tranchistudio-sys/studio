/**
 * shoots.ts — Đọc LỊCH CHỤP trong khoảng ngày: ngày chính (bookings.shoot_date) +
 * ngày phụ (booking_occurrences). CHỈ ĐỌC, tham số hoá ($1/$2) chống SQL injection,
 * cap độ rộng khoảng ngày (chống query quá rộng), whitelist field (không dump record).
 *
 * KHÔNG thêm business logic mới — đọc đúng các bảng mà Calendar hiện dùng.
 */
import { pool } from "@workspace/db";
import { getSchemaFlags } from "../schema-compat.js";

export type Shoot = {
  bookingId: number;
  orderCode: string | null;
  customerName: string | null;
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** HH:MM hoặc null. */
  time: string | null;
  location: string | null;
  serviceLabel: string | null;
  status: string | null;
  /** true = ngày thực hiện PHỤ (booking_occurrences), không phải ngày chính. */
  additionalDay: boolean;
  label?: string | null;
};

export type ListShootsResult = {
  from: string;
  to: string;
  count: number;
  shoots: Shoot[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92; // chặn query quá rộng

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function hhmm(t: string | null): string | null {
  return t ? String(t).slice(0, 5) : null;
}

/**
 * @throws Error('bad_request: ...') khi ngày sai định dạng / khoảng quá rộng.
 */
export async function listShoots(from: string, to: string): Promise<ListShootsResult> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new Error("bad_request: from/to phải là ngày dạng YYYY-MM-DD");
  }
  if (from > to) throw new Error("bad_request: from phải ≤ to");
  const span = daysBetween(from, to);
  if (span < 0 || span > MAX_RANGE_DAYS) {
    throw new Error(`bad_request: khoảng ngày tối đa ${MAX_RANGE_DAYS} ngày`);
  }

  // Ngày CHÍNH — loại đơn đã xoá + huỷ. Giữ nguyên các trạng thái Calendar hiển thị.
  const mainRows = await pool.query(
    `SELECT b.id, b.order_code, b.service_label, b.package_type,
            b.shoot_date::text AS shoot_date, b.shoot_time::text AS shoot_time,
            b.location, b.status, c.name AS customer_name
       FROM bookings b
       LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.deleted_at IS NULL
        AND COALESCE(b.status,'') <> 'cancelled'
        AND b.shoot_date IS NOT NULL
        AND b.shoot_date >= $1::date AND b.shoot_date <= $2::date
      ORDER BY b.shoot_date, b.shoot_time NULLS LAST, b.id
      LIMIT 500`,
    [from, to],
  );

  const shoots: Shoot[] = (mainRows.rows as Array<Record<string, unknown>>).map((r) => ({
    bookingId: Number(r.id),
    orderCode: (r.order_code as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    date: String(r.shoot_date),
    time: hhmm(r.shoot_time as string | null),
    location: (r.location as string | null) ?? null,
    serviceLabel: (r.service_label as string | null) || (r.package_type as string | null) || null,
    status: (r.status as string | null) ?? null,
    additionalDay: false,
  }));

  // Ngày PHỤ (booking_occurrences) — chỉ khi DB đã có bảng (tương thích ngược).
  if ((await getSchemaFlags()).occurrences) {
    const occRows = await pool.query(
      `SELECT o.booking_id, o.shoot_date::text AS shoot_date, o.shoot_time::text AS shoot_time, o.label,
              b.order_code, b.service_label, b.package_type, b.location, b.status, c.name AS customer_name
         FROM booking_occurrences o
         JOIN bookings b ON b.id = o.booking_id
         LEFT JOIN customers c ON c.id = b.customer_id
        WHERE b.deleted_at IS NULL
          AND COALESCE(b.status,'') <> 'cancelled'
          AND o.shoot_date >= $1::date AND o.shoot_date <= $2::date
        ORDER BY o.shoot_date, o.shoot_time NULLS LAST, o.booking_id
        LIMIT 500`,
      [from, to],
    );
    for (const r of occRows.rows as Array<Record<string, unknown>>) {
      shoots.push({
        bookingId: Number(r.booking_id),
        orderCode: (r.order_code as string | null) ?? null,
        customerName: (r.customer_name as string | null) ?? null,
        date: String(r.shoot_date),
        time: hhmm(r.shoot_time as string | null),
        location: (r.location as string | null) ?? null,
        serviceLabel: (r.service_label as string | null) || (r.package_type as string | null) || null,
        status: (r.status as string | null) ?? null,
        additionalDay: true,
        label: (r.label as string | null) ?? null,
      });
    }
  }

  shoots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time ?? "").localeCompare(b.time ?? "")));
  return { from, to, count: shoots.length, shoots };
}
