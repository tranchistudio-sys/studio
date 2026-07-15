/**
 * OPERATIONS ENGINE — GĐ1e-3 (chủ duyệt workflow 15/07).
 *
 *   Database → OPERATIONS ENGINE (file này) → Copilot (chỉ ĐỌC + diễn đạt)
 *
 * Song song FINANCIAL ENGINE (tiền): sau GĐ1e-2 Copilot đã 0 SQL tài chính; GĐ1e-3
 * dời NỐT các query VẬN HÀNH (lịch chụp / hậu kỳ / nhân sự / chấm công / bảng giá)
 * ra đây → studio-copilot.ts KHÔNG còn `pool.query` nào (zero-SQL tuyệt đối).
 *
 * Lớp này CHỈ ĐỌC (SELECT), trả dữ liệu thô đã map camelCase; định dạng câu chữ
 * (formatVND/formatDate/lines) do Copilot lo. KHÔNG tính tiền (đó là việc Financial
 * Engine) — chỉ liệt kê/gom nghiệp vụ vận hành trên tập đơn hợp lệ (revenueCountableSql).
 */
import { pool } from "@workspace/db";
import { revenueCountableSql } from "../booking-money";

const APP_TZ = "Asia/Ho_Chi_Minh";

/** Cột timestamp naive-UTC (created_at) → quy mốc ngày VN sang UTC trước khi so sánh. */
function vnBoundToUtc(param: string): string {
  return `(${param}::timestamp AT TIME ZONE '${APP_TZ}' AT TIME ZONE 'UTC')`;
}

/**
 * customer_deadline / deadline_system là cột TEXT default '' — dữ liệu thật lẫn '',
 * 'YYYY-MM-DD' và 'YYYY-MM-DD HH:MM:SS'. Cast thẳng ::date nổ 22007 với '' → chỉ cast
 * phần khớp dạng ngày, mọi giá trị khác thành NULL (NULL so sánh = false, không crash).
 */
function safeDateSql(col: string): string {
  return `substring(${col} from '^\\d{4}-\\d{2}-\\d{2}')`;
}

// ─── Lịch chụp ─────────────────────────────────────────────────────────────────

export type ScheduleRow = {
  shootDate: string | null;
  shootTime: string | null;
  orderCode: string | null;
  packageType: string | null;
  customerName: string | null;
  /** Chỉ có ở truy vấn theo NGÀY (lịch hôm nay) — undefined ở truy vấn khoảng. */
  customerPhone?: string | null;
};

function mapSchedule(b: Record<string, unknown>, withPhone: boolean): ScheduleRow {
  const row: ScheduleRow = {
    shootDate: (b.shoot_date as string) ?? null,
    shootTime: (b.shoot_time as string) ?? null,
    orderCode: (b.order_code as string) ?? null,
    packageType: (b.package_type as string) ?? null,
    customerName: (b.customer_name as string) ?? null,
  };
  if (withPhone) row.customerPhone = (b.customer_phone as string) ?? null;
  return row;
}

/** Lịch chụp trong MỘT ngày (kèm SĐT khách) — đơn hợp lệ, tối đa 30. */
export async function opsBookingsOnDate(date: string): Promise<ScheduleRow[]> {
  const r = await pool.query(
    `SELECT b.shoot_date, b.shoot_time, b.order_code, b.package_type,
            c.name AS customer_name, c.phone AS customer_phone
     FROM bookings b
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.shoot_date = $1::date AND ${revenueCountableSql("b")}
     ORDER BY b.shoot_time NULLS LAST, b.id
     LIMIT 30`,
    [date],
  );
  return (r.rows as Array<Record<string, unknown>>).map(b => mapSchedule(b, true));
}

/** Lịch chụp trong khoảng ngày [from, to] (tháng / tuần) — đơn hợp lệ, limit tuỳ nơi. */
export async function opsBookingsInRange(from: string, to: string, limit: number): Promise<ScheduleRow[]> {
  const r = await pool.query(
    `SELECT b.shoot_date, b.shoot_time, b.order_code, b.package_type,
            c.name AS customer_name
     FROM bookings b
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.shoot_date >= $1::date AND b.shoot_date <= $2::date
       AND ${revenueCountableSql("b")}
     ORDER BY b.shoot_date, b.shoot_time NULLS LAST
     LIMIT $3`,
    [from, to, limit],
  );
  return (r.rows as Array<Record<string, unknown>>).map(b => mapSchedule(b, false));
}

// ─── Hậu kỳ (photoshop_jobs) ───────────────────────────────────────────────────

export type OverdueJobRow = {
  jobCode: string | null;
  orderCode: string | null;
  customerName: string | null;
  customerDeadline: string | null;
  deadlineSystem: string | null;
  status: string | null;
  staffName: string;
};

