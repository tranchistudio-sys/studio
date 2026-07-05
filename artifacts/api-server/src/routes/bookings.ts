import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { bookingsTable, customersTable, paymentsTable, expensesTable, tasksTable, staffTable, servicePackagesTable, packageItemsTable, photoshopJobsTable, servicesTable, bookingChangeLogTable, contractsTable, bookingDressesTable, bookingItemsTable, staffJobEarningsTable, staffAllowancesTable, attendanceLogsTable } from "@workspace/db/schema";
import { eq, and, desc, inArray, or, ilike, sql, asc, gte, lte, isNull, ne } from "drizzle-orm";
import { isCollectedPayment, money } from "../lib/booking-money";
import { verifyToken, getCallerRole } from "./auth";
import { computeBookingEarnings } from "./job-earnings";
import { emitNotification } from "./notifications";
import { normalizeItemsAssignedStaffCast } from "../lib/resolve-staff-cast";
import { maybeCreatePhotoshopJobForBooking } from "./photoshop-jobs";
import { bookingRequiresPostProduction } from "../lib/post-production-eligibility";
import {
  sanitizeAdditionalServices,
  validateAdditionalServices,
  calcAdditionalServicesTotal,
  normalizeAdditionalServicesCast,
  assertAdditionalServicesValid,
  AdditionalServicesValidationError,
  type AdditionalServiceLine,
} from "../lib/additional-services";

const router: IRouter = Router();

// ─── Task #55: Sanitize deductions ───────────────────────────────────────────
export type DeductionItem = { label: string; amount: number };
export function sanitizeDeductions(raw: unknown): DeductionItem[] {
  if (!Array.isArray(raw)) return [];
  return (raw as DeductionItem[])
    .filter(d => d?.label?.trim() && d.amount > 0)
    .map(({ label, amount }) => ({ label: String(label).trim(), amount: Number(amount) }));
}


// --- Additional services ---
async function prepareAdditionalServicesForSave(raw: unknown, packageId?: number | null): Promise<AdditionalServiceLine[]> {
  const lines = sanitizeAdditionalServices(raw);
  assertAdditionalServicesValid(lines);
  return normalizeAdditionalServicesCast(lines, packageId);
}

/** Sum non-voided payments for a booking (A3). */
async function sumActivePayments(
  bookingId: number,
  client?: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
): Promise<number> {
  // A4: tiền đã thu hợp lệ — loại phiếu đã hủy (voided) và KHÔNG cộng refund (refund tách riêng, không làm paidAmount phồng).
  const sql = `SELECT COALESCE(SUM(amount::numeric), 0) AS total_paid
    FROM payments WHERE booking_id = $1 AND payment_type <> 'refund' AND COALESCE(status, 'active') <> 'voided'`;
  if (client) {
    const result = await client.query<{ total_paid: string }>(sql, [bookingId]);
    return parseFloat(result.rows[0].total_paid);
  }
  const rows = await db
    .select({ amount: paymentsTable.amount, status: paymentsTable.status, paymentType: paymentsTable.paymentType })
    .from(paymentsTable)
    .where(eq(paymentsTable.bookingId, bookingId));
  return rows
    .filter((p) => (p.status ?? "active") !== "voided" && p.paymentType !== "refund")
    .reduce((s, p) => s + parseFloat(p.amount), 0);
}

async function recalcParentTotalFromChildren(parentId: number): Promise<number> {
  const children = await db
    .select({ totalAmount: bookingsTable.totalAmount })
    .from(bookingsTable)
    // Nguồn tiền chuẩn: tổng hợp đồng cha chỉ gồm con CÒN HIỆU LỰC
    // (bỏ con đã hủy + con trong thùng rác) để không thổi phồng tổng/công nợ cha.
    .where(and(
      eq(bookingsTable.parentId, parentId),
      isNull(bookingsTable.deletedAt),
      ne(bookingsTable.status, "cancelled"),
    ));
  const newParentTotal = children.reduce((sum, c) => sum + parseFloat(c.totalAmount), 0);
  await db
    .update(bookingsTable)
    .set({ totalAmount: String(newParentTotal) })
    .where(eq(bookingsTable.id, parentId));
  return newParentTotal;
}
// ─── Task #71: Normalize items[].photoName/makeupName from assignedStaff ─────
type StaffAssignmentLike = { role?: string; staffId?: number; staffName?: string; id?: string };

async function normalizeBookingItemsCast(
  rawItems: unknown,
  bookingPackageId?: number | null,
): Promise<unknown[]> {
  const normalized = await normalizeItemsAssignedStaffCast(rawItems, bookingPackageId);
  return normalizeItemStaff(normalized);
}

function normalizeItemStaff(rawItems: unknown): unknown[] {
  if (!Array.isArray(rawItems)) return [];
  return (rawItems as Record<string, unknown>[]).map((item) => {
    const sa: StaffAssignmentLike[] = Array.isArray(item.assignedStaff)
      ? (item.assignedStaff as StaffAssignmentLike[])
      : [];
    const result = { ...item };

    // Populate photoName from assignedStaff if empty
    if (!result.photoName || result.photoName === "") {
      const p = sa.find(s => /^(photo|photographer)$/i.test(String(s.role ?? "")));
      if (p?.staffName) {
        result.photoName = p.staffName;
        result.photoId = p.staffId ?? result.photoId;
      }
    }

    // Populate makeupName from assignedStaff if empty
    if (!result.makeupName || result.makeupName === "") {
      const m = sa.find(s => /^makeup$/i.test(String(s.role ?? "")));
      if (m?.staffName) {
        result.makeupName = m.staffName;
        result.makeupId = m.staffId ?? result.makeupId;
      }
    }

    return result;
  });
}

// ─── Select fields shared across GET queries ──────────────────────────────────
const bookingFields = {
  id: bookingsTable.id,
  orderCode: bookingsTable.orderCode,
  customerId: bookingsTable.customerId,
  customerName: customersTable.name,
  customerPhone: customersTable.phone,
  customerRank: customersTable.customerRank,
  shootDate: bookingsTable.shootDate,
  shootTime: bookingsTable.shootTime,
  serviceCategory: bookingsTable.serviceCategory,
  packageType: bookingsTable.packageType,
  location: bookingsTable.location,
  status: bookingsTable.status,
  items: bookingsTable.items,
  surcharges: bookingsTable.surcharges,
  totalAmount: bookingsTable.totalAmount,
  depositAmount: bookingsTable.depositAmount,
  paidAmount: bookingsTable.paidAmount,
  discountAmount: bookingsTable.discountAmount,
  assignedStaff: bookingsTable.assignedStaff,
  internalNotes: bookingsTable.internalNotes,
  notes: bookingsTable.notes,
  parentId: bookingsTable.parentId,
  serviceLabel: bookingsTable.serviceLabel,
  isParentContract: bookingsTable.isParentContract,
  photoCount: bookingsTable.photoCount,
  includedRetouchedPhotosSnapshot: bookingsTable.includedRetouchedPhotosSnapshot,
  servicePackageId: bookingsTable.servicePackageId,
  requiredRoles: bookingsTable.requiredRoles,
  deductions: bookingsTable.deductions,
  createdByStaffId: bookingsTable.createdByStaffId,
  additionalServices: bookingsTable.additionalServices,
  createdAt: bookingsTable.createdAt,
};

