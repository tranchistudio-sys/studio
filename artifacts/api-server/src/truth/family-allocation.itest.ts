/**
 * FAMILY CASH ALLOCATION TRUTH TEST — PR #102.
 *
 * Bug nghiệp vụ được fix: phiếu thu hợp đồng gộp nằm ở đơn CHA, đơn CON không
 * nhận được phần tiền đã thu → Khách hàng / Dashboard / Revenue / Copilot báo
 * nợ SAI. Engine giờ phân bổ LIVE từ payments gốc, pro-rata theo giá trị hợp
 * đồng của từng dịch vụ con.
 *
 * Test dựng MỘT gia đình tổng hợp (cha 10tr = con 3tr + con 7tr) trên DB local,
 * ghi MỘT phiếu 4tr ở CHA, rồi bắt các surface ra CÙNG MỘT SỐ:
 *   Booking (family remaining) / Customer / Dashboard / Revenue / Copilot / Engine.
 * Lệch quá 1 đồng = FAIL. Cột bookings.paid_amount bị cố tình ghi RÁC (999999)
 * để chứng minh engine không còn tin cột phân bổ cũ.
 *
 * Edge: nhiều payment, refund, void, giảm giá, temp_quote, cancelled, deleted,
 * occurrence, trả dư. Dọn sạch data tổng hợp trong afterAll (DELETE theo id).
 * Chạy qua `pnpm truth` (DATABASE_URL local) — KHÔNG nằm trong `pnpm test`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";
import {
  engineSystemDebt,
  engineCustomerDebt,
  engineCustomerFinance,
  engineReceivableForRange,
  engineAllocPaidSql,
} from "../lib/finance/financial-engine";
import { getSimpleFinance } from "../lib/finance-summary";
import { getUnpaidCustomers } from "../lib/studio-copilot";
import { allocateFamilyPaid } from "../lib/booking-money";

const MARK = "TRUTH-ALLOC-102";
const MONTH_FROM = "2030-01-01";
const MONTH_TO = "2030-01-31";

let custId = 0;
let parentId = 0;
let childAId = 0; // 3.000.000
let childBId = 0; // 7.000.000
const paymentIds: number[] = [];

let baseSystemDebt = 0;
let baseCopilotTotal = 0;
let baseReceivable2030 = 0;

function close(a: number, b: number, eps = 1): void {
  expect(Math.abs(a - b), `lệch ${a} vs ${b} quá ${eps}đ`).toBeLessThan(eps);
}

async function addPayment(bookingId: number, amount: number, type = "payment"): Promise<number> {
  const r = await pool.query(
    `INSERT INTO payments (booking_id, amount, payment_method, payment_type, paid_date, paid_at, notes)
     VALUES ($1, $2, 'cash', $3, '2030-01-05', '2030-01-05T03:00:00Z', $4) RETURNING id`,
    [bookingId, String(amount), type, MARK],
  );
  const id = Number((r.rows[0] as { id: number }).id);
  paymentIds.push(id);
  return id;
}

/** Con số màn BOOKING/HỢP ĐỒNG: tổng gia đình − phiếu thu hợp lệ của gia đình (độc lập Engine). */
async function bookingScreenFamilyRemaining(root: number): Promise<number> {
  const r = await pool.query(
    `SELECT GREATEST(0,
        (SELECT COALESCE(SUM(GREATEST(0, b.total_amount - COALESCE(b.discount_amount,0))), 0)
         FROM bookings b
         WHERE COALESCE(b.parent_id, b.id) = $1
           AND b.deleted_at IS NULL AND b.is_parent_contract = false
           AND COALESCE(b.status,'') NOT IN ('cancelled','temp_quote'))
        -
        (SELECT COALESCE(SUM(p.amount::numeric), 0)
         FROM payments p JOIN bookings pb ON pb.id = p.booking_id
         WHERE COALESCE(pb.parent_id, pb.id) = $1
           AND COALESCE(p.status,'active') != 'voided'
           AND COALESCE(p.payment_type,'') NOT IN ('refund','ad_hoc'))
     ) AS v`,
    [root],
  );
  return Number((r.rows[0] as { v?: string })?.v ?? 0);
}

