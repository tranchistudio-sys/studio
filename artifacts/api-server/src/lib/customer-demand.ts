/**
 * customer-demand.ts — NHÓM NHU CẦU của khách ("Cưới" / "Beauty") tính HOÀN TOÀN
 * TỰ ĐỘNG từ đơn hàng, KHÔNG lưu cột, KHÔNG có ô nhập tay.
 *
 * Vì sao tính động (không denormalize thành 1 cột customers.demand):
 *  - Yêu cầu chủ 18/07: nhóm khách suy ra từ gói dịch vụ đã đặt, tạo/xóa/đổi đơn
 *    là nhóm phải đúng NGAY — tính lúc đọc thì không thể lệch, không cần job đồng bộ.
 *  - Không đẻ ra nguồn chân lý thứ hai có thể lệch với đơn hàng.
 *
 * Nguồn tín hiệu DUY NHẤT đáng tin: booking.service_package_id → service_packages.group_id
 * → service_groups.name → map theo từ khóa. (bookings.service_category luôn = 'wedding'
 * mặc định nên VÔ DỤNG để phân loại; package_type chỉ là nhãn "Dịch vụ 1 + Dịch vụ 2".)
 *
 * "Đơn hợp lệ" = revenueCountableSql (đồng bộ công nợ/doanh thu: loại thùng rác/hủy/
 * báo giá tạm/đơn cha tổng/con mồ côi) + loại thêm 'draft' (lịch tạm) theo yêu cầu 7.
 * Đơn KHÔNG có gói (service_package_id NULL) hoặc thuộc nhóm trung tính (In ảnh, Makeup
 * lẻ, Cho thuê trang phục lẻ, Combo có/không makeup không ghi "cưới") → KHÔNG gắn badge
 * (không đoán bừa; khách chỉ hiện badge khi đơn nói rõ nhu cầu).
 */
import { pool } from "@workspace/db";
import { revenueCountableSql } from "./booking-money";
import { normalizeSearchText } from "./search-normalize";

export type DemandCategory = "wedding" | "beauty";

/** Từ khóa (đã bỏ dấu) trên TÊN NHÓM dịch vụ → nhu cầu Cưới. */
const WEDDING_KEYWORDS = ["cuoi", "cong", "album", "tiec", "quay phim"] as const;
/** Từ khóa (đã bỏ dấu) trên TÊN NHÓM dịch vụ → nhu cầu Beauty. */
const BEAUTY_KEYWORDS = ["beauty", "thoi trang", "gia dinh", "bau", "profile", "nang tho"] as const;

/**
 * Phân loại MỘT tên nhóm dịch vụ thành các nhu cầu. Khớp theo TỪ (word-boundary sau
 * khi bỏ dấu + thay ký tự không phải chữ/số bằng khoảng trắng) để "bau" không dính
 * nhầm "album", "cong" không dính nhầm từ khác. Một nhóm có thể ra 0, 1 hoặc 2 nhu cầu.
 */
export function classifyServiceGroupDemand(groupName: string | null | undefined): DemandCategory[] {
  const norm = normalizeSearchText(groupName).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const padded = ` ${norm} `;
  const has = (kw: string) => padded.includes(` ${kw} `);
  const out: DemandCategory[] = [];
  if (WEDDING_KEYWORDS.some(has)) out.push("wedding");
  if (BEAUTY_KEYWORDS.some(has)) out.push("beauty");
  return out;
}

/** Gộp tập nhu cầu theo thứ tự ổn định [wedding, beauty]. */
function toStableArray(set: Set<DemandCategory>): DemandCategory[] {
  const out: DemandCategory[] = [];
  if (set.has("wedding")) out.push("wedding");
  if (set.has("beauty")) out.push("beauty");
  return out;
}

/**
 * Nhu cầu tự động của khách, tính từ đơn hợp lệ.
 * @param customerId nếu truyền → chỉ tính cho 1 khách (màn hồ sơ); bỏ trống → toàn bộ.
 * @returns Map customerId → mảng nhu cầu (rỗng nếu khách không có badge — không đưa vào map).
 */
export async function computeCustomerDemand(customerId?: number): Promise<Map<number, DemandCategory[]>> {
  const params: unknown[] = [];
  let extra = "";
  if (customerId != null) {
    params.push(customerId);
    extra = ` AND b.customer_id = $${params.length}`;
  }
  // INNER JOIN gói: chỉ đơn CÓ gói tham gia; đơn không gói tự bị loại (đúng ý đồ).
  const sql = `
    SELECT b.customer_id AS cid, g.name AS group_name
    FROM bookings b
    JOIN service_packages p ON p.id = b.service_package_id
    JOIN service_groups g ON g.id = p.group_id
    WHERE ${revenueCountableSql("b")}
      AND COALESCE(b.status, '') <> 'draft'
      AND b.customer_id IS NOT NULL${extra}`;
  const r = await pool.query(sql, params);

  const acc = new Map<number, Set<DemandCategory>>();
  for (const row of r.rows as Array<{ cid: number; group_name: string | null }>) {
    const cats = classifyServiceGroupDemand(row.group_name);
    if (cats.length === 0) continue;
    const cid = Number(row.cid);
    let set = acc.get(cid);
    if (!set) { set = new Set(); acc.set(cid, set); }
    for (const c of cats) set.add(c);
  }

  const out = new Map<number, DemandCategory[]>();
  for (const [cid, set] of acc) out.set(cid, toStableArray(set));
  return out;
}