router.get("/bookings", async (req, res) => {
  try {
  const status = req.query.status as string | undefined;
  // Báo giá tạm (temp_quote) mặc định BỊ LOẠI khỏi mọi danh sách — chỉ trả về khi
  // caller chủ động xin (lịch chụp truyền includeTempQuotes=1, hoặc filter status=temp_quote).
  const includeTempQuotes = req.query.includeTempQuotes === "1" || status === "temp_quote";
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  const parentId = req.query.parentId ? parseInt(req.query.parentId as string) : undefined;
  // Advanced filters (Task #173)
  const shootMonth = req.query.shootMonth as string | undefined;       // "YYYY-MM"
  const serviceCategory = req.query.serviceCategory as string | undefined;
  const staffStatus = req.query.staffStatus as string | undefined;     // "unassigned"|"understaffed"|"ready"
  const paymentStatus = req.query.paymentStatus as string | undefined; // "debt"|"paid"
  const progressStatus = req.query.progressStatus as string | undefined; // "pending"|"in_progress"|"paused"|"done"|"overdue"

  // q === undefined  → not passed at all (main bookings list, no limit)
  // q === ""         → explicitly passed empty (?q=), return 10 most recent
  // q === "..."      → search term, return matching results
  const hasQParam = req.query.q !== undefined;
  const q = hasQParam ? (req.query.q as string).trim() : undefined;

  const searchCondition = q
    ? or(
        ilike(bookingsTable.orderCode, `%${q}%`),
        ilike(bookingsTable.serviceLabel, `%${q}%`),
        ilike(bookingsTable.packageType, `%${q}%`),
        ilike(customersTable.name, `%${q}%`),
        ilike(customersTable.phone, `%${q}%`),
      )
    : undefined;

  // Build shoot month date range condition
  let shootMonthCondition: ReturnType<typeof and> | undefined;
  if (shootMonth && /^\d{4}-\d{2}$/.test(shootMonth)) {
    const [yr, mo] = shootMonth.split("-");
    const startDate = `${yr}-${mo}-01`;
    const lastDay = new Date(parseInt(yr), parseInt(mo), 0).getDate();
    const endDate = `${yr}-${mo}-${String(lastDay).padStart(2, "0")}`;
    shootMonthCondition = and(gte(bookingsTable.shootDate, startDate), lte(bookingsTable.shootDate, endDate));
  }

  const baseQuery = db
    .select(bookingFields)
    .from(bookingsTable)
    .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
    .where(
      and(
        isNull(bookingsTable.deletedAt), // Thùng rác: ẩn booking đã xoá mềm khỏi danh sách active
        includeTempQuotes ? undefined : ne(bookingsTable.status, "temp_quote"),
        status ? eq(bookingsTable.status, status) : undefined,
        customerId ? eq(bookingsTable.customerId, customerId) : undefined,
        parentId ? eq(bookingsTable.parentId, parentId) : undefined,
        serviceCategory ? eq(bookingsTable.serviceCategory, serviceCategory) : undefined,
        shootMonthCondition,
        searchCondition,
      )
    )
    .orderBy(desc(bookingsTable.createdAt));

  // Only limit when ?q param was explicitly included in the URL but has no text
  // (= "show recent 10" mode for the booking-link dropdown)
  const rows = (hasQParam && !q)
    ? await baseQuery.limit(10)
    : await baseQuery;

  const allPayments = await db.select().from(paymentsTable);

  // ── Build paidByBookingId map (tổng payments theo booking_id, loại voided) ─
  const paidByBookingId: Record<number, number> = {};
  for (const p of allPayments) {
    // Nguồn tiền chuẩn: "đã thu" loại phiếu hoàn (refund), phiếu hủy (voided), thu lẻ (ad_hoc).
    if (p.bookingId != null && isCollectedPayment(p)) {
      paidByBookingId[p.bookingId] = (paidByBookingId[p.bookingId] ?? 0) + money(p.amount);
    }
  }

  // ── Build bookingInfoMap để tra cứu totalAmount/discountAmount của parent ─
  // Cần cho child booking để tính remainingAmount theo parent
  const bookingInfoMap: Record<number, { totalAmount: number; discountAmount: number }> = {};
  for (const r of rows) {
    bookingInfoMap[r.id] = {
      totalAmount:    parseFloat(r.totalAmount),
      discountAmount: parseFloat(r.discountAmount ?? "0"),
    };
  }

  // Hardening: nếu query có filter (status, search...), parent booking có thể
  // không có trong rows. Fetch bổ sung các parent còn thiếu từ DB.
  const missingParentIds = [...new Set(
    rows
      .filter(r => r.parentId != null && !bookingInfoMap[r.parentId])
      .map(r => r.parentId as number)
  )];
  if (missingParentIds.length > 0) {
    const parentRows = await db
      .select({ id: bookingsTable.id, totalAmount: bookingsTable.totalAmount, discountAmount: bookingsTable.discountAmount })
      .from(bookingsTable)
      .where(inArray(bookingsTable.id, missingParentIds));
    for (const pr of parentRows) {
      bookingInfoMap[pr.id] = {
        totalAmount:    parseFloat(pr.totalAmount),
        discountAmount: parseFloat(pr.discountAmount ?? "0"),
      };
    }
  }

  // Fetch all task rows for bookings — JOIN staff để lấy tên assignee
  const taskAggRows = await db
    .select({
      bookingId: tasksTable.bookingId,
      role: tasksTable.role,
      taskType: tasksTable.taskType,
      assigneeId: tasksTable.assigneeId,
      status: tasksTable.status,
      assigneeName: staffTable.name,
    })
    .from(tasksTable)
    .leftJoin(staffTable, eq(tasksTable.assigneeId, staffTable.id))
    .where(sql`${tasksTable.bookingId} is not null`);

  // Build maps per booking
  type TaskAssignee = { role: string | null; taskType: string | null; assigneeName: string; status: string };
  const taskCountMap: Record<number, number> = {};
  const productionCostMap: Record<number, number> = {};
  const coveredRolesMap: Record<number, Set<string>> = {};
  const taskAssigneesMap: Record<number, TaskAssignee[]> = {};

  for (const row of taskAggRows) {
    if (row.bookingId == null) continue;
    const bid = row.bookingId;
    taskCountMap[bid] = (taskCountMap[bid] ?? 0) + 1;
    if (!coveredRolesMap[bid]) coveredRolesMap[bid] = new Set();
    if (row.assigneeId != null && row.role) coveredRolesMap[bid].add(row.role);
    // Chỉ thêm vào taskAssigneesMap khi có assignee
    if (row.assigneeName) {
      if (!taskAssigneesMap[bid]) taskAssigneesMap[bid] = [];
      taskAssigneesMap[bid].push({
        role: row.role,
        taskType: row.taskType,
        assigneeName: row.assigneeName,
        status: row.status,
      });
    }
  }

  // Sum productionCost separately using SQL aggregate
  const costAgg = await db
    .select({
      bookingId: tasksTable.bookingId,
      totalCost: sql<string>`coalesce(sum(${tasksTable.cost}), 0)::text`,
    })
    .from(tasksTable)
    .where(sql`${tasksTable.bookingId} is not null`)
    .groupBy(tasksTable.bookingId);

  for (const row of costAgg) {
    if (row.bookingId != null) productionCostMap[row.bookingId] = parseFloat(row.totalCost);
  }

  // Fetch photoshop_jobs status for all bookings (for progressStatus field + filter)
  const today = new Date().toISOString().slice(0, 10);
  const progressStatusMap: Record<number, string> = {};
  {
    const allBookingIds = rows.map(r => r.id);
    if (allBookingIds.length > 0) {
      const jobRows = await db
        .select({ bookingId: photoshopJobsTable.bookingId, status: photoshopJobsTable.status, internalDeadline: photoshopJobsTable.internalDeadline })
        .from(photoshopJobsTable)
        .where(and(inArray(photoshopJobsTable.bookingId, allBookingIds), eq(photoshopJobsTable.isActive, true)));
      for (const job of jobRows) {
        if (job.bookingId == null) continue;
        const dl = job.internalDeadline as string | null;
        const st = job.status as string;
        let ps: string;
        if (!job.status) ps = "pending";
        else if (st === "hoan_thanh") ps = "done";
        else if (st === "tam_hoan") ps = "paused";
        else if (dl && dl < today && st !== "hoan_thanh") ps = "overdue";
        else if (st === "dang_xu_ly" || st === "cho_duyet") ps = "in_progress";
        else ps = "pending";
        progressStatusMap[job.bookingId] = ps;
      }
    }
  }

  // Collect unique serviceIds from booking items to fetch durations
  const allServiceIds = new Set<number>();
  for (const row of rows) {
    const items = Array.isArray(row.items) ? (row.items as Array<{ serviceId?: number | null }>) : [];
    for (const item of items) {
      if (item.serviceId) allServiceIds.add(item.serviceId);
    }
  }
  const serviceDurationMap: Record<number, string | null> = {};
  if (allServiceIds.size > 0) {
    const svcRows = await db
      .select({ id: servicesTable.id, duration: servicesTable.duration })
      .from(servicesTable)
      .where(inArray(servicesTable.id, [...allServiceIds]));
    for (const s of svcRows) {
      serviceDurationMap[s.id] = s.duration ?? null;
    }
  }

  let bookings = rows.map((b) => {
    const totalAmount = parseFloat(b.totalAmount);
    const discountAmt = parseFloat(b.discountAmount ?? "0");
    const productionCost = productionCostMap[b.id] ?? 0;

    // ── Tính paidAmount và remainingAmount theo đúng logic parent/child ──────
    // Child booking (parentId != null): dùng payments của PARENT
    // Standalone/Parent booking (parentId == null): dùng payments của chính nó
    let paidAmount: number;
    let remainingAmount: number;

    if (b.parentId != null) {
      // Child booking → paidAmount từ parent's payments
      paidAmount = paidByBookingId[b.parentId] ?? 0;
      // remainingAmount = parent.totalAmount - parent.discountAmount - parentPaidAmount
      const parentInfo = bookingInfoMap[b.parentId];
      const parentTotal    = parentInfo?.totalAmount    ?? totalAmount;
      const parentDiscount = parentInfo?.discountAmount ?? discountAmt;
      remainingAmount = Math.max(0, parentTotal - parentDiscount - paidAmount);
    } else {
      // Standalone hoặc parent booking → dùng payments của chính nó
      paidAmount = paidByBookingId[b.id] ?? 0;
      remainingAmount = Math.max(0, totalAmount - discountAmt - paidAmount);
    }

    const reqRoles = (b.requiredRoles as string[]) ?? [];
    const covRoles = [...(coveredRolesMap[b.id] ?? new Set<string>())];
    const taskCnt = taskCountMap[b.id] ?? 0;
    let bStaffStatus: string;
    if (taskCnt === 0 || reqRoles.length === 0) bStaffStatus = "unassigned";
    else if (reqRoles.every(r => covRoles.includes(r))) bStaffStatus = "ready";
    else bStaffStatus = "understaffed";

    const bProgressStatus = progressStatusMap[b.id] ?? "pending";

    // Derive shootDuration from first item's service duration
    const bItems = Array.isArray(b.items) ? (b.items as Array<{ serviceId?: number | null }>) : [];
    const firstSvcId = bItems[0]?.serviceId ?? null;
    const shootDuration = firstSvcId ? (serviceDurationMap[firstSvcId] ?? null) : null;

    return {
      ...b,
      items: normalizeItemStaff(b.items),
      totalAmount,
      depositAmount: parseFloat(b.depositAmount),
      paidAmount,
      discountAmount: discountAmt,
      remainingAmount,
      taskCount: taskCnt,
      productionCost,
      profit: totalAmount - discountAmt - productionCost,
      requiredRoles: reqRoles,
      coveredRoles: covRoles,
      taskAssignees: taskAssigneesMap[b.id] ?? [],
      staffStatus: bStaffStatus,
      progressStatus: bProgressStatus,
      shootDuration,
    };
  });

  // Apply post-filters
  if (staffStatus) {
    bookings = bookings.filter(b => b.staffStatus === staffStatus);
  }
  if (paymentStatus === "debt") {
    bookings = bookings.filter(b => b.remainingAmount > 0);
  } else if (paymentStatus === "paid") {
    bookings = bookings.filter(b => b.remainingAmount <= 0);
  }
  if (progressStatus) {
    bookings = bookings.filter(b => b.progressStatus === progressStatus);
  }

  res.json(bookings);
  } catch (err) {
    console.error("GET /bookings error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// ─── Thùng rác Booking — danh sách booking đã xoá mềm (CHỈ admin) ───────────
// Đặt TRƯỚC GET /bookings/:id để "trash" không bị bắt nhầm thành :id.
router.get("/bookings/trash", async (req, res) => {
  try {
    if ((await getCallerRole(req.headers.authorization)) !== "admin") {
      return res.status(403).json({ error: "Chỉ admin được xem thùng rác" });
    }
    const rows = await db
      .select({
        ...bookingFields,
        deletedAt: bookingsTable.deletedAt,
        deletedBy: bookingsTable.deletedBy,
        deleteReason: bookingsTable.deleteReason,
        deletedByName: staffTable.name,
      })
      .from(bookingsTable)
      .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
      .leftJoin(staffTable, eq(bookingsTable.deletedBy, staffTable.id))
      // Hiện: đơn lẻ/đơn cha đã xoá + đơn con bị xoá LẺ (cha còn sống). Ẩn con khi
      // cha CŨNG bị xoá (cascade) để khỏi trùng — cha đại diện cho cả cụm.
      .where(sql`${bookingsTable.deletedAt} IS NOT NULL
        AND (${bookingsTable.parentId} IS NULL
          OR NOT EXISTS (SELECT 1 FROM bookings p WHERE p.id = ${bookingsTable.parentId} AND p.deleted_at IS NOT NULL))`)
      .orderBy(desc(bookingsTable.deletedAt));
    res.json(rows);
  } catch (err) {
    console.error("GET /bookings/trash error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi tải thùng rác" });
  }
});

router.post("/bookings", async (req, res) => {
  try {
  const callerId = verifyToken(req.headers.authorization) || null;
  const {
    customerId, shootDate, shootTime, serviceCategory, packageType, location,
    totalAmount, depositAmount, discountAmount, items, surcharges, notes, internalNotes,
    assignedStaff, parentId, serviceLabel, isParentContract, includedRetouchedPhotosSnapshot,
    // Deposit payment fields
    depositPaymentMethod, depositCollector, depositPaidDate, depositPaidAt,
    // Multi-service contract support
    subServices,
    // Task #24: link to package (tracking only)
    servicePackageId,
    // Task #55: deductions
    deductions,
    additionalServices,
    packageTotal,
  } = req.body;

  const depMethod    = depositPaymentMethod || "cash";
  const depCollector = depositCollector     || null;
  // Khi user chỉ gửi giờ qua depositPaidAt mà không gửi ngày → derive ngày từ datetime
  // theo VN local tz (en-CA cho format YYYY-MM-DD), tránh drift quanh nửa đêm.
  const vnDateOf = (iso: string) =>
    new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
  const depPaidDateResolved = depositPaidDate
    || (depositPaidAt ? vnDateOf(depositPaidAt) : null);

  // Báo giá tạm tính: status "temp_quote", mã BG riêng (không chiếm dãy DH),
  // không tạo phiếu cọc, không tạo job hậu kỳ — chưa phải đơn thật.
  const isTempQuote = req.body.isTempQuote === true;

  const count = await db.select().from(bookingsTable);
  const bgCount = count.filter(b => (b.orderCode ?? "").startsWith("BG")).length;
  const orderCode = isTempQuote
    ? `BG${String(bgCount + 1).padStart(4, "0")}`
    : `DH${String(count.length - bgCount + 1).padStart(4, "0")}`;

  // ── Multi-service contract: create parent + children atomically ──
  if (subServices && Array.isArray(subServices) && subServices.length > 0) {
    // 1. Create parent contract booking
    const [parent] = await db
      .insert(bookingsTable)
      .values({
        orderCode,
        customerId,
        shootDate,       // contract/signing date
        shootTime: shootTime || "08:00",
        serviceCategory: serviceCategory || "wedding",
        packageType: packageType || `Hợp đồng ${subServices.length} dịch vụ`,
        location: location || null,
        totalAmount: String(totalAmount || 0),
        depositAmount: String(depositAmount || 0),
        discountAmount: String(discountAmount || 0),
        paidAmount: isTempQuote ? "0" : String(depositAmount || 0),
        items: [],
        surcharges: surcharges || [],
        deductions: [],
        notes: notes || null,
        internalNotes: internalNotes || null,
        assignedStaff: assignedStaff || {},
        isParentContract: true,
        status: isTempQuote ? "temp_quote" : "confirmed",
        createdByStaffId: callerId,
      })
      .returning();

    // 2. Create deposit payment for the parent contract
    // (báo giá tạm KHÔNG tạo phiếu thu — chưa có tiền thật)
    if (!isTempQuote && depositAmount && parseFloat(String(depositAmount)) > 0) {
      await db.insert(paymentsTable).values({
        bookingId:     parent.id,
        amount:        String(depositAmount),
        paymentMethod: depMethod,
        paymentType:   "deposit",
        collectorName: depCollector,
        // Ngày + giờ cọc = thời điểm studio thật sự nhận tiền (do user chốt).
        // KHÔNG fallback về shootDate. paidAt là source-of-truth datetime;
        // paidDate giữ phần ngày để đồng bộ — derive từ paidAt nếu user chỉ gửi giờ.
        paidDate:      depPaidDateResolved,
        ...(depositPaidAt ? { paidAt: new Date(depositPaidAt) } : {}),
        notes:         "Cọc giữ lịch",
      });
    }

    // 3. Create child service bookings
    const children = [];
    for (let i = 0; i < subServices.length; i++) {
      const sub = subServices[i];
      const childPkgId = sub.servicePackageId ? parseInt(String(sub.servicePackageId)) : null;
      let childAdditionalServices: AdditionalServiceLine[] = [];
      if (sub.additionalServices !== undefined) {
        childAdditionalServices = await prepareAdditionalServicesForSave(sub.additionalServices, childPkgId);
      }
      const childCode = `${orderCode}-${i + 1}`;
      const [child] = await db
        .insert(bookingsTable)
        .values({
          orderCode: childCode,
          customerId,
          shootDate: sub.shootDate || shootDate,
          shootTime: sub.shootTime || "08:00",
          serviceCategory: serviceCategory || "wedding",
          packageType: sub.serviceLabel || sub.items?.[0]?.serviceName || `Dịch vụ ${i + 1}`,
          location: sub.location || location || null,
          totalAmount: String(sub.totalAmount || 0),
          depositAmount: "0",
          discountAmount: "0",
          paidAmount: "0",
          items: await normalizeBookingItemsCast(sub.items || [], null),
          surcharges: sub.surcharges || [],
          deductions: sanitizeDeductions(sub.deductions),
          notes: sub.notes || null,
          internalNotes: null,
          assignedStaff: sub.assignedStaff || {},
          parentId: parent.id,
          serviceLabel: sub.serviceLabel || null,
          isParentContract: false,
          status: isTempQuote ? "temp_quote" : (sub.status || "confirmed"),
          createdByStaffId: callerId,
          additionalServices: childAdditionalServices,
        })
        .returning();
      if (!isTempQuote) await maybeCreatePhotoshopJobForBooking(child.id).catch(() => {});
      children.push(child);
    }

    const newParentTotal = await recalcParentTotalFromChildren(parent.id);
    const [parentRefreshed] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, parent.id));

    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
    emitNotification({
      staffId: null,
      senderStaffId: callerId ?? null,
      type: "booking_new",
      title: isTempQuote ? `Báo giá tạm ${parent.orderCode} (hợp đồng gộp)` : "Lịch mới (hợp đồng gộp)",
      message: `Khách ${customer.name} — ${parent.serviceLabel || "Chưa rõ dịch vụ"}`,
      targetModule: "calendar",
      targetId: String(parent.id),
      bookingId: parent.id,
    });
    res.status(201).json({
      ...(parentRefreshed ?? parent),
      customerName: customer.name,
      customerPhone: customer.phone,
      totalAmount: newParentTotal,
      depositAmount: parseFloat(parent.depositAmount),
      paidAmount: parseFloat(parent.paidAmount),
      discountAmount: parseFloat(parent.discountAmount ?? "0"),
      remainingAmount: Math.max(0, parseFloat(parent.totalAmount) - parseFloat(parent.discountAmount ?? "0") - parseFloat(parent.paidAmount)),
      children: children.map(c => ({ ...c, totalAmount: parseFloat(c.totalAmount) })),
    });
    return;
  }

  // ── Single booking (existing behavior) ──

  // Task #24: nếu có servicePackageId, snapshot items + includedRetouchedPhotos từ package
  let snapshotItems = items || [];
  let snapshotRetouched = includedRetouchedPhotosSnapshot != null ? parseInt(String(includedRetouchedPhotosSnapshot)) : 0;
  if (servicePackageId) {
    const pkgId = parseInt(String(servicePackageId));
    const [pkg] = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.id, pkgId));
    if (pkg) {
      const pkgItems = await db.select().from(packageItemsTable).where(eq(packageItemsTable.packageId, pkgId)).orderBy(asc(packageItemsTable.sortOrder));
      if (pkgItems.length > 0 && snapshotItems.length === 0) snapshotItems = pkgItems;
      if (!includedRetouchedPhotosSnapshot) snapshotRetouched = (pkg as { includedRetouchedPhotos?: number }).includedRetouchedPhotos ?? 0;
    }
  }

  const pkgIdForCast = servicePackageId ? parseInt(String(servicePackageId)) : null;
  snapshotItems = await normalizeBookingItemsCast(snapshotItems, pkgIdForCast);

  let snapshotAdditionalServices: AdditionalServiceLine[] = [];
  if (additionalServices !== undefined) {
    snapshotAdditionalServices = await prepareAdditionalServicesForSave(additionalServices, pkgIdForCast);
  }

  const [booking] = await db
    .insert(bookingsTable)
    .values({
      orderCode,
      customerId,
      shootDate,
      shootTime,
      serviceCategory: serviceCategory || "wedding",
      packageType,
      location,
      totalAmount: String(totalAmount),
      depositAmount: String(depositAmount || 0),
      discountAmount: String(discountAmount || 0),
      paidAmount: isTempQuote ? "0" : String(depositAmount || 0),
      items: snapshotItems,
      surcharges: surcharges || [],
      deductions: isParentContract ? [] : sanitizeDeductions(deductions),
      notes,
      internalNotes,
      assignedStaff: assignedStaff || [],
      parentId: parentId || null,
      serviceLabel: serviceLabel || null,
      isParentContract: isParentContract || false,
      includedRetouchedPhotosSnapshot: snapshotRetouched,
      servicePackageId: servicePackageId ? parseInt(String(servicePackageId)) : null,
      status: isTempQuote ? "temp_quote" : "pending",
      createdByStaffId: callerId,
      additionalServices: snapshotAdditionalServices,
    })
    .returning();

  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));

  // Báo giá tạm KHÔNG tạo phiếu thu — chưa có tiền thật
  if (!isTempQuote && depositAmount && parseFloat(String(depositAmount)) > 0) {
    await db.insert(paymentsTable).values({
      bookingId:     booking.id,
      amount:        String(depositAmount),
      paymentMethod: depMethod,
      paymentType:   "deposit",
      collectorName: depCollector,
      // Ngày + giờ cọc = thời điểm studio thật sự nhận tiền (do user chốt).
      // KHÔNG fallback về shootDate. paidAt là source-of-truth datetime;
      // paidDate đồng bộ từ paidAt nếu user chỉ gửi giờ.
      paidDate:      depPaidDateResolved,
      ...(depositPaidAt ? { paidAt: new Date(depositPaidAt) } : {}),
      notes:         "Cọc giữ lịch",
    });
  }

  // Lookup tên người tạo đơn để hiện trong notification
  let creatorName = "Hệ thống";
  if (callerId) {
    const [creator] = await db.select({ name: staffTable.name }).from(staffTable).where(eq(staffTable.id, callerId));
    if (creator?.name) creatorName = creator.name;
  }
  if (!isTempQuote) await maybeCreatePhotoshopJobForBooking(booking.id).catch(err => console.warn("[bookings] maybeCreatePhotoshopJob POST failed:", err));

  const orderCodeStr = booking.orderCode ? ` ${booking.orderCode}` : "";
  emitNotification({
    staffId: null,
    senderStaffId: callerId ?? null,
    type: "booking_new",
    title: isTempQuote
      ? `Báo giá tạm${orderCodeStr} — ${customer.name}`
      : `Lịch chụp mới${orderCodeStr} — ${customer.name}`,
    message: `${creatorName} vừa tạo ${isTempQuote ? "báo giá tạm tính" : "đơn"} cho khách ${customer.name}${booking.serviceLabel ? ` — ${booking.serviceLabel}` : ""}${booking.shootDate ? ` (${booking.shootDate}${booking.shootTime ? " " + booking.shootTime : ""})` : ""}`,
    targetModule: "calendar",
    targetId: String(booking.id),
    bookingId: booking.id,
  });
  res.status(201).json({
    ...booking,
    customerName: customer.name,
    customerPhone: customer.phone,
    totalAmount: parseFloat(booking.totalAmount),
    depositAmount: parseFloat(booking.depositAmount),
    paidAmount: parseFloat(booking.paidAmount),
    discountAmount: parseFloat(booking.discountAmount ?? "0"),
    remainingAmount: Math.max(0, parseFloat(booking.totalAmount) - parseFloat(booking.discountAmount ?? "0") - parseFloat(booking.paidAmount)),
  });
  } catch (err) {
    if (err instanceof AdditionalServicesValidationError) {
      return res.status(400).json({ error: err.message, errors: err.errors });
    }
    console.error("POST /bookings error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi tạo đơn hàng" });
  }
});

