/**
 * Test fix bug toggle Báo giá tạm + form Chỉnh sửa (17/07):
 * bàn giao booking từ panel sang form phải áp statusOverride — nếu không form
 * init status cũ rồi lưu đè, booking rớt trạng thái vừa toggle.
 */
import { describe, it, expect } from "vitest";
import { applyStatusOverride } from "./effective-status";

describe("applyStatusOverride", () => {
  const BK = { id: 1, status: "pending_service", customerName: "A" };

  it("CA BUG: vừa toggle temp_quote nhưng object còn status cũ → áp override", () => {
    const out = applyStatusOverride(BK, "temp_quote");
    expect(out.status).toBe("temp_quote");
    expect(out.id).toBe(1);
    expect(out.customerName).toBe("A"); // các field khác giữ nguyên
  });

  it("không mutate object gốc", () => {
    applyStatusOverride(BK, "temp_quote");
    expect(BK.status).toBe("pending_service");
  });

  it("chưa toggle (override null/undefined) → trả nguyên object, không copy thừa", () => {
    expect(applyStatusOverride(BK, null)).toBe(BK);
    expect(applyStatusOverride(BK, undefined)).toBe(BK);
  });

  it("toggle OFF (override='confirmed') áp được cho cả gia đình qua map", () => {
    const family = [
      { id: 10, status: "temp_quote" },
      { id: 11, status: "temp_quote" },
    ];
    const out = family.map(b => applyStatusOverride(b, "confirmed"));
    expect(out.map(b => b.status)).toEqual(["confirmed", "confirmed"]);
  });
});
