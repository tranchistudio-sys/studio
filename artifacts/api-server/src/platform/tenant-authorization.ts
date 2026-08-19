import { getPlatformPool, withPlatformTransaction } from "@workspace/platform-db";
import type { Response } from "express";
import type { PlatformSessionContext, TenantRole } from "./types";

export interface TenantStaffMembershipRef {
  id: string;
  userId: string;
  role: TenantRole;
  status: string;
}

export function platformContextFromResponse(res: Response): PlatformSessionContext | null {
  return (res.locals.platformAuth as PlatformSessionContext | undefined) ?? null;
}

export async function findTenantStaffMembership(
  context: PlatformSessionContext,
  tenantStaffId: number,
): Promise<TenantStaffMembershipRef | null> {
  if (!context.activeTenantId) return null;
  const result = await getPlatformPool().query<{
    id: string;
    user_id: string;
    tenant_role: TenantRole;
    status: string;
  }>(
    `SELECT id, user_id, tenant_role, status
     FROM tenant_memberships
     WHERE tenant_id = $1 AND tenant_staff_id = $2
     LIMIT 1`,
    [context.activeTenantId, tenantStaffId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, userId: row.user_id, role: row.tenant_role, status: row.status } : null;
}

export async function revokeTenantStaffSessions(
  context: PlatformSessionContext,
  tenantStaffId: number,
  reason: string,
): Promise<void> {
  const membership = await findTenantStaffMembership(context, tenantStaffId);
  if (!membership) return;
  await withPlatformTransaction(async (client) => {
    await client.query(
      `UPDATE tenant_memberships
       SET auth_version = auth_version + 1,
           sessions_revoked_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [membership.id],
    );
    await client.query(
      `UPDATE sessions
       SET revoked_at = COALESCE(revoked_at, now()),
           revoked_reason = COALESCE(revoked_reason, $2)
       WHERE tenant_membership_id = $1 AND revoked_at IS NULL`,
      [membership.id, reason.slice(0, 200)],
    );
  });
}