router.get("/bookings/:id", async (req, res) => {
  try {
  const id = parseInt(req.params.id);
  const [row] = await db
    .select(bookingFields)
    .from(bookingsTable)
    .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
    .where(eq(bookingsTable.id, id));

  if (!row) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });

  const paymentBookingId = row.parentId ?? id;
  const payments = await db.select().from(paymentsTable).where(eq(paymentsTable.bookingId, paymentBookingId));

  // Expenses: child/standalone = this booking only; parent contract = parent + all children
  let expenseBookingIds: number[] = [id];
  let children: unknown[] = [];
  if (row.isParentContract) {
    const childRows = await db
      .select(bookingFields)
      .from(bookingsTable)
      .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
      .where(eq(bookingsTable.parentId, id))
      .orderBy(bookingsTable.shootDate);
    expenseBookingIds = [id, ...childRows.map((c) => c.id)];
    children = childRows.map((c) => ({
      ...c,
      items: normalizeItemStaff(c.items),
      totalAmount: parseFloat(c.totalAmount),
      depositAmount: parseFloat(c.depositAmount),
    }));
  }

  const expenses = expenseBookingIds.length === 1
    ? await db.select().from(expensesTable).where(eq(expensesTable.bookingId, id))
        .orderBy(desc(expensesTable.expenseAt), desc(expensesTable.expenseDate), desc(expensesTable.createdAt))
    : await db.select().from(expensesTable).where(inArray(expensesTable.bookingId, expenseBookingIds))
        .orderBy(desc(expensesTable.expenseAt), desc(expensesTable.expenseDate), desc(expensesTable.createdAt));
  const tasks = await db
    .select({
      id: tasksTable.id, title: tasksTable.title, category: tasksTable.category,
      status: tasksTable.status, priority: tasksTable.priority, dueDate: tasksTable.dueDate,
      assigneeId: tasksTable.assigneeId, assigneeName: staffTable.name,
      role: tasksTable.role, taskType: tasksTable.taskType,
      cost: tasksTable.cost,
    })
    .from(tasksTable)
    .leftJoin(staffTable, eq(tasksTable.assigneeId, staffTable.id))
    .where(eq(tasksTable.bookingId, id));

  const paidAmount = payments
    .filter(isCollectedPayment)
    .reduce((s, p) => s + money(p.amount), 0);
  const totalAmount = parseFloat(row.totalAmount);
  const discountAmt = parseFloat(row.discountAmount ?? "0");
  const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);

  // Lookup creator name
  let createdByStaffName: string | null = null;
  if (row.createdByStaffId) {
    const [creator] = await db
      .select({ name: staffTable.name })
      .from(staffTable)
      .where(eq(staffTable.id, row.createdByStaffId));
    createdByStaffName = creator?.name ?? null;
  }
  const productionCost = tasks.reduce((s, t) => s + (t.cost != null ? parseFloat(t.cost as string) : 0), 0);
  const coveredRoles = [...new Set(tasks.filter(t => t.assigneeId != null && t.role).map(t => t.role as string))];

  // ── If this booking is a child (has parentId), fetch siblings + parent ──
  let siblings: unknown[] = [];
  let parentContract: unknown = null;

  if (row.parentId) {
    const siblingRows = await db
      .select(bookingFields)
      .from(bookingsTable)
      .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
      .where(and(eq(bookingsTable.parentId, row.parentId)))
      .orderBy(bookingsTable.shootDate);

    const siblingIds = siblingRows.map(s => s.id);
    const siblingTaskRows = siblingIds.length > 0
      ? await db
          .select({
            bookingId: tasksTable.bookingId,
            role: tasksTable.role,
            taskType: tasksTable.taskType,
            assigneeId: tasksTable.assigneeId,
            assigneeName: staffTable.name,
            status: tasksTable.status,
          })
          .from(tasksTable)
          .leftJoin(staffTable, eq(tasksTable.assigneeId, staffTable.id))
          .where(sql`${tasksTable.bookingId} in ${siblingIds}`)
      : [];
    const sibTaskMap: Record<number, { role: string | null; taskType: string | null; assigneeName: string; status: string }[]> = {};
    for (const tr of siblingTaskRows) {
      if (tr.bookingId == null || !tr.assigneeName) continue;
      if (!sibTaskMap[tr.bookingId]) sibTaskMap[tr.bookingId] = [];
      sibTaskMap[tr.bookingId].push({ role: tr.role, taskType: tr.taskType, assigneeName: tr.assigneeName, status: tr.status });
    }

    siblings = siblingRows.map(s => ({
      ...s,
      items: normalizeItemStaff(s.items),
      totalAmount: parseFloat(s.totalAmount),
      depositAmount: parseFloat(s.depositAmount),
      taskAssignees: sibTaskMap[s.id] ?? [],
    }));

    const [parentRow] = await db
      .select(bookingFields)
      .from(bookingsTable)
      .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
      .where(eq(bookingsTable.id, row.parentId));

    if (parentRow) {
      const parentPayments = await db.select().from(paymentsTable).where(eq(paymentsTable.bookingId, parentRow.id));
      const parentPaid = parentPayments
    .filter(isCollectedPayment)
    .reduce((s, p) => s + money(p.amount), 0);
      const parentTotal = parseFloat(parentRow.totalAmount);
      const parentDiscount = parseFloat(parentRow.discountAmount ?? "0");
      parentContract = {
        ...parentRow,
        items: normalizeItemStaff(parentRow.items),
        totalAmount: parentTotal,
        depositAmount: parseFloat(parentRow.depositAmount),
        paidAmount: parentPaid,
        discountAmount: parentDiscount,
        remainingAmount: Math.max(0, parentTotal - parentDiscount - parentPaid),
      };
    }
  }

  // children populated above when isParentContract

  // taskAssignees — chỉ những task có assignee
  const taskAssignees = tasks
    .filter(t => t.assigneeName)
    .map(t => ({
      role: t.role,
      taskType: t.taskType,
      assigneeName: t.assigneeName as string,
      status: t.status,
    }));

  // A4: child bookings show contract-level payment balance (parent payments vs parent total)
  let detailRemainingAmount = Math.max(0, totalAmount - discountAmt - paidAmount);
  if (row.parentId && parentContract && typeof parentContract === "object" && parentContract !== null) {
    const pc = parentContract as { totalAmount?: number; discountAmount?: number };
    detailRemainingAmount = Math.max(
      0,
      (pc.totalAmount ?? totalAmount) - (pc.discountAmount ?? discountAmt) - paidAmount,
    );
  }

  res.json({
    ...row,
    items: normalizeItemStaff(row.items),
    totalAmount,
    depositAmount: parseFloat(row.depositAmount),
    paidAmount,
    discountAmount: discountAmt,
    remainingAmount: detailRemainingAmount,
    totalExpenses,
    grossProfit: totalAmount - totalExpenses,
    createdByStaffName,
    payments: payments.map(p => ({ ...p, amount: parseFloat(p.amount) })),
    expenses: expenses.map(e => ({ ...e, amount: parseFloat(e.amount) })),
    tasks,
    taskAssignees,
    siblings,
    parentContract,
    children,
  });
  } catch (err) {
    console.error("GET /bookings/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.put("/bookings/:id", async (req, res) => {
  try {
  const id = parseInt(req.params.id);
  const {
    customerId,
    shootDate, shootTime, serviceCategory, packageType, location, status,
    totalAmount, depositAmount, discountAmount, items, surcharges, notes, internalNotes,
    assignedStaff, parentId, serviceLabel, isParentContract, photoCount, includedRetouchedPhotosSnapshot,
    servicePackageId,
    // Task #55: deductions
    deductions,
    additionalServices,
    packageTotal,
    // Ngày + giờ cọc — CHỈ cập nhật khi field có mặt trong body
    // (frontend chỉ gửi khi user chủ động đổi ô Ngày/Giờ trong block Thanh toán).
    // KHÔNG bao giờ tự suy từ shootDate. paidAt là source-of-truth datetime.
    depositPaidDate, depositPaidAt,
  } = req.body;
  // Derive YYYY-MM-DD theo VN local tz từ datetime ISO, tránh drift quanh nửa đêm.
  const vnDateOf = (iso: string) =>
    new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

  const updateData: Record<string, unknown> = {};
  // Cho phép đổi khách của show (sửa tên/đổi khách). Chỉ nhận id hợp lệ.
  if (customerId !== undefined && customerId !== null) {
    const cidNum = parseInt(String(customerId));
    if (Number.isInteger(cidNum) && cidNum > 0) updateData.customerId = cidNum;
  }
  if (shootDate !== undefined) updateData.shootDate = shootDate;
  if (shootTime !== undefined) updateData.shootTime = shootTime;
  if (serviceCategory !== undefined) updateData.serviceCategory = serviceCategory;
  if (packageType !== undefined) updateData.packageType = packageType;
  if (location !== undefined) updateData.location = location;
  if (status !== undefined) updateData.status = status;
  if (totalAmount !== undefined) updateData.totalAmount = String(totalAmount);
  if (depositAmount !== undefined) updateData.depositAmount = String(depositAmount);
  if (discountAmount !== undefined) updateData.discountAmount = String(discountAmount);
  if (items !== undefined) updateData.items = items;
  if (surcharges !== undefined) updateData.surcharges = surcharges;
  if (notes !== undefined) updateData.notes = notes;
  if (internalNotes !== undefined) updateData.internalNotes = internalNotes;
  if (assignedStaff !== undefined) updateData.assignedStaff = assignedStaff;
  if (parentId !== undefined) updateData.parentId = parentId;
  if (serviceLabel !== undefined) updateData.serviceLabel = serviceLabel;
  if (isParentContract !== undefined) updateData.isParentContract = isParentContract;
  if (photoCount !== undefined) updateData.photoCount = photoCount !== null ? parseInt(String(photoCount)) : null;
  if (includedRetouchedPhotosSnapshot !== undefined) updateData.includedRetouchedPhotosSnapshot = parseInt(String(includedRetouchedPhotosSnapshot)) || 0;
  if (servicePackageId !== undefined) updateData.servicePackageId = servicePackageId ? parseInt(String(servicePackageId)) : null;

  // Check booking exists. Đọc đầy đủ field để diff trước/sau, ghi lịch sử sửa đơn.
  const [oldBooking] = await db
    .select({
      status: bookingsTable.status,
      customerId: bookingsTable.customerId,
      parentId: bookingsTable.parentId,
      isParentContract: bookingsTable.isParentContract,
      orderCode: bookingsTable.orderCode,
      shootDate: bookingsTable.shootDate,
      shootTime: bookingsTable.shootTime,
      location: bookingsTable.location,
      totalAmount: bookingsTable.totalAmount,
      depositAmount: bookingsTable.depositAmount,
      discountAmount: bookingsTable.discountAmount,
      notes: bookingsTable.notes,
      items: bookingsTable.items,
    })
    .from(bookingsTable)
    .where(eq(bookingsTable.id, id));
  if (!oldBooking) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
  const oldStatus = oldBooking.status;

  // A8: parent contracts ignore client totalAmount — derived from Σ children
  if (oldBooking.isParentContract) {
    delete updateData.totalAmount;
  }
  const callerId = verifyToken(req.headers.authorization) || null;

  // Task #55: enforce deductions = [] for parent contracts (always, regardless of body)
  if (oldBooking.isParentContract) {
    updateData.deductions = [];
  } else if (deductions !== undefined) {
    updateData.deductions = sanitizeDeductions(deductions);
  }

  if (additionalServices !== undefined) {
    const pkgForExtras =
      servicePackageId !== undefined
        ? (servicePackageId ? parseInt(String(servicePackageId)) : null)
        : (oldBooking as { servicePackageId?: number | null }).servicePackageId ?? null;
    updateData.additionalServices = await prepareAdditionalServicesForSave(
      additionalServices,
      pkgForExtras,
    );
  }

  // ── Staff sync logic ──────────────────────────────────────────────────────
  // Helper: normalize role aliases (photo ↔ photographer, etc.)
  const normalizeRoleStr = (role: string): string => {
    const r = role.toLowerCase();
    return r === "photo" ? "photographer" : r;
  };

  // Sync legacy photoName/photoId/makeupName/makeupId fields from each item's
  // assignedStaff array. This is needed because the StaffAssignmentEditor only
  // mutates assignedStaff[], so item.photoName can become stale after a
  // photographer change — leading to calendar cards showing the OLD name while
  // detail shows the NEW one (the exact bug reported by users).
  //
  // IMPORTANT: only sync when item EXPLICITLY includes `assignedStaff` (even
  // if empty array). If the field is OMITTED (legacy payload that only sets
  // photoName directly), preserve existing photoName/photoId — do NOT blank
  // it. This prevents data loss for older clients.
  const syncItemLegacyFields = (item: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = { ...item };
    if (!Object.prototype.hasOwnProperty.call(item, "assignedStaff")) {
      return result; // legacy item — leave photoName/photoId untouched
    }
    const itemStaff: StaffAssignmentLike[] = Array.isArray(item.assignedStaff)
      ? (item.assignedStaff as StaffAssignmentLike[])
      : [];
    const photographer = itemStaff.find(s => normalizeRoleStr(s.role ?? "") === "photographer");
    const makeup = itemStaff.find(s => normalizeRoleStr(s.role ?? "") === "makeup");
    if (photographer) {
      result.photoName = photographer.staffName ?? "";
      result.photoId = photographer.staffId ?? null;
    } else {
      result.photoName = "";
      result.photoId = null;
    }
    if (makeup) {
      result.makeupName = makeup.staffName ?? "";
      result.makeupId = makeup.staffId ?? null;
    } else {
      result.makeupName = "";
      result.makeupId = null;
    }
    return result;
  };

  // Case A: items provided in body — items[].assignedStaff is the source of truth.
  //   Just sync legacy fields (photoName/photoId etc) to keep all modules in sync.
  //   Do NOT inject top-level assignedStaff into items[] — that caused cumulative
  //   sales/photoshop duplication on every save (reported bug).
  if (items !== undefined && Array.isArray(items)) {
    const pkgIdForCast =
      servicePackageId !== undefined
        ? (servicePackageId ? parseInt(String(servicePackageId)) : null)
        : undefined;
    const castNormalized = await normalizeBookingItemsCast(items, pkgIdForCast ?? null);
    updateData.items = (castNormalized as Record<string, unknown>[]).map(syncItemLegacyFields);
  }
  // Case B (legacy): only top-level assignedStaff provided, no items — write-back
  //   into the existing items[].assignedStaff so other modules see the change.
  else if (assignedStaff !== undefined && Array.isArray(assignedStaff)) {
    const normalizedStaff = (assignedStaff as StaffAssignmentLike[]).map(sa => ({
      ...sa,
      role: sa.role ? normalizeRoleStr(sa.role) : sa.role,
    }));

    const [bk] = await db.select({ items: bookingsTable.items }).from(bookingsTable).where(eq(bookingsTable.id, id));
    const currentItems: Record<string, unknown>[] = bk && Array.isArray(bk.items)
      ? (bk.items as Record<string, unknown>[])
      : [];

    const mergedItems = currentItems.map((item) => {
      const result: Record<string, unknown> = { ...item };

      if (normalizedStaff.length === 0) {
        result.assignedStaff = [];
      } else {
        const itemStaff: StaffAssignmentLike[] = Array.isArray(item.assignedStaff)
          ? (item.assignedStaff as StaffAssignmentLike[]).map(s => ({
              ...s,
              role: s.role ? normalizeRoleStr(s.role) : s.role,
            }))
          : [];

        // Replace by role; only append if no entry with that role exists yet
        for (const sa of normalizedStaff) {
          const idx = itemStaff.findIndex(s => (s.role ?? "") === (sa.role ?? ""));
          if (idx >= 0) {
            itemStaff[idx] = { ...itemStaff[idx], ...sa };
          } else {
            itemStaff.push(sa);
          }
        }
        result.assignedStaff = itemStaff;
      }

      return syncItemLegacyFields(result);
    });

    updateData.items = mergedItems;
  }

  // Run all changes in a single DB transaction: deposit payment upsert + booking update + recalculate
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── 1. Upsert/delete deposit payment record (only if depositAmount is in body) ──
    if (depositAmount !== undefined) {
      const newDepositAmount = parseFloat(String(depositAmount));

      const depResult = await client.query<{ id: number }>(
        `SELECT id FROM payments WHERE booking_id = $1 AND payment_type = 'deposit' ORDER BY id ASC`,
        [id]
      );
      const depRecords = depResult.rows;

      // Delete duplicates, keep oldest
      if (depRecords.length > 1) {
        for (const r of depRecords.slice(1)) {
          await client.query(`DELETE FROM payments WHERE id = $1`, [r.id]);
        }
      }

      if (newDepositAmount > 0) {
        // Derive paid_date từ depositPaidAt khi user chỉ gửi giờ → đảm bảo đồng bộ
        // theo VN local tz, tránh drift calendar quanh nửa đêm.
        const resolvedPaidDate =
          depositPaidDate !== undefined
            ? (depositPaidDate || null)
            : (depositPaidAt ? vnDateOf(depositPaidAt) : undefined);
        if (depRecords.length > 0) {
          // CHỈ update paid_date / paid_at khi user chủ động gửi (sửa ô Ngày hoặc Giờ).
          // Nếu chỉ đổi shootDate mà không đụng ngày/giờ cọc → giữ nguyên gốc.
          const sets: string[] = ["amount = $1"];
          const params: unknown[] = [String(newDepositAmount)];
          if (resolvedPaidDate !== undefined) {
            params.push(resolvedPaidDate);
            sets.push(`paid_date = $${params.length}`);
          }
          if (depositPaidAt !== undefined) {
            params.push(depositPaidAt ? new Date(depositPaidAt) : null);
            sets.push(`paid_at = COALESCE($${params.length}::timestamp, paid_at)`);
          }
          params.push(depRecords[0].id);
          await client.query(
            `UPDATE payments SET ${sets.join(", ")} WHERE id = $${params.length}`,
            params
          );
        } else {
          // Tạo record cọc mới — dùng giá trị đã resolve, fallback NOW()
          const paidDateVal = resolvedPaidDate ?? null;
          const paidAtVal = depositPaidAt ? new Date(depositPaidAt) : null;
          await client.query(
            `INSERT INTO payments (booking_id, amount, payment_method, payment_type, paid_date, notes, paid_at)
             VALUES ($1, $2, 'cash', 'deposit', COALESCE($3::date, NOW()::date), 'Cọc giữ lịch', COALESCE($4::timestamp, NOW()))`,
            [id, String(newDepositAmount), paidDateVal, paidAtVal]
          );
        }
      } else {
        if (depRecords.length > 0) {
          await client.query(`DELETE FROM payments WHERE id = $1`, [depRecords[0].id]);
        }
      }
    }

    // ── 2. Recalculate paid_amount from active (non-voided) payments ──
    const paymentBookingId = oldBooking.parentId ?? id;
    const paidAmount = await sumActivePayments(paymentBookingId, client);

    // ── 3. Calculate remaining_amount using effective totals ──
    const bkCurrentResult = await client.query<{ total_amount: string; discount_amount: string }>(
      `SELECT total_amount::numeric AS total_amount, COALESCE(discount_amount::numeric, 0) AS discount_amount FROM bookings WHERE id = $1`,
      [id]
    );
    const bkCurrent = bkCurrentResult.rows[0];
    const effectiveTotalAmount    = totalAmount    !== undefined ? parseFloat(String(totalAmount))    : parseFloat(bkCurrent.total_amount);
    const effectiveDiscountAmount = discountAmount !== undefined ? parseFloat(String(discountAmount)) : parseFloat(bkCurrent.discount_amount);
    const remainingAmount = Math.max(0, effectiveTotalAmount - effectiveDiscountAmount - paidAmount);

    updateData.paidAmount    = String(paidAmount);

    // ── 4. Build and execute booking UPDATE inside the same transaction ──
    const camelToSnake = (s: string) => s.replace(/([A-Z])/g, "_$1").toLowerCase();
    const jsonbColumns = new Set(["items", "surcharges", "assigned_staff", "required_roles", "deductions", "additional_services"]);
    const entries = Object.entries(updateData);
    const setClauses = entries.map(([k], i) => {
      const col = camelToSnake(k);
      return jsonbColumns.has(col) ? `${col} = $${i + 1}::jsonb` : `${col} = $${i + 1}`;
    }).join(", ");
    const params = [...entries.map(([k, v]) => {
      const col = camelToSnake(k);
      return jsonbColumns.has(col) ? JSON.stringify(v) : v;
    }), id];

    const updateResult = await client.query<{ customer_id: number }>(
      `UPDATE bookings SET ${setClauses} WHERE id = $${params.length} RETURNING customer_id`,
      params
    );
    if (updateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
    }

    await client.query("COMMIT");

    const customerId = updateResult.rows[0].customer_id;

    // Post-production: tạo job mới nếu gói yêu cầu hậu kỳ (không sửa job cũ nếu không đủ điều kiện)
    if (items !== undefined || servicePackageId !== undefined) {
      await maybeCreatePhotoshopJobForBooking(id).catch(err => console.warn("[bookings] maybeCreatePhotoshopJob PUT failed:", err));
    }

    // Task #316: Sync photoshop_jobs.total_photos when booking snapshot changes
    // Also handles case where only servicePackageId changes (no explicit snapshot in body)
    if (includedRetouchedPhotosSnapshot !== undefined || servicePackageId !== undefined) {
      let newSnap: number;
      if (includedRetouchedPhotosSnapshot !== undefined) {
        newSnap = parseInt(String(includedRetouchedPhotosSnapshot)) || 0;
      } else {
        // servicePackageId changed without explicit snapshot — resolve from DB
        const snapResult = await pool.query<{ included_retouched_photos_snapshot: number }>(
          `SELECT included_retouched_photos_snapshot FROM bookings WHERE id = $1`,
          [id]
        );
        newSnap = Number(snapResult.rows[0]?.included_retouched_photos_snapshot ?? 0);
      }
      await pool.query(
        `UPDATE photoshop_jobs SET total_photos = $1 WHERE booking_id = $2 AND is_active = true`,
        [newSnap, id]
      );
    }

    if (status === "completed" && oldStatus !== "completed") {
      computeBookingEarnings(id).catch(err => console.error("Earnings compute error:", err));
    }

    // Re-read full booking + customer (outside transaction is fine — data is committed)
    const [[fullBooking], [customer]] = await Promise.all([
      db.select().from(bookingsTable).where(eq(bookingsTable.id, id)),
      db.select({ name: customersTable.name, phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, customerId)),
    ]);

    if (fullBooking?.parentId) {
      await recalcParentTotalFromChildren(fullBooking.parentId);
    } else if (fullBooking?.isParentContract) {
      await recalcParentTotalFromChildren(id);
    }

    const custName = customer?.name || "Khách";
    const orderCode = oldBooking.orderCode || `#${id}`;

    // ── Lịch sử sửa đơn (booking_change_log) + thông báo chi tiết ──
    // Lookup tên người thao tác
    let editorName = "Hệ thống";
    if (callerId) {
      const [editor] = await db.select({ name: staffTable.name }).from(staffTable).where(eq(staffTable.id, callerId));
      if (editor?.name) editorName = editor.name;
    }

    // Helper: format VND
    const fmtVND = (v: unknown): string => {
      const n = parseFloat(String(v ?? 0));
      if (!isFinite(n)) return "0đ";
      return new Intl.NumberFormat("vi-VN").format(n) + "đ";
    };
    // Helper: extract photographer/makeup names from items[]
    const extractStaffByRole = (its: unknown, role: "photographer" | "makeup"): string => {
      if (!Array.isArray(its)) return "";
      const names = new Set<string>();
      for (const it of its as Record<string, unknown>[]) {
        const sa = Array.isArray(it.assignedStaff) ? (it.assignedStaff as { role?: string; staffName?: string }[]) : [];
        for (const s of sa) {
          const r = (s.role || "").toLowerCase().replace("photo", "photographer").replace("photographergrapher", "photographer");
          if (r === role && s.staffName) names.add(s.staffName.trim());
        }
        if (role === "photographer" && it.photoName && typeof it.photoName === "string" && it.photoName.trim()) names.add(it.photoName.trim());
        if (role === "makeup" && it.makeupName && typeof it.makeupName === "string" && it.makeupName.trim()) names.add(it.makeupName.trim());
      }
      return Array.from(names).join(", ");
    };

    // Effective new values (use payload if provided, else fallback to old)
    const newItems = items !== undefined ? updateData.items : oldBooking.items;
    const changes: { field: string; label: string; oldDisplay: string; newDisplay: string }[] = [];
    const pushChange = (field: string, label: string, oldRaw: unknown, newRaw: unknown, formatter?: (v: unknown) => string) => {
      const fmt = formatter || ((v: unknown) => (v == null || v === "" ? "(trống)" : String(v)));
      const oldD = fmt(oldRaw);
      const newD = fmt(newRaw);
      if (oldD !== newD) changes.push({ field, label, oldDisplay: oldD, newDisplay: newD });
    };

    if (shootDate !== undefined) pushChange("shootDate", "ngày chụp", oldBooking.shootDate, shootDate);
    if (shootTime !== undefined) pushChange("shootTime", "giờ chụp", oldBooking.shootTime, shootTime);
    if (location !== undefined) pushChange("location", "địa điểm", oldBooking.location, location);
    if (status !== undefined) pushChange("status", "trạng thái", oldBooking.status, status);
    if (totalAmount !== undefined) pushChange("totalAmount", "tổng tiền", oldBooking.totalAmount, totalAmount, fmtVND);
    if (depositAmount !== undefined) pushChange("depositAmount", "tiền cọc", oldBooking.depositAmount, depositAmount, fmtVND);
    if (discountAmount !== undefined) pushChange("discountAmount", "giảm giá", oldBooking.discountAmount, discountAmount, fmtVND);
    if (notes !== undefined) pushChange("notes", "ghi chú", oldBooking.notes, notes);
    // Diff staff theo từng vai trò (so 2 chuỗi tên đã sort)
    if (items !== undefined || assignedStaff !== undefined) {
      const oldPhoto = extractStaffByRole(oldBooking.items, "photographer");
      const newPhoto = extractStaffByRole(newItems, "photographer");
      const oldMakeup = extractStaffByRole(oldBooking.items, "makeup");
      const newMakeup = extractStaffByRole(newItems, "makeup");
      if (oldPhoto !== newPhoto) changes.push({ field: "photographer", label: "nhiếp ảnh", oldDisplay: oldPhoto || "(chưa có)", newDisplay: newPhoto || "(chưa có)" });
      if (oldMakeup !== newMakeup) changes.push({ field: "makeup", label: "makeup", oldDisplay: oldMakeup || "(chưa có)", newDisplay: newMakeup || "(chưa có)" });
    }

    // Ghi vào booking_change_log
    if (changes.length > 0) {
      try {
        await db.insert(bookingChangeLogTable).values(changes.map(c => ({
          bookingId: id,
          fieldChanged: c.field,
          oldValue: c.oldDisplay,
          newValue: c.newDisplay,
          changedById: callerId,
        })));
      } catch (logErr) {
        console.error("[booking_change_log] insert error:", logErr);
      }
    }

    // Phát thông báo gộp 1 cái duy nhất với danh sách thay đổi
    if (changes.length > 0) {
      // Trường hợp đặc biệt: chỉ đổi trạng thái sang "cancelled" → notification riêng
      const statusChange = changes.find(c => c.field === "status");
      const onlyStatusToCancel = changes.length === 1 && statusChange && status === "cancelled";

      if (onlyStatusToCancel) {
        emitNotification({
          staffId: null,
          senderStaffId: callerId ?? null,
          type: "booking_cancelled",
          title: `Hủy lịch ${orderCode} — ${custName}`,
          message: `${editorName} vừa hủy đơn ${orderCode} (khách ${custName}).`,
          targetModule: "calendar",
          targetId: String(id),
          bookingId: id,
        });
      } else {
        const summary = changes.slice(0, 4).map(c => `${c.label}: ${c.oldDisplay} → ${c.newDisplay}`).join("; ");
        const more = changes.length > 4 ? ` (+${changes.length - 4} thay đổi khác)` : "";
        emitNotification({
          staffId: null,
          senderStaffId: callerId ?? null,
          type: "booking_updated",
          title: `${editorName} sửa đơn ${orderCode} — ${custName}`,
          message: `${summary}${more}`,
          targetModule: "calendar",
          targetId: String(id),
          bookingId: id,
        });
      }
    }

    if (assignedStaff && Array.isArray(assignedStaff)) {
      for (const sa of assignedStaff as { staffId?: number; staffName?: string; role?: string }[]) {
        if (sa.staffId) {
          emitNotification({
            staffId: sa.staffId,
            senderStaffId: callerId ?? null,
            type: "task_assigned",
            title: `Được giao việc — đơn ${orderCode}`,
            message: `${editorName} phân công bạn làm ${sa.role || "việc"} cho đơn ${orderCode} (khách ${custName}).`,
            targetModule: "calendar",
            targetId: String(id),
            bookingId: id,
          });
        }
      }
    }

    res.json({
      ...fullBooking,
      customerName: customer?.name,
      customerPhone: customer?.phone,
      totalAmount:    parseFloat(fullBooking.totalAmount),
      depositAmount:  parseFloat(fullBooking.depositAmount),
      paidAmount,
      discountAmount: parseFloat(fullBooking.discountAmount ?? "0"),
      remainingAmount,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  } catch (err) {
    if (err instanceof AdditionalServicesValidationError) {
      return res.status(400).json({ error: err.message, errors: err.errors });
    }
    console.error("PUT /bookings/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi cập nhật đơn hàng" });
  }
});

// ─── Task #341: Add child booking to existing multi-service contract ────────
router.post("/bookings/:parentId/add-child", async (req, res) => {
  try {
    const parentId = parseInt(req.params.parentId);
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

    const [parent] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, parentId));
    if (!parent) return res.status(404).json({ error: "Không tìm thấy hợp đồng gốc" });
    if (!parent.isParentContract) return res.status(400).json({ error: "Booking này không phải hợp đồng multi-service" });

    const { customerId, serviceLabel, shootDate, shootTime, items, totalAmount, surcharges, deductions, notes, assignedStaff, servicePackageId, location, additionalServices } = req.body;
    // Dịch vụ con mới kế thừa khách của hợp đồng cha, trừ khi FE gửi customerId hợp lệ (đổi khách).
    const cidNum = parseInt(String(customerId));
    const childCustomerId = Number.isInteger(cidNum) && cidNum > 0 ? cidNum : parent.customerId;

    const existingChildren = await db.select({ id: bookingsTable.id, orderCode: bookingsTable.orderCode })
      .from(bookingsTable).where(eq(bookingsTable.parentId, parentId));
    const parentPrefix = `${parent.orderCode}-`;
    let maxIndex = 0;
    for (const c of existingChildren) {
      if (c.orderCode && c.orderCode.startsWith(parentPrefix)) {
        const suffix = parseInt(c.orderCode.slice(parentPrefix.length), 10);
        if (!isNaN(suffix) && suffix > maxIndex) maxIndex = suffix;
      }
    }
    const nextIndex = maxIndex + 1;
    const childCode = `${parent.orderCode}-${nextIndex}`;

    const [child] = await db.insert(bookingsTable).values({
      orderCode: childCode,
      customerId: childCustomerId,
      shootDate: shootDate || parent.shootDate,
      shootTime: shootTime || "08:00",
      serviceCategory: parent.serviceCategory,
      packageType: serviceLabel || `Dịch vụ ${nextIndex}`,
      location: location || parent.location || null,
      totalAmount: String(totalAmount || 0),
      depositAmount: "0",
      discountAmount: "0",
      paidAmount: "0",
      items: items || [],
      surcharges: surcharges || [],
      deductions: sanitizeDeductions(deductions),
      notes: notes || null,
      internalNotes: null,
      assignedStaff: assignedStaff || {},
      parentId: parent.id,
      serviceLabel: serviceLabel || null,
      isParentContract: false,
      status: "confirmed",
      createdByStaffId: callerId,
      servicePackageId: servicePackageId ? parseInt(String(servicePackageId)) : null,
    }).returning();

    const newParentTotal = await recalcParentTotalFromChildren(parentId);

    res.status(201).json({
      ...child,
      totalAmount: parseFloat(child.totalAmount),
      parentTotal: newParentTotal,
    });
  } catch (err) {
    console.error("POST /bookings/:parentId/add-child error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi thêm dịch vụ con" });
  }
});

