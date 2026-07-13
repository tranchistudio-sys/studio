import { pool } from "@workspace/db";
import { revenueCountableSql } from "./booking-money";

// ─── Types & constants ───────────────────────────────────────────────────────

export type CopilotIntent =
  | "greeting"
  | "schedule"
  | "revenue"
  | "debt"
  | "post_production"
  | "staff"
  | "customer"
  | "pricing"
  | "analysis"
  | "overview"
  | "unknown";

export type CopilotResult = {
  answer: string;
  fromData: boolean;
  intent: CopilotIntent;
};

export const COPILOT_SYSTEM_PROMPT = `Bạn là Amazing Studio Copilot, trợ lý điều hành nội bộ cho studio cưới Amazing Studio. Nhiệm vụ của bạn là đọc dữ liệu thật trong hệ thống, trả lời ngắn gọn, rõ ràng, không bịa, không nói lan man. Ưu tiên hỗ trợ quản lý lịch chụp, khách hàng, công nợ, doanh thu, nhân sự, chấm công, hậu kỳ và bảng giá. Nếu câu hỏi chỉ là chào hỏi thì chỉ chào lại, không tự xuất báo cáo.`;

// ─── Utilities ───────────────────────────────────────────────────────────────

function formatVND(n: number): string {
  return Math.round(n).toLocaleString("vi-VN") + " đ";
}

function formatDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getDate()}/${dt.getMonth() + 1}/${dt.getFullYear()}`;
}

// Mốc "hôm nay/tháng này" tính theo giờ Việt Nam, không phụ thuộc TZ server
// (prod chạy UTC — cùng kỹ thuật với dashboard.ts và revenue/helpers.ts).
const APP_TZ = "Asia/Ho_Chi_Minh";

function toVNDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: APP_TZ }); // "YYYY-MM-DD"
}

/**
 * Cột timestamp naive (paid_at, created_at) đang lưu wall-clock UTC → quy đổi
 * mốc ngày VN ($n dạng 'YYYY-MM-DD') sang UTC trước khi so sánh, độc lập session TZ.
 */
function vnBoundToUtc(param: string): string {
  return `(${param}::timestamp AT TIME ZONE '${APP_TZ}' AT TIME ZONE 'UTC')`;
}

function monthRange(ref = new Date()) {
  const [y, m] = toVNDateStr(ref).split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const p = (n: number) => String(n).padStart(2, "0");
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return {
    start: `${y}-${p(m)}-01`,
    end: `${y}-${p(m)}-${p(lastDay)}`,
    // Mốc nửa mở cho cột timestamp: [start, nextStart)
    nextStart: `${ny}-${p(nm)}-01`,
    label: `tháng ${m}/${y}`,
    year: y,
    month: m,
  };
}

function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .trim();
}

function staffSalutation(name: string | null | undefined): string {
  if (!name?.trim()) return "bạn";
  const parts = name.trim().split(/\s+/);
  const given = parts[parts.length - 1];
  return `anh ${given}`;
}

function todayStr(): string {
  return toVNDateStr(new Date());
}

function weekEnd(from = new Date()): string {
  return toVNDateStr(new Date(from.getTime() + 7 * 86400000));
}

// ─── Intent classification ─────────────────────────────────────────────────────

/** Câu hỏi mơ hồ → overview. Trả "today" | "month" | "general" | null */
export function detectOverviewScope(q: string): "today" | "month" | "general" | null {
  const specific = /(bao nhieu|may |ai |khach nao|don nao|danh sach|list|top |nhieu nhat)/.test(q);
  if (specific) return null;

  if (/^(hom nay|hnay)$/.test(q)) return "today";
  if (/hom nay (sao|the nao|ra sao|on|roi)/.test(q) || /(sao roi|the nao).*(hom nay|hnay)/.test(q)) return "today";

  if (/thang nay (ra sao|on|the nao|sao|roi)/.test(q) || /tinh hinh thang nay/.test(q)) return "month";
  if (/thang nay (on|ra sao)/.test(q)) return "month";

  const vague =
    /(tinh hinh|ra sao|the nao|on khong|can xu ly|dang chu y|cong viec|co gi|tong quan|overview|bao cao)/.test(q) ||
    /(hom nay|thang nay).*(sao|the nao|on|roi)/.test(q);
  if (!vague) return null;

  if (/hom nay|hnay/.test(q) && !/thang nay/.test(q)) return "today";
  if (/thang nay/.test(q)) return "month";
  return "general";
}

export function classifyIntent(question: string): CopilotIntent {
  const q = normalizeQuestion(question);
  if (!q) return "unknown";

  const pureGreeting =
    /^(hi|hello|hey|alo|chao|xin chao|helo)([\s!.,?]*)$/.test(q) ||
    q === "xin chao ban";
  if (pureGreeting) return "greeting";

  // Nhánh debt PHẢI đứng trước revenue: câu chứa từ khóa cả 2 nhánh (vd "doanh thu
  // chưa thu") là hỏi tiền CHƯA thu về → debt. "(?!\s?xep)" chặn "chưa thu xếp".
  if (
    /(no|cong no|no tien|chua tra|dang no|chua thanh toan)/.test(q) ||
    /(chua thu|phai thu|co the thu|con thu (dc|duoc))(?!\s?xep)/.test(q)
  )
    return "debt";
  if (/(doanh thu|thu ve|da thu|tien ve|loi nhuan|loi lo)/.test(q)) return "revenue";
  if (/(di tre|tre gio|muon|cham cong|check in|checkin)/.test(q)) return "staff";
  if (/(tre|qua han|overdue)/.test(q) && /(hau ky|pts|photoshop|retouch|don)/.test(q)) return "post_production";
  if (/(hau ky|pts|photoshop|retouch)/.test(q)) return "post_production";
  if (/(ban tot|ban chay|nhieu don)/.test(q) && /(goi|dich vu|package)/.test(q)) return "revenue";
  if (/(bang gia|goi dich vu|bao gia|gia goi|service package)/.test(q)) return "pricing";
  if (/(khach hang|thong tin khach|so dien thoai|sdt)/.test(q)) return "customer";
  if (/(phan tich|de xuat|uu tien|nen lam|nen xu ly|goi y van hanh|tuan nay nen)/.test(q)) return "analysis";
  if (/(nhan vien|cast|luong|nhieu viec|workload|ai dang lam)/.test(q)) return "staff";
  if (detectOverviewScope(q)) return "overview";
  if (/(hom nay|hnay|today|tuan nay|week|lich chup|lich show|show|buoi chup|may show|bao nhieu show)/.test(q)) return "schedule";

  return "unknown";
}

// ─── Data tools ──────────────────────────────────────────────────────────────

export async function getTodayBookings() {
  const today = todayStr();
  const r = await pool.query(
    `SELECT b.shoot_date, b.shoot_time, b.order_code, b.package_type,
            c.name AS customer_name, c.phone AS customer_phone
     FROM bookings b
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.shoot_date = $1::date AND ${revenueCountableSql("b")}
     ORDER BY b.shoot_time NULLS LAST, b.id
     LIMIT 30`,
    [today],
  );
  const rows = r.rows as Record<string, unknown>[];
  const lines = rows.map(b => {
    const time = b.shoot_time ? ` ${b.shoot_time}` : "";
    const code = b.order_code ? `[${b.order_code}] ` : "";
    return `• ${code}${b.customer_name} (${b.customer_phone}) — ${b.package_type || "—"}${time}`;
  });
  return { date: today, count: rows.length, lines };
}

export async function getMonthBookings(ref = new Date()) {
  const { start, end, label } = monthRange(ref);
  const r = await pool.query(
    `SELECT b.shoot_date, b.shoot_time, b.order_code, b.package_type, b.status,
            c.name AS customer_name
     FROM bookings b
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.shoot_date >= $1::date AND b.shoot_date <= $2::date
       AND ${revenueCountableSql("b")}
     ORDER BY b.shoot_date, b.shoot_time NULLS LAST
     LIMIT 50`,
    [start, end],
  );
  const rows = r.rows as Record<string, unknown>[];
  const lines = rows.map(b => {
    const time = b.shoot_time ? ` ${b.shoot_time}` : "";
    const code = b.order_code ? `[${b.order_code}] ` : "";
    return `• ${formatDate(b.shoot_date as string)}${time}: ${code}${b.customer_name} — ${b.package_type || "—"}`;
  });
  return { label, count: rows.length, lines, truncated: rows.length >= 50 };
}

export async function getRevenueSummary(ref = new Date()) {
  const { start, end, nextStart, label } = monthRange(ref);
  // paid_at là timestamp naive-UTC → ranh giới tháng VN phải quy đổi + nửa mở,
  // nếu không phiếu thu từ 07:00 sáng ngày cuối tháng trở đi bị rớt khỏi tháng.
  const paidCond = `paid_at >= ${vnBoundToUtc("$1")} AND paid_at < ${vnBoundToUtc("$2")}
     AND COALESCE(status, 'active') != 'voided'`;
  const revR = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE ${paidCond}`,
    [start, nextStart],
  );
  const ordR = await pool.query(
    `SELECT COUNT(*) AS cnt FROM bookings b
     WHERE b.shoot_date >= $1::date AND b.shoot_date <= $2::date AND ${revenueCountableSql("b")}`,
    [start, end],
  );
  const paidR = await pool.query(
    `SELECT COUNT(*) AS cnt FROM payments WHERE ${paidCond}`,
    [start, nextStart],
  );
  return {
    label,
    revenue: Number((revR.rows[0] as Record<string, unknown>)?.total ?? 0),
    orderCount: Number((ordR.rows[0] as Record<string, unknown>)?.cnt ?? 0),
    paymentCount: Number((paidR.rows[0] as Record<string, unknown>)?.cnt ?? 0),
  };
}

