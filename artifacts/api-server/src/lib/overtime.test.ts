import { describe, it, expect } from "vitest";
import { computeOvertimeForMonth, roundOvertimeMinutes } from "./overtime.js";

describe("roundOvertimeMinutes", () => {
  it("returns 0 for <15 phút", () => {
    expect(roundOvertimeMinutes(0)).toBe(0);
    expect(roundOvertimeMinutes(14)).toBe(0);
  });
  it("returns 0.5 cho 15-44 phút", () => {
    expect(roundOvertimeMinutes(15)).toBe(0.5);
    expect(roundOvertimeMinutes(30)).toBe(0.5);
    expect(roundOvertimeMinutes(44)).toBe(0.5);
  });
  it("returns 1 cho ≥45 phút", () => {
    expect(roundOvertimeMinutes(45)).toBe(1);
    expect(roundOvertimeMinutes(59)).toBe(1);
    expect(roundOvertimeMinutes(60)).toBe(1);
  });
  it("cộng full hours + remainder", () => {
    expect(roundOvertimeMinutes(75)).toBe(1.5);  // 1h + 15p
    expect(roundOvertimeMinutes(105)).toBe(2);   // 1h + 45p
    expect(roundOvertimeMinutes(135)).toBe(2.5); // 2h + 15p
    expect(roundOvertimeMinutes(74)).toBe(1);    // 1h + 14p
  });
});

describe("computeOvertimeForMonth", () => {
  it("pair 1 cặp check-in/check-out trong ngày → 70p (1h10) → 1h (rem<15)", () => {
    const r = computeOvertimeForMonth([
      { date: "2026-05-01", type: "overtime_check_in", time: "18:00" },
      { date: "2026-05-01", type: "overtime_check_out", time: "19:10" },
    ], 30000);
    expect(r.hours).toBe(1);
    expect(r.pay).toBe(30000);
    expect(r.byDate[0].segments).toEqual([{ start: "18:00", end: "19:10", minutes: 70 }]);
  });

  it("nhiều phiên OT trong 1 ngày → cộng phút trước khi làm tròn", () => {
    // 40p + 30p = 70p → 1h (rem=10 < 15)
    const r = computeOvertimeForMonth([
      { date: "2026-05-02", type: "overtime_check_in", time: "12:00" },
      { date: "2026-05-02", type: "overtime_check_out", time: "12:40" },
      { date: "2026-05-02", type: "overtime_check_in", time: "18:00" },
      { date: "2026-05-02", type: "overtime_check_out", time: "18:30" },
    ], 30000);
    expect(r.byDate[0].minutes).toBe(70);
    expect(r.hours).toBe(1);
    expect(r.pay).toBe(30000);
  });

  it("nhiều ngày → cộng tổng", () => {
    const r = computeOvertimeForMonth([
      { date: "2026-05-01", type: "overtime_check_in", time: "18:00" },
      { date: "2026-05-01", type: "overtime_check_out", time: "19:00" }, // 60p → 1h
      { date: "2026-05-02", type: "overtime_check_in", time: "18:00" },
      { date: "2026-05-02", type: "overtime_check_out", time: "20:30" }, // 150p → 2.5h
    ], 25000);
    expect(r.hours).toBe(3.5);
    expect(r.pay).toBe(87500);
    expect(r.byDate).toHaveLength(2);
  });

  it("bỏ qua check-out không có check-in", () => {
    const r = computeOvertimeForMonth([
      { date: "2026-05-03", type: "overtime_check_out", time: "19:00" },
    ], 30000);
    expect(r.hours).toBe(0);
    expect(r.pay).toBe(0);
  });

  it("check-in mà chưa check-out → không tính (chờ session sau)", () => {
    const r = computeOvertimeForMonth([
      { date: "2026-05-03", type: "overtime_check_in", time: "18:00" },
    ], 30000);
    expect(r.hours).toBe(0);
  });

  it("bỏ qua log không phải overtime type", () => {
    const r = computeOvertimeForMonth([
      { date: "2026-05-04", type: "check_in", time: "08:00" },
      { date: "2026-05-04", type: "check_out", time: "17:00" },
      { date: "2026-05-04", type: "overtime_check_in", time: "18:00" },
      { date: "2026-05-04", type: "overtime_check_out", time: "18:50" }, // 50p → 1h
    ], 30000);
    expect(r.hours).toBe(1);
    expect(r.pay).toBe(30000);
  });

  it("dưới 15 phút → 0", () => {
    const r = computeOvertimeForMonth([
      { date: "2026-05-05", type: "overtime_check_in", time: "18:00" },
      { date: "2026-05-05", type: "overtime_check_out", time: "18:10" },
    ], 30000);
    expect(r.hours).toBe(0);
    expect(r.pay).toBe(0);
  });

  it("custom rate", () => {
    const r = computeOvertimeForMonth([
      { date: "2026-05-06", type: "overtime_check_in", time: "18:00" },
      { date: "2026-05-06", type: "overtime_check_out", time: "20:00" }, // 2h
    ], 50000);
    expect(r.pay).toBe(100000);
  });
});
