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

// Cap tập ứng viên (chấm điểm ở JS rất nhẹ). Mỗi row là MỘT root booking/family,
// nên multi-service không tạo duplicate trong kết quả.
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
      // blob = gộp customer + root/child code + contract code + tên dịch vụ.
      const blob =
        `immutable_unaccent(coalesce(c.name,'')||' '||coalesce(f.root_order_code,'')||' '||` +
        "coalesce(f.child_codes,'')||' '||coalesce(f.contract_codes,'')||' '||" +
        "coalesce(f.service_names,'')||' '||coalesce(f.location,'')||' '||coalesce(f.notes,''))";

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
        or.push(`(regexp_replace(coalesce(f.root_order_code,'')||' '||coalesce(f.child_codes,'')||' '||coalesce(f.contract_codes,''), '[^0-9 ]', '', 'g') ILIKE $${p.length})`);
      }
      if (or.length === 0) return [];

      const r = await pool.query(
        `WITH family_rows AS (
           SELECT root.id, ${EFF_ORDER_CODE_SQL.replaceAll("b.", "root.")} AS root_order_code,
                  root.shoot_date, root.package_type, root.service_label, root.location,
                  root.notes, root.status, root.total_amount, root.customer_id, root.created_at,
                  string_agg(DISTINCT coalesce(nullif(ch.order_code,''), 'DH' || lpad(ch.id::text, 4, '0')), ' ') FILTER (WHERE ch.id IS NOT NULL) AS child_codes,
                  string_agg(DISTINCT trim(coalesce(ch.service_label,'') || ' ' || coalesce(ch.package_type,'')), ' ') FILTER (WHERE ch.id IS NOT NULL) AS service_names,
                  count(DISTINCT ch.id)::int AS service_count
           FROM bookings root
           LEFT JOIN bookings ch ON ch.parent_id = root.id AND ch.deleted_at IS NULL AND ch.status <> 'cancelled'
           WHERE root.parent_id IS NULL AND root.deleted_at IS NULL AND root.status <> 'temp_quote'
           GROUP BY root.id
         ), f AS (
           SELECT fr.*, ca.contract_codes, ca.contracts
           FROM family_rows fr
           LEFT JOIN LATERAL (
             SELECT string_agg(DISTINCT ct.contract_code, ' ') AS contract_codes,
                    json_agg(json_build_object('id', ct.id, 'code', ct.contract_code) ORDER BY ct.created_at DESC) AS contracts
             FROM contracts ct
             JOIN bookings cb ON cb.id = ct.booking_id
             WHERE coalesce(cb.parent_id, cb.id) = fr.id
           ) ca ON true
         )
         SELECT f.*, c.name AS customer_name, c.phone AS customer_phone
         FROM f JOIN customers c ON f.customer_id = c.id
         WHERE (${or.join(" OR ")})
         ORDER BY f.created_at DESC
         LIMIT ${CANDIDATE_LIMIT}`,
        p,
      );
      return r.rows
        .map((row: Record<string, unknown>) => {
          const orderCode = displayOrderCode(row.root_order_code, row.id as number);
          const contracts = Array.isArray(row.contracts)
            ? row.contracts as Array<{ id?: number; code?: string }>
            : [];
          const normalizedQueryCode = normalizeSearchText(normalizeSearchText(q).replace(/\s+/g, ""));
          const matchedContract = contracts.find((ct) =>
            normalizeSearchText(ct.code).replace(/\s+/g, "").includes(normalizedQueryCode),
          ) ?? contracts[0];
          // location/notes CHỈ dùng để chấm điểm (khớp địa điểm/ghi chú), KHÔNG trả ra payload.
          const score = scoreSearchResult(q, {
            customerName: row.customer_name as string,
            customerPhone: row.customer_phone as string,
            orderCode,
            childOrderCodes: row.child_codes as string,
            contractCodes: row.contract_codes as string,
            serviceLabel: row.service_label as string,
            packageType: (row.service_names as string) || (row.package_type as string),
            location: row.location as string,
            notes: row.notes as string,
          });
          return {
            score,
            item: {
              id: row.id as number,
              orderCode,
              contractId: matchedContract?.id ?? null,
              contractCode: matchedContract?.code ?? null,
              customerName: (row.customer_name as string) ?? "",
              customerPhone: (row.customer_phone as string) ?? "",
              shootDate: row.shoot_date as string,
              packageType: (row.service_names as string) || (row.package_type as string) || "",
              serviceLabel: (row.service_label as string) ?? null,
              serviceCount: Number(row.service_count ?? 0) || 1,
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
