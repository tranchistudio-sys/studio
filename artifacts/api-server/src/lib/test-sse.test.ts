import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { runWithTenantDatabase } from "@workspace/db";
import { emitTestSessionEvent, subscribeTestSession } from "./test-sse";

function inTenant<T>(tenantId: string, work: () => T): T {
  return runWithTenantDatabase({
    tenantId,
    tenantSlug: tenantId,
    databaseRef: `db-${tenantId}`,
    pool: {} as never,
    db: {} as never,
  }, work);
}

describe("test SSE tenant isolation", () => {
  it("does not deliver an event to the same session id in another tenant", () => {
    const write = vi.fn<(chunk: string) => boolean>(() => true);
    const response = { write } as unknown as Response;
    const unsubscribe = inTenant("studio-a", () =>
      subscribeTestSession("shared-session-id", response));

    inTenant("studio-b", () => emitTestSessionEvent("shared-session-id", {
      type: "debug_update",
      sessionId: "shared-session-id",
      debug: { source: "studio-b" },
    }));
    expect(write).not.toHaveBeenCalled();

    inTenant("studio-a", () => emitTestSessionEvent("shared-session-id", {
      type: "debug_update",
      sessionId: "shared-session-id",
      debug: { source: "studio-a" },
    }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toContain("studio-a");

    unsubscribe();
  });
});
