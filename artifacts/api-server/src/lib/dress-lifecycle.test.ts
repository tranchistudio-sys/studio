import { describe, it, expect } from "vitest";
import {
  isOverdue,
  effectiveDressStatus,
  isBlockingStatus,
  resolveLifecycleTransition,
  suggestDressDates,
} from "./dress-lifecycle.js";

// ── suggestDressDates — Case 1 ───────────────────────────────────────────────
describe("suggestDressDates", () => {
  it("Case 1: cưới 05/08 → lấy ĐÚNG 05/08, trả 08/08", () => {
    expect(suggestDressDates("2026-08-05")).toEqual({ pickupDate: "2026-08-05", returnDate: "2026-08-08" });
  });
  it("qua ranh giới tháng (trả +3 nhảy tháng)", () => {
    expect(suggestDressDates("2026-07-30")).toEqual({ pickupDate: "2026-07-30", returnDate: "2026-08-02" });
  });
  it("ngày cưới không hợp lệ → rỗng", () => {
    expect(suggestDressDates("")).toEqual({ pickupDate: "", returnDate: "" });
  });
});

// ── isOverdue — Case 4 ───────────────────────────────────────────────────────
describe("isOverdue (derived)", () => {
  const today = "2026-08-10";
  it("Case 4: picked_up, quá ngày trả 08/08, chưa trả thực tế → overdue", () => {
    expect(isOverdue("picked_up", "2026-08-08", null, today)).toBe(true);
  });
  it("đã có ngày trả thực tế → KHÔNG overdue", () => {
    expect(isOverdue("picked_up", "2026-08-08", "2026-08-09", today)).toBe(false);
  });
  it("chưa tới ngày trả → không overdue", () => {
    expect(isOverdue("picked_up", "2026-08-15", null, today)).toBe(false);
  });
  it("status không phải ở tay khách (reserved/cleaning/ready) → không overdue", () => {
    expect(isOverdue("reserved", "2026-08-01", null, today)).toBe(false);
    expect(isOverdue("cleaning", "2026-08-01", null, today)).toBe(false);
    expect(isOverdue("ready", "2026-08-01", null, today)).toBe(false);
  });
});

describe("effectiveDressStatus", () => {
  it("đắp overdue lên picked_up quá hạn", () => {
    expect(effectiveDressStatus({ status: "picked_up", returnDate: "2026-08-01", actualReturnDate: null }, "2026-08-10")).toBe("overdue");
  });
  it("giữ nguyên khi không quá hạn", () => {
    expect(effectiveDressStatus({ status: "cleaning" }, "2026-08-10")).toBe("cleaning");
  });
});

// ── isBlockingStatus — Case 5/6 ──────────────────────────────────────────────
describe("isBlockingStatus", () => {
  it("Case 5: cleaning vẫn CHIẾM (chưa available)", () => {
    expect(isBlockingStatus("cleaning")).toBe(true);
  });
  it("Case 6: ready = available (không chiếm)", () => {
    expect(isBlockingStatus("ready")).toBe(false);
  });
  it("reserved/preparing/picked_up/waiting_return = chiếm", () => {
    for (const s of ["reserved", "preparing", "picked_up", "waiting_return"]) expect(isBlockingStatus(s)).toBe(true);
  });
  it("returned/cancelled = không chiếm", () => {
    expect(isBlockingStatus("returned")).toBe(false);
    expect(isBlockingStatus("cancelled")).toBe(false);
  });
});

// ── resolveLifecycleTransition ───────────────────────────────────────────────
describe("resolveLifecycleTransition", () => {
  it("Khách đã lấy: reserved → picked_up + ghi ngày lấy", () => {
    expect(resolveLifecycleTransition("pick_up", "reserved")).toEqual({ status: "picked_up", setActualPickup: true });
  });
  it("Đã nhận lại: picked_up → CLEANING (không ready) + ghi ngày trả", () => {
    expect(resolveLifecycleTransition("receive_back", "picked_up")).toEqual({ status: "cleaning", setActualReturn: true });
  });
  it("Sẵn sàng chỉ sau cleaning/returned", () => {
    expect(resolveLifecycleTransition("mark_ready", "cleaning")).toEqual({ status: "ready" });
    expect(resolveLifecycleTransition("mark_ready", "returned")).toEqual({ status: "ready" });
    expect(resolveLifecycleTransition("mark_ready", "picked_up")).toBeNull(); // không nhảy cóc từ đang giữ
  });
  it("hành động không hợp lệ với trạng thái → null", () => {
    expect(resolveLifecycleTransition("pick_up", "returned")).toBeNull();
    expect(resolveLifecycleTransition("receive_back", "reserved")).toBeNull();
  });
});
