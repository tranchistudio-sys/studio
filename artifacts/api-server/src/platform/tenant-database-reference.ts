export interface AmazingTenantDatabaseReference {
  hostRef: string;
  databaseName: string;
  roleName: string;
}

export interface TenantDatabaseRegistryRow {
  database_ref: string;
  host_ref: string;
  database_name: string;
  role_name: string;
  secret_ref: string | null;
}

function parseConnectionReference(raw: string, label: string): AmazingTenantDatabaseReference {
  const url = new URL(raw);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const roleName = decodeURIComponent(url.username);
  if (!url.hostname || !databaseName || !roleName) {
    throw new Error(`${label} thiếu host, database hoặc role`);
  }
  return {
    hostRef: url.host.toLowerCase(),
    databaseName,
    roleName,
  };
}

export function resolveAmazingTenantDatabaseReference(): AmazingTenantDatabaseReference {
  const defaultUrl = process.env.DEFAULT_TENANT_DATABASE_URL?.trim();
  const businessUrl = process.env.DATABASE_URL?.trim();
  if (!defaultUrl || !businessUrl) {
    throw new Error(
      "DEFAULT_TENANT_DATABASE_URL và DATABASE_URL phải cùng trỏ tới database Amazing Studio hiện tại",
    );
  }
  const expected = parseConnectionReference(defaultUrl, "DEFAULT_TENANT_DATABASE_URL");
  const current = parseConnectionReference(businessUrl, "DATABASE_URL");
  if (
    expected.hostRef !== current.hostRef ||
    expected.databaseName !== current.databaseName ||
    expected.roleName !== current.roleName
  ) {
    throw new Error(
      "DEFAULT_TENANT_DATABASE_URL không khớp DATABASE_URL nghiệp vụ hiện tại; từ chối fallback database",
    );
  }
  return expected;
}

export function registryMatchesAmazingRuntime(row: TenantDatabaseRegistryRow | undefined): boolean {
  if (!row) return false;
  const expected = resolveAmazingTenantDatabaseReference();
  return (
    row.database_ref === "amazing-studio-current-production" &&
    row.host_ref === expected.hostRef &&
    row.database_name === expected.databaseName &&
    row.role_name === expected.roleName &&
    row.secret_ref === "env:DEFAULT_TENANT_DATABASE_URL"
  );
}
