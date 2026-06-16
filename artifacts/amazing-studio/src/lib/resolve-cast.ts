export type CastResolveSource = "staff_pricing" | "staff_rate" | "none" | "pending";

export type StaffRate = { staffId: number; role: string; taskKey: string; rate: number | null };
export type CastRatePkg = { staffId: number; role: string; packageId: number; amount: number | null };

export function normalizeRoleForCast(role: string): string {
  const r = role.toLowerCase().trim();
  if (r === "photo") return "photographer";
  return r;
}

export function lookupCastByPkg(
  staffId: number | null,
  role: string,
  packageId: number | null,
  castRates: CastRatePkg[],
): number | null {
  if (!staffId || !packageId || !role) return null;
  const r = normalizeRoleForCast(role);
  const found = castRates.find(c => c.staffId === staffId && c.role === r && c.packageId === packageId);
  if (found?.amount != null && found.amount > 0) return found.amount;
  return null;
}

/** Exact taskKey only — no mac_dinh fallback (avoids spurious 100k defaults). */
export function lookupStaffRateExact(
  staffId: number | null,
  role: string,
  taskKey: string,
  rates: StaffRate[],
): number | null {
  if (!staffId || !role || !taskKey) return null;
  const r = normalizeRoleForCast(role);
  const found = rates.find(
    x => x.staffId === staffId && x.role === r && x.taskKey === taskKey && x.rate != null && x.rate > 0,
  );
  return found?.rate ?? null;
}

export type CastResolveResult = {
  amount: number | null;
  source: CastResolveSource;
};

export function resolveCastAmount(
  staffId: number | null,
  role: string,
  baseJobType: string,
  packageId: number | null | undefined,
  allCastRates: CastRatePkg[] | undefined,
  allStaffRates: StaffRate[],
): CastResolveResult {
  if (!staffId || !role) return { amount: null, source: "none" };

  if (packageId) {
    const fromCast = lookupCastByPkg(staffId, role, packageId, allCastRates ?? []);
    if (fromCast != null) return { amount: fromCast, source: "staff_pricing" };
    return { amount: null, source: "none" };
  }

  const taskKey = (baseJobType && baseJobType.trim()) || "mac_dinh";
  const fromRate = lookupStaffRateExact(staffId, role, taskKey, allStaffRates);
  if (fromRate != null) return { amount: fromRate, source: "staff_rate" };

  return { amount: null, source: "none" };
}

export function logCastResolve(ctx: {
  staffId: number | null;
  staffName?: string;
  role: string;
  packageId?: number | null;
  taskKey?: string;
  result: CastResolveResult;
}) {
  if (typeof console === "undefined" || !console.debug) return;
  console.debug("[cast-resolve]", {
    staffId: ctx.staffId,
    staffName: ctx.staffName,
    role: normalizeRoleForCast(ctx.role),
    packageId: ctx.packageId ?? null,
    taskKey: ctx.taskKey,
    resolvedCastAmount: ctx.result.amount,
    source: ctx.result.source,
  });
}

export function assignmentDedupeKey(staffId: number, role: string): string {
  return `${staffId}:${normalizeRoleForCast(role)}`;
}

export function castAmountFromResult(result: CastResolveResult): number {
  return result.amount ?? 0;
}