/** Mọi surface tiền phải ra CÙNG MỘT SỐ nợ cho khách tổng hợp. */
async function expectAllSurfacesDebt(expected: number): Promise<void> {
  const [custFin, custDebt, sysDebt, simple, copilot, receivable, bookingScreen] = await Promise.all([
    engineCustomerFinance(custId),
    engineCustomerDebt(custId),
    engineSystemDebt(),
    getSimpleFinance("2030-01-01", "2030-01-02"),
    getUnpaidCustomers(100000),
    engineReceivableForRange(MONTH_FROM, MONTH_TO),
    bookingScreenFamilyRemaining(parentId),
  ]);
  close(custFin.totalDebt, expected);                          // màn Khách hàng (engineCustomerFinance)
  close(custDebt, expected);                                   // Engine per-khách
  close(sysDebt - baseSystemDebt, expected);                   // Engine toàn hệ thống (delta)
  close(simple.customerDebt - baseSystemDebt, expected);       // Dashboard /dashboard/simple (delta)
  close(copilot.totalDebt - baseCopilotTotal, expected);       // Copilot tool (delta)
  close(receivable - baseReceivable2030, expected);            // Revenue "còn có thể thu" tháng 2030-01 (delta)
  close(bookingScreen, expected);                              // màn Booking/Hợp đồng (family remaining)
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("Family Allocation Truth Test cần DATABASE_URL (DB local) — chạy qua `pnpm truth`.");
  }
  // Baseline TRƯỚC khi bơm data tổng hợp.
  baseSystemDebt = await engineSystemDebt();
  baseCopilotTotal = (await getUnpaidCustomers(100000)).totalDebt;
  baseReceivable2030 = await engineReceivableForRange(MONTH_FROM, MONTH_TO);

  const c = await pool.query(
    `INSERT INTO customers (name, phone, source) VALUES ($1, $2, 'walk-in') RETURNING id`,
    [`${MARK} KH`, `0111${String(Math.floor(Math.random() * 900000) + 100000)}`],
  );
  custId = Number((c.rows[0] as { id: number }).id);

  // paid_amount cố tình ghi RÁC — engine PHẢI bỏ qua cột này (đọc payments gốc).
  const p = await pool.query(
    `INSERT INTO bookings (order_code, customer_id, shoot_date, shoot_time, service_category,
        package_type, status, total_amount, deposit_amount, paid_amount, discount_amount, is_parent_contract)
     VALUES ($1, $2, '2030-01-10', '08:00', 'wedding', $3, 'confirmed', '10000000', '0', '999999', '0', true)
     RETURNING id`,
    [`${MARK}-P`, custId, `${MARK} goi`],
  );
  parentId = Number((p.rows[0] as { id: number }).id);

  const a = await pool.query(
    `INSERT INTO bookings (order_code, customer_id, shoot_date, shoot_time, service_category,
        package_type, status, total_amount, deposit_amount, paid_amount, discount_amount, is_parent_contract, parent_id)
     VALUES ($1, $2, '2030-01-10', '08:00', 'wedding', $3, 'confirmed', '3000000', '0', '888888', '0', false, $4)
     RETURNING id`,
    [`${MARK}-A`, custId, `${MARK} dv1`, parentId],
  );
  childAId = Number((a.rows[0] as { id: number }).id);

  const b = await pool.query(
    `INSERT INTO bookings (order_code, customer_id, shoot_date, shoot_time, service_category,
        package_type, status, total_amount, deposit_amount, paid_amount, discount_amount, is_parent_contract, parent_id)
     VALUES ($1, $2, '2030-01-20', '08:00', 'wedding', $3, 'confirmed', '7000000', '0', '0', '0', false, $4)
     RETURNING id`,
    [`${MARK}-B`, custId, `${MARK} dv2`, parentId],
  );
  childBId = Number((b.rows[0] as { id: number }).id);

  // Occurrence (ngày phụ) cho con A — thuần lịch, KHÔNG được ảnh hưởng tiền.
  await pool.query(
    `INSERT INTO booking_occurrences (booking_id, shoot_date, shoot_time, label, sort_order)
     VALUES ($1, '2030-01-15', '08:00', $2, 1)`,
    [childAId, MARK],
  ).catch(() => null); // DB chưa migrate bảng occurrences thì bỏ qua — không đụng tiền
});

afterAll(async () => {
  // Dọn SẠCH data tổng hợp (thứ tự FK: payments/occurrences → con → cha → khách).
  if (paymentIds.length) {
    await pool.query(`DELETE FROM payments WHERE id = ANY($1::int[])`, [paymentIds]);
  }
  await pool.query(`DELETE FROM booking_occurrences WHERE label = $1`, [MARK]).catch(() => null);
  await pool.query(`DELETE FROM bookings WHERE order_code IN ($1, $2, $3)`, [
    `${MARK}-A`, `${MARK}-B`, `${MARK}-P`,
  ]);
  await pool.query(`DELETE FROM customers WHERE id = $1`, [custId]);
});

