import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const bookingsTable = { __t: "bookings" } as const;
const expensesTable = { __t: "expenses" } as const;
const staffTable = { __t: "staff" } as const;
const tasksTable = { __t: "tasks" } as const;
const paymentsTable = { __t: "payments" } as const;
const fixedCostsTable = { __t: "fixed_costs" } as const;

type Row = Record<string, unknown>;
const seeded = new Map<unknown, Row[]>();
function setRows(table: unknown, rows: Row[]) {
  seeded.set(table, rows);
}

vi.mock("@workspace/db/schema", () => ({
  bookingsTable,
  expensesTable,
  staffTable,
  tasksTable,
  paymentsTable,
  fixedCostsTable,
}));

vi.mock("@workspace/db", () => {
  const db = {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => Promise.resolve(seeded.get(table) ?? []),
    }),
  };
  // pool.query phải trả {rows: []} (convention repo): GĐ1b-1 route monthly gọi
  // FINANCIAL ENGINE (schema-flags + receivable) qua pool — mock trần sẽ nổ 500.
  return { db, pool: { query: vi.fn(async () => ({ rows: [] })) } };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), and: vi.fn(), desc: vi.fn(), asc: vi.fn(),
  inArray: vi.fn(), or: vi.fn(), ilike: vi.fn(), sql: vi.fn(),
  gte: vi.fn(), lte: vi.fn(),
}));

const { default: revenueRouter } = await import("./revenue.js");

let server: Server;
let baseUrl = "";

function mkBooking(opts: {
  id: number; createdAt: string; total: number;
  service?: string; saleId?: number | null;
  status?: string; shootDate?: string;
}): Row {
  const [y, m, d] = opts.createdAt.split("-").map(Number);
  return {
    id: opts.id,
    totalAmount: String(opts.total),
    paidAmount: "0",
    discountAmount: "0",
    shootDate: opts.shootDate ?? opts.createdAt,
    status: opts.status ?? "confirmed",
    isParentContract: false,
    parentId: null,
    serviceCategory: opts.service ?? "wedding",
    assignedStaff: opts.saleId == null ? null : { sale: opts.saleId },
    createdAt: new Date(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0),
  };
}

