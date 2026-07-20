import { Router, type IRouter, type Request, type Response } from "express";
import { db, pool } from "@workspace/db";
import { bookingsTable, customersTable, paymentsTable, expensesTable, tasksTable, staffTable, servicePackagesTable, packageItemsTable, photoshopJobsTable, servicesTable, bookingChangeLogTable, contractsTable, bookingDressesTable, bookingItemsTable, staffJobEarningsTable, staffAllowancesTable, attendanceLogsTable, bookingOccurrencesTable } from "@workspace/db/schema";
import { eq, and, desc, inArray, or, ilike, sql, asc, gte, lte, isNull, ne } from "drizzle-orm";
import { isCollectedPayment, money } from "../lib/booking-money";
import { engineAllocationSnapshot } from "../lib/finance/financial-engine";
import { resolveBookingTotal, summarizeItemsForLog } from "../lib/booking-total";
import { verifyToken, getCallerRole } from "./auth";
import { computeBookingEarnings } from "./job-earnings";
import { emitNotification } from "./notifications";
import { normalizeItemsAssignedStaffCast, buildPrevManualMap } from "../lib/resolve-staff-cast";
import { maybeCreatePhotoshopJobForBooking } from "./photoshop-jobs";
import { getSchemaFlags, bookingColumnsCompat, type SchemaFlags } from "../lib/schema-compat";
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
import {
  sanitizeOccurrenceDrafts,
  planOccurrencesSync,
  normalizeDate,
  normalizeTime,
} from "../lib/booking-occurrences";

const router: IRouter = Router();

/**
 * Yêu cầu caller ĐÃ ĐĂNG NHẬP hợp lệ (staff HOẶC admin, tài khoản còn hoạt động).
 * Dùng cho các endpoint ĐỌC dữ liệu đơn hàng — payload có tên khách, SĐT, ghi chú
 * nội bộ và tiền. Trước 20/07 các route này để trần: gọi /api/bookings/:id không
 * cần token vẫn trả đủ PII, dò id 1,2,3… là hút sạch danh sách khách.
 *
 * Cùng khuôn với customers.ts (PR #113) — KHÔNG thêm role mới, mọi nhân sự đăng
 * nhập đều xem được như trước. Guard PHẢI chạy TRƯỚC mọi truy vấn DB để (a) không
 * rò PII, (b) người ngoài không phân biệt được đơn có tồn tại hay không (401 giống
 * hệt nhau, chống dò id).
 * Trả true nếu hợp lệ; nếu không, GỬI 401 và trả false.
 */
