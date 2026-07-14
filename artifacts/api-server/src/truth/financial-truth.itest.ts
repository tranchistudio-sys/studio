/**
 * FINANCIAL TRUTH TEST — GĐ0 (chủ duyệt 14/07). Chạy trên DB THẬT (local snapshot):
 *
 *   cd artifacts/api-server && DATABASE_URL=... pnpm truth
 *
 * Đuôi .itest.ts để KHÔNG lọt vào `pnpm test` thường (vitest chỉ gom *.test.*).
 * Không mock — import code thật, nối DB thật. Lệch 1 đồng = FAIL + log rõ surface.
 *
 * Tier 1 (bắt buộc PASS từ hôm nay): Dashboard ↔ Copilot ↔ booking-money.
 * Tier 2 (chốt chặn GĐ1): màn Khách Hàng ↔ phần còn lại — nếu FAIL tức màn
 * Khách hàng còn công thức riêng (không trừ giảm giá, clamp ở tổng) — đúng
 * hiện trạng đã phát hiện; GĐ1 debt-service phải làm tier này PASS.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { pool } from "@workspace/db";
import {
  verifyCustomerDebt,
  verifySystemDebt,
  verifyRevenue,
  verifyBookingRemaining,
  verifyExcludedGroups,
  formatCheck,
  _resetTruthCache,
  type TruthCheck,
} from "../lib/finance/truth-service";

const ledger: TruthCheck[] = [];
function record(c: TruthCheck): TruthCheck {
  ledger.push(c);
  console.log(formatCheck(c));
  return c;
}

async function ids(sql: string): Promise<number[]> {
  const r = await pool.query(sql);
  return (r.rows as Array<{ id: number }>).map(x => Number(x.id));
}

const DEBT_SQL =
  "GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0))";
const COUNTABLE = `b.deleted_at IS NULL AND b.is_parent_contract = false
  AND COALESCE(b.status,'') NOT IN ('cancelled','temp_quote')
  AND (b.parent_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM bookings pk WHERE pk.id = b.parent_id
      AND (pk.deleted_at IS NOT NULL OR COALESCE(pk.status,'') IN ('cancelled','temp_quote'))))`;

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("Financial Truth Test cần DATABASE_URL (DB local snapshot) — chạy qua `pnpm truth`.");
  }
  _resetTruthCache();
});

describe("TIER 1 — Dashboard ↔ Copilot ↔ booking-money (bắt buộc PASS)", () => {
  it("Tổng công nợ toàn hệ thống: SQL dashboard vs TOOL Copilot thật", async () => {
    const c = record(await verifySystemDebt());
    expect(c.pass, formatCheck(c)).toBe(true);
  });

  it("Doanh thu tháng: màn Tổng quan tài chính vs tool Copilot (cùng cửa sổ)", async () => {
    const now = new Date();
    const vn = now.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
    const from = `${vn.slice(0, 7)}-01`;
    const c = record(await verifyRevenue(from, vn));
    expect(c.pass, formatCheck(c)).toBe(true);
  });

  it("10 booking nhiều payment nhất: remaining từ PHIẾU THU (lib) vs CỘT paid_amount (màn)", async () => {
    const bids = await ids(`
      SELECT b.id FROM bookings b WHERE ${COUNTABLE}
      ORDER BY (SELECT COUNT(*) FROM payments p WHERE p.booking_id = b.id) DESC, b.id LIMIT 10`);
    const fails: string[] = [];
    for (const id of bids) {
      const c = record(await verifyBookingRemaining(id));
      if (!c.pass) fails.push(formatCheck(c));
    }
    // Lệch ở đây = cột paid_amount hết đồng bộ với phiếu thu (lỗi DATA phải xử lý,
    // vì MỌI màn đang tin cột paid_amount).
    expect(fails, fails.join("\n")).toEqual([]);
  });

  it("Nhóm bị loại (deleted/cancelled/temp_quote/cha tổng/con mồ côi) đóng góp = 0", async () => {
    const checks = await verifyExcludedGroups();
    const fails = checks.map(record).filter(c => !c.pass);
    expect(fails.map(formatCheck), "").toEqual([]);
  });
});

describe("TIER 2 — màn Khách Hàng ↔ Dashboard ↔ Copilot (chốt chặn GĐ1)", () => {
  // ⚠️ KNOWN DIVERGENCE (đo 14/07 trên snapshot prod): computeCustomerAggregate của màn
  // Khách hàng KHÔNG trừ giảm giá, trừ bằng Σ phiếu thu (không phải cột paid_amount),
  // và clamp ở TỔNG thay vì từng đơn → 13/20 top nợ + 10/10 khách cha–con lệch
  // (vd Trúc Ly: màn khách 43.299.994 vs chuẩn 42.799.994).
  // `it.fails` = suite xanh NHƯNG ghi nhận lệch còn tồn tại. GĐ1a (debt-service) sửa
  // màn Khách hàng xong PHẢI đổi it.fails → it — nếu quên, suite sẽ đỏ để nhắc.
  it.fails("Top 20 khách nợ lớn nhất: 3 surface phải cùng một số", async () => {
    const cids = await ids(`
      SELECT c.id FROM customers c JOIN bookings b ON b.customer_id = c.id
      WHERE ${COUNTABLE} GROUP BY c.id ORDER BY SUM(${DEBT_SQL}) DESC LIMIT 20`);
    const fails: string[] = [];
    for (const id of cids) {
      const c = record(await verifyCustomerDebt(id, "(top nợ)"));
      if (!c.pass) fails.push(formatCheck(c));
    }
    expect(fails, `\n${fails.join("\n")}`).toEqual([]);
  });

  it.fails("20 khách ngẫu nhiên (md5 ổn định): 3 surface phải cùng một số", async () => {
    const cids = await ids(`SELECT id FROM customers ORDER BY md5(id::text) LIMIT 20`);
    const fails: string[] = [];
    for (const id of cids) {
      const c = record(await verifyCustomerDebt(id, "(ngẫu nhiên)"));
      if (!c.pass) fails.push(formatCheck(c));
    }
    expect(fails, `\n${fails.join("\n")}`).toEqual([]);
  });

  it.fails("10 khách có hợp đồng CHA+CON: 3 surface phải cùng một số (không cộng trùng)", async () => {
    const cids = await ids(`
      SELECT DISTINCT c.id FROM customers c
      JOIN bookings p ON p.customer_id = c.id AND p.is_parent_contract = true
      JOIN bookings ch ON ch.parent_id = p.id
      ORDER BY c.id LIMIT 10`);
    const fails: string[] = [];
    for (const id of cids) {
      const c = record(await verifyCustomerDebt(id, "(cha+con)"));
      if (!c.pass) fails.push(formatCheck(c));
    }
    expect(fails, `\n${fails.join("\n")}`).toEqual([]);
  });
});
