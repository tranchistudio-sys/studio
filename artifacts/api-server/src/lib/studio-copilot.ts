import { pool } from "@workspace/db";
import { revenueCountableSql } from "./booking-money";
// GĐ1e-2 (chủ duyệt 15/07): Copilot KHÔNG tự SQL tài chính nữa — mọi số tiền đọc
// từ FINANCIAL ENGINE (số thô) + BUSINESS ENGINE (Insight có status/caveats). Các
// query còn lại trong file này là VẬN HÀNH (lịch/nhân sự/chấm công/bảng giá/hậu kỳ).
import {
  engineMonthlyRevenueActivity,
  engineServicePerformance,
  engineUnpaidCustomers,
  engineCustomersByPhone,
} from "./finance/financial-engine";
import { bizMonthlyOverview, type InsightStatus } from "./finance/business-engine";

// ─── Types & constants ───────────────────────────────────────────────────────

export type CopilotIntent =
  | "greeting"
  | "schedule"
  | "revenue"
  | "finance"
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
  /** Facts đã xác minh từ DB — nguồn số liệu DUY NHẤT cho AI composer diễn đạt lại. */
  facts?: CopilotFacts;
};

/**
 * Dữ kiện có cấu trúc, tách "số liệu đã xác minh" khỏi "cách diễn đạt".
 * Composer (AI hoặc deterministic) chỉ được diễn đạt từ đây, không tự tạo số.
 */
export type CopilotFacts = {
  intent: CopilotIntent;
  /** "2026-07" (theo tháng) hoặc "2026-07-14" (theo ngày) nếu câu hỏi có mốc thời gian. */
  period?: string;
  /** Phạm vi số liệu bằng lời — composer phải giữ đúng phạm vi này khi diễn đạt. */
  scopeDescription: string;
  /** Độ tin dữ liệu từ Business Engine Insight — "partial/missing/unknown" phải được nói ra. */
  status?: InsightStatus;
  /** Lưu ý bắt buộc (phủ sổ cast, hoa hồng sale…) — composer phải nêu ĐẦY ĐỦ, không giấu. */
  caveats?: string[];
  facts: Record<string, unknown>;
};

/** Câu trả lời nội bộ của từng intent: text deterministic + facts kèm theo. */
type BuiltAnswer = { text: string; facts?: CopilotFacts };

export const COPILOT_SYSTEM_PROMPT = `Bạn là Amazing Studio Copilot, trợ lý điều hành nội bộ cho studio cưới Amazing Studio. Nhiệm vụ của bạn là đọc dữ liệu thật trong hệ thống, trả lời ngắn gọn, rõ ràng, không bịa, không nói lan man. Ưu tiên hỗ trợ quản lý lịch chụp, khách hàng, công nợ, doanh thu, nhân sự, chấm công, hậu kỳ và bảng giá. Nếu câu hỏi chỉ là chào hỏi thì chỉ chào lại, không tự xuất báo cáo.`;

// ─── Utilities ───────────────────────────────────────────────────────────────

function formatVND(n: number): string {
  return Math.round(n).toLocaleString("vi-VN") + " đ";
}

function formatDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getDate()}/${dt.getMonth() + 1}/${dt.getFullYear()}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
    period: `${y}-${p(m)}`,
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
    /^(hi|hello|hey|alo|chao|xin chao|helo)( em| ban| anh| chi)?([\s!.,?]*)$/.test(q) ||
    q === "xin chao ban";
  if (pureGreeting) return "greeting";

  // Tài chính (thu − chi = lợi nhuận, hòa vốn) PHẢI đứng trước debt/revenue —
  // cùng công thức màn "Tổng quan tài chính" (sự cố 14/07: câu "tổng quan tài
  // chính" rơi vào overview, thiếu chi phí/lợi nhuận và lệch số với màn hình).
  if (/(tai chinh|loi nhuan|lai lo|loi lo|hoa von|chi phi|da chi bao nhieu|chi het bao nhieu|tieu bao nhieu)/.test(q))
    return "finance";

  // Nhánh debt PHẢI đứng trước revenue: câu chứa từ khóa cả 2 nhánh (vd "doanh thu
  // chưa thu") là hỏi tiền CHƯA thu về → debt. "(?!\s?xep)" chặn "chưa thu xếp".
  if (
    /(no|cong no|no tien|chua tra|dang no|chua thanh toan)/.test(q) ||
    /(chua thu|phai thu|co the thu|con thu (dc|duoc))(?!\s?xep)/.test(q)
  )
    return "debt";
  if (/(doanh thu|thu ve|da thu|tien ve)/.test(q)) return "revenue";
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

