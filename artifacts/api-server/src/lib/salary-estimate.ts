import { db, pool } from "@workspace/db";
import {
  staffTable, staffJobEarningsTable, staffRatePricesTable,
  staffLeaveRequestsTable, payrollsTable, serviceJobSplitsTable,
  staffCastRatesTable,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

export type EstimateSource = "paid_payroll" | "draft_payroll" | "realtime";

export interface ShowItem {
  bookingId: number;
  shootDate: string;
  role: string;
  taskKey: string;
  serviceName: string;
  rate: number;
  rateType: string;
  fromCastAmount: boolean;
  earningId?: number;
  allowanceType?: string;
  allowanceNote?: string | null;
  // Sale commission realtime: % cast × tiền thực thu
  percentRate?: number;   // vd 7 = 7%
  percentBase?: number;   // = collectedBase (giữ tương thích UI cũ)
  // Task #499: tách "Đã thu" vs "Còn treo" cho sale.
  // CHỈ informational — KHÔNG cộng remainingAmount vào tổng realtime / payroll / earnings.
  collectedBase?: number;     // tổng payments active của booking
  remainingBase?: number;     // max(total_amount - collectedBase, 0)
  collectedAmount?: number;   // collectedBase × percent / 100 (= rate)
  remainingAmount?: number;   // remainingBase × percent / 100 (preview, không cộng)
}

export interface MonthEstimate {
  staffId: number;
  month: number;
  year: number;
  baseSalary: number;
  daysInMonth: number;
  daysAccrued: number;
  baseSalaryAccrued: number;
  showEarnings: number;
  bonus: number;
  penalty: number;
  leaveDeduction: number;
  advance: number;
  total: number;
  source: EstimateSource;
  payrollId?: number;
  showItems: ShowItem[];
  leaveDaysUsed: number;
  leaveDaysCap: number;
  // Forecast cuối tháng (admin-only, populate khi includeForecast=true).
  // Dự báo nội bộ — KHÔNG ghi payroll, không tạo earning.
  forecastShowEarnings?: number;
  forecastBaseSalary?: number;
  forecastTotal?: number;
  forecastShowCount?: number;
  forecastPastCount?: number;
  forecastFutureCount?: number;
}

const ROLE_NORMALIZE: Record<string, string> = {
  sales: "sale",
  photo: "photographer",
};

function normalizeRole(r: string): string {
  return ROLE_NORMALIZE[r] ?? r;
}

// ── Rate resolution ported from job-earnings.ts (supports fixed/percent/per_photo) ──
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
    const fb = await db.select().from(staffRatePricesTable).where(and(
      eq(staffRatePricesTable.staffId, staffId),
      eq(staffRatePricesTable.role, role),
      eq(staffRatePricesTable.taskKey, "mac_dinh"),
    ));
    if (fb.length > 0 && fb[0].rate !== null) {
      return { rate: parseFloat(fb[0].rate!), rateType: fb[0].rateType };
    }
  }
  return null;
}

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

// Highest priority: per-package cast (staff_cast_rates). packageId = items[].serviceId
// (legacy naming — refers to service_packages.id in this codebase).
async function lookupStaffCastByPackage(
  staffId: number, role: string, packageId: number | null | undefined
): Promise<{ rate: number; rateType: string } | null> {
  if (!packageId) return null;
  const rows = await db.select().from(staffCastRatesTable).where(and(
    eq(staffCastRatesTable.staffId, staffId),
    eq(staffCastRatesTable.role, role),
    eq(staffCastRatesTable.packageId, packageId),
  ));
  if (rows.length > 0 && rows[0].amount !== null) {
    const amt = parseFloat(rows[0].amount as unknown as string);
    const rt = (rows[0] as { rateType?: string }).rateType ?? "fixed";
    if (!Number.isNaN(amt) && amt > 0) return { rate: amt, rateType: rt };
  }
  return null;
}

async function resolveEarning(
  staffId: number, role: string, taskKey: string,
  serviceId: number | null | undefined, bookingTotal: number,
  photoCount: number = 0, commissionBase?: number
): Promise<{ rate: number; rateType: string } | null> {
  // 1) Per-package cast (new system) takes precedence over per-taskKey rate.
  const pkgCast = await lookupStaffCastByPackage(staffId, role, serviceId);
  if (pkgCast) {
    let rate = pkgCast.rate;
    if (pkgCast.rateType === "percent") {
      const base = commissionBase !== undefined ? commissionBase : bookingTotal;
      rate = (base * pkgCast.rate) / 100;
    } else if (pkgCast.rateType === "per_photo") {
      rate = pkgCast.rate * Math.max(photoCount, 1);
    }
    return { rate, rateType: pkgCast.rateType };
  }

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
  const split = await lookupServiceSplit(serviceId, role);
  if (split) {
    let rate = split.rate;
    if (split.rateType === "percent") {
      const base = commissionBase !== undefined ? commissionBase : bookingTotal;
      rate = (base * split.rate) / 100;
    } else if (split.rateType === "per_photo") {
      rate = split.rate * Math.max(photoCount, 1);
    }
    return { rate, rateType: split.rateType };
  }
  return null;
}

