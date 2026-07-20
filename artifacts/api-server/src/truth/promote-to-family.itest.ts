/**
 * TRUTH TEST — khách cũ quay lại book thêm dịch vụ (20/07).
 *
 * Nghiệp vụ: mở đơn cũ 1 dịch vụ → "+ Thêm dịch vụ" → thêm được DV2, DV3, DV4…
 * Backend tự nâng đơn lẻ thành hợp đồng nhiều dịch vụ, KHÔNG bắt admin biết
 * cha/con. Trước đây FE khoá nút này (chữa cháy sau sự cố DH0191).
 *
 * BẤT BIẾN QUAN TRỌNG NHẤT: nâng cấp cấu trúc KHÔNG được làm đổi một đồng nào.
 * Test dựng gia đình tổng hợp trên DB local, chụp mọi con số tiền TRƯỚC và SAU
 * khi nâng cấp rồi so từng đồng; sau đó thêm DV2/DV3/DV4 và kiểm tổng tăng đúng.
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
let customerId: number;
let bookingId: number;          // đơn lẻ ban đầu
let creatorId: number;          // nhân sự đã chốt đơn gốc (khác người bấm nút)
let parentId: number | null = null;
const createdBookingIds: number[] = [];
const createdPaymentIds: number[] = [];
const CODE = `ITEST-PROMOTE-${Date.now()}`;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
}

/** Mọi con số tiền của GIA ĐÌNH, đọc thẳng DB — không qua cache/engine. */
async function familyMoney(rootId: number) {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(b.total_amount::numeric) FILTER (WHERE b.is_parent_contract = false), 0)::text AS children_total,
       COALESCE(MAX(b.total_amount::numeric) FILTER (WHERE b.is_parent_contract = true), 0)::text  AS parent_total,
       COALESCE(MAX(b.deposit_amount::numeric) FILTER (WHERE b.is_parent_contract = true), 0)::text AS parent_deposit,
       COALESCE(MAX(b.discount_amount::numeric) FILTER (WHERE b.is_parent_contract = true), 0)::text AS parent_discount
     FROM bookings b
     WHERE COALESCE(b.parent_id, b.id) = $1 AND b.deleted_at IS NULL`, [rootId]);
  const p = await pool.query(
    `SELECT COALESCE(SUM(p.amount::numeric),0)::text AS paid, COUNT(*)::int AS n
     FROM payments p JOIN bookings b ON b.id = p.booking_id
     WHERE COALESCE(b.parent_id, b.id) = $1`, [rootId]);
  return { ...r.rows[0], ...p.rows[0] } as Record<string, unknown>;
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
  const c = await pool.query(`SELECT id FROM customers ORDER BY id DESC LIMIT 1`);
  customerId = (c.rows[0] as { id: number }).id;
  // Người tạo đơn = một nhân sự KHÁC người bấm nút, để bắt được lỗi "hoa hồng sale
  // đổi chủ" (cha nhận created_by_staff_id của người vừa bấm thay vì người chốt đơn).
  const other = await pool.query(
    `SELECT id FROM staff WHERE is_active = 1 AND id <> $1 ORDER BY id LIMIT 1`,
    [(a.rows[0] as { id: number }).id]);
  creatorId = other.rows.length ? (other.rows[0] as { id: number }).id : (a.rows[0] as { id: number }).id;

  // Đơn LẺ ban đầu: 5.000.000, cọc 2.000.000 (có phiếu thu thật).
  const b = await pool.query(
    `INSERT INTO bookings (order_code, customer_id, shoot_date, shoot_time, service_category, package_type,
       total_amount, deposit_amount, discount_amount, paid_amount, items, surcharges, deductions,
       assigned_staff, is_parent_contract, status, created_by_staff_id)
     VALUES ($1,$2,'2030-09-01','08:00','wedding','Gói A', '5000000','2000000','500000','2000000',
       '[{"name":"Gói A","price":5000000}]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,false,'confirmed',$3)
     RETURNING id`, [CODE, customerId, creatorId]);
  bookingId = (b.rows[0] as { id: number }).id;
  createdBookingIds.push(bookingId);

  const pay = await pool.query(
    `INSERT INTO payments (booking_id, amount, payment_method, payment_type, notes, paid_at)
     VALUES ($1,'2000000','cash','deposit','itest cọc', NOW()) RETURNING id`, [bookingId]);
  createdPaymentIds.push((pay.rows[0] as { id: number }).id);
});

afterAll(async () => {
  if (createdPaymentIds.length) await pool.query(`DELETE FROM payments WHERE id = ANY($1::int[])`, [createdPaymentIds]);
  await pool.query(`DELETE FROM payments WHERE booking_id = ANY($1::int[])`, [createdBookingIds]);
  if (parentId) {
    const kids = await pool.query(`SELECT id FROM bookings WHERE parent_id = $1`, [parentId]);
    const ids = (kids.rows as { id: number }[]).map(k => k.id);
    if (ids.length) await pool.query(`DELETE FROM payments WHERE booking_id = ANY($1::int[])`, [ids]);
    await pool.query(`DELETE FROM bookings WHERE parent_id = $1`, [parentId]);
    await pool.query(`DELETE FROM bookings WHERE id = $1`, [parentId]);
  }
  await pool.query(`DELETE FROM bookings WHERE id = ANY($1::int[])`, [createdBookingIds]);
  await new Promise<void>(r => srv?.close(() => r()));
});

describe("A. Đơn 1 dịch vụ → thêm dịch vụ thứ 2", () => {
  it("nâng cấp KHÔNG làm đổi một đồng nào (tổng, cọc, đã thu, số phiếu)", async () => {
    const before = await familyMoney(bookingId);

    const r = await api("POST", `/api/bookings/${bookingId}/promote-to-family`);
    expect(r.status, r.text).toBe(200);
    expect(r.json.alreadyFamily).toBe(false);
    parentId = r.json.parentId as number;
    expect(r.json.childId).toBe(bookingId);

    const after = await familyMoney(parentId);
    expect(after.children_total, "tổng dịch vụ đổi sau khi nâng cấp").toBe(before.children_total);
    expect(after.parent_total, "tổng hợp đồng đổi").toBe(before.children_total);
    expect(after.parent_deposit, "cọc đổi").toBe("2000000.00");
    expect(after.paid, "đã thu đổi").toBe(before.paid);
    expect(after.n, "số phiếu thu đổi (duplicate hoặc mất)").toBe(before.n);
  });

  it("BLOCKER cũ: GIẢM GIÁ không được biến mất khỏi engine tiền", async () => {
    // Engine chỉ tính trên DÒNG DỊCH VỤ (bỏ qua hàng cha) — xem family-allocation.itest.
    // Nếu promote dời hẳn giảm giá lên cha thì net của gia đình nhảy lên đúng số đã
    // giảm → khách bỗng nợ thêm 500k và doanh thu tháng cũng phồng lên bấy nhiêu.
    const net = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(0, b.total_amount::numeric - COALESCE(b.discount_amount,0)::numeric)),0)::text AS net
       FROM bookings b
       WHERE COALESCE(b.parent_id, b.id) = $1 AND b.deleted_at IS NULL AND b.is_parent_contract = false`,
      [parentId]);
    expect((net.rows[0] as { net: string }).net, "engine mất giảm giá sau khi nâng cấp").toBe("4500000.00");

    // Hợp đồng + danh sách đơn lại đọc giảm giá từ CHA → cha cũng phải có.
    const p = await pool.query(`SELECT discount_amount::text d FROM bookings WHERE id = $1`, [parentId]);
    expect((p.rows[0] as { d: string }).d, "hợp đồng mất dòng giảm giá").toBe("500000.00");
  });

  it("giữ nguyên NGƯỜI TẠO đơn (hoa hồng sale không đổi chủ)", async () => {
    const c = await pool.query(`SELECT created_by_staff_id c FROM bookings WHERE id = $1`, [bookingId]);
    const p = await pool.query(`SELECT created_by_staff_id c FROM bookings WHERE id = $1`, [parentId]);
    expect((c.rows[0] as { c: number | null }).c, "đơn gốc mất người tạo").toBe(creatorId);
    expect((p.rows[0] as { c: number | null }).c, "hoa hồng sale chuyển sang người bấm nút").toBe(creatorId);
  });

  it("dịch vụ cũ còn nguyên: id, ngày, nội dung gói, tiền của nó", async () => {
    const c = await pool.query(
      `SELECT id, parent_id, order_code, total_amount::text t, deposit_amount::text d, paid_amount::text p,
              items, shoot_date::text sd FROM bookings WHERE id = $1`, [bookingId]);
    const row = c.rows[0] as Record<string, unknown>;
    expect(row.parent_id).toBe(parentId);
    expect(row.t).toBe("5000000.00");           // giá dịch vụ giữ nguyên
    expect(row.d).toBe("0.00");                 // cọc dời lên cha (đúng hình dạng gốc)
    expect(row.p).toBe("0.00");
    expect(row.order_code).toBe(`${CODE}-1`);
    expect(String(row.sd)).toContain("2030-09-01");
    expect(JSON.stringify(row.items)).toContain("Gói A");
  });

  it("phiếu thu chuyển về cha (nếu để lại con thì mọi màn hình hiện cọc = 0)", async () => {
    const p = await pool.query(`SELECT booking_id FROM payments WHERE id = ANY($1::int[])`, [createdPaymentIds]);
    expect((p.rows[0] as { booking_id: number }).booking_id).toBe(parentId);
  });

  it("thêm DV2 7.000.000 → tổng hợp đồng = 12.000.000, cọc/đã thu KHÔNG đổi", async () => {
    const before = await familyMoney(parentId!);
    const r = await api("POST", `/api/bookings/${parentId}/add-child`, {
      serviceLabel: "Dịch vụ 2", shootDate: "2030-10-01", shootTime: "08:00",
      items: [{ name: "Gói B", price: 7_000_000 }], totalAmount: 7_000_000,
    });
    expect(r.status, r.text).toBe(201);
    const after = await familyMoney(parentId!);
    expect(after.children_total).toBe("12000000.00");
    expect(after.parent_total).toBe("12000000.00");
    expect(after.paid, "thêm dịch vụ làm đổi tiền đã thu").toBe(before.paid);
    expect(after.n, "thêm dịch vụ đẻ ra phiếu thu lạ").toBe(before.n);
  });
});

