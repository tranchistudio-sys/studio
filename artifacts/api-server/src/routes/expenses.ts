import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { expensesTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { verifyToken } from "./auth";

const router: IRouter = Router();

const fmt = (e: { amount: string; receiptUrls?: unknown; [key: string]: unknown }) => ({
  ...e,
  amount: parseFloat(e.amount),
  receiptUrls: Array.isArray(e.receiptUrls) ? e.receiptUrls : [],
});

function genCode() {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const r = Math.floor(Math.random() * 900 + 100);
  return `PC${y}${m}${d}${r}`;
}

// ── Phiếu chi datetime helpers ────────────────────────────────────────────────
// Derive YYYY-MM-DD theo Asia/Ho_Chi_Minh để keep expense_date sync với expense_at.
function vnDateOf(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

router.get("/expenses", async (req, res) => {
  const rows = await db
    .select()
    .from(expensesTable)
    .orderBy(desc(expensesTable.expenseAt), desc(expensesTable.expenseDate), desc(expensesTable.createdAt));
  let filtered = rows;

  const category = req.query.category as string | undefined;
  const createdBy = req.query.createdBy as string | undefined;
  const dateRange = req.query.dateRange as string | undefined;
  const statusFilter = req.query.status as string | undefined;
  const mine = req.query.mine === "1" || req.query.mine === "true";

  // Kiểm tra quyền caller — nhân viên không phải admin luôn chỉ thấy chi tiêu của mình
  const callerId = verifyToken(req.headers.authorization);
  let callerIsAdmin = false;
  if (callerId) {
    const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
    const caller = callerR.rows[0] as Record<string, unknown> | undefined;
    callerIsAdmin = !!(caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"))));
  }

  if (!callerId) {
    // Không có token hợp lệ — trả về danh sách rỗng
    return res.json([]);
  }

  if (!callerIsAdmin) {
    // Nhân viên không phải admin luôn chỉ thấy chi tiêu của mình
    filtered = filtered.filter(e => e.createdByStaffId === callerId);
  } else if (mine) {
    // Admin chọn xem của mình thôi
    filtered = filtered.filter(e => e.createdByStaffId === callerId);
  }

  const bookingIdFilter = req.query.bookingId as string | undefined;
  if (bookingIdFilter) {
    const bid = parseInt(bookingIdFilter, 10);
    if (!Number.isNaN(bid)) {
      const includeChildren = req.query.includeChildren === "1" || req.query.includeChildren === "true";
      if (includeChildren) {
        const childR = await pool.query<{ id: number }>(
          `SELECT id FROM bookings WHERE parent_id = $1`,
          [bid],
        );
        const ids = new Set([bid, ...childR.rows.map((r) => r.id)]);
        filtered = filtered.filter((row) => row.bookingId != null && ids.has(row.bookingId));
      } else {
        filtered = filtered.filter((row) => row.bookingId === bid);
      }
    }
  }

  if (category) filtered = filtered.filter(e => e.category === category);
  if (createdBy) filtered = filtered.filter(e => e.createdBy === createdBy);
  if (statusFilter) filtered = filtered.filter(e => e.status === statusFilter);
  if (dateRange) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (dateRange === "today") {
      filtered = filtered.filter(e => e.expenseDate === today);
    } else if (dateRange === "7days") {
      const d7 = new Date(now); d7.setDate(d7.getDate() - 6);
      filtered = filtered.filter(e => e.expenseDate >= d7.toISOString().slice(0, 10));
    } else if (dateRange === "month") {
      const ym = today.slice(0, 7);
      filtered = filtered.filter(e => e.expenseDate.startsWith(ym));
    } else if (dateRange === "all") {
      // không lọc thêm
    }
  }

  res.json(filtered.map(fmt));
});

router.get("/expenses/stats", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.json({ today: 0, todayCount: 0, week: 0, weekCount: 0, month: 0, monthCount: 0, total: 0, totalCount: 0 });

  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));

  let allRows = await db.select().from(expensesTable);
  // Nhân viên chỉ thấy thống kê chi phí của mình
  const rows = isAdmin ? allRows : allRows.filter(e => e.createdByStaffId === callerId);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const d7 = new Date(now); d7.setDate(d7.getDate() - 6);
  const ym = today.slice(0, 7);

  const todayRows = rows.filter(e => e.expenseDate === today);
  const d7Rows = rows.filter(e => e.expenseDate >= d7.toISOString().slice(0, 10));
  const monthRows = rows.filter(e => e.expenseDate.startsWith(ym));

  const sum = (arr: typeof rows) => arr.reduce((s, e) => s + parseFloat(e.amount), 0);
  res.json({
    today: sum(todayRows),
    todayCount: todayRows.length,
    week: sum(d7Rows),
    weekCount: d7Rows.length,
    month: sum(monthRows),
    monthCount: monthRows.length,
    total: sum(rows),
    totalCount: rows.length,
  });
});