// Nợ per-booking theo ĐÚNG chuẩn dashboard/simple (customerDebt): NET − đã thu.
const BOOKING_DEBT_SQL =
  "GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0))";

/**
 * Khách còn nợ trên tập đơn countable chuẩn (loại thùng rác/hủy/báo giá tạm/đơn CHA
 * tổng/con mồ côi — cùng predicate với dashboard, chống cộng trùng cha–con PR #65).
 * @param range giới hạn "đơn phát sinh trong tháng" theo shoot_date (mốc ngày VN).
 */
export async function getUnpaidCustomers(
  limit = 15,
  range?: { start: string; end: string; label: string },
) {
  const rangeCond = range ? ` AND b.shoot_date >= $2::date AND b.shoot_date <= $3::date` : "";
  const r = await pool.query(
    `SELECT c.name, c.phone, SUM(${BOOKING_DEBT_SQL}) AS debt
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     WHERE ${revenueCountableSql("b")}${rangeCond}
     GROUP BY c.id, c.name, c.phone
     HAVING SUM(${BOOKING_DEBT_SQL}) > 0
     ORDER BY debt DESC
     LIMIT $1`,
    range ? [limit, range.start, range.end] : [limit],
  );
  const rows = r.rows as Record<string, unknown>[];
  const lines = rows.map(d => `• ${d.name} (${d.phone}): còn nợ ${formatVND(Number(d.debt))}`);
  const totalR = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${BOOKING_DEBT_SQL} > 0) AS order_cnt,
            COALESCE(SUM(${BOOKING_DEBT_SQL}), 0) AS total_debt
     FROM bookings b
     WHERE ${revenueCountableSql("b")}${range ? " AND b.shoot_date >= $1::date AND b.shoot_date <= $2::date" : ""}`,
    range ? [range.start, range.end] : [],
  );
  const totalRow = totalR.rows[0] as Record<string, unknown> | undefined;
  return {
    count: rows.length,
    totalDebt: Number(totalRow?.total_debt ?? 0),
    orderCount: Number(totalRow?.order_cnt ?? 0),
    lines,
  };
}

/**
 * customer_deadline / deadline_system là cột TEXT default '' — dữ liệu thật lẫn '',
 * 'YYYY-MM-DD' và 'YYYY-MM-DD HH:MM:SS'. Cast thẳng ::date nổ 22007 với '' (sự cố
 * Copilot "Không đọc được dữ liệu studio") → chỉ cast phần khớp dạng ngày, mọi giá
 * trị khác thành NULL (NULL so sánh = false, không crash).
 */
function safeDateSql(col: string): string {
  return `substring(${col} from '^\\d{4}-\\d{2}-\\d{2}')`;
}

export async function getOverduePostProductionJobs(limit = 15) {
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
  const rows = r.rows as Record<string, unknown>[];
  const lines = rows.map(j => {
    const code = j.order_code || j.job_code || "—";
    const dl = j.customer_deadline || j.deadline_system;
    const dlStr = dl ? formatDate(String(dl).slice(0, 10)) : "—";
    return `• [${code}] ${j.customer_name} — hạn ${dlStr}, ${j.staff_name} (${j.status})`;
  });
  return { count: rows.length, lines };
}

export async function getStaffWorkload(limit = 10) {
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
  const rows = r.rows as Record<string, unknown>[];
  const lines = rows.map(row => `• ${row.staff_name}: ${row.job_count} việc đang làm`);
  return { count: rows.length, lines, top: rows[0] as Record<string, unknown> | undefined };
}

export async function getAttendanceSummary(ref = new Date()) {
  const { start, nextStart, label } = monthRange(ref);
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
    [start, nextStart],
  );
  const rows = r.rows as Record<string, unknown>[];
  const lateLines = rows
    .filter(row => Number(row.late_count) > 0)
    .map(row => `• ${row.name}: ${row.late_count} lần đi trễ / ${row.checkins} lần check-in`);
  const totalCheckins = rows.reduce((s, row) => s + Number(row.checkins), 0);
  return { label, totalCheckins, lateLines, hasData: rows.length > 0 };
}

export async function getServicePerformance(ref = new Date()) {
  const { start, end, label } = monthRange(ref);
  const r = await pool.query(
    `SELECT COALESCE(sp.name, b.package_type, 'Khác') AS package_name,
            COUNT(b.id) AS booking_count,
            COALESCE(SUM(CAST(b.total_amount AS numeric)), 0) AS revenue
     FROM bookings b
     LEFT JOIN service_packages sp ON sp.id = b.service_package_id
     WHERE b.shoot_date >= $1::date AND b.shoot_date <= $2::date
       AND ${revenueCountableSql("b")}
     GROUP BY COALESCE(sp.name, b.package_type, 'Khác')
     ORDER BY booking_count DESC
     LIMIT 10`,
    [start, end],
  );
  const rows = r.rows as Record<string, unknown>[];
  const lines = rows.map(row =>
    `• ${row.package_name}: ${row.booking_count} đơn — ${formatVND(Number(row.revenue))}`,
  );
  return { label, lines, top: rows[0] as Record<string, unknown> | undefined };
}

export async function getPricingPackages(limit = 20) {
  const r = await pool.query(
    `SELECT p.code, p.name, p.price, p.short_description AS description, g.name AS group_name
     FROM service_packages p
     LEFT JOIN service_groups g ON g.id = p.group_id
     WHERE p.deleted_at IS NULL
     ORDER BY g.sort_order ASC NULLS LAST, p.sort_order ASC, p.name
     LIMIT $1`,
    [limit],
  );
  const rows = r.rows as Record<string, unknown>[];
  const lines = rows.map(p => {
    const price = formatVND(Number(p.price ?? 0));
    const grp = p.group_name ? ` (${p.group_name})` : "";
    return `• ${p.name}${grp}: ${price}`;
  });
  return { count: rows.length, lines };
}

async function getWeekSchedule() {
  const today = todayStr();
  const end = weekEnd();
  const r = await pool.query(
    `SELECT b.shoot_date, b.shoot_time, b.order_code, b.package_type, c.name AS customer_name
     FROM bookings b
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.shoot_date BETWEEN $1::date AND $2::date AND ${revenueCountableSql("b")}
     ORDER BY b.shoot_date, b.shoot_time NULLS LAST
     LIMIT 40`,
    [today, end],
  );
  const rows = r.rows as Record<string, unknown>[];
  const lines = rows.map(b => {
    const time = b.shoot_time ? ` ${b.shoot_time}` : "";
    const code = b.order_code ? `[${b.order_code}] ` : "";
    return `• ${formatDate(b.shoot_date as string)}${time}: ${code}${b.customer_name} — ${b.package_type || "—"}`;
  });
  return { count: rows.length, lines };
}

async function searchCustomer(q: string): Promise<string | null> {
  const phone = q.replace(/\D/g, "");
  if (phone.length >= 9) {
    const r = await pool.query(
      `SELECT c.name, c.phone,
              COUNT(b.id) AS booking_count,
              COALESCE(SUM(${BOOKING_DEBT_SQL}), 0) AS debt
       FROM customers c
       LEFT JOIN bookings b ON b.customer_id = c.id AND ${revenueCountableSql("b")}
       WHERE c.phone LIKE $1
       GROUP BY c.id, c.name, c.phone
       LIMIT 5`,
      [`%${phone.slice(-9)}%`],
    );
    const rows = r.rows as Record<string, unknown>[];
    if (rows.length) {
      const lines = rows.map(c =>
        `• ${c.name} (${c.phone}): ${c.booking_count} đơn, còn nợ ${formatVND(Number(c.debt))}`,
      );
      return `👤 **${rows.length} khách** tìm theo SĐT:\n\n${lines.join("\n")}`;
    }
  }
  return null;
}

// ─── Response builders ─────────────────────────────────────────────────────────

function greetingResponse(staffName?: string | null): string {
  const who = staffSalutation(staffName);
  return `Chào ${who}, em sẵn sàng hỗ trợ Amazing Studio. Anh có thể hỏi: hôm nay có bao nhiêu show, khách nào đang nợ, hoặc đơn nào trễ hậu kỳ.`;
}

function unknownResponse(): string {
  return `Em chưa hiểu câu hỏi này. Anh thử hỏi cụ thể hơn, hoặc gõ "tình hình hôm nay" / "tháng này ra sao" để xem tổng quan.`;
}

async function answerSchedule(q: string): Promise<string> {
  if (/tuan nay|week|7 ngay/.test(q)) {
    const week = await getWeekSchedule();
    const warn = week.count >= 40 ? "\n\n⚠️ Danh sách dài — hiển thị tối đa 40 buổi." : "";
    return `📅 **Lịch chụp 7 ngày tới:** ${week.count} buổi\n\n${week.lines.join("\n") || "• Không có lịch trong tuần này"}${warn}\n\n💡 Kiểm tra nhân sự cast trước từng buổi chụp.`;
  }
  if (/thang nay|thang/.test(q) && !/hom nay/.test(q)) {
    const month = await getMonthBookings();
    const suffix = month.truncated ? "\n\n⚠️ Chỉ hiển thị 50 buổi đầu trong tháng." : "";
    return `📅 **Lịch chụp ${month.label}:** ${month.count} buổi\n\n${month.lines.join("\n") || "• Chưa có lịch trong tháng"}${suffix}`;
  }
  const today = await getTodayBookings();
  return `📅 **Hôm nay ${formatDate(today.date)}:** ${today.count} show\n\n${today.lines.join("\n") || "• Không có show hôm nay"}\n\n💡 Xem chi tiết từng đơn tại module Lịch chụp.`;
}

async function answerDebt(q: string): Promise<string> {
  // "tháng này" → chỉ đơn PHÁT SINH trong tháng (theo shoot_date, giờ VN) —
  // nói rõ phạm vi để không lẫn với nợ tồn toàn hệ thống.
  const range = /thang nay/.test(q) ? monthRange() : undefined;
  const data = await getUnpaidCustomers(15, range);
  if (range) {
    if (!data.orderCount) {
      return `✅ **${range.label}: các đơn phát sinh trong tháng đã thu đủ.**\n\n📌 Phạm vi: chỉ tính đơn có ngày chụp trong ${range.label}. Nợ tồn các tháng trước (nếu có) không nằm trong số này — hỏi "khách nào đang nợ tiền" để xem toàn bộ.`;
    }
    return `💰 **${range.label}: ${data.orderCount} đơn chưa thu đủ** — còn có thể thu ${formatVND(data.totalDebt)} (${data.count} khách)\n\n${data.lines.join("\n")}\n\n📌 Phạm vi: đơn phát sinh trong ${range.label} (đã loại đơn hủy/xóa/báo giá tạm, không cộng trùng hợp đồng cha–con).\n💡 Muốn xem nợ tồn toàn bộ mọi tháng: hỏi "khách nào đang nợ tiền".`;
  }
  if (!data.count) {
    return "✅ **Không có khách nợ** — tất cả đơn đã thanh toán đủ trong hệ thống.";
  }
  return `💰 **${data.count} khách còn nợ** — tổng: ${formatVND(data.totalDebt)} (${data.orderCount} đơn chưa thu đủ)\n\n${data.lines.join("\n")}\n\n📌 Phạm vi: nợ tồn toàn hệ thống tính đến hiện tại, không giới hạn tháng.\n⚠️ Ưu tiên nhắc khách đầu danh sách.\n💡 Vào module Khách hàng để ghi nhận thanh toán.`;
}

async function answerRevenue(q: string): Promise<string> {
  if (/(ban tot|ban chay|nhieu don|goi.*ban)/.test(q)) {
    const perf = await getServicePerformance();
    if (!perf.top) {
      return `📦 **Gói dịch vụ ${perf.label}:** chưa có đơn chụp trong tháng.\n\n💡 Kiểm tra module Đơn hàng nếu đã có booking ngoài hệ thống.`;
    }
    const topLines = perf.lines.slice(0, 5).join("\n");
    return `📦 **Gói bán tốt nhất ${perf.label}:** ${perf.top.package_name} (${perf.top.booking_count} đơn — ${formatVND(Number(perf.top.revenue))})\n\n**Top gói:**\n${topLines}\n\n💡 Tập trung marketing gói đang bán chạy.`;
  }
  const data = await getRevenueSummary();
  if (data.paymentCount === 0 && data.revenue === 0) {
    return `📊 **Doanh thu ${data.label}:** chưa có phiếu thu trong hệ thống.\n\n💡 Nếu đã thu tiền ngoài app, cần ghi nhận vào module Thanh toán.`;
  }
  return `💵 **Doanh thu ${data.label}** (phiếu thu thực tế): ${formatVND(data.revenue)}\n📦 Đơn chụp trong tháng: **${data.orderCount}** đơn (${data.paymentCount} phiếu thu)\n\n💡 So sánh với mục tiêu tháng để điều chỉnh kế hoạch bán.`;
}

async function answerPostProduction(q: string): Promise<string> {
  if (/(tre|qua han|overdue)/.test(q)) {
    const overdue = await getOverduePostProductionJobs();
    if (!overdue.count) {
      return "✅ **Không có đơn trễ hậu kỳ** — tất cả job đang trong hạn.";
    }
    return `🚨 **${overdue.count} đơn trễ hậu kỳ:**\n\n${overdue.lines.join("\n")}\n\n⚠️ Ưu tiên xử lý các đơn quá hạn giao khách.\n💡 Vào Tiến độ hậu kỳ để cập nhật trạng thái.`;
  }
  const workload = await getStaffWorkload();
  if (!workload.count) {
    return "✅ Không có việc hậu kỳ đang tồn — tất cả đã xong hoặc chưa có job.";
  }
  return `🖥️ **Việc hậu kỳ đang làm** (${workload.count} nhân sự):\n\n${workload.lines.join("\n")}\n\n💡 Cân bằng tải nếu một người quá nhiều việc.`;
}

async function answerStaff(q: string): Promise<string> {
  if (/(di tre|tre gio|muon|cham cong)/.test(q)) {
    const att = await getAttendanceSummary();
    if (!att.hasData) {
      return `⏰ **Chấm công ${att.label}:** chưa có dữ liệu check-in trong hệ thống.\n\n💡 Cần nhân viên chấm công qua app để có số liệu.`;
    }
    if (!att.lateLines.length) {
      return `⏰ **Chấm công ${att.label}:** ${att.totalCheckins} lần check-in — không ai đi trễ sau 08:10.`;
    }
    return `⏰ **Đi trễ nhiều nhất** (${att.label}, sau 08:10):\n\n${att.lateLines.join("\n")}\n\n💡 Trao đổi với nhân viên đầu danh sách nếu lặp lại.`;
  }
  const workload = await getStaffWorkload();
  if (!workload.count) {
    return "✅ Không có việc hậu kỳ đang giao — kiểm tra module Nhân sự để xem lịch cast.";
  }
  const top = workload.top;
  const topName = top?.staff_name ?? "—";
  const topCount = top?.job_count ?? 0;
  return `👷 **Tải hậu kỳ theo nhân sự:**\n\n${workload.lines.join("\n")}\n\n⚠️ **${topName}** đang nhiều việc nhất (${topCount} job).\n💡 Cân nhắc chuyển bớt job hoặc hỗ trợ thêm.`;
}

async function answerPricing(): Promise<string> {
  const pkgs = await getPricingPackages();
  if (!pkgs.count) {
    return "📋 Chưa có gói dịch vụ trong bảng giá (service_packages). Cần cập nhật CMS Bảng giá.";
  }
  return `📋 **Bảng giá** (${pkgs.count} gói):\n\n${pkgs.lines.join("\n")}\n\n💡 Chi tiết đầy đủ xem tại module Bảng giá / CMS.`;
}

async function answerCustomer(q: string): Promise<string> {
  const found = await searchCustomer(q);
  if (found) return found + "\n\n💡 Gửi SĐT hoặc tên khách cụ thể để tra chi tiết hơn.";
  return "👤 Để tra khách hàng, anh gửi **số điện thoại** hoặc hỏi: \"Khách nào đang nợ tiền?\"";
}


/**
 * Một tool lỗi KHÔNG được giết cả câu trả lời tổng quan/phân tích (sự cố prod:
 * Promise.all chết chùm vì 1 query hỏng) — trả null + log lỗi thật để tra sau.
 */
async function safeTool<T>(name: string, run: Promise<T>): Promise<T | null> {
  try {
    return await run;
  } catch (err) {
    console.error(`studio-copilot tool ${name} error:`, err);
    return null;
  }
}

const NO_DATA = "(tạm không đọc được mục này)";

async function answerOverview(q: string): Promise<string> {
  const scope = detectOverviewScope(q) ?? "general";
  const isToday = scope === "today";
  const mLabel = monthRange().label;
  const label = isToday
    ? `hôm nay ${formatDate(todayStr())}`
    : scope === "month"
      ? mLabel
      : `studio — ${formatDate(todayStr())}`;

  const [rev, debt, today, month, overdue, workload, att] = await Promise.all([
    safeTool("revenue", getRevenueSummary()),
    safeTool("debt", getUnpaidCustomers(3)),
    safeTool("todaySchedule", getTodayBookings()),
    safeTool("monthSchedule", getMonthBookings()),
    safeTool("overduePts", getOverduePostProductionJobs(5)),
    safeTool("workload", getStaffWorkload(3)),
    safeTool("attendance", getAttendanceSummary()),
  ]);

  const scheduleNote = isToday
    ? today
      ? today.count
        ? `${today.count} show`
        : "không có show"
      : NO_DATA
    : month
      ? month.count
        ? `${month.count} buổi chụp`
        : "chưa có lịch"
      : NO_DATA;

  const ptsActive = workload?.lines.length
    ? workload.lines.reduce((sum, line) => {
        const m = line.match(/: (\d+) việc/);
        return sum + (m ? Number(m[1]) : 0);
      }, 0)
    : 0;

  const summaryLines = [
    rev
      ? `• **Doanh thu ${rev.label}:** ${formatVND(rev.revenue)} (${rev.orderCount} đơn chụp)`
      : `• **Doanh thu ${mLabel}:** ${NO_DATA}`,
    `• **Lịch ${isToday ? "hôm nay" : scope === "month" ? mLabel : "hôm nay"}:** ${scheduleNote}`,
    debt
      ? `• **Công nợ:** ${debt.count ? `${debt.count} khách — ${formatVND(debt.totalDebt)}` : "không có"}`
      : `• **Công nợ:** ${NO_DATA}`,
    workload && overdue
      ? `• **Hậu kỳ:** ${ptsActive} việc đang làm${overdue.count ? `, **${overdue.count} đơn trễ**` : ""}`
      : `• **Hậu kỳ:** ${NO_DATA}`,
    workload
      ? workload.top
        ? `• **Nhân sự HK:** ${workload.top.staff_name} nhiều việc nhất (${workload.top.job_count} job)`
        : `• **Nhân sự HK:** không có việc tồn`
      : `• **Nhân sự HK:** ${NO_DATA}`,
    att
      ? att.lateLines.length
        ? `• **Chấm công ${att.label}:** ${att.lateLines[0].replace("• ", "")}`
        : att.hasData
          ? `• **Chấm công ${att.label}:** không ai đi trễ sau 08:10`
          : `• **Chấm công:** chưa có dữ liệu check-in`
      : `• **Chấm công:** ${NO_DATA}`,
  ];

  const issues: string[] = [];
  if (overdue && overdue.count > 0) issues.push(`🚨 **${overdue.count} đơn hậu kỳ trễ** — ${overdue.lines.slice(0, 2).map(l => l.replace("• ", "")).join("; ")}`);
  if (debt && debt.count > 0) issues.push(`💰 Công nợ **${formatVND(debt.totalDebt)}** — ${debt.lines.slice(0, 2).map(l => l.replace("• ", "")).join("; ")}`);
  if (isToday && today && today.count >= 3) issues.push(`📅 Hôm nay **${today.count} show** — cần sắp nhân sự & thiết bị`);
  if (workload?.top && Number(workload.top.job_count) >= 5) issues.push(`👷 ${workload.top.staff_name} đang **${workload.top.job_count}** việc HK — cân tải`);
  if (att && att.lateLines.length >= 2) issues.push(`⏰ Nhiều người đi trễ tháng này — xem module Chấm công`);
  if (!rev || !debt || !today || !month || !overdue || !workload || !att) {
    issues.push("⚠️ Một phần dữ liệu tạm không đọc được — số liệu phía trên có thể thiếu");
  }
  if (!issues.length) issues.push("✅ Không có vấn đề cấp bách — vận hành ổn định");

  const priorities: string[] = [];
  if (overdue && overdue.count > 0) priorities.push(`1. Xử lý **${overdue.count} đơn trễ hậu kỳ** trước`);
  if (debt && debt.count > 0) priorities.push(`${priorities.length + 1}. Nhắc thu công nợ — ưu tiên khách đầu danh sách`);
  if (isToday && today && today.count > 0) priorities.push(`${priorities.length + 1}. Chuẩn bị **${today.count} show hôm nay**`);
  else if (!isToday && month && month.count > 0) priorities.push(`${priorities.length + 1}. Rà soát lịch **${month.label}** (${month.count} buổi)`);
  if (workload?.top && Number(workload.top.job_count) >= 4) priorities.push(`${priorities.length + 1}. Hỗ trợ **${workload.top.staff_name}** giảm tải hậu kỳ`);
  if (!priorities.length) priorities.push("1. Chăm sóc khách mới & cập nhật tiến độ đơn đang làm");

  return `📊 **Tổng quan ${label}**

