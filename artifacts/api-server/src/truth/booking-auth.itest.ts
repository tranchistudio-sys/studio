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
 * Về dữ liệu: các request GHI trong file này đều là request PHẢI bị từ chối (401)
 * hoặc dùng id không tồn tại, nên không tạo/sửa/xoá hàng thật nào. Nếu một guard
 * hỏng thì test sẽ FAIL — đó chính là điều nó canh.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { pool } from "@workspace/db";
import type { Server } from "node:http";

// Chốt secret ở top-level, TRƯỚC lệnh import ĐỘNG routes/* trong beforeAll (auth.ts
// resolve JWT_SECRET lúc load module, nên thứ tự này mới ăn).
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
  const { default: paymentsRouter } = await import("../routes/payments");
  const app = express();
  app.use(express.json());
  app.use("/api", bookingsRouter);
  app.use("/api", contractsRouter);
  app.use("/api", paymentsRouter);
  srv = await new Promise<Server>(resolve => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  // Ưu tiên đơn CON của một hợp đồng gộp: chỉ đường đó mới kích hoạt thao tác ghi
  // SỚM của handler PUT (cập nhật cột nhắc thuê đồ trên đơn CHA). Chọn đơn lẻ thì
  // test "chặn trước khi ghi" sẽ xanh giả — guard đặt sai chỗ vẫn không bị bắt.
  const b = await pool.query(`
    SELECT id FROM bookings WHERE deleted_at IS NULL AND parent_id IS NOT NULL
    ORDER BY id DESC LIMIT 1`);
  const bAny = b.rows.length ? b : await pool.query(
    `SELECT id FROM bookings WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`);
  bookingId = (bAny.rows[0] as { id: number }).id;

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

/**
 * GHI nguy hiểm hơn ĐỌC: người lạ sửa được tiền/trạng thái đơn, xoá cứng hợp đồng.
 * Các test dưới chỉ gửi request KHÔNG hợp lệ (401) nên KHÔNG ghi gì vào DB.
 */
async function send(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

describe("Chặn GHI dữ liệu khi chưa đăng nhập", () => {
  it("POST /api/bookings (tạo đơn) không token → 401", async () => {
    const r = await send("POST", "/api/bookings", { customerId: 1, shootDate: "2030-01-01", totalAmount: 1 });
    expect(r.status).toBe(401);
  });

  it("PUT /api/bookings/:id (sửa tiền/trạng thái) không token → 401", async () => {
    const r = await send("PUT", `/api/bookings/${bookingId}`, { totalAmount: 1 });
    expect(r.status).toBe(401);
  });

  it("PUT /api/bookings/:id token RÁC / HẾT HẠN → 401", async () => {
    expect((await send("PUT", `/api/bookings/${bookingId}`, { totalAmount: 1 }, "rac")).status).toBe(401);
    expect((await send("PUT", `/api/bookings/${bookingId}`, { totalAmount: 1 }, mintToken(adminId, -60))).status).toBe(401);
  });

  it("PUT bị chặn TRƯỚC MỌI thao tác ghi — cả gia đình hợp đồng không suy suyển", async () => {
    // Chụp TOÀN BỘ hàng của cả gia đình (cha + các con), không chỉ total_amount:
    // thao tác GHI ĐẦU TIÊN của handler PUT đụng vào cột nhắc thuê đồ của đơn CHA,
    // nên nếu chỉ so total_amount của đơn con thì guard có bị đặt sai chỗ vẫn "pass".
    const familySql = `
      SELECT b.* FROM bookings b
      WHERE COALESCE(b.parent_id, b.id) = (SELECT COALESCE(parent_id, id) FROM bookings WHERE id = $1)
      ORDER BY b.id`;
    const before = await pool.query(familySql, [bookingId]);
    expect(before.rows.length).toBeGreaterThan(0);

    await send("PUT", `/api/bookings/${bookingId}`, { totalAmount: 123, dressWarnPickupDays: 9 });

    const after = await pool.query(familySql, [bookingId]);
    expect(after.rows, "request ẩn danh đã ghi được vào DB").toEqual(before.rows);
  });

  it("PATCH /api/payments/:id không token → 401", async () => {
    const p = await pool.query(`SELECT id FROM payments ORDER BY id DESC LIMIT 1`);
    if (!p.rows.length) { console.log("  (DB local chưa có phiếu thu — bỏ qua)"); return; }
    const id = (p.rows[0] as { id: number }).id;
    expect((await send("PATCH", `/api/payments/${id}`, { proofImageUrl: "x" })).status).toBe(401);
  });

  it("DELETE /api/contracts/:id không token → 401 và hợp đồng KHÔNG bị xoá", async () => {
    const c = await pool.query(`SELECT id FROM contracts ORDER BY id DESC LIMIT 1`);
    if (!c.rows.length) { console.log("  (DB local chưa có hợp đồng — bỏ qua)"); return; }
    const id = (c.rows[0] as { id: number }).id;
    expect((await send("DELETE", `/api/contracts/${id}`)).status).toBe(401);
    const still = await pool.query(`SELECT id FROM contracts WHERE id = $1`, [id]);
    expect(still.rows.length, "hợp đồng bị xoá dù chưa đăng nhập").toBe(1);
  });

  it("ĐÚNG QUYỀN thì qua được cổng: 4 route ghi KHÔNG trả 401 khi có token", async () => {
    // Cố ý gửi dữ liệu không hợp lệ / id không tồn tại: đủ để chứng minh guard cho
    // qua (không 401), mà KHÔNG ghi gì thật vào DB.
    const tok = mintToken(adminId);
    const post = await send("POST", "/api/bookings", {}, tok);
    expect(post.status, "POST /bookings chặn nhầm người đã đăng nhập").not.toBe(401);

    const put = await send("PUT", "/api/bookings/999999999", { totalAmount: 1 }, tok);
    expect(put.status, "PUT /bookings/:id chặn nhầm người đã đăng nhập").not.toBe(401);

    const patch = await send("PATCH", "/api/payments/999999999", {}, tok);
    expect(patch.status, "PATCH /payments/:id chặn nhầm người đã đăng nhập").not.toBe(401);

    const del = await send("DELETE", "/api/contracts/999999999", undefined, tok);
    expect(del.status, "DELETE /contracts/:id chặn nhầm người đã đăng nhập").not.toBe(401);
  });

  it("NHÂN VIÊN (không phải admin) vẫn đính được ảnh chứng từ — không siết nhầm thành admin-only", async () => {
    if (staffId == null) { console.log("  (DB local không có staff non-admin — bỏ qua)"); return; }
    const r = await send("PATCH", "/api/payments/999999999", {}, mintToken(staffId));
    expect(r.status).not.toBe(401);
    expect(r.status, "PATCH bị siết thành admin-only, nhân viên thu tiền hết đính được ảnh").not.toBe(403);
  });

  it("phản hồi 401 của các route GHI không rò PII", async () => {
    const r = await send("PUT", `/api/bookings/${bookingId}`, { totalAmount: 1 });
    for (const k of PII_KEYS) expect(r.text).not.toContain(k);
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
