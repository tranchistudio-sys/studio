import { describe, expect, it } from "vitest";
import {
  publicApiUrl,
  publicTenantBase,
  publicTenantPagePath,
  publicTenantRoute,
  publicTenantSlugFromPath,
} from "./public-tenant";

describe("public tenant routing", () => {
  it("giữ Amazing legacy ở root và studio mới ở canonical path riêng", () => {
    expect(publicTenantBase("amazing-studio")).toBe("");
    expect(publicTenantPagePath("/cho-thue-do", "amazing-studio")).toBe("/cho-thue-do");
    expect(publicTenantPagePath("/cho-thue-do", "cupid-wedding-da-nang"))
      .toBe("/studio/cupid-wedding-da-nang/cho-thue-do");
  });

  it("tách cache/API identity theo tenant", () => {
    expect(publicApiUrl("/api/cms/public/packages", "tenant-a"))
      .toContain("tenant=tenant-a");
    expect(publicApiUrl("/api/cms/public/packages", "tenant-b"))
      .toContain("tenant=tenant-b");
  });

  it("parse canonical route và fail closed về legacy selector cho path sai", () => {
    expect(publicTenantRoute("/studio/tenant-a/bo-anh"))
      .toEqual({ base: "/studio/tenant-a", slug: "tenant-a" });
    expect(publicTenantRoute("/studio/../bo-anh")).toBeNull();
    expect(publicTenantSlugFromPath("/studio/tenant-a/bo-anh")).toBe("tenant-a");
    expect(publicTenantSlugFromPath("/studio/../bo-anh")).toBe("amazing-studio");
  });
});
