import { describe, expect, it } from "vitest";
import { staffAssignedToBooking, resolveAttendanceMode, studioLatePenaltyApplies } from "./attendance-mode";

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
