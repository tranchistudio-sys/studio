/**
 * FINANCIAL TRUTH TEST — GĐ0 (chủ duyệt 14/07, kiến trúc Engine-làm-chuẩn):
 *
 *   Booking/Payment/Expense/Payroll → FINANCIAL ENGINE → mọi consumer
 *   (Dashboard, Khách hàng, Revenue, Copilot) phải đọc ra ĐÚNG số Engine.
 *   Dashboard KHÔNG phải chuẩn — nó cũng là consumer bị kiểm.
 *
 * Chạy trên DB THẬT (local snapshot):
 *   cd artifacts/api-server && DATABASE_URL=... pnpm truth
 *
 * Đuôi .itest.ts + config riêng để KHÔNG lọt vào `pnpm test` thường. Không mock.
 * Lệch 1 đồng so với Engine = FAIL + log rõ consumer nào lệch.
 *
 * TIER 1 (bắt buộc PASS từ hôm nay): consumer đã khớp Engine + toàn vẹn dữ liệu gốc.
 * TIER 2 (`it.fails` — lệch ĐÃ BIẾT, GĐ1 phải lật lại thành `it`):
 *   - màn Khách Hàng (không trừ giảm giá, trừ bằng Σ phiếu thu, clamp ở tổng) → GĐ1a
 *   - Dashboard đếm chi phí sai quy tắc ②③ (personal/chưa duyệt/trả gốc vay) → GĐ1b
 *   - màn Doanh thu dùng tasks.cost thay staff_job_earnings (quy tắc ④) → GĐ1d
 */
import { describe, it, expect, beforeAll } from "vitest";
import { pool } from "@workspace/db";
import {
  verifyCustomerDebt,
  verifySystemDebt,
  verifyCashIn,
  verifyCashOutRules,
  verifyLaborSource,
  verifyBookingRemaining,
  verifyFamilyCashIntegrity,
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

function vnToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("Financial Truth Test cần DATABASE_URL (DB local snapshot) — chạy qua `pnpm truth`.");
  }
  _resetTruthCache();
});

describe("TIER 1 — consumer đã khớp ENGINE + toàn vẹn dữ liệu gốc (bắt buộc PASS)", () => {
  it("Tổng công nợ hệ thống: Engine ↔ Dashboard(consumer) ↔ Copilot(tool thật)", async () => {
    const c = record(await verifySystemDebt());
    expect(c.pass, formatCheck(c)).toBe(true);
  });

  it("Tiền đã thu trong kỳ: Engine(payments gốc) ↔ Dashboard ↔ Copilot", async () => {
    const to = vnToday();
    const from = `${to.slice(0, 7)}-01`;
    const c = record(await verifyCashIn(from, to));
    expect(c.pass, formatCheck(c)).toBe(true);
  });

  it("Nợ per-khách: Copilot phải khớp Engine trên top-20 + 20 ngẫu nhiên + 10 cha–con", async () => {
    const top = await ids(`
      SELECT c.id FROM customers c JOIN bookings b ON b.customer_id = c.id
      WHERE ${COUNTABLE} GROUP BY c.id ORDER BY SUM(${DEBT_SQL}) DESC LIMIT 20`);
    const rand = await ids(`SELECT id FROM customers ORDER BY md5(id::text) LIMIT 20`);
    const fam = await ids(`
      SELECT DISTINCT c.id FROM customers c
      JOIN bookings p ON p.customer_id = c.id AND p.is_parent_contract = true
      JOIN bookings ch ON ch.parent_id = p.id
      ORDER BY c.id LIMIT 10`);
    const fails: string[] = [];
    for (const id of [...new Set([...top, ...rand, ...fam])]) {
      const c = await verifyCustomerDebt(id, "");
      // TIER 1 chỉ xét consumer Copilot vs Engine (màn Khách hàng nằm ở TIER 2)
      const copilotDiff = Math.abs(c.surfaces.copilot - c.surfaces.engine);
      if (copilotDiff !== 0) fails.push(formatCheck(c));
    }
    expect(fails, `\n${fails.join("\n")}`).toEqual([]);
  });

  it("10 booking nhiều payment nhất: paid_amount (phân bổ) ↔ Σ phiếu thu gốc", async () => {
    const bids = await ids(`
      SELECT b.id FROM bookings b WHERE ${COUNTABLE}
      ORDER BY (SELECT COUNT(*) FROM payments p WHERE p.booking_id = b.id) DESC, b.id LIMIT 10`);
    const fails: string[] = [];
    for (const id of bids) {
      const c = record(await verifyBookingRemaining(id));
      if (!c.pass) fails.push(formatCheck(c));
    }
    expect(fails, fails.join("\n")).toEqual([]);
  });

  it("Nhóm bị loại (deleted/cancelled/temp_quote/cha tổng/mồ côi) đóng góp = 0", async () => {
    const checks = await verifyExcludedGroups();
    const fails = checks.map(record).filter(c => !c.pass);
    expect(fails.map(formatCheck), "").toEqual([]);
  });
});

