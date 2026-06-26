import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  staffJobEarningsTable, staffRatePricesTable,
  staffTable, bookingsTable, serviceJobSplitsTable, servicesTable,
} from "@workspace/db/schema";
import { eq, and, desc, ne } from "drizzle-orm";

const router: IRouter = Router();

const fmtEarning = (e: { rate: string; [key: string]: unknown }) => ({ ...e, rate: parseFloat(e.rate) });

// ─── Lookup rate: per-staff individual rate (highest priority) ─────────────────
async function lookupStaffRate(
  staffId: number, role: string, taskKey: string
): Promise<{ rate: number; rateType: string } | null> {
  const exact = await db.select().from(staffRatePricesTable).where(and(
    eq(staffRatePricesTable.staffId, staffId),
    eq(staffRatePricesTable.role, role),
    eq(staffRatePricesTable.taskKey, taskKey),
  ));
  if (exact.length > 0 && exact[0].rate !== null) {
    return { rate: parseFloat(exact[0].rate!), rateType: exact[0].rateType };
  }
  if (taskKey !== "mac_dinh") {
    const fallback = await db.select().from(staffRatePricesTable).where(and(
      eq(staffRatePricesTable.staffId, staffId),
      eq(staffRatePricesTable.role, role),
      eq(staffRatePricesTable.taskKey, "mac_dinh"),
    ));
    if (fallback.length > 0 && fallback[0].rate !== null) {
      return { rate: parseFloat(fallback[0].rate!), rateType: fallback[0].rateType };
    }
  }
  return null;
}

// ─── Lookup service split for a role (fallback when no per-staff rate) ─────────
async function lookupServiceSplit(
  serviceId: number | null | undefined, role: string
): Promise<{ rate: number; rateType: string } | null> {
  if (!serviceId) return null;
  const rows = await db.select().from(serviceJobSplitsTable).where(and(
    eq(serviceJobSplitsTable.serviceId, serviceId),
    eq(serviceJobSplitsTable.role, role),
  ));
  if (rows.length > 0) {
    return { rate: parseFloat(rows[0].amount), rateType: rows[0].rateType };
  }
  return null;
}

// ─── Lookup service ID by name (for earnings computation) ──────────────────────
async function findServiceIdByName(name: string): Promise<number | null> {
  const rows = await db.select({ id: servicesTable.id }).from(servicesTable)
    .where(eq(servicesTable.name, name));
  return rows.length > 0 ? rows[0].id : null;
}

// ─── Resolve earning for a staff+role: per-staff > service split > null ────────
// commissionBase: total amount eligible for sale commission (excludes beauty if applicable)
async function resolveEarning(
  staffId: number, role: string, taskKey: string,
  serviceId: number | null | undefined, bookingTotal: number,
  photoCount: number = 0, commissionBase?: number
): Promise<{ rate: number; rateType: string } | null> {
  // 1. Per-staff individual rate (priority)
  const staffRate = await lookupStaffRate(staffId, role, taskKey);
  if (staffRate) {
    let rate = staffRate.rate;
    if (staffRate.rateType === "percent") {
      const base = commissionBase !== undefined ? commissionBase : bookingTotal;
      rate = (base * staffRate.rate) / 100;
    } else if (staffRate.rateType === "per_photo") {
      rate = staffRate.rate * Math.max(photoCount, 1);
    }
    return { rate, rateType: staffRate.rateType };
  }

  // 2. Service-level split (default)
  const serviceSplit = await lookupServiceSplit(serviceId, role);
  if (serviceSplit) {
    let rate = serviceSplit.rate;
    if (serviceSplit.rateType === "percent") {
      const base = commissionBase !== undefined ? commissionBase : bookingTotal;
      rate = (base * serviceSplit.rate) / 100;
    } else if (serviceSplit.rateType === "per_photo") {
      rate = serviceSplit.rate * Math.max(photoCount, 1);
    }
    return { rate, rateType: serviceSplit.rateType };
  }

  return null;
}

