import { describe, expect, it } from "vitest";
import {
  buildCollaboratorCalendarEntry,
  parseCollaboratorCalendarRange,
  resolveCollaboratorServiceNames,
  type CollaboratorCalendarRow,
} from "./collaborator-calendar";

function row(assignedStaff: unknown): CollaboratorCalendarRow {
  return {
    id: 501,
    order_code: "DH0501",
    customer_name: "Khách A",
    shoot_date: "2026-08-25",
    shoot_time: "08:30",
    service_category: "wedding",
    package_type: "Phóng sự cưới",
    location: "Tây Ninh",
    status: "confirmed",
    items: [{ assignedStaff }],
    assigned_staff: [],
    additional_services: [],
    service_label: "Lễ cưới",
    customer_phone: "0900000000",
    total_amount: "20000000",
    deposit_amount: "5000000",
    paid_amount: "5000000",
    internal_notes: "ghi chú mật",
  };
}

describe("collaborator calendar DTO", () => {
  it("chỉ tạo DTO khi chính tenantStaffId được phân công", () => {
    expect(buildCollaboratorCalendarEntry(row([
      { staffId: 25, staffName: "Châu", role: "makeup" },
      { staffId: 30, staffName: "Vũ", role: "photographer" },
    ]), [], 25)).toEqual(expect.objectContaining({ bookingId: 501, assignedRoles: ["makeup"] }));
    expect(buildCollaboratorCalendarEntry(row([
      { staffId: 30, staffName: "Vũ", role: "photographer" },
    ]), [], 25)).toBeNull();
  });

  it("không để PII điện thoại, tiền hoặc ghi chú lọt vào DTO", () => {
    const dto = buildCollaboratorCalendarEntry(row([
      { staffId: 25, staffName: "Châu", role: "makeup" },
    ]), [], 25)!;
    expect(dto).not.toHaveProperty("customerPhone");
    expect(dto).not.toHaveProperty("totalAmount");
    expect(dto).not.toHaveProperty("depositAmount");
    expect(dto).not.toHaveProperty("paidAmount");
    expect(dto).not.toHaveProperty("notes");
    expect(dto).not.toHaveProperty("internalNotes");
  });

  it("ưu tiên tên gói snapshot trong item thay cho nhãn Dịch vụ N", () => {
    const booking = row([]);
    booking.service_label = "Dịch vụ 1";
    booking.package_type = "Dịch vụ 1";
    booking.items = [{
      serviceName: "Combo Makeup Luxury",
      assignedStaff: [{ staffId: 25, staffName: "Châu", role: "makeup" }],
      price: 9_500_000,
    }];

    const dto = buildCollaboratorCalendarEntry(booking, [], 25)!;
    expect(dto.serviceName).toBe("Combo Makeup Luxury");
    expect(dto.serviceNames).toEqual(["Combo Makeup Luxury"]);
    expect(dto).not.toHaveProperty("price");
  });

  it("chỉ ưu tiên tên item được giao cho chính CTV", () => {
    const booking = row([]);
    booking.items = [
      {
        serviceName: "Chụp cổng Luxury",
        assignedStaff: [{ staffId: 25, role: "makeup" }],
      },
      {
        serviceName: "Chụp tiệc",
        assignedStaff: [{ staffId: 30, role: "photographer" }],
      },
    ];
    expect(resolveCollaboratorServiceNames(booking, 25)).toEqual(["Chụp cổng Luxury"]);
  });

  it("lấy tên dịch vụ cộng thêm khi CTV được giao tại dòng đó", () => {
    const booking = row([]);
    booking.items = [];
    booking.additional_services = [{
      title: "Makeup tại nhà",
      staffAssignments: [{ staffId: 25, role: "makeup" }],
      unitPrice: 2_000_000,
    }];
    expect(resolveCollaboratorServiceNames(booking, 25)).toEqual(["Makeup tại nhà"]);
  });
});

describe("collaborator calendar range", () => {
  it("chỉ nhận ngày hợp lệ và tối đa 93 ngày", () => {
    expect(parseCollaboratorCalendarRange("2026-08-01", "2026-08-31")).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(parseCollaboratorCalendarRange("2026-02-30", "2026-03-01")).toBeNull();
    expect(parseCollaboratorCalendarRange("2026-08-31", "2026-08-01")).toBeNull();
    expect(parseCollaboratorCalendarRange("2026-01-01", "2026-12-31")).toBeNull();
  });
});
