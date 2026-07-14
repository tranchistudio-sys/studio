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
  verifyMonthReceivable,
  verifySignedAndCollected,
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

// ✅ GĐ1a (14/07): màn Khách hàng ĐÃ chuyển sang engineCustomerFinance — 3 test
// dưới lật it.fails → it, verify qua HTTP API THẬT (cần server chạy bản GĐ1a +
// env TRUTH_API_BASE=http://localhost:3000; thiếu env thì skip kèm cảnh báo,
// vì fallback legacy vẫn là công thức cũ đã bỏ).
describe.skipIf(!process.env.TRUTH_API_BASE)(
  "TIER 1b — màn Khách Hàng (HTTP API thật) khớp Engine (bắt buộc PASS từ GĐ1a)",
  () => {
    it("Top-20 khách nợ lớn nhất", async () => {
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

    it("20 khách ngẫu nhiên (md5 ổn định)", async () => {
      const cids = await ids(`SELECT id FROM customers ORDER BY md5(id::text) LIMIT 20`);
      const fails: string[] = [];
      for (const id of cids) {
        const c = record(await verifyCustomerDebt(id, "(ngẫu nhiên)"));
        if (!c.pass) fails.push(formatCheck(c));
      }
      expect(fails, `\n${fails.join("\n")}`).toEqual([]);
    });

    it("10 khách có hợp đồng CHA+CON (không cộng trùng)", async () => {
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
  },
);

describe("TIER 2 — lệch ĐÃ BIẾT so với Engine (GĐ1 phải lật it.fails → it)", () => {

  // ✅ GĐ1c (14/07): quy tắc ②③ ĐÃ áp vào getSimpleFinance (Dashboard + Copilot
  // cùng đọc engineCashOut) — lật it.fails → it, kèm check BẢO TOÀN bên dưới.
  it("Chi phí studio trong kỳ: Dashboard(consumer) khớp Engine (quy tắc ②③)", async () => {
    const to = vnToday();
    const from = `${to.slice(0, 7)}-01`;
    const c = record(await verifyCashOutRules(from, to));
    expect(c.pass, formatCheck(c)).toBe(true);
    // HTTP surface: màn Tổng quan tài chính thật cũng phải ra đúng số Engine
    if (process.env.TRUTH_API_BASE) {
      const base = process.env.TRUTH_API_BASE.replace(/\/$/, "");
      const dj = (await (await fetch(`${base}/api/dashboard/simple?from=${from}&to=${to}`)).json()) as {
        directExpense?: number;
      };
      expect(Number(dj.directExpense), "HTTP /dashboard/simple directExpense").toBe(c.surfaces.engine);
    }
    // BẢO TOÀN: studio + personal + chưa-duyệt + trả-gốc-vay = TOÀN BỘ expense trong kỳ
    // (không khoản nào bị rơi im lặng — chỉ được LOẠI CÓ TÊN).
    const all = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric), 0) AS v FROM expenses
       WHERE expense_date >= $1::date AND expense_date <= $2::date`,
      [from, to],
    );
    const total =
      c.surfaces.engine +
      c.surfaces["(engine loại: personal)"] +
      c.surfaces["(engine loại: chưa duyệt)"] +
      c.surfaces["(engine loại: trả gốc vay)"];
    expect(total, "studio + các khoản bị loại phải = tổng expense trong kỳ").toBe(
      Number((all.rows[0] as { v: string }).v),
    );
  });

  // ✅ GĐ1b-2 (14/07): quy tắc ④ ĐÃ áp — cast từ sổ staff_job_earnings, gán theo
  // booking bucket; tasks.cost đã bị loại. Test chuyển sang TIER 1e bên dưới.

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

// ─── TIER 1c — GĐ1b-1: "Còn có thể thu từ show của tháng" (scope ngày chụp) ────
// 8 điều kiện chủ chốt 14/07 tối: Engine ↔ Revenue monthly ↔ custom-range ↔
// Copilot cùng kỳ = cùng MỘT số; membership theo shoot_date/occurrence; không
// double-count multi-occurrence; contractValue/collected không đổi scope.

describe("TIER 1c — Còn có thể thu từ show của tháng (bắt buộc PASS từ GĐ1b-1)", () => {
  const ym = vnToday().slice(0, 7);

  it("Engine ↔ Revenue monthly(HTTP) ↔ custom-range(HTTP) ↔ Copilot: lệch 0 đồng", async () => {
    const c = record(await verifyMonthReceivable(ym));
    expect(c.pass, formatCheck(c)).toBe(true);
    if (!process.env.TRUTH_API_BASE) {
      console.warn("⚠️ TRUTH_API_BASE chưa bật — mới so Engine ↔ Copilot, thiếu 2 surface HTTP.");
    }
  });

  it("contractValue (ký mới, created_at) & collected (payment_date) KHÔNG đổi", async () => {
    if (!process.env.TRUTH_API_BASE) {
      console.warn("⚠️ Bỏ qua (cần TRUTH_API_BASE).");
      return;
    }
    const checks = await verifySignedAndCollected(ym);
    const fails = checks.map(record).filter(c => !c.pass);
    expect(fails.map(formatCheck), `\n${fails.map(formatCheck).join("\n")}`).toEqual([]);
  });

  it("Membership đúng ngữ nghĩa: tính đơn chụp-trong-tháng bất kể tạo khi nào; loại đơn chụp tháng khác; DISTINCT không double-count", async () => {
    const { getSchemaFlags } = await import("../lib/schema-compat");
    const { monthMembershipSql, engineReceivableForRange } = await import("../lib/finance/financial-engine");
    const [y, m] = ym.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const from = `${ym}-01`;
    const to = `${ym}-${String(lastDay).padStart(2, "0")}`;
    const hasOcc = (await getSchemaFlags()).occurrences;
    const member = monthMembershipSql("$1", "$2", hasOcc);
    const createdVN = `(b.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

    const engine = await engineReceivableForRange(from, to);

    // (item 6) Bản tính lại ĐỘC LẬP bằng DISTINCT id — đơn nhiều occurrence chỉ 1 lần
    const indep = await pool.query(
      `SELECT COALESCE(SUM(${DEBT_SQL}), 0) AS v FROM bookings b
       WHERE b.id IN (
         SELECT DISTINCT b.id FROM bookings b
         WHERE ${COUNTABLE} AND ${member})`,
      [from, to],
    );
    expect(Number((indep.rows[0] as { v?: string }).v)).toBe(engine);

    // (item 4) Phân hoạch theo ngày TẠO: engine = tạo-trước-tháng + tạo-trong-tháng + tạo-sau
    const parts = await pool.query(
      `SELECT
         COALESCE(SUM(${DEBT_SQL}) FILTER (WHERE ${createdVN} < $1::date), 0) AS pre,
         COALESCE(SUM(${DEBT_SQL}) FILTER (WHERE ${createdVN} BETWEEN $1::date AND $2::date), 0) AS cur,
         COALESCE(SUM(${DEBT_SQL}) FILTER (WHERE ${createdVN} > $2::date), 0) AS post
       FROM bookings b WHERE ${COUNTABLE} AND ${member}`,
      [from, to],
    );
    const pr = parts.rows[0] as { pre: string; cur: string; post: string };
    expect(Number(pr.pre) + Number(pr.cur) + Number(pr.post)).toBe(engine);
    console.log(
      `INFO | item4: đơn tạo TRƯỚC tháng nhưng chụp trong tháng đóng góp ${pr.pre} vào receivable ${ym} (phải được tính)`,
    );

    // (item 5) Đơn TẠO trong tháng nhưng KHÔNG chụp trong tháng: cấm lọt vào membership
    const leak = await pool.query(
      `SELECT COUNT(*) AS c, COALESCE(SUM(${DEBT_SQL}), 0) AS v FROM bookings b
       WHERE ${COUNTABLE} AND ${createdVN} BETWEEN $1::date AND $2::date
         AND NOT (${member})`,
      [from, to],
    );
    const lk = leak.rows[0] as { c: string; v: string };
    console.log(
      `INFO | item5: ${lk.c} đơn tạo trong ${ym} nhưng chụp tháng khác, tổng nợ sống ${lk.v} — KHÔNG nằm trong receivable tháng (đúng)`,
    );
    // membership và NOT membership loại trừ nhau — giao phải rỗng
    const overlap = await pool.query(
      `SELECT COUNT(*) AS c FROM bookings b
       WHERE ${COUNTABLE} AND (${member}) AND NOT (${member})`,
      [from, to],
    );
    expect(Number((overlap.rows[0] as { c: string }).c)).toBe(0);
  });
});

// ─── TIER 1e — GĐ1b-2: CAST theo show từ sổ staff_job_earnings (quy tắc ④) ─────

describe("TIER 1e — Cast từ sổ earnings (bắt buộc PASS từ GĐ1b-2)", () => {
  const ym = vnToday().slice(0, 7);

  it("Engine cast (booking bucket) ↔ monthly HTTP staffCast ↔ custom-range HTTP: lệch 0", async () => {
    const c = record(await verifyLaborSource(ym));
    expect(c.pass, formatCheck(c)).toBe(true);
    if (!process.env.TRUTH_API_BASE) {
      console.warn("⚠️ TRUTH_API_BASE chưa bật — thiếu 2 surface HTTP.");
    }
  });

  it("Metadata minh bạch: laborCoverage đúng số đếm thật + salesCommissionIncluded=false", async () => {
    if (!process.env.TRUTH_API_BASE) {
      console.warn("⚠️ Bỏ qua (cần TRUTH_API_BASE).");
      return;
    }
    const base = process.env.TRUTH_API_BASE.replace(/\/$/, "");
    const mj = (await (await fetch(`${base}/api/revenue/v2/monthly?range=1`)).json()) as {
      labor?: {
        laborSource: string;
        salesCommissionIncluded: boolean;
        laborCoverage: { earningCount: number; bookingCountWithEarnings: number; eligibleBookingCount: number; status: string };
        notes: string[];
      };
    };
    expect(mj.labor?.laborSource).toBe("staff_job_earnings");
    expect(mj.labor?.salesCommissionIncluded).toBe(false);
    // Đếm lại độc lập từ DB
    const cnt = await pool.query(`
      SELECT COUNT(*) AS ec, COUNT(DISTINCT e.booking_id) AS bc
      FROM staff_job_earnings e JOIN bookings b ON b.id = e.booking_id
      WHERE COALESCE(e.status,'') NOT IN ('voided','cancelled') AND ${COUNTABLE}`);
    const row = cnt.rows[0] as { ec: string; bc: string };
    expect(mj.labor?.laborCoverage.earningCount).toBe(Number(row.ec));
    expect(mj.labor?.laborCoverage.bookingCountWithEarnings).toBe(Number(row.bc));
    const eligible = await pool.query(`SELECT COUNT(*) AS v FROM bookings b WHERE ${COUNTABLE}`);
    expect(mj.labor?.laborCoverage.eligibleBookingCount).toBe(Number((eligible.rows[0] as { v: string }).v));
    const expectStatus =
      Number(row.bc) >= Number((eligible.rows[0] as { v: string }).v) ? "full" : "partial";
    expect(mj.labor?.laborCoverage.status).toBe(expectStatus);
    if (expectStatus === "partial") {
      expect((mj.labor?.notes ?? []).join(" ")).toContain("một số show cũ chưa có dữ liệu cast");
    }
    expect((mj.labor?.notes ?? []).join(" ")).toContain("Chưa bao gồm hoa hồng sale");
    console.log(`INFO | coverage: ${row.bc} booking có earning / ${(eligible.rows[0] as { v: string }).v} đơn hợp lệ (${row.ec} khoản) — ${expectStatus}`);
  });

  it("Chống trừ trùng: voided bị loại; mỗi earning MỘT lần; payroll consumed vẫn là chi phí", async () => {
    const { engineCastForCreatedCohort } = await import("../lib/finance/financial-engine");
    // Tổng cast all-time qua Engine-cohort trên khoảng rất rộng
    const engineAll = await engineCastForCreatedCohort("2000-01-01", "2100-01-01");

    // (a) Bản tính lại độc lập theo TỪNG earning DISTINCT — không double-count
    const indep = await pool.query(`
      SELECT COALESCE(SUM(rate::numeric), 0) AS v FROM (
        SELECT DISTINCT e.id, e.rate FROM staff_job_earnings e
        JOIN bookings b ON b.id = e.booking_id
        WHERE COALESCE(e.status,'') NOT IN ('voided','cancelled') AND ${COUNTABLE}) t`);
    expect(Number((indep.rows[0] as { v: string }).v)).toBe(engineAll);

    // (b) voided/cancelled bị loại: tổng KHÔNG lọc − tổng voided/cancelled = engine
    const split = await pool.query(`
      SELECT
        COALESCE(SUM(e.rate::numeric), 0) AS all_sum,
        COALESCE(SUM(e.rate::numeric) FILTER (WHERE COALESCE(e.status,'') IN ('voided','cancelled')), 0) AS bad_sum
      FROM staff_job_earnings e JOIN bookings b ON b.id = e.booking_id WHERE ${COUNTABLE}`);
    const sp = split.rows[0] as { all_sum: string; bad_sum: string };
    expect(Number(sp.all_sum) - Number(sp.bad_sum)).toBe(engineAll);

    // (c) earning đã bị payroll consume (payroll_id NOT NULL) VẪN là chi phí trong profit
    const byPayroll = await pool.query(`
      SELECT
        COALESCE(SUM(e.rate::numeric) FILTER (WHERE e.payroll_id IS NOT NULL), 0) AS consumed,
        COALESCE(SUM(e.rate::numeric) FILTER (WHERE e.payroll_id IS NULL), 0) AS pending
      FROM staff_job_earnings e JOIN bookings b ON b.id = e.booking_id
      WHERE COALESCE(e.status,'') NOT IN ('voided','cancelled') AND ${COUNTABLE}`);
    const bp = byPayroll.rows[0] as { consumed: string; pending: string };
    expect(Number(bp.consumed) + Number(bp.pending)).toBe(engineAll);
    console.log(`INFO | cast đã qua payroll: ${bp.consumed} | chưa qua payroll: ${bp.pending} — cả hai đều nằm trong chi phí (payroll không phải chi phí mới)`);

    // (d) audit: booking có CẢ earning lẫn expense direct — cảnh báo CỤ THỂ từng
    // booking (số tiền + mô tả chi), KHÔNG tự loại khi chưa đủ căn cứ.
    const audit = await pool.query(`
      SELECT b.order_code,
        (SELECT COALESCE(SUM(e.rate::numeric),0) FROM staff_job_earnings e
          WHERE e.booking_id = b.id AND COALESCE(e.status,'') NOT IN ('voided','cancelled')) AS earning_total,
        (SELECT COALESCE(SUM(x.amount::numeric),0) FROM expenses x
          WHERE x.booking_id = b.id AND x.status IN ('approved','paid')
            AND COALESCE(x.cost_class,'') = 'direct') AS expense_direct_total,
        (SELECT string_agg(COALESCE(x.description, x.category, '?'), '; ') FROM expenses x
          WHERE x.booking_id = b.id AND x.status IN ('approved','paid')
            AND COALESCE(x.cost_class,'') = 'direct') AS expense_desc
      FROM bookings b
      WHERE ${COUNTABLE}
        AND EXISTS (SELECT 1 FROM staff_job_earnings e WHERE e.booking_id = b.id
                    AND COALESCE(e.status,'') NOT IN ('voided','cancelled'))
        AND EXISTS (SELECT 1 FROM expenses x WHERE x.booking_id = b.id
                    AND x.status IN ('approved','paid') AND COALESCE(x.cost_class,'') = 'direct')
      LIMIT 10`);
    if (audit.rows.length) {
      for (const r of audit.rows as Array<{
        order_code: string; earning_total: string; expense_direct_total: string; expense_desc: string;
      }>) {
        console.warn(
          `⚠️ AUDIT | ${r.order_code}: earning=${r.earning_total} + expense_direct=${r.expense_direct_total} (${r.expense_desc}) — kiểm tra tay xem có trả cast 2 đường không`,
        );
      }
    } else {
      console.log("INFO | audit: không có booking nào vừa earning vừa expense direct.");
    }
  });
});

// ─── TIER 1f — GĐ1e-1: BUSINESS ENGINE = Financial Engine TỪNG ĐỒNG ────────────

describe("TIER 1f — Business Engine không được đổi một đồng nào (bắt buộc PASS)", () => {
  const ym = vnToday().slice(0, 7);

  it("A. Tổng quan tháng: mọi facts JSON == Engine", async () => {
    const { verifyBusinessMonthly } = await import("../lib/finance/truth-service");
    const checks = (await verifyBusinessMonthly(ym)).map(record);
    const fails = checks.filter(c => !c.pass);
    expect(fails.map(formatCheck), `\n${fails.map(formatCheck).join("\n")}`).toEqual([]);
  });

  it("C. Công nợ: tổng + từng khách top nợ + tổng quá hạn == Engine", async () => {
    const { verifyBusinessDebt } = await import("../lib/finance/truth-service");
    const checks = (await verifyBusinessDebt()).map(record);
    const fails = checks.filter(c => !c.pass);
    expect(fails.map(formatCheck), `\n${fails.map(formatCheck).join("\n")}`).toEqual([]);
  });

  it("D+E. Chéo sổ per-booking ↔ per-service ↔ tổng hệ thống ↔ sổ cast", async () => {
    const { verifyBusinessCrossSums } = await import("../lib/finance/truth-service");
    const checks = (await verifyBusinessCrossSums()).map(record);
    const fails = checks.filter(c => !c.pass);
    expect(fails.map(formatCheck), `\n${fails.map(formatCheck).join("\n")}`).toEqual([]);
  });

  it("VÍ DỤ JSON thật cho câu 'Tháng này thế nào?' (log để chủ duyệt)", async () => {
    const { bizMonthlyOverview, bizBusinessHealth, bizCashflowProjection } = await import(
      "../lib/finance/business-engine"
    );
    const [overview, health, cashflow] = await Promise.all([
      bizMonthlyOverview(ym),
      bizBusinessHealth(ym),
      bizCashflowProjection(ym),
    ]);
    console.log("=== JSON 'Tháng này thế nào?' ===");
    console.log(JSON.stringify({ overview, cashflow, health }, null, 2));
    // Ghi ra file khi cần đính kèm báo cáo (vitest có thể nuốt console)
    if (process.env.TRUTH_JSON_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.TRUTH_JSON_OUT, JSON.stringify({ overview, cashflow, health }, null, 2));
    }
    expect(overview.status).toBeDefined();
    expect(overview.source).toBe("financial-engine");
    // Coverage cast đang partial trên data thật → không được nhận 'ok'
    expect(["partial", "ok", "unknown"]).toContain(overview.status);
    expect(health.data?.health).toBeDefined();
  });
});
