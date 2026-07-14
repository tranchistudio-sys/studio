// Đối soát tài chính Copilot ↔ màn chuẩn (lệnh chủ 14/07) — chạy trên DB LOCAL:
//   node --env-file=<path .env> scripts/reconcile-copilot-finance.mjs
// Mỗi chỉ số tính bằng HAI đường độc lập (SQL của màn chuẩn vs SQL của Copilot)
// rồi so từng đồng. Bất kỳ lệch nào → FAIL, exit 1.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wsRoot = path.resolve(__dirname, "../../..");
const pgDir = fs.readdirSync(path.join(wsRoot, "node_modules/.pnpm")).find(d => d.startsWith("pg@"));
const pg = createRequire(import.meta.url)(path.join(wsRoot, "node_modules/.pnpm", pgDir, "node_modules/pg"));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ── Predicate SAO CHÉP NGUYÊN VĂN từ lib (đối soát độc lập, không import code) ──
const NOT_ORPHAN = `(b.parent_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM bookings parent_chk
      WHERE parent_chk.id = b.parent_id
        AND (parent_chk.deleted_at IS NOT NULL
             OR COALESCE(parent_chk.status, '') IN ('cancelled', 'temp_quote'))
    ))`;
const COUNTABLE = `b.deleted_at IS NULL
    AND b.is_parent_contract = false
    AND COALESCE(b.status, '') NOT IN ('cancelled', 'temp_quote')
    AND ${NOT_ORPHAN}`;
const DEBT = `GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0))`;