// Derive service_packages.id for cast lookup. Booking creation/edit carries package
// identity as bookings.service_package_id, and per-item as items[].serviceKey = "pkg-{id}".
// items[].serviceId points to services.id (NOT service_packages.id), so don't use it here.
function derivePackageId(
  bookingPkgId: number | null | undefined,
  items: Array<Record<string, unknown>> | null
): number | null {
  if (typeof bookingPkgId === "number" && bookingPkgId > 0) return bookingPkgId;
  if (Array.isArray(items)) {
    for (const it of items) {
      if (!it) continue;
      const pidRaw = it.packageId ?? it.servicePackageId;
      if (typeof pidRaw === "number" && pidRaw > 0) return pidRaw;
      if (typeof pidRaw === "string") {
        const n = parseInt(pidRaw, 10);
        if (!Number.isNaN(n) && n > 0) return n;
      }
      const key = typeof it.serviceKey === "string" ? it.serviceKey : null;
      if (key && key.startsWith("pkg-")) {
        const n = parseInt(key.slice(4), 10);
        if (!Number.isNaN(n) && n > 0) return n;
      }
    }
  }
  return null;
}

// Commission base = total excluding beauty/makeup items (đồng bộ với computeBookingEarnings).
function computeCommissionBase(items: Array<Record<string, unknown>> | null, bookingTotal: number): number {
  if (!Array.isArray(items) || items.length === 0) return bookingTotal;
  const beautyKeywords = ["beauty", "makeup", "trang điểm", "làm đẹp"];
  return items.reduce((sum, it) => {
    const name = String(it.serviceName ?? "").toLowerCase();
    const cat = String(it.serviceCategory ?? "").toLowerCase();
    const isBeauty = beautyKeywords.some(k => name.includes(k) || cat.includes(k));
    return isBeauty ? sum : sum + (typeof it.price === "number" ? it.price : parseFloat(String(it.price ?? 0)) || 0);
  }, 0);
}

function parseJsonb(val: unknown): unknown {
  if (val == null) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return null; }
  }
  if (Buffer.isBuffer(val)) {
    try { return JSON.parse(val.toString("utf8")); } catch { return null; }
  }
  return val;
}

// Task #496: kiểm assigned_staff đã khai báo sale chưa (bất kể staff nào).
// Dùng để quyết định có fallback sale = created_by_staff_id hay không.
function assignedDeclaresSale(assigned: unknown): boolean {
  if (!assigned) return false;
  if (Array.isArray(assigned)) {
    return (assigned as Array<Record<string, unknown>>).some(e =>
      e && typeof e === "object" && normalizeRole(String(e.role ?? "")) === "sale"
    );
  }
  if (typeof assigned === "object") {
    const a = assigned as Record<string, unknown>;
    const v = a.sale;
    return v != null && String(v).trim() !== "" && String(v) !== "0";
  }
  return false;
}