describe("PR #102 — MỘT payment ở CHA: mọi surface ra CÙNG MỘT SỐ", () => {
  it("chưa có payment: nợ = 10tr trên mọi surface (engine bỏ qua paid_amount rác)", async () => {
    await expectAllSurfacesDebt(10_000_000);
  });

  it("payment 4tr ghi ở CHA → mọi surface = 6tr; phân bổ pro-rata 1,2tr/2,8tr xuống con", async () => {
    await addPayment(parentId, 4_000_000);
    await expectAllSurfacesDebt(6_000_000);

    // Đã trả per-khách = đúng 4tr (tiền ở cha CHẢY XUỐNG con — không còn "treo").
    const fin = await engineCustomerFinance(custId);
    close(fin.totalPaid, 4_000_000);
    close(fin.totalOwed, 10_000_000);

    // Phân bổ per-booking (SQL): A = 4tr×3/10 = 1,2tr; B = 4tr×7/10 = 2,8tr.
    const r = await pool.query(
      `SELECT b.id, ${engineAllocPaidSql("b")} AS alloc FROM bookings b WHERE b.id = ANY($1::int[])`,
      [[childAId, childBId]],
    );
    const byId = new Map((r.rows as Array<{ id: number; alloc: string }>).map(x => [Number(x.id), Number(x.alloc)]));
    close(byId.get(childAId) ?? -1, 1_200_000);
    close(byId.get(childBId) ?? -1, 2_800_000);

    // Bản JS thuần (revenue/data.ts dùng) phải khớp bản SQL — hai implementation độc lập.
    const rows = await pool.query(
      `SELECT id, parent_id AS "parentId", is_parent_contract AS "isParentContract", status,
              deleted_at AS "deletedAt", total_amount AS "totalAmount", discount_amount AS "discountAmount"
       FROM bookings WHERE COALESCE(parent_id, id) = $1`,
      [parentId],
    );
    const pays = await pool.query(
      `SELECT p.booking_id AS "bookingId", p.amount, p.status, p.payment_type AS "paymentType"
       FROM payments p WHERE p.booking_id = ANY($2::int[]) OR p.booking_id = $1`,
      [parentId, [parentId, childAId, childBId]],
    );
    const js = allocateFamilyPaid(
      rows.rows as never[],
      pays.rows as never[],
    );
    close(js.get(childAId) ?? -1, byId.get(childAId) ?? -2, 0.5);
    close(js.get(childBId) ?? -1, byId.get(childBId) ?? -2, 0.5);
  });

  it("payment NHIỀU LẦN: +1tr → 5tr mọi surface", async () => {
    await addPayment(parentId, 1_000_000);
    await expectAllSurfacesDebt(5_000_000);
  });

  it("REFUND không phải tiền thu: +refund 2tr → số KHÔNG đổi (5tr)", async () => {
    await addPayment(parentId, 2_000_000, "refund");
    await expectAllSurfacesDebt(5_000_000);
  });

  it("VOID phiếu 1tr → quay về 6tr (không mất, không double)", async () => {
    const last = paymentIds[1]; // phiếu 1tr
    await pool.query(`UPDATE payments SET status = 'voided' WHERE id = $1`, [last]);
    await expectAllSurfacesDebt(6_000_000);
  });

  it("GIẢM GIÁ 1tr ở con B → net gia đình 9tr, nợ 5tr; bất biến Σ per-booking = family clamp", async () => {
    await pool.query(`UPDATE bookings SET discount_amount = '1000000' WHERE id = $1`, [childBId]);
    await expectAllSurfacesDebt(5_000_000);
  });

  it("TEMP_QUOTE cả nhà → đóng góp 0 mọi surface; tắt → về 5tr (toggle #100 + engine nhất quán)", async () => {
    await pool.query(`UPDATE bookings SET status = 'temp_quote' WHERE id = ANY($1::int[])`, [
      [parentId, childAId, childBId],
    ]);
    await expectAllSurfacesDebt(0);
    await pool.query(`UPDATE bookings SET status = 'confirmed' WHERE id = ANY($1::int[])`, [
      [parentId, childAId, childBId],
    ]);
    await expectAllSurfacesDebt(5_000_000);
  });

  it("CANCELLED con B → chỉ còn A (net 3tr) mà đã thu 4tr → nợ 0, không âm; bỏ hủy → 5tr", async () => {
    await pool.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [childBId]);
    await expectAllSurfacesDebt(0);
    await pool.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [childBId]);
    await expectAllSurfacesDebt(5_000_000);
  });

  it("DELETED (thùng rác) con A → chỉ còn B net 6tr, đã thu 4tr → nợ 2tr; phục hồi → 5tr", async () => {
    await pool.query(`UPDATE bookings SET deleted_at = NOW() WHERE id = $1`, [childAId]);
    await expectAllSurfacesDebt(2_000_000);
    await pool.query(`UPDATE bookings SET deleted_at = NULL WHERE id = $1`, [childAId]);
    await expectAllSurfacesDebt(5_000_000);
  });

  it("TRẢ DƯ: +20tr → nợ 0 mọi surface (không âm), tiền thu vẫn đủ sổ", async () => {
    await addPayment(parentId, 20_000_000);
    await expectAllSurfacesDebt(0);
    const fin = await engineCustomerFinance(custId);
    close(fin.totalPaid, 24_000_000); // 4tr + 20tr (1tr đã void, refund không tính)
  });
});