**Tóm tắt**
${summaryLines.join("\n")}

**Vấn đề cần chú ý**
${issues.join("\n")}

**Việc nên ưu tiên**
${priorities.join("\n")}`;
}

async function answerAnalysis(): Promise<string> {
  const [today, debt, overdue, workload, perf] = await Promise.all([
    safeTool("todaySchedule", getTodayBookings()),
    safeTool("debt", getUnpaidCustomers(3)),
    safeTool("overduePts", getOverduePostProductionJobs(5)),
    safeTool("workload", getStaffWorkload(3)),
    safeTool("servicePerf", getServicePerformance()),
  ]);

  const priorities: string[] = [];
  if (overdue && overdue.count > 0) priorities.push(`1. **Hậu kỳ trễ** (${overdue.count} đơn) — xử lý ngay: ${overdue.lines.slice(0, 2).join("; ")}`);
  if (debt && debt.count > 0) priorities.push(`2. **Thu công nợ** — tổng ${formatVND(debt.totalDebt)}, ưu tiên: ${debt.lines.slice(0, 2).join("; ")}`);
  if (today && today.count > 0) priorities.push(`3. **Lịch hôm nay** — ${today.count} show, chuẩn bị nhân sự & thiết bị`);
  if (workload?.top) priorities.push(`4. **Cân tải hậu kỳ** — ${workload.top.staff_name} đang ${workload.top.job_count} việc`);
  if (perf?.top) priorities.push(`5. **Gói bán chạy** — ${perf.top.package_name} (${perf.top.booking_count} đơn ${perf.label})`);

  const degraded = !today || !debt || !overdue || !workload || !perf
    ? "\n\n⚠️ Một phần dữ liệu tạm không đọc được — danh sách có thể thiếu mục."
    : "";

  if (!priorities.length) {
    return `📊 Tuần này hệ thống ít việc cấp bách — tập trung chăm sóc khách mới và cập nhật bảng giá.${degraded}`;
  }

  return `📊 **Ưu tiên tuần này** (từ dữ liệu thật):\n\n${priorities.join("\n")}\n\n💡 Hỏi chi tiết từng mục: lịch hôm nay, công nợ, đơn trễ HK...${degraded}`;
}

/** Dữ liệu gộp cho LLM khi intent = analysis */
export async function buildAnalysisContext(): Promise<string> {
  const [today, debt, overdue, workload, att, perf, rev] = await Promise.all([
    safeTool("todaySchedule", getTodayBookings()),
    safeTool("debt", getUnpaidCustomers(5)),
    safeTool("overduePts", getOverduePostProductionJobs(8)),
    safeTool("workload", getStaffWorkload(5)),
    safeTool("attendance", getAttendanceSummary()),
    safeTool("servicePerf", getServicePerformance()),
    safeTool("revenue", getRevenueSummary()),
  ]);
  const mLabel = monthRange().label;
  return `=== DỮ LIỆU PHÂN TÍCH AMAZING STUDIO ===