describe("TIER 2 — lệch ĐÃ BIẾT so với Engine (GĐ1 phải lật it.fails → it)", () => {
  // ⚠️ Màn Khách hàng (computeCustomerAggregate): KHÔNG trừ giảm giá, trừ bằng
  // Σ phiếu thu thay cột paid_amount, clamp ở TỔNG → đo 14/07: 13/20 top nợ,
  // 10/10 khách cha–con lệch (vd Trúc Ly KH#150: 43.299.994 vs Engine 42.799.994).
  // GĐ1a (debt-service) sửa xong PHẢI đổi it.fails → it.
  it.fails("Màn Khách Hàng khớp Engine: top-20 khách nợ lớn nhất", async () => {
    const cids = await ids(`
      SELECT c.id FROM customers c JOIN bookings b ON b.customer_id = c.id
      WHERE ${COUNTABLE} GROUP BY c.id ORDER BY SUM(${DEBT_SQL}) DESC LIMIT 20`);
    const fails: string[] = [];
    for (const id of cids) {
      const c = record(await verifyCustomerDebt(id, "(top nợ)"));
      if (Math.abs(c.surfaces.manKhachHang - c.surfaces.engine) !== 0) fails.push(formatCheck(c));
    }
    expect(fails, `\n${fails.join("\n")}`).toEqual([]);
  });

  it.fails("Màn Khách Hàng khớp Engine: 20 khách ngẫu nhiên (md5 ổn định)", async () => {
    const cids = await ids(`SELECT id FROM customers ORDER BY md5(id::text) LIMIT 20`);
    const fails: string[] = [];
    for (const id of cids) {
      const c = record(await verifyCustomerDebt(id, "(ngẫu nhiên)"));
      if (Math.abs(c.surfaces.manKhachHang - c.surfaces.engine) !== 0) fails.push(formatCheck(c));
    }
    expect(fails, `\n${fails.join("\n")}`).toEqual([]);
  });

  it.fails("Màn Khách Hàng khớp Engine: 10 khách có hợp đồng CHA+CON", async () => {
    const cids = await ids(`
      SELECT DISTINCT c.id FROM customers c
      JOIN bookings p ON p.customer_id = c.id AND p.is_parent_contract = true
      JOIN bookings ch ON ch.parent_id = p.id
      ORDER BY c.id LIMIT 10`);
    const fails: string[] = [];
    for (const id of cids) {
      const c = record(await verifyCustomerDebt(id, "(cha+con)"));
      if (Math.abs(c.surfaces.manKhachHang - c.surfaces.engine) !== 0) fails.push(formatCheck(c));
    }
    expect(fails, `\n${fails.join("\n")}`).toEqual([]);
  });

  // ⚠️ Quy tắc ②③: Dashboard /dashboard/simple đang đếm CẢ chi phí personal /
  // chưa duyệt / trả gốc vay. GĐ1b (cashflow-service) sửa xong PHẢI lật → it.
  it.fails("Chi phí studio trong kỳ: Dashboard(consumer) khớp Engine (quy tắc ②③)", async () => {
    const to = vnToday();
    const from = `${to.slice(0, 7)}-01`;
    const c = record(await verifyCashOutRules(from, to));
    expect(c.pass, formatCheck(c)).toBe(true);
  });

  // ⚠️ Quy tắc ④: màn Doanh thu dùng tasks.cost (thực tế = 0, không ai nhập) thay
  // staff_job_earnings. GĐ1d (labor-service) sửa xong PHẢI lật → it.
  it.fails("Lương cast trong kỳ: nguồn màn Doanh thu khớp Engine (quy tắc ④)", async () => {
    const to = vnToday();
    const from = `${to.slice(0, 7)}-01`;
    const c = record(await verifyLaborSource(from, to));
    expect(c.pass, formatCheck(c)).toBe(true);
  });

  // ⚠️ NỢ DỮ LIỆU LỊCH SỬ (đo 14/07: 39 gia đình đơn): Σ paid_amount trên các
  // thành viên sống KHÔNG khớp Σ phiếu thu gốc — chủ yếu đếm TRÙNG cha+con
  // (vd FAM#134: phân bổ 50.2tr vs phiếu gốc 24.2tr) hoặc paid_amount nhập tay
  // không có phiếu. Đây là việc LÀM SẠCH DATA (chiến dịch riêng), không phải lỗi
  // code — mọi màn + Engine hiện cùng đọc paid_amount nên vẫn nhất quán với nhau.
  // Lật → it sau chiến dịch làm sạch + trigger đồng bộ paid_amount.
  it.fails("Toàn vẹn GIA ĐÌNH đơn: Σ phiếu thu gốc = Σ paid_amount thành viên sống", async () => {
    const drifts = (await verifyFamilyCashIntegrity(200)).map(record);
    expect(
      drifts.map(formatCheck),
      `\n${drifts.map(formatCheck).join("\n")}`,
    ).toEqual([]);
  });
});