describe("A2. CHỐT CHẶN: đơn con không bao giờ đẻ thêm phiếu cọc", () => {
  it("PUT cọc lên DỊCH VỤ CON bị bỏ qua — không nhân đôi tiền khách", async () => {
    // Ca thật: rớt mạng ngay sau khi nâng cấp, form còn trỏ hàng cũ (nay đã là con)
    // rồi bấm Lưu. Trước khi có chốt này, máy cọc thấy con không còn phiếu nào (đã
    // dời lên cha) nên tạo THÊM một phiếu = khách đưa 1 lần mà sổ ghi 2 lần.
    const before = await familyMoney(parentId!);
    const r = await api("PUT", `/api/bookings/${bookingId}`, { depositAmount: 2_000_000 });
    expect(r.status, r.text).toBe(200);
    const after = await familyMoney(parentId!);
    expect(after.n, "đẻ thêm phiếu thu trên đơn con").toBe(before.n);
    expect(after.paid, "tiền đã thu bị nhân đôi").toBe(before.paid);

    const child = await pool.query(`SELECT deposit_amount::text d FROM bookings WHERE id = $1`, [bookingId]);
    expect((child.rows[0] as { d: string }).d, "cọc bị ghi xuống đơn con").toBe("0.00");
  });
});

describe("B. Đơn đã nhiều dịch vụ → thêm tiếp bình thường", () => {
  it("thêm DV3 9.000.000 → tổng 21.000.000", async () => {
    const r = await api("POST", `/api/bookings/${parentId}/add-child`, {
      serviceLabel: "Dịch vụ 3", shootDate: "2030-11-01", shootTime: "08:00",
      items: [{ name: "Gói C", price: 9_000_000 }], totalAmount: 9_000_000,
    });
    expect(r.status, r.text).toBe(201);
    expect((await familyMoney(parentId!)).children_total).toBe("21000000.00");
  });

  it("thêm DV4 3.000.000 → tổng 24.000.000, mỗi dịch vụ giữ ngày riêng", async () => {
    const r = await api("POST", `/api/bookings/${parentId}/add-child`, {
      serviceLabel: "Dịch vụ 4", shootDate: "2030-12-01", shootTime: "14:00",
      items: [{ name: "Gói D", price: 3_000_000 }], totalAmount: 3_000_000,
    });
    expect(r.status, r.text).toBe(201);
    expect((await familyMoney(parentId!)).children_total).toBe("24000000.00");

    const kids = await pool.query(
      `SELECT order_code, shoot_date::text sd, shoot_time::text st, total_amount::text t
       FROM bookings WHERE parent_id = $1 ORDER BY id`, [parentId]);
    const rows = kids.rows as { order_code: string; sd: string; st: string; t: string }[];
    expect(rows).toHaveLength(4);
    expect(rows.map(r => r.t)).toEqual(["5000000.00", "7000000.00", "9000000.00", "3000000.00"]);
    // Ngày riêng từng dịch vụ, không bị đồng bộ về một ngày.
    expect(new Set(rows.map(r => r.sd.slice(0, 10))).size).toBe(4);
    expect(rows[3].st.slice(0, 5)).toBe("14:00");
    // Mã đơn theo quy ước cha-con, không trùng nhau.
    expect(new Set(rows.map(r => r.order_code)).size).toBe(4);
  });

  it("KHÔNG duplicate: đúng 1 cha + 4 con, không đẻ đơn lẻ mồ côi", async () => {
    const all = await pool.query(
      `SELECT COUNT(*)::int n FROM bookings
       WHERE COALESCE(parent_id, id) = $1 AND deleted_at IS NULL`, [parentId]);
    expect((all.rows[0] as { n: number }).n).toBe(5);
  });
});

