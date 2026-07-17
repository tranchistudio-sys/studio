/**
 * Integration test cho /api/revenue/v2/evidence — BẰNG CHỨNG SỐ LIỆU.
 *
 * Bất biến CỐT LÕI (yêu cầu chủ studio 17/07): với CÙNG kỳ lọc,
 *   detailTotal (tổng các dòng bằng chứng) == cardTotal (số trên ô)
 *   == totals của /api/revenue/v2/monthly — lệch 0 đồng, metric nào cũng vậy.
 *
 * Kèm các rule tiền bắt buộc: temp_quote/cancelled/deleted không vào số chính thức,
 * void/refund loại khỏi Đã thu, giảm giá ra NET đúng, nhiều phiếu không double-count.
 * (Family allocation trên DB THẬT được kiểm ở src/truth/revenue-evidence.itest.ts.)
 */
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
  // pool.query: cast từ sổ staff_job_earnings + danh mục fixed_costs (nhánh mock riêng);
  // enrichment/engine SQL khác trả rỗng — evidence phải vẫn KHỚP TỪNG ĐỒNG
  // vì enrichment chỉ là nhãn, không phải nguồn số tiền.
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (String(sql).includes("staff_job_earnings") && String(sql).includes("GROUP BY")) {
        return { rows: [
          { bid: 1, cast_total: "1000000", cnt: "1" },
          { bid: 5, cast_total: "1500000", cnt: "2" },
        ] };
      }
      if (String(sql).includes("FROM fixed_costs")) {
        return { rows: [{ label: "Mặt bằng", amount: "2000000" }] };
      }
      return { rows: [] };
    }),
  };
  return { db, pool };
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
  id: number; createdAt: string; total: number; discount?: number;
  status?: string; shootDate?: string; parentId?: number | null;
  isParent?: boolean; deletedAt?: string | null;
}): Row {
  const [y, m, d] = opts.createdAt.split("-").map(Number);
  return {
    id: opts.id,
    totalAmount: String(opts.total),
    paidAmount: "0",
    discountAmount: String(opts.discount ?? 0),
    shootDate: opts.shootDate ?? opts.createdAt,
    status: opts.status ?? "confirmed",
    isParentContract: opts.isParent ?? false,
    parentId: opts.parentId ?? null,
    serviceCategory: "wedding",
    assignedStaff: null,
    createdAt: new Date(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0),
    deletedAt: opts.deletedAt ? new Date(opts.deletedAt) : null,
  };
}

function mkPayment(opts: {
  id: number; bookingId: number | null; amount: number; date: string;
  type?: string; status?: string;
}): Row {
  const [y, m, d] = opts.date.split("-").map(Number);
  return {
    id: opts.id,
    bookingId: opts.bookingId,
    amount: String(opts.amount),
    paymentType: opts.type ?? "deposit",
    paidDate: opts.date,
    paidAt: new Date(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0),
    status: opts.status ?? "active",
  };
}

const FROM = "2026-02-01";
const TO = "2026-02-28";