router.delete("/bookings/:parentId/remove-child/:childId", async (req, res) => {
  try {
    const parentId = parseInt(req.params.parentId);
    const childId = parseInt(req.params.childId);
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

    const role = await getCallerRole(req.headers.authorization);
    if (role !== "admin") return res.status(403).json({ error: "Chỉ admin mới có thể xoá dịch vụ con" });

    const [parent] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, parentId));
    if (!parent) return res.status(404).json({ error: "Không tìm thấy hợp đồng gốc" });
    if (!parent.isParentContract) return res.status(400).json({ error: "Booking này không phải hợp đồng multi-service" });

    const [child] = await db.select().from(bookingsTable).where(and(eq(bookingsTable.id, childId), eq(bookingsTable.parentId, parentId)));
    if (!child) return res.status(404).json({ error: "Không tìm thấy dịch vụ con trong hợp đồng này" });

    const allChildren = await db.select({ id: bookingsTable.id })
      .from(bookingsTable).where(eq(bookingsTable.parentId, parentId));
    if (allChildren.length <= 1) return res.status(400).json({ error: "Hợp đồng phải có ít nhất 1 dịch vụ con. Hãy xoá toàn bộ hợp đồng nếu muốn huỷ." });

    const childLabel = child.serviceLabel || child.packageType || "Dịch vụ";

    const result = await db.transaction(async (tx) => {
      await tx.delete(tasksTable).where(eq(tasksTable.bookingId, childId));
      await tx.delete(expensesTable).where(eq(expensesTable.bookingId, childId));
      await tx.delete(contractsTable).where(eq(contractsTable.bookingId, childId));
      await tx.delete(paymentsTable).where(eq(paymentsTable.bookingId, childId));
      // Giải phóng váy/đồ đang giữ — nếu không xoá, hàng booking_dresses mồ côi vẫn
      // bị query trùng-lịch (/dresses/:id/conflict) tính → báo "Trùng lịch" với đơn
      // đã xoá. (FK schema khai báo onDelete cascade nhưng DB thật chưa có ràng buộc.)
      await tx.delete(bookingDressesTable).where(eq(bookingDressesTable.bookingId, childId));
      await tx.delete(bookingsTable).where(eq(bookingsTable.id, childId));

      await tx.insert(bookingChangeLogTable).values({
        bookingId: parentId,
        fieldChanged: "remove_child",
        oldValue: JSON.stringify({ childId, childServiceLabel: childLabel }),
        newValue: null,
        reason: `Xoá dịch vụ con "${childLabel}" (ID: ${childId})`,
        changedById: callerId,
      });

      const remainingChildren = await tx.select({ totalAmount: bookingsTable.totalAmount, serviceLabel: bookingsTable.serviceLabel, packageType: bookingsTable.packageType })
        .from(bookingsTable).where(eq(bookingsTable.parentId, parentId));
      const newParentTotal = remainingChildren.reduce((s, c) => s + parseFloat(c.totalAmount), 0);
      const newPackageType = remainingChildren.map(c => c.serviceLabel || c.packageType || "Dịch vụ").join(" + ");

      await tx.update(bookingsTable)
        .set({ totalAmount: String(newParentTotal), packageType: newPackageType })
        .where(eq(bookingsTable.id, parentId));

      return { parentTotal: newParentTotal, remainingCount: remainingChildren.length };
    });

    res.json({ message: "Đã xoá dịch vụ con", parentTotal: result.parentTotal, remainingChildren: result.remainingCount });
  } catch (err) {
    console.error("DELETE /bookings/:parentId/remove-child/:childId error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi xoá dịch vụ con" });
  }
});

