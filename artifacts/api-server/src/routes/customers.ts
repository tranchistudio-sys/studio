import { Router, type IRouter, type Request, type Response } from "express";
import { db, pool } from "@workspace/db";
import { customersTable, bookingsTable } from "@workspace/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";
import { verifyToken, getCallerRole } from "./auth";
import { withStartupDdlLock } from "../lib/startup-ddl";
import { customerVisibleBookings } from "../lib/customer-aggregate";
// GĐ1a (kiến trúc 14/07): tiền của khách đọc từ FINANCIAL ENGINE — route không tự tính.
import { engineCustomerFinance, engineAllCustomersFinance } from "../lib/finance/financial-engine";
import { bookingColumnsCompat } from "../lib/schema-compat";
// Nhóm nhu cầu (Cưới/Beauty) tính TỰ ĐỘNG từ đơn hợp lệ — không lưu cột, không nhập tay.
import { computeCustomerDemand } from "../lib/customer-demand";
// Xuất danh sách khách cho Meta Ads (logic thuần: chuẩn hoá SĐT, gộp trùng, CSV).
import {
  buildMetaExport, metaRowsToCsv, metaExportFilename, matchesDemandFilter,
  type MetaExportInput, type MetaAudience, type DemandFilter,
} from "../lib/meta-export";

const router: IRouter = Router();

interface PgConstraintError {
  code: string;
  constraint?: string;
}

function isPgConstraintError(err: unknown): err is PgConstraintError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\+\.]/g, "");
}

// SĐT placeholder ("0", "00", "000", "chưa có", rỗng...) KHÔNG phải số thật → coi như thiếu.
// Tránh dùng số rác để tra/merge khách (bug khách bị quay về khách cũ có phone "0").
function isMissingPhone(raw: unknown): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return true;
  if (["chưa có", "chua co", "không", "khong", "n/a", "na", "-", "/"].includes(s)) return true;
  const digits = s.replace(/\D/g, "");
  if (!digits) return true;          // không có chữ số
  if (/^0+$/.test(digits)) return true; // toàn số 0: "0", "00", "000"...
  return false;
}

/** Chuẩn hoá SĐT để LƯU: trả null nếu là placeholder/thiếu, ngược lại chuẩn hoá định dạng. */
function normalizePhoneOrNull(raw: unknown): string | null {
  if (isMissingPhone(raw)) return null;
  return normalizePhone(String(raw).trim());
}

const ALLOWED_RANKS = new Set(["new", "potential", "vip", "super_vip", "model", "needs_care"]);
function normalizeRank(rank: unknown): string {
  if (typeof rank !== "string" || !ALLOWED_RANKS.has(rank)) return "new";
  return rank;
}

async function ensureCustomerPhoneUnique() {
  await pool.query(`
    ALTER TABLE customers
    ADD CONSTRAINT customers_phone_unique UNIQUE (phone)
  `).catch((err: unknown) => {
    if (isPgConstraintError(err) && (err.code === "42710" || err.code === "42P07")) return;
    throw err;
  });
}
withStartupDdlLock(ensureCustomerPhoneUnique).catch(console.error);

/**
 * Xác thực caller là ADMIN. Trả true nếu hợp lệ; nếu không, GỬI LUÔN 401/403 và
 * trả false (caller chỉ cần `if (!(await ensureAdmin(...))) return;`).
 */
async function ensureAdmin(req: Request, res: Response, forbiddenMsg = "Không có quyền thực hiện thao tác này"): Promise<boolean> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) { res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" }); return false; }
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) { res.status(403).json({ error: forbiddenMsg }); return false; }
  return true;
}

/**
 * Yêu cầu caller ĐÃ ĐĂNG NHẬP hợp lệ (staff HOẶC admin, tài khoản còn hoạt động).
 * Dùng cho các endpoint TRẢ dữ liệu khách nhạy cảm (tên/SĐT/email/địa chỉ/ghi chú/
 * lịch sử tài chính): mọi nhân sự đăng nhập đều được XEM — đúng role model hiện có
 * (getCallerRole = admin|staff|null), KHÔNG thêm role mới. Ghi/xoá vẫn siết riêng.
 * Trả true nếu hợp lệ; nếu không, GỬI 401 và trả false.
 */
