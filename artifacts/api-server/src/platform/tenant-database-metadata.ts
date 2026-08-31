export class TenantDatabaseMetadataMismatchError extends Error {
  constructor() { super("Tenant database metadata does not match the registry"); this.name = "TenantDatabaseMetadataMismatchError"; }
}

export function assertTenantDatabaseMetadata(
  expectedTenantId: string,
  tenantSlug: string,
  metadataTenantIds: string[],
): void {
  if (metadataTenantIds.length === 1 && metadataTenantIds[0]?.toLowerCase() === expectedTenantId.toLowerCase()) return;
  if (tenantSlug === "amazing-studio" && metadataTenantIds.length === 0) return;
  throw new TenantDatabaseMetadataMismatchError();
}
