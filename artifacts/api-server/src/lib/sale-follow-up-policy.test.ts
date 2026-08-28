import { describe, expect, it } from "vitest";
import { followUpControlFromMessage, followUpEligibility } from "./sale-follow-up-policy";

describe("sale follow-up policy", () => {
  it.each([
    ["Đừng nhắn nữa", "DO_NOT_CONTACT"],
    ["Không liên hệ chị nữa", "DO_NOT_CONTACT"],
    ["Chị đặt bên khác rồi", "CHOSE_ANOTHER_STUDIO"],
    ["Chị chọn studio khác rồi", "CHOSE_ANOTHER_STUDIO"],
    ["Không cần nữa em", "NO_LONGER_INTERESTED"],
    ["Chị không làm nữa", "NO_LONGER_INTERESTED"],
  ])("stops follow-up: %s", (message, reason) => {
    expect(followUpControlFromMessage(message)).toMatchObject({ stop: true, stopReason: reason });
  });

  it.each(["Tuần sau nhắn chị", "Cuối tháng liên hệ lại", "Thứ hai nhắn chị"])("preserves requested contact wording: %s", (message) => {
    const result = followUpControlFromMessage(message);
    expect(result.stop).toBe(false);
    expect(result.requestedContactText).toBeTruthy();
  });

  it("does not invent a schedule when customer only says not now", () => {
    expect(followUpControlFromMessage("Giờ chị chưa tính đâu")).toMatchObject({ deferWithoutSchedule: true, requestedContactText: null });
  });

  it.each([
    [{ optedOut: true, aiMode: "active", customerId: null, followUpCount: 0 }, "opted_out"],
    [{ optedOut: false, aiMode: "takeover", customerId: null, followUpCount: 0 }, "ai_mode_takeover"],
    [{ optedOut: false, aiMode: "active", customerId: 12, followUpCount: 0 }, "customer_converted"],
    [{ optedOut: false, aiMode: "active", customerId: null, followUpCount: 3 }, "follow_up_limit_reached"],
    [{ optedOut: false, aiMode: "active", customerId: null, followUpCount: 0, customerRepliedAfterSnapshot: true }, "customer_replied_after_snapshot"],
  ])("blocks ineligible follow-up: %j", (input, reason) => {
    expect(followUpEligibility(input)).toEqual({ allowed: false, reason });
  });
});
