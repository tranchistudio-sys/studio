import { db, pool } from "@workspace/db";
import { servicePackagesTable, serviceGroupsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

const TRUE_GROUP_NAMES = new Set([
  "CHỤP CỔNG TẠI STUDIO",
  "ALBUM TẠI STUDIO",
  "ALBUM NGOẠI CẢNH",
  "CHỤP TIỆC CƯỚI",
  "BEAUTY / THỜI TRANG",
  "CHỤP GIA ĐÌNH",
  "QUAY PHIM",
]);

const PRINT_TRUE_GROUP_NAMES = new Set([
  "ALBUM TẠI STUDIO",
  "ALBUM NGOẠI CẢNH",
  "IN ẢNH",
]);

const FALSE_GROUP_NAMES = new Set([
  "MAKEUP LẺ",
  "IN ẢNH",
  "COMBO KHÔNG MAKEUP",
  "COMBO CÓ MAKEUP",
  "COMBO TRANG PHỤC CƯỚI - CÓ MAKEUP",
  "COMBO TRANG PHỤC CƯỚI - KHÔNG MAKEUP",
]);

export function defaultRequiresPrintingByGroupName(groupName: string | null | undefined): boolean {
  if (!groupName) return false;
  const n = groupName.trim().toUpperCase();
  return PRINT_TRUE_GROUP_NAMES.has(n);
}

export function defaultRequiresPostProductionByGroupName(groupName: string | null | undefined): boolean {
  if (!groupName) return false;
  const n = groupName.trim().toUpperCase();
  if (FALSE_GROUP_NAMES.has(n)) return false;
  if (TRUE_GROUP_NAMES.has(n)) return true;
  if (n.includes("COMBO")) return false;
  if (n.includes("MAKEUP") && !n.includes("CHỤP")) return false;
  if (n.includes("IN ẢNH") || n.includes("THUÊ")) return false;
  return false;
}

export function parsePackageIdFromItem(item: Record<string, unknown>): number | null {
  const raw = item.packageId ?? item.servicePackageId ?? item.serviceId;
  if (typeof raw === "number" && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return parseInt(raw, 10);
  const key = typeof item.serviceKey === "string" ? item.serviceKey : "";
  if (key.startsWith("pkg-")) {
    const n = parseInt(key.slice(4), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export function packageIdsFromBookingLike(booking: {
  servicePackageId?: number | null;
  items?: unknown;
}): number[] {
  const ids = new Set<number>();
  if (booking.servicePackageId && booking.servicePackageId > 0) ids.add(booking.servicePackageId);
  const items = Array.isArray(booking.items) ? booking.items as Record<string, unknown>[] : [];
  for (const it of items) {
    const pid = parsePackageIdFromItem(it);
    if (pid) ids.add(pid);
  }
  return [...ids];
}

export async function packageRequiresPostProduction(packageId: number): Promise<boolean> {
  const [pkg] = await db
    .select({ flag: servicePackagesTable.requiresPostProduction })
    .from(servicePackagesTable)
    .where(eq(servicePackagesTable.id, packageId));
  return (pkg?.flag ?? 0) !== 0;
}

export async function bookingRequiresPostProduction(booking: {
  servicePackageId?: number | null;
  items?: unknown;
}): Promise<boolean> {
  const ids = packageIdsFromBookingLike(booking);
  if (ids.length === 0) return false;
  const rows = await db
    .select({ id: servicePackagesTable.id, flag: servicePackagesTable.requiresPostProduction })
    .from(servicePackagesTable)
    .where(inArray(servicePackagesTable.id, ids));
  return rows.some(r => (r.flag ?? 0) !== 0);
}

export async function defaultRequiresPostProductionForGroupId(groupId: number | null | undefined): Promise<boolean> {
  if (!groupId) return false;
  const [g] = await db.select({ name: serviceGroupsTable.name }).from(serviceGroupsTable).where(eq(serviceGroupsTable.id, groupId));
  return defaultRequiresPostProductionByGroupName(g?.name);
}

export async function defaultRequiresPrintingForGroupId(groupId: number | null | undefined): Promise<boolean> {
  if (!groupId) return false;
  const [g] = await db.select({ name: serviceGroupsTable.name }).from(serviceGroupsTable).where(eq(serviceGroupsTable.id, groupId));
  return defaultRequiresPrintingByGroupName(g?.name);
}

/** SQL snippet: booking linked to at least one package with requires_post_production = true */
export const BOOKING_REQUIRES_POST_PRODUCTION_SQL = `
  (
    b.service_package_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM service_packages sp_req
      WHERE sp_req.id = b.service_package_id AND sp_req.requires_post_production = true
    )
  )
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(COALESCE(b.items, '[]'::jsonb)) = 'array'
           THEN b.items ELSE '[]'::jsonb END
    ) AS it
    WHERE
      (
        (it->>'packageId') ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM service_packages spc
          WHERE spc.id = (it->>'packageId')::int AND spc.requires_post_production = true
        )
      )
      OR (
        (it->>'servicePackageId') ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM service_packages spc
          WHERE spc.id = (it->>'servicePackageId')::int AND spc.requires_post_production = true
        )
      )
      OR (
        (it->>'serviceKey') ~ '^pkg-[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM service_packages spc
          WHERE spc.id = REPLACE(it->>'serviceKey', 'pkg-', '')::int
            AND spc.requires_post_production = true
        )
      )
  )
`;
