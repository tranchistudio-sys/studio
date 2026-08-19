import { describe, expect, it } from "vitest";
import {
  capLegacyAdmin,
  readLegacyToken,
  signLegacyToken,
  verifyLegacyToken,
} from "./legacy-auth-token";

describe("legacy auth compatibility token", () => {
  it("ký token ngắn hạn và giữ session id chỉ ở phía server", () => {
    const token = signLegacyToken(42, "session-id", 60, "STAFF");
    const payload = readLegacyToken(`Bearer ${token}`);

    expect(payload?.id).toBe(42);
    expect(payload?.sid).toBe("session-id");
    expect(payload?.tenantRole).toBe("STAFF");
    expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(60);
  });

  it("từ chối token hết hạn, sai chữ ký và sai thuật toán", () => {
    const expired = signLegacyToken(7, undefined, -1);
    expect(verifyLegacyToken(`Bearer ${expired}`)).toBeNull();

    const valid = signLegacyToken(7);
    expect(verifyLegacyToken(`Bearer ${valid.slice(0, -1)}x`)).toBeNull();

    const [header, body, signature] = valid.split(".");
    const wrongHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expect(verifyLegacyToken(`Bearer ${wrongHeader}.${body}.${signature}`)).toBeNull();
    expect(header).toBeTruthy();
  });

  it("dùng tenant membership làm trần quyền cho legacy admin", () => {
    const staffMembership = `Bearer ${signLegacyToken(42, "session-id", 60, "STAFF")}`;
    const adminMembership = `Bearer ${signLegacyToken(42, "session-id", 60, "ADMIN")}`;
    const ownerMembership = `Bearer ${signLegacyToken(42, "session-id", 60, "OWNER")}`;

    expect(capLegacyAdmin(staffMembership, true)).toBe(false);
    expect(capLegacyAdmin(adminMembership, false)).toBe(true);
    expect(capLegacyAdmin(ownerMembership, false)).toBe(true);
    expect(capLegacyAdmin(undefined, true)).toBe(true);
  });
});