function extractStaffEntries(
  assignedRaw: unknown, itemsRaw: unknown, staffId: number,
  createdByStaffId?: number | null
): Array<{ role: string; taskKey: string; castAmount: number; manual?: boolean }> {
  const out: Array<{ role: string; taskKey: string; castAmount: number; manual?: boolean }> = [];
  const assigned = parseJsonb(assignedRaw);
  const items = parseJsonb(itemsRaw) as Array<Record<string, unknown>> | null;

  // 1) top-level assigned_staff
  if (assigned) {
    if (Array.isArray(assigned)) {
      for (const entry of assigned as Array<Record<string, unknown>>) {
        if (entry == null || typeof entry !== "object") continue;
        if (String(entry.staffId ?? "") !== String(staffId)) continue;
        const role = normalizeRole(String(entry.role ?? "unknown"));
        const taskKey = String(entry.taskKey ?? "mac_dinh");
        const castRaw = entry.castAmount;
        const cast = typeof castRaw === "number" ? castRaw
          : typeof castRaw === "string" ? parseFloat(castRaw) || 0
          : 0;
        out.push({ role, taskKey, castAmount: cast, manual: entry.castSource === "manual" });
      }
    } else if (typeof assigned === "object") {
      const a = assigned as Record<string, unknown>;
      const map: Array<[string, string, string]> = [
        ["photo", "photographer", "photoTask"],
        ["photographer", "photographer", "photographerTask"],
        ["makeup", "makeup", "makeupTask"],
        ["sale", "sale", "saleTask"],
        ["photoshop", "photoshop", "photoshopTask"],
        ["marketing", "marketing", "marketingTask"],
      ];
      for (const [key, role, taskField] of map) {
        if (String(a[key] ?? "") === String(staffId)) {
          out.push({ role, taskKey: String(a[taskField] ?? "mac_dinh"), castAmount: 0 });
        }
      }
    }
  }

  // 2) items[].assignedStaff  /  items[].photoId / makeupId
  if (Array.isArray(items)) {
    for (const it of items) {
      if (!it) continue;
      const itemStaff = it.assignedStaff as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(itemStaff)) {
        for (const s of itemStaff) {
          if (!s || String(s.staffId ?? "") !== String(staffId)) continue;
          const role = normalizeRole(String(s.role ?? "unknown"));
          const taskKey = String(s.taskKey ?? "mac_dinh");
          const castRaw = s.castAmount;
          const cast = typeof castRaw === "number" ? castRaw
            : typeof castRaw === "string" ? parseFloat(castRaw) || 0
            : 0;
          out.push({ role, taskKey, castAmount: cast, manual: s.castSource === "manual" });
        }
      }
      if (String(it.photoId ?? "") === String(staffId) && !out.find(e => e.role === "photographer")) {
        out.push({ role: "photographer", taskKey: "mac_dinh", castAmount: 0 });
      }
      if (String(it.makeupId ?? "") === String(staffId) && !out.find(e => e.role === "makeup")) {
        out.push({ role: "makeup", taskKey: "mac_dinh", castAmount: 0 });
      }
    }
  }

  // 3) Task #496: Sale fallback = người tạo booking. Nếu assigned_staff KHÔNG khai báo sale
  // (booking cũ trước SaleStaffDropdown hoặc admin quên gán) → coi creator là sale chính.
  if (
    createdByStaffId != null &&
    Number(createdByStaffId) === Number(staffId) &&
    !out.some(e => e.role === "sale") &&
    !assignedDeclaresSale(assigned)
  ) {
    out.push({ role: "sale", taskKey: "mac_dinh", castAmount: 0 });
  }

  // Dedup theo role lấy entry ĐẦU TIÊN → đẩy GIÁ TAY (items) lên trước để nó
  // thắng entry cũ ở top-level assigned_staff (vd đã lưu ở Giao việc). Stable:
  // chỉ đổi vị trí manual, giữ nguyên thứ tự tương đối còn lại.
  const manualFirst = [
    ...out.filter(e => e.manual),
    ...out.filter(e => !e.manual),
  ];
  return manualFirst;
}

async function countApprovedLeaveDays(staffId: number, month: number, year: number): Promise<number> {
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  const rows = await db.select().from(staffLeaveRequestsTable).where(and(
    eq(staffLeaveRequestsTable.staffId, staffId),
    eq(staffLeaveRequestsTable.status, "approved"),
  ));
  const days = new Set<string>();
  for (const r of rows) {
    const sdStr = typeof r.startDate === "string" ? r.startDate : (r.startDate as Date).toISOString().slice(0, 10);
    const edStr = typeof r.endDate === "string" ? r.endDate : (r.endDate as Date).toISOString().slice(0, 10);
    const s = sdStr > monthStart ? sdStr : monthStart;
    const e = edStr < monthEnd ? edStr : monthEnd;
    if (s > e) continue;
    const sd = new Date(s), ed = new Date(e);
    for (let d = new Date(sd); d <= ed; d.setDate(d.getDate() + 1)) {
      days.add(d.toISOString().slice(0, 10));
    }
  }
  return days.size;
}

/**
 * Realtime month salary estimate.
 *
 * Sources (precedence):
 * - paid_payroll  : if payroll status=paid → return locked numbers verbatim (no recompute).
 * - draft_payroll : if payroll status=draft → bonus/penalty/advance từ draft.items, show/base tính realtime.
 * - realtime      : chưa có payroll → bonus/penalty/advance = 0 (không tự infer từ attendance_adjustments).
 *
 * Cấu phần realtime:
 * - baseSalaryAccrued = baseSalary / daysInMonth × daysAccrued
 *   daysAccrued = today.day (current month) | daysInMonth (past) | 0 (future)
 * - showEarnings: bookings shoot_date ≤ effectiveEnd, ưu tiên castAmount embedded trong
 *   assigned_staff; fallback resolveEarning (per-staff rate → service split, hỗ trợ
 *   fixed/percent/per_photo).
 * - leaveDeduction = baseSalary/daysInMonth × max(0, leaveUsed-2).
 * - Dedup: nếu staff_job_earnings đã ghi (bookingId+role+serviceKey) → dùng số đã ghi
 *   (tránh drift với computeBookingEarnings).
 */
