import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { resetClientCacheForScope } from "./client-runtime";

describe("tenant runtime cache boundary", () => {
  it("clears all cached tenant data when scope changes", () => {
    const client = new QueryClient();
    client.setQueryData(["customers"], [{ id: 1, name: "Tenant A" }]);

    expect(resetClientCacheForScope(client, "tenant-a", "tenant-b")).toBe(true);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("keeps cache for an identical scope unless an auth sync forces reset", () => {
    const client = new QueryClient();
    client.setQueryData(["calendar"], ["same tenant"]);

    expect(resetClientCacheForScope(client, "tenant-a", "tenant-a")).toBe(false);
    expect(client.getQueryData(["calendar"])).toEqual(["same tenant"]);
    expect(resetClientCacheForScope(client, "tenant-a", "tenant-a", true)).toBe(true);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
