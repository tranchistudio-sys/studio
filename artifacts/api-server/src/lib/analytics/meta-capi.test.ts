import { describe, expect, it } from "vitest";
import { purchaseCustomData, sanitizeAttribution } from "./analytics-data";

describe("Meta CAPI business semantics", () => {
  it("uses the persisted payment amount, not contract value", () => {
    expect(purchaseCustomData("2000000", 17, 8)).toEqual({
      value: 2_000_000, currency: "VND", payment_id: "17", booking_id: "8",
    });
  });

  it("keeps only bounded attribution fields", () => {
    expect(sanitizeAttribution({
      firstTouch: { utmSource: "facebook", fbclid: "abc", forbidden: "secret" },
      lastTouch: { landingPage: "/bang-gia" },
      injected: "no",
    })).toEqual({
      firstTouch: { utmSource: "facebook", fbclid: "abc" },
      lastTouch: { landingPage: "/bang-gia" },
    });
  });
});
