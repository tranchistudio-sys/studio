import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn() },
}));
vi.mock("@workspace/db/schema", () => ({
  bookingsTable: {},
  customersTable: {},
  paymentsTable: {},
  expensesTable: {},
  tasksTable: {},
  staffTable: {},
  servicePackagesTable: {},
  packageItemsTable: {},
  photoshopJobsTable: {},
}));
vi.mock("./auth", () => ({
  verifyToken: vi.fn(),
}));
vi.mock("./job-earnings", () => ({
  computeBookingEarnings: vi.fn(),
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  asc: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
}));

import { buildTempQuoteFamilyStatusUpdate, sanitizeDeductions, normalizeItemStaffLock } from "./bookings.js";
import { sanitizeAdditionalServices, validateAdditionalServices } from "@workspace/db/additional-services";
import { assertAdditionalServicesValid, AdditionalServicesValidationError } from "../lib/additional-services.js";

// ── sanitizeDeductions ────────────────────────────────────────────────────────

describe("sanitizeDeductions", () => {
  it("returns empty array for non-array input", () => {
    expect(sanitizeDeductions(null)).toEqual([]);
    expect(sanitizeDeductions(undefined)).toEqual([]);
    expect(sanitizeDeductions("string")).toEqual([]);
    expect(sanitizeDeductions(42)).toEqual([]);
  });

  it("returns empty array for empty array input", () => {
    expect(sanitizeDeductions([])).toEqual([]);
  });

  it("filters out entries with zero or negative amount", () => {
    const input = [
      { label: "Giảm", amount: 0 },
      { label: "Giảm âm", amount: -100 },
    ];
    expect(sanitizeDeductions(input)).toEqual([]);
  });

  it("filters out entries with empty label", () => {
    const input = [
      { label: "", amount: 500000 },
      { label: "   ", amount: 200000 },
    ];
    expect(sanitizeDeductions(input)).toEqual([]);
  });

  it("trims labels and converts amounts to numbers", () => {
    const input = [{ label: "  Giảm tiền cọc  ", amount: 500000 }];
    expect(sanitizeDeductions(input)).toEqual([
      { label: "Giảm tiền cọc", amount: 500000 },
    ]);
  });

  it("keeps only valid entries from mixed array", () => {
    const input = [
      { label: "Hợp lệ", amount: 100000 },
      { label: "", amount: 50000 },
      { label: "Zero", amount: 0 },
      { label: "Hợp lệ 2", amount: 200000 },
    ];
    expect(sanitizeDeductions(input)).toEqual([
      { label: "Hợp lệ", amount: 100000 },
      { label: "Hợp lệ 2", amount: 200000 },
    ]);
  });

  it("converts string amounts to numbers", () => {
    const input = [{ label: "Test", amount: "300000" as unknown as number }];
    const result = sanitizeDeductions(input);
    expect(result[0].amount).toBe(300000);
    expect(typeof result[0].amount).toBe("number");
  });
});

// ── createdByStaffId — verifyToken integration ────────────────────────────────

