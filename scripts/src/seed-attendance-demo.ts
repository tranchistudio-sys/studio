/**
 * Seed chấm công demo — chỉ xóa/ghi record có tag [TEST-ATTENDANCE].
 * Chạy: pnpm --filter @workspace/scripts run seed-attendance-demo
 */
import { pool } from "@workspace/db";

const TAG = "[TEST-ATTENDANCE]";
const MONTH = "2026-06";
const STAFF = { hoa: 8, trung: 3, quan: 7 } as const;

/** VN HH:MM → created_at (DB +7h = VN) */
function vnTime(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const utcH = h - 7;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCHours(utcH, m, 0, 0);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

type DayPlan = { date: string; in?: string; out?: string; note?: string };

const hoaDays: DayPlan[] = [
  "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06",
  "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-15",
].map((date) => ({ date, in: "08:30", out: "18:00", note: "đúng giờ" }));

const trungDays: DayPlan[] = [
  { date: "2026-06-01", in: "08:45", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-02", in: "09:15", out: "18:00", note: "trễ nhẹ" },
  { date: "2026-06-03", in: "08:30", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-04", in: "09:45", out: "18:00", note: "trễ vừa" },
  { date: "2026-06-05", in: "08:55", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-06", in: "10:20", out: "18:00", note: "trễ nặng" },
  { date: "2026-06-08", in: "08:20", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-09", in: "09:10", out: "18:00", note: "trễ nhẹ" },
  { date: "2026-06-10", in: "08:40", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-11", in: "09:50", out: "18:00", note: "trễ vừa" },
  { date: "2026-06-12", in: "08:35", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-13", in: "08:25", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-15", in: "09:20", out: "18:00", note: "trễ nhẹ" },
];

const quanDays: DayPlan[] = [
  { date: "2026-06-01", in: "08:40", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-03", in: "08:50", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-06", in: "08:35", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-09", in: "08:45", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-11", in: "08:30", out: "18:00", note: "đúng giờ" },
  { date: "2026-06-13", in: "08:55", out: "18:00", note: "đúng giờ" },
  // 02,05,10,15 = vắng (không log)
];

const quanLeaves = [
  { start: "2026-06-04", end: "2026-06-04", reason: `${TAG} nghỉ phép cá nhân` },
  { start: "2026-06-08", end: "2026-06-08", reason: `${TAG} nghỉ phép` },
  { start: "2026-06-12", end: "2026-06-12", reason: `${TAG} nghỉ phép` },
];

async function insertPunch(staffId: number, type: "check_in" | "check_out", date: string, hhmm: string, note: string) {
  await pool.query(
    `INSERT INTO attendance_logs (staff_id, type, method, notes, created_at)
     VALUES ($1, $2, 'manual', $3, $4::timestamp)`,
    [staffId, type, `${TAG} ${note}`, vnTime(date, hhmm)],
  );
}

async function main() {
  console.log(`Seeding attendance demo ${MONTH}…`);

  await pool.query(`DELETE FROM attendance_logs WHERE notes LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM staff_leave_requests WHERE reason LIKE $1`, [`${TAG}%`]);

  for (const p of hoaDays) {
    if (!p.in) continue;
    await insertPunch(STAFF.hoa, "check_in", p.date, p.in, p.note ?? "");
    if (p.out) await insertPunch(STAFF.hoa, "check_out", p.date, p.out, p.note ?? "");
  }
  for (const p of trungDays) {
    if (!p.in) continue;
    await insertPunch(STAFF.trung, "check_in", p.date, p.in, p.note ?? "");
    if (p.out) await insertPunch(STAFF.trung, "check_out", p.date, p.out, p.note ?? "");
  }
  for (const p of quanDays) {
    if (!p.in) continue;
    await insertPunch(STAFF.quan, "check_in", p.date, p.in, p.note ?? "");
    if (p.out) await insertPunch(STAFF.quan, "check_out", p.date, p.out, p.note ?? "");
  }
  for (const lv of quanLeaves) {
    await pool.query(
      `INSERT INTO staff_leave_requests (staff_id, start_date, end_date, reason, status, leave_type, session)
       VALUES ($1, $2::date, $3::date, $4, 'approved', 'off', 'full_day')`,
      [STAFF.quan, lv.start, lv.end, lv.reason],
    );
  }

  await pool.query(`UPDATE staff SET name = 'Hoa' WHERE id = $1`, [STAFF.hoa]);
  await pool.query(`UPDATE staff SET name = 'Trung' WHERE id = $1`, [STAFF.trung]);
  await pool.query(`UPDATE staff SET name = 'Quân' WHERE id = $1`, [STAFF.quan]);

  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM attendance_logs WHERE notes LIKE $1`,
    [`${TAG}%`],
  );
  console.log(`Done. ${r.rows[0].n} log rows tagged ${TAG}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