/** Job hậu kỳ đang mở đã quá hạn khách HOẶC hạn hệ thống (tính theo ngày VN). */
export async function opsOverduePostProductionJobs(limit = 15): Promise<OverdueJobRow[]> {
  const cd = safeDateSql("pj.customer_deadline");
  const ds = safeDateSql("pj.deadline_system");
  const vnToday = `(NOW() AT TIME ZONE '${APP_TZ}')::date`;
  const r = await pool.query(
    `SELECT pj.job_code, b.order_code, c.name AS customer_name,
            pj.customer_deadline, pj.deadline_system, pj.status,
            COALESCE(NULLIF(TRIM(pj.assigned_staff_name), ''), 'Chưa giao') AS staff_name
     FROM photoshop_jobs pj
     LEFT JOIN bookings b ON b.id = pj.booking_id
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE pj.is_active = true
       AND pj.status NOT IN ('xong_show', 'hoan_thanh')
       AND (${cd}::date < ${vnToday} OR ${ds}::date < ${vnToday})
     ORDER BY COALESCE(${cd}, ${ds}) NULLS LAST
     LIMIT $1`,
    [limit],
  );
  return (r.rows as Array<Record<string, unknown>>).map(j => ({
    jobCode: (j.job_code as string) ?? null,
    orderCode: (j.order_code as string) ?? null,
    customerName: (j.customer_name as string) ?? null,
    customerDeadline: (j.customer_deadline as string) ?? null,
    deadlineSystem: (j.deadline_system as string) ?? null,
    status: (j.status as string) ?? null,
    staffName: String(j.staff_name ?? "Chưa giao"),
  }));
}

// ─── Nhân sự: tải hậu kỳ theo người ────────────────────────────────────────────

export type StaffWorkloadRow = { staffName: string; jobCount: number };

/** Số job hậu kỳ đang mở gom theo nhân sự được giao, xếp nhiều → ít. */
export async function opsStaffWorkload(limit = 10): Promise<StaffWorkloadRow[]> {
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(assigned_staff_name), ''), 'Chưa giao') AS staff_name,
            COUNT(*) AS job_count
     FROM photoshop_jobs
     WHERE is_active = true
       AND status NOT IN ('xong_show', 'hoan_thanh')
     GROUP BY assigned_staff_id, assigned_staff_name
     ORDER BY job_count DESC
     LIMIT $1`,
    [limit],
  );
  return (r.rows as Array<Record<string, unknown>>).map(row => ({
    staffName: String(row.staff_name ?? "Chưa giao"),
    jobCount: Number(row.job_count),
  }));
}

// ─── Chấm công ─────────────────────────────────────────────────────────────────

export type AttendanceRow = { name: string | null; lateCount: number; checkins: number };

/** Đi trễ (check-in sau 08:10 giờ VN) + số check-in theo nhân viên trong kỳ [from, to). */
export async function opsAttendance(from: string, to: string): Promise<AttendanceRow[]> {
  // created_at naive-UTC: đổi sang giờ VN phải qua 'UTC' trước ('AT TIME ZONE VN'
  // trực tiếp là SAI CHIỀU — check-in buổi sáng bị đếm nhầm thành đi trễ).
  const r = await pool.query(
    `SELECT s.name,
            COUNT(*) FILTER (
              WHERE al.type = 'check_in'
                AND (al.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${APP_TZ}')::time > TIME '08:10:00'
            ) AS late_count,
            COUNT(*) FILTER (WHERE al.type = 'check_in') AS checkins
     FROM attendance_logs al
     JOIN staff s ON s.id = al.staff_id
     WHERE al.created_at >= ${vnBoundToUtc("$1")} AND al.created_at < ${vnBoundToUtc("$2")}
     GROUP BY s.id, s.name
     HAVING COUNT(*) FILTER (WHERE al.type = 'check_in') > 0
     ORDER BY late_count DESC, checkins DESC
     LIMIT 10`,
    [from, to],
  );
  return (r.rows as Array<Record<string, unknown>>).map(row => ({
    name: (row.name as string) ?? null,
    lateCount: Number(row.late_count),
    checkins: Number(row.checkins),
  }));
}

// ─── Bảng giá ──────────────────────────────────────────────────────────────────

export type PricingRow = {
  code: string | null;
  name: string | null;
  price: number;
  description: string | null;
  groupName: string | null;
};

/** Gói dịch vụ đang mở bán (chưa xóa), theo thứ tự nhóm rồi tên. */
export async function opsPricingPackages(limit = 20): Promise<PricingRow[]> {
  const r = await pool.query(
    `SELECT p.code, p.name, p.price, p.short_description AS description, g.name AS group_name
     FROM service_packages p
     LEFT JOIN service_groups g ON g.id = p.group_id
     WHERE p.deleted_at IS NULL
     ORDER BY g.sort_order ASC NULLS LAST, p.sort_order ASC, p.name
     LIMIT $1`,
    [limit],
  );
  return (r.rows as Array<Record<string, unknown>>).map(p => ({
    code: (p.code as string) ?? null,
    name: (p.name as string) ?? null,
    price: Number(p.price ?? 0),
    description: (p.description as string) ?? null,
    groupName: (p.group_name as string) ?? null,
  }));
}
