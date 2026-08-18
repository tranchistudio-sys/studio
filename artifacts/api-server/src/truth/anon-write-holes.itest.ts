/**
 * TRUTH TEST — 3 lỗ GHI ẩn danh còn lại (siết 20/07, tiếp PR #120/#121).
 *
 *  1. POST   /contracts/:id/mark-signed  → ĐÃ XOÁ HẲN (dead code, không caller nào).
 *  2. DELETE /staff-rates/clear          → admin-only (đúng như comment vốn hứa).
 *  3. POST   /payments/sync-deposits     → admin-only (khớp UI: nút chỉ hiện cho admin).
 *
 * VỀ DỮ LIỆU — đọc kỹ trước khi sửa file này:
 * Hai endpoint (2) và (3) là thao tác HÀNG LOẠT trên dữ liệu thật: /clear xoá sạch
 * bảng đơn giá nhân sự (không soft-delete, không audit, mất là mất), sync-deposits
 * tạo/sửa phiếu cọc + ghi lại paid_amount trên MỌI đơn còn sống. Vì vậy test này
 * CỐ Ý KHÔNG gọi chúng bằng token admin — không có cách nào "qua cổng mà không
 * chạy". Ta chỉ chứng minh guard chặn đúng (401/403) và dữ liệu KHÔNG suy suyển.
 * Đường thuận (admin gọi được) đã có bằng chứng khác: UI hiện đang gọi chúng bằng
 * token admin và chạy bình thường.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { pool } from "@workspace/db";
import type { Server } from "node:http";

// Chốt secret ở top-level, TRƯỚC lệnh import ĐỘNG routes/* trong beforeAll.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "truth-test-secret";

function mintToken(staffId: number, expSeconds = 3600): string {
  const secret = process.env.SESSION_SECRET as string;
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const b = Buffer.from(JSON.stringify({ id: staffId, exp: Math.floor(Date.now() / 1000) + expSeconds })).toString("base64url");
  return `${h}.${b}.${createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url")}`;
}

let srv: Server;
let base: string;
let adminId: number;
let staffId: number | null = null;
let contractId: number | null = null;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Cần DATABASE_URL (DB local) — chạy qua `pnpm truth`.");

  const express = (await import("express")).default;
  const { default: contractsRouter } = await import("../routes/contracts");
  const { default: paymentsRouter } = await import("../routes/payments");
  const { default: staffRatesRouter } = await import("../routes/staff-rates");
  const app = express();
  app.use(express.json());
  app.use("/api", contractsRouter);
  app.use("/api", paymentsRouter);
  app.use("/api", staffRatesRouter);
  srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  const a = await pool.query(`SELECT id FROM staff WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1`);
  adminId = (a.rows[0] as { id: number }).id;
  const s = await pool.query(`SELECT id FROM staff WHERE role <> 'admin' AND is_active = 1 ORDER BY id LIMIT 1`);
  staffId = s.rows.length ? (s.rows[0] as { id: number }).id : null;
  const c = await pool.query(`SELECT id FROM contracts ORDER BY id DESC LIMIT 1`);
  contractId = c.rows.length ? (c.rows[0] as { id: number }).id : null;
});

afterAll(async () => { await new Promise<void>(r => srv?.close(() => r())); });

async function send(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

describe("POST /contracts/:id/mark-signed — đã xoá hẳn", () => {
  it("route không còn tồn tại (404), kể cả khi có token admin", async () => {
    if (contractId == null) { console.log("  (DB local chưa có hợp đồng — bỏ qua)"); return; }
    expect((await send("POST", `/api/contracts/${contractId}/mark-signed`, { customerName: "Kẻ giả mạo" })).status).toBe(404);
    expect((await send("POST", `/api/contracts/${contractId}/mark-signed`, {}, mintToken(adminId))).status).toBe(404);
  });

  it("hợp đồng KHÔNG bị ký giả: chữ ký/trạng thái/tên khách còn nguyên", async () => {
    if (contractId == null) return;
    const before = await pool.query(
      `SELECT c.status, c.signed_at, c.signer_name, c.signature_image_url, cu.name AS cus_name, cu.phone AS cus_phone
       FROM contracts c LEFT JOIN customers cu ON cu.id = c.customer_id WHERE c.id = $1`, [contractId]);
    await send("POST", `/api/contracts/${contractId}/mark-signed`,
      { customerName: "Kẻ giả mạo", customerPhone: "0900000000", signedAt: "2020-01-01" });
    const after = await pool.query(
      `SELECT c.status, c.signed_at, c.signer_name, c.signature_image_url, cu.name AS cus_name, cu.phone AS cus_phone
       FROM contracts c LEFT JOIN customers cu ON cu.id = c.customer_id WHERE c.id = $1`, [contractId]);
    expect(after.rows[0], "hợp đồng/khách bị sửa dù route đã xoá").toEqual(before.rows[0]);
  });

  it("đường ký THẬT của khách vẫn còn (không xoá nhầm)", async () => {
    const c = await pool.query(`SELECT public_token FROM contracts WHERE public_token IS NOT NULL LIMIT 1`);
    if (c.rows.length === 0) { console.log("  (DB local chưa có hợp đồng có link public — bỏ qua)"); return; }
    const token = (c.rows[0] as { public_token: string }).public_token;
    // GET công khai vẫn mở (không cần đăng nhập) → đường ký theo token còn nguyên.
    const r = await fetch(`${base}/api/public/contracts/by-token/${token}`);
    expect(r.status).toBe(200);
    // Và POST ký theo token vẫn được ĐỊNH TUYẾN (không 404); thiếu dữ liệu nên 400/409,
    // KHÔNG gửi chữ ký thật để không ký nhầm hợp đồng của khách.
    const sign = await send("POST", `/api/public/contracts/by-token/${token}/sign`, {});
    expect(sign.status, "đường ký công khai bị xoá nhầm").not.toBe(404);
  });
});

describe("DELETE /staff-rates/clear — chỉ admin (bảng đơn giá nhân sự)", () => {
  it("không token → 401 và bảng còn nguyên", async () => {
    const before = await pool.query(`SELECT COUNT(*)::int n FROM staff_rate_prices`);
    expect((await send("DELETE", "/api/staff-rates/clear")).status).toBe(401);
    const after = await pool.query(`SELECT COUNT(*)::int n FROM staff_rate_prices`);
    expect(after.rows[0], "bảng đơn giá bị xoá dù chưa đăng nhập").toEqual(before.rows[0]);
  });

  it("token rác / hết hạn → 401", async () => {
    expect((await send("DELETE", "/api/staff-rates/clear", undefined, "rac")).status).toBe(401);
    expect((await send("DELETE", "/api/staff-rates/clear", undefined, mintToken(adminId, -60))).status).toBe(401);
  });

  it("NHÂN VIÊN thường → 403 và bảng còn nguyên (không chỉ 401)", async () => {
    if (staffId == null) { console.log("  (DB local không có staff non-admin — bỏ qua)"); return; }
    const before = await pool.query(`SELECT COUNT(*)::int n FROM staff_rate_prices`);
    expect((await send("DELETE", "/api/staff-rates/clear", undefined, mintToken(staffId))).status).toBe(403);
    const after = await pool.query(`SELECT COUNT(*)::int n FROM staff_rate_prices`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("phản hồi 401/403 không rò dữ liệu bảng giá", async () => {
    const r = await send("DELETE", "/api/staff-rates/clear");
    expect(r.text).not.toContain("rate");
    expect(r.text).not.toContain("staffId");
  });
});

describe("POST /payments/sync-deposits — chỉ admin (ghi hàng loạt tiền)", () => {
  it("không token → 401 và KHÔNG tạo phiếu thu nào", async () => {
    const before = await pool.query(`SELECT COUNT(*)::int n FROM payments`);
    expect((await send("POST", "/api/payments/sync-deposits")).status).toBe(401);
    const after = await pool.query(`SELECT COUNT(*)::int n FROM payments`);
    expect(after.rows[0], "phiếu thu bị tạo dù chưa đăng nhập").toEqual(before.rows[0]);
  });

  it("token rác / hết hạn → 401", async () => {
    expect((await send("POST", "/api/payments/sync-deposits", undefined, "rac")).status).toBe(401);
    expect((await send("POST", "/api/payments/sync-deposits", undefined, mintToken(adminId, -60))).status).toBe(401);
  });

  it("NHÂN VIÊN thường → 403 và KHÔNG đụng tiền", async () => {
    if (staffId == null) { console.log("  (DB local không có staff non-admin — bỏ qua)"); return; }
    const before = await pool.query(`SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::text s FROM payments`);
    expect((await send("POST", "/api/payments/sync-deposits", undefined, mintToken(staffId))).status).toBe(403);
    const after = await pool.query(`SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::text s FROM payments`);
    expect(after.rows[0], "tiền bị đụng dù không phải admin").toEqual(before.rows[0]);
  });

  it("guard chạy TRƯỚC vòng lặp ghi: paid_amount của mọi đơn không đổi", async () => {
    const sql = `SELECT COALESCE(SUM(paid_amount),0)::text s, COUNT(*)::int n FROM bookings WHERE deleted_at IS NULL`;
    const before = await pool.query(sql);
    await send("POST", "/api/payments/sync-deposits");
    if (staffId != null) await send("POST", "/api/payments/sync-deposits", undefined, mintToken(staffId));
    const after = await pool.query(sql);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