// ─── Auto-compute earnings for a completed booking ────────────────────────────
export async function computeBookingEarnings(bookingId: number): Promise<void> {
  // Task #476: KHÔNG xóa earning role=photoshop — nguồn earning Photoshop là
  // module Hậu kỳ (syncPhotoshopEarning), không phải booking path.
  await db.delete(staffJobEarningsTable).where(and(
    eq(staffJobEarningsTable.bookingId, bookingId),
    eq(staffJobEarningsTable.status, "pending"),
    ne(staffJobEarningsTable.role, "photoshop"),
  ));

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  // Booking đã HỦY (cancelled) hoặc đã vào THÙNG RÁC (deleted_at) → KHÔNG tính lương
  // (pending earnings đã bị xóa ở trên).
  if (!booking || booking.status === "cancelled" || booking.deletedAt != null) return;

  const earnedDate = booking.shootDate;
  const d = new Date(earnedDate);
  const month = d.getMonth() + 1;
  const year = d.getFullYear();

  const items = (booking.items || []) as Array<{
    serviceName?: string; serviceId?: number | null; price?: number;
    photoId?: number | null; photoTask?: string;
    makeupId?: number | null; makeupTask?: string;
    serviceCategory?: string;
  }>;

  // Total of all items (or fall back to booking.totalAmount)
  const bookingTotal = items.length > 0
    ? items.reduce((sum, it) => sum + (it.price || 0), 0)
    : parseFloat(booking.totalAmount as string) || 0;

  // Commission base = total excluding beauty/makeup-only items (for Hoa's sale commission)
  const beautyKeywords = ["beauty", "makeup", "trang điểm", "làm đẹp"];
  const commissionBase = items.length > 0
    ? items.reduce((sum, it) => {
        const name = (it.serviceName || "").toLowerCase();
        const cat = (it.serviceCategory || "").toLowerCase();
        const isBeauty = beautyKeywords.some(k => name.includes(k) || cat.includes(k));
        return isBeauty ? sum : sum + (it.price || 0);
      }, 0)
    : bookingTotal; // if no items breakdown, use full total as base

  // Number of photos for per_photo calculation
  const photoCount = booking.photoCount ?? 0;

  // Normalize assignedStaff: both legacy object and new StaffAssignment array format
  const assignedRaw = booking.assignedStaff || {};
  let assigned: Record<string, unknown>;
  if (Array.isArray(assignedRaw)) {
    assigned = {};
    for (const entry of assignedRaw as { role?: string; staffId?: unknown; taskKey?: string }[]) {
      if (!entry.role || entry.staffId == null) continue;
      const key = entry.role === "sales" ? "sale" : entry.role;
      assigned[key] = entry.staffId;
      if (entry.taskKey) assigned[`${key}Task`] = entry.taskKey;
    }
  } else {
    assigned = assignedRaw as Record<string, unknown>;
  }

  const earnings: Array<{
    bookingId: number; staffId: number; role: string; serviceKey: string;
    serviceName: string; rate: string; earnedDate: string; month: number; year: number;
  }> = [];

  const seen = new Set<string>();
  function addEarning(staffId: number, role: string, taskKey: string, serviceName: string, rate: number) {
    const key = `${staffId}-${role}-${taskKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    earnings.push({ bookingId, staffId, role, serviceKey: taskKey, serviceName, rate: String(Math.round(rate)), earnedDate, month, year });
  }

  // ── Per line: photographer and makeup ─────────────────────────────────────
  for (const item of items) {
    const lineName = item.serviceName || booking.packageType || "Dịch vụ";
    let serviceId = item.serviceId || null;
    if (!serviceId && item.serviceName) {
      serviceId = await findServiceIdByName(item.serviceName);
    }

    if (item.photoId) {
      const taskKey = item.photoTask || "mac_dinh";
      const found = await resolveEarning(item.photoId, "photographer", taskKey, serviceId, item.price || bookingTotal, photoCount);
      if (found) addEarning(item.photoId, "photographer", taskKey, lineName, found.rate);
    }

    if (item.makeupId) {
      const taskKey = item.makeupTask || "mac_dinh";
      const found = await resolveEarning(item.makeupId, "makeup", taskKey, serviceId, item.price || bookingTotal, photoCount);
      if (found) addEarning(item.makeupId, "makeup", taskKey, lineName, found.rate);
    }
  }

  // --- Additional services earnings ---
  const additionalLines = (booking.additionalServices || []) as Array<{
    id?: string; title?: string; taskKey?: string;
    staffAssignments?: Array<{ staffId?: number; role?: string; allocatedQty?: number; castAmount?: number }>;
  }>;
  for (const line of additionalLines) {
    const lineTitle = line.title || "Dich vu cong them";
    const taskKey = line.taskKey || line.id || "mac_dinh";
    for (const st of line.staffAssignments || []) {
      const allocated = st.allocatedQty || 0;
      if (!st.staffId || allocated <= 0) continue;
      const rate = st.castAmount || 0;
      if (rate <= 0) continue;
      const role = (st.role || "makeup").toLowerCase();
      const dedupKey = String(st.staffId) + "-" + role + "-extra-" + String(line.id);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      addEarning(st.staffId, role, taskKey, lineTitle, rate);
    }
  }


  // ── Booking-level: sale (with commission base), photoshop (per_photo), marketing ─
  const firstServiceId = items[0]?.serviceId ||
    (items[0]?.serviceName ? await findServiceIdByName(items[0]?.serviceName || "") : null);
  const bookingLabel = booking.packageType || items[0]?.serviceName || "Dịch vụ";

  // Task #476: photoshop earning chuyển sang module Hậu kỳ (photoshop_jobs) — bỏ khỏi booking-level path.
  // MẢNG-4: KHÔNG persist hoa hồng SALE ở đây nữa. Hoa hồng sale = % cast theo gói
  // (staff_cast_rates) × TIỀN ĐÃ THU, được tính realtime ở salary-estimate.ts (đã LUÔN bỏ
  // qua row sale persisted) và staff-commissions.ts. Persist ở đây dùng SAI nguồn
  // (staff_rate_prices) + SAI base (giá gốc) → ra số khác 2 đường kia, chỉ gây nhiễu ở
  // GET /job-earnings. Giữ lại marketing (không dùng hoa_hong_*).
  type BookingRole = "marketing";
  const bookingLevelRoles: Array<{ role: BookingRole; staffKey: string; taskKey: string }> = [
    { role: "marketing", staffKey: "marketing", taskKey: (assigned.marketingTask as string) || "mac_dinh" },
  ];

  for (const { role, staffKey, taskKey } of bookingLevelRoles) {
    const staffId = assigned[staffKey] as number | undefined;
    if (!staffId) continue;

    const found = await resolveEarning(
      staffId, role, taskKey, firstServiceId, bookingTotal,
      photoCount, undefined
    );
    if (!found) continue;

    addEarning(staffId, role, taskKey, bookingLabel, found.rate);
  }

  if (earnings.length > 0) {
    await db.insert(staffJobEarningsTable).values(earnings.map(e => ({
      ...e,
      status: "pending",
      // Phase 2: source_id deterministic (khớp backfill migration) để truy nguồn + chống trùng.
      sourceId: `${e.role}:booking:${e.bookingId}:${e.serviceKey}`,
    })));
  }
}

// ─── GET /job-earnings ────────────────────────────────────────────────────────
router.get("/job-earnings", async (req, res) => {
  const { verifyToken } = await import("./auth");
  const { pool } = await import("@workspace/db");
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const cr = await pool.query(`SELECT role FROM staff WHERE id=$1`, [callerId]);
  const isAdmin = (cr.rows[0] as { role?: string })?.role === "admin";

  let staffId = req.query.staffId ? parseInt(req.query.staffId as string) : undefined;
  if (!isAdmin) {
    if (staffId && staffId !== callerId) {
      return res.status(403).json({ error: "Không có quyền xem thu nhập của nhân viên khác" });
    }
    staffId = callerId;
  }
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;

  const rows = await db
    .select({
      id: staffJobEarningsTable.id,
      bookingId: staffJobEarningsTable.bookingId,
      staffId: staffJobEarningsTable.staffId,
      staffName: staffTable.name,
      staffType: staffTable.staffType,
      role: staffJobEarningsTable.role,
      serviceKey: staffJobEarningsTable.serviceKey,
      serviceName: staffJobEarningsTable.serviceName,
      rate: staffJobEarningsTable.rate,
      earnedDate: staffJobEarningsTable.earnedDate,
      month: staffJobEarningsTable.month,
      year: staffJobEarningsTable.year,
      status: staffJobEarningsTable.status,
      notes: staffJobEarningsTable.notes,
      bookingCode: bookingsTable.orderCode,
      customerName: bookingsTable.orderCode,
    })
    .from(staffJobEarningsTable)
    .innerJoin(staffTable, eq(staffJobEarningsTable.staffId, staffTable.id))
    .innerJoin(bookingsTable, eq(staffJobEarningsTable.bookingId, bookingsTable.id))
    .orderBy(desc(staffJobEarningsTable.earnedDate));

  let filtered = rows;
  if (staffId) filtered = filtered.filter(r => r.staffId === staffId);
  if (month) filtered = filtered.filter(r => r.month === month);
  if (year) filtered = filtered.filter(r => r.year === year);

  res.json(filtered.map(fmtEarning));
});

// ─── GET /job-earnings/by-booking/:bookingId ─────────────────────────────────
router.get("/job-earnings/by-booking/:bookingId", async (req, res) => {
  const bookingId = parseInt(req.params.bookingId);
  const rows = await db
    .select({
      id: staffJobEarningsTable.id,
      staffId: staffJobEarningsTable.staffId,
      staffName: staffTable.name,
      staffType: staffTable.staffType,
      role: staffJobEarningsTable.role,
      serviceKey: staffJobEarningsTable.serviceKey,
      serviceName: staffJobEarningsTable.serviceName,
      rate: staffJobEarningsTable.rate,
      status: staffJobEarningsTable.status,
    })
    .from(staffJobEarningsTable)
    .innerJoin(staffTable, eq(staffJobEarningsTable.staffId, staffTable.id))
    .where(eq(staffJobEarningsTable.bookingId, bookingId));
  res.json(rows.map(fmtEarning));
});

// ─── POST /job-earnings/compute/:bookingId ────────────────────────────────────
router.post("/job-earnings/compute/:bookingId", async (req, res) => {
  const bookingId = parseInt(req.params.bookingId);
  await computeBookingEarnings(bookingId);
  const earnings = await db.select({
    id: staffJobEarningsTable.id,
    staffId: staffJobEarningsTable.staffId,
    staffName: staffTable.name,
    staffType: staffTable.staffType,
    role: staffJobEarningsTable.role,
    serviceName: staffJobEarningsTable.serviceName,
    rate: staffJobEarningsTable.rate,
    status: staffJobEarningsTable.status,
  })
    .from(staffJobEarningsTable)
    .innerJoin(staffTable, eq(staffJobEarningsTable.staffId, staffTable.id))
    .where(eq(staffJobEarningsTable.bookingId, bookingId));
  res.json(earnings.map(fmtEarning));
});

// ─── PATCH /job-earnings/:id/void ─────────────────────────────────────────────
// Sửa/gỡ earning không xoá vật lý: chuyển 'voided' + ghi lý do vào notes.
// Chặn nếu earning đã 'paid'.
router.patch("/job-earnings/:id/void", async (req, res) => {
  const id = parseInt(req.params.id);
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Phải nhập lý do" });
  const [current] = await db.select().from(staffJobEarningsTable).where(eq(staffJobEarningsTable.id, id));
  if (!current) return res.status(404).json({ error: "Không tìm thấy" });
  if (current.status === "paid") return res.status(400).json({ error: "Không thể void earning đã trả." });
  const note = `[VOID ${new Date().toISOString().slice(0, 10)}] ${reason}`;
  const mergedNotes = current.notes ? `${current.notes}\n${note}` : note;
  const [row] = await db.update(staffJobEarningsTable)
    .set({ status: "voided", notes: mergedNotes })
    .where(eq(staffJobEarningsTable.id, id))
    .returning();
  res.json(fmtEarning(row));
});

// ─── PUT /job-earnings/:id ────────────────────────────────────────────────────
router.put("/job-earnings/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, notes } = req.body;
  const update: Record<string, unknown> = {};
  if (status !== undefined) update.status = status;
  if (notes !== undefined) update.notes = notes;
  const [row] = await db.update(staffJobEarningsTable).set(update).where(eq(staffJobEarningsTable.id, id)).returning();
  if (!row) return res.status(404).json({ error: "Không tìm thấy" });
  res.json(fmtEarning(row));
});

// ─── GET /job-earnings/summary/:staffId ───────────────────────────────────────
router.get("/job-earnings/summary/:staffId", async (req, res) => {
  const staffId = parseInt(req.params.staffId);
  const year = req.query.year ? parseInt(req.query.year as string) : new Date().getFullYear();

  const rows = await db.select().from(staffJobEarningsTable)
    .where(and(eq(staffJobEarningsTable.staffId, staffId), eq(staffJobEarningsTable.year, year)));

  const byMonth: Record<number, { month: number; totalEarnings: number; jobCount: number }> = {};
  for (const r of rows) {
    if (!byMonth[r.month]) byMonth[r.month] = { month: r.month, totalEarnings: 0, jobCount: 0 };
    byMonth[r.month].totalEarnings += parseFloat(r.rate);
    byMonth[r.month].jobCount++;
  }

  res.json(Object.values(byMonth).sort((a, b) => a.month - b.month));
});

export default router;
