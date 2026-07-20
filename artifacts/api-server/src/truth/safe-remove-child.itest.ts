/**
 * TRUTH TEST — gỡ dịch vụ khỏi hợp đồng KHÔNG được xoá cứng tiền/chữ ký/lịch sử.
 *
 * Trước 20/07, DELETE /bookings/:parentId/remove-child/:childId xoá CỨNG cả phiếu
 * thu, hợp đồng, chi phí, công việc và chính đơn — không thùng rác, không hoàn tác.
 * Rủi ro tăng vọt sau PR #123 vì từ nay nhiều đơn mang tiền thật trở thành dịch vụ
 * con của hợp đồng gộp.
 *
 * Luật mới:
 *  - dịch vụ con CÓ phiếu thu       → 409, không xoá gì
 *  - dịch vụ con gắn hợp đồng ĐÃ KÝ → 409, không xoá gì
 *  - còn lại                        → XOÁ MỀM vào thùng rác, mọi dữ liệu giữ nguyên
 *
 * Dọn sạch data tổng hợp trong afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { pool } from "@workspace/db";
import type { Server } from "node:http";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "truth-test-secret";

function mint(staffId: number): string {
  const secret = process.env.SESSION_SECRET as string;
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const b = Buffer.from(JSON.stringify({ id: staffId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `${h}.${b}.${createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url")}`;
}

let srv: Server;
let base: string;
let token: string;
let parentId: number;
let childPaid: number;   // con CÓ phiếu thu
let childSigned: number; // con gắn hợp đồng đã ký
let childPlain: number;  // con sạch — được phép gỡ
const CODE = `ITEST-RMCHILD-${Date.now()}`;
const madeBookings: number[] = [];
const madeContracts: number[] = [];

async function api(method: string, path: string) {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
}

async function mkBooking(label: string, parent: number | null, total = 1_000_000) {
  const r = await pool.query(
    `INSERT INTO bookings (order_code, customer_id, shoot_date, shoot_time, service_category, package_type,
       total_amount, deposit_amount, discount_amount, paid_amount, items, surcharges, deductions,
       assigned_staff, is_parent_contract, status, parent_id, service_label)
     VALUES ($1,(SELECT id FROM customers ORDER BY id DESC LIMIT 1),'2031-05-01','08:00','wedding',$2,
       $3,'0','0','0','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,$4,'confirmed',$5,$2)
     RETURNING id`,
    [`${CODE}-${label}`, label, String(total), parent === null, parent]);
  const id = (r.rows[0] as { id: number }).id;
  madeBookings.push(id);
  return id;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Cần DATABASE_URL (DB local) — chạy qua `pnpm truth`.");
  const express = (await import("express")).default;
  const { default: bookingsRouter } = await import("../routes/bookings");
  const app = express();
  app.use(express.json());
  app.use("/api", bookingsRouter);
  srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  const a = await pool.query(`SELECT id FROM staff WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1`);
  token = mint((a.rows[0] as { id: number }).id);

  parentId = await mkBooking("P", null, 0);
  childPaid = await mkBooking("paid", parentId);
  childSigned = await mkBooking("signed", parentId);
  childPlain = await mkBooking("plain", parentId);

  await pool.query(
    `INSERT INTO payments (booking_id, amount, payment_method, payment_type, notes, paid_at)
     VALUES ($1,'750000','cash','payment','itest thu tiền', NOW())`, [childPaid]);

  const c = await pool.query(
    `INSERT INTO contracts (booking_id, customer_id, contract_code, title, content, total_value, status, signed_at)
     VALUES ($1,(SELECT customer_id FROM bookings WHERE id = $1),$2,'HĐ itest','điều khoản itest','1000000','signed', NOW())
     RETURNING id`,
    [childSigned, `${CODE}-HD`]);
  madeContracts.push((c.rows[0] as { id: number }).id);
});

afterAll(async () => {
  if (madeContracts.length) await pool.query(`DELETE FROM contracts WHERE id = ANY($1::int[])`, [madeContracts]);
  if (madeBookings.length) {
    await pool.query(`DELETE FROM payments WHERE booking_id = ANY($1::int[])`, [madeBookings]);
    await pool.query(`DELETE FROM booking_change_log WHERE booking_id = ANY($1::int[])`, [madeBookings]);
    await pool.query(`DELETE FROM bookings WHERE id = ANY($1::int[])`, [madeBookings]);
  }
  await new Promise<void>(r => srv?.close(() => r()));
});

describe("Gỡ dịch vụ CÓ TIỀN → từ chối, không mất gì", () => {
  it("409 kèm số phiếu + tổng tiền, nói rõ vướng gì", async () => {
    const r = await api("DELETE", `/api/bookings/${parentId}/remove-child/${childPaid}`);
    expect(r.status, r.text).toBe(409);
    expect(r.json.blockedBy).toBe("payments");
    expect(r.json.paymentTotal).toBe(750000);
    expect(String(r.json.error)).toContain("phiếu thu");
  });

  it("phiếu thu và đơn còn NGUYÊN sau khi bị từ chối", async () => {
    const p = await pool.query(`SELECT COUNT(*)::int n FROM payments WHERE booking_id = $1`, [childPaid]);
    expect((p.rows[0] as { n: number }).n, "phiếu thu bị xoá dù đã từ chối").toBe(1);
    const b = await pool.query(`SELECT deleted_at FROM bookings WHERE id = $1`, [childPaid]);
    expect((b.rows[0] as { deleted_at: unknown }).deleted_at).toBeNull();
  });
});

describe("Gỡ dịch vụ gắn HỢP ĐỒNG ĐÃ KÝ → từ chối, chữ ký còn nguyên", () => {
  it("409 và nói rõ là do hợp đồng đã ký", async () => {
    const r = await api("DELETE", `/api/bookings/${parentId}/remove-child/${childSigned}`);
    expect(r.status, r.text).toBe(409);
    expect(r.json.blockedBy).toBe("signed-contract");
  });

  it("hợp đồng đã ký KHÔNG bị xoá", async () => {
    const c = await pool.query(`SELECT status FROM contracts WHERE id = ANY($1::int[])`, [madeContracts]);
    expect(c.rows.length, "hợp đồng đã ký bị xoá cứng").toBe(1);
    expect((c.rows[0] as { status: string }).status).toBe("signed");
  });
});

describe("Gỡ dịch vụ SẠCH → vào thùng rác, khôi phục được", () => {
  it("gỡ thành công", async () => {
    const r = await api("DELETE", `/api/bookings/${parentId}/remove-child/${childPlain}`);
    expect(r.status, r.text).toBe(200);
  });

  it("đơn KHÔNG bị xoá cứng — nằm trong thùng rác, có lý do", async () => {
    const b = await pool.query(
      `SELECT deleted_at, deleted_by, delete_reason FROM bookings WHERE id = $1`, [childPlain]);
    expect(b.rows.length, "đơn bị xoá cứng, không khôi phục được").toBe(1);
    const row = b.rows[0] as { deleted_at: unknown; deleted_by: number | null; delete_reason: string | null };
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).not.toBeNull();
    expect(String(row.delete_reason)).toContain("Gỡ khỏi hợp đồng");
  });

  it("có ghi lịch sử trên hợp đồng cha", async () => {
    const l = await pool.query(
      `SELECT field_changed FROM booking_change_log WHERE booking_id = $1 AND field_changed = 'remove_child'`,
      [parentId]);
    expect(l.rows.length).toBeGreaterThan(0);
  });

  it("tổng hợp đồng cha tính lại, KHÔNG còn ôm tiền dịch vụ đã gỡ", async () => {
    const p = await pool.query(`SELECT total_amount::text t FROM bookings WHERE id = $1`, [parentId]);
    // còn lại 2 con còn hiệu lực (paid + signed) × 1.000.000
    expect((p.rows[0] as { t: string }).t).toBe("2000000.00");
  });
});