router.get("/expenses/:id", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));

  const id = parseInt(req.params.id);
  const [e] = await db.select().from(expensesTable).where(eq(expensesTable.id, id));
  if (!e) return res.status(404).json({ error: "Không tìm thấy" });
  // Staff can only see their own expense detail
  if (!isAdmin && e.createdByStaffId !== callerId) return res.status(403).json({ error: "Không có quyền xem chi phí này" });
  res.json(fmt(e));
});

router.post("/expenses", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const { type, category, amount, description, bookingId, paymentMethod, expenseDate, expenseAt, receiptUrl, receiptUrls, createdBy, notes, bankName, bankAccount, costClass } = req.body;
  const expenseCode = genCode();
  // Phiếu chi datetime: nguồn-source-of-truth là expenseAt (timestamp).
  // Nếu client không gửi expenseAt → mặc định là thời điểm hiện tại (KHÔNG suy
  // theo booking/expenseDate). expense_date được derive theo VN tz để sync.
  const expenseAtDate = expenseAt ? new Date(expenseAt) : new Date();
  // expenseAt là source-of-truth: luôn derive expenseDate theo VN tz để khỏi
  // lệch ngày giữa 2 cột (chỉ fallback expenseDate khi client legacy chỉ gửi
  // expense_date, không gửi expenseAt).
  const resolvedExpenseDate = expenseAt ? vnDateOf(expenseAtDate) : (expenseDate || vnDateOf(expenseAtDate));
  // Task #363: nếu không truyền costClass → mặc định: gắn booking → direct, không gắn → operating
  const ALLOWED_CLASS = ["direct", "operating", "depreciation", "interest", "loan_principal"];
  const resolvedCostClass = ALLOWED_CLASS.includes(costClass) ? costClass : (bookingId ? "direct" : "operating");

  // Nhân viên tự nộp → status LUÔN = "submitted", admin tạo → "approved"
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  const status = isAdmin ? "approved" : "submitted";
  const createdByStaffId = isAdmin ? null : callerId;

  const [expense] = await db
    .insert(expensesTable)
    .values({
      expenseCode,
      type: type || "operational",
      category: category || "Chi khác",
      amount: String(amount),
      description: description || "",
      bookingId: bookingId || null,
      costClass: resolvedCostClass,
      paymentMethod: paymentMethod || "cash",
      expenseDate: resolvedExpenseDate,
      expenseAt: expenseAtDate,
      receiptUrl: receiptUrl || null,
      bankName: bankName || null,
      bankAccount: bankAccount || null,
      createdBy: createdBy || null,
      createdByStaffId,
      status,
      notes: notes || null,
    })
    .returning();
  if (Array.isArray(receiptUrls) && receiptUrls.length) {
    const [updated] = await db.update(expensesTable).set({ receiptUrls }).where(eq(expensesTable.id, expense.id)).returning();
    res.status(201).json(fmt(updated || expense));
    return;
  }
  res.status(201).json(fmt(expense));
});

