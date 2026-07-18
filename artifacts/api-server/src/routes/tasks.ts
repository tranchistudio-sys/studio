import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { tasksTable, staffTable, staffRatePricesTable, bookingsTable } from "@workspace/db/schema";
import { eq, desc, and, or, isNull } from "drizzle-orm";
import { getCallerRole } from "./auth";

const router: IRouter = Router();

const TASK_TYPE_LABELS: Record<string, string> = {
  chup: "Chụp ảnh", makeup: "Trang điểm", pts: "Chỉnh ảnh (PTS)",
  support: "Hỗ trợ", in: "In ảnh/album", giao_file: "Giao file ảnh",
  goi_khach: "Gọi / nhắn khách", quay_phim: "Quay phim", other: "Khác",
};

const fmt = (t: Record<string, unknown>, assigneeName: string | null) => ({
  ...t,
  cost: t.cost != null ? parseFloat(t.cost as string) : 0,
  assigneeName,
  taskTypeLabel: TASK_TYPE_LABELS[(t.taskType as string) ?? ""] ?? (t.taskType as string) ?? "",
});

// ── Helper: tự tính cost từ staffRatePricesTable ──────────────────────────────
async function lookupCost(staffId: number | null, role: string | null, taskType: string | null, bookingTotalAmount: number): Promise<number> {
  if (!staffId || !role) return 0;
  const taskKey = taskType || "mac_dinh";

  // Exact match: staffId + role + taskKey
  const rows = await db.select()
    .from(staffRatePricesTable)
    .where(and(
      eq(staffRatePricesTable.staffId, staffId),
      eq(staffRatePricesTable.role, role),
      or(
        eq(staffRatePricesTable.taskKey, taskKey),
        eq(staffRatePricesTable.taskKey, "mac_dinh"),
      ),
    ));

  // Prefer exact taskKey match, fallback to mac_dinh
  const exact = rows.find(r => r.taskKey === taskKey);
  const fallback = rows.find(r => r.taskKey === "mac_dinh");
  const matched = exact ?? fallback;

  if (!matched || matched.rate == null) return 0;

  const rate = parseFloat(matched.rate);
  if (matched.rateType === "percent") {
    return Math.round(rate / 100 * bookingTotalAmount);
  }
  return rate;
}