// ─── Thùng rác: XOÁ MỀM (soft-delete) — chuyển booking vào thùng rác ──
// MỌI nhân viên đăng nhập được xoá mềm (nhập sai đơn tự xử lý được — deletedBy
// ghi lại ai xoá). Quản lý thùng rác (xem/phục hồi/xoá vĩnh viễn) vẫn CHỈ admin.
// KHÔNG hard-delete. Giữ nguyên dữ liệu con (lương/thu/chi/task) — chúng bị ẩn khỏi
// hệ thống active qua filter deleted_at ở các query, và quay lại khi phục hồi.
router.delete("/bookings/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

    const [target] = await db.select({
      isParentContract: bookingsTable.isParentContract,
      deletedAt: bookingsTable.deletedAt,
    }).from(bookingsTable).where(eq(bookingsTable.id, id));
    if (!target) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
    if (target.deletedAt) return res.status(400).json({ error: "Đơn đã ở trong thùng rác" });

    const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : null;

    // Hợp đồng cha → đưa toàn bộ dịch vụ con vào thùng rác cùng (khôi phục cùng nhau).
    const ids = [id];
    if (target.isParentContract) {
      const children = await db.select({ id: bookingsTable.id }).from(bookingsTable).where(eq(bookingsTable.parentId, id));
      for (const c of children) ids.push(c.id);
    }

    await db.transaction(async (tx) => {
      await tx.update(bookingsTable)
        .set({ deletedAt: new Date(), deletedBy: callerId, deleteReason: reason })
        .where(inArray(bookingsTable.id, ids));
      await tx.insert(bookingChangeLogTable).values({
        bookingId: id,
        fieldChanged: "trash",
        oldValue: null,
        newValue: "deleted",
        reason: reason ?? "Đưa vào thùng rác",
        changedById: callerId,
      });
    });

    emitNotification({ staffId: null, type: "booking_cancelled", title: "Đưa đơn vào thùng rác", message: `Đơn #${id} đã được chuyển vào thùng rác`, targetModule: "calendar", targetId: String(id), bookingId: id });
    res.json({ ok: true, trashed: true, ids });
  } catch (err) {
    console.error("DELETE /bookings/:id (soft-delete) error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi đưa đơn vào thùng rác" });
  }
});

