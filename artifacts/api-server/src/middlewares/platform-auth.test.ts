import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

import {
  configuredPublicTenantSlug,
  isPublicBusinessRoute,
  requestIsSameOrigin,
  tenantRoleCanAccessBusiness,
} from "./platform-auth";

function publicRequest(queryTenant?: string, host = "tranchistudio.com") {
  return {
    query: queryTenant === undefined ? {} : { tenant: queryTenant },
    get(name: string) {
      return name.toLowerCase() === "host" ? host : undefined;
    },
  } as any;
}

describe("default-deny API boundary", () => {
  it("ưu tiên tenant selector hợp lệ trên public URL", () => {
    process.env.PUBLIC_TENANT_SLUG = "amazing-studio";
    expect(configuredPublicTenantSlug(publicRequest("cupid-wedding-da-nang"))).toBe("cupid-wedding-da-nang");
  });

  it("fail closed với tenant selector sai định dạng", () => {
    process.env.PUBLIC_TENANT_SLUG = "amazing-studio";
    expect(configuredPublicTenantSlug(publicRequest("../../amazing-studio"))).toBeNull();
    expect(configuredPublicTenantSlug(publicRequest("Cupid Wedding"))).toBeNull();
  });

  it("chỉ mở đúng public contract bằng token, không mở legacy ID route", () => {
    expect(isPublicBusinessRoute("GET", "/public/contracts/by-token/opaque-token")).toBe(true);
    expect(isPublicBusinessRoute("POST", "/public/contracts/by-token/opaque-token/sign")).toBe(true);
    expect(isPublicBusinessRoute("GET", "/contracts/123/public")).toBe(false);
    expect(isPublicBusinessRoute("GET", "/contracts/123/sign")).toBe(false);
  });

  it("không để route nghiệp vụ nhạy cảm lọt qua tên gần giống public", () => {
    for (const [method, path] of [
      ["GET", "/accounting/transactions"],
      ["GET", "/dresses"],
      ["GET", "/payments/export"],
      ["PUT", "/storage/uploads/local/abc"],
      ["GET", "/cms/publicity/internal"],
    ]) {
      expect(isPublicBusinessRoute(method, path)).toBe(false);
    }
  });

  it("chỉ public đúng healthz, không public check-ai-key", () => {
    expect(isPublicBusinessRoute("GET", "/healthz")).toBe(true);
    expect(isPublicBusinessRoute("GET", "/check-ai-key")).toBe(false);
  });

  it("STAFF không gọi API quản trị tài chính/cấu hình", () => {
    expect(tenantRoleCanAccessBusiness("STAFF", "GET", "/accounting/transactions")).toBe(false);
    expect(tenantRoleCanAccessBusiness("STAFF", "POST", "/salary-rates")).toBe(false);
    expect(tenantRoleCanAccessBusiness("STAFF", "PUT", "/settings")).toBe(false);
    expect(tenantRoleCanAccessBusiness("STAFF", "POST", "/staff")).toBe(false);
    expect(tenantRoleCanAccessBusiness("STAFF", "GET", "/calendar")).toBe(true);
    expect(tenantRoleCanAccessBusiness("ADMIN", "POST", "/salary-rates")).toBe(true);
  });

  it("áp dụng policy không phân biệt hoa thường như Express router", () => {
    expect(tenantRoleCanAccessBusiness("STAFF", "get", "/AcCoUnTiNg/Transactions")).toBe(false);
    expect(tenantRoleCanAccessBusiness("STAFF", "post", "/SaLaRy-RaTeS")).toBe(false);
    expect(tenantRoleCanAccessBusiness("STAFF", "put", "/SeTtInGs")).toBe(false);
    expect(tenantRoleCanAccessBusiness("STAFF", "post", "/StAfF/42")).toBe(false);
    expect(isPublicBusinessRoute("get", "/HeAlThZ")).toBe(true);
    expect(isPublicBusinessRoute("GET", "/ACCOUNTING/transactions")).toBe(false);
  });

  it("so khớp origin gồm cả scheme và host", () => {
    const request = (origin: string) => ({
      get(name: string) {
        const headers: Record<string, string> = {
          origin,
          host: "tranchistudio.com",
          "x-forwarded-proto": "https",
        };
        return headers[name.toLowerCase()];
      },
      protocol: "https",
    }) as any;

    expect(requestIsSameOrigin(request("https://tranchistudio.com"))).toBe(true);
    expect(requestIsSameOrigin(request("https://evil.example"))).toBe(false);
    expect(requestIsSameOrigin(request("http://tranchistudio.com"))).toBe(false);
  });
});