router.put("/expenses/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) {
    // Staff can only edit their own submitted expenses
    const [existing] = await db.select().from(expensesTable).where(eq(expensesTable.id, id));
    if (!existing) return res.status(404).json({ error: "Không tìm thấy chi phí" });
    if (existing.createdByStaffId !== callerId) return res.status(403).json({ error: "Không có quyền sửa chi phí này" });
    if (existing.status !== "submitted") return res.status(403).json({ error: "Chỉ có thể sửa chi phí chưa duyệt" });
  }
  const { type, category, amount, description, bookingId, paymentMethod, expenseDate, expenseAt, receiptUrl, receiptUrls, notes, bankName, bankAccount, createdBy, costClass } = req.body;
  const ALLOWED_CLASS = ["direct", "operating", "depreciation", "interest", "loan_principal"];
  const update: Record<string, unknown> = {};
  if (type !== undefined) update.type = type;
  if (category !== undefined) update.category = category;
  if (amount !== undefined) update.amount = String(amount);
  if (description !== undefined) update.description = description;
  if (bookingId !== undefined) update.bookingId = bookingId || null;
  // Task #363: nếu client không truyền costClass mà có thay đổi bookingId → tự suy ra mặc định để khớp hợp đồng API.
  if (costClass !== undefined && ALLOWED_CLASS.includes(costClass)) {
    update.costClass = costClass;
  } else if (bookingId !== undefined) {
    update.costClass = bookingId ? "direct" : "operating";
  }
  if (paymentMethod !== undefined) update.paymentMethod = paymentMethod;
  // Phiếu chi datetime: chỉ update khi user chủ động đổi ô ngày/giờ. Khi đổi
  // expenseAt thì sync expense_date theo VN tz; nếu chỉ đổi expense_date (cũ)
  // thì giữ tương thích.
  if (expenseAt !== undefined && expenseAt !== null && expenseAt !== "") {
    const dt = new Date(expenseAt);
    if (!isNaN(dt.getTime())) {
      update.expenseAt = dt;
      update.expenseDate = vnDateOf(dt);
    }
  } else if (expenseDate !== undefined) {
    update.expenseDate = expenseDate;
  }
  if (receiptUrl !== undefined) update.receiptUrl = receiptUrl;
  if (receiptUrls !== undefined && Array.isArray(receiptUrls)) update.receiptUrls = receiptUrls;
  if (notes !== undefined) update.notes = notes;
  if (bankName !== undefined) update.bankName = bankName;
  if (bankAccount !== undefined) update.bankAccount = bankAccount;
  if (createdBy !== undefined) update.createdBy = createdBy;
  const [expense] = await db.update(expensesTable).set(update).where(eq(expensesTable.id, id)).returning();
  if (!expense) return res.status(404).json({ error: "Không tìm thấy chi phí" });
  res.json(fmt(expense));
});

// ── Task #12: Approve / Reject ─────────────────────────────────────────────────
router.patch("/expenses/:id/approve", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền duyệt chi phí" });

  const id = parseInt(req.params.id);
  const { action = "approve" } = req.body;

  const [e] = await db.update(expensesTable)
    .set({
      status: action === "reject" ? "rejected" : "approved",
      approvedByStaffId: action === "reject" ? null : callerId,
    })
    .where(eq(expensesTable.id, id))
    .returning();
  if (!e) return res.status(404).json({ error: "Không tìm thấy chi phí" });
  res.json(fmt(e));
});

// ── Task #12: Reject expense ──────────────────────────────────────────────────
router.patch("/expenses/:id/reject", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền từ chối chi phí" });

  const id = parseInt(req.params.id);
  const [e] = await db.update(expensesTable)
    .set({ status: "rejected", approvedByStaffId: null })
    .where(eq(expensesTable.id, id))
    .returning();
  if (!e) return res.status(404).json({ error: "Không tìm thấy chi phí" });
  res.json(fmt(e));
});

// ── Task #12: Mark as Paid ────────────────────────────────────────────────────
router.patch("/expenses/:id/pay", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền xác nhận thanh toán" });

  const id = parseInt(req.params.id);
  const { paidFrom, paidAt } = req.body;
  const PAID_FROM_ALLOWED = ["company", "owner", "mom"];
  const resolvedPaidFrom = PAID_FROM_ALLOWED.includes(paidFrom) ? paidFrom : "company";

  const [e] = await db.update(expensesTable)
    .set({
      status: "paid",
      paidByStaffId: callerId,
      paidFrom: resolvedPaidFrom,
      paidAt: paidAt || new Date().toISOString(),
    })
    .where(eq(expensesTable.id, id))
    .returning();
  if (!e) return res.status(404).json({ error: "Không tìm thấy chi phí" });
  res.json(fmt(e));
});

router.delete("/expenses/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) {
    const [existing] = await db.select().from(expensesTable).where(eq(expensesTable.id, id));
    if (!existing) return res.status(404).json({ error: "Không tìm thấy chi phí" });
    if (existing.createdByStaffId !== callerId) return res.status(403).json({ error: "Không có quyền xoá chi phí này" });
    if (existing.status !== "submitted") return res.status(403).json({ error: "Chỉ có thể xoá chi phí chưa duyệt" });
  }
  await db.delete(expensesTable).where(eq(expensesTable.id, id));
  res.status(204).send();
});

export default router;
