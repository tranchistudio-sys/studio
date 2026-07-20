/**
 * TRUTH TEST — Hợp đồng phải hiện ĐỦ ngày thực hiện (chip Ngày 1/Ngày 2… đầu trang).
 *
 * Yêu cầu chủ 20/07: booking có N ngày thì ĐẦU hợp đồng phải thấy đủ N ngày,
 * không bắt người xem cuộn xuống mục "Lịch thực hiện" mới hiểu.
 *
 * READ-ONLY trên DB THẬT: tìm một hợp đồng CHƯA KÝ có dịch vụ mang ngày phụ →
 * buildContractPayload phải trả services[].occurrences đủ số ngày, đồng thời
 * schedule (mục Lịch thực hiện) chứa đúng các ngày đó — hai chỗ hiển thị
 * không được lệch nhau.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { pool } from "@workspace/db";
import { buildContractPayload } from "../lib/contractPayload";

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("Truth test cần DATABASE_URL (DB local snapshot) — chạy qua `pnpm truth`.");
  }
});

describe("Chip ngày đầu hợp đồng ↔ booking_occurrences ↔ Lịch thực hiện", () => {
  it("services[].occurrences khớp DB và nằm đủ trong schedule", async () => {
    // Hợp đồng CHƯA KÝ (render live) có ít nhất một dịch vụ mang ngày phụ.
    const r = await pool.query(`
      SELECT c.id AS contract_id, o.booking_id, COUNT(o.id)::int AS occ_count
      FROM contracts c
      JOIN bookings cb ON cb.id = c.booking_id
      JOIN bookings b ON COALESCE(b.parent_id, b.id) = COALESCE(cb.parent_id, cb.id)
      JOIN booking_occurrences o ON o.booking_id = b.id
      WHERE COALESCE(c.status, '') != 'signed' AND b.deleted_at IS NULL
      GROUP BY c.id, o.booking_id
      ORDER BY c.id DESC LIMIT 1
    `);
    if (r.rows.length === 0) {
      console.log("  (DB không có hợp đồng chưa ký nào mang ngày phụ — bỏ qua; unit test contractPayload.test.ts vẫn phủ logic)");
      return;
    }
    const { contract_id, booking_id, occ_count } = r.rows[0] as {
      contract_id: number; booking_id: number; occ_count: number;
    };

    const occRows = await pool.query(
      `SELECT shoot_date::text AS d, shoot_time::text AS t FROM booking_occurrences WHERE booking_id = $1 ORDER BY sort_order, shoot_date, id`,
      [booking_id],
    );

    const payload = await buildContractPayload(contract_id, "internal");
    const svc = payload.services.find(s => s.bookingId === booking_id);
    expect(svc, `hợp đồng #${contract_id} phải chứa dịch vụ booking #${booking_id}`).toBeTruthy();
    expect(svc!.occurrences.length, "chip đầu hợp đồng phải đủ số ngày phụ").toBe(occ_count);

    for (const o of occRows.rows as Array<{ d: string; t: string | null }>) {
      const inChips = svc!.occurrences.some(x => x.date.slice(0, 10) === o.d.slice(0, 10));
      const inSchedule = payload.schedule.some(s => String(s.date).slice(0, 10) === o.d.slice(0, 10));
      // Dòng dịch vụ là nơi DUY NHẤT còn vẽ ngày (mục "Lịch thực hiện" riêng đã bỏ
      // 20/07) → chip phải đủ; schedule vẫn phải khớp vì nó là nguồn đóng băng bản ký.
      expect(inChips, `ngày phụ ${o.d} phải hiện ngay trên dòng dịch vụ`).toBe(true);
      expect(inSchedule, `ngày phụ ${o.d} phải có trong schedule (nguồn đóng băng bản ký)`).toBe(true);
    }
    console.log(`  ✓ hợp đồng #${contract_id} / booking #${booking_id}: ${occ_count} ngày phụ hiện đủ trên dòng dịch vụ`);
  });

  it("bản ĐÃ KÝ (kể cả snapshot cũ chưa lưu occurrences) vẫn hiện đủ ngày trên dòng dịch vụ", async () => {
    // Hợp đồng ĐÃ KÝ có dịch vụ mang ngày phụ — đường render đóng băng.
    const r = await pool.query(`
      SELECT c.id AS contract_id, o.booking_id, COUNT(o.id)::int AS occ_count
      FROM contracts c
      JOIN bookings cb ON cb.id = c.booking_id
      JOIN bookings b ON COALESCE(b.parent_id, b.id) = COALESCE(cb.parent_id, cb.id)
      JOIN booking_occurrences o ON o.booking_id = b.id
      WHERE COALESCE(c.status, '') = 'signed' AND b.deleted_at IS NULL
      GROUP BY c.id, o.booking_id
      ORDER BY c.id DESC LIMIT 1
    `);
    if (r.rows.length === 0) {
      console.log("  (DB chưa có hợp đồng ĐÃ KÝ nào mang ngày phụ — unit test contractPayload.test.ts phủ logic back-fill)");
      return;
    }
    const { contract_id, booking_id, occ_count } = r.rows[0] as {
      contract_id: number; booking_id: number; occ_count: number;
    };
    const payload = await buildContractPayload(contract_id, "internal");
    const svc = payload.services.find(s => s.bookingId === booking_id);
    expect(svc, `hợp đồng đã ký #${contract_id} phải chứa dịch vụ booking #${booking_id}`).toBeTruthy();
    // Bản ký có thể đóng băng số ngày KHÁC live (ký xong mới thêm ngày) — điều bắt
    // buộc là dòng dịch vụ không được rỗng khi bản ký thực sự có nhiều ngày.
    const scheduleDays = payload.schedule.length;
    if (scheduleDays > payload.services.length) {
      expect(
        payload.services.some(s => s.occurrences.length > 0),
        "bản ký nhiều ngày nhưng KHÔNG dòng dịch vụ nào hiện ngày phụ → khách mất thông tin ngày",
      ).toBe(true);
    }
    console.log(`  ✓ hợp đồng ĐÃ KÝ #${contract_id}: dòng dịch vụ hiện ${svc!.occurrences.length} ngày phụ (live DB có ${occ_count})`);
  });
});