// ─── Thùng rác: PHỤC HỒI (CHỈ admin) — cảnh báo conflict, không tự sửa lương đã chốt ──
router.post("/bookings/:id/restore", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
    if ((await getCallerRole(req.headers.authorization)) !== "admin") {
      return res.status(403).json({ error: "Chỉ admin được phục hồi booking" });
    }
    const [target] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
    if (!target) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
    if (!target.deletedAt) return res.status(400).json({ error: "Đơn không ở trong thùng rác" });

    // Cảnh báo (KHÔNG chặn — admin tự quyết sau khi xem):
    const conflicts: string[] = [];
    // 1) Trùng lịch với đơn ACTIVE khác cùng ngày (+giờ nếu có).
    const clashR = await pool.query(
      `SELECT id FROM bookings
        WHERE deleted_at IS NULL AND id <> $1 AND shoot_date = $2
          AND ($3::text IS NULL OR shoot_time = $3) AND COALESCE(status,'') <> 'cancelled'
        LIMIT 5`,
      [id, target.shootDate, target.shootTime ?? null],
    );
    if (clashR.rows.length) conflicts.push(`Trùng lịch với ${clashR.rows.length} đơn khác cùng ngày${target.shootTime ? "/giờ" : ""}`);
    // 2) Lương liên quan ĐÃ CHỐT (payroll paid) — phục hồi không tự sửa bảng đã chốt.
    const paidR = await pool.query(
      `SELECT COUNT(*)::int AS n FROM staff_job_earnings e
         JOIN payrolls p ON p.id = e.payroll_id
        WHERE (e.booking_id = $1 OR e.service_booking_id = $1) AND p.status = 'paid'`,
      [id],
    );
    if (Number(paidR.rows[0]?.n ?? 0) > 0) {
      conflicts.push("Có khoản lương liên quan ĐÃ CHỐT — phục hồi sẽ KHÔNG tự sửa bảng lương đã chốt, cần kiểm tra/điều chỉnh tay");
    }

    const ids = [id];
    if (target.isParentContract) {
      const children = await db.select({ id: bookingsTable.id }).from(bookingsTable).where(eq(bookingsTable.parentId, id));
      for (const c of children) ids.push(c.id);
    }
    await db.transaction(async (tx) => {
      await tx.update(bookingsTable)
        .set({ deletedAt: null, deletedBy: null, deleteReason: null })
        .where(inArray(bookingsTable.id, ids));
      await tx.insert(bookingChangeLogTable).values({
        bookingId: id, fieldChanged: "restore", oldValue: "deleted", newValue: "restored",
        reason: "Phục hồi từ thùng rác", changedById: callerId,
      });
    });
    emitNotification({ staffId: null, type: "booking_cancelled", title: "Phục hồi đơn", message: `Đơn #${id} đã được phục hồi từ thùng rác`, targetModule: "calendar", targetId: String(id), bookingId: id });
    res.json({ ok: true, restored: true, ids, conflicts });
  } catch (err) {
    console.error("POST /bookings/:id/restore error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi phục hồi đơn" });
  }
});