async function ensureAuth(req: Request, res: Response): Promise<boolean> {
  const role = await getCallerRole(req.headers.authorization);
  if (!role) { res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" }); return false; }
  return true;
}

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
  opts?: { allowManual?: boolean; prevManual?: Map<string, number> },
): Promise<unknown[]> {
  const normalized = await normalizeItemsAssignedStaffCast(rawItems, bookingPackageId, opts);
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
// TƯƠNG THÍCH NGƯỢC (sự cố 2026-07-13): 2 cột dress_warn_* có thể CHƯA tồn tại
// trên DB chưa migrate → tách riêng, chỉ select khi schema có (getSchemaFlags).
// Thiếu cột thì FE nhận undefined → form dùng mặc định 3/2, KHÔNG sập /calendar.
const bookingFieldsBase = {
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
const bookingFieldsFull = {
  ...bookingFieldsBase,
  dressWarnPickupDays: bookingsTable.dressWarnPickupDays,
  dressWarnReturnDays: bookingsTable.dressWarnReturnDays,
};
/** Chọn bộ field theo schema thực tế của DB (thiếu cột → bộ base, không 500). */
function bookingFieldsFor(flags: SchemaFlags) {
  return flags.dressWarnCols ? bookingFieldsFull : bookingFieldsBase;
}

/** Chuẩn hoá số ngày nhắc thuê đồ: null/rỗng = null (mặc định 3/2), clamp 0..30. */
function toWarnDays(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(30, Math.floor(n));
}

router.get("/bookings", async (req, res) => {
  try {
  // Danh sách còn nặng hơn chi tiết: 1 request là ra cả danh sách khách + SĐT,
  // lại có ?q= tìm theo tên/SĐT. Phải đăng nhập.
  if (!(await ensureAuth(req, res))) return;
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

  const schemaFlags = await getSchemaFlags();
  const baseQuery = db
    .select(bookingFieldsFor(schemaFlags))
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

  // Ngày thực hiện phụ (dịch vụ nhiều ngày) — batch theo tất cả booking. Thuần
  // lịch trình, KHÔNG có tiền nên không ảnh hưởng tổng/công nợ/doanh thu.
  const occByBookingId: Record<number, { id: number; shootDate: string; shootTime: string | null; label: string | null; sortOrder: number }[]> = {};
  // Tương thích ngược: DB chưa migrate (thiếu bảng) → bỏ qua, đơn hiện như 1 ngày.
  if (schemaFlags.occurrences) {
    const allBookingIds = rows.map(r => r.id);
    if (allBookingIds.length > 0) {
      const occRows = await db
        .select({ id: bookingOccurrencesTable.id, bookingId: bookingOccurrencesTable.bookingId, shootDate: bookingOccurrencesTable.shootDate, shootTime: bookingOccurrencesTable.shootTime, label: bookingOccurrencesTable.label, sortOrder: bookingOccurrencesTable.sortOrder })
        .from(bookingOccurrencesTable)
        .where(inArray(bookingOccurrencesTable.bookingId, allBookingIds))
        .orderBy(asc(bookingOccurrencesTable.sortOrder), asc(bookingOccurrencesTable.shootDate), asc(bookingOccurrencesTable.id));
      for (const o of occRows) {
        (occByBookingId[o.bookingId] ??= []).push({ id: o.id, shootDate: o.shootDate as string, shootTime: o.shootTime, label: o.label, sortOrder: o.sortOrder });
      }
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
      occurrences: occByBookingId[b.id] ?? [],
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
        ...bookingFieldsFor(await getSchemaFlags()),
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
  // Trước 20/07 route này để trần: verifyToken bên dưới chỉ ghi "ai tạo" chứ không
  // hề chặn → người lạ tạo đơn được. Chặn TRƯỚC khi đọc/ghi bất cứ thứ gì.
  if (!(await ensureAuth(req, res))) return;
  const callerId = verifyToken(req.headers.authorization) || null;
  // Giá tay (castSource='manual') chỉ được giữ khi người lưu là admin.
  const allowManual = (await getCallerRole(req.headers.authorization)) === "admin";
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

  const count = await db.select(await bookingColumnsCompat()).from(bookingsTable);
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
        // Tương thích ngược: chỉ ghi cột setting nhắc khi DB đã migrate.
        ...((await getSchemaFlags()).dressWarnCols ? {
          dressWarnPickupDays: toWarnDays(req.body.dressWarnPickupDays),
          dressWarnReturnDays: toWarnDays(req.body.dressWarnReturnDays),
        } : {}),
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
      // Guard P0: tổng dịch vụ con phải khớp dữ liệu dịch vụ của chính nó
      // (tổng cha = Σ con, nên con lệch là cha lệch theo).
      const childResolved = resolveBookingTotal(String(sub.totalAmount || 0), sub.items || [], childAdditionalServices);
      if (childResolved.mismatch) {
        console.warn(
          `[booking-total-guard] POST /bookings (con ${childCode}): totalAmount client=${sub.totalAmount} lệch expected=${childResolved.expected} — tự tính lại.`,
        );
      }
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
          totalAmount: String(childResolved.total),
          depositAmount: "0",
          discountAmount: "0",
          paidAmount: "0",
          items: await normalizeBookingItemsCast(sub.items || [], null, { allowManual }),
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
    const [parentRefreshed] = await db.select(await bookingColumnsCompat()).from(bookingsTable).where(eq(bookingsTable.id, parent.id));

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
  snapshotItems = await normalizeBookingItemsCast(snapshotItems, pkgIdForCast, { allowManual });

  let snapshotAdditionalServices: AdditionalServiceLine[] = [];
  if (additionalServices !== undefined) {
    snapshotAdditionalServices = await prepareAdditionalServicesForSave(additionalServices, pkgIdForCast);
  }

  // Guard P0 chống lệch total/items khi TẠO đơn thường (đồng nhất với PUT).
  // resolveBookingTotal chỉ đối chiếu khi items có giá — snapshot từ gói có thể là
  // content-lines không mang giá → expected=0 → giữ nguyên tổng client (an toàn).
  const singleResolved = resolveBookingTotal(String(totalAmount), snapshotItems, snapshotAdditionalServices);
  if (singleResolved.mismatch) {
    console.warn(
      `[booking-total-guard] POST /bookings: totalAmount client=${totalAmount} lệch expected=${singleResolved.expected} — tự tính lại.`,
    );
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
      totalAmount: String(singleResolved.total),
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
      // Tương thích ngược: chỉ ghi cột setting nhắc khi DB đã migrate.
      ...((await getSchemaFlags()).dressWarnCols ? {
        dressWarnPickupDays: toWarnDays(req.body.dressWarnPickupDays),
        dressWarnReturnDays: toWarnDays(req.body.dressWarnReturnDays),
      } : {}),
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

// PR-B: breakdown phân bổ tiền của CẢ GIA ĐÌNH đơn (id = cha, con hoặc đơn lẻ) —
// nguồn DUY NHẤT là engineAllocationSnapshot (allocator chia đều cọc, chốt 17/07).
// FE màn Thu tiền dùng để hiện picker "chung hợp đồng / dịch vụ cụ thể / FIFO"
// kèm preview tiền sẽ trừ vào đâu. services trả theo đúng thứ tự FIFO của
// allocator (ngày thực hiện ASC, thiếu ngày xếp cuối, cùng ngày theo ID ASC).
router.get("/bookings/:id/allocation", async (req, res) => {
  try {
    // Trả tiền cọc/còn nợ theo cả gia đình hợp đồng → phải đăng nhập.
    if (!(await ensureAuth(req, res))) return;
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id không hợp lệ" });
    const snap = await engineAllocationSnapshot();
    const rootId = snap.byId.get(id)?.rootId ?? (snap.families.has(id) ? id : null);
    if (rootId == null) {
      // Đơn không countable (báo giá tạm/hủy/thùng rác...) hoặc không tồn tại →
      // không có phân bổ; FE fallback về hành vi thu tiền thẳng như cũ.
      return res.json({ rootId: id, services: [], totalDeposit: 0, overpayment: 0, totalNet: 0, totalAllocPaid: 0, totalRemaining: 0 });
    }
    const fam = snap.families.get(rootId);
    const members = snap.members
      .filter(m => m.rootId === rootId)
      .sort((a, b) => {
        const ka = a.shootDate ?? "9999-12-31";
        const kb = b.shootDate ?? "9999-12-31";
        if (ka !== kb) return ka < kb ? -1 : 1;
        return a.bookingId - b.bookingId;
      });
    const services = members.map(m => ({
      bookingId: m.bookingId,
      orderCode: m.orderCode,
      serviceLabel: m.serviceLabel,
      serviceCategory: m.serviceCategory,
      packageType: m.packageType,
      shootDate: m.shootDate,
      net: m.net,
      equalDeposit: m.equalDeposit,
      directPaid: m.directPaid,
      legacyDepositPaid: m.legacyDepositPaid,
      parentFifo: m.parentFifo,
      allocPaid: m.allocPaid,
      remaining: m.debt,
    }));
    res.json({
      rootId,
      totalDeposit: fam?.totalDeposit ?? 0,
      canonicalDepositPaymentId: fam?.canonicalDepositPaymentId ?? null,
      overpayment: fam?.overpayment ?? 0,
      totalNet: services.reduce((s, x) => s + x.net, 0),
      totalAllocPaid: services.reduce((s, x) => s + x.allocPaid, 0),
      totalRemaining: services.reduce((s, x) => s + x.remaining, 0),
      services,
    });
  } catch (err) {
    console.error("GET /bookings/:id/allocation error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi đọc phân bổ tiền" });
  }
});

router.get("/bookings/:id", async (req, res) => {
  try {
  // Chặn TRƯỚC khi chạm DB: không rò PII, và id có/không tồn tại đều 401 như nhau.
  if (!(await ensureAuth(req, res))) return;
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "id không hợp lệ" });
  const schemaFlags = await getSchemaFlags();
  const [row] = await db
    .select(bookingFieldsFor(schemaFlags))
    .from(bookingsTable)
    .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
    .where(eq(bookingsTable.id, id));

  if (!row) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });

  const paymentBookingId = row.parentId ?? id;
  const payments = await db.select().from(paymentsTable).where(eq(paymentsTable.bookingId, paymentBookingId));

  // Ngày thực hiện phụ (dịch vụ nhiều ngày) của CHÍNH đơn này — thuần lịch, không tiền.
  // Tương thích ngược: DB chưa migrate (thiếu bảng) → coi như không có ngày phụ.
  const occurrences = schemaFlags.occurrences
    ? await db
        .select({ id: bookingOccurrencesTable.id, shootDate: bookingOccurrencesTable.shootDate, shootTime: bookingOccurrencesTable.shootTime, label: bookingOccurrencesTable.label, sortOrder: bookingOccurrencesTable.sortOrder })
        .from(bookingOccurrencesTable)
        .where(eq(bookingOccurrencesTable.bookingId, id))
        .orderBy(asc(bookingOccurrencesTable.sortOrder), asc(bookingOccurrencesTable.shootDate), asc(bookingOccurrencesTable.id))
    : [];

  /**
   * Ngày phụ của CÁC DÒNG DỊCH VỤ KHÁC trong cùng hợp đồng (sibling/child).
   * Trước đây chỉ đơn đang mở mới có `occurrences` → màn xem show và hợp đồng chỉ
   * hiện đủ ngày cho ĐÚNG dịch vụ đang xem, các dịch vụ còn lại tưởng như 1 ngày.
   * Batch 1 query như list endpoint; thuần lịch trình nên KHÔNG đụng tiền/công nợ.
   */
  async function occurrencesByBookingId(ids: number[]) {
    const map: Record<number, { id: number; shootDate: string; shootTime: string | null; label: string | null; sortOrder: number }[]> = {};
    // Tương thích ngược: DB chưa migrate (thiếu bảng) → coi như không có ngày phụ.
    if (!schemaFlags.occurrences || ids.length === 0) return map;
    const rows = await db
      .select({ id: bookingOccurrencesTable.id, bookingId: bookingOccurrencesTable.bookingId, shootDate: bookingOccurrencesTable.shootDate, shootTime: bookingOccurrencesTable.shootTime, label: bookingOccurrencesTable.label, sortOrder: bookingOccurrencesTable.sortOrder })
      .from(bookingOccurrencesTable)
      .where(inArray(bookingOccurrencesTable.bookingId, ids))
      .orderBy(asc(bookingOccurrencesTable.sortOrder), asc(bookingOccurrencesTable.shootDate), asc(bookingOccurrencesTable.id));
    for (const o of rows) {
      (map[o.bookingId] ??= []).push({ id: o.id, shootDate: o.shootDate, shootTime: o.shootTime, label: o.label, sortOrder: o.sortOrder });
    }
    return map;
  }

  // Expenses: child/standalone = this booking only; parent contract = parent + all children
  let expenseBookingIds: number[] = [id];
  let children: unknown[] = [];
  if (row.isParentContract) {
    const childRows = await db
      .select(bookingFieldsFor(schemaFlags))
      .from(bookingsTable)
      .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
      .where(eq(bookingsTable.parentId, id))
      .orderBy(bookingsTable.shootDate);
    expenseBookingIds = [id, ...childRows.map((c) => c.id)];
    const childOcc = await occurrencesByBookingId(childRows.map((c) => c.id));
    children = childRows.map((c) => ({
      ...c,
      items: normalizeItemStaff(c.items),
      totalAmount: parseFloat(c.totalAmount),
      depositAmount: parseFloat(c.depositAmount),
      occurrences: childOcc[c.id] ?? [],
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
      .select(bookingFieldsFor(schemaFlags))
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

    const sibOcc = await occurrencesByBookingId(siblingIds);
    siblings = siblingRows.map(s => ({
      ...s,
      items: normalizeItemStaff(s.items),
      totalAmount: parseFloat(s.totalAmount),
      depositAmount: parseFloat(s.depositAmount),
      taskAssignees: sibTaskMap[s.id] ?? [],
      occurrences: sibOcc[s.id] ?? [],
    }));

    const [parentRow] = await db
      .select(bookingFieldsFor(schemaFlags))
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
    occurrences,
  });
  } catch (err) {
    console.error("GET /bookings/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.put("/bookings/:id", async (req, res) => {
  try {
  // PHẢI là câu lệnh đầu tiên: handler này GHI vào DB (cột nhắc thuê đồ của đơn
  // cha) từ rất sớm, trong khi verifyToken phía dưới chỉ dùng để ghi log "ai sửa"
  // và không bao giờ từ chối → trước đây người lạ sửa được tiền/trạng thái đơn.
  if (!(await ensureAuth(req, res))) return;
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
  if (serviceLabel !== undefined) updateData.serviceLabel = serviceLabel;
  // parentId / isParentContract KHÔNG nhận qua PUT — xem guard cách ly cha–con bên dưới
  // (re-parent qua PUT có thể hút đơn độc lập vào tổng hợp đồng khác).
  if (photoCount !== undefined) updateData.photoCount = photoCount !== null ? parseInt(String(photoCount)) : null;
  if (includedRetouchedPhotosSnapshot !== undefined) updateData.includedRetouchedPhotosSnapshot = parseInt(String(includedRetouchedPhotosSnapshot)) || 0;
  if (servicePackageId !== undefined) updateData.servicePackageId = servicePackageId ? parseInt(String(servicePackageId)) : null;
  // Setting nhắc thuê đồ (thuần lịch nhắc, không đụng tiền) — chỉ cập nhật khi field có mặt
  // VÀ DB đã migrate (tương thích ngược: thiếu cột thì bỏ qua thay vì 500).
  const dressWarnColsReady = (await getSchemaFlags()).dressWarnCols;
  if (dressWarnColsReady && req.body.dressWarnPickupDays !== undefined) updateData.dressWarnPickupDays = toWarnDays(req.body.dressWarnPickupDays);
  if (dressWarnColsReady && req.body.dressWarnReturnDays !== undefined) updateData.dressWarnReturnDays = toWarnDays(req.body.dressWarnReturnDays);

  // ── Toggle "Báo giá tạm tính" (temp_quote = true/false, MỘT nguồn chân lý là
  // bookings.status). Bật/tắt phải flip CẢ GIA ĐÌNH (cha + các con) trong cùng
  // transaction — nửa tím nửa thường thì predicate countable (con theo cha, con
  // theo chính nó) vẫn loại cả nhà → "tắt rồi mà số không về". Không delete/
  // recreate gì; đổi qua lại bao nhiêu lần cũng deterministic + idempotent.
  const newStatusRaw = status !== undefined ? String(status) : undefined;

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
      additionalServices: bookingsTable.additionalServices,
    })
    .from(bookingsTable)
    .where(eq(bookingsTable.id, id));
  if (!oldBooking) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
  const oldStatus = oldBooking.status;

  // Ranh giới temp_quote: chỉ khi body CÓ status và giá trị đổi phía (thường↔tạm).
  const wasTempQuote = oldStatus === "temp_quote";
  const willTempQuote = newStatusRaw !== undefined ? newStatusRaw === "temp_quote" : wasTempQuote;
  const crossesTempBoundary = newStatusRaw !== undefined && wasTempQuote !== willTempQuote;
  let tempToggledFamilyIds: number[] = [];

  // Setting nhắc thuê đồ sống ở ĐƠN GỐC (reminder tính per family theo root).
  // PUT vào đơn con mà có gửi field nhắc → ghi sang đơn gốc để setting luôn có tác dụng.
  if (oldBooking.parentId && (updateData.dressWarnPickupDays !== undefined || updateData.dressWarnReturnDays !== undefined)) {
    const rootWarnUpdate: Record<string, unknown> = {};
    if (updateData.dressWarnPickupDays !== undefined) { rootWarnUpdate.dressWarnPickupDays = updateData.dressWarnPickupDays; delete updateData.dressWarnPickupDays; }
    if (updateData.dressWarnReturnDays !== undefined) { rootWarnUpdate.dressWarnReturnDays = updateData.dressWarnReturnDays; delete updateData.dressWarnReturnDays; }
    await db.update(bookingsTable).set(rootWarnUpdate).where(eq(bookingsTable.id, oldBooking.parentId));
  }

  // ── Cách ly cha–con (P0 isolation): PUT sửa đơn KHÔNG được đổi quan hệ cha–con.
  // Quan hệ này chỉ được thay đổi qua add-child / remove-child (server-side, có kiểm
  // soát). Client gửi đúng giá trị hiện tại thì bỏ qua; cố ĐỔI thì trả 400.
  if (parentId !== undefined && (parentId ?? null) !== (oldBooking.parentId ?? null)) {
    return res.status(400).json({ error: "Không thể đổi quan hệ cha–con của đơn qua chỉnh sửa. Dùng thêm/xoá dịch vụ con của hợp đồng gộp." });
  }
  if (isParentContract !== undefined && Boolean(isParentContract) !== Boolean(oldBooking.isParentContract)) {
    return res.status(400).json({ error: "Không thể đổi loại hợp đồng gộp qua chỉnh sửa đơn." });
  }

  // A8: parent contracts ignore client totalAmount — derived from Σ children
  if (oldBooking.isParentContract) {
    delete updateData.totalAmount;
  }
  const callerId = verifyToken(req.headers.authorization) || null;
  // Giá tay (castSource='manual') chỉ được TẠO/ĐỔI khi người lưu là admin.
  // prevManual = giá tay đang lưu → non-admin lưu lại (sửa giờ) vẫn giữ được,
  // chỉ giá tay MỚI/ĐỔI mới bị chặn (chống bơm lương + chống mất giá lặng lẽ).
  const allowManual = (await getCallerRole(req.headers.authorization)) === "admin";
  const prevManual = buildPrevManualMap(oldBooking.items);

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
    const castNormalized = await normalizeBookingItemsCast(items, pkgIdForCast ?? null, { allowManual, prevManual });
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

      return result;
    });

    // BẢO MẬT: Case B cũng phải qua normalize (allowManual/prevManual) — nếu không,
    // nhân viên thường gửi assignedStaff (không kèm items) sẽ bơm được castAmount
    // 'manual' tuỳ ý vào items[].assignedStaff → thành lương thật. syncItemLegacyFields
    // chạy SAU normalize để photoName/photoId khớp assignedStaff đã chuẩn hoá.
    const mergedNormalized = await normalizeBookingItemsCast(mergedItems, null, { allowManual, prevManual });
    updateData.items = (mergedNormalized as Record<string, unknown>[]).map(syncItemLegacyFields);
  }

  // ── Ngày thực hiện phụ gửi KÈM payload Lưu → validate TRƯỚC khi mở transaction.
  // (Atomic save: payload sai thì 400 ngay, chưa ghi gì; hết cảnh frontend sync
  // ngày phụ bằng nhiều request rời sau khi booking đã lưu.)
  let occurrenceDrafts: import("../lib/booking-occurrences").OccurrenceDraftSanitized[] | undefined;
  if (req.body.occurrences !== undefined) {
    const parsed = sanitizeOccurrenceDrafts(req.body.occurrences);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    occurrenceDrafts = parsed.drafts;
  }
  const occurrencesReady = occurrenceDrafts !== undefined && (await getSchemaFlags()).occurrences;
  // Đổi ngày chính + giữ nguyên field khác → ngày phụ vẫn phải hết trùng với ngày chính MỚI.
  const effectiveShootDateForOcc = (updateData.shootDate as string | undefined) ?? oldBooking.shootDate;
  const effectiveShootTimeForOcc = (updateData.shootTime as string | undefined) ?? oldBooking.shootTime;
  let occChangeSummary: { oldDisplay: string; newDisplay: string } | null = null;

  // ── Guard P0 chống lệch total/items (sự cố DH0191 2026-07-12): booking THƯỜNG không
  // được ghi totalAmount mâu thuẫn với dữ liệu dịch vụ. Nếu payload có CẢ items lẫn
  // totalAmount mà tổng lệch khỏi Σ(items + dịch vụ cộng thêm) → tự tính lại từ dữ liệu
  // thực tế. Booking CHA đã bị xoá totalAmount ở guard A8 (tổng cha recalc từ con).
  // Payload chỉ có totalAmount không kèm items (vd sửa tổng tay ở trang Đơn hàng) giữ nguyên.
  if (!oldBooking.isParentContract && items !== undefined && updateData.totalAmount !== undefined) {
    const extrasForTotal =
      updateData.additionalServices !== undefined ? updateData.additionalServices : oldBooking.additionalServices;
    const resolved = resolveBookingTotal(String(updateData.totalAmount), updateData.items, extrasForTotal);
    if (resolved.mismatch) {
      console.warn(
        `[booking-total-guard] PUT /bookings/${id}: totalAmount client=${updateData.totalAmount} lệch expected=${resolved.expected} — tự tính lại từ items/dịch vụ cộng thêm.`,
      );
      updateData.totalAmount = String(resolved.total);
    }
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

      // Chốt 17/07 (Q2/Q3): CHỈ phiếu deposit CŨ NHẤT là cọc canonical do ô "Tiền cọc"
      // quản lý. Các phiếu deposit KHÁC (user tự tạo khi thu thêm) là TIỀN THẬT —
      // allocator đọc chúng như thu thêm/pool. TUYỆT ĐỐI không DELETE như trước
      // (xóa là mất tiền thật khỏi sổ).

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

    // ── 5. Sync ngày thực hiện phụ TRONG CÙNG transaction (atomic với booking) ──
    // Đổi ngày = UPDATE in-place theo id (không delete-rồi-create) → card lịch
    // không bao giờ "mất tạm"; lỗi bất kỳ → ROLLBACK toàn bộ, không nửa cũ nửa mới.
    if (occurrencesReady && occurrenceDrafts !== undefined) {
      const existingOccResult = await client.query<{ id: number; shoot_date: string; shoot_time: string | null; label: string | null; sort_order: number }>(
        `SELECT id, shoot_date::text AS shoot_date, shoot_time::text AS shoot_time, label, sort_order
         FROM booking_occurrences WHERE booking_id = $1
         ORDER BY sort_order ASC, shoot_date ASC, id ASC`,
        [id]
      );
      const existingOcc = existingOccResult.rows;
      const planned = planOccurrencesSync(
        existingOcc,
        occurrenceDrafts,
        effectiveShootDateForOcc,
        effectiveShootTimeForOcc,
      );
      if (!planned.ok) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: planned.error });
      }
      const { toUpdate, toInsert, deleteIds } = planned.plan;
      for (const u of toUpdate) {
        await client.query(
          `UPDATE booking_occurrences SET shoot_date = $1, shoot_time = $2, label = $3, updated_at = NOW()
           WHERE id = $4 AND booking_id = $5`,
          [u.shootDate, u.shootTime, u.label, u.id, id]
        );
      }
      let nextSort = existingOcc.reduce((m, o) => Math.max(m, o.sort_order), 0);
      for (const ins of toInsert) {
        nextSort += 1;
        await client.query(
          `INSERT INTO booking_occurrences (booking_id, shoot_date, shoot_time, label, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, ins.shootDate, ins.shootTime, ins.label, nextSort]
        );
      }
      if (deleteIds.length > 0) {
        await client.query(
          `DELETE FROM booking_occurrences WHERE booking_id = $1 AND id = ANY($2::int[])`,
          [id, deleteIds]
        );
      }
      // Diff cho lịch sử sửa đơn (ghi sau COMMIT cùng các thay đổi khác).
      const fmtOcc = (o: { shootDate?: string; shoot_date?: string; shootTime?: string | null; shoot_time?: string | null; label?: string | null }) => {
        const d = normalizeDate(o.shootDate ?? o.shoot_date ?? "");
        const t = normalizeTime(o.shootTime ?? o.shoot_time ?? null);
        const l = (o.label ?? "").trim();
        return `${d}${t ? ` ${t}` : ""}${l ? ` — ${l}` : ""}`;
      };
      const oldDisplay = existingOcc.map(fmtOcc).join("; ") || "(không có)";
      const newDisplay = occurrenceDrafts.map(fmtOcc).join("; ") || "(không có)";
      if (oldDisplay !== newDisplay) occChangeSummary = { oldDisplay, newDisplay };
    }

    // ── 6. Đơn đổi khách → hợp đồng CHƯA KÝ gắn đơn này đi theo khách mới ──
    // (Hợp đồng render khách live theo booking; cột customer_id đồng bộ để list/
    // join cũ không lệch. Bản ĐÃ KÝ giữ nguyên — bản pháp lý.)
    if (updateData.customerId !== undefined && updateData.customerId !== oldBooking.customerId) {
      await client.query(
        `UPDATE contracts SET customer_id = $1
         WHERE booking_id = $2 AND COALESCE(status, '') <> 'signed'`,
        [updateData.customerId, id]
      );
    }

    // ── 7. Toggle Báo giá tạm: flip CẢ GIA ĐÌNH trong cùng transaction ──
    // Booking chính đã được UPDATE ở bước 4; đây là phần cha + anh em còn lại.
    // Chỉ UPDATE status — không đụng khách/dịch vụ/giá/ngày/payment/occurrence.
    if (crossesTempBoundary) {
      const rootId = oldBooking.parentId ?? id;
      if (willTempQuote) {
        // BẬT: cả nhà về temp_quote (trừ đơn đã hủy/đã xóa — giữ nguyên trạng thái đó).
        const r = await client.query<{ id: number }>(
          `UPDATE bookings SET status = 'temp_quote'
           WHERE (id = $1 OR parent_id = $1) AND id <> $2
             AND deleted_at IS NULL AND COALESCE(status, '') NOT IN ('cancelled', 'temp_quote')
           RETURNING id`,
          [rootId, id]
        );
        tempToggledFamilyIds = r.rows.map((x) => x.id);
      } else {
        // TẮT: mọi thành viên đang temp_quote nhận CÙNG trạng thái mới → cả nhà
        // countable trở lại một lần, deterministic.
        const r = await client.query<{ id: number }>(
          `UPDATE bookings SET status = $3
           WHERE (id = $1 OR parent_id = $1) AND id <> $2
             AND deleted_at IS NULL AND status = 'temp_quote'
           RETURNING id`,
          [rootId, id, newStatusRaw]
        );
        tempToggledFamilyIds = r.rows.map((x) => x.id);
      }
    }

    await client.query("COMMIT");

    const customerId = updateResult.rows[0].customer_id;

    // Post-production: tạo job mới nếu gói yêu cầu hậu kỳ (không sửa job cũ nếu không đủ điều kiện)
    if (items !== undefined || servicePackageId !== undefined) {
      await maybeCreatePhotoshopJobForBooking(id).catch(err => console.warn("[bookings] maybeCreatePhotoshopJob PUT failed:", err));
    }

    // ── Side-effect sau toggle Báo giá tạm (dữ liệu chính đã COMMIT) ──
    // BẬT: computeBookingEarnings dọn lương pending rồi early-return vì temp_quote
    //      (lương đã trả + earning Hậu kỳ paid giữ nguyên; job hậu kỳ không xóa —
    //      các màn hậu kỳ tự ẩn vì lọc status).
    // TẮT: tạo job hậu kỳ nếu gói yêu cầu (lúc tạo báo giá đã skip); hàm tự bỏ qua
    //      cha tổng/không đủ điều kiện. Không tạo trùng (maybe* kiểm tra job active).
    if (crossesTempBoundary) {
      const affectedIds = [id, ...tempToggledFamilyIds];
      for (const bid of affectedIds) {
        if (willTempQuote) {
          computeBookingEarnings(bid).catch(err => console.warn("[bookings] earnings cleanup (temp_quote on) failed:", err));
        } else {
          await maybeCreatePhotoshopJobForBooking(bid).catch(err => console.warn("[bookings] maybeCreatePhotoshopJob (temp_quote off) failed:", err));
          // Tắt thẳng về "Hoàn thành" → tính lương chốt cho cả gia đình như luồng completed chuẩn.
          if (newStatusRaw === "completed") {
            computeBookingEarnings(bid).catch(err => console.warn("[bookings] earnings compute (temp_quote off) failed:", err));
          }
        }
      }
      // Audit: các thành viên gia đình bị flip theo (đơn đang sửa đã có log status riêng).
      if (tempToggledFamilyIds.length > 0) {
        await db.insert(bookingChangeLogTable).values(tempToggledFamilyIds.map(bid => ({
          bookingId: bid,
          fieldChanged: "status",
          oldValue: willTempQuote ? null : "temp_quote",
          newValue: willTempQuote ? "temp_quote" : String(newStatusRaw),
          reason: willTempQuote
            ? "Đồng bộ Báo giá tạm tính cho cả hợp đồng gộp"
            : "Đồng bộ Booking chính thức cho cả hợp đồng gộp",
          changedById: callerId,
        }))).catch(err => console.warn("[bookings] temp-quote toggle change-log failed:", err));
      }
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
    } else if (oldStatus === "completed" && items !== undefined) {
      // Show ĐÃ hoàn thành mà admin sửa lại nhân sự/giá tay → tính lại lương chốt
      // (computeBookingEarnings chỉ xoá + tạo lại earning status 'pending', không
      // đụng earning đã 'paid') để tiền chốt khớp con số mới trên form + lịch sử.
      computeBookingEarnings(id).catch(err => console.error("Earnings recompute error:", err));
    }

    // Re-read full booking + customer (outside transaction is fine — data is committed)
    const [[fullBooking], [customer]] = await Promise.all([
      db.select(await bookingColumnsCompat()).from(bookingsTable).where(eq(bookingsTable.id, id)),
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
    // Log giá trị THẬT SỰ được ghi (sau guard chống lệch), không phải giá trị client gửi.
    if (totalAmount !== undefined) pushChange("totalAmount", "tổng tiền", oldBooking.totalAmount, updateData.totalAmount ?? totalAmount, fmtVND);
    if (depositAmount !== undefined) pushChange("depositAmount", "tiền cọc", oldBooking.depositAmount, depositAmount, fmtVND);
    if (discountAmount !== undefined) pushChange("discountAmount", "giảm giá", oldBooking.discountAmount, discountAmount, fmtVND);
    if (notes !== undefined) pushChange("notes", "ghi chú", oldBooking.notes, notes);
    if (occChangeSummary) changes.push({ field: "occurrences", label: "ngày thực hiện phụ", oldDisplay: occChangeSummary.oldDisplay, newDisplay: occChangeSummary.newDisplay });
    // Diff staff theo từng vai trò (so 2 chuỗi tên đã sort)
    if (items !== undefined || assignedStaff !== undefined) {
      const oldPhoto = extractStaffByRole(oldBooking.items, "photographer");
      const newPhoto = extractStaffByRole(newItems, "photographer");
      const oldMakeup = extractStaffByRole(oldBooking.items, "makeup");
      const newMakeup = extractStaffByRole(newItems, "makeup");
      if (oldPhoto !== newPhoto) changes.push({ field: "photographer", label: "nhiếp ảnh", oldDisplay: oldPhoto || "(chưa có)", newDisplay: newPhoto || "(chưa có)" });
      if (oldMakeup !== newMakeup) changes.push({ field: "makeup", label: "makeup", oldDisplay: oldMakeup || "(chưa có)", newDisplay: newMakeup || "(chưa có)" });
    }

    // Đổi DỊCH VỤ phải để lại dấu vết: sự cố DH0191 chỉ thấy mỗi dòng "Tổng tiền"
    // nên không truy được chuyện gì đã xảy ra với dịch vụ. Log tóm tắt items cũ→mới.
    if (items !== undefined) {
      pushChange(
        "services",
        "dịch vụ",
        summarizeItemsForLog(oldBooking.items, fmtVND),
        summarizeItemsForLog(newItems, fmtVND),
      );
    }

    // Giá tay: ghi lịch sử khi admin đổi lương tay của nhân sự (minh bạch tiền bạc)
    if (items !== undefined) {
      type CastEntry = { name: string; amount: number; manual: boolean };
      const normRole = (r: string) => { const x = (r || "").toLowerCase().trim(); return x === "photo" ? "photographer" : x; };
      const collectCast = (its: unknown): Map<string, CastEntry> => {
        const m = new Map<string, CastEntry>();
        if (!Array.isArray(its)) return m;
        (its as Record<string, unknown>[]).forEach((it, itemIdx) => {
          const sa = Array.isArray(it.assignedStaff)
            ? (it.assignedStaff as { staffId?: number; staffName?: string; role?: string; castAmount?: unknown; castSource?: string }[])
            : [];
          for (const s of sa) {
            if (!s?.staffId || !s?.role) continue;
            // Key gồm itemIdx: 1 người đứng 2 dòng dịch vụ không đè log của nhau;
            // role normalize 'photo'→'photographer' để items cũ/mới không lệch key.
            m.set(`${itemIdx}:${s.staffId}:${normRole(s.role)}`, {
              name: (s.staffName || "").trim() || `NV#${s.staffId}`,
              amount: parseFloat(String(s.castAmount ?? 0)) || 0,
              manual: s.castSource === "manual",
            });
          }
        });
        return m;
      };
      const oldCast = collectCast(oldBooking.items);
      const newCast = collectCast(newItems);
      for (const [key, nv] of newCast) {
        const ov = oldCast.get(key);
        // Log khi: entry mới là giá tay và khác giá trước đó, hoặc bỏ giá tay quay về bảng cast.
        const wasManual = ov?.manual ?? false;
        if (nv.manual && (!ov || Math.abs(ov.amount - nv.amount) > 0.01)) {
          changes.push({
            field: `manual_cast_${key}`,
            label: `giá tay ${nv.name}`,
            oldDisplay: ov ? fmtVND(ov.amount) : "(chưa có)",
            newDisplay: fmtVND(nv.amount),
          });
        } else if (!nv.manual && wasManual) {
          changes.push({
            field: `manual_cast_${key}`,
            label: `giá tay ${nv.name}`,
            oldDisplay: `${fmtVND(ov!.amount)} (tay)`,
            newDisplay: `${fmtVND(nv.amount)} (theo bảng cast)`,
          });
        }
      }
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
/**
 * POST /bookings/:id/promote-to-family — NÂNG CẤP đơn lẻ thành hợp đồng nhiều dịch vụ.
 *
 * Nghiệp vụ (chủ studio 20/07): khách cũ quay lại chốt thêm gói thì phải mở đơn cũ
 * bấm "Thêm dịch vụ" là xong — bao nhiêu lần cũng được. Trước đây FE KHOÁ nút này
 * cho đơn 1 dịch vụ (sau sự cố DH0191) — khoá tính năng để né bug, không chấp nhận.
 *
 * Cách làm: GIỮ NGUYÊN hàng đơn cũ và id của nó (hợp đồng, phiếu thu, lịch nhiều
 * ngày, trang phục, phân công, lương ekip, lịch sử… đều bám id đó), tạo THÊM một
 * hàng CHA rồi trỏ đơn cũ vào làm dịch vụ con thứ nhất.
 *
 * TIỀN PHẢI DI CHUYỂN LÊN CHA, không chỉ đổi quan hệ:
 * ba chỗ đọc tiền của con TỪ CHA (danh sách đơn ~442, chi tiết ~917, PUT recalc
 * ~1467). Nếu để phiếu thu nằm lại đơn cũ thì cọc khách hiện 0đ và lần lưu kế tiếp
 * ghi đè paid_amount = 0 đè lên chính hàng đang giữ phiếu → lệch sổ.
 * Vì vậy trong CÙNG một transaction: chuyển payments sang cha, dời deposit/discount/
 * paid lên cha và zero ở con — ĐÚNG hình dạng mà tạo hợp đồng gộp từ đầu vẫn tạo ra
 * (cha giữ tiền, con "0"/"0"/"0"), để engine/truth test không phải học hình dạng mới.
 * Hợp đồng cũng trỏ về cha, nếu không thì mở từ cha sẽ đẻ ra hợp đồng thứ hai.
 *
 * Idempotent: gọi trên đơn đã là cha/con thì KHÔNG làm gì, chỉ trả về id cha.
 * Lỗi giữa chừng → rollback toàn bộ, không có trạng thái nửa vời.
 */