/**
 * Doanh thu tháng: đọc từ FINANCIAL ENGINE. `revenue` (đã thu) = engineCashIn nên
 * KHỚP TỪNG ĐỒNG màn Tổng quan tài chính — thay cửa sổ vnBoundToUtc-trọn-tháng cũ
 * bằng cùng cửa sổ Dashboard/Engine (hết lệch nhẹ ở ranh giới tháng, 4 surface = 1 số).
 */
export async function getRevenueSummary(ref = new Date()) {
  const { start, end, label } = monthRange(ref);
  const a = await engineMonthlyRevenueActivity(start, end);
  return { label, revenue: a.collected, orderCount: a.bookingCount, paymentCount: a.paymentCount };
}

/**
 * Khách còn nợ: đọc từ FINANCIAL ENGINE (engineUnpaidCustomers) — cùng nợ sống ①
 * và predicate countable với engineSystemDebt/Dashboard. Wrapper chỉ định dạng dòng.
 * @param range giới hạn "đơn thuộc tháng": shoot_date HOẶC occurrence trong tháng.
 */
export async function getUnpaidCustomers(
  limit = 15,
  range?: { start: string; end: string; label: string },
) {
  const data = await engineUnpaidCustomers(limit, range ? { start: range.start, end: range.end } : undefined);
  const lines = data.customers.map(d => `• ${d.name} (${d.phone}): còn nợ ${formatVND(d.debt)}`);
  return {
    count: data.customers.length,
    totalDebt: data.totalDebt,
    orderCount: data.orderCount,
    lines,
    // Khách nợ lớn nhất (danh sách đã ORDER BY debt DESC) — cho follow-up có căn cứ.
    top: data.customers[0] ? { name: String(data.customers[0].name), debt: data.customers[0].debt } : undefined,
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
  const rows = await engineServicePerformance(start, end);
  const lines = rows.map(row => `• ${row.packageName}: ${row.bookingCount} đơn — ${formatVND(row.revenue)}`);
  const top = rows[0]
    ? { package_name: rows[0].packageName, booking_count: rows[0].bookingCount, revenue: rows[0].revenue }
    : undefined;
  return { label, lines, top };
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

async function searchCustomer(q: string): Promise<BuiltAnswer | null> {
  const phone = q.replace(/\D/g, "");
  if (phone.length >= 9) {
    // Nợ khách đọc từ FINANCIAL ENGINE (nợ sống ①); phần tra đuôi SĐT là vận hành.
    const rows = await engineCustomersByPhone(phone.slice(-9));
    if (rows.length) {
      const lines = rows.map(c =>
        `• ${c.name} (${c.phone}): ${c.bookingCount} đơn, còn nợ ${formatVND(c.debt)}`,
      );
      return {
        text: `Em tìm thấy ${rows.length} khách theo số điện thoại này:\n\n${lines.join("\n")}`,
        facts: {
          intent: "customer",
          scopeDescription: "tra khách theo số điện thoại, kèm số đơn hợp lệ và nợ còn lại",
          facts: { matchCount: rows.length, lines },
        },
      };
    }
  }
  return null;
}

// ─── Response builders ─────────────────────────────────────────────────────────

function greetingResponse(staffName?: string | null): string {
  const who = staffSalutation(staffName);
  return `Chào ${who}, em sẵn sàng hỗ trợ Amazing Studio. Anh có thể hỏi em về lịch chụp, công nợ, doanh thu, hậu kỳ hay chấm công — ví dụ "hôm nay có bao nhiêu show".`;
}

function unknownResponse(): string {
  return `Em chưa hiểu ý anh lắm. Anh hỏi cụ thể hơn giúp em, hoặc gõ "tình hình hôm nay" / "tháng này ra sao" để em tóm tắt tổng quan.`;
}

/**
 * Tối đa MỘT gợi ý bước tiếp theo, gắn với đúng intent và CHỈ khi facts có căn cứ.
 * Không dùng câu khuyên chung chung kiểu "so sánh với mục tiêu" khi không có dữ liệu
 * mục tiêu, và không dùng cùng một câu cho mọi loại câu hỏi.
 */
export function buildFollowUp(intent: CopilotIntent, f: Record<string, unknown>): string | null {
  switch (intent) {
    case "revenue": {
      const n = Number(f.bookingCount ?? 0);
      if (n <= 0) return null;
      return `Số đã thu chưa phản ánh hết dòng tiền — anh muốn biết trong ${n} đơn của tháng còn đơn nào chưa thu đủ, còn thu về được bao nhiêu thì hỏi em "tháng này còn bao nhiêu đơn chưa thu".`;
    }
    case "debt": {
      const name = typeof f.topDebtorName === "string" ? f.topDebtorName : "";
      const debt = Number(f.topDebtorDebt ?? 0);
      if (!name || debt <= 0) return null;
      return `Riêng ${name} đã chiếm ${formatVND(debt)} — anh nên nhắc nhóm khách đầu danh sách trước.`;
    }
    case "schedule": {
      const n = Number(f.count ?? 0);
      if (n < 3) return null;
      return `Lịch khá dày, anh để ý sắp nhân sự và thiết bị sớm nha.`;
    }
    case "post_production": {
      const n = Number(f.overdueCount ?? 0);
      if (n <= 0) return null;
      return `Đơn đứng đầu danh sách đang trễ lâu nhất — anh ưu tiên xử lý rồi cập nhật trạng thái trong Tiến độ hậu kỳ.`;
    }
    case "staff": {
      const name = typeof f.topStaffName === "string" ? f.topStaffName : "";
      const top = Number(f.topJobCount ?? 0);
      if (!name || top < 5) return null;
      return `${name} đang ôm ${top} việc — anh cân nhắc san bớt cho người đang ít việc hơn.`;
    }
    default:
      return null;
  }
}

async function answerSchedule(q: string): Promise<BuiltAnswer> {
  if (/tuan nay|week|7 ngay/.test(q)) {
    const week = await getWeekSchedule();
    const facts: CopilotFacts = {
      intent: "schedule",
      scopeDescription: "lịch chụp 7 ngày tới, chỉ tính đơn hợp lệ (đã loại đơn hủy/xóa/báo giá tạm)",
      facts: { count: week.count, lines: week.lines },
    };
    if (!week.count) {
      return { text: "7 ngày tới studio chưa có lịch chụp nào anh nha.", facts };
    }
    const warn = week.count >= 40 ? "\n\nDanh sách dài nên em chỉ hiển thị 40 buổi đầu." : "";
    const follow = buildFollowUp("schedule", facts.facts);
    return {
      text: `7 ngày tới studio có ${week.count} buổi chụp anh nha:\n\n${week.lines.join("\n")}${warn}${follow ? `\n\n${follow}` : ""}`,
      facts,
    };
  }
  if (/thang nay|thang/.test(q) && !/hom nay/.test(q)) {
    const m = monthRange();
    const month = await getMonthBookings();
    const facts: CopilotFacts = {
      intent: "schedule",
      period: m.period,
      scopeDescription: `lịch chụp ${month.label}, chỉ tính đơn hợp lệ`,
      facts: { count: month.count, lines: month.lines },
    };
    if (!month.count) {
      return { text: `${capitalize(month.label)} chưa có lịch chụp nào trong hệ thống anh nha.`, facts };
    }
    const suffix = month.truncated ? "\n\nDanh sách dài nên em chỉ hiển thị 50 buổi đầu trong tháng." : "";
    return {
      text: `${capitalize(month.label)} studio có ${month.count} buổi chụp:\n\n${month.lines.join("\n")}${suffix}`,
      facts,
    };
  }
  const today = await getTodayBookings();
  const facts: CopilotFacts = {
    intent: "schedule",
    period: today.date,
    scopeDescription: `lịch chụp hôm nay ${formatDate(today.date)}, chỉ tính đơn hợp lệ`,
    facts: { count: today.count, lines: today.lines },
  };
  if (!today.count) {
    return {
      text: `Hôm nay ${formatDate(today.date)} studio không có show nào anh nha. Anh muốn xem lịch tuần này hay cả tháng thì hỏi em thêm.`,
      facts,
    };
  }
  const follow = buildFollowUp("schedule", facts.facts);
  return {
    text: `Hôm nay ${formatDate(today.date)} studio có ${today.count} show anh nha:\n\n${today.lines.join("\n")}${follow ? `\n\n${follow}` : ""}`,
    facts,
  };
}

async function answerDebt(q: string): Promise<BuiltAnswer> {
  // "tháng này" → chỉ đơn PHÁT SINH trong tháng (theo shoot_date, giờ VN) —
  // nói rõ phạm vi để không lẫn với nợ tồn toàn hệ thống.
  const range = /thang nay/.test(q) ? monthRange() : undefined;
  const data = await getUnpaidCustomers(15, range);
  const factData: Record<string, unknown> = {
    customerCount: data.count,
    orderCount: data.orderCount,
    totalDebt: data.totalDebt,
    topDebtorName: data.top?.name,
    topDebtorDebt: data.top?.debt,
    lines: data.lines,
  };
  const facts: CopilotFacts = {
    intent: "debt",
    period: range?.period,
    scopeDescription: range
      ? `công nợ các đơn có ngày chụp trong ${range.label}, đã loại đơn hủy/xóa/báo giá tạm, không cộng trùng hợp đồng cha–con`
      : "nợ tồn toàn hệ thống tính đến hiện tại, đã loại đơn hủy/xóa/báo giá tạm, không cộng trùng hợp đồng cha–con",
    facts: factData,
  };
  const follow = buildFollowUp("debt", factData);
  if (range) {
    if (!data.orderCount) {
      return {
        text: `Các đơn phát sinh trong ${range.label} đã thu đủ hết rồi anh. Phạm vi em tính là đơn có ngày chụp trong ${range.label} — nợ tồn các tháng trước (nếu có) không nằm trong số này, anh hỏi "khách nào đang nợ tiền" là em xem toàn bộ.`,
        facts,
      };
    }
    return {
      text: `${capitalize(range.label)} còn ${data.orderCount} đơn chưa thu đủ, tiền còn có thể thu về là ${formatVND(data.totalDebt)} từ ${data.count} khách:\n\n${data.lines.join("\n")}\n\nPhạm vi em tính: đơn phát sinh trong ${range.label}, đã loại đơn hủy/xóa/báo giá tạm và không cộng trùng hợp đồng cha–con.${follow ? ` ${follow}` : ""}`,
      facts,
    };
  }
  if (!data.count) {
    return { text: "Hiện không có khách nào còn nợ — mọi đơn trong hệ thống đã thu đủ anh nha.", facts };
  }
  return {
    text: `Hiện có ${data.count} khách còn nợ với ${data.orderCount} đơn chưa thu đủ, tổng cộng ${formatVND(data.totalDebt)}:\n\n${data.lines.join("\n")}\n\nSố này là nợ tồn toàn hệ thống tính đến hiện tại, không giới hạn tháng.${follow ? ` ${follow}` : ""}`,
    facts,
  };
}

async function answerRevenue(q: string): Promise<BuiltAnswer> {
  if (/(ban tot|ban chay|nhieu don|goi.*ban)/.test(q)) {
    const perf = await getServicePerformance();
    const facts: CopilotFacts = {
      intent: "revenue",
      scopeDescription: `số đơn và doanh thu theo gói dịch vụ trong ${perf.label}, tính theo ngày chụp của đơn hợp lệ`,
      facts: {
        topPackage: perf.top?.package_name ?? null,
        topBookingCount: perf.top ? Number(perf.top.booking_count) : 0,
        topRevenue: perf.top ? Number(perf.top.revenue) : 0,
        lines: perf.lines.slice(0, 5),
      },
    };
    if (!perf.top) {
      return {
        text: `${capitalize(perf.label)} chưa có đơn chụp nào nên em chưa xếp hạng gói được. Nếu studio đã nhận booking ngoài hệ thống thì anh kiểm tra lại module Đơn hàng nha.`,
        facts,
      };
    }
    return {
      text: `Gói bán tốt nhất ${perf.label} là ${perf.top.package_name} với ${perf.top.booking_count} đơn, mang về ${formatVND(Number(perf.top.revenue))}. Top gói trong tháng:\n\n${perf.lines.slice(0, 5).join("\n")}`,
      facts,
    };
  }
  const m = monthRange();
  const data = await getRevenueSummary();
  const factData: Record<string, unknown> = {
    collectedAmount: data.revenue,
    bookingCount: data.orderCount,
    paymentCount: data.paymentCount,
  };
  const facts: CopilotFacts = {
    intent: "revenue",
    period: m.period,
    scopeDescription: `phiếu thu thực tế trong ${data.label}, đã loại phiếu hủy`,
    facts: factData,
  };
  if (data.paymentCount === 0 && data.revenue === 0) {
    return {
      text: `${capitalize(data.label)} hệ thống chưa ghi nhận phiếu thu nào. Nếu studio có thu tiền ngoài app thì anh cần ghi nhận vào module Thanh toán để số liệu khớp thực tế.`,
      facts,
    };
  }
  const follow = buildFollowUp("revenue", factData);
  return {
    text: `${capitalize(data.label)} studio đã thu thực tế ${formatVND(data.revenue)}, ghi nhận qua ${data.paymentCount} phiếu thu. Trong tháng có ${data.orderCount} đơn chụp.${follow ? `\n\n${follow}` : ""}`,
    facts,
  };
}

/**
 * Tài chính thực tế = BUSINESS ENGINE `bizMonthlyOverview` (bọc getSimpleFinance —
 * CÙNG số màn "Tổng quan tài chính"): đã thu − (chi trực tiếp + chi phí cố định).
 * Copilot chỉ ĐỌC Insight; status + caveats (phủ sổ cast, hoa hồng sale) được nói
 * ra đầy đủ để chủ không hiểu nhầm lợi nhuận này là con số cuối cùng (chưa trừ cast).
 */
async function answerFinance(): Promise<BuiltAnswer> {
  const m = monthRange();
  const overview = await bizMonthlyOverview(m.period);
  const scope =
    "tài chính thực tế tháng này, cùng công thức màn Tổng quan tài chính: đã thu − (chi trực tiếp + chi phí cố định) = lợi nhuận; công nợ là nợ tồn toàn hệ thống";

  if (!overview.data) {
    // Thiếu nguồn Engine → nói thẳng, KHÔNG bịa số (quy tắc F của Business Engine).
    const facts: CopilotFacts = {
      intent: "finance",
      period: m.period,
      scopeDescription: scope,
      status: overview.status,
      caveats: overview.caveats,
      facts: {},
    };
    return {
      text: overview.caveats[0] ?? "Em chưa đọc được số liệu tài chính tháng này, anh thử lại sau ít phút nha.",
      facts,
    };
  }

  const d = overview.data;
  const from = d.window.from;
  const to = d.window.to;
  const facts: CopilotFacts = {
    intent: "finance",
    period: m.period,
    scopeDescription: scope,
    status: overview.status,
    caveats: overview.caveats,
    facts: {
      collectedAmount: d.collected,
      directExpense: d.spent.direct,
      fixedCostMonthly: d.spent.fixedMonthly,
      totalSpent: d.spent.total,
      realProfit: d.actualProfit,
      breakevenStatus: d.breakeven.status,
      breakevenDelta: d.breakeven.delta,
      customerDebt: d.systemDebt,
    },
  };
  const profitStr =
    d.actualProfit < 0 ? `âm ${formatVND(Math.abs(d.actualProfit))}` : `dương ${formatVND(d.actualProfit)}`;
  const breakevenLine =
    d.breakeven.status === "over"
      ? `Studio đã vượt điểm hòa vốn ${formatVND(d.breakeven.delta)}.`
      : `Studio chưa đạt hòa vốn — còn thiếu ${formatVND(d.breakeven.delta)}.`;
  const debtNote =
    d.systemDebt > 0
      ? `\n\nNgoài ra khách còn nợ ${formatVND(d.systemDebt)} chưa thu về — anh hỏi "khách nào đang nợ tiền" là em liệt kê chi tiết.`
      : "";
  // Status/caveats phải được NÓI ĐẦY ĐỦ (lợi nhuận này CHƯA trừ cast → có thể cao hơn thực tế).
  const caveatNote = overview.caveats.length ? `\n\nLưu ý: ${overview.caveats.join(" ")}` : "";
  return {
    text: `Từ ${formatDate(from)} đến ${formatDate(to)} studio đã thu ${formatVND(d.collected)}, đã chi ${formatVND(d.spent.total)} (chi trực tiếp ${formatVND(d.spent.direct)} + chi phí cố định ${formatVND(d.spent.fixedMonthly)}). Lợi nhuận thực tế đang ${profitStr}. ${breakevenLine}${debtNote}${caveatNote}`,
    facts,
  };
}

async function answerPostProduction(q: string): Promise<BuiltAnswer> {
  if (/(tre|qua han|overdue)/.test(q)) {
    const overdue = await getOverduePostProductionJobs();
    const factData: Record<string, unknown> = { overdueCount: overdue.count, lines: overdue.lines };
    const facts: CopilotFacts = {
      intent: "post_production",
      scopeDescription: "job hậu kỳ đang mở và đã quá hạn khách hoặc hạn hệ thống, tính đến hôm nay",
      facts: factData,
    };
    if (!overdue.count) {
      return { text: "Không có đơn nào trễ hậu kỳ, tất cả job đang trong hạn anh nha.", facts };
    }
    const follow = buildFollowUp("post_production", factData);
    return {
      text: `Đang có ${overdue.count} đơn trễ hậu kỳ:\n\n${overdue.lines.join("\n")}${follow ? `\n\n${follow}` : ""}`,
      facts,
    };
  }
  const workload = await getStaffWorkload();
  const factData: Record<string, unknown> = {
    staffCount: workload.count,
    topStaffName: workload.top?.staff_name ?? null,
    topJobCount: workload.top ? Number(workload.top.job_count) : 0,
    lines: workload.lines,
  };
  const facts: CopilotFacts = {
    intent: "post_production",
    scopeDescription: "job hậu kỳ đang mở, gom theo nhân sự được giao",
    facts: factData,
  };
  if (!workload.count) {
    return { text: "Hiện không có việc hậu kỳ nào đang tồn — tất cả đã xong hoặc chưa có job anh nha.", facts };
  }
  const follow = buildFollowUp("staff", factData);
  return {
    text: `Hậu kỳ đang có ${workload.count} nhân sự cầm việc:\n\n${workload.lines.join("\n")}${follow ? `\n\n${follow}` : ""}`,
    facts,
  };
}

async function answerStaff(q: string): Promise<BuiltAnswer> {
  if (/(di tre|tre gio|muon|cham cong)/.test(q)) {
    const att = await getAttendanceSummary();
    const facts: CopilotFacts = {
      intent: "staff",
      scopeDescription: `chấm công ${att.label}, mốc đi trễ là check-in sau 08:10 giờ VN`,
      facts: { totalCheckins: att.totalCheckins, lateLines: att.lateLines, hasData: att.hasData },
    };
    if (!att.hasData) {
      return {
        text: `${capitalize(att.label)} chưa có dữ liệu check-in nào. Nhân viên cần chấm công qua app thì em mới có số liệu cho anh xem.`,
        facts,
      };
    }
    if (!att.lateLines.length) {
      return {
        text: `${capitalize(att.label)} có ${att.totalCheckins} lần check-in và không ai đi trễ sau 08:10 — chấm công đang ổn anh nha.`,
        facts,
      };
    }
    return {
      text: `Đi trễ ${att.label} (mốc 08:10) như sau:\n\n${att.lateLines.join("\n")}\n\nNgười đầu danh sách đang trễ nhiều nhất — nếu còn lặp lại thì anh nên trao đổi trực tiếp.`,
      facts,
    };
  }
  const workload = await getStaffWorkload();
  const factData: Record<string, unknown> = {
    staffCount: workload.count,
    topStaffName: workload.top?.staff_name ?? null,
    topJobCount: workload.top ? Number(workload.top.job_count) : 0,
    lines: workload.lines,
  };
  const facts: CopilotFacts = {
    intent: "staff",
    scopeDescription: "việc hậu kỳ đang mở, gom theo nhân sự được giao",
    facts: factData,
  };
  if (!workload.count) {
    return { text: "Hiện không có việc hậu kỳ nào đang giao anh nha. Lịch cast từng show anh xem ở module Nhân sự.", facts };
  }
  const follow = buildFollowUp("staff", factData);
  return {
    text: `Tải hậu kỳ theo nhân sự hiện tại:\n\n${workload.lines.join("\n")}${follow ? `\n\n${follow}` : ""}`,
    facts,
  };
}

async function answerPricing(): Promise<BuiltAnswer> {
  const pkgs = await getPricingPackages();
  const facts: CopilotFacts = {
    intent: "pricing",
    scopeDescription: "bảng giá gói dịch vụ đang mở bán (chưa xóa)",
    facts: { count: pkgs.count, lines: pkgs.lines },
  };
  if (!pkgs.count) {
    return { text: "Bảng giá chưa có gói dịch vụ nào — anh cần cập nhật trong CMS Bảng giá.", facts };
  }
  return {
    text: `Bảng giá đang có ${pkgs.count} gói:\n\n${pkgs.lines.join("\n")}\n\nChi tiết mô tả từng gói anh xem thêm ở module Bảng giá.`,
    facts,
  };
}

async function answerCustomer(q: string): Promise<BuiltAnswer> {
  const found = await searchCustomer(q);
  if (found) return found;
  return {
    text: `Anh gửi em số điện thoại của khách để em tra, hoặc hỏi "khách nào đang nợ tiền" để xem danh sách công nợ.`,
  };
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

async function answerOverview(q: string): Promise<BuiltAnswer> {
  const scope = detectOverviewScope(q) ?? "general";
  const isToday = scope === "today";
  const mLabel = monthRange().label;
  const label = isToday
    ? `hôm nay ${formatDate(todayStr())}`
    : scope === "month"
      ? mLabel
      : `studio ${formatDate(todayStr())}`;

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

  const partialMissing = !rev || !debt || !today || !month || !overdue || !workload || !att;

  const summaryLines = [
    rev
      ? `• Doanh thu ${rev.label}: ${formatVND(rev.revenue)} (${rev.orderCount} đơn chụp)`
      : `• Doanh thu ${mLabel}: ${NO_DATA}`,
    `• Lịch ${isToday ? "hôm nay" : scope === "month" ? mLabel : "hôm nay"}: ${scheduleNote}`,
    debt
      ? `• Công nợ: ${debt.count ? `${debt.count} khách — ${formatVND(debt.totalDebt)}` : "không có"}`
      : `• Công nợ: ${NO_DATA}`,
    workload && overdue
      ? `• Hậu kỳ: ${ptsActive} việc đang làm${overdue.count ? `, ${overdue.count} đơn trễ` : ""}`
      : `• Hậu kỳ: ${NO_DATA}`,
    workload
      ? workload.top
        ? `• Nhân sự hậu kỳ: ${workload.top.staff_name} nhiều việc nhất (${workload.top.job_count} job)`
        : `• Nhân sự hậu kỳ: không có việc tồn`
      : `• Nhân sự hậu kỳ: ${NO_DATA}`,
    att
      ? att.lateLines.length
        ? `• Chấm công ${att.label}: ${att.lateLines[0].replace("• ", "")}`
        : att.hasData
          ? `• Chấm công ${att.label}: không ai đi trễ sau 08:10`
          : `• Chấm công: chưa có dữ liệu check-in`
      : `• Chấm công: ${NO_DATA}`,
  ];

  const issues: string[] = [];
  if (overdue && overdue.count > 0) issues.push(`• ${overdue.count} đơn hậu kỳ trễ — ${overdue.lines.slice(0, 2).map(l => l.replace("• ", "")).join("; ")}`);
  if (debt && debt.count > 0) issues.push(`• Công nợ ${formatVND(debt.totalDebt)} — ${debt.lines.slice(0, 2).map(l => l.replace("• ", "")).join("; ")}`);
  if (isToday && today && today.count >= 3) issues.push(`• Hôm nay ${today.count} show — cần sắp nhân sự và thiết bị sớm`);
  if (workload?.top && Number(workload.top.job_count) >= 5) issues.push(`• ${workload.top.staff_name} đang ${workload.top.job_count} việc hậu kỳ — nên cân tải`);
  if (att && att.lateLines.length >= 2) issues.push(`• Nhiều người đi trễ tháng này — anh xem thêm module Chấm công`);
  if (partialMissing) {
    issues.push("• Một phần dữ liệu tạm không đọc được — số liệu phía trên có thể thiếu");
  }
  if (!issues.length) issues.push("• Không có vấn đề cấp bách — vận hành đang ổn định");

  const priorities: string[] = [];
  if (overdue && overdue.count > 0) priorities.push(`1. Xử lý ${overdue.count} đơn trễ hậu kỳ trước`);
  if (debt && debt.count > 0) priorities.push(`${priorities.length + 1}. Nhắc thu công nợ — ưu tiên khách đầu danh sách`);
  if (isToday && today && today.count > 0) priorities.push(`${priorities.length + 1}. Chuẩn bị ${today.count} show hôm nay`);
  else if (!isToday && month && month.count > 0) priorities.push(`${priorities.length + 1}. Rà soát lịch ${month.label} (${month.count} buổi)`);
  if (workload?.top && Number(workload.top.job_count) >= 4) priorities.push(`${priorities.length + 1}. Hỗ trợ ${workload.top.staff_name} giảm tải hậu kỳ`);
  if (!priorities.length) priorities.push("1. Chăm sóc khách mới và cập nhật tiến độ đơn đang làm");

  const facts: CopilotFacts = {
    intent: "overview",
    period: isToday ? todayStr() : monthRange().period,
    scopeDescription: `tổng quan vận hành ${label}, gom từ doanh thu/lịch/công nợ/hậu kỳ/chấm công`,
    facts: {
      revenue: rev ? { label: rev.label, collectedAmount: rev.revenue, bookingCount: rev.orderCount } : null,
      todayShowCount: today?.count ?? null,
      monthShowCount: month?.count ?? null,
      debt: debt ? { customerCount: debt.count, totalDebt: debt.totalDebt } : null,
      overdueJobCount: overdue?.count ?? null,
      workloadTop: workload?.top ? { name: workload.top.staff_name, jobCount: Number(workload.top.job_count) } : null,
      lateLines: att?.lateLines ?? null,
      partialDataMissing: partialMissing,
    },
  };

  return {
    text: `Tổng quan ${label} đây anh:

Tóm tắt
${summaryLines.join("\n")}

Cần chú ý
${issues.join("\n")}

Nên ưu tiên
${priorities.join("\n")}`,
    facts,
  };
}

async function answerAnalysis(): Promise<BuiltAnswer> {
  const [today, debt, overdue, workload, perf] = await Promise.all([
    safeTool("todaySchedule", getTodayBookings()),
    safeTool("debt", getUnpaidCustomers(3)),
    safeTool("overduePts", getOverduePostProductionJobs(5)),
    safeTool("workload", getStaffWorkload(3)),
    safeTool("servicePerf", getServicePerformance()),
  ]);

  const priorities: string[] = [];
  if (overdue && overdue.count > 0) priorities.push(`${priorities.length + 1}. Hậu kỳ trễ (${overdue.count} đơn) — xử lý ngay: ${overdue.lines.slice(0, 2).join("; ")}`);
  if (debt && debt.count > 0) priorities.push(`${priorities.length + 1}. Thu công nợ — tổng ${formatVND(debt.totalDebt)}, ưu tiên: ${debt.lines.slice(0, 2).join("; ")}`);
  if (today && today.count > 0) priorities.push(`${priorities.length + 1}. Lịch hôm nay — ${today.count} show, chuẩn bị nhân sự và thiết bị`);
  if (workload?.top) priorities.push(`${priorities.length + 1}. Cân tải hậu kỳ — ${workload.top.staff_name} đang ${workload.top.job_count} việc`);
  if (perf?.top) priorities.push(`${priorities.length + 1}. Gói bán chạy — ${perf.top.package_name} (${perf.top.booking_count} đơn ${perf.label})`);

  const degraded = !today || !debt || !overdue || !workload || !perf
    ? "\n\nMột phần dữ liệu tạm không đọc được — danh sách có thể thiếu mục."
    : "";

  if (!priorities.length) {
    return { text: `Tuần này hệ thống ít việc cấp bách anh nha — anh có thể tập trung chăm sóc khách mới và cập nhật bảng giá.${degraded}` };
  }

  return {
    text: `Theo dữ liệu hiện tại, tuần này anh nên ưu tiên:\n\n${priorities.join("\n")}\n\nAnh muốn xem kỹ mục nào thì hỏi em thêm — lịch hôm nay, công nợ hay đơn trễ hậu kỳ đều được.${degraded}`,
  };
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
        return { answer: customerHit.text, fromData: true, intent: "customer", facts: customerHit.facts };
      }
      if (q.length >= 4) {
        const built = await answerOverview(q);
        return { answer: built.text, fromData: true, intent: "overview", facts: built.facts };
      }
      return { answer: unknownResponse(), fromData: false, intent };
    }

    let built: BuiltAnswer;
    switch (intent) {
      case "schedule":
        built = await answerSchedule(q);
        break;
      case "debt":
        built = await answerDebt(q);
        break;
      case "revenue":
        built = await answerRevenue(q);
        break;
      case "finance":
        built = await answerFinance();
        break;
      case "post_production":
        built = await answerPostProduction(q);
        break;
      case "staff":
        built = await answerStaff(q);
        break;
      case "customer":
        built = await answerCustomer(q);
        break;
      case "pricing":
        built = await answerPricing();
        break;
      case "overview":
        built = await answerOverview(q);
        break;
      case "analysis":
        built = await answerAnalysis();
        break;
      default:
        return { answer: unknownResponse(), fromData: false, intent: "unknown" };
    }

    return { answer: built.text, fromData: true, intent, facts: built.facts };
  } catch (err) {
    console.error("answerStudioCopilot error:", err);
    return {
      answer: "Em chưa đọc được dữ liệu studio lúc này, anh thử lại sau ít phút nha. Nếu vẫn lỗi thì nhờ kỹ thuật kiểm tra kết nối giúp em.",
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