beforeAll(async () => {
  setRows(bookingsTable, [
    // b1: đơn thường có GIẢM GIÁ 1M → net 9M (test rule giảm giá)
    mkBooking({ id: 1, createdAt: "2026-02-05", total: 10_000_000, discount: 1_000_000 }),
    // b2: BÁO GIÁ TẠM — không được vào doanh thu hợp đồng
    mkBooking({ id: 2, createdAt: "2026-02-08", total: 20_000_000, status: "temp_quote" }),
    // b3: ĐÃ HỦY — không tính
    mkBooking({ id: 3, createdAt: "2026-02-10", total: 7_000_000, status: "cancelled" }),
    // b4: ĐÃ XÓA (thùng rác) — không tính
    mkBooking({ id: 4, createdAt: "2026-02-12", total: 5_000_000, deletedAt: "2026-02-13" }),
    // b5: đơn thường, có 2 phiếu thu (test không double-count)
    mkBooking({ id: 5, createdAt: "2026-02-15", total: 8_000_000 }),
    // Gia đình hợp đồng gộp: cha tổng (không vào doanh thu) + 2 con
    mkBooking({ id: 10, createdAt: "2026-02-20", total: 0, isParent: true }),
    mkBooking({ id: 11, createdAt: "2026-02-20", total: 6_000_000, parentId: 10 }),
    mkBooking({ id: 12, createdAt: "2026-02-21", total: 4_000_000, parentId: 10 }),
    // b20: đơn tạo THÁNG KHÁC — không vào kỳ 02/2026
    mkBooking({ id: 20, createdAt: "2026-03-02", total: 9_000_000 }),
    // Gia đình CHA RỖNG (zombie): cha còn "confirmed" nhưng con duy nhất đã XÓA
    // → phiếu thu nằm trên cha KHÔNG được tính (root cause vụ lệch 2tr PR #86).
    mkBooking({ id: 30, createdAt: "2026-02-24", total: 0, isParent: true }),
    mkBooking({ id: 31, createdAt: "2026-02-24", total: 5_000_000, parentId: 30, deletedAt: "2026-02-25" }),
  ]);
  setRows(paymentsTable, [
    // p1: cọc hợp lệ trên b1
    mkPayment({ id: 1, bookingId: 1, amount: 5_000_000, date: "2026-02-06" }),
    // p2: tiền THẬT đã thu trên đơn báo giá tạm — card Đã thu hiện đang tính (scope payment_date)
    mkPayment({ id: 2, bookingId: 2, amount: 2_000_000, date: "2026-02-08" }),
    // p3+p4: 2 phiếu trên cùng b5 — phải ra đúng 2 dòng, không nhân đôi
    mkPayment({ id: 3, bookingId: 5, amount: 3_000_000, date: "2026-02-16", type: "payment" }),
    mkPayment({ id: 4, bookingId: 5, amount: 2_000_000, date: "2026-02-17", type: "payment" }),
    // p5: phiếu ĐÃ HỦY (voided) — loại
    mkPayment({ id: 5, bookingId: 5, amount: 4_000_000, date: "2026-02-18", status: "voided" }),
    // p6: phiếu HOÀN TIỀN — loại
    mkPayment({ id: 6, bookingId: 1, amount: 1_000_000, date: "2026-02-19", type: "refund" }),
    // p7: phiếu NGOÀI KỲ (tháng 3) — loại khỏi kỳ 02
    mkPayment({ id: 7, bookingId: 1, amount: 9_000_000, date: "2026-03-01" }),
    // pp: phiếu trên ĐƠN CHA hợp đồng gộp (cha còn con hiệu lực → vẫn là tiền thật của kỳ)
    mkPayment({ id: 8, bookingId: 10, amount: 5_000_000, date: "2026-02-22" }),
    // p9: phiếu trên CHA RỖNG (con chết hết) — tiền treo, KHÔNG tính vào Đã thu
    mkPayment({ id: 9, bookingId: 30, amount: 1_500_000, date: "2026-02-23" }),
    // p10/p11: phiếu trên đơn ĐÃ HỦY / ĐÃ XÓA — tiền ĐÃ vào túi là sự kiện dòng tiền,
    // VẪN tính vào Đã thu (đơn chết không tự hoàn tiền; muốn trừ phải lập phiếu refund).
    mkPayment({ id: 10, bookingId: 3, amount: 700_000, date: "2026-02-24" }),
    mkPayment({ id: 11, bookingId: 4, amount: 300_000, date: "2026-02-25" }),
    // p12: thu LẺ không gắn đơn (ad_hoc) — là khoản thu thật của kỳ
    mkPayment({ id: 12, bookingId: null, amount: 900_000, date: "2026-02-26", type: "ad_hoc" }),
  ]);
  setRows(expensesTable, [
    // e1: CP trực tiếp gắn b1 (đã duyệt)
    { id: 1, bookingId: 1, amount: "500000", expenseDate: "2026-02-06", status: "approved", costClass: "direct", description: "Thuê xe đi show", expenseCode: "PC0001" },
    // e2: CP vận hành trong kỳ
    { id: 2, bookingId: null, amount: "200000", expenseDate: "2026-02-15", status: "paid", costClass: "operating", description: "Điện nước", expenseCode: "PC0002" },
    // e3: khấu hao, e4: lãi vay
    { id: 3, bookingId: null, amount: "300000", expenseDate: "2026-02-01", status: "approved", costClass: "depreciation", description: "Khấu hao máy", expenseCode: "PC0003" },
    { id: 4, bookingId: null, amount: "100000", expenseDate: "2026-02-02", status: "approved", costClass: "interest", description: "Lãi vay NH", expenseCode: "PC0004" },
    // e5: submitted (chưa duyệt) — LOẠI; e6: rejected — LOẠI
    { id: 5, bookingId: null, amount: "999000", expenseDate: "2026-02-03", status: "submitted", costClass: "operating", description: "Chưa duyệt", expenseCode: "PC0005" },
    { id: 6, bookingId: null, amount: "888000", expenseDate: "2026-02-04", status: "rejected", costClass: "operating", description: "Bị từ chối", expenseCode: "PC0006" },
    // e7: trả gốc vay — KHÔNG phải chi phí; e8: chi cá nhân — không vào P&L studio
    { id: 7, bookingId: null, amount: "777000", expenseDate: "2026-02-05", status: "approved", costClass: "loan_principal", description: "Trả gốc", expenseCode: "PC0007" },
    { id: 8, bookingId: null, amount: "555000", expenseDate: "2026-02-06", status: "approved", costClass: "personal", description: "Chi cá nhân", expenseCode: "PC0008" },
    // e9: CP trực tiếp gắn đơn NGOÀI kỳ (b20 tạo tháng 3) — không vào kỳ 02
    { id: 9, bookingId: 20, amount: "444000", expenseDate: "2026-02-25", status: "approved", costClass: "direct", description: "Gắn đơn tháng 3", expenseCode: "PC0009" },
    // e10: CP trực tiếp gắn đơn ĐÃ HỦY (b3) — đơn không countable nên KHÔNG vào chi phí kỳ nào
    { id: 10, bookingId: 3, amount: "222000", expenseDate: "2026-02-26", status: "approved", costClass: "direct", description: "Gắn đơn đã hủy", expenseCode: "PC0010" },
    // e11: cost_class LẠ — đặt ở THÁNG 1 riêng để không lây expected các test tháng 2
    { id: 11, bookingId: null, amount: "123000", expenseDate: "2026-01-15", status: "approved", costClass: "khac_x", description: "Loại lạ", expenseCode: "PC0011" },
  ]);
  setRows(fixedCostsTable, [
    { id: 1, label: "Mặt bằng", amount: "2000000", active: true },
    { id: 2, label: "Khoản đã tắt", amount: "3000000", active: false },
  ]);
  setRows(staffTable, []);
  setRows(tasksTable, []);

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

type Evidence = {
  formula: string;
  notes: string[];
  groups: Array<{ key: string; label: string; sign: 1 | -1; subtotal: number; rows: Array<Record<string, unknown> & { amount: number }> }>;
  detailTotal: number;
  cardTotal: number;
  reconciliationDelta: number;
  rowCount: number;
};

async function evidence(metric: string): Promise<Evidence> {
  return get(`/api/revenue/v2/evidence?metric=${metric}&from=${FROM}&to=${TO}`);
}

function rowsOf(ev: Evidence, key?: string) {
  return ev.groups.filter(g => !key || g.key === key).flatMap(g => g.rows);
}

/** Gom mọi nhóm phiếu thu (chính thức + báo giá tạm + thu lẻ). */
function paymentRows(ev: Evidence) {
  return ev.groups.filter(g => g.key.startsWith("payments")).flatMap(g => g.rows);
}

/** Cộng lại từ TỪNG DÒNG — không tin detailTotal server trả về. */
function sumRows(ev: Evidence): number {
  return ev.groups.reduce((s, g) => s + g.sign * g.rows.reduce((x, r) => x + r.amount, 0), 0);
}

// Số kỳ vọng (tự cộng tay từ seed ở trên):
// Đã thu 02/2026: p1(5M) + p2(2M) + p3(3M) + p4(2M) + p8-cha-sống(5M)
//   + p10-đơn-hủy(700k) + p11-đơn-xóa(300k) + p12-ad-hoc(900k); LOẠI p9 (cha rỗng) = 18.9M
const EXPECTED_COLLECTED = 5_000_000 + 2_000_000 + 3_000_000 + 2_000_000 + 5_000_000 + 700_000 + 300_000 + 900_000;
const EXPECTED_CONTRACT = 9_000_000 + 8_000_000 + 6_000_000 + 4_000_000; // b1(net),b5,b11,b12 = 27M
const EXPECTED_COST = 2_500_000 + 500_000 + 200_000 + 2_000_000 + 300_000 + 100_000; // cast+direct+operating+fixed+dep+interest = 5.6M

describe("Bất biến #1 — detailTotal == cardTotal == totals của /monthly (lệch 0 đồng)", () => {
  const CASES: Array<{ metric: string; monthlyField: string }> = [
    { metric: "collected", monthlyField: "collected" },
    { metric: "remaining", monthlyField: "remaining" },
    { metric: "cost", monthlyField: "totalCost" },
    { metric: "realProfit", monthlyField: "realProfit" },
    { metric: "contractValue", monthlyField: "contractValue" },
    { metric: "expectedCost", monthlyField: "totalCost" },
    { metric: "expectedProfit", monthlyField: "netProfit" },
    // Đợt 2 — các ô còn lại của màn Doanh thu:
    { metric: "grossProfit", monthlyField: "grossProfit" },
    { metric: "operatingProfit", monthlyField: "operatingProfit" },
    { metric: "netProfit", monthlyField: "netProfit" },
    { metric: "staffCast", monthlyField: "staffCast" },
    { metric: "directCost", monthlyField: "directCost" },
    { metric: "operatingExpenses", monthlyField: "operatingExpenses" },
    { metric: "depreciation", monthlyField: "depreciation" },
    { metric: "interest", monthlyField: "interest" },
  ];

  for (const c of CASES) {
    it(`${c.metric}: bằng chứng khớp card và khớp /monthly`, async () => {
      const [ev, monthly] = await Promise.all([
        evidence(c.metric),
        get(`/api/revenue/v2/monthly?from=${FROM}&to=${TO}`) as Promise<{ totals: Record<string, number> }>,
      ]);
      // Server tự đối chiếu: lệch 0
      expect(ev.reconciliationDelta).toBe(0);
      // Tự cộng từng dòng phía test = detailTotal = cardTotal
      expect(sumRows(ev)).toBe(ev.detailTotal);
      expect(ev.detailTotal).toBe(ev.cardTotal);
      // Card của evidence = đúng số /monthly đang chiếu lên ô
      expect(ev.cardTotal).toBe(monthly.totals[c.monthlyField]);
    });
  }
});

describe("Rule tiền trên từng bảng bằng chứng", () => {
  it("Đã thu: đúng 8 phiếu hợp lệ; loại voided/refund/ngoài kỳ/cha-rỗng; 2 phiếu cùng đơn = 2 dòng", async () => {
    const ev = await evidence("collected");
    const rows = paymentRows(ev);
    expect(rows.length).toBe(8);
    const ids = rows.map(r => Number(r.paymentId)).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 8, 10, 11, 12]);
    expect(ev.detailTotal).toBe(EXPECTED_COLLECTED);
    // 2 phiếu của b5 xuất hiện đúng 2 lần, tổng 5M — không nhân đôi
    const b5rows = rows.filter(r => r.bookingId === 5);
    expect(b5rows.length).toBe(2);
    expect(b5rows.reduce((s, r) => s + r.amount, 0)).toBe(5_000_000);
  });

  it("CHỐT rule cha rỗng (root cause PR #86): phiếu 1.5M trên cha hết con hiệu lực KHÔNG vào Đã thu", async () => {
    const ev = await evidence("collected");
    const rows = paymentRows(ev);
    expect(rows.map(r => r.paymentId)).not.toContain(9);
    expect(rows.filter(r => r.bookingId === 30).length).toBe(0);
    // Đối chứng: phiếu trên cha CÒN con hiệu lực (b10) thì VẪN tính
    expect(rows.map(r => r.paymentId)).toContain(8);
  });

  it("CHỐT rule đơn hủy/xóa + thu lẻ: tiền ĐÃ vào túi vẫn là Đã thu; ad_hoc có nhãn Thu lẻ", async () => {
    const ev = await evidence("collected");
    const rows = paymentRows(ev);
    const p10 = rows.find(r => r.paymentId === 10)!;
    const p11 = rows.find(r => r.paymentId === 11)!;
    const p12 = rows.find(r => r.paymentId === 12)!;
    expect(p10.amount).toBe(700_000);  // đơn cancelled — phiếu vẫn là dòng tiền thật
    expect(p11.amount).toBe(300_000);  // đơn deleted — như trên (muốn trừ phải lập refund)
    expect(p12.amount).toBe(900_000);
    expect(String(p12.kind)).toContain("Thu lẻ");
    expect(p12.bookingId).toBeNull();
  });

  it("CHỐT nghiệp vụ 17/07 — Đã thu tách 3 nhóm: chính thức / BÁO GIÁ TẠM (nhãn rõ) / thu lẻ; tổng khớp quỹ", async () => {
    const ev = await evidence("collected");
    const byKey = Object.fromEntries(ev.groups.map(g => [g.key, g]));

    // 1. Thu từ booking chính thức: p1(5M) + p3(3M) + p4(2M) + p8(5M) + p10(700k) + p11(300k) = 16M
    expect(byKey["payments-official"]!.subtotal).toBe(16_000_000);
    expect(byKey["payments-official"]!.rows.map(r => r.paymentId)).not.toContain(2);
    // Nhãn nhóm chính thức phải là nhãn thường — KHÔNG dòng nào bị dán nhầm nhãn báo giá tạm
    const p1row = byKey["payments-official"]!.rows.find(r => r.paymentId === 1)!;
    expect(String(p1row.kind)).toBe("Cọc");
    expect(byKey["payments-official"]!.rows.map(r => String(r.kind))).not.toContain("Tiền thu từ Báo giá tạm");

    // 2. Thu từ BÁO GIÁ TẠM: đúng p2 (2M trên b2 temp_quote), nhãn RÕ từng dòng
    const tq = byKey["payments-temp-quote"]!;
    expect(tq.subtotal).toBe(2_000_000);
    expect(tq.rows.length).toBe(1);
    expect(tq.rows[0]!.paymentId).toBe(2);
    expect(String(tq.rows[0]!.kind)).toBe("Tiền thu từ Báo giá tạm");
    expect(tq.label).toContain("BÁO GIÁ TẠM");

    // 3. Thu lẻ: p12 (900k)
    expect(byKey["payments-adhoc"]!.subtotal).toBe(900_000);

    // Tổng 3 nhóm (từ RESPONSE thật) == card == quỹ — tách nhóm không đổi một đồng
    expect(byKey["payments-official"]!.subtotal + tq.subtotal + byKey["payments-adhoc"]!.subtotal).toBe(ev.cardTotal);
    expect(ev.detailTotal).toBe(EXPECTED_COLLECTED);
    expect(ev.cardTotal).toBe(EXPECTED_COLLECTED);

    // Note giải thích phải xuất hiện khi có nhóm báo giá tạm
    expect(ev.notes.some(n => n.includes("BÁO GIÁ TẠM"))).toBe(true);

    // Còn đơn temp_quote (b2) vẫn KHÔNG nằm trong Doanh thu hợp đồng (công nợ temp_quote
    // bị loại ở tầng SQL engine — kiểm trên DB thật trong truth itest, mock này SQL rỗng)
    const contract = await evidence("contractValue");
    expect(rowsOf(contract).map(r => r.bookingId)).not.toContain(2);
  });

  it("Kỳ KHÔNG có phiếu báo giá tạm/thu lẻ (03/2026): chỉ còn nhóm chính thức, không nhóm rỗng, không note thừa", async () => {
    const ev = await get(`/api/revenue/v2/evidence?metric=collected&from=2026-03-01&to=2026-03-31`) as Evidence;
    expect(ev.groups.map(g => g.key)).toEqual(["payments-official"]);
    expect(ev.detailTotal).toBe(9_000_000); // chỉ p7 (thu 01/03 trên b1)
    expect(ev.cardTotal).toBe(9_000_000);
    expect(ev.notes).toEqual([]);
  });

  it("Doanh thu hợp đồng: loại temp_quote/cancelled/deleted/cha tổng; NET trừ giảm giá đúng", async () => {
    const ev = await evidence("contractValue");
    const rows = rowsOf(ev, "contracts");
    const ids = rows.map(r => r.bookingId).sort((a, b) => Number(a) - Number(b));
    expect(ids).toEqual([1, 5, 11, 12]); // KHÔNG có b2 (temp_quote), b3 (cancelled), b4 (deleted), b10 (cha)
    const b1 = rows.find(r => r.bookingId === 1)!;
    expect(b1.amount).toBe(9_000_000); // 10M − 1M giảm giá
    expect(String(b1.detail)).toContain("giảm giá");
    expect(ev.detailTotal).toBe(EXPECTED_CONTRACT);
  });

  it("Chi phí: đủ 6 nhóm; loại submitted/rejected/loan_principal/personal/đơn ngoài kỳ/đơn hủy", async () => {
    const ev = await evidence("cost");
    expect(ev.detailTotal).toBe(EXPECTED_COST);
    const byKey = Object.fromEntries(ev.groups.map(g => [g.key, g.subtotal]));
    expect(byKey["cast"]).toBe(2_500_000);
    expect(byKey["direct"]).toBe(500_000);
    expect(byKey["operating"]).toBe(200_000);
    expect(byKey["fixed"]).toBe(2_000_000); // 2M/tháng × 1 bucket
    expect(byKey["depreciation"]).toBe(300_000);
    expect(byKey["interest"]).toBe(100_000);
    // Các phiếu bị loại không xuất hiện ở bất kỳ nhóm nào
    // (e10 gắn đơn ĐÃ HỦY → đơn không countable, chi phí không rơi vào kỳ nào)
    const allExpenseIds = rowsOf(ev).map(r => r.expenseId).filter(x => x != null);
    for (const excluded of [5, 6, 7, 8, 9, 10]) expect(allExpenseIds).not.toContain(excluded);
  });

  it("CP cố định (nhánh CHUẨN — danh mục đọc được): liệt kê từng khoản × số tháng, KHÔNG có dòng điều chỉnh", async () => {
    const ev = await evidence("cost");
    const fixed = ev.groups.find(g => g.key === "fixed")!;
    expect(fixed.rows.length).toBe(1);
    expect(String(fixed.rows[0]!.name)).toBe("Mặt bằng");
    expect(fixed.rows[0]!.amount).toBe(2_000_000); // 2M/tháng × 1 bucket
    expect(fixed.rows.some(r => String(r.name).includes("Điều chỉnh"))).toBe(false);
  });

  it("Lợi nhuận thực: phần (+) = Đã thu, phần (−) = Chi phí, hiệu đúng công thức", async () => {
    const ev = await evidence("realProfit");
    const plus = ev.groups.filter(g => g.sign === 1).reduce((s, g) => s + g.subtotal, 0);
    const minus = ev.groups.filter(g => g.sign === -1).reduce((s, g) => s + g.subtotal, 0);
    expect(plus).toBe(EXPECTED_COLLECTED);
    expect(minus).toBe(EXPECTED_COST);
    expect(ev.detailTotal).toBe(EXPECTED_COLLECTED - EXPECTED_COST);
    // Phần A cũng phải tách nhóm như metric Đã thu (chốt 17/07) — không được gộp phẳng
    const plusKeys = ev.groups.filter(g => g.sign === 1).map(g => g.key);
    expect(plusKeys).toContain("payments-official");
    expect(plusKeys).toContain("payments-temp-quote");
    expect(plusKeys).toContain("payments-adhoc");
  });

  it("Lợi nhuận kỳ vọng: Doanh thu hợp đồng − Chi phí dự kiến", async () => {
    const ev = await evidence("expectedProfit");
    expect(ev.detailTotal).toBe(EXPECTED_CONTRACT - EXPECTED_COST);
  });

  it("Đợt 2 — số cộng tay: grossProfit/operatingProfit/netProfit + 4 ô chi phí + Khấu hao+Lãi vay", async () => {
    // Cộng tay từ seed: cast 2.5M, direct 500k, operating 200k + fixed 2M, dep 300k, interest 100k
    const gross = await evidence("grossProfit");
    expect(gross.detailTotal).toBe(EXPECTED_CONTRACT - (2_500_000 + 500_000)); // 27M − 3M = 24M
    const op = await evidence("operatingProfit");
    expect(op.detailTotal).toBe(EXPECTED_CONTRACT - (2_500_000 + 500_000) - (200_000 + 2_000_000)); // 21.8M
    const net = await evidence("netProfit");
    expect(net.detailTotal).toBe(EXPECTED_CONTRACT - EXPECTED_COST); // 21.4M — đúng chuỗi ròng
    const cast = await evidence("staffCast");
    expect(cast.detailTotal).toBe(2_500_000);
    const direct = await evidence("directCost");
    expect(direct.detailTotal).toBe(3_000_000);
    const opex = await evidence("operatingExpenses");
    expect(opex.detailTotal).toBe(2_200_000);
    const depInt = await evidence("depreciationInterest");
    expect(depInt.detailTotal).toBe(400_000);
    expect(depInt.cardTotal).toBe(400_000);
    expect(depInt.reconciliationDelta).toBe(0);
  });

  it("Đợt 2 — cashSpent/cashNet ĐÚNG rule dòng tiền: GỒM chi cá nhân + chi gắn đơn ngoài cohort, KHÔNG gồm CP cố định; khớp /daily-cashflow", async () => {
    // Rule daily-cashflow theo NGÀY CHI: e1 500k + e2 200k + e3 300k + e4 100k
    //   + e8 personal 555k + e9 444k (gắn b20 ngoài cohort 02) + e10 222k (gắn b3 đã hủy)
    //   LOẠI: e5 submitted, e6 rejected, e7 loan_principal. KHÔNG cộng fixed 2M.
    const EXPECTED_CASH_SPENT = 500_000 + 200_000 + 300_000 + 100_000 + 555_000 + 444_000 + 222_000;
    const ev = await get(`/api/revenue/v2/evidence?metric=cashSpent&from=${FROM}&to=${TO}`) as Evidence;
    expect(ev.detailTotal).toBe(EXPECTED_CASH_SPENT);
    expect(ev.cardTotal).toBe(EXPECTED_CASH_SPENT);
    expect(ev.reconciliationDelta).toBe(0);
    // Chi cá nhân hiện RÕ thành nhóm riêng, không lẫn vào P&L
    const personal = ev.groups.find(g => g.key === "cash-personal")!;
    expect(personal.subtotal).toBe(555_000);
    // KHÔNG có nhóm CP cố định trong dòng tiền
    expect(ev.groups.some(g => g.key === "fixed")).toBe(false);

    // Đối chiếu THẲNG với endpoint biểu đồ — cùng kỳ phải cùng số
    const daily = await get(`/api/revenue/v2/daily-cashflow?month=2026-02`) as { totals: { collected: number; spent: number; net: number } };
    expect(ev.detailTotal).toBe(daily.totals.spent);

    const net = await get(`/api/revenue/v2/evidence?metric=cashNet&from=${FROM}&to=${TO}`) as Evidence;
    expect(net.detailTotal).toBe(EXPECTED_COLLECTED - EXPECTED_CASH_SPENT);
    expect(net.reconciliationDelta).toBe(0);
    expect(net.detailTotal).toBe(daily.totals.net);
    expect(daily.totals.collected).toBe(EXPECTED_COLLECTED); // thu: rule y hệt collected
  });

  it("cashSpent: assert TỪNG ID phiếu (chống va chạm số học 777k = 555k + 222k) + cls lạ vẫn liệt kê", async () => {
    const ev = await get(`/api/revenue/v2/evidence?metric=cashSpent&from=${FROM}&to=${TO}`) as Evidence;
    const cashIds = rowsOf(ev).map(r => r.expenseId).filter(x => x != null).sort((a, b) => Number(a) - Number(b));
    expect(cashIds).toEqual([1, 2, 3, 4, 8, 9, 10]); // đúng từng phiếu, không phải tình cờ đúng tổng
    // cls lạ (e11, tháng 1) — nhóm 'Chi khác' vẫn liệt kê, không rớt tiền
    const jan = await get(`/api/revenue/v2/evidence?metric=cashSpent&from=2026-01-01&to=2026-01-31`) as Evidence;
    expect(jan.detailTotal).toBe(123_000);
    const odd = jan.groups.find(g => g.key === "cash-khac_x")!;
    expect(odd).toBeDefined();
    expect(odd.label).toContain("Chi khác");
    expect(jan.reconciliationDelta).toBe(0);
  });

  it("Kỳ MỘT NGÀY (đường bấm 'Ngày thu cao nhất'/Top ngày): from=to → đúng phiếu của ngày đó, khớp daily-cashflow", async () => {
    const ev = await get(`/api/revenue/v2/evidence?metric=collected&from=2026-02-06&to=2026-02-06`) as Evidence;
    expect(ev.detailTotal).toBe(5_000_000); // chỉ p1 ngày 06/02
    expect(ev.reconciliationDelta).toBe(0);
    const daily = await get(`/api/revenue/v2/daily-cashflow?month=2026-02`) as { days: Array<{ date: string; collected: number }> };
    const day = daily.days.find(d => d.date === "2026-02-06")!;
    expect(ev.detailTotal).toBe(day.collected);
  });

  it("Clip GIỮA THÁNG kiểu ô bảng tháng FE (max(from, đầu tháng)..min(to, cuối tháng)): khớp months[] của /monthly", async () => {
    const from = "2026-02-05", to = "2026-03-20";
    const monthly = await get(`/api/revenue/v2/monthly?from=${from}&to=${to}`) as {
      months: Array<Record<string, number> & { month: string }>;
    };
    for (const row of monthly.months) {
      const ym = String(row.month);
      const [y, m] = ym.split("-").map(Number);
      const last = new Date(y!, m!, 0).getDate();
      const clipFrom = from > `${ym}-01` ? from : `${ym}-01`;
      const end = `${ym}-${String(last).padStart(2, "0")}`;
      const clipTo = to < end ? to : end;
      const ev = await get(`/api/revenue/v2/evidence?metric=collected&from=${clipFrom}&to=${clipTo}`) as Evidence;
      expect(ev.detailTotal, `collected ${ym}`).toBe(row.collected);
      // e3 (khấu hao 01/02) + e4 (lãi vay 02/02) phải bị CLIP khỏi bucket tháng 2 (từ 05/02)
      const cost = await get(`/api/revenue/v2/evidence?metric=cost&from=${clipFrom}&to=${clipTo}`) as Evidence;
      expect(cost.detailTotal, `cost ${ym}`).toBe(row.totalCost);
    }
  });

  it("Còn nợ (mock SQL rỗng): vẫn tự đối chiếu detail == card == 0", async () => {
    const ev = await evidence("remaining");
    expect(ev.detailTotal).toBe(0);
    expect(ev.cardTotal).toBe(0);
    expect(ev.reconciliationDelta).toBe(0);
  });

  it("fixedCostGroup nhánh ĐIỀU CHỈNH: danh mục lệch số đã tính → thêm dòng bù đúng TỪNG ĐỒNG", async () => {
    const { fixedCostGroup } = await import("./revenue/evidence.js");
    // Danh mục hiện tại 2M/tháng × 1 bucket = 2M, nhưng kỳ đã cộng 2.5M (danh mục vừa bị sửa)
    const g = fixedCostGroup([{ label: "Mặt bằng", amount: 2_000_000 }], 1, 2_500_000);
    expect(g.subtotal).toBe(2_500_000); // bảng KHÔNG được thiếu tiền so với card
    const adjust = g.rows.find(r => String(r.name).includes("Điều chỉnh"))!;
    expect(adjust.amount).toBe(500_000);
    // Danh mục khớp đúng → KHÔNG sinh dòng điều chỉnh
    const g2 = fixedCostGroup([{ label: "Mặt bằng", amount: 2_000_000 }], 2, 4_000_000);
    expect(g2.rows.length).toBe(1);
    expect(g2.subtotal).toBe(4_000_000);
  });
});

