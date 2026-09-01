function configuredUrl(name: string): URL {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} chưa được cấu hình cho provisioning`);
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${name} không phải PostgreSQL URL hợp lệ`);
  }
}

export function assertTenantProvisioningEnvironment(): void {
  const environment = process.env.APP_ENV?.trim().toLowerCase();
  if (environment !== "staging" && environment !== "production")
    throw new Error(
      "Tenant provisioning worker cần APP_ENV=staging hoặc production",
    );
  if (
    environment === "production" &&
    process.env.TENANT_PROVISIONING_PRODUCTION_ACK !== "DATABASE_PER_TENANT"
  )
    throw new Error(
      "Production provisioning chưa có xác nhận DATABASE_PER_TENANT",
    );
  const allowed = new Set(
    (process.env.TENANT_PROVISIONING_HOST_ALLOWLIST ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowed.size || allowed.has("*")) {
    throw new Error(
      "TENANT_PROVISIONING_HOST_ALLOWLIST phải là allowlist tường minh",
    );
  }
  for (const name of [
    "TENANT_PROVISIONING_ADMIN_URL",
    "PLATFORM_DATABASE_URL",
  ] as const) {
    const url = configuredUrl(name);
    if (
      !url.protocol.startsWith("postgres") ||
      !allowed.has(url.hostname.toLowerCase())
    ) {
      throw new Error(`${name} không trỏ tới PostgreSQL host được cho phép`);
    }
  }
}
