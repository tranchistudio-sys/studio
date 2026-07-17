/**
 * TRUTH TEST — Bằng chứng số liệu (PR Financial Evidence), chạy trên DB THẬT:
 *
 *   Card (/revenue/v2/monthly) ↔ Engine ↔ Bảng bằng chứng (/revenue/v2/evidence)
 *   phải ra CÙNG MỘT SỐ — lệch 1 đồng = FAIL (spec chủ studio 17/07, mục 9).
 *
 * READ-ONLY tuyệt đối: chỉ GET + SELECT, không ghi bất kỳ dòng nào.
 * Chạy: cd artifacts/api-server && DATABASE_URL=... pnpm truth
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { pool } from "@workspace/db";
import revenueRouter from "../routes/revenue/index";
import {
  engineReceivableForRange,
  ENGINE_DEBT_SQL,
} from "../lib/finance/financial-engine";
import { revenueCountableSql } from "../lib/booking-money";

// EPS hấp thụ nhiễu float của numeric→JS (1/1000 đồng) — mọi lệch thật ≥ 1đ đều FAIL.
const EPS = 0.001;

let server: Server;
let base = "";

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("Truth test cần DATABASE_URL (DB local snapshot) — chạy qua `pnpm truth`.");
  }
  const app = express();
  app.use("/api", revenueRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function vnToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`);
  expect(r.ok, `GET ${path} → HTTP ${r.status}`).toBe(true);
  return r.json() as Promise<T>;
}

type Evidence = {
  groups: Array<{ key: string; sign: 1 | -1; subtotal: number; rows: Array<{ amount: number; bookingId: number | null }> }>;
  detailTotal: number;
  cardTotal: number;
  reconciliationDelta: number;
};

const METRIC_TO_FIELD: Record<string, string> = {
  collected: "collected",
  remaining: "remaining",
  cost: "totalCost",
  realProfit: "realProfit",
  contractValue: "contractValue",
  expectedCost: "totalCost",
  expectedProfit: "netProfit",
};

function sumRows(ev: Evidence): number {
  return ev.groups.reduce((s, g) => s + g.sign * g.rows.reduce((x, r) => x + r.amount, 0), 0);
}

async function checkRange(from: string, to: string) {
  const monthly = await getJson<{ totals: Record<string, number> }>(
    `/api/revenue/v2/monthly?from=${from}&to=${to}`,
  );
  for (const [metric, field] of Object.entries(METRIC_TO_FIELD)) {
    const ev = await getJson<Evidence>(`/api/revenue/v2/evidence?metric=${metric}&from=${from}&to=${to}`);
    const rowSum = sumRows(ev);
    const card = monthly.totals[field]!;
    const msg = (what: string, a: number, b: number) =>
      `[${metric} ${from}..${to}] ${what}: ${a} ≠ ${b} (lệch ${a - b})`;
    expect(Math.abs(ev.reconciliationDelta), msg("server tự đối chiếu detail↔card", ev.detailTotal, ev.cardTotal)).toBeLessThan(EPS);
    expect(Math.abs(rowSum - ev.detailTotal), msg("Σ từng dòng ↔ detailTotal", rowSum, ev.detailTotal)).toBeLessThan(EPS);
    expect(Math.abs(ev.cardTotal - card), msg("cardTotal ↔ /monthly totals", ev.cardTotal, card)).toBeLessThan(EPS);
    console.log(`  ✓ ${metric.padEnd(15)} ${from}..${to}  card=${card.toLocaleString("vi-VN")}  rows=${ev.groups.reduce((s, g) => s + g.rows.length, 0)}`);
  }
}

describe("Bằng chứng ↔ Card ↔ Engine trên DB THẬT — lệch 1 đồng = FAIL", () => {
  it("tháng hiện tại (VN)", async () => {
    const to = vnToday();
    const ym = to.slice(0, 7);
    const [y, m] = ym.split("-").map(Number);
    const lastDay = new Date(y!, m!, 0).getDate();
    await checkRange(`${ym}-01`, `${ym}-${String(lastDay).padStart(2, "0")}`);
  });

  it("nhiều tháng (từ 2026-01-01 đến hôm nay) — bucket tháng phải lát kín không trùng", async () => {
    await checkRange("2026-01-01", vnToday());
  });

  it("kỳ lẻ trong tháng (7 ngày gần nhất) — clip theo ngày phải chính xác", async () => {
    const to = vnToday();
    const d = new Date(`${to}T00:00:00`);
    d.setDate(d.getDate() - 6);
    const from = d.toLocaleDateString("en-CA");
    await checkRange(from, to);
  });

  it("Còn nợ: cardTotal của evidence == engineReceivableForRange (gọi Engine trực tiếp)", async () => {
    const to = vnToday();
    const from = `${to.slice(0, 7)}-01`;
    const ev = await getJson<Evidence>(`/api/revenue/v2/evidence?metric=remaining&from=${from}&to=${to}`);
    const engine = await engineReceivableForRange(from, to);
    expect(Math.abs(ev.cardTotal - engine)).toBeLessThan(EPS);
    expect(Math.abs(ev.detailTotal - engine)).toBeLessThan(EPS);
  });
});

describe("Phân bổ gia đình hợp đồng gộp (spec #2) — phiếu ở CHA, nợ chia đúng cho CON", () => {
  it("Σ nợ evidence của các thành viên == max(0, NET gia đình − phiếu gốc gia đình)", async () => {
    // Tìm 1 gia đình: có phiếu thu nằm TRÊN ĐƠN CHA + ≥1 con countable.
    const fam = await pool.query(`
      SELECT pb.id AS root
      FROM payments p
      JOIN bookings pb ON pb.id = p.booking_id AND pb.is_parent_contract = true
      WHERE COALESCE(p.status,'active') != 'voided'
        AND COALESCE(p.payment_type,'') NOT IN ('refund','ad_hoc')
        AND EXISTS (
          SELECT 1 FROM bookings ch
          WHERE ch.parent_id = pb.id AND ${revenueCountableSql("ch")}
        )
      ORDER BY pb.id DESC LIMIT 1
    `);
    if (fam.rows.length === 0) {
      console.log("  (DB không có gia đình nào có phiếu trên cha — bỏ qua, mock test đã phủ)");
      return;
    }
    const root = Number((fam.rows[0] as { root: number }).root);

    // Vế độc lập: NET các thành viên countable − tổng phiếu gốc hợp lệ của gia đình.
    const agg = await pool.query(
      `SELECT
         COALESCE(SUM(GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0)))
           FILTER (WHERE ${revenueCountableSql("b")}), 0) AS net,
         (SELECT COALESCE(SUM(p.amount::numeric), 0)
          FROM payments p JOIN bookings pb ON pb.id = p.booking_id
          WHERE COALESCE(pb.parent_id, pb.id) = $1
            AND COALESCE(p.status,'active') != 'voided'
            AND COALESCE(p.payment_type,'') NOT IN ('refund','ad_hoc')) AS paid
       FROM bookings b WHERE COALESCE(b.parent_id, b.id) = $1`,
      [root],
    );
    const famNet = Number((agg.rows[0] as { net: string }).net);
    const famPaid = Number((agg.rows[0] as { paid: string }).paid);
    const expectedFamilyDebt = Math.max(0, famNet - famPaid);

    // Range phủ toàn bộ ngày chụp của thành viên countable.
    const range = await pool.query(
      `SELECT MIN(b.shoot_date)::text AS lo, MAX(b.shoot_date)::text AS hi, ARRAY_AGG(b.id) AS ids
       FROM bookings b WHERE COALESCE(b.parent_id, b.id) = $1 AND ${revenueCountableSql("b")}`,
      [root],
    );
    const { lo, hi, ids } = range.rows[0] as { lo: string; hi: string; ids: number[] };

    // Đối chiếu 1: Engine debt per-member (không qua HTTP).
    const eng = await pool.query(
      `SELECT COALESCE(SUM(${ENGINE_DEBT_SQL}), 0) AS v
       FROM bookings b WHERE COALESCE(b.parent_id, b.id) = $1 AND ${revenueCountableSql("b")}`,
      [root],
    );
    const engineFamilyDebt = Number((eng.rows[0] as { v: string }).v);
    expect(Math.abs(engineFamilyDebt - expectedFamilyDebt),
      `Engine ${engineFamilyDebt} ≠ độc lập ${expectedFamilyDebt} (gia đình #${root})`).toBeLessThan(EPS);

    // Đối chiếu 2: bảng bằng chứng HTTP trong range phủ gia đình — các dòng của
    // thành viên gia đình cộng lại phải RA ĐÚNG số nợ gia đình ở trên.
    const ev = await getJson<Evidence>(`/api/revenue/v2/evidence?metric=remaining&from=${lo}&to=${hi}`);
    const memberIds = new Set(ids.map(Number));
    const famRowSum = ev.groups.flatMap(g => g.rows)
      .filter(r => r.bookingId != null && memberIds.has(Number(r.bookingId)))
      .reduce((s, r) => s + r.amount, 0);
    expect(Math.abs(famRowSum - expectedFamilyDebt),
      `Bằng chứng ${famRowSum} ≠ nợ gia đình ${expectedFamilyDebt} (gia đình #${root}, range ${lo}..${hi})`).toBeLessThan(EPS);
    console.log(`  ✓ gia đình #${root}: net=${famNet.toLocaleString("vi-VN")} paid=${famPaid.toLocaleString("vi-VN")} nợ=${expectedFamilyDebt.toLocaleString("vi-VN")} — evidence khớp`);
  });
});