describe("Range NHIỀU THÁNG (02+03/2026) — số kỳ vọng cộng tay, không chỉ so 2 vế cùng core", () => {
  const FROM2 = "2026-02-01";
  const TO2 = "2026-03-31";
  // Cộng tay: Đã thu = kỳ 02 (18.9M) + p7 (9M, thu 01/03) = 27.9M
  const COLLECTED_2M = EXPECTED_COLLECTED + 9_000_000;
  // Doanh thu HĐ = kỳ 02 (27M) + b20 (9M, chốt 02/03) = 36M
  const CONTRACT_2M = EXPECTED_CONTRACT + 9_000_000;
  // Chi phí = cast 2.5M (bucket 02) + direct e1 500k + e9 444k (b20 thuộc bucket 03)
  //   + operating e2 200k + CP cố định 2M × 2 bucket + khấu hao 300k + lãi vay 100k = 12.044M... tự cộng:
  const COST_2M = 2_500_000 + 500_000 + 444_000 + 200_000 + 2_000_000 * 2 + 300_000 + 100_000;

  it("collected/contractValue/cost đúng số cộng tay; delta = 0; khớp /monthly", async () => {
    for (const [metric, expected, monthlyField] of [
      ["collected", COLLECTED_2M, "collected"],
      ["contractValue", CONTRACT_2M, "contractValue"],
      ["cost", COST_2M, "totalCost"],
    ] as const) {
      const [ev, monthly] = await Promise.all([
        get(`/api/revenue/v2/evidence?metric=${metric}&from=${FROM2}&to=${TO2}`) as Promise<Evidence>,
        get(`/api/revenue/v2/monthly?from=${FROM2}&to=${TO2}`) as Promise<{ totals: Record<string, number> }>,
      ]);
      expect(ev.detailTotal, metric).toBe(expected);
      expect(ev.cardTotal, metric).toBe(expected);
      expect(ev.reconciliationDelta, metric).toBe(0);
      expect(monthly.totals[monthlyField], metric).toBe(expected);
      expect(sumRows(ev), metric).toBe(expected);
    }
  });

  it("CP cố định 2 bucket: dòng 'Mặt bằng' = 2M × 2 tháng = 4M", async () => {
    const ev = await get(`/api/revenue/v2/evidence?metric=cost&from=${FROM2}&to=${TO2}`) as Evidence;
    const fixed = ev.groups.find(g => g.key === "fixed")!;
    expect(fixed.rows.length).toBe(1);
    expect(fixed.rows[0]!.amount).toBe(4_000_000);
    expect(String(fixed.rows[0]!.detail)).toContain("2 tháng");
  });

  it("e9 (direct gắn b20 tháng 3) chỉ xuất hiện khi range phủ tháng 3 — không rơi nhầm bucket", async () => {
    const evFeb = await evidence("cost");
    expect(rowsOf(evFeb).map(r => r.expenseId)).not.toContain(9);
    const ev2m = await get(`/api/revenue/v2/evidence?metric=cost&from=${FROM2}&to=${TO2}`) as Evidence;
    expect(rowsOf(ev2m).map(r => r.expenseId)).toContain(9);
  });
});

