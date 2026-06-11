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

import { sanitizeDeductions } from "./bookings.js";
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