// ── Booking-centric view — MUST be before /tasks/:id ─────────────────────────
router.get("/tasks/booking-view", async (req, res) => {
  try {
    // Trả tên/SĐT khách theo booking (có filter search) → bắt auth trước khi query.
    if (!(await getCallerRole(req.headers.authorization))) {
      res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
      return;
    }
    const { search, shootMonth } = req.query as Record<string, string>;

    // Build WHERE clause addition for shoot month filter
    let shootMonthWhere = "";
    const queryParams: string[] = [];
    if (shootMonth && /^\d{4}-\d{2}$/.test(shootMonth)) {
      const [yr, mo] = shootMonth.split("-");
      const startDate = `${yr}-${mo}-01`;
      const endDate = `${yr}-${mo}-31`;
      queryParams.push(startDate, endDate);
      shootMonthWhere = `AND b.shoot_date >= $1 AND b.shoot_date <= $2`;
    }

    const result = await pool.query(`
      SELECT
        b.id              AS booking_id,
        b.order_code,
        b.shoot_date,
        b.created_at      AS booking_created_at,
        b.package_type,
        b.service_label,
        b.status          AS booking_status,
        b.location,
        b.assigned_staff,
        b.items,
        b.required_roles,
        c.name            AS customer_name,
        c.phone           AS customer_phone,
        t.id              AS task_id,
        t.title           AS task_title,
        t.assignee_id,
        s.name            AS assignee_name,
        t.role,
        t.task_type,
        t.status          AS task_status,
        t.cost,
        t.notes           AS task_notes
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id
      LEFT JOIN tasks t ON t.booking_id = b.id
      LEFT JOIN staff s ON s.id = t.assignee_id
      WHERE b.status NOT IN ('cancelled','temp_quote')
        AND b.deleted_at IS NULL
        AND (b.parent_id IS NULL OR b.is_parent_contract = true)
        ${shootMonthWhere}
      ORDER BY b.shoot_date ASC, b.created_at DESC, t.created_at ASC
    `, queryParams);

    // Group rows by booking_id
    const map = new Map<number, Record<string, unknown> & { tasks: unknown[] }>();
    for (const row of result.rows) {
      const bid = Number(row.booking_id);
      if (!map.has(bid)) {
        const rawStaff = row.assigned_staff;
        const rawItems = row.items;
        let assigned_staff: unknown[] = [];

        try {
          // Case 1: already an array (saved from Giao việc)
          if (Array.isArray(rawStaff)) {
            assigned_staff = rawStaff;
          }
          // Case 2: string JSON — parse then handle array or object
          else if (typeof rawStaff === "string" && rawStaff.trim()) {
            const parsed = JSON.parse(rawStaff);
            if (Array.isArray(parsed)) {
              assigned_staff = parsed;
            } else if (parsed && typeof parsed === "object") {
              // normalize object-format below
              const obj = parsed as Record<string, unknown>;
              const roleKeys = ["sale", "photoshop", "photo", "makeup", "video"];
              for (const role of roleKeys) {
                if (obj[role]) {
                  assigned_staff.push({ id: `obj-${role}-${obj[role]}`, role, staffId: obj[role], staffName: "", castAmount: 0 });
                }
              }
            }
          }
          // Case 3: old-format object { sale: N, photoshop: M } — normalize to StaffAssignment[]
          else if (rawStaff && typeof rawStaff === "object") {
            const obj = rawStaff as Record<string, unknown>;
            const roleKeys = ["sale", "photoshop", "photo", "makeup", "video"];
            for (const role of roleKeys) {
              if (obj[role]) {
                assigned_staff.push({ id: `obj-${role}-${obj[role]}`, role, staffId: obj[role], staffName: "", castAmount: 0 });
              }
            }
          }
        } catch {
          assigned_staff = [];
        }

        // Extract per-service staff from items[i].assignedStaff (where Lịch show saves staff)
        try {
          const itemsArr = Array.isArray(rawItems) ? rawItems : [];
          for (const item of itemsArr) {
            if (Array.isArray((item as Record<string, unknown>)?.assignedStaff)) {
              for (const sa of (item as Record<string, unknown>).assignedStaff as unknown[]) {
                const s = sa as Record<string, unknown>;
                // Deduplicate by id or by staffId+role combo
                const already = (assigned_staff as Array<Record<string, unknown>>).some(
                  x => x.id === s.id || (s.staffId && x.staffId === s.staffId && x.role === s.role)
                );
                if (!already) assigned_staff.push(sa);
              }
            }
          }
        } catch { /* ignore */ }

        const requiredRoles: string[] = Array.isArray(row.required_roles) ? row.required_roles as string[] : [];
        map.set(bid, {
          booking_id: bid,
          order_code: row.order_code,
          shoot_date: row.shoot_date,
          booking_created_at: row.booking_created_at,
          package_type: row.package_type,
          service_label: row.service_label,
          booking_status: row.booking_status,
          location: row.location,
          customer_name: row.customer_name,
          customer_phone: row.customer_phone,
          required_roles: requiredRoles,
          assigned_staff,
          tasks: [],
        });
      }
      if (row.task_id) {
        (map.get(bid)!.tasks as unknown[]).push({
          task_id: Number(row.task_id),
          title: row.task_title,
          assignee_id: row.assignee_id ? Number(row.assignee_id) : null,
          assignee_name: row.assignee_name,
          role: row.role,
          task_type: row.task_type,
          task_status: row.task_status,
          cost: row.cost ? parseFloat(String(row.cost)) : 0,
          notes: row.task_notes,
        });
      }
    }

    let data = Array.from(map.values()).map(b => {
      const requiredRoles = (b.required_roles as string[]) ?? [];
      const tasks = b.tasks as Array<{ role?: string; assignee_id?: number | null }>;
      const coveredRoles = [...new Set(tasks.filter(t => t.assignee_id != null && t.role).map(t => t.role as string))];
      let staffStatus: string;
      if (tasks.length === 0) {
        staffStatus = "unassigned";
      } else if (requiredRoles.length > 0 && requiredRoles.every(r => coveredRoles.includes(r))) {
        staffStatus = "ready";
      } else if (requiredRoles.length > 0 && requiredRoles.some(r => !coveredRoles.includes(r))) {
        staffStatus = "understaffed";
      } else {
        staffStatus = tasks.some(t => t.assignee_id != null) ? "ready" : "unassigned";
      }
      // days_to_shoot for upcoming badge
      const shoot = b.shoot_date as string | null;
      const today = new Date().toISOString().slice(0, 10);
      let daysToShoot: number | null = null;
      if (shoot) {
        const diff = (new Date(shoot).getTime() - new Date(today).getTime()) / 86400000;
        daysToShoot = Math.ceil(diff);
      }
      return { ...b, staffStatus, coveredRoles, daysToShoot };
    });

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(b =>
        String(b.customer_name ?? "").toLowerCase().includes(q) ||
        String(b.customer_phone ?? "").toLowerCase().includes(q) ||
        String(b.order_code ?? "").toLowerCase().includes(q) ||
        String(b.shoot_date ?? "").includes(q)
      );
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /tasks
router.get("/tasks", async (req, res) => {
  const statusFilter = req.query.status as string | undefined;
  const assigneeId = req.query.assigneeId ? parseInt(req.query.assigneeId as string) : undefined;
  const bookingId = req.query.bookingId ? parseInt(req.query.bookingId as string) : undefined;

  const rows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      description: tasksTable.description,
      category: tasksTable.category,
      assigneeId: tasksTable.assigneeId,
      assigneeName: staffTable.name,
      bookingId: tasksTable.bookingId,
      servicePackageId: tasksTable.servicePackageId,
      role: tasksTable.role,
      taskType: tasksTable.taskType,
      priority: tasksTable.priority,
      status: tasksTable.status,
      dueDate: tasksTable.dueDate,
      completedAt: tasksTable.completedAt,
      notes: tasksTable.notes,
      cost: tasksTable.cost,
      createdAt: tasksTable.createdAt,
    })
    .from(tasksTable)
    .leftJoin(staffTable, eq(tasksTable.assigneeId, staffTable.id))
    .orderBy(desc(tasksTable.createdAt));

  let filtered = rows;
  if (statusFilter) filtered = filtered.filter(t => t.status === statusFilter);
  if (assigneeId) filtered = filtered.filter(t => t.assigneeId === assigneeId);
  if (bookingId) filtered = filtered.filter(t => t.bookingId === bookingId);

  res.json(filtered.map(t => fmt(t as Record<string, unknown>, t.assigneeName ?? null)));
});

// POST /tasks
router.post("/tasks", async (req, res) => {
  const { title, description, category, assigneeId, bookingId, servicePackageId, role, taskType, priority, dueDate, notes, cost: costOverride } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: "Thiếu tiêu đề" });

  // Task #22: bookingId bắt buộc
  if (!bookingId) return res.status(400).json({ error: "Thiếu bookingId — mỗi việc phải thuộc 1 đơn hàng" });

  // Lookup booking total for percent-rate calc
  let bookingTotal = 0;
  const [booking] = await db.select({ totalAmount: bookingsTable.totalAmount }).from(bookingsTable).where(and(eq(bookingsTable.id, parseInt(String(bookingId))), isNull(bookingsTable.deletedAt)));
  if (booking) bookingTotal = parseFloat(booking.totalAmount);

  // Auto-compute cost from staffRates unless manually overridden
  let cost = 0;
  if (costOverride != null && costOverride !== "") {
    cost = parseFloat(String(costOverride));
  } else {
    cost = await lookupCost(assigneeId ? parseInt(String(assigneeId)) : null, role ?? null, taskType ?? null, bookingTotal);
  }

  const [task] = await db.insert(tasksTable).values({
    title, description,
    category: category || "other",
    assigneeId: assigneeId || null,
    bookingId: parseInt(String(bookingId)),
    servicePackageId: servicePackageId || null,
    role: role || null,
    taskType: taskType || null,
    priority: priority || "medium",
    dueDate: dueDate || null,
    notes: notes || null,
    status: "todo",
    cost: String(cost),
  }).returning();

  let assigneeName: string | null = null;
  if (task.assigneeId) {
    const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, task.assigneeId));
    assigneeName = staff?.name ?? null;
  }

  res.status(201).json(fmt(task as unknown as Record<string, unknown>, assigneeName));
});