beforeAll(async () => {
  setRows(bookingsTable, [
    mkBooking({ id: 1, createdAt: "2026-01-15", total: 10_000_000, service: "wedding", saleId: 101 }),
    mkBooking({ id: 2, createdAt: "2026-02-10", total: 20_000_000, service: "prewedding", saleId: 102 }),
    mkBooking({ id: 3, createdAt: "2026-02-20", total: 5_000_000, service: "wedding", saleId: 101 }),
    mkBooking({ id: 4, createdAt: "2026-03-05", total: 30_000_000, service: "prewedding", saleId: 102 }),
    mkBooking({ id: 5, createdAt: "2026-03-25", total: 7_000_000, service: "wedding", saleId: null }),
  ]);
  setRows(tasksTable, [
    { id: 1, bookingId: 1, cost: "1000000", role: "photographer", taskType: "shoot", status: "done" },
    { id: 2, bookingId: 4, cost: "3000000", role: "photographer", taskType: "shoot", status: "done" },
  ]);
  setRows(expensesTable, [
    { id: 1, bookingId: 1, amount: "500000", expenseDate: "2026-01-16", status: "approved", costClass: "direct" },
    { id: 2, bookingId: 4, amount: "800000", expenseDate: "2026-03-06", status: "approved", costClass: "direct" },
    { id: 3, bookingId: null, amount: "200000", expenseDate: "2026-02-15", status: "approved", costClass: "operating" },
  ]);
  setRows(paymentsTable, [
    { id: 1, bookingId: 1, amount: "10000000", paymentType: "deposit", paidDate: "2026-01-15", paidAt: new Date(2026, 0, 15) },
    { id: 2, bookingId: 2, amount: "10000000", paymentType: "deposit", paidDate: "2026-02-10", paidAt: new Date(2026, 1, 10) },
    { id: 3, bookingId: 3, amount: "5000000", paymentType: "deposit", paidDate: "2026-02-20", paidAt: new Date(2026, 1, 20) },
    { id: 4, bookingId: 4, amount: "15000000", paymentType: "deposit", paidDate: "2026-03-05", paidAt: new Date(2026, 2, 5) },
  ]);
  setRows(staffTable, [
    { id: 101, name: "Sale A" },
    { id: 102, name: "Sale B" },
  ]);
  setRows(fixedCostsTable, []);

  const app = express();
  app.use("/api", revenueRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function get(path: string) {
  const r = await fetch(`${baseUrl}${path}`);
  expect(r.ok).toBe(true);
  return r.json();
}

describe("GET /api/revenue/v2/monthly — date filter regression", () => {
  it("returns different totals for January vs March", async () => {
    const jan = await get("/api/revenue/v2/monthly?from=2026-01-01&to=2026-01-31");
    const mar = await get("/api/revenue/v2/monthly?from=2026-03-01&to=2026-03-31");

    expect(jan.totals.contractValue).toBe(10_000_000);
    expect(jan.totals.bookingCount).toBe(1);
    expect(jan.totals.collected).toBe(10_000_000);

    expect(mar.totals.contractValue).toBe(37_000_000);
    expect(mar.totals.bookingCount).toBe(2);
    expect(mar.totals.collected).toBe(15_000_000);

    expect(jan.totals.contractValue).not.toBe(mar.totals.contractValue);
    expect(jan.totals.bookingCount).not.toBe(mar.totals.bookingCount);
  });

  it("returns echoed from/to in response", async () => {
    const r = await get("/api/revenue/v2/monthly?from=2026-02-01&to=2026-02-28");
    expect(r.dateFrom).toBe("2026-02-01");
    expect(r.dateTo).toBe("2026-02-28");
    expect(r.totals.contractValue).toBe(25_000_000);
    expect(r.totals.bookingCount).toBe(2);
  });
});

describe("GET /api/revenue/v2/by-service — date filter regression", () => {
  it("returns different rows when filtered by January vs March", async () => {
    const jan = await get("/api/revenue/v2/by-service?from=2026-01-01&to=2026-01-31");
    const mar = await get("/api/revenue/v2/by-service?from=2026-03-01&to=2026-03-31");

    const janWedding = jan.find((r: { serviceKey: string }) => r.serviceKey === "wedding");
    const janPrewed = jan.find((r: { serviceKey: string }) => r.serviceKey === "prewedding");
    expect(janWedding?.count).toBe(1);
    expect(janWedding?.contractValue).toBe(10_000_000);
    expect(janPrewed).toBeUndefined();

    const marWedding = mar.find((r: { serviceKey: string }) => r.serviceKey === "wedding");
    const marPrewed = mar.find((r: { serviceKey: string }) => r.serviceKey === "prewedding");
    expect(marWedding?.count).toBe(1);
    expect(marWedding?.contractValue).toBe(7_000_000);
    expect(marPrewed?.count).toBe(1);
    expect(marPrewed?.contractValue).toBe(30_000_000);

    const janTotal = jan.reduce((s: number, r: { contractValue: number }) => s + r.contractValue, 0);
    const marTotal = mar.reduce((s: number, r: { contractValue: number }) => s + r.contractValue, 0);
    expect(janTotal).not.toBe(marTotal);
  });

  it("includes profit reflecting cast + direct expenses in scope", async () => {
    const mar = await get("/api/revenue/v2/by-service?from=2026-03-01&to=2026-03-31");
    const prewed = mar.find((r: { serviceKey: string }) => r.serviceKey === "prewedding");
    // booking 4: collected 15M, cast 3M, direct 0.8M → profit = 15 - 3 - 0.8 = 11.2M
    expect(prewed?.profit).toBe(11_200_000);
  });
});

describe("GET /api/revenue/by-sale — date filter regression (Task #366)", () => {
  it("returns different per-sale rows for January vs March", async () => {
    const jan = await get("/api/revenue/by-sale?from=2026-01-01&to=2026-01-31");
    const mar = await get("/api/revenue/by-sale?from=2026-03-01&to=2026-03-31");

    const janA = jan.find((r: { staffId: number }) => r.staffId === 101);
    expect(janA?.count).toBe(1);
    expect(janA?.revenue).toBe(10_000_000);
    expect(jan.find((r: { staffId: number }) => r.staffId === 102)).toBeUndefined();

    const marB = mar.find((r: { staffId: number }) => r.staffId === 102);
    expect(marB?.count).toBe(1);
    expect(marB?.revenue).toBe(30_000_000);
    expect(mar.find((r: { staffId: number }) => r.staffId === 101)).toBeUndefined();
    expect(mar.find((r: { staffId: number }) => r.staffId === 0)?.revenue).toBe(7_000_000);

    const janTotal = jan.reduce((s: number, r: { revenue: number }) => s + r.revenue, 0);
    const marTotal = mar.reduce((s: number, r: { revenue: number }) => s + r.revenue, 0);
    expect(janTotal).toBe(10_000_000);
    expect(marTotal).toBe(37_000_000);
    expect(janTotal).not.toBe(marTotal);

    // contribution % is recomputed within the scoped range, not against the global total.
    // Jan: Sale A is the only assigned row → 100%. Mar: Sale B = 30/37 ≈ 81%, unassigned ≈ 19%.
    expect(janA?.contribution).toBe(100);
    expect(marB?.contribution).toBe(81);
    expect(mar.find((r: { staffId: number }) => r.staffId === 0)?.contribution).toBe(19);
    expect(janA?.contribution).not.toBe(marB?.contribution);
  });

  it("returns full population when no date filter is provided", async () => {
    const all = await get("/api/revenue/by-sale");
    const total = all.reduce((s: number, r: { revenue: number }) => s + r.revenue, 0);
    expect(total).toBe(72_000_000);
  });
});