// ─── Thùng rác: XOÁ VĨNH VIỄN (purge, CHỈ admin) — hard-delete toàn bộ dữ liệu con ──
// Chỉ áp dụng cho đơn ĐANG trong thùng rác. Giữ nguyên logic dọn dữ liệu nguyên tử cũ.
router.delete("/bookings/:id/purge", async (req, res) => {
  try {
  const id = parseInt(req.params.id);
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  if ((await getCallerRole(req.headers.authorization)) !== "admin") {
    return res.status(403).json({ error: "Chỉ admin được xoá vĩnh viễn" });
  }

  const [target] = await db.select({
    isParentContract: bookingsTable.isParentContract,
    deletedAt: bookingsTable.deletedAt,
  }).from(bookingsTable).where(eq(bookingsTable.id, id));
  if (!target) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
  if (!target.deletedAt) return res.status(400).json({ error: "Chỉ xoá vĩnh viễn đơn đang trong thùng rác (hãy đưa vào thùng rác trước)" });

  // Gom id cần xoá: nếu là hợp đồng cha → kèm toàn bộ dịch vụ con.
  const idsToDelete = [id];
  if (target.isParentContract) {
    const children = await db.select({ id: bookingsTable.id }).from(bookingsTable).where(eq(bookingsTable.parentId, id));
    for (const c of children) idsToDelete.push(c.id);
  }

  // A1: dọn dữ liệu liên quan NGUYÊN TỬ trong 1 transaction — hoặc xoá/gỡ hết, hoặc
  // rollback toàn bộ. Tránh "xoá dở dang" để lại râu ria (lương ma, job hậu kỳ ma…).
  await db.transaction(async (tx) => {
    await tx.delete(tasksTable).where(inArray(tasksTable.bookingId, idsToDelete));
    await tx.delete(expensesTable).where(inArray(expensesTable.bookingId, idsToDelete));
    await tx.delete(contractsTable).where(inArray(contractsTable.bookingId, idsToDelete));
    await tx.delete(paymentsTable).where(inArray(paymentsTable.bookingId, idsToDelete));
    // Giải phóng váy/đồ đang giữ để không còn báo "Trùng lịch" với đơn đã xoá.
    await tx.delete(bookingDressesTable).where(inArray(bookingDressesTable.bookingId, idsToDelete));
    await tx.delete(bookingItemsTable).where(inArray(bookingItemsTable.bookingId, idsToDelete));
    await tx.delete(bookingChangeLogTable).where(inArray(bookingChangeLogTable.bookingId, idsToDelete));
    await tx.delete(photoshopJobsTable).where(inArray(photoshopJobsTable.bookingId, idsToDelete));
    // 💰 Lương: xoá thu nhập/phụ cấp gắn booking_id HOẶC service_booking_id (đơn con
    // multi-service) → tránh lương ma / phụ cấp ma sau khi xoá đơn.
    await tx.delete(staffJobEarningsTable).where(
      or(inArray(staffJobEarningsTable.bookingId, idsToDelete), inArray(staffJobEarningsTable.serviceBookingId, idsToDelete)),
    );
    await tx.delete(staffAllowancesTable).where(
      or(inArray(staffAllowancesTable.bookingId, idsToDelete), inArray(staffAllowancesTable.serviceBookingId, idsToDelete)),
    );
    // Chấm công: GIỮ log, chỉ gỡ liên kết (đúng ý schema set null) → không mất công đã ghi.
    await tx.update(attendanceLogsTable).set({ bookingId: null }).where(inArray(attendanceLogsTable.bookingId, idsToDelete));
    // Thiệp cưới: GIỮ thiệp (sản phẩm của khách), chỉ gỡ link (cột raw SQL, không có schema Drizzle).
    await tx.execute(sql`UPDATE wedding_cards SET booking_id = NULL WHERE booking_id IN (${sql.join(idsToDelete, sql`, `)})`);
    // Cuối cùng: xoá chính booking (cha + con).
    await tx.delete(bookingsTable).where(inArray(bookingsTable.id, idsToDelete));
  });

  emitNotification({ staffId: null, type: "booking_cancelled", title: "Xoá vĩnh viễn đơn hàng", message: `Đơn #${id} đã bị xoá vĩnh viễn`, targetModule: "calendar", targetId: String(id), bookingId: id });
  res.status(204).send();
  } catch (err) {
    console.error("DELETE /bookings/:id/purge error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi xoá vĩnh viễn đơn hàng" });
  }
});

