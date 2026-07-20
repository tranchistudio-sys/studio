/**
 * TRUTH TEST — module Đơn hàng KHÔNG được trả dữ liệu khách cho người chưa đăng nhập.
 *
 * Sự cố 20/07 (xác minh trên prod): GET /api/bookings/250 trả 200 kèm customerName,
 * customerPhone, internalNotes, totalAmount… mà KHÔNG cần token → dò id 1,2,3… là
 * hút sạch danh sách khách của studio.
 *
 * Test chạy router THẬT trên HTTP thật (giống family-allocation.itest.ts), DB local:
 *  - không token / token rác        → 401, body không chứa PII
 *  - token staff / admin hợp lệ     → 200 như cũ
 *  - id KHÔNG tồn tại + không token → vẫn 401 (không lộ đơn có tồn tại hay không)
 *  - link hợp đồng public           → vẫn mở được không cần đăng nhập
 *
 * READ-ONLY: chỉ GET, không ghi gì vào DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { pool } from "@workspace/db";
import type { Server } from "node:http";

// Chốt secret TRƯỚC khi import routes/auth (JWT_SECRET resolve lúc load module).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "truth-test-secret";

function mintToken(staffId: number, expSeconds = 3600): string {
  const secret = process.env.SESSION_SECRET as string;
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const b = Buffer.from(JSON.stringify({ id: staffId, exp: Math.floor(Date.now() / 1000) + expSeconds })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url");
  return `${h}.${b}.${sig}`;
}

let srv: Server;
let base: string;
let bookingId: number;
let adminId: number;
let staffId: number | null = null;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Cần DATABASE_URL (DB local) — chạy qua `pnpm truth`.");

  const express = (await import("express")).default;
  const { default: bookingsRouter } = await import("../routes/bookings");
  const { default: contractsRouter } = await import("../routes/contracts");
  const app = express();
  app.use(express.json());
  app.use("/api", bookingsRouter);
  app.use("/api", contractsRouter);
  srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  const b = await pool.query(`SELECT id FROM bookings WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`);
  bookingId = (b.rows[0] as { id: number }).id;

  const a = await pool.query(`SELECT id FROM staff WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1`);
  adminId = (a.rows[0] as { id: number }).id;

  const s = await pool.query(`SELECT id FROM staff WHERE role <> 'admin' AND is_active = 1 ORDER BY id LIMIT 1`);
  staffId = s.rows.length ? (s.rows[0] as { id: number }).id : null;
});

afterAll(async () => { await new Promise<void>(r => srv?.close(() => r())); });

const PII_KEYS = ["customerName", "customerPhone", "internalNotes", "totalAmount", "paidAmount", "customerId"];

async function get(path: string, token?: string) {
  const res = await fetch(`${base}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

describe("GET /api/bookings/:id — chặn người chưa đăng nhập", () => {
  it("KHÔNG token → 401 và body không rò PII", async () => {
    const r = await get(`/api/bookings/${bookingId}`);
    expect(r.status).toBe(401);
    for (const k of PII_KEYS) expect(r.text).not.toContain(k);
    expect(r.json?.error).toBeTruthy();
  });

  it("token RÁC → 401", async () => {
    const r = await get(`/api/bookings/${bookingId}`, "khong-phai-jwt");
    expect(r.status).toBe(401);
  });

  it("token KÝ SAI (đúng dạng JWT, sai chữ ký) → 401", async () => {
    const real = mintToken(adminId);
    const forged = real.slice(0, real.lastIndexOf(".")) + ".chu-ky-gia";
    const r = await get(`/api/bookings/${bookingId}`, forged);
    expect(r.status).toBe(401);
  });

  it("token HẾT HẠN → 401", async () => {
    const r = await get(`/api/bookings/${bookingId}`, mintToken(adminId, -60));
    expect(r.status).toBe(401);
  });

  it("admin hợp lệ → 200, vẫn trả đủ dữ liệu như trước", async () => {
    const r = await get(`/api/bookings/${bookingId}`, mintToken(adminId));
    expect(r.status).toBe(200);
    expect(r.json?.id).toBe(bookingId);
    expect(r.json).toHaveProperty("customerName");
  });

  it("staff (không phải admin) hợp lệ → 200 (không đổi role model)", async () => {
    if (staffId == null) { console.log("  (DB local không có staff non-admin đang hoạt động — bỏ qua)"); return; }
    const r = await get(`/api/bookings/${bookingId}`, mintToken(staffId));
    expect(r.status).toBe(200);
  });

  it("CHỐNG DÒ ID: id không tồn tại + không token → vẫn 401 y hệt, không lộ 404", async () => {
    const nope = await get(`/api/bookings/999999999`);
    const real = await get(`/api/bookings/${bookingId}`);
    expect(nope.status).toBe(401);
    expect(nope.status).toBe(real.status);
    expect(nope.text).toBe(real.text); // phản hồi giống hệt → không suy ra được gì
  });

  it("id không hợp lệ + không token → 401 trước, không phải 400 (không lộ cách hệ thống parse)", async () => {
    const r = await get(`/api/bookings/abc`);
    expect(r.status).toBe(401);
  });
});

describe("Các endpoint đọc khác của module đơn hàng", () => {
  it("GET /api/bookings (danh sách) không token → 401", async () => {
    const r = await get(`/api/bookings`);
    expect(r.status).toBe(401);
    for (const k of PII_KEYS) expect(r.text).not.toContain(k);
  });

  it("GET /api/bookings?q= (tìm theo tên/SĐT) không token → 401", async () => {
    const r = await get(`/api/bookings?q=nguyen`);
    expect(r.status).toBe(401);
  });

  it("GET /api/bookings danh sách CÓ token → 200 như cũ", async () => {
    const r = await get(`/api/bookings`, mintToken(adminId));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
  });

  it("GET /api/bookings/:id/allocation không token → 401", async () => {
    const r = await get(`/api/bookings/${bookingId}/allocation`);
    expect(r.status).toBe(401);
  });

  it("GET /api/bookings/:id/allocation CÓ token → 200", async () => {
    const r = await get(`/api/bookings/${bookingId}/allocation`, mintToken(adminId));
    expect(r.status).toBe(200);
  });
});

describe("KHÔNG được khoá nhầm link hợp đồng công khai", () => {
  it("GET /api/public/contracts/by-token/:token vẫn mở được KHÔNG cần đăng nhập", async () => {
    const c = await pool.query(`SELECT public_token FROM contracts WHERE public_token IS NOT NULL LIMIT 1`);
    if (c.rows.length === 0) { console.log("  (DB local chưa có hợp đồng nào có link public — bỏ qua)"); return; }
    const token = (c.rows[0] as { public_token: string }).public_token;
    const r = await get(`/api/public/contracts/by-token/${token}`);
    expect(r.status).toBe(200);
    expect(r.json?.services).toBeTruthy();
  });
});
