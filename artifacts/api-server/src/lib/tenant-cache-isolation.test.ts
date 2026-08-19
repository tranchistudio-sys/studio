import { describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workspace/db")>(),
  pool: { query },
}));

import {
  maybeTenantDatabaseContext,
  runWithTenantDatabase,
} from "@workspace/db";
import { getAiProviderConfig } from "./ai-provider";

function inTenant<T>(tenantId: string, work: () => T): T {
  return runWithTenantDatabase({
    tenantId,
    tenantSlug: tenantId,
    databaseRef: `db-${tenantId}`,
    pool: {} as never,
    db: {} as never,
  }, work);
}

describe("DB-derived cache tenant isolation", () => {
  it("does not reuse one studio's AI provider config for another studio", async () => {
    query.mockImplementation(async () => {
      const tenantId = maybeTenantDatabaseContext()?.tenantId;
      const primary = tenantId?.startsWith("cache-a-") ? "claude" : "openai";
      return {
        rows: [{ value: JSON.stringify({
          primary,
          fallback1: null,
          fallback2: null,
          autoFallback: false,
          timeoutMs: 5000,
          retries: 0,
        }) }],
      };
    });
    const suffix = String(Date.now());
    const tenantA = `cache-a-${suffix}`;
    const tenantB = `cache-b-${suffix}`;

    await expect(inTenant(tenantA, () => getAiProviderConfig()))
      .resolves.toMatchObject({ primary: "claude" });
    await expect(inTenant(tenantB, () => getAiProviderConfig()))
      .resolves.toMatchObject({ primary: "openai" });
    await expect(inTenant(tenantA, () => getAiProviderConfig()))
      .resolves.toMatchObject({ primary: "claude" });

    expect(query).toHaveBeenCalledTimes(2);
  });
});