router.post("/bookings/:id/promote-to-family", async (req, res) => {
  try {
    if (!(await ensureAuth(req, res))) return;
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id không hợp lệ" }); return; }

    const exists = await db.select({ id: bookingsTable.id }).from(bookingsTable).where(eq(bookingsTable.id, id));
    if (exists.length === 0) { res.status(404).json({ error: "Không tìm thấy đơn" }); return; }

    const callerId = verifyToken(req.headers.authorization) || null;

    const result = await db.transaction(async (tx) => {
      // KHOÁ hàng rồi mới đọc: hai người cùng bấm "Thêm dịch vụ" một lúc thì người
      // sau phải thấy trạng thái người trước đã ghi. Không khoá thì cả hai cùng
      // thấy "đơn lẻ" → đẻ hai hàng cha, phiếu thu về cha thứ nhất còn đơn cũ trỏ
      // cha thứ hai = cha mồ côi giữ tiền, gia đình mất sạch phiếu.
      const locked = await tx.execute(
        sql`SELECT id, order_code, customer_id, shoot_date, shoot_time, service_category, package_type,
                   location, total_amount, deposit_amount, discount_amount, paid_amount, status,
                   internal_notes, service_label, parent_id, is_parent_contract, created_by_staff_id,
                   dress_warn_pickup_days, dress_warn_return_days
            FROM bookings WHERE id = ${id} FOR UPDATE`,
      );
      const r = (locked as unknown as { rows: Record<string, unknown>[] }).rows[0];
      if (!r) return { notFound: true as const };
      // Đã nằm trong hợp đồng gộp rồi → không đụng gì, trả id cha để FE dùng tiếp.
      if (r.is_parent_contract === true) return { parentId: id, childId: null, alreadyFamily: true as const };
      if (r.parent_id != null) return { parentId: Number(r.parent_id), childId: id, alreadyFamily: true as const };

      const row = {
        orderCode: r.order_code as string | null,
        customerId: Number(r.customer_id),
        shootDate: r.shoot_date as string,
        shootTime: r.shoot_time as string | null,
        serviceCategory: r.service_category as string | null,
        location: r.location as string | null,
        totalAmount: r.total_amount as string,
        depositAmount: r.deposit_amount as string,
        discountAmount: r.discount_amount as string,
        paidAmount: r.paid_amount as string,
        status: r.status as string,
        internalNotes: r.internal_notes as string | null,
        serviceLabel: r.service_label as string | null,
        packageType: r.package_type as string | null,
        createdByStaffId: r.created_by_staff_id as number | null,
      };
      const oldCode = row.orderCode || `DH${String(id).padStart(4, "0")}`;
      // 1. CHA kế thừa mã đơn cũ (DH0xxx) + toàn bộ TIỀN của đơn cũ.
      //    items rỗng: tiền của cha = Σ con (quy ước A8 sẵn có).
      const [parent] = await tx
        .insert(bookingsTable)
        .values({
          orderCode: oldCode,
          customerId: row.customerId,
          shootDate: row.shootDate,
          shootTime: row.shootTime || "08:00",
          serviceCategory: row.serviceCategory || "wedding",
          packageType: "Hợp đồng nhiều dịch vụ",
          location: row.location || null,
          totalAmount: String(row.totalAmount ?? 0),
          depositAmount: String(row.depositAmount ?? 0),
          // Giảm giá phải nằm ở CẢ HAI, và đó KHÔNG phải cộng đôi: engine tiền chỉ
          // tính trên dòng dịch vụ (bỏ qua hàng cha), còn hợp đồng + danh sách đơn
          // lại đọc từ cha. Dời hẳn lên cha thì engine mất giảm giá → khách bỗng nợ
          // thêm đúng số đã giảm; để nguyên ở con thì hợp đồng hiện nợ cao hơn.
          // Ghi cả hai chỗ = mỗi bên đọc đúng một lần, mọi con số giữ y nguyên.
          discountAmount: String(row.discountAmount ?? 0),
          paidAmount: String(row.paidAmount ?? 0),
          items: [],
          surcharges: [],
          deductions: [],
          notes: null,
          internalNotes: row.internalNotes || null,
          assignedStaff: {},
          isParentContract: true,
          status: row.status,
          // GIỮ người tạo gốc: hoa hồng sale fallback theo cột này. Ghi người bấm
          // nút vào đây là lặng lẽ chuyển hoa hồng của bạn sale đã chốt đơn sang
          // người vừa bấm "Thêm dịch vụ".
          createdByStaffId: row.createdByStaffId ?? callerId,
          // Setting nhắc thuê đồ đọc theo GỐC gia đình → không mang lên cha là đơn
          // âm thầm rơi về mặc định 3/2.
          ...((await getSchemaFlags()).dressWarnCols ? {
            dressWarnPickupDays: (r as { dress_warn_pickup_days?: number | null }).dress_warn_pickup_days ?? null,
            dressWarnReturnDays: (r as { dress_warn_return_days?: number | null }).dress_warn_return_days ?? null,
          } : {}),
        })
        .returning();

      // 2. Đơn cũ thành dịch vụ con #1: đổi mã theo quy ước cha-con, TRẢ tiền lên cha.
      //    Giữ nguyên id, items, ngày, ghi chú, nhân sự, phụ thu — không đụng.
      await tx
        .update(bookingsTable)
        .set({
          parentId: parent.id,
          orderCode: `${oldCode}-1`,
          serviceLabel: row.serviceLabel || row.packageType || "Dịch vụ 1",
          depositAmount: "0",
          paidAmount: "0",
          // KHÔNG zero discountAmount ở đây — xem ghi chú ở hàng cha phía trên.
        })
        .where(eq(bookingsTable.id, id));

      // 3. Phiếu thu + hợp đồng chuyển về cha (xem docblock — bắt buộc, không phải tuỳ chọn).
      await tx.update(paymentsTable).set({ bookingId: parent.id }).where(eq(paymentsTable.bookingId, id));
      await tx.update(contractsTable).set({ bookingId: parent.id }).where(eq(contractsTable.bookingId, id));

      // 4. Tổng của cha = tổng con còn hiệu lực. Tính TRONG tx (helper ngoài dùng
      //    connection khác sẽ kẹt lock với chính transaction này).
      const kids = await tx
        .select({ total: bookingsTable.totalAmount })
        .from(bookingsTable)
        .where(and(eq(bookingsTable.parentId, parent.id), isNull(bookingsTable.deletedAt), ne(bookingsTable.status, "cancelled")));
      const sum = kids.reduce((acc, k) => acc + (parseFloat(String(k.total ?? 0)) || 0), 0);
      await tx.update(bookingsTable).set({ totalAmount: String(sum) }).where(eq(bookingsTable.id, parent.id));

      return { parentId: parent.id, childId: id, alreadyFamily: false as const };
    });

    if ("notFound" in result) { res.status(404).json({ error: "Không tìm thấy đơn" }); return; }
    res.json(result);
  } catch (err) {
    console.error("POST /bookings/:id/promote-to-family error:", err);
    res.status(500).json({ error: "Không nâng cấp được đơn thành hợp đồng nhiều dịch vụ" });
  }
});

