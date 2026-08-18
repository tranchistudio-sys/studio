import { describe, expect, it } from "vitest";
import { runWithTenantDatabase } from "@workspace/db";
import { logWebhookEvent, webhookEvents } from "./webhook-log";

function inTenant<T>(tenantId: string, work: () => T): T {
  return runWithTenantDatabase({
    tenantId,
    tenantSlug: tenantId,
    databaseRef: `db-${tenantId}`,
    pool: {} as never,
    db: {} as never,
  }, work);
}

describe("webhook event cache tenant isolation", () => {
  it("keeps the in-memory diagnostics list private to each tenant", () => {
    const tenantA = `webhook-a-${Date.now()}`;
    const tenantB = `webhook-b-${Date.now()}`;

    inTenant(tenantA, () => logWebhookEvent({
      at: "2026-01-01T00:00:00Z",
      type: "message",
      summary: "studio-a-private",
    }));

    inTenant(tenantB, () => {
      expect(webhookEvents).toHaveLength(0);
      logWebhookEvent({
        at: "2026-01-01T00:00:00Z",
        type: "message",
        summary: "studio-b-private",
      });
      expect(webhookEvents.map((event) => event.summary)).toEqual(["studio-b-private"]);
      expect(JSON.parse(JSON.stringify(webhookEvents))).toEqual([
        expect.objectContaining({ summary: "studio-b-private" }),
      ]);
    });

    inTenant(tenantA, () => {
      expect(webhookEvents.map((event) => event.summary)).toEqual(["studio-a-private"]);
    });
  });
});
