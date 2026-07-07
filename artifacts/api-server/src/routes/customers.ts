import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { customersTable, bookingsTable, paymentsTable } from "@workspace/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";
import { verifyToken } from "./auth";
import { withStartupDdlLock } from "../lib/startup-ddl";
import { computeCustomerAggregate, isDebtCountableBooking } from "../lib/customer-aggregate";

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

router.get("/customers", async (req, res) => {
  try {
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

  const allPayments = await db.select().from(paymentsTable);

  const result = await Promise.all(
    customers.map(async (c) => {
      const bookings = (await db.select().from(bookingsTable).where(and(eq(bookingsTable.customerId, c.id as number), isNull(bookingsTable.deletedAt))))
        .filter((b) => b.status !== "temp_quote"); // báo giá tạm không tính vào công nợ/chi tiêu khách
      // Gộp số liệu qua helper: bỏ đơn CHA tổng khỏi công nợ/số show (chống cộng trùng cha-con),
      // vẫn cộng phiếu thu ghi ở đơn cha vào "đã thu".
      const { totalBookings, totalPaid, totalDebt } = computeCustomerAggregate(bookings, allPayments);
      return { ...c, totalBookings, totalPaid, totalDebt };
    })
  );

  res.json(result);
  } catch (err) {
    console.error("GET /customers error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.get("/customers/by-phone", async (req, res) => {
  try {
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
  const id = parseInt(req.params.id);
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  if (!customer) return res.status(404).json({ error: "Không tìm thấy khách hàng" });
  const bookings = await db.select().from(bookingsTable).where(and(eq(bookingsTable.customerId, id), isNull(bookingsTable.deletedAt)));
  const allPayments = await db.select().from(paymentsTable);
  // Gộp số liệu qua helper (chống cộng trùng cha-con): phải truyền CẢ đơn cha để cộng
  // đúng phiếu thu ghi ở đơn cha, nhưng công nợ/số show chỉ đếm đơn con + đơn lẻ.
  const { totalBookings, totalPaid, totalDebt } = computeCustomerAggregate(bookings, allPayments);
  // Lịch sử show: bỏ dòng đơn CHA tổng (là bản gộp trùng của các dịch vụ con) để không
  // hiển thị dòng tổng trùng; các dịch vụ con + đơn lẻ vẫn giữ nguyên → không mất lịch sử.
  const historyBookings = bookings.filter(isDebtCountableBooking);
  res.json({ ...customer, totalBookings, totalPaid, totalDebt, bookings: historyBookings });
  } catch (err) {
    console.error("GET /customers/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.get("/customers/:id/recent-bookings", async (req, res) => {
  try {
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
    const setFields: Record<string, unknown> = {
      name, email, address, notes, facebook, zalo, source, tags: tags || [], gender, avatar,
    };
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
  // Admin-only: verify token and check role
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const callerIsAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!callerIsAdmin) return res.status(403).json({ error: "Không có quyền xóa khách hàng" });

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
