import { db } from "@workspace/db";
import { staffCastRatesTable, staffRatePricesTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

export type CastResolveSource = "staff_pricing" | "staff_rate" | "none";

export function normalizeRoleForCast(role: string): string {
  const r = role.toLowerCase().trim();
  if (r === "photo") return "photographer";
  return r;
}

/** service_packages.id from item.serviceKey "pkg-{id}" (NOT items[].serviceId). */
export function derivePackageIdFromItem(
  item: Record<string, unknown>,
  bookingPackageId?: number | null,
): number | null {
  if (typeof bookingPackageId === "number" && bookingPackageId > 0) return bookingPackageId;
  const pidRaw = item.packageId ?? item.servicePackageId;
  if (typeof pidRaw === "number" && pidRaw > 0) return pidRaw;
  if (typeof pidRaw === "string") {
    const n = parseInt(pidRaw, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  const key = typeof item.serviceKey === "string" ? item.serviceKey : null;
  if (key?.startsWith("pkg-")) {
    const n = parseInt(key.slice(4), 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return null;
}

export type StaffAssignmentCastInput = {
  id?: string;
  staffId?: number;
  staffName?: string;
  role?: string;
  castAmount?: number;
  castSource?: string;
  taskKey?: string;
};

export type ResolvedCast = {
  amount: number | null;
  source: CastResolveSource;
  staffId: number;
  staffName?: string;
  role: string;
  packageId: number | null;
  taskKey: string;
};

export async function resolveStaffCastAmount(opts: {
  staffId: number;
  role: string;
  packageId?: number | null;
  taskKey?: string | null;
  staffName?: string;
}): Promise<ResolvedCast> {
  const role = normalizeRoleForCast(opts.role);
  const staffId = opts.staffId;
  const packageId = opts.packageId ?? null;
  const taskKey = (opts.taskKey && opts.taskKey.trim()) || "mac_dinh";
  const base: ResolvedCast = {
    amount: null,
    source: "none",
    staffId,
    staffName: opts.staffName,
    role,
    packageId,
    taskKey,
  };

  if (!staffId || !role) return base;

  if (packageId) {
    const rows = await db
      .select()
      .from(staffCastRatesTable)
      .where(
        and(
          eq(staffCastRatesTable.staffId, staffId),
          eq(staffCastRatesTable.role, role),
          eq(staffCastRatesTable.packageId, packageId),
        ),
      );
    if (rows.length > 0 && rows[0].amount != null) {
      const amt = parseFloat(rows[0].amount as string);
      if (!Number.isNaN(amt) && amt > 0) {
        return { ...base, amount: amt, source: "staff_pricing" };
      }
    }
    return base;
  }

  const rateRows = await db
    .select()
    .from(staffRatePricesTable)
    .where(
      and(
        eq(staffRatePricesTable.staffId, staffId),
        eq(staffRatePricesTable.role, role),
        eq(staffRatePricesTable.taskKey, taskKey),
      ),
    );
  if (rateRows.length > 0 && rateRows[0].rate != null) {
    const rt = rateRows[0].rateType ?? "fixed";
    if (rt === "percent") return base;
    const amt = parseFloat(rateRows[0].rate as string);
    if (!Number.isNaN(amt) && amt > 0) {
      return { ...base, amount: amt, source: "staff_rate" };
    }
  }

  return base;
}

function assignmentKey(staffId: number, role: string): string {
  return `${staffId}:${normalizeRoleForCast(role)}`;
}

// Giá tay áp cho MỌI role đã chọn nhân sự (photographer/makeup/videographer/
// assistant/assistant_photo/marketing/sales/other...). Đường tiền mỗi role:
//  • photographer/makeup: persist job-earnings (snapshot manual) + realtime — như cũ.
//  • Role khác (trừ sale/photoshop): manual > 0 cũng được persist vào
//    staff_job_earnings khi booking hoàn thành (computeBookingEarnings); trước đó
//    realtime (salary-estimate) đọc thẳng castAmount manual — 2 đường cùng 1 số.
//  • sale: KHÔNG persist (hoa hồng tính riêng); manual = số CHỐT thay % cho booking
//    đó trong lương realtime. photoshop: module Hậu kỳ own earning riêng.
// Manual 0đ là GIÁ TRỊ HỢP LỆ (chốt 0 công) — khác với "chưa có giá" (resolve bảng).

/** Build map giá tay ĐANG LƯU trong DB, GẮN THEO VỊ TRÍ DÒNG DỊCH VỤ:
 *  key `itemIdx:staffId:role` → DANH SÁCH amount (1 phần tử mỗi dòng manual).
 *  Override thuộc về đúng assignment/item của nó — non-admin re-save chỉ giữ
 *  được manual Ở ĐÚNG VỊ TRÍ item cũ; sao chép sang item khác KHÔNG match →
 *  bị resolve lại (chặn nhân bản 1 giá tay admin thành nhiều khoản lương).
 *  Mỗi entry chỉ match được MỘT LẦN (consume-once). Yêu cầu castAmount hiện
 *  diện — entry manual thiếu amount không được ngầm hiểu 0đ. */
export function buildPrevManualMap(oldItems: unknown): Map<string, number[]> {
  const m = new Map<string, number[]>();
  if (!Array.isArray(oldItems)) return m;
  (oldItems as Record<string, unknown>[]).forEach((it, itemIdx) => {
    const sa = Array.isArray(it.assignedStaff) ? (it.assignedStaff as StaffAssignmentCastInput[]) : [];
    for (const s of sa) {
      if (!s?.staffId || !s?.role || s.castSource !== "manual" || s.castAmount == null) continue;
      const amt = typeof s.castAmount === "number" ? s.castAmount : parseFloat(String(s.castAmount));
      // >= 0: manual 0đ cũng phải được giữ khi non-admin re-save booking.
      if (Number.isFinite(amt) && amt >= 0) {
        const key = `${itemIdx}:${assignmentKey(s.staffId, s.role)}`;
        const arr = m.get(key) ?? [];
        arr.push(amt);
        m.set(key, arr);
      }
    }
  });
  return m;
}

/** Tìm amount khớp trong prevManual và TIÊU THỤ nó (xoá khỏi danh sách) — mỗi
 *  dòng manual đang lưu chỉ "bảo lãnh" được đúng 1 dòng manual trong payload. */
function matchAndConsumePrevManual(prev: Map<string, number[]> | undefined, key: string, amt: number): boolean {
  const arr = prev?.get(key);
  if (!arr || arr.length === 0) return false;
  const idx = arr.findIndex(v => Math.abs(v - amt) < 0.01);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  return true;
}

/** Sanitize assignedStaff TOP-LEVEL (cột bookings.assigned_staff — lưu raw,
 *  KHÔNG đi qua normalizeItemsAssignedStaffCast): salary-estimate tin cờ
 *  castSource='manual' ở đây, nên non-admin không được phép tự gắn/đổi cờ đó
 *  (vd bơm manual-0 để xoá lương realtime của đồng nghiệp). Admin giữ nguyên;
 *  non-admin chỉ giữ entry manual TRÙNG giá tay đang lưu (consume-once);
 *  entry manual lạ bị hạ cấp castSource='none' + castAmount=0.
 *  Dạng legacy object {sale: N, ...} không có castSource → trả nguyên vẹn. */
export function sanitizeTopLevelAssignedStaffCast(
  raw: unknown,
  opts: { allowManual?: boolean; prevManual?: Map<string, number[]> },
): unknown {
  if (!Array.isArray(raw)) return raw;
  if (opts.allowManual) return raw;
  return (raw as StaffAssignmentCastInput[]).map(entry => {
    if (!entry || entry.castSource !== "manual") return entry;
    const amt = typeof entry.castAmount === "number" ? entry.castAmount : parseFloat(String(entry.castAmount ?? 0));
    if (
      entry.staffId && entry.role && entry.castAmount != null && Number.isFinite(amt) && amt >= 0 &&
      // top-level = pseudo-item index 0 (map build từ [{assignedStaff: old}])
      matchAndConsumePrevManual(opts.prevManual, `0:${assignmentKey(entry.staffId, entry.role)}`, amt)
    ) {
      return entry; // giá tay admin đã chốt, nhân viên re-save giữ nguyên
    }
    console.warn("[cast-resolve] stripped non-admin manual on top-level assignedStaff", {
      staffId: entry.staffId, role: entry.role, castAmount: entry.castAmount,
    });
    return { ...entry, castSource: "none", castAmount: 0 };
  });
}

/** Resolve cast from DB, dedupe staffId+role, log corrections.
 *  opts.allowManual: caller là admin → entry castSource='manual' (giá tay) được
 *  GIỮ NGUYÊN thay vì ghi đè bằng bảng cast.
 *  opts.prevManual: map giá tay đang lưu (buildPrevManualMap) — dùng khi caller
 *  KHÔNG phải admin: entry manual trùng giá đang lưu vẫn được giữ (không bị xoá
 *  khi nhân viên sửa giờ chụp), nhưng giá manual MỚI/ĐỔI thì resolve lại (chặn bơm).
 *  Ngoài 2 trường hợp trên, mọi giá vẫn resolve theo bảng cast như cũ. */
export async function normalizeItemsAssignedStaffCast(
  rawItems: unknown,
  bookingPackageId?: number | null,
  opts?: { allowManual?: boolean; prevManual?: Map<string, number[]> },
): Promise<unknown[]> {
  if (!Array.isArray(rawItems)) return [];
  const seenPerItem = new Map<number, Set<string>>();
  const prevManual = opts?.prevManual;

  return Promise.all(
    (rawItems as Record<string, unknown>[]).map(async (item, itemIdx) => {
      if (!Array.isArray(item.assignedStaff)) return item;
      const packageId = derivePackageIdFromItem(item, bookingPackageId);
      const taskKey = String(item.baseJobType ?? "mac_dinh");
      const seen = seenPerItem.get(itemIdx) ?? new Set<string>();
      seenPerItem.set(itemIdx, seen);

      const normalized: StaffAssignmentCastInput[] = [];
      for (const raw of item.assignedStaff as StaffAssignmentCastInput[]) {
        if (!raw?.staffId || !raw?.role) {
          normalized.push(raw);
          continue;
        }
        const key = assignmentKey(raw.staffId, raw.role);
        if (seen.has(key)) {
          console.warn("[cast-resolve] dropped duplicate assignment", {
            itemIdx,
            staffId: raw.staffId,
            role: normalizeRoleForCast(raw.role),
          });
          continue;
        }
        seen.add(key);

        const canonRole = normalizeRoleForCast(raw.role);
        // Giá tay: giữ khi (a) admin gõ đè, HOẶC (b) non-admin nhưng trùng đúng
        // giá tay đang lưu trong DB (consume-once — 1 dòng lưu chỉ bảo lãnh 1 dòng
        // payload, chặn nhân bản giá tay sang item khác thành 2 khoản lương).
        // Áp cho MỌI role; 0đ là giá trị hợp lệ (chốt 0 công). Yêu cầu castAmount
        // HIỆN DIỆN — entry manual thiếu amount không được ngầm hiểu là 0đ.
        const manualAmt = typeof raw.castAmount === "number" ? raw.castAmount : parseFloat(String(raw.castAmount ?? 0));
        const isManualReq = raw.castSource === "manual" && raw.castAmount != null && Number.isFinite(manualAmt) && manualAmt >= 0;
        // prevManual key GẮN itemIdx: manual chỉ được bảo lãnh ở ĐÚNG dòng dịch vụ cũ.
        const matchesPrev = isManualReq && !opts?.allowManual && matchAndConsumePrevManual(prevManual, `${itemIdx}:${key}`, manualAmt);
        if (isManualReq && (opts?.allowManual || matchesPrev)) {
          console.info("[cast-resolve] manual price kept", {
            staffId: raw.staffId,
            staffName: raw.staffName,
            role: canonRole,
            packageId,
            manualCastAmount: manualAmt,
            via: opts?.allowManual ? "admin" : "prev-match",
          });
          normalized.push({ ...raw, role: canonRole, castAmount: manualAmt, castSource: "manual" });
          continue;
        }

        const resolved = await resolveStaffCastAmount({
          staffId: raw.staffId,
          role: raw.role,
          packageId,
          taskKey,
          staffName: raw.staffName,
        });

        const sent = typeof raw.castAmount === "number" ? raw.castAmount : parseFloat(String(raw.castAmount ?? 0));
        const canonical = resolved.amount ?? 0;
        if (sent > 0 && canonical > 0 && Math.abs(sent - canonical) > 0.01) {
          console.warn("[cast-resolve] corrected cast on save", {
            staffId: raw.staffId,
            staffName: raw.staffName,
            role: resolved.role,
            packageId,
            taskKey,
            sentCastAmount: sent,
            resolvedCastAmount: canonical,
            source: resolved.source,
          });
        }

        console.info("[cast-resolve]", {
          staffId: raw.staffId,
          staffName: raw.staffName,
          role: resolved.role,
          packageId,
          taskKey,
          servicePackage: packageId,
          resolvedCastAmount: canonical,
          source: resolved.source,
        });

        normalized.push({
          ...raw,
          role: resolved.role,
          castAmount: canonical,
          castSource: resolved.source,
        });
      }

      return { ...item, assignedStaff: normalized };
    }),
  );
}
