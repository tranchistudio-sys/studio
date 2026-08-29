import { describe, expect, it } from "vitest";
import { isAdvertisingTrackingAllowed } from "./policy";

describe("advertising tracking policy", () => {
  it("tracks anonymous marketing visitors", () => {
    expect(isAdvertisingTrackingAllowed({ authenticated: false, isPublicPath: true, path: "/bang-gia" })).toBe(true);
  });

  it.each(["/calendar", "/bookings", "/payments"])("never tracks internal route %s", (path) => {
    expect(isAdvertisingTrackingAllowed({ authenticated: false, isPublicPath: false, path })).toBe(false);
  });

  it("never tracks authenticated staff even in public preview", () => {
    expect(isAdvertisingTrackingAllowed({ authenticated: true, isPublicPath: true, path: "/bang-gia" })).toBe(false);
  });

  it.each(["/login", "/contract/public-token", "/thiep-cuoi/demo"])("excludes sensitive/non-marketing public route %s", (path) => {
    expect(isAdvertisingTrackingAllowed({ authenticated: false, isPublicPath: true, path })).toBe(false);
  });
});
