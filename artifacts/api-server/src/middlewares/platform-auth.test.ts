import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

import {
  collaboratorCanAccessBusiness,
  isPublicBusinessRoute,
  platformContextCanAccessBusiness,
  requireActiveTenantManager,
  requestIsSameOrigin,
  tenantRoleCanAccessBusiness,
} from "./platform-auth";
import type { PlatformSessionContext } from "../platform/types";

function context(
  permissions: Record<string, unknown>,
  tenantRole: PlatformSessionContext["tenantRole"] = "STAFF",
): PlatformSessionContext {
  return {
    sessionId: "session",
    createdAt: new Date(),
    userId: "user",
    userStatus: "active",
    platformRole: null,
    activeTenantId: "tenant",
    tenantStatus: "active",
    membershipId: "membership",
    membershipStatus: "active",
    tenantRole,
    tenantStaffId: 25,
    permissions,
    csrfTokenHash: "hash",
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe("default-deny API boundary", () => {
  it("collaborator deny-by-default và chỉ whitelist lịch của chính mình", () => {
    const collaborator = context({
      accessPreset: "COLLABORATOR",
      calendarScope: "OWN",
      bookingDetailScope: "WORK_ONLY",
    });
    expect(platformContextCanAccessBusiness(collaborator, "GET", "/bookings/my-calendar")).toBe(true);
    for (const [method, path] of [
      ["GET", "/bookings"],
      ["GET", "/bookings/501"],
      ["GET", "/customers"],
      ["GET", "/payments"],
      ["GET", "/dashboard"],
      ["GET", "/staff/me/profile"],
      ["POST", "/bookings/my-calendar"],
    ]) {
      expect(platformContextCanAccessBusiness(collaborator, method, path)).toBe(false);
    }
    expect(collaboratorCanAccessBusiness("GET", "/BOOKINGS/MY-CALENDAR")).toBe(true);
    expect(platformContextCanAccessBusiness(
      context({ accessPreset: "COLLABORATOR" }, "ADMIN"),
      "GET",
      "/payments",
    )).toBe(false);
  });

  it("permissions rỗng giữ nguyên quyền STAFF cũ", () => {
    expect(platformContextCanAccessBusiness(context({}), "GET", "/bookings")).toBe(true);
    expect(platformContextCanAccessBusiness(context({}), "GET", "/calendar")).toBe(true);
  });

  it("preset collaborator không thể dùng tenant-manager routes dù role bị lệch thành ADMIN", () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    requireActiveTenantManager({} as any, {
      locals: { platformAuth: context({ accessPreset: "COLLABORATOR" }, "ADMIN") },
      status,
      json,
    } as any, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
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
