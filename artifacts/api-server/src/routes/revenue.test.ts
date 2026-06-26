import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn() },
}));
vi.mock("@workspace/db/schema", () => ({
  bookingsTable: {},
  expensesTable: {},
  staffTable: {},
  tasksTable: {},
  paymentsTable: {},
  fixedCostsTable: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
}));

import { buildBySaleRows, type BySaleBooking } from "./revenue.js";

function mkBooking(id: number, ymd: string, total: number, saleId: number | null): BySaleBooking {
  const [y, m, d] = ymd.split("-").map(Number);
  return {
    id,
    totalAmount: String(total),
    netAmount: total, // doanh thu NET (không giảm giá trong test ⇒ = total)
    assignedStaff: saleId == null ? null : { sale: saleId },
    createdAt: new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0),
  };
}

describe("buildBySaleRows — date range filtering", () => {
  const bookings: BySaleBooking[] = [
    mkBooking(1, "2026-01-15", 10_000_000, 101),
    mkBooking(2, "2026-02-10", 20_000_000, 102),
    mkBooking(3, "2026-02-20", 5_000_000, 101),
    mkBooking(4, "2026-03-05", 30_000_000, 102),
    mkBooking(5, "2026-03-25", 7_000_000, null),
  ];
  const staffMap = new Map<number, string>([
    [101, "Sale A"],
    [102, "Sale B"],
  ]);
  const castByBooking = new Map<number, number>();
  const directExpByBooking = new Map<number, number>();

  it("returns all bookings when from/to are not provided", () => {
    const rows = buildBySaleRows(bookings, staffMap, castByBooking, directExpByBooking);
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    expect(total).toBe(72_000_000);
    expect(rows.find(r => r.staffId === 101)?.count).toBe(2);
    expect(rows.find(r => r.staffId === 102)?.count).toBe(2);
    expect(rows.find(r => r.staffId === 0)?.count).toBe(1);
  });

  it("scopes results to a single month", () => {
    const rows = buildBySaleRows(
      bookings, staffMap, castByBooking, directExpByBooking,
      "2026-02-01", "2026-02-28",
    );
    expect(rows.find(r => r.staffId === 101)?.revenue).toBe(5_000_000);
    expect(rows.find(r => r.staffId === 102)?.revenue).toBe(20_000_000);
    expect(rows.find(r => r.staffId === 0)).toBeUndefined();
  });

  it("returns different totals for different ranges (regression for Task #366)", () => {
    const jan = buildBySaleRows(
      bookings, staffMap, castByBooking, directExpByBooking,
      "2026-01-01", "2026-01-31",
    );
    const mar = buildBySaleRows(
      bookings, staffMap, castByBooking, directExpByBooking,
      "2026-03-01", "2026-03-31",
    );
    const janTotal = jan.reduce((s, r) => s + r.revenue, 0);
    const marTotal = mar.reduce((s, r) => s + r.revenue, 0);
    expect(janTotal).toBe(10_000_000);
    expect(marTotal).toBe(37_000_000);
    expect(janTotal).not.toBe(marTotal);
  });

  it("recomputes contribution % within the scoped range", () => {
    const rows = buildBySaleRows(
      bookings, staffMap, castByBooking, directExpByBooking,
      "2026-02-01", "2026-02-28",
    );
    expect(rows.find(r => r.staffId === 102)?.contribution).toBe(80);
    expect(rows.find(r => r.staffId === 101)?.contribution).toBe(20);
  });

  it("returns empty when no bookings fall in range", () => {
    const rows = buildBySaleRows(
      bookings, staffMap, castByBooking, directExpByBooking,
      "2025-01-01", "2025-12-31",
    );
    expect(rows).toEqual([]);
  });
});