async function ensureAuth(req: Request, res: Response): Promise<boolean> {
  const role = await getCallerRole(req.headers.authorization);
  if (!role) { res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" }); return false; }
  return true;
}

function parseAudience(v: unknown): MetaAudience {
  return v === "with_orders" || v === "min_value" ? v : "all";
}

/**
 * Gộp khách + số liệu cho XUẤT META, áp ĐÚNG bộ lọc màn Khách hàng (search/rank/
 * source/demand). KHÔNG N+1: 1 query khách + engineAllCustomersFinance (value +
 * số đơn countable, khớp engine) + computeCustomerDemand (nhóm nhu cầu) — tất cả
 * gộp/song song. Trả input THUẦN cho buildMetaExport.
 */
async function collectMetaInputs(req: Request): Promise<MetaExportInput[]> {
  const search = (req.query.search as string | undefined)?.trim();
  const rank = req.query.rank as string | undefined;
  const source = req.query.source as string | undefined;
  const demand = ((req.query.demand as string | undefined) ?? "") as DemandFilter;

  const COLS = `id, name, phone, source, customer_rank`;
  let rows: Array<{ id: number; name: string; phone: string | null; source: string; customer_rank: string }>;
  if (search) {
    const pct = `%${search}%`;
    const normPct = `%${normalizePhone(search)}%`;
    const r = await pool.query(
      `SELECT ${COLS} FROM customers
       WHERE immutable_unaccent(name) ILIKE immutable_unaccent($1) OR phone ILIKE $2 OR facebook ILIKE $3
       ORDER BY created_at DESC`,
      [pct, normPct, pct],
    );
    rows = r.rows;
  } else {
    const r = await pool.query(`SELECT ${COLS} FROM customers ORDER BY created_at DESC`);
    rows = r.rows;
  }

  const [finance, demandMap] = await Promise.all([engineAllCustomersFinance(), computeCustomerDemand()]);

  const out: MetaExportInput[] = [];
  for (const c of rows) {
    if (rank && c.customer_rank !== rank) continue;
    if (source && c.source !== source) continue;
    const groups = demandMap.get(c.id) ?? [];
    if (!matchesDemandFilter(groups, demand)) continue;
    const f = finance.get(c.id);
    out.push({
      id: c.id, name: c.name, phone: c.phone,
      value: f?.totalOwed ?? 0, countableBookings: f?.totalBookings ?? 0,
      demandGroups: groups,
    });
  }
  return out;
}

// Preview cho popup xác nhận: tổng khách / SĐT hợp lệ / bị loại / trùng đã gộp / sẽ xuất.
router.get("/customers/meta-export/preview", async (req, res) => {
  try {
    if (!(await ensureAdmin(req, res, "Chỉ admin được xuất danh sách khách"))) return;
    const inputs = await collectMetaInputs(req);
    const { stats } = buildMetaExport(inputs, { audience: parseAudience(req.query.audience), minValue: Number(req.query.minValue) || 0 });
    res.json(stats);
  } catch (err) {
    console.error("GET /customers/meta-export/preview error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// Tải CSV chuẩn Meta (admin-only). Số chuẩn E.164, không trùng, chỉ 9 cột cho phép.
router.get("/customers/meta-export", async (req, res) => {
  try {
    if (!(await ensureAdmin(req, res, "Chỉ admin được xuất danh sách khách"))) return;
    const inputs = await collectMetaInputs(req);
    const { rows } = buildMetaExport(inputs, { audience: parseAudience(req.query.audience), minValue: Number(req.query.minValue) || 0 });
    const csv = metaRowsToCsv(rows);
    const filename = metaExportFilename(new Date());
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error("GET /customers/meta-export error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.get("/customers", async (req, res) => {
  try {
  if (!(await ensureAuth(req, res))) return;
  const search = req.query.search as string | undefined;
  let customers;
  if (search) {
    const pct = `%${search}%`;
    const normPct = `%${normalizePhone(search)}%`;
    const r = await pool.query(
      `SELECT * FROM customers
       WHERE immutable_unaccent(name) ILIKE immutable_unaccent($1)
          OR phone ILIKE $2
          OR facebook ILIKE $3
       ORDER BY created_at DESC`,
      [pct, normPct, pct]
    );
    customers = r.rows.map((row: Record<string, unknown>) => ({
      id: row.id, name: row.name, phone: row.phone, email: row.email,
      address: row.address, notes: row.notes, facebook: row.facebook,
      zalo: row.zalo, source: row.source, tags: row.tags, gender: row.gender,
      avatar: row.avatar, customCode: row.custom_code, customerRank: row.customer_rank,
      createdAt: row.created_at,
    }));
  } else {
    customers = await db.select().from(customersTable).orderBy(desc(customersTable.createdAt));
  }
  const rankFilter = req.query.rank as string | undefined;
  if (rankFilter) customers = customers.filter((c) => c.customerRank === rankFilter);

  // FINANCIAL ENGINE: một query gộp cho TOÀN BỘ khách (thay N+1 query per khách
  // + nạp toàn bộ payments vào RAM). Công thức chuẩn quy tắc ①: nợ sống per-booking
  // (net − paid_amount, clamp từng đơn) trên tập countable — khớp Dashboard/Copilot.
  // Nhóm nhu cầu (Cưới/Beauty) tính động cùng lúc (query độc lập, chạy song song).
  const [financeByCustomer, demandByCustomer] = await Promise.all([
    engineAllCustomersFinance(),
    computeCustomerDemand(),
  ]);
  const zero = { totalBookings: 0, totalOwed: 0, totalPaid: 0, totalDebt: 0, totalOverpaid: 0 };
  const result = customers.map((c) => ({
    ...c,
    ...(financeByCustomer.get(c.id as number) ?? zero),
    demandGroups: demandByCustomer.get(c.id as number) ?? [],
  }));

  res.json(result);
  } catch (err) {
    console.error("GET /customers error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.get("/customers/by-phone", async (req, res) => {
  try {
  if (!(await ensureAuth(req, res))) return;
  const rawPhone = (req.query.phone as string | undefined) ?? "";
  // Không tra theo SĐT placeholder ("0"...) — tránh merge nhầm khách.
  if (isMissingPhone(rawPhone)) return res.status(400).json({ error: "Số điện thoại không hợp lệ để tra cứu" });
  const phone = normalizePhone(rawPhone.trim());
  const r = await pool.query(
    `SELECT * FROM customers
     WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '') = $1
     LIMIT 1`,
    [phone]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy" });
  const row = r.rows[0] as Record<string, unknown>;
  res.json({
    id: row.id, name: row.name, phone: row.phone, email: row.email,
    address: row.address, notes: row.notes, facebook: row.facebook,
    zalo: row.zalo, source: row.source, tags: row.tags, gender: row.gender,
    avatar: row.avatar, customCode: row.custom_code, customerRank: row.customer_rank,
    createdAt: row.created_at,
  });
  } catch (err) {
    console.error("GET /customers/by-phone error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.post("/customers", async (req, res) => {
  const { name, phone, email, address, notes, facebook, zalo, source, tags, gender, avatar, customerRank } = req.body;
  const normalizedPhone = normalizePhoneOrNull(phone);
  try {
    if (!(await ensureAuth(req, res))) return;
    const count = await db.select().from(customersTable);
    const customCode = `KH${String(count.length + 1).padStart(3, "0")}`;
    const [customer] = await db
      .insert(customersTable)
      .values({ name, phone: normalizedPhone, email, address, notes, facebook, zalo, source: source || "other", tags: tags || [], gender, avatar, customCode, customerRank: normalizeRank(customerRank) })
      .returning();
    res.status(201).json({ ...customer, totalBookings: 0, totalPaid: 0, totalDebt: 0 });
  } catch (err: unknown) {
    if (isPgConstraintError(err) && err.code === "23505" && err.constraint?.includes("phone")) {
      const [existing] = await db.select().from(customersTable).where(eq(customersTable.phone, normalizedPhone));
      return res.status(409).json({
        conflict: true,
        existingCustomer: existing ?? null,
        error: `Số điện thoại "${phone}" đã tồn tại trong hệ thống.`,
      });
    }
    console.error("POST /customers error:", err);
    return res.status(500).json({ error: "Lỗi hệ thống khi tạo khách hàng" });
  }
});

router.get("/customers/:id", async (req, res) => {
  try {
  if (!(await ensureAuth(req, res))) return;
  const id = parseInt(req.params.id);
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  if (!customer) return res.status(404).json({ error: "Không tìm thấy khách hàng" });
  // Lấy TOÀN BỘ đơn của khách (kể cả đã xóa mềm) — cần đơn cha đã xóa để
  // customerVisibleBookings nhận diện con mồ côi cho phần LỊCH SỬ hiển thị.
  const bookings = await db.select(await bookingColumnsCompat()).from(bookingsTable).where(eq(bookingsTable.customerId, id));
  // FINANCIAL ENGINE: tiền của khách KHÔNG tính tại route (kiến trúc 14/07) —
  // quy tắc ① nợ sống per-booking, khớp Dashboard/Copilot (vd Trúc Ly 42.799.994).
  const { totalBookings, totalOwed, totalPaid, totalDebt, totalOverpaid } = await engineCustomerFinance(id);
  // Nhóm nhu cầu (Cưới/Beauty) tự động của riêng khách này.
  const demandGroups = (await computeCustomerDemand(id)).get(id) ?? [];
  // Lịch sử show: chỉ các đơn còn hiệu lực (đơn con + đơn lẻ) — bỏ đơn cha tổng (bản gộp
  // trùng của dịch vụ con), đơn trong thùng rác, đơn hủy, báo giá tạm. Dịch vụ con còn
  // hiệu lực vẫn giữ nguyên → không mất lịch sử; audit xóa/sửa vẫn nằm ở chi tiết đơn.
  const historyBookings = customerVisibleBookings(bookings);
  res.json({ ...customer, totalBookings, totalOwed, totalPaid, totalDebt, totalOverpaid, demandGroups, bookings: historyBookings });
  } catch (err) {
    console.error("GET /customers/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.get("/customers/:id/recent-bookings", async (req, res) => {
  try {
    if (!(await ensureAuth(req, res))) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
    const rows = await db
      .select({
        id: bookingsTable.id,
        shootDate: bookingsTable.shootDate,
        serviceLabel: bookingsTable.serviceLabel,
        serviceCategory: bookingsTable.serviceCategory,
        packageType: bookingsTable.packageType,
        status: bookingsTable.status,
        totalAmount: bookingsTable.totalAmount,
      })
      .from(bookingsTable)
      .where(and(eq(bookingsTable.customerId, id), isNull(bookingsTable.parentId), isNull(bookingsTable.deletedAt)))
      .orderBy(desc(bookingsTable.shootDate))
      .limit(2);
    res.json(rows);
  } catch (err) {
    console.error("GET /customers/:id/recent-bookings error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.put("/customers/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, phone, email, address, notes, facebook, zalo, source, tags, gender, avatar, customerRank } = req.body;
  const rawPhone = phone !== undefined ? String(phone) : undefined;
  try {
    if (!(await ensureAuth(req, res))) return;
    const setFields: Record<string, unknown> = {
      name, email, address, notes, facebook, zalo, source, gender, avatar,
    };
    // tags chỉ được ghi khi body THẬT SỰ gửi tags — PUT một phần ({name}, {phone},
    // {avatar}…) mà ép tags||[] sẽ xóa sạch tags của khách một cách lặng lẽ.
    if (tags !== undefined) setFields.tags = tags || [];
    if (customerRank !== undefined) setFields.customerRank = normalizeRank(customerRank);
    if (rawPhone !== undefined) {
      setFields.phone = normalizePhoneOrNull(rawPhone);
    }
    const [customer] = await db
      .update(customersTable)
      .set(setFields)
      .where(eq(customersTable.id, id))
      .returning();
    if (!customer) return res.status(404).json({ error: "Không tìm thấy khách hàng" });
    res.json({ ...customer, totalBookings: 0, totalPaid: 0, totalDebt: 0 });
  } catch (err: unknown) {
    if (isPgConstraintError(err) && err.code === "23505" && err.constraint?.includes("phone")) {
      return res.status(409).json({ error: `Số điện thoại "${phone}" đã được dùng bởi khách hàng khác. Vui lòng kiểm tra lại.` });
    }
    console.error("PUT /customers/:id error:", err);
    return res.status(500).json({ error: "Lỗi hệ thống khi cập nhật khách hàng" });
  }
});

router.delete("/customers/:id", async (req, res) => {
  try {
  // Admin-only (dùng chung ensureAdmin — giữ nguyên message cũ).
  if (!(await ensureAdmin(req, res, "Không có quyền xóa khách hàng"))) return;

  const id = parseInt(req.params.id);
  const force = req.query.force === "true";

  if (force) {
    // Cascade delete in a true single-connection transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Children of bookings
      await client.query(`DELETE FROM attendance_logs    WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      await client.query(`DELETE FROM booking_change_log WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      await client.query(`DELETE FROM booking_items      WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      await client.query(`DELETE FROM expenses           WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      await client.query(`DELETE FROM payments           WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      await client.query(`DELETE FROM photoshop_jobs     WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      await client.query(`DELETE FROM staff_job_earnings WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      await client.query(`DELETE FROM tasks              WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      await client.query(`DELETE FROM contracts          WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = $1)`, [id]);
      // Children of rentals
      await client.query(`DELETE FROM payments           WHERE rental_id  IN (SELECT id FROM rentals  WHERE customer_id = $1)`, [id]);
      // Direct customer relations
      await client.query(`DELETE FROM bookings  WHERE customer_id = $1`, [id]);
      await client.query(`DELETE FROM rentals   WHERE customer_id = $1`, [id]);
      await client.query(`DELETE FROM contracts WHERE customer_id = $1`, [id]);
      await client.query(`DELETE FROM quotes    WHERE customer_id = $1`, [id]);
      await client.query(`DELETE FROM customers WHERE id = $1`, [id]);
      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }
  } else {
    await db.delete(customersTable).where(eq(customersTable.id, id));
  }

  res.status(204).send();
  } catch (err: unknown) {
    // Drizzle wraps PG errors in .cause; check for FK constraint (code 23503)
    const pgError = (err as Record<string, unknown>)?.cause;
    if (isPgConstraintError(pgError) && pgError.code === "23503") {
      return res.status(409).json({
        error: "Không thể xóa khách hàng vì có đơn chụp hoặc thanh toán liên kết. Vui lòng xóa hoặc chuyển các đơn trước.",
      });
    }
    console.error("DELETE /customers/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

export default router;