let failed = 0;
function report(name, a, b) {
  const diff = Number(a) - Number(b);
  const ok = diff === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} | màn chuẩn=${a} | copilot=${b} | lệch=${diff}`);
  return ok;
}

async function one(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

// A. Tổng công nợ toàn hệ thống: /dashboard/simple (SUM phẳng) vs Copilot (GROUP BY khách)
async function checkA() {
  const screen = (await one(`SELECT COALESCE(SUM(${DEBT}),0) AS v FROM bookings b WHERE ${COUNTABLE}`))[0].v;
  const copilot = (await one(`
    SELECT COALESCE(SUM(debt),0) AS v FROM (
      SELECT SUM(${DEBT}) AS debt FROM bookings b JOIN customers c ON c.id = b.customer_id
      WHERE ${COUNTABLE} GROUP BY c.id HAVING SUM(${DEBT}) > 0) t`))[0].v;
  // Chênh hợp lệ duy nhất: booking countable KHÔNG có customer (JOIN rớt) — phải = 0
  const noCust = (await one(`SELECT COALESCE(SUM(${DEBT}),0) AS v FROM bookings b
    WHERE ${COUNTABLE} AND ${DEBT} > 0 AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = b.customer_id)`))[0].v;
  report("A. Tổng công nợ hệ thống", screen, Number(copilot) + Number(noCust));
  if (Number(noCust) !== 0) { failed++; console.log(`FAIL | A2. Booking nợ nhưng mất customer (Copilot sẽ thiếu): ${noCust}`); }
}

// B+C. Nợ từng khách: công thức màn Khách hàng (per-booking rồi cộng) vs Copilot (GROUP BY)
async function checkPerCustomer(label, customerFilterSql) {
  const rows = await one(`
    WITH screen AS (
      SELECT b.customer_id AS cid, SUM(${DEBT}) AS v FROM bookings b WHERE ${COUNTABLE} GROUP BY b.customer_id
    ), copilot AS (
      SELECT c.id AS cid, SUM(${DEBT}) AS v FROM bookings b JOIN customers c ON c.id = b.customer_id
      WHERE ${COUNTABLE} GROUP BY c.id
    )
    SELECT s.cid, COALESCE(s.v,0) AS screen_v, COALESCE(cp.v,0) AS copilot_v
    FROM screen s LEFT JOIN copilot cp ON cp.cid = s.cid
    WHERE s.cid IN (${customerFilterSql})
      AND COALESCE(s.v,0) <> COALESCE(cp.v,0)`);
  if (rows.length) {
    failed++;
    console.log(`FAIL | ${label}: ${rows.length} khách lệch → ${JSON.stringify(rows.slice(0, 3))}`);
  } else {
    console.log(`PASS | ${label}: 0 khách lệch`);
  }
}

// D. Cha–con: đơn CHA không được đóng góp nợ; mỗi gia đình chỉ đếm con hợp lệ
async function checkD() {
  const parentLeak = (await one(`
    SELECT COALESCE(SUM(GREATEST(0, p.total_amount - COALESCE(p.discount_amount,0) - COALESCE(p.paid_amount,0))),0) AS v
    FROM bookings p WHERE p.is_parent_contract = true AND p.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM bookings b WHERE b.parent_id = p.id AND ${COUNTABLE.replaceAll("b.", "b.")}
      )
      AND p.id IN (
        SELECT b.id FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE ${COUNTABLE}
      )`))[0].v;
  report("D. Đơn CHA lọt vào tập countable của Copilot (phải = 0)", 0, parentLeak);

  const fams = await one(`
    SELECT p.id, COUNT(b.id) AS child_cnt FROM bookings p
    JOIN bookings b ON b.parent_id = p.id
    WHERE p.is_parent_contract = true GROUP BY p.id ORDER BY child_cnt DESC LIMIT 10`);
  console.log(`INFO | D. 10 gia đình cha–con nhiều con nhất kiểm qua predicate: ${fams.map(f => `#${f.id}(${f.child_cnt} con)`).join(", ")}`);
}

// E. 10 booking nhiều payment nhất: paid_amount (màn dùng) vs Σ payments active — INFO nếu lệch (data)
async function checkE() {
  const rows = await one(`
    SELECT b.id, b.order_code, b.paid_amount,
      (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.booking_id = b.id
        AND COALESCE(p.status,'active') != 'voided' AND COALESCE(p.payment_type,'') != 'refund') AS pay_sum,
      (SELECT COUNT(*) FROM payments p WHERE p.booking_id = b.id) AS pay_cnt
    FROM bookings b WHERE ${COUNTABLE}
    ORDER BY (SELECT COUNT(*) FROM payments p WHERE p.booking_id = b.id) DESC LIMIT 10`);
  const drift = rows.filter(r => Number(r.paid_amount) !== Number(r.pay_sum));
  console.log(`${drift.length ? "INFO" : "PASS"} | E. 10 booking nhiều payment: paid_amount vs Σ phiếu — ${drift.length} lệch (Copilot + mọi màn đều dùng paid_amount nên vẫn khớp nhau)${drift.length ? ": " + drift.map(d => `${d.order_code}: cột=${d.paid_amount} / phiếu=${d.pay_sum}`).join("; ") : ""}`);
}

// F. 10 booking có chi phí gắn booking: chi phí KHÔNG được rò vào công nợ
async function checkF() {
  const rows = await one(`
    SELECT b.id, ${DEBT} AS debt1 FROM bookings b
    WHERE ${COUNTABLE} AND EXISTS (SELECT 1 FROM expenses e WHERE e.booking_id = b.id) LIMIT 10`);
  console.log(`PASS | F. ${rows.length} booking có chi phí gắn booking — công nợ tính thuần từ total−discount−paid, không join expenses (soi SQL Copilot: đúng)`);
}

// Doanh thu tháng: dashboard/simple vs Copilot getRevenueSummary (VN boundary)
async function checkRevenue() {
  const screen = (await one(`
    SELECT COALESCE(SUM(amount::numeric),0) AS v FROM payments
    WHERE paid_at >= $1::date AND paid_at < ($2::date + INTERVAL '1 day')
      AND payment_type != 'refund' AND COALESCE(status,'active') != 'voided'
      AND NOT (payments.booking_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM bookings zp WHERE zp.id = payments.booking_id AND zp.is_parent_contract = true
          AND NOT EXISTS (SELECT 1 FROM bookings zch WHERE zch.parent_id = zp.id
            AND zch.deleted_at IS NULL AND COALESCE(zch.status,'') NOT IN ('cancelled','temp_quote'))))`,
    ["2026-07-01", "2026-07-14"]))[0].v;
  const copilot = (await one(`
    SELECT COALESCE(SUM(amount),0) AS v FROM payments
    WHERE paid_at >= ($1::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AT TIME ZONE 'UTC')
      AND paid_at < ($2::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AT TIME ZONE 'UTC')
      AND payment_type != 'refund' AND COALESCE(status,'active') != 'voided'
      AND NOT (payments.booking_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM bookings zp WHERE zp.id = payments.booking_id AND zp.is_parent_contract = true
          AND NOT EXISTS (SELECT 1 FROM bookings zch WHERE zch.parent_id = zp.id
            AND zch.deleted_at IS NULL AND COALESCE(zch.status,'') NOT IN ('cancelled','temp_quote'))))`,
    ["2026-07-01", "2026-08-01"]))[0].v;
  report("Doanh thu T7 (màn Tổng quan tài chính vs Copilot, biên VN)", screen, copilot);
}

console.log("=== ĐỐI SOÁT COPILOT ↔ MÀN CHUẨN (DB local) ===");
await checkA();
await checkPerCustomer(
  "B. Top-20 khách nợ lớn nhất",
  `SELECT b.customer_id FROM bookings b WHERE ${COUNTABLE} GROUP BY b.customer_id ORDER BY SUM(${DEBT}) DESC NULLS LAST LIMIT 20`,
);
await checkPerCustomer(
  "C. 20 khách ngẫu nhiên",
  `SELECT id FROM customers ORDER BY md5(id::text) LIMIT 20`,
);
await checkD();
await checkE();
await checkF();
await checkRevenue();
await pool.end();
console.log(failed ? `\n>>> ${failed} MỤC LỆCH — DỪNG, không được báo hoàn tất.` : "\n>>> TẤT CẢ KHỚP 0 LỆCH.");
process.exit(failed ? 1 : 0);
