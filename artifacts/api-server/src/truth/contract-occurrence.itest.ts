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
      expect(inChips, `ngày phụ ${o.d} phải có trong chip đầu hợp đồng`).toBe(true);
      expect(inSchedule, `ngày phụ ${o.d} phải có trong mục Lịch thực hiện`).toBe(true);
    }
    console.log(`  ✓ hợp đồng #${contract_id} / booking #${booking_id}: ${occ_count} ngày phụ hiện đủ ở chip + Lịch thực hiện`);
  });
});
