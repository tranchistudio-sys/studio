import { pool } from "@workspace/db";

/**
 * ĐỌC LỊCH cho Claude Sale — CHỈ ĐỌC (read-only).
 *
 * AN TOÀN TUYỆT ĐỐI: file này CHỈ chạy câu SELECT trên bảng bookings để dựng
 * một bản tóm tắt lịch sắp tới cho Claude phán đoán còn trống / đụng giờ.
 *   - KHÔNG INSERT/UPDATE/DELETE bất kỳ thứ gì.
 *   - KHÔNG đọc thông tin khách (customer PII) — chỉ giờ + loại dịch vụ + trạng thái.
 *   - Việc tạo/sửa/hủy/giữ lịch KHÔNG bao giờ do AI làm; AI chỉ đề xuất & báo nhân viên.
 */

const WEEKDAY_VI: Record<number, string> = {
  1: "Thứ 2", 2: "Thứ 3", 3: "Thứ 4", 4: "Thứ 5", 5: "Thứ 6", 6: "Thứ 7", 7: "Chủ nhật",
};

type ScheduleRow = {
  shoot_date: string;
  isodow: number;
  shoot_time: string | null;
  service_category: string | null;
  package_type: string | null;
  service_label: string | null;
  status: string | null;
};

let cache: { text: string; days: number; at: number } | null = null;
const TTL_MS = 3 * 60 * 1000;

function fmtDate(d: string): string {
  // d dạng YYYY-MM-DD → DD/MM
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[3]}/${m[2]}` : d;
}

/**
 * Tóm tắt lịch sắp tới (windowDays ngày) cho Claude đọc. Trả "" nếu lỗi/không có.
 * KHÔNG bao giờ throw.
 */
export async function getScheduleContext(windowDays = 21): Promise<string> {
  const days = Math.min(60, Math.max(1, Math.round(windowDays)));
  if (cache && cache.days === days && Date.now() - cache.at < TTL_MS) return cache.text;
  try {
    const res = await pool.query(
      `SELECT shoot_date::text AS shoot_date,
              EXTRACT(ISODOW FROM shoot_date)::int AS isodow,
              shoot_time, service_category, package_type, service_label, status
         FROM bookings
        WHERE shoot_date >= CURRENT_DATE
          AND shoot_date < CURRENT_DATE + ($1::int * INTERVAL '1 day')
          AND COALESCE(LOWER(status), '') NOT IN ('canceled','cancelled','void','voided','rejected')
          AND COALESCE(is_parent_contract, false) = false
        ORDER BY shoot_date, shoot_time NULLS LAST`,
      [days],
    );
    const rows = res.rows as ScheduleRow[];
    if (rows.length === 0) {
      const text = `LỊCH SẮP TỚI (${days} ngày): hiện CHƯA có buổi chụp nào được đặt trong dữ liệu. Vẫn áp dụng quy tắc cuối tuần & escalation khi cần.`;
      cache = { text, days, at: Date.now() };
      return text;
    }

    const byDate = new Map<string, ScheduleRow[]>();
    for (const r of rows) {
      if (!byDate.has(r.shoot_date)) byDate.set(r.shoot_date, []);
      byDate.get(r.shoot_date)!.push(r);
    }

    const lines: string[] = [];
    for (const [date, list] of byDate) {
      const dow = list[0].isodow;
      const weekendTag = dow === 6 || dow === 7 ? " ⚠cuối tuần" : "";
      const shows = list
        .map((r) => {
          const time = (r.shoot_time ?? "").trim() || "chưa rõ giờ";
          const kind = (r.service_label || r.package_type || r.service_category || "buổi chụp").toString().trim();
          return `${time} (${kind})`;
        })
        .join("; ");
      lines.push(`${fmtDate(date)} ${WEEKDAY_VI[dow] ?? ""}${weekendTag}: ${list.length} buổi — ${shows}`);
    }

    const text = `LỊCH SẮP TỚI (${days} ngày, đã có buổi chụp — dùng để phán đoán còn trống/đụng giờ, KHÔNG phải để tự xác nhận):
${lines.join("\n")}
(Ngày không xuất hiện ở trên = chưa có buổi nào trong dữ liệu. Cuối tuần luôn phải kiểm tra kỹ, không khẳng định chắc.)`;
    cache = { text, days, at: Date.now() };
    return text;
  } catch (err) {
    console.error("[ClaudeSale] getScheduleContext lỗi — bỏ qua:", String(err).slice(0, 200));
    return "";
  }
}

export function clearScheduleCache(): void {
  cache = null;
}
