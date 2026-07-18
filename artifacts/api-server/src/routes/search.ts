import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  normalizeSearchText,
  normalizePhone,
  tokenize,
  scoreSearchResult,
} from "../lib/search-normalize";
import { getCallerRole } from "./auth";

/**
 * Global Search — ô "Tìm khách, đơn hàng…" ở header (SmartSearch.tsx gọi GET /api/search?q=).
 *
 * Chiến lược: SQL lấy TẬP ỨNG VIÊN rộng nhưng có chặn (bỏ dấu qua immutable_unaccent + token +
 * số hoá SĐT/mã đơn) để KHÔNG SÓT match; sau đó JS chấm điểm + xếp hạng (scoreSearchResult) rồi
 * cắt top N. Không cần extension/schema mới (immutable_unaccent đã có sẵn trong DB).
 *
 * Không đụng bảng nào ngoài đọc; không sửa logic tiền/công nợ (#65–69); trả totalAmount thô có sẵn.
 */
const router: IRouter = Router();

// Cap tập ứng viên (chấm điểm ở JS rất nhẹ). Đặt rộng để token phổ biến/nhiều SĐT trùng số không
// cắt mất match tốt-nhưng-cũ TRƯỚC khi xếp hạng (review #3). Studio-scale vài nghìn đơn ⇒ dư sức.
const CANDIDATE_LIMIT = 400;
const CUSTOMER_CANDIDATE_LIMIT = 200;

// Mã đơn HIỂN THỊ: order_code, nếu NULL/rỗng thì tổng hợp "DH{id 4 chữ số}" — GIỐNG chỗ khác trong
// app (dashboard.ts) — để đơn thiếu order_code vẫn tìm được bằng mã đang hiện (review #1).
const EFF_ORDER_CODE_SQL = "coalesce(nullif(b.order_code,''), 'DH' || lpad(b.id::text, 4, '0'))";
function displayOrderCode(orderCode: unknown, id: number): string {
  const oc = typeof orderCode === "string" ? orderCode : "";
  return oc || `DH${String(id).padStart(4, "0")}`;
}

router.get("/search", async (req, res) => {
  try {
    // Global Search trả PII khách (tên/SĐT/địa chỉ) + tiền đơn → BẮT auth trước khi
    // query. Mọi nhân sự đăng nhập đều dùng được (đúng role model hiện có).
    if (!(await getCallerRole(req.headers.authorization))) {
      res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
      return;
    }
    const qRaw = typeof req.query.q === "string" ? req.query.q : "";
    const q = qRaw.trim();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "8"), 10) || 8, 1), 20);

    if (normalizeSearchText(q).length < 2 && normalizePhone(q).length < 2) {
      return res.json({ bookings: [], customers: [] });
    }

    const tokens = tokenize(q);
    const qDigits = normalizePhone(q);

    // ── Query BOOKING (chạy song song với customers) ─────────────────────────
    const runBookings = async (): Promise<unknown[]> => {
      // blob = gộp các trường text để token match "ở bất kỳ đâu" (tên/mã/gói/địa điểm/ghi chú).
      const blob =
        `immutable_unaccent(coalesce(c.name,'')||' '||${EFF_ORDER_CODE_SQL}||' '||` +
        "coalesce(b.service_label,'')||' '||coalesce(b.package_type,'')||' '||" +
        "coalesce(b.location,'')||' '||coalesce(b.notes,''))";

      const p: string[] = [];
      const or: string[] = [];
      if (tokens.length > 0) {
        const conds = tokens.map((t) => { p.push(`%${t}%`); return `${blob} ILIKE $${p.length}`; });
        or.push(`(${conds.join(" AND ")})`);
      }
      if (qDigits.length >= 3) {
        p.push(`%${qDigits}%`);
        or.push(`(regexp_replace(coalesce(c.phone,''), '[^0-9]', '', 'g') ILIKE $${p.length})`);
      }
      if (qDigits.length >= 1) {
        p.push(`%${qDigits}%`);
        or.push(`(regexp_replace(${EFF_ORDER_CODE_SQL}, '[^0-9]', '', 'g') ILIKE $${p.length})`);
      }
      if (or.length === 0) return [];

      const r = await pool.query(
        `SELECT b.id, b.order_code, b.shoot_date, b.package_type, b.service_label,
                b.location, b.notes, b.status, b.total_amount, b.customer_id,
                c.name AS customer_name, c.phone AS customer_phone
         FROM bookings b
         JOIN customers c ON b.customer_id = c.id
         WHERE b.deleted_at IS NULL AND b.status <> 'temp_quote' AND (${or.join(" OR ")})
         ORDER BY b.created_at DESC
         LIMIT ${CANDIDATE_LIMIT}`,
        p,
      );
      return r.rows
        .map((row: Record<string, unknown>) => {
          const orderCode = displayOrderCode(row.order_code, row.id as number);
          // location/notes CHỈ dùng để chấm điểm (khớp địa điểm/ghi chú), KHÔNG trả ra payload.
          const score = scoreSearchResult(q, {
            customerName: row.customer_name as string,
            customerPhone: row.customer_phone as string,
            orderCode,
            serviceLabel: row.service_label as string,
            packageType: row.package_type as string,
            location: row.location as string,
            notes: row.notes as string,
          });
          return {
            score,
            item: {
              id: row.id as number,
              orderCode,
              customerName: (row.customer_name as string) ?? "",
              customerPhone: (row.customer_phone as string) ?? "",
              shootDate: row.shoot_date as string,
              packageType: (row.package_type as string) ?? "",
              serviceLabel: (row.service_label as string) ?? null,
              status: (row.status as string) ?? "",
              totalAmount: Number(row.total_amount ?? 0),
              customerId: row.customer_id as number,
            },
          };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.item);
    };

    // ── Query KHÁCH HÀNG (kể cả khách chưa có đơn) ──────────────────────────
    const runCustomers = async (): Promise<unknown[]> => {
      const p: string[] = [];
      const or: string[] = [];
      if (tokens.length > 0) {
        const conds = tokens.map((t) => { p.push(`%${t}%`); return `immutable_unaccent(coalesce(name,'')) ILIKE $${p.length}`; });
        or.push(`(${conds.join(" AND ")})`);
      }
      if (qDigits.length >= 3) {
        p.push(`%${qDigits}%`);
        or.push(`(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') ILIKE $${p.length})`);
      }
      if (or.length === 0) return [];

      const r = await pool.query(
        `SELECT id, name, phone, address FROM customers
         WHERE ${or.join(" OR ")}
         ORDER BY created_at DESC
         LIMIT ${CUSTOMER_CANDIDATE_LIMIT}`,
        p,
      );
      return r.rows
        .map((row: Record<string, unknown>) => {
          const item = {
            id: row.id as number,
            name: (row.name as string) ?? "",
            phone: (row.phone as string) ?? "",
            address: (row.address as string) ?? null,
          };
          const score = scoreSearchResult(q, { customerName: item.name, customerPhone: item.phone });
          return { score, item };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((x) => x.item);
    };

    const [bookings, customers] = await Promise.all([runBookings(), runCustomers()]);
    res.json({ bookings, customers });
  } catch (err) {
    console.error("GET /search error:", err);
    res.status(500).json({ error: "Lỗi tìm kiếm" });
  }
});

export default router;
