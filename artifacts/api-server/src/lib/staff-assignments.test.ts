import { describe, expect, it } from "vitest";
import { resolveBookingAssignedStaff } from "./staff-assignments";

describe("resolveBookingAssignedStaff", () => {
  it("items[].assignedStaff là nguồn chính khi đã khai báo", () => {
    const result = resolveBookingAssignedStaff(
      [{ staffId: 10, staffName: "Legacy", role: "makeup" }],
      [{ assignedStaff: [{ staffId: 25, staffName: "Châu", role: "makeup" }] }],
      [],
    );
    expect(result.map(row => row.staffId)).toEqual([25]);
  });

  it("fallback assigned_staff legacy khi items chưa có assignment", () => {
    const result = resolveBookingAssignedStaff({ photo: 25 }, [], []);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ staffId: 25, role: "photographer" }),
    ]));
  });

  it("gộp phân công dịch vụ cộng thêm", () => {
    const result = resolveBookingAssignedStaff(
      [],
      [{ assignedStaff: [{ staffId: 25, staffName: "Châu", role: "makeup" }] }],
      [{ staffAssignments: [{ staffId: 30, staffName: "Vũ", role: "assistant" }] }],
    );
    expect(result.map(row => row.staffId).sort()).toEqual([25, 30]);
  });
});