export async function computeMonthEstimate(
  staffId: number, month: number, year: number,
  options?: { includeForecast?: boolean }
): Promise<MonthEstimate | null> {
  const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, staffId));
  if (!staff) return null;

  const baseSalary = parseFloat(String(staff.baseSalaryAmount ?? 0)) ||
    parseFloat(String(staff.salary ?? "0").replace(/[^\d.]/g, "")) || 0;

  const now = new Date();
  const daysInMonth = new Date(year, month, 0).getDate();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;
  const isFutureMonth = (year > now.getFullYear()) ||
    (year === now.getFullYear() && month > now.getMonth() + 1);

  const todayDay = now.getDate();
  const daysAccrued = isFutureMonth ? 0 : (isCurrentMonth ? todayDay : daysInMonth);
  const baseSalaryAccrued = daysInMonth > 0
    ? Math.round((baseSalary / daysInMonth) * daysAccrued)
    : 0;

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  const todayStr = now.toISOString().slice(0, 10);
  const effectiveEnd = isFutureMonth ? null
    : isCurrentMonth ? (todayStr < monthEnd ? todayStr : monthEnd)
    : monthEnd;

  // Existing earnings — dedup theo (booking, role) để KHÔNG drift với
  // computeBookingEarnings (taskKey trong assigned_staff có thể khác taskKey
  // được persist từ items[] path, nên ta gộp theo role).
  const existingEarnings = await db.select().from(staffJobEarningsTable).where(and(
    eq(staffJobEarningsTable.staffId, staffId),
    eq(staffJobEarningsTable.month, month),
    eq(staffJobEarningsTable.year, year),
  ));
  const earningByBookingRole = new Map<string, typeof existingEarnings[number][]>();
  for (const e of existingEarnings) {
    if (e.status === "voided") continue;
    const k = `${e.bookingId}-${e.role}`;
    const arr = earningByBookingRole.get(k) ?? [];
    arr.push(e);
    earningByBookingRole.set(k, arr);
  }

  const showItems: ShowItem[] = [];
  let showEarnings = 0;
  // Task #476: track earnings đã đẩy vào showItems để pass cuối surface phần còn lại
  // (vd Photoshop earning của staff KHÔNG nằm trong booking.assigned_staff).
  const consumedEarningIds = new Set<number>();

  if (effectiveEnd) {
    const bookingsR = await pool.query(`
      SELECT id, shoot_date, package_type, service_label, assigned_staff,
             total_amount, items, photo_count, service_package_id,
             created_by_staff_id
      FROM bookings
      WHERE shoot_date >= $1::date AND shoot_date <= $2::date
        AND COALESCE(status, '') <> 'cancelled'
        AND deleted_at IS NULL
        AND (assigned_staff IS NOT NULL OR items IS NOT NULL OR created_by_staff_id IS NOT NULL)
      ORDER BY shoot_date ASC
    `, [monthStart, effectiveEnd]);

    // Task #496: pre-fetch payments active aggregate (1 query) cho sale commission realtime.
    // Sale ăn % cast × tiền THỰC THU (payments status='active'), KHÔNG cache snapshot.
    const bookingIdList = (bookingsR.rows as Array<{ id: number }>).map(b => b.id);
    const paidByBooking = new Map<number, number>();
    if (bookingIdList.length > 0) {
      const payAggR = await pool.query(
        `SELECT booking_id, SUM(amount::numeric) AS paid
           FROM payments
          WHERE booking_id = ANY($1::int[])
            AND COALESCE(status, 'active') = 'active'
          GROUP BY booking_id`,
        [bookingIdList]
      );
      for (const r of payAggR.rows as Array<{ booking_id: number; paid: string }>) {
        paidByBooking.set(r.booking_id, Number(r.paid) || 0);
      }
    }

    for (const b of bookingsR.rows as Array<{
      id: number; shoot_date: string | Date; package_type: string | null;
      service_label: string | null; assigned_staff: unknown;
      total_amount: string | number | null;
      items: Array<Record<string, unknown>> | null;
      photo_count: number | null;
      service_package_id: number | null;
      created_by_staff_id: number | null;
    }>) {
      const entries = extractStaffEntries(b.assigned_staff, b.items, staffId, b.created_by_staff_id);
      if (entries.length === 0) continue;

      const shootDateStr = typeof b.shoot_date === "string"
        ? b.shoot_date
        : new Date(b.shoot_date).toISOString().slice(0, 10);
      const bookingTotal = parseFloat(String(b.total_amount ?? 0)) || 0;
      const photoCount = b.photo_count ?? 0;
      const itemsArr = Array.isArray(b.items) ? b.items : null;
      const packageId = derivePackageId(b.service_package_id, itemsArr);
      const commissionBase = computeCommissionBase(itemsArr, bookingTotal);
      const serviceName = b.service_label || b.package_type || "Dịch vụ";

      // 1) Nếu booking đã có earnings persisted cho role này → dùng nguyên (no drift).
      // Task #496: KHÔNG cache snapshot cho sale — sale luôn recompute từ payments active.
      const consumedRoles = new Set<string>();
      for (const ent of entries) {
        if (consumedRoles.has(ent.role)) continue;
        if (ent.role === "sale") continue; // sale realtime, bỏ persisted
        const existing = earningByBookingRole.get(`${b.id}-${ent.role}`);
        if (!existing || existing.length === 0) continue;
        consumedRoles.add(ent.role);
        for (const e of existing) {
          const rate = parseFloat(e.rate);
          if (rate <= 0) continue;
          showItems.push({
            bookingId: b.id,
            shootDate: shootDateStr,
            role: e.role,
            taskKey: e.serviceKey || ent.taskKey,
            serviceName: e.serviceName || serviceName,
            rate,
            rateType: "fixed",
            fromCastAmount: false,
            earningId: e.id,
          });
          showEarnings += rate;
          consumedEarningIds.add(e.id);
        }
      }

      // 2) Còn lại (chưa có earning persisted) → tính realtime từ cast/rate.
      const paidAmount = paidByBooking.get(b.id) ?? 0;

      for (const ent of entries) {
        if (consumedRoles.has(ent.role)) continue;
        // MẢNG-5 dedup: 1 booking có thể liệt kê nhiều dòng cùng role cho 1 nhân viên
        // (assigned_staff + items[].assignedStaff trùng, hoặc 2 dòng sale). Không đánh dấu
        // role đã xử lý → cộng TRÙNG show/hoa hồng. Add ngay khi vào vòng (giống Pass1).
        consumedRoles.add(ent.role);

        let rate = 0;
        let rateType = "fixed";
        let fromCast = false;
        let percentRateUsed: number | undefined;
        let percentBaseUsed: number | undefined;

        if (ent.castAmount && ent.castAmount > 0) {
          rate = ent.castAmount;
          fromCast = true;
        } else {
          // Task #496: Sale ăn % cast × tiền THỰC THU (payments active).
          // Các role khác giữ behavior cũ (legacy commissionBase chỉ khi taskKey "hoa_hong_*").
          const isSaleRole = ent.role === "sale";
          const isLegacyCommission = isSaleRole && ent.taskKey.startsWith("hoa_hong_");
          const baseForPercent = isSaleRole
            ? paidAmount
            : (isLegacyCommission ? commissionBase : undefined);

          // Lấy raw % để dán nhãn (nếu pkgCast percent)
          const pkgRaw = await lookupStaffCastByPackage(staffId, ent.role, packageId);
          if (pkgRaw && pkgRaw.rateType === "percent") {
            percentRateUsed = pkgRaw.rate;
            percentBaseUsed = baseForPercent ?? bookingTotal;
          }

          const resolved = await resolveEarning(
            staffId, ent.role, ent.taskKey, packageId, bookingTotal, photoCount,
            baseForPercent
          );
          if (resolved && resolved.rate > 0) {
            rate = resolved.rate;
            rateType = resolved.rateType;
          }
        }

        // Task #499: với sale percent, tính thêm "Còn treo" (informational only).
        let collectedBase: number | undefined;
        let remainingBase: number | undefined;
        let collectedAmount: number | undefined;
        let remainingAmount: number | undefined;
        const isSalePercentPreview =
          ent.role === "sale" && percentRateUsed !== undefined;
        if (isSalePercentPreview) {
          collectedBase = paidAmount;
          remainingBase = Math.max(bookingTotal - paidAmount, 0);
          collectedAmount = rate; // = paidAmount × % / 100 (có thể = 0 nếu chưa thu)
          remainingAmount = (remainingBase * percentRateUsed!) / 100;
          // Nếu chưa thu (rate=0) nhưng vẫn còn treo → đảm bảo rateType phản
          // ánh percent để UI render đúng nhãn "Đã thu/Còn treo".
          if (rateType === "fixed") rateType = "percent";
        }

        // Bỏ qua nếu không có rate VÀ không có preview "Còn treo" (vd các role
        // khác chưa khai báo). Sale chưa thu nhưng còn treo → vẫn push để
        // surface công nợ commission cho nhân viên follow khách.
        if (rate <= 0 && !(isSalePercentPreview && (remainingAmount ?? 0) > 0)) continue;

        showItems.push({
          bookingId: b.id,
          shootDate: shootDateStr,
          role: ent.role,
          taskKey: ent.taskKey,
          serviceName,
          rate,
          rateType,
          fromCastAmount: fromCast,
          ...(percentRateUsed !== undefined ? { percentRate: percentRateUsed } : {}),
          ...(percentBaseUsed !== undefined ? { percentBase: percentBaseUsed } : {}),
          ...(collectedBase !== undefined ? { collectedBase } : {}),
          ...(remainingBase !== undefined ? { remainingBase } : {}),
          ...(collectedAmount !== undefined ? { collectedAmount } : {}),
          ...(remainingAmount !== undefined ? { remainingAmount } : {}),
        });
        showEarnings += rate; // CHỈ cộng collectedAmount (=rate). KHÔNG cộng remainingAmount.
      }
    }
  }

  // ── Task #476: surface earnings không match booking.assigned_staff ───────
  // Vd Photoshop: completedBy có thể là staff KHÔNG được giao trên booking.
  // Vẫn cần xuất hiện trên Staff Profile (today/month/total/showItems).
  if (effectiveEnd) {
    const orphanIds = existingEarnings
      .filter(e => e.status !== "voided" && !consumedEarningIds.has(e.id))
      .map(e => e.bookingId);
    if (orphanIds.length > 0) {
      const uniqueIds = Array.from(new Set(orphanIds));
      const bookingsR = await pool.query(
        `SELECT id, shoot_date, package_type, service_label, status, deleted_at
           FROM bookings WHERE id = ANY($1::int[])`,
        [uniqueIds],
      );
      const bookingMeta = new Map<number, { shootDate: string; serviceName: string }>();
      // Booking đã HỦY (cancelled) hoặc đã vào THÙNG RÁC (deleted_at) → không surface earning.
      const cancelledOrphan = new Set<number>();
      for (const b of bookingsR.rows as Array<{
        id: number; shoot_date: string | Date;
        package_type: string | null; service_label: string | null; status: string | null; deleted_at: string | Date | null;
      }>) {
        if (b.status === "cancelled" || b.deleted_at != null) { cancelledOrphan.add(b.id); continue; }
        const sd = typeof b.shoot_date === "string"
          ? b.shoot_date.slice(0, 10)
          : new Date(b.shoot_date).toISOString().slice(0, 10);
        bookingMeta.set(b.id, {
          shootDate: sd,
          serviceName: b.service_label || b.package_type || "Dịch vụ",
        });
      }
      for (const e of existingEarnings) {
        if (e.status === "voided" || consumedEarningIds.has(e.id)) continue;
        if (e.bookingId != null && cancelledOrphan.has(e.bookingId)) continue;
        // Task #496: sale luôn recompute realtime → bỏ qua orphan sale để không double-count.
        if (e.role === "sale") continue;
        const rate = parseFloat(e.rate);
        if (rate <= 0) continue;
        const meta = bookingMeta.get(e.bookingId);
        const shootDateStr = meta?.shootDate
          ?? (typeof e.earnedDate === "string"
              ? e.earnedDate.slice(0, 10)
              : new Date(e.earnedDate).toISOString().slice(0, 10));
        showItems.push({
          bookingId: e.bookingId,
          shootDate: shootDateStr,
          role: e.role,
          taskKey: e.serviceKey || "mac_dinh",
          serviceName: e.serviceName || meta?.serviceName || "Dịch vụ",
          rate,
          rateType: "fixed",
          fromCastAmount: false,
          earningId: e.id,
        });
        showEarnings += rate;
        consumedEarningIds.add(e.id);
      }
    }
  }

  // ── Task #483: Phụ cấp linh hoạt — inject allowances as ShowItems ─────────
  // Allowances are date-bound via the booking's shoot_date. We include all
  // allowances for bookings whose shoot_date falls in [monthStart, effectiveEnd].
  if (effectiveEnd) {
    const allowRows = await pool.query(
      `SELECT sa.id, sa.booking_id, sa.allowance_type, sa.amount, sa.note,
              b.shoot_date, b.package_type, b.service_label
         FROM staff_allowances sa
         JOIN bookings b ON b.id = sa.booking_id
        WHERE sa.staff_id = $1
          AND b.shoot_date >= $2::date
          AND b.shoot_date <= $3::date
          AND COALESCE(b.status, '') <> 'cancelled'
          AND b.deleted_at IS NULL
        ORDER BY b.shoot_date`,
      [staffId, monthStart, effectiveEnd]
    );
    for (const r of allowRows.rows as Array<{
      id: number; booking_id: number; allowance_type: string;
      amount: string; note: string | null;
      shoot_date: string | Date; package_type: string | null; service_label: string | null;
    }>) {
      const amt = parseFloat(String(r.amount ?? 0));
      if (amt <= 0) continue;
      const sd = typeof r.shoot_date === "string"
        ? r.shoot_date.slice(0, 10)
        : new Date(r.shoot_date).toISOString().slice(0, 10);
      showItems.push({
        bookingId: r.booking_id,
        shootDate: sd,
        role: "allowance",
        taskKey: r.allowance_type,
        serviceName: r.service_label || r.package_type || "Phụ cấp",
        rate: amt,
        rateType: "allowance",
        fromCastAmount: false,
        allowanceType: r.allowance_type,
        allowanceNote: r.note,
      });
      showEarnings += amt;
    }
  }
  // ── End allowances ────────────────────────────────────────────────────────

  // ── Payroll source override ────────────────────────────────────────────────
  const [payroll] = await db.select().from(payrollsTable).where(and(
    eq(payrollsTable.staffId, staffId),
    eq(payrollsTable.month, month),
    eq(payrollsTable.year, year),
  ));

  if (payroll && payroll.status === "paid") {
    const itemsAny = (payroll.items ?? {}) as Record<string, unknown>;
    const paidBase = parseFloat(String(payroll.baseSalary));
    const paidShow = parseFloat(String(payroll.showBonus));
    const paidBonus = parseFloat(String(payroll.bonus));
    const paidAdvance = parseFloat(String(payroll.advance));
    const paidPenalty = Number(itemsAny.penalty ?? 0);
    const paidLeaveDed = Number(itemsAny.leaveDeduction ?? 0);
    const leaveUsed = Number(itemsAny.leaveDaysUsed ?? 0);
    const leaveCap = Number(itemsAny.leaveDaysCap ?? 2);
    const paidTotal = parseFloat(String(payroll.netSalary));
    const snap = itemsAny.snapshot as { showItems?: ShowItem[] } | undefined;
    const lockedShowItems = Array.isArray(snap?.showItems) && snap.showItems.length > 0
      ? snap.showItems
      : showItems;
    const result: MonthEstimate = {
      staffId, month, year,
      baseSalary, daysInMonth,
      daysAccrued: daysInMonth,
      baseSalaryAccrued: paidBase,
      showEarnings: paidShow,
      bonus: paidBonus,
      penalty: paidPenalty,
      leaveDeduction: paidLeaveDed,
      advance: paidAdvance,
      total: paidTotal,
      source: "paid_payroll",
      payrollId: payroll.id,
      showItems: lockedShowItems,
      leaveDaysUsed: leaveUsed,
      leaveDaysCap: leaveCap,
    };
    if (options?.includeForecast) {
      // Đã chốt rồi → forecast = total đã chốt.
      result.forecastShowEarnings = paidShow;
      result.forecastBaseSalary = paidBase;
      result.forecastTotal = paidTotal;
      result.forecastShowCount = showItems.length;
      result.forecastPastCount = showItems.length;
      result.forecastFutureCount = 0;
    }
    return result;
  }

  let bonus = 0, penalty = 0, advance = 0;
  let source: EstimateSource = "realtime";
  let payrollId: number | undefined;

  if (payroll && payroll.status === "draft") {
    const itemsAny = (payroll.items ?? {}) as Record<string, unknown>;
    bonus = parseFloat(String(payroll.bonus)) || 0;
    advance = parseFloat(String(payroll.advance)) || 0;
    penalty = Number(itemsAny.penalty ?? 0) || 0;
    source = "draft_payroll";
    payrollId = payroll.id;
  }
  // realtime (no payroll) → bonus/penalty/advance = 0; KHÔNG infer từ
  // attendance_adjustments (chỉ payroll/generate mới đọc adjustments).

  const cap = 2;
  const leaveUsed = await countApprovedLeaveDays(staffId, month, year);
  const overflow = Math.max(0, leaveUsed - cap);
  const leaveDeduction = daysInMonth > 0 ? Math.round((baseSalary / daysInMonth) * overflow) : 0;

  const total = baseSalaryAccrued + showEarnings + bonus - penalty - leaveDeduction - advance;

  const result: MonthEstimate = {
    staffId, month, year,
    baseSalary, daysInMonth, daysAccrued,
    baseSalaryAccrued, showEarnings,
    bonus, penalty, leaveDeduction, advance,
    total,
    source, payrollId,
    showItems,
    leaveDaysUsed: leaveUsed,
    leaveDaysCap: cap,
  };

  // ── Forecast cuối tháng (admin-only) ─────────────────────────────────────
  // Dự báo nội bộ: nếu giữ nguyên lịch đã giao thì cuối tháng phải trả
  // khoảng bao nhiêu. KHÔNG ghi payroll, không tạo earning.
  if (options?.includeForecast) {
    const forecastBookingsR = await pool.query(`
      SELECT id, shoot_date, package_type, service_label, assigned_staff,
             total_amount, items, photo_count, service_package_id,
             created_by_staff_id
      FROM bookings
      WHERE shoot_date >= $1::date AND shoot_date <= $2::date
        AND COALESCE(status, '') <> 'cancelled'
        AND deleted_at IS NULL
        AND (assigned_staff IS NOT NULL OR items IS NOT NULL OR created_by_staff_id IS NOT NULL)
      ORDER BY shoot_date ASC
    `, [monthStart, monthEnd]);

    let fcShowEarnings = 0;
    let fcCount = 0, fcPast = 0, fcFuture = 0;

    for (const b of forecastBookingsR.rows as Array<{
      id: number; shoot_date: string | Date; package_type: string | null;
      service_label: string | null; assigned_staff: unknown;
      total_amount: string | number | null;
      items: Array<Record<string, unknown>> | null;
      photo_count: number | null;
      service_package_id: number | null;
      created_by_staff_id: number | null;
    }>) {
      const entries = extractStaffEntries(b.assigned_staff, b.items, staffId, b.created_by_staff_id);
      if (entries.length === 0) continue;

      const shootDateStr = typeof b.shoot_date === "string"
        ? b.shoot_date.slice(0, 10)
        : new Date(b.shoot_date).toISOString().slice(0, 10);
      const isPast = shootDateStr <= todayStr;

      const bookingTotal = parseFloat(String(b.total_amount ?? 0)) || 0;
      const photoCount = b.photo_count ?? 0;
      const itemsArr = Array.isArray(b.items) ? b.items : null;
      const packageId = derivePackageId(b.service_package_id, itemsArr);
      const commissionBase = computeCommissionBase(itemsArr, bookingTotal);

      // 1) persisted earnings (chỉ có cho booking đã qua ngày)
      // Task #496: sale forecast luôn realtime — bỏ persisted để không drift với % cast hiện tại.
      const consumedRoles = new Set<string>();
      for (const ent of entries) {
        if (consumedRoles.has(ent.role)) continue;
        if (ent.role === "sale") continue;
        const existing = earningByBookingRole.get(`${b.id}-${ent.role}`);
        if (!existing || existing.length === 0) continue;
        consumedRoles.add(ent.role);
        for (const e of existing) {
          const rate = parseFloat(e.rate);
          if (rate <= 0) continue;
          fcShowEarnings += rate;
          fcCount += 1;
          if (isPast) fcPast += 1; else fcFuture += 1;
        }
      }

      // 2) realtime rate (cả future và past chưa persist)
      for (const ent of entries) {
        if (consumedRoles.has(ent.role)) continue;
        // MẢNG-5 dedup (nhánh forecast): giống Pass1, tránh cộng trùng khi nhiều dòng cùng role.
        consumedRoles.add(ent.role);
        let rate = 0;
        if (ent.castAmount && ent.castAmount > 0) {
          rate = ent.castAmount;
        } else {
          // Task #496: forecast cho sale = % cast × total_amount (commission khi thu đủ).
          const isSaleRole = ent.role === "sale";
          const isLegacyCommission = isSaleRole && ent.taskKey.startsWith("hoa_hong_");
          const baseForPercent = isSaleRole
            ? bookingTotal
            : (isLegacyCommission ? commissionBase : undefined);
          const resolved = await resolveEarning(
            staffId, ent.role, ent.taskKey, packageId, bookingTotal, photoCount,
            baseForPercent
          );
          if (resolved && resolved.rate > 0) rate = resolved.rate;
        }
        if (rate <= 0) continue;
        fcShowEarnings += rate;
        fcCount += 1;
        if (isPast) fcPast += 1; else fcFuture += 1;
      }
    }

    // Forecast: lương cứng ĐỦ tháng + tổng show cả tháng + bonus - penalty - leaveDeduction.
    // KHÔNG trừ advance (advance là đã ứng, không phải trả thêm).
    const forecastBaseSalary = baseSalary;
    const forecastTotal = forecastBaseSalary + fcShowEarnings + bonus - penalty - leaveDeduction;

    result.forecastShowEarnings = fcShowEarnings;
    result.forecastBaseSalary = forecastBaseSalary;
    result.forecastTotal = forecastTotal;
    result.forecastShowCount = fcCount;
    result.forecastPastCount = fcPast;
    result.forecastFutureCount = fcFuture;
  }

  return result;
}
