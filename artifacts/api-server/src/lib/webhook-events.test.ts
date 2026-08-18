import { describe, it, expect } from "vitest";
import { extractPostbackText, extractOptinText, buildPostbackPseudoMid } from "./webhook-events";

describe("webhook-events — postback/optin (thuần)", () => {
  it("extractPostbackText: ưu tiên title (điều khách thấy trên nút), fallback payload", () => {
    expect(extractPostbackText({ title: "Xem bảng giá", payload: "PRICE_LIST" })).toBe("Xem bảng giá");
    expect(extractPostbackText({ payload: "GET_STARTED" })).toBe("GET_STARTED");
    expect(extractPostbackText({})).toBe("[khách bấm nút menu]");
    expect(extractPostbackText(undefined)).toBe("[khách bấm nút menu]");
  });

  it("extractOptinText: kèm ref nếu có", () => {
    expect(extractOptinText({ ref: "ADS_CAMPAIGN_7" })).toBe("[khách opt-in: ADS_CAMPAIGN_7]");
    expect(extractOptinText({})).toBe("[khách opt-in nhận tin]");
  });

  it("pseudo-mid ỔN ĐỊNH: cùng event → cùng mid (Meta retry bị dedupe); khác payload/ts → khác mid", () => {
    const a = buildPostbackPseudoMid("psid1", 1753690000000, "PRICE_LIST");
    const b = buildPostbackPseudoMid("psid1", 1753690000000, "PRICE_LIST");
    const c = buildPostbackPseudoMid("psid1", 1753690000001, "PRICE_LIST");
    const d = buildPostbackPseudoMid("psid1", 1753690000000, "GET_STARTED");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a.startsWith("pb:psid1:")).toBe(true);
  });

  it("payload dị dạng (object/null/number) không throw", () => {
    expect(() => buildPostbackPseudoMid("p", null, { weird: true })).not.toThrow();
    expect(() => buildPostbackPseudoMid("p", "abc", 123)).not.toThrow();
    expect(extractPostbackText({ title: 123 as unknown })).toBe("[khách bấm nút menu]");
  });

  it("text bị cắt 500 ký tự (chống payload khổng lồ)", () => {
    expect(extractPostbackText({ title: "x".repeat(2000) }).length).toBe(500);
  });
});