describe("Validate input", () => {
  it("metric lạ → 400", async () => {
    const r = await fetch(`${baseUrl}/api/revenue/v2/evidence?metric=hack&from=${FROM}&to=${TO}`);
    expect(r.status).toBe(400);
  });
  it("thiếu/sai định dạng ngày → 400", async () => {
    const r1 = await fetch(`${baseUrl}/api/revenue/v2/evidence?metric=collected`);
    expect(r1.status).toBe(400);
    const r2 = await fetch(`${baseUrl}/api/revenue/v2/evidence?metric=collected&from=2026-02-28&to=2026-02-01`);
    expect(r2.status).toBe(400);
  });
  it("ngày rác đúng regex nhưng KHÔNG có thật trên lịch (31/02, tháng 13) → 400, kể cả metric=remaining", async () => {
    for (const metric of ["collected", "remaining"]) {
      const r1 = await fetch(`${baseUrl}/api/revenue/v2/evidence?metric=${metric}&from=2026-02-31&to=2026-03-01`);
      expect(r1.status, `${metric} 2026-02-31`).toBe(400);
      const r2 = await fetch(`${baseUrl}/api/revenue/v2/evidence?metric=${metric}&from=2026-01-01&to=2026-13-01`);
      expect(r2.status, `${metric} 2026-13-01`).toBe(400);
    }
  });
  it("range quá dài (chống quét cả trăm năm khóa event loop) → 400", async () => {
    const r = await fetch(`${baseUrl}/api/revenue/v2/evidence?metric=collected&from=1990-01-01&to=2090-12-31`);
    expect(r.status).toBe(400);
    // 60 tháng chẵn vẫn hợp lệ
    const ok = await fetch(`${baseUrl}/api/revenue/v2/evidence?metric=collected&from=2022-01-01&to=2026-12-31`);
    expect(ok.status).toBe(200);
  });
});