// PUT /tasks/:id
router.put("/tasks/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { title, description, assigneeId, priority, status, dueDate, notes, taskType, role, servicePackageId, cost: costOverride } = req.body;
  const update: Record<string, unknown> = {};
  if (title !== undefined) update.title = title;
  if (description !== undefined) update.description = description;
  if (assigneeId !== undefined) update.assigneeId = assigneeId;
  if (priority !== undefined) update.priority = priority;
  if (status !== undefined) {
    update.status = status;
    if (status === "done") update.completedAt = new Date();
    else update.completedAt = null;
  }
  if (dueDate !== undefined) update.dueDate = dueDate;
  if (notes !== undefined) update.notes = notes;
  if (taskType !== undefined) update.taskType = taskType;
  if (role !== undefined) update.role = role;
  if (servicePackageId !== undefined) update.servicePackageId = servicePackageId;

  // Re-lookup cost if staffId/role/taskType changed and no manual override
  if (costOverride != null && costOverride !== "") {
    update.cost = String(parseFloat(String(costOverride)));
  } else if (assigneeId !== undefined || role !== undefined || taskType !== undefined) {
    // Fetch current task to get the full context for cost lookup
    const [current] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
    if (current) {
      const effectiveStaffId = assigneeId !== undefined ? (assigneeId || null) : current.assigneeId;
      const effectiveRole = role !== undefined ? (role || null) : current.role;
      const effectiveTaskType = taskType !== undefined ? (taskType || null) : current.taskType;

      let bookingTotal = 0;
      if (current.bookingId) {
        const [booking] = await db.select({ totalAmount: bookingsTable.totalAmount }).from(bookingsTable).where(and(eq(bookingsTable.id, current.bookingId), isNull(bookingsTable.deletedAt)));
        if (booking) bookingTotal = parseFloat(booking.totalAmount);
      }
      const recomputedCost = await lookupCost(effectiveStaffId, effectiveRole, effectiveTaskType, bookingTotal);
      update.cost = String(recomputedCost);
    }
  }

  const [task] = await db.update(tasksTable).set(update).where(eq(tasksTable.id, id)).returning();
  if (!task) return res.status(404).json({ error: "Task không tồn tại" });

  let assigneeName: string | null = null;
  if (task.assigneeId) {
    const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, task.assigneeId));
    assigneeName = staff?.name ?? null;
  }

  res.json(fmt(task as unknown as Record<string, unknown>, assigneeName));
});

// DELETE /tasks/:id
router.delete("/tasks/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(tasksTable).where(eq(tasksTable.id, id));
  res.status(204).send();
});

export default router;
