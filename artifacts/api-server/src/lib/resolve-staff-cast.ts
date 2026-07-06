import { db } from "@workspace/db";
import { staffCastRatesTable, staffRatePricesTable } from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";

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
  // Slot nhân sự trong gói (vd 'traditional_photo'). Không có = assignment cấp
  // role như trước giờ.
  slotKey?: string | null;
};

export type ResolvedCast = {
  amount: number | null;
  source: CastResolveSource;
  staffId: number;
  staffName?: string;
  role: string;
  packageId: number | null;
  taskKey: string;
  slotKey: string | null;
};

export async function resolveStaffCastAmount(opts: {
  staffId: number;
  role: string;
  packageId?: number | null;
  taskKey?: string | null;
  staffName?: string;
  slotKey?: string | null;
}): Promise<ResolvedCast> {
  const role = normalizeRoleForCast(opts.role);
  const staffId = opts.staffId;
  const packageId = opts.packageId ?? null;
  const taskKey = (opts.taskKey && opts.taskKey.trim()) || "mac_dinh";
  const slotKey = (opts.slotKey && String(opts.slotKey).trim()) || null;
  const base: ResolvedCast = {
    amount: null,
    source: "none",
    staffId,
    staffName: opts.staffName,
    role,
    packageId,
    taskKey,
    slotKey,
  };

  if (!staffId || !role) return base;

  if (packageId) {
    // Có slotKey → CHỈ tra đúng dòng cast của slot đó; thiếu là "Chưa có giá",
    // KHÔNG fallback sang slot khác hay dòng cast cấp role (yêu cầu nghiệp vụ:
    // 2 slot cùng role phải có 2 mức tiền độc lập, không mượn giá nhau).
    // Không slotKey → tra dòng cast cấp role (slot_key IS NULL) — y hệt trước giờ.
    const rows = await db
      .select()
      .from(staffCastRatesTable)
      .where(
        and(
          eq(staffCastRatesTable.staffId, staffId),
          eq(staffCastRatesTable.role, role),
          eq(staffCastRatesTable.packageId, packageId),
          slotKey ? eq(staffCastRatesTable.slotKey, slotKey) : isNull(staffCastRatesTable.slotKey),
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

function assignmentKey(staffId: number, role: string, slotKey?: string | null): string {
  // slotKey trong key: cho phép cùng 1 người giữ 2 slot khác nhau cùng role
  // (vd vừa Photo truyền thống vừa Photo phóng sự). Entry không slot → key như cũ.
  return `${staffId}:${normalizeRoleForCast(role)}:${(slotKey && String(slotKey).trim()) || ""}`;
}

/** Resolve cast from DB, dedupe staffId+role, log corrections. */
export async function normalizeItemsAssignedStaffCast(
  rawItems: unknown,
  bookingPackageId?: number | null,
): Promise<unknown[]> {
  if (!Array.isArray(rawItems)) return [];
  const seenPerItem = new Map<number, Set<string>>();

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
        const key = assignmentKey(raw.staffId, raw.role, raw.slotKey);
        if (seen.has(key)) {
          console.warn("[cast-resolve] dropped duplicate assignment", {
            itemIdx,
            staffId: raw.staffId,
            role: normalizeRoleForCast(raw.role),
            slotKey: raw.slotKey ?? null,
          });
          continue;
        }
        seen.add(key);

        const resolved = await resolveStaffCastAmount({
          staffId: raw.staffId,
          role: raw.role,
          packageId,
          taskKey,
          staffName: raw.staffName,
          slotKey: raw.slotKey,
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