router.post("/bookings/:parentId/add-child", async (req, res) => {
  try {
    const parentId = parseInt(req.params.parentId);
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

    const [parent] = await db.select(await bookingColumnsCompat()).from(bookingsTable).where(eq(bookingsTable.id, parentId));
    if (!parent) return res.status(404).json({ error: "Không tìm thấy hợp đồng gốc" });
    if (!parent.isParentContract) return res.status(400).json({ error: "Booking này không phải hợp đồng multi-service" });

    const { customerId, serviceLabel, shootDate, shootTime, items, totalAmount, surcharges, deductions, notes, assignedStaff, servicePackageId, location, additionalServices } = req.body;
    // BẢO MẬT: giá tay chỉ giữ khi admin; dịch vụ con mới không có DB cũ nên
    // không có prevManual → non-admin gửi manual đều bị resolve về bảng cast.
    const allowManual = (await getCallerRole(req.headers.authorization)) === "admin";
    const childPkgId = servicePackageId ? parseInt(String(servicePackageId)) : null;
    const normalizedChildItems = await normalizeBookingItemsCast(items || [], childPkgId, { allowManual });
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

    // FE tính totalAmount của dịch vụ con = gói + DỊCH VỤ CỘNG THÊM, nhưng trước đây
    // add-child VỨT additionalServices (không lưu) → tiền có trong tổng mà dữ liệu mất
    // (cùng họ bug DH0191). Lưu extras + đối chiếu tổng với dữ liệu thực tế.
    const childExtras = additionalServices !== undefined
      ? await prepareAdditionalServicesForSave(additionalServices, childPkgId)
      : [];
    const childResolved = resolveBookingTotal(String(totalAmount || 0), normalizedChildItems, childExtras);
    if (childResolved.mismatch) {
      console.warn(
        `[booking-total-guard] POST add-child ${childCode}: totalAmount client=${totalAmount} lệch expected=${childResolved.expected} — tự tính lại.`,
      );
    }

    const [child] = await db.insert(bookingsTable).values({
      orderCode: childCode,
      customerId: childCustomerId,
      shootDate: shootDate || parent.shootDate,
      shootTime: shootTime || "08:00",
      serviceCategory: parent.serviceCategory,
      packageType: serviceLabel || `Dịch vụ ${nextIndex}`,
      location: location || parent.location || null,
      totalAmount: String(childResolved.total),
      depositAmount: "0",
      discountAmount: "0",
      paidAmount: "0",
      items: normalizedChildItems,
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
      additionalServices: childExtras,
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

    const [parent] = await db.select(await bookingColumnsCompat()).from(bookingsTable).where(eq(bookingsTable.id, parentId));
    if (!parent) return res.status(404).json({ error: "Không tìm thấy hợp đồng gốc" });
    if (!parent.isParentContract) return res.status(400).json({ error: "Booking này không phải hợp đồng multi-service" });

    const [child] = await db.select(await bookingColumnsCompat()).from(bookingsTable).where(and(eq(bookingsTable.id, childId), eq(bookingsTable.parentId, parentId)));
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

      // Đồng nhất với recalcParentTotalFromChildren: chỉ con CÒN HIỆU LỰC được tính
      // vào tổng cha (bỏ con trong thùng rác + con đã hủy) — nếu không, xoá 1 con có
      // thể "hồi sinh" tiền của con khác đã nằm trong thùng rác.
      const remainingChildren = await tx.select({ totalAmount: bookingsTable.totalAmount, serviceLabel: bookingsTable.serviceLabel, packageType: bookingsTable.packageType })
        .from(bookingsTable).where(and(
          eq(bookingsTable.parentId, parentId),
          isNull(bookingsTable.deletedAt),
          ne(bookingsTable.status, "cancelled"),
        ));
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
      parentId: bookingsTable.parentId,
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

    // Cách ly tiền cha–con: đưa một dịch vụ CON vào thùng rác phải tính lại tổng cha
    // ngay (recalc đã lọc con deleted/cancelled) — không để cha ôm tiền con đã xoá.
    if (target.parentId) await recalcParentTotalFromChildren(target.parentId);

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
    const [target] = await db.select(await bookingColumnsCompat()).from(bookingsTable).where(eq(bookingsTable.id, id));
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
    // Cách ly tiền cha–con: phục hồi một dịch vụ CON thì tổng cha phải cộng lại nó ngay.
    if (target.parentId) await recalcParentTotalFromChildren(target.parentId);
    // Phục hồi CHA khôi phục cả cụm con (kể cả con từng bị trash RIÊNG trước đó, theo
    // query ids ở trên) → tổng cha phải tính lại theo con active, nếu không sẽ đọng
    // giá trị cũ và HỤT tiền của con vừa sống lại (review C1).
    else if (target.isParentContract) await recalcParentTotalFromChildren(id);

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
