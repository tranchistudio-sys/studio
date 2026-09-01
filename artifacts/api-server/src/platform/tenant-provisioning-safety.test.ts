import { afterEach, describe, expect, it } from "vitest";
import { assertTenantProvisioningEnvironment } from "./tenant-provisioning-safety";

const names = ["APP_ENV", "TENANT_PROVISIONING_HOST_ALLOWLIST", "TENANT_PROVISIONING_ADMIN_URL", "PLATFORM_DATABASE_URL"];
afterEach(() => names.forEach((name) => delete process.env[name]));

function validStagingEnvironment() {
  process.env.APP_ENV = "staging";
  process.env.TENANT_PROVISIONING_HOST_ALLOWLIST = "amazing-studio-staging-db.internal";
  process.env.TENANT_PROVISIONING_ADMIN_URL = "postgres://provisioner:secret@amazing-studio-staging-db.internal:5432/postgres";
  process.env.PLATFORM_DATABASE_URL = "postgres://platform:secret@amazing-studio-staging-db.internal:5432/amazing_platform_staging";
}

describe("tenant provisioning environment safety", () => {
  it("accepts only the explicitly allowlisted staging host", () => {
    validStagingEnvironment();
    expect(() => assertTenantProvisioningEnvironment()).not.toThrow();
  });

  it("rejects production even when URLs otherwise match", () => {
    validStagingEnvironment(); process.env.APP_ENV = "production";
    expect(() => assertTenantProvisioningEnvironment()).toThrow(/APP_ENV=staging/);
  });

  it("rejects missing, wildcard, and mismatched host allowlists", () => {
    validStagingEnvironment(); process.env.TENANT_PROVISIONING_HOST_ALLOWLIST = "";
    expect(() => assertTenantProvisioningEnvironment()).toThrow(/allowlist/);
    process.env.TENANT_PROVISIONING_HOST_ALLOWLIST = "*";
    expect(() => assertTenantProvisioningEnvironment()).toThrow(/allowlist/);
    process.env.TENANT_PROVISIONING_HOST_ALLOWLIST = "production-db.internal";
    expect(() => assertTenantProvisioningEnvironment()).toThrow(/staging/);
  });
});