describe("C. Gọi lại nhiều lần / trạng thái đã là gia đình", () => {
  it("gọi promote trên đơn ĐÃ là cha → không làm gì, trả đúng id cha (idempotent)", async () => {
    const before = await familyMoney(parentId!);
    const r = await api("POST", `/api/bookings/${parentId}/promote-to-family`);
    expect(r.status).toBe(200);
    expect(r.json.alreadyFamily).toBe(true);
    expect(r.json.parentId).toBe(parentId);
    expect(await familyMoney(parentId!)).toEqual(before);
  });

  it("gọi promote trên đơn ĐÃ là con → trả id cha, không tạo cha thứ hai", async () => {
    const before = await familyMoney(parentId!);
    const r = await api("POST", `/api/bookings/${bookingId}/promote-to-family`);
    expect(r.status).toBe(200);
    expect(r.json.alreadyFamily).toBe(true);
    expect(r.json.parentId).toBe(parentId);
    expect(await familyMoney(parentId!)).toEqual(before);
  });

  it("đơn không tồn tại → 404, không tạo rác", async () => {
    expect((await api("POST", "/api/bookings/999999999/promote-to-family")).status).toBe(404);
  });

  it("chưa đăng nhập → 401 (guard chạy trước khi đụng DB)", async () => {
    const res = await fetch(`${base}/api/bookings/${bookingId}/promote-to-family`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});