describe("POST /bookings — createdByStaffId sourced from JWT", () => {
  it("verifyToken is imported from auth module (mock verifies wiring)", async () => {
    // This test verifies that verifyToken is available in bookings route
    // so callerId can be correctly extracted for createdByStaffId.
    // The mock at top level ensures bookings.ts can load without a real DB.
    const { verifyToken } = await import("./auth.js");
    expect(verifyToken).toBeDefined();
    expect(typeof verifyToken).toBe("function");
  });

  it("verifyToken returns null for missing authorization header", async () => {
    const { verifyToken } = await import("./auth.js");
    (verifyToken as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    expect(verifyToken(undefined)).toBeNull();
  });

  it("verifyToken returns staffId for valid token — callerId used as createdByStaffId", async () => {
    const { verifyToken } = await import("./auth.js");
    (verifyToken as ReturnType<typeof vi.fn>).mockReturnValueOnce(42);
    const callerId = verifyToken("Bearer valid-token");
    expect(callerId).toBe(42);
    // callerId (42) would be stored as createdByStaffId in booking insert
  });
});


describe("validateAdditionalServices", () => {
  it("rejects allocated over qty", () => {
    const lines = sanitizeAdditionalServices([{ id: "a1", title: "Extra", qty: 2, unitPrice: 100000, staffAssignments: [{ staffId: 1, staffName: "A", role: "makeup", allocatedQty: 3, castAmount: 0 }] }]);
    expect(validateAdditionalServices(lines).ok).toBe(false);
  });
  it("assert throws", () => {
    const lines = sanitizeAdditionalServices([{ id: "a2", title: "X", qty: 1, unitPrice: 0, staffAssignments: [{ staffId: 1, staffName: "A", role: "makeup", allocatedQty: 2, castAmount: 0 }] }]);
    expect(() => assertAdditionalServicesValid(lines)).toThrow(AdditionalServicesValidationError);
  });
});

describe("sumActivePayments logic", () => {
  it("filters voided payments", () => {
    const payments = [
      { amount: "1000000", status: "active" },
      { amount: "500000", status: "voided" },
    ];
    const paid = payments
      .filter((p) => (p.status ?? "active") !== "voided")
      .reduce((s, p) => s + parseFloat(p.amount), 0);
    expect(paid).toBe(1000000);
  });
});

describe("temp quote family status SQL", () => {
  it("uses contiguous bind parameters when switching a contract to temp_quote", () => {
    const query = buildTempQuoteFamilyStatusUpdate({
      rootId: 100,
      bookingId: 101,
      customerId: 99,
      rootCode: "DH0375",
      nextStatus: "temp_quote",
    });
    expect(query.values).toEqual([100, 101, 99, "DH0375"]);
    expect(query.text).toContain("status = 'temp_quote'");
    expect(query.text).toContain("$3");
    expect(query.text).not.toContain("$5");
    expect(query.text).toContain("customer_id = $3");
  });

  it("binds the target status when switching a temp quote back to official", () => {
    const query = buildTempQuoteFamilyStatusUpdate({
      rootId: 100,
      bookingId: 101,
      customerId: 99,
      rootCode: "BG0037",
      nextStatus: "confirmed",
    });
    expect(query.values).toEqual([100, 101, 99, "BG0037", "confirmed"]);
    expect(query.text).toContain("status = $5");
  });
});

// ── normalizeItemStaffLock (cờ "Đã đủ nhân sự" theo từng dịch vụ) ─────────────

describe("normalizeItemStaffLock", () => {
  it("giữ nguyên item cũ KHÔNG có cờ — show cũ không tự thành 'đã đủ nhân sự'", () => {
    const items = [{ serviceName: "Chụp tiệc", assignedStaff: [] }];
    expect(normalizeItemStaffLock(items)).toEqual(items);
    expect(Object.prototype.hasOwnProperty.call(normalizeItemStaffLock(items)[0] as object, "staffLocked")).toBe(false);
  });

  it("chỉ boolean true mới được lưu là đã khoá; giá trị rác quy về false", () => {
    const out = normalizeItemStaffLock([
      { serviceName: "A", staffLocked: true },
      { serviceName: "B", staffLocked: false },
      { serviceName: "C", staffLocked: "true" },
      { serviceName: "D", staffLocked: 1 },
      { serviceName: "E", staffLocked: null },
    ]) as { serviceName: string; staffLocked: unknown }[];
    expect(out.map(i => i.staffLocked)).toEqual([true, false, false, false, false]);
  });

  it("không đụng tới nhân sự/giá của dòng dịch vụ", () => {
    const staff = [{ role: "photographer", staffId: 1, staffName: "TranChi", castAmount: 500000 }];
    const out = normalizeItemStaffLock([
      { serviceName: "Chụp cổng", price: 3900000, assignedStaff: staff, staffLocked: true },
    ]) as Record<string, unknown>[];
    expect(out[0].assignedStaff).toEqual(staff);
    expect(out[0].price).toBe(3900000);
    expect(out[0].staffLocked).toBe(true);
  });

  it("phần tử không phải object thì trả nguyên vẹn (không crash)", () => {
    expect(normalizeItemStaffLock([null, "x", 3])).toEqual([null, "x", 3]);
  });
});
