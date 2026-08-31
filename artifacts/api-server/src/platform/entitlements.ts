import { getPlatformPool, type PlatformQueryable } from "@workspace/platform-db";

export type FeatureKey =
  | "core_management" | "website" | "ai_lulu" | "copilot"
  | "advanced_reports" | "custom_branding" | "custom_domain";

export interface TenantEntitlements {
  planCode: string;
  subscriptionStatus: string;
  active: boolean;
  expiresAt: Date | null;
  features: Record<FeatureKey, boolean>;
}

const EMPTY_FEATURES: Record<FeatureKey, boolean> = {
  core_management: false, website: false, ai_lulu: false, copilot: false,
  advanced_reports: false, custom_branding: false, custom_domain: false,
};

export function resolveEntitlements(input: {
  planCode: string; status: string; expiresAt?: Date | string | null;
  graceUntil?: Date | string | null; features?: Record<string, unknown> | null;
  now?: Date;
}): TenantEntitlements {
  const now = input.now ?? new Date();
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  const graceUntil = input.graceUntil ? new Date(input.graceUntil) : null;
  const statusAllows = input.status === "active" || input.status === "trial" || input.status === "past_due";
  const withinPeriod = !expiresAt || expiresAt > now || (input.status === "past_due" && Boolean(graceUntil && graceUntil > now));
  const active = statusAllows && withinPeriod;
  const features = { ...EMPTY_FEATURES };
  for (const key of Object.keys(features) as FeatureKey[]) features[key] = active && input.features?.[key] === true;
  return { planCode: input.planCode, subscriptionStatus: input.status, active, expiresAt, features };
}

export async function getTenantEntitlements(
  tenantId: string,
  queryable: PlatformQueryable = getPlatformPool(),
): Promise<TenantEntitlements> {
  const result = await queryable.query<{
    plan_code: string; status: string; current_period_ends_at: Date | null;
    grace_until: Date | null; features: Record<string, unknown>;
  }>(`SELECT COALESCE(p.code, upper(p.id)) AS plan_code, s.status,
             s.current_period_ends_at, s.grace_until, p.features
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1 AND s.status <> 'cancelled'
      ORDER BY s.created_at DESC LIMIT 1`, [tenantId]);
  const row = result.rows[0];
  if (!row) return resolveEntitlements({ planCode: "NONE", status: "expired", features: {} });
  return resolveEntitlements({ planCode: row.plan_code, status: row.status,
    expiresAt: row.current_period_ends_at, graceUntil: row.grace_until, features: row.features });
}