// ─── Task #294: Backfill created_by_staff_id for old bookings ────────────────
// Uses the earliest booking_change_log entry's changed_by_id as the creator.
// Admin-only. Safe to run multiple times (only updates NULL rows).
router.post("/bookings/backfill-creator", async (req, res) => {
  try {
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
    const role = await getCallerRole(req.headers.authorization);
    if (role !== "admin") return res.status(403).json({ error: "Chỉ admin mới có thể chạy backfill" });

    const result = await pool.query(`
      UPDATE bookings b
      SET created_by_staff_id = earliest.changed_by_id
      FROM (
        SELECT DISTINCT ON (booking_id) booking_id, changed_by_id
        FROM booking_change_log
        WHERE changed_by_id IS NOT NULL
        ORDER BY booking_id, created_at ASC
      ) AS earliest
      WHERE b.id = earliest.booking_id
        AND b.created_by_staff_id IS NULL
    `);

    return res.json({
      message: "Backfill hoàn tất",
      updatedRows: result.rowCount ?? 0,
    });
  } catch (err) {
    console.error("POST /bookings/backfill-creator error:", err);
    return res.status(500).json({ error: "Lỗi hệ thống khi backfill" });
  }
});

// ─── GET /bookings/:id/change-log ────────────────────────────────────────────
// Trả về lịch sử sửa đơn theo thứ tự mới nhất trước, kèm tên người sửa
router.get("/bookings/:id/change-log", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

    const rows = await db
      .select({
        id: bookingChangeLogTable.id,
        bookingId: bookingChangeLogTable.bookingId,
        fieldChanged: bookingChangeLogTable.fieldChanged,
        oldValue: bookingChangeLogTable.oldValue,
        newValue: bookingChangeLogTable.newValue,
        reason: bookingChangeLogTable.reason,
        changedById: bookingChangeLogTable.changedById,
        createdAt: bookingChangeLogTable.createdAt,
        changedByName: staffTable.name,
      })
      .from(bookingChangeLogTable)
      .leftJoin(staffTable, eq(bookingChangeLogTable.changedById, staffTable.id))
      .where(eq(bookingChangeLogTable.bookingId, id))
      .orderBy(desc(bookingChangeLogTable.createdAt))
      .limit(200);

    return res.json(rows);
  } catch (err) {
    console.error("GET /bookings/:id/change-log error:", err);
    return res.status(500).json({ error: "Lỗi hệ thống khi lấy lịch sử sửa đơn" });
  }
});

export default router;