Hôm nay (${formatDate(todayStr())}): ${today ? `${today.count} show` : NO_DATA}
${today ? today.lines.slice(0, 5).join("\n") || "(không có show)" : ""}

Doanh thu ${rev?.label ?? mLabel}: ${rev ? `${formatVND(rev.revenue)} (${rev.orderCount} đơn chụp)` : NO_DATA}

Công nợ: ${debt ? `${debt.count} khách, tổng ${formatVND(debt.totalDebt)}` : NO_DATA}
${debt ? debt.lines.join("\n") || "(không nợ)" : ""}

Đơn trễ hậu kỳ: ${overdue ? overdue.count : NO_DATA}
${overdue ? overdue.lines.join("\n") || "(không trễ)" : ""}

Tải hậu kỳ:
${workload ? workload.lines.join("\n") || "(không có việc)" : NO_DATA}

Chấm công ${att?.label ?? mLabel}: ${att ? att.lateLines.join("\n") || "(không đi trễ hoặc chưa có dữ liệu)" : NO_DATA}

Gói bán ${perf?.label ?? mLabel}:
${perf ? perf.lines.slice(0, 5).join("\n") || "(chưa có đơn)" : NO_DATA}`;
}

// ─── Main entry ────────────────────────────────────────────────────────────────

export async function answerStudioCopilot(
  question: string,
  staffName?: string | null,
): Promise<CopilotResult> {
  const q = normalizeQuestion(question);
  const intent = classifyIntent(question);

  try {
    if (intent === "greeting") {
      return { answer: greetingResponse(staffName), fromData: false, intent };
    }

    if (intent === "unknown") {
      const customerHit = await searchCustomer(q);
      if (customerHit) {
        return { answer: customerHit, fromData: true, intent: "customer" };
      }
      if (q.length >= 4) {
        return { answer: await answerOverview(q), fromData: true, intent: "overview" };
      }
      return { answer: unknownResponse(), fromData: false, intent };
    }

    let answer: string;
    switch (intent) {
      case "schedule":
        answer = await answerSchedule(q);
        break;
      case "debt":
        answer = await answerDebt(q);
        break;
      case "revenue":
        answer = await answerRevenue(q);
        break;
      case "post_production":
        answer = await answerPostProduction(q);
        break;
      case "staff":
        answer = await answerStaff(q);
        break;
      case "customer":
        answer = await answerCustomer(q);
        break;
      case "pricing":
        answer = await answerPricing();
        break;
      case "overview":
        answer = await answerOverview(q);
        break;
      case "analysis":
        answer = await answerAnalysis();
        break;
      default:
        answer = unknownResponse();
        return { answer, fromData: false, intent: "unknown" };
    }

    return { answer, fromData: true, intent };
  } catch (err) {
    console.error("answerStudioCopilot error:", err);
    return {
      answer: "❌ Không đọc được dữ liệu studio lúc này. Thử lại sau hoặc kiểm tra kết nối database.",
      fromData: false,
      intent,
    };
  }
}

export function isLlmConfigured(): boolean {
  // Claude (provider chính mới) — chỉ cần ANTHROPIC_API_KEY là LLM sẵn sàng.
  if ((process.env.ANTHROPIC_API_KEY ?? "").trim()) return true;
  // OpenAI legacy (cổng riêng hoặc OpenAI thật) — dùng khi provider là OpenAI.
  const key = (process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim();
  return !!key && key !== "placeholder";
}