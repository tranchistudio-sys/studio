import { describe, expect, it, vi } from "vitest";
// attendance-mode.ts import `pool` từ @workspace/db (throw "DATABASE_URL must be set"
// lúc import nếu thiếu env). Test chỉ dùng hàm THUẦN (so giờ trễ) → mock db cho gọn,
// theo convention các unit test khác trong repo.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import { staffAssignedToBooking, resolveAttendanceMode, studioLatePenaltyApplies, computeShowLateness, normalizeShootTime } from "./attendance-mode";

// Seed late rules (giống ensureAttendanceSchema): mốc đúng giờ 08:10
const SEED_RULES = [
  { lateFromTime: "08:11", lateToTime: "08:30", penaltyAmount: "10000" },
  { lateFromTime: "08:31", lateToTime: "09:00", penaltyAmount: "20000" },
  { lateFromTime: "09:01", lateToTime: "09:30", penaltyAmount: "30000" },
  { lateFromTime: "09:31", lateToTime: "10:00", penaltyAmount: "50000" },
  { lateFromTime: "10:00", lateToTime: null, penaltyAmount: "100000" },
];

describe("computeShowLateness (so giờ chấm với shoot_time)", () => {
  const run = (checkIn: string, shoot: string) => computeShowLateness(checkIn, shoot, SEED_RULES, "08:10");

  it("đúng giờ / đến sớm → không trễ, không phạt", () => {
    expect(run("14:00", "14:00")).toMatchObject({ isLate: false, penalty: 0 });
    expect(run("13:45", "14:00")).toMatchObject({ isLate: false, penalty: 0 });
  });

  it("trễ nhẹ (1–20p) → tier 0 / vàng, 10k", () => {
    expect(run("14:05", "14:00")).toMatchObject({ isLate: true, tierIdx: 0, penalty: 10000, lateMinutes: 5 });
    expect(run("14:20", "14:00")).toMatchObject({ isLate: true, tierIdx: 0, penalty: 10000 });
  });

  it("trễ vừa (21–50p) → tier 1 / cam, 20k", () => {
    expect(run("14:25", "14:00")).toMatchObject({ isLate: true, tierIdx: 1, penalty: 20000 });
  });

  it("trễ nặng (51–80p) → tier 2 / đỏ, 30k", () => {
    expect(run("14:55", "14:00")).toMatchObject({ isLate: true, tierIdx: 2, penalty: 30000 });
  });

  it("trễ rất nặng → mức cao nhất 100k", () => {
    expect(run("16:30", "14:00")).toMatchObject({ isLate: true, penalty: 100000 });
  });

  it("hoạt động với giờ hẹn buổi sáng y như studio", () => {
    expect(run("08:10", "08:00")).toMatchObject({ isLate: true, tierIdx: 0, penalty: 10000, lateMinutes: 10 });
  });
});

describe("normalizeShootTime", () => {
  it("chuẩn hoá nhiều định dạng về HH:MM", () => {
    expect(normalizeShootTime("14:30")).toBe("14:30");
    expect(normalizeShootTime("8:5")).toBe("08:05");
    expect(normalizeShootTime("8h30")).toBe("08:30");
    expect(normalizeShootTime("9h")).toBe("09:00");
    expect(normalizeShootTime("14g00")).toBe("14:00");
    expect(normalizeShootTime("")).toBeNull();
    expect(normalizeShootTime(null)).toBeNull();
  });
});

describe("staffAssignedToBooking", () => {
  it("detects staff in items[].assignedStaff", () => {
    const row = {
      assigned_staff: [],
      items: [{ assignedStaff: [{ staffId: 3, role: "photographer" }] }],
    };
    expect(staffAssignedToBooking(row, 3)).toBe(true);
    expect(staffAssignedToBooking(row, 99)).toBe(false);
  });

  it("detects legacy photoId on items", () => {
    const row = {
      assigned_staff: null,
      items: [{ photoId: 3, assignedStaff: [] }],
    };
    expect(staffAssignedToBooking(row, 3)).toBe(true);
  });

  it("detects object-style assigned_staff", () => {
    const row = {
      assigned_staff: { photographer: 5 },
      items: null,
    };
    expect(staffAssignedToBooking(row, 5)).toBe(true);
  });
});

describe("resolveAttendanceMode", () => {
  it("SHOW when has booking", () => {
    expect(resolveAttendanceMode({ hasBooking: true, isLeaveExcused: false, isWeekend: false })).toBe("SHOW");
    expect(studioLatePenaltyApplies("SHOW")).toBe(false);
  });

  it("STUDIO when no booking", () => {
    expect(resolveAttendanceMode({ hasBooking: false, isLeaveExcused: false, isWeekend: false })).toBe("STUDIO");
    expect(studioLatePenaltyApplies("STUDIO")).toBe(true);
  });
});
