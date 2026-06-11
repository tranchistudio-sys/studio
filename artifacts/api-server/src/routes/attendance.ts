import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import {
  attendanceLogsTable, attendanceRulesTable, attendanceLateRulesTable,
  attendanceAdjustmentsTable, attendanceLogOverridesTable,
  attendanceShiftOverridesTable, attendanceShiftOverrideStaffTable,
  staffLeaveRequestsTable,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyToken } from "./auth";
import { getPublicBaseUrl } from "../lib/publicUrl";
import { computeOvertimeForMonth, type OvertimeLog } from "../lib/overtime";
import {
  getShowDayDatesForStaff,
  getShowDayDatesByStaffForMonth,
  getShowDayStaffIdsForDate,
  getBookingsForStaffOnDate,
  resolveAttendanceMode,
  studioLatePenaltyApplies,
  isSundayOff,
  type AttendanceMode,
} from "../lib/attendance-mode";

// ─── Helper: lấy danh sách ngày leave 'approved' trong tháng (cap 2) ────────
// Trả về Set<dateStr> chỉ chứa tối đa 2 ngày đầu tiên (cap).
async function getExcusedLeaveDates(staffId: number, monthStr: string): Promise<{ excused: Set<string>; allLeaveDates: string[]; used: number; cap: number }> {
  const cap = 2;
  const [y, m] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStart = `${monthStr}-01`;
  const monthEnd = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;
  const rows = await db.select().from(staffLeaveRequestsTable).where(and(
    eq(staffLeaveRequestsTable.staffId, staffId),
    eq(staffLeaveRequestsTable.status, "approved"),
  ));
  const days = new Set<string>();
  for (const r of rows) {
    const s = r.startDate > monthStart ? r.startDate : monthStart;
    const e = r.endDate < monthEnd ? r.endDate : monthEnd;
    if (s > e) continue;
    const sd = new Date(s), ed = new Date(e);
    for (let d = new Date(sd); d <= ed; d.setDate(d.getDate() + 1)) {
      days.add(d.toISOString().slice(0, 10));
    }
  }
  const sorted = [...days].sort();
  const excused = new Set(sorted.slice(0, cap));
  return { excused, allLeaveDates: sorted, used: sorted.length, cap };
}

function getStaticQrUrl(): string {
  return `${getPublicBaseUrl()}/attendance/check-in`;
}

function todayVN(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}


const ATTENDANCE_ACT_AS_HEADER = "x-attendance-staff-id";

async function isStaffAdmin(staffId: number): Promise<boolean> {
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [staffId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  return !!(caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"))));
}

async function resolveAttendanceStaffId(req: import("express").Request, callerId: number): Promise<number> {
  const raw = req.headers[ATTENDANCE_ACT_AS_HEADER] ?? req.headers["X-Attendance-Staff-Id"];
  if (!raw) return callerId;
  const targetId = parseInt(String(Array.isArray(raw) ? raw[0] : raw), 10);
  if (!targetId || targetId === callerId) return callerId;
  if (!(await isStaffAdmin(callerId))) return callerId;
  const targetR = await pool.query(`SELECT id FROM staff WHERE id = $1 AND is_active = 1 LIMIT 1`, [targetId]);
  return targetR.rows.length > 0 ? targetId : callerId;
}

function mapTestStaffRow(row: Record<string, unknown>) {
  return {
    id: row.id as number,
    name: String(row.name),
    role: String(row.role),
    staffType: String(row.staff_type ?? "official"),
  };
}

async function findAttendanceTestStaff() {
  const settingsR = await pool.query(`SELECT value FROM settings WHERE key = 'attendance_test_staff_id' LIMIT 1`);
  if (settingsR.rows[0]) {
    const id = parseInt(String((settingsR.rows[0] as { value: string }).value), 10);
    if (id) {
      const r = await pool.query(
        `SELECT id, name, role, staff_type FROM staff WHERE id = $1 AND is_active = 1 LIMIT 1`, [id],
      );
      if (r.rows[0]) return mapTestStaffRow(r.rows[0] as Record<string, unknown>);
    }
  }
  const r = await pool.query(`
    SELECT id, name, role, staff_type FROM staff
    WHERE is_active = 1 AND (
      username = 'attendance_test'
      OR name ILIKE '%nhan vien test%'
      OR name ILIKE '%nhân viên test%'
      OR name ILIKE '%nv test%'
    )
    ORDER BY id ASC LIMIT 1`);
  if (r.rows[0]) return mapTestStaffRow(r.rows[0] as Record<string, unknown>);
  const fallback = await pool.query(`
    SELECT id, name, role, staff_type FROM staff
    WHERE is_active = 1 AND role NOT IN ('admin', 'owner')
    ORDER BY id ASC LIMIT 1`);
  return fallback.rows[0] ? mapTestStaffRow(fallback.rows[0] as Record<string, unknown>) : null;
}

const VALID_WORK_TYPES = new Set(["studio", "di_show", "makeup_ngoai", "hau_ky", "linh_dong"]);

// ─── Startup migration: add work_type, clean bad rules, seed defaults ────────
async function ensureAttendanceSchema() {
  await pool.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS work_type TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS checkin_photo_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS checkout_photo_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE attendance_adjustments ADD COLUMN IF NOT EXISTS category TEXT`).catch(() => {});
  // Task #504: cột đơn giá tăng ca / giờ (default 30k)
  await pool.query(`ALTER TABLE attendance_rules ADD COLUMN IF NOT EXISTS overtime_rate_per_hour NUMERIC(12,2) NOT NULL DEFAULT 30000`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_log_overrides (
      id SERIAL PRIMARY KEY,
      log_id INTEGER NOT NULL REFERENCES attendance_logs(id) ON DELETE CASCADE,
      override_time TEXT,
      override_is_late INTEGER,
      reason TEXT NOT NULL,
      created_by INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_overrides_log_id ON attendance_log_overrides(log_id)`).catch(() => {});
  // Partial unique index for atomic waiver dedup (1 waiver per staff+date)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_adj_waiver_unique ON attendance_adjustments(staff_id, date) WHERE category = 'waiver'`).catch(() => {});

  // Clean bad late-rule rows (legacy: lateToTime >= 20:00 was a UI default bug)
  await pool.query(`DELETE FROM attendance_late_rules WHERE late_to_time >= '20:00'`).catch(() => {});

  // Task #505: bảng ca làm linh hoạt theo ngày
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_shift_overrides (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      name TEXT NOT NULL DEFAULT 'Ca đặc biệt',
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      standard_hours NUMERIC(4,2) NOT NULL DEFAULT 8,
      flexible_break_hours NUMERIC(4,2) NOT NULL DEFAULT 2,
      notes TEXT,
      scope TEXT NOT NULL DEFAULT 'all',
      created_by INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_shift_overrides_date ON attendance_shift_overrides(date)`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_shift_override_staff (
      id SERIAL PRIMARY KEY,
      override_id INTEGER NOT NULL REFERENCES attendance_shift_overrides(id) ON DELETE CASCADE,
      staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_shift_override_staff_override ON attendance_shift_override_staff(override_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_shift_override_staff_staff ON attendance_shift_override_staff(staff_id)`).catch(() => {});

  // Seed default rule if none active
  const ruleR = await pool.query(`SELECT id FROM attendance_rules WHERE is_active = 1 LIMIT 1`);
  let ruleId: number;
  if (ruleR.rows.length === 0) {
    const ins = await pool.query(`
      INSERT INTO attendance_rules (name, check_in_from, check_in_to, weekly_on_time_bonus, is_active)
      VALUES ('Mặc định', '07:30', '08:10', '50000', 1) RETURNING id
    `);
    ruleId = (ins.rows[0] as { id: number }).id;
  } else {
    ruleId = (ruleR.rows[0] as { id: number }).id;
  }

  // Seed default late rules if none
  const lateR = await pool.query(`SELECT id FROM attendance_late_rules WHERE rule_id = $1 LIMIT 1`, [ruleId]);
  if (lateR.rows.length === 0) {
    const seeds: [string, string | null, string][] = [
      ["08:11", "08:30", "10000"],
      ["08:31", "09:00", "20000"],
      ["09:01", "09:30", "30000"],
      ["09:31", "10:00", "50000"],
      ["10:00", null,     "100000"],
    ];
    for (const [from, to, amt] of seeds) {
      await pool.query(
        `INSERT INTO attendance_late_rules (rule_id, late_from_time, late_to_time, penalty_amount) VALUES ($1, $2, $3, $4)`,
        [ruleId, from, to, amt]
      );
    }
  }
}
ensureAttendanceSchema().catch(err => console.error("[attendance] ensureSchema failed:", err));

const router: IRouter = Router();

const STUDIO_LAT = 11.3101;
const STUDIO_LNG = 106.1074;
const DEFAULT_RADIUS_M = 300;

function getDistanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// GET /attendance/test-staff — admin chế độ nhân viên: NV hệ thống để test chấm công
router.get("/attendance/test-staff", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  if (!(await isStaffAdmin(callerId))) return res.status(403).json({ error: "Không có quyền" });
  const staff = await findAttendanceTestStaff();
  if (!staff) return res.status(404).json({ error: "Chưa cấu hình nhân viên test chấm công" });
  res.json(staff);
});

// ── Check In ──────────────────────────────────────────────────────────────────
router.post("/attendance/check-in", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = await resolveAttendanceStaffId(req, callerId);

  const {
    lat, lng, accuracyM, bookingId, workType: reqWorkType,
    checkinPhotoUrl, notes,
  } = req.body as {
    lat?: number; lng?: number; accuracyM?: number; bookingId?: number;
    workType?: string; checkinPhotoUrl?: string; notes?: string;
  };

  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "Vui lòng cấp quyền GPS để chấm công." });
  }

  const settingsR = await pool.query(`SELECT key, value FROM settings WHERE key IN ('studio_lat', 'studio_lng', 'attendance_radius_m')`);
  const settingsMap: Record<string, string> = {};
  for (const row of settingsR.rows as { key: string; value: string }[]) {
    settingsMap[row.key] = row.value;
  }
  const studioLat = parseFloat(settingsMap.studio_lat ?? String(STUDIO_LAT));
  const studioLng = parseFloat(settingsMap.studio_lng ?? String(STUDIO_LNG));
  const radiusM = parseFloat(settingsMap.attendance_radius_m ?? String(DEFAULT_RADIUS_M));

  const distanceM = getDistanceM(parseFloat(String(lat)), parseFloat(String(lng)), studioLat, studioLng);
  const inGeofence = distanceM <= radiusM;
  const requestedOffsite = !!(reqWorkType && ["di_show", "makeup_ngoai"].includes(String(reqWorkType)));
  const photoUrl = checkinPhotoUrl ? String(checkinPhotoUrl).trim() : "";
  const noteText = notes ? String(notes).trim() : null;

  let method: "qr" | "offsite" | "manual";
  let allowedBookingId: number | null = bookingId ? parseInt(String(bookingId)) : null;

  if (requestedOffsite) {
    // Show ngoài: không cần lịch chụp — bắt buộc selfie + GPS
    if (!photoUrl) {
      return res.status(400).json({ error: "Show ngoài cần chụp selfie xác thực trước khi chấm công" });
    }
    method = "offsite";
  } else if (inGeofence) {
    method = "qr";
  } else {
    return res.status(400).json({
      error: "Bạn đang ngoài vùng studio. Chọn \u201cĐi Show ngoài\u201d (selfie + GPS) hoặc đến studio để chấm \u201cTại Studio\u201d.",
      distanceM: Math.round(distanceM),
      radiusM,
    });
  }

  let workType: string;
  if (reqWorkType && VALID_WORK_TYPES.has(String(reqWorkType))) {
    workType = String(reqWorkType);
  } else if (method === "offsite") {
    const staffR = await pool.query(`SELECT role FROM staff WHERE id = $1`, [staffId]);
    const role = (staffR.rows[0] as { role?: string } | undefined)?.role;
    workType = role === "makeup" ? "makeup_ngoai" : "di_show";
  } else {
    workType = "studio";
  }

  if (method === "qr" && !["studio", "hau_ky", "linh_dong"].includes(workType)) {
    return res.status(400).json({ error: "Tại studio chỉ được chọn Studio, Hậu kỳ hoặc Linh động." });
  }
  if (method === "offsite" && !["di_show", "makeup_ngoai"].includes(workType)) {
    return res.status(400).json({ error: "Show ngoài chỉ được chọn Đi show hoặc Makeup ngoài." });
  }

  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const existing = await pool.query(
    `SELECT id FROM attendance_logs WHERE staff_id = $1 AND type = 'check_in' AND (created_at + interval '7 hours')::date = $2::date LIMIT 1`,
    [staffId, today]
  );
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: "Bạn đã check-in hôm nay rồi" });
  }

  const [log] = await db.insert(attendanceLogsTable).values({
    staffId,
    type: "check_in",
    method,
    lat: String(lat),
    lng: String(lng),
    accuracyM: accuracyM !== undefined ? String(accuracyM) : null,
    distanceM: String(Math.round(distanceM)),
    bookingId: allowedBookingId,
    workType,
    checkinPhotoUrl: method === "offsite" ? photoUrl : null,
    notes: noteText,
  }).returning();

  res.status(201).json(log);
});

// ── QR Token ──────────────────────────────────────────────────────────────────
router.get("/attendance/qr-token", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const url = getStaticQrUrl();
  res.json({ url });
});

// ── Check Out ─────────────────────────────────────────────────────────────────
router.post("/attendance/check-out", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = await resolveAttendanceStaffId(req, callerId);

  const { lat, lng, accuracyM } = req.body;

  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const alreadyOut = await pool.query(
    `SELECT id FROM attendance_logs WHERE staff_id = $1 AND type = 'check_out' AND (created_at + interval '7 hours')::date = $2::date LIMIT 1`,
    [staffId, today]
  );
  if (alreadyOut.rows.length > 0) {
    return res.status(400).json({ error: "Bạn đã check-out hôm nay rồi" });
  }

  const checkInR = await pool.query(
    `SELECT method FROM attendance_logs WHERE staff_id = $1 AND type = 'check_in' AND (created_at + interval '7 hours')::date = $2::date LIMIT 1`,
    [staffId, today]
  );
  if (checkInR.rows.length === 0) {
    return res.status(400).json({ error: "Bạn chưa chấm vào hôm nay" });
  }
  const checkoutMethod: "qr" | "offsite" | "manual" = (checkInR.rows[0] as { method: string } | undefined)?.method as "qr" | "offsite" | "manual" ?? "qr";

  const [log] = await db.insert(attendanceLogsTable).values({
    staffId,
    type: "check_out",
    method: checkoutMethod,
    lat: lat !== undefined ? String(lat) : null,
    lng: lng !== undefined ? String(lng) : null,
    accuracyM: accuracyM !== undefined ? String(accuracyM) : null,
  }).returning();

  res.status(201).json(log);
});

// ── Overtime check-in/out (Task #504) ───────────────────────────────────────
// Bấm sau giờ ca chính. Log riêng type=overtime_check_in/out, work_type='overtime'.
// Validate GPS y như chấm công thường (geofence hoặc booking offsite).
async function handleOvertimePunch(req: import("express").Request, res: import("express").Response, punchType: "overtime_check_in" | "overtime_check_out") {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = await resolveAttendanceStaffId(req, callerId);
  const { lat, lng, accuracyM } = req.body;
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "Vui lòng cấp quyền GPS để chấm tăng ca." });
  }

  // Geofence check (cùng logic check-in)
  const settingsR = await pool.query(`SELECT key, value FROM settings WHERE key IN ('studio_lat', 'studio_lng', 'attendance_radius_m')`);
  const settingsMap: Record<string, string> = {};
  for (const row of settingsR.rows as { key: string; value: string }[]) settingsMap[row.key] = row.value;
  const studioLat = parseFloat(settingsMap.studio_lat ?? String(STUDIO_LAT));
  const studioLng = parseFloat(settingsMap.studio_lng ?? String(STUDIO_LNG));
  const radiusM = parseFloat(settingsMap.attendance_radius_m ?? String(DEFAULT_RADIUS_M));
  const distanceM = getDistanceM(parseFloat(String(lat)), parseFloat(String(lng)), studioLat, studioLng);
  const inGeofence = distanceM <= radiusM;
  const method: "qr" | "offsite" = inGeofence ? "qr" : "offsite";
  if (!inGeofence) {
    // Cho phép offsite chỉ khi có booking hôm nay
    const today = todayVN();
    const offsite = await pool.query(`
      SELECT id FROM bookings
      WHERE shoot_date = $1 AND status NOT IN ('cancelled', 'huy')
        AND (
          (assigned_staff @> to_jsonb($2::int))
          OR (assigned_staff->>'photo')::int = $2
          OR (assigned_staff->>'photographer')::int = $2
          OR (assigned_staff->>'makeup')::int = $2
          OR (assigned_staff->>'sale')::int = $2
        ) LIMIT 1`, [today, staffId]);
    if (offsite.rows.length === 0) {
      return res.status(400).json({
        error: "Bạn không trong vùng studio và không có lịch chụp hôm nay",
        distanceM: Math.round(distanceM), radiusM,
      });
    }
  }

  // Task #505: OT chỉ được phép sau giờ kết thúc ca làm hôm đó
  const today = todayVN();
  if (punchType === "overtime_check_in") {
    const shift = await getShiftForDate(staffId, today);
    const nowHHMM = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(11, 16);
    if (nowHHMM < shift.endTime) {
      return res.status(400).json({
        error: `Chưa đến giờ tăng ca. Ca hôm nay kết thúc lúc ${shift.endTime}.`,
        shiftEndTime: shift.endTime,
      });
    }
  }

  // Khi check-in OT: yêu cầu đã có log OT check-out chưa-cặp HOẶC chưa từng có OT check-in
  // chưa cặp trong ngày. Tức là không cho phép 2 check-in OT liên tiếp.
  const sameDayR = await pool.query(
    `SELECT type FROM attendance_logs
       WHERE staff_id = $1 AND (created_at + interval '7 hours')::date = $2::date
         AND type IN ('overtime_check_in', 'overtime_check_out')
       ORDER BY created_at ASC`,
    [staffId, today]
  );
  const otLogsToday = (sameDayR.rows as { type: string }[]).map(r => r.type);
  // Đếm pending: số OT check-in chưa có check-out match
  let pending = 0;
  for (const t of otLogsToday) {
    if (t === "overtime_check_in") pending++;
    else if (t === "overtime_check_out" && pending > 0) pending--;
  }
  if (punchType === "overtime_check_in" && pending > 0) {
    return res.status(400).json({ error: "Bạn đang trong phiên tăng ca — hãy kết thúc trước khi bắt đầu phiên mới." });
  }
  if (punchType === "overtime_check_out" && pending === 0) {
    return res.status(400).json({ error: "Bạn chưa bắt đầu phiên tăng ca nào để kết thúc." });
  }

  const [log] = await db.insert(attendanceLogsTable).values({
    staffId,
    type: punchType,
    method,
    lat: String(lat), lng: String(lng),
    accuracyM: accuracyM !== undefined ? String(accuracyM) : null,
    distanceM: String(Math.round(distanceM)),
    workType: "overtime",
  }).returning();
  res.status(201).json(log);
}

router.post("/attendance/overtime/check-in", (req, res) => handleOvertimePunch(req, res, "overtime_check_in"));
router.post("/attendance/overtime/check-out", (req, res) => handleOvertimePunch(req, res, "overtime_check_out"));

// ─── Task #505: Ca làm linh hoạt theo ngày ─────────────────────────────────
export type ShiftInfo = {
  name: string;
  startTime: string;       // HH:MM
  endTime: string;         // HH:MM
  standardHours: number;
  flexibleBreakHours: number;
  source: "override" | "default";
  overrideId?: number;
  scope?: "all" | "selected";
};

const DEFAULT_SHIFT: ShiftInfo = {
  name: "Ca ngày",
  startTime: "08:00",
  endTime: "18:00",
  standardHours: 8,
  flexibleBreakHours: 2,
  source: "default",
};

type ShiftRow = {
  id: number; date: string; name: string; start_time: string; end_time: string;
  standard_hours: string; flexible_break_hours: string; notes: string | null; scope: string;
  staff_ids: number[] | null;
};

function rowToShift(r: ShiftRow): ShiftInfo {
  return {
    name: r.name,
    startTime: r.start_time,
    endTime: r.end_time,
    standardHours: parseFloat(String(r.standard_hours ?? "8")),
    flexibleBreakHours: parseFloat(String(r.flexible_break_hours ?? "2")),
    source: "override",
    overrideId: r.id,
    scope: r.scope === "selected" ? "selected" : "all",
  };
}

// Lấy ca cho 1 staff ở 1 ngày cụ thể. Ưu tiên: scope=selected match staffId > scope=all > default.
export async function getShiftForDate(staffId: number, dateStr: string): Promise<ShiftInfo> {
  const r = await pool.query<ShiftRow>(`
    SELECT o.id, to_char(o.date, 'YYYY-MM-DD') as date, o.name, o.start_time, o.end_time,
           o.standard_hours, o.flexible_break_hours, o.notes, o.scope,
           COALESCE((SELECT array_agg(staff_id) FROM attendance_shift_override_staff WHERE override_id = o.id), NULL) as staff_ids
    FROM attendance_shift_overrides o
    WHERE o.date = $1::date
    ORDER BY o.created_at DESC
  `, [dateStr]);
  const rows = r.rows as ShiftRow[];
  // Priority: selected match first
  for (const row of rows) {
    if (row.scope === "selected" && Array.isArray(row.staff_ids) && row.staff_ids.includes(staffId)) {
      return rowToShift(row);
    }
  }
  for (const row of rows) {
    if (row.scope === "all") return rowToShift(row);
  }
  return DEFAULT_SHIFT;
}

// Batch: trả map<dateStr, ShiftInfo> cho 1 staff trên tháng (giảm N+1 query).
async function getShiftsForMonth(staffId: number, monthStr: string): Promise<Map<string, ShiftInfo>> {
  const [y, m] = monthStr.split("-").map(Number);
  const monthStart = `${monthStr}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthEnd = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;
  const r = await pool.query<ShiftRow>(`
    SELECT o.id, to_char(o.date, 'YYYY-MM-DD') as date, o.name, o.start_time, o.end_time,
           o.standard_hours, o.flexible_break_hours, o.notes, o.scope,
           COALESCE((SELECT array_agg(staff_id) FROM attendance_shift_override_staff WHERE override_id = o.id), NULL) as staff_ids
    FROM attendance_shift_overrides o
    WHERE o.date BETWEEN $1::date AND $2::date
    ORDER BY o.date, o.created_at DESC
  `, [monthStart, monthEnd]);
  const byDate = new Map<string, ShiftRow[]>();
  for (const row of r.rows as ShiftRow[]) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date)!.push(row);
  }
  const result = new Map<string, ShiftInfo>();
  for (const [date, rows] of byDate) {
    let picked: ShiftRow | null = null;
    for (const row of rows) {
      if (row.scope === "selected" && Array.isArray(row.staff_ids) && row.staff_ids.includes(staffId)) {
        picked = row; break;
      }
    }
    if (!picked) {
      for (const row of rows) {
        if (row.scope === "all") { picked = row; break; }
      }
    }
    if (picked) result.set(date, rowToShift(picked));
  }
  return result;
}

function shiftForDateFromMap(map: Map<string, ShiftInfo>, dateStr: string): ShiftInfo {
  return map.get(dateStr) ?? DEFAULT_SHIFT;
}

async function requireAdmin(req: import("express").Request): Promise<{ ok: boolean; staffId: number | null }> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return { ok: false, staffId: null };
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  return { ok: !!isAdmin, staffId: callerId };
}

// GET /api/attendance/shifts?month=YYYY-MM  (admin only)
router.get("/attendance/shifts", async (req, res) => {
  const { ok } = await requireAdmin(req);
  if (!ok) return res.status(403).json({ error: "Không có quyền" });
  const month = String(req.query.month || todayVN().slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return res.status(400).json({ error: "month không hợp lệ" });
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const r = await pool.query(`
    SELECT o.id, to_char(o.date, 'YYYY-MM-DD') as date, o.name, o.start_time, o.end_time,
           o.standard_hours, o.flexible_break_hours, o.notes, o.scope,
           o.created_by, o.created_at, s.name as created_by_name,
           COALESCE((SELECT array_agg(staff_id) FROM attendance_shift_override_staff WHERE override_id = o.id), '{}') as staff_ids
    FROM attendance_shift_overrides o
    LEFT JOIN staff s ON s.id = o.created_by
    WHERE o.date BETWEEN $1::date AND $2::date
    ORDER BY o.date, o.created_at
  `, [monthStart, monthEnd]);
  res.json((r.rows as Record<string, unknown>[]).map(row => ({
    id: row.id,
    date: row.date,
    name: row.name,
    startTime: row.start_time,
    endTime: row.end_time,
    standardHours: parseFloat(String(row.standard_hours ?? "8")),
    flexibleBreakHours: parseFloat(String(row.flexible_break_hours ?? "2")),
    notes: row.notes ?? null,
    scope: row.scope,
    staffIds: Array.isArray(row.staff_ids) ? row.staff_ids : [],
    createdBy: row.created_by ?? null,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
  })));
});

// GET /api/attendance/shift-today  (staff: trả ca hôm nay của họ)
router.get("/attendance/shift-today", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = await resolveAttendanceStaffId(req, callerId);
  const date = String(req.query.date || todayVN());
  const shift = await getShiftForDate(staffId, date);
  res.json({ date, ...shift });
});

function validateShiftBody(body: Record<string, unknown>): { ok: true; data: { date: string; name: string; startTime: string; endTime: string; standardHours: number; flexibleBreakHours: number; notes: string | null; scope: "all" | "selected"; staffIds: number[] } } | { ok: false; error: string } {
  const date = String(body.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Ngày không hợp lệ" };
  const name = String(body.name ?? "").trim() || "Ca đặc biệt";
  const startTime = String(body.startTime ?? "");
  const endTime = String(body.endTime ?? "");
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) return { ok: false, error: "Giờ không hợp lệ (HH:MM)" };
  if (endTime <= startTime) return { ok: false, error: "Giờ kết thúc phải sau giờ bắt đầu" };
  const standardHours = Number(body.standardHours ?? 8);
  const flexibleBreakHours = Number(body.flexibleBreakHours ?? 2);
  if (!Number.isFinite(standardHours) || standardHours < 0 || standardHours > 24) return { ok: false, error: "Công chuẩn không hợp lệ" };
  if (!Number.isFinite(flexibleBreakHours) || flexibleBreakHours < 0 || flexibleBreakHours > 24) return { ok: false, error: "Nghỉ linh hoạt không hợp lệ" };
  const scope = body.scope === "selected" ? "selected" : "all";
  const staffIdsRaw = Array.isArray(body.staffIds) ? body.staffIds : [];
  const staffIds = staffIdsRaw.map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0);
  if (scope === "selected" && staffIds.length === 0) return { ok: false, error: "Cần chọn ít nhất 1 nhân viên cho ca riêng" };
  const notes = body.notes ? String(body.notes) : null;
  return { ok: true, data: { date, name, startTime, endTime, standardHours, flexibleBreakHours, notes, scope, staffIds } };
}

// POST /api/attendance/shifts  (admin)
router.post("/attendance/shifts", async (req, res) => {
  const { ok, staffId } = await requireAdmin(req);
  if (!ok) return res.status(403).json({ error: "Không có quyền" });
  const v = validateShiftBody(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.data;
  const ins = await pool.query(`
    INSERT INTO attendance_shift_overrides (date, name, start_time, end_time, standard_hours, flexible_break_hours, notes, scope, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
  `, [d.date, d.name, d.startTime, d.endTime, String(d.standardHours), String(d.flexibleBreakHours), d.notes, d.scope, staffId]);
  const overrideId = (ins.rows[0] as { id: number }).id;
  if (d.scope === "selected" && d.staffIds.length > 0) {
    for (const sid of d.staffIds) {
      await pool.query(`INSERT INTO attendance_shift_override_staff (override_id, staff_id) VALUES ($1, $2)`, [overrideId, sid]);
    }
  }
  res.status(201).json({ id: overrideId });
});

// PUT /api/attendance/shifts/:id  (admin)
router.put("/attendance/shifts/:id", async (req, res) => {
  const { ok } = await requireAdmin(req);
  if (!ok) return res.status(403).json({ error: "Không có quyền" });
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id không hợp lệ" });
  const v = validateShiftBody(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.data;
  const upd = await pool.query(`
    UPDATE attendance_shift_overrides
    SET date=$1, name=$2, start_time=$3, end_time=$4, standard_hours=$5, flexible_break_hours=$6, notes=$7, scope=$8
    WHERE id=$9 RETURNING id
  `, [d.date, d.name, d.startTime, d.endTime, String(d.standardHours), String(d.flexibleBreakHours), d.notes, d.scope, id]);
  if (upd.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy ca" });
  await pool.query(`DELETE FROM attendance_shift_override_staff WHERE override_id = $1`, [id]);
  if (d.scope === "selected" && d.staffIds.length > 0) {
    for (const sid of d.staffIds) {
      await pool.query(`INSERT INTO attendance_shift_override_staff (override_id, staff_id) VALUES ($1, $2)`, [id, sid]);
    }
  }
  res.json({ id });
});

// DELETE /api/attendance/shifts/:id  (admin) — không phá log cũ
router.delete("/attendance/shifts/:id", async (req, res) => {
  const { ok } = await requireAdmin(req);
  if (!ok) return res.status(403).json({ error: "Không có quyền" });
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id không hợp lệ" });
  const del = await pool.query(`DELETE FROM attendance_shift_overrides WHERE id = $1 RETURNING id`, [id]);
  if (del.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy ca" });
  res.json({ ok: true });
});

// ── Helper: find penalty for a given check-in time (HH:MM) ───────────────────
// Returns { isLate, penalty }: isLate=true for any check-in after checkInTo
// even if no late-rule matches (penalty=0). UI uses isLate to render "Trễ" badge.
// Infer work_type from method when work_type column is NULL (legacy data before V2 migration)
function inferWorkType(method: string | null, rawWorkType: string | null): string | null {
  if (rawWorkType) return rawWorkType;
  if (method === "offsite") return "di_show";
  if (method === "qr") return "studio";
  if (method === "manual") return "studio";
  return null;
}

function findPenalty(
  localTime: string,
  checkInTo: string,
  lateRules: { lateFromTime: string | null; lateToTime: string | null; penaltyAmount: string | null }[]
): { isLate: boolean; penalty: number } {
  if (!localTime || localTime <= checkInTo) return { isLate: false, penalty: 0 };
  let maxPenalty = 0;
  for (const lr of lateRules) {
    const fromTime = lr.lateFromTime ?? "00:00";
    const toTime = lr.lateToTime;
    const inRange = localTime >= fromTime && (toTime === null || localTime <= toTime);
    if (inRange) {
      const amt = lr.penaltyAmount ? parseFloat(String(lr.penaltyAmount)) : 0;
      if (amt > maxPenalty) maxPenalty = amt;
    }
  }
  return { isLate: true, penalty: maxPenalty };
}

// Fetch overrides for a list of log IDs, returns Map<logId, override>
type LogOverride = {
  id: number; logId: number; overrideTime: string | null;
  overrideIsLate: number | null; reason: string;
  createdBy: number | null; createdByName: string | null; createdAt: string;
};
async function loadOverrides(logIds: number[]): Promise<Map<number, LogOverride>> {
  const map = new Map<number, LogOverride>();
  if (logIds.length === 0) return map;
  const r = await pool.query(
    `SELECT o.id, o.log_id, o.override_time, o.override_is_late, o.reason,
            o.created_by, s.name as created_by_name, o.created_at
     FROM attendance_log_overrides o
     LEFT JOIN staff s ON s.id = o.created_by
     WHERE o.log_id = ANY($1::int[])
     ORDER BY o.created_at DESC`,
    [logIds]
  );
  for (const row of r.rows as Record<string, unknown>[]) {
    const logId = row.log_id as number;
    if (!map.has(logId)) {
      // newest first → first one wins
      map.set(logId, {
        id: row.id as number,
        logId,
        overrideTime: (row.override_time as string | null) ?? null,
        overrideIsLate: row.override_is_late === null || row.override_is_late === undefined ? null : Number(row.override_is_late),
        reason: String(row.reason ?? ""),
        createdBy: (row.created_by as number | null) ?? null,
        createdByName: (row.created_by_name as string | null) ?? null,
        createdAt: row.created_at instanceof Date ? (row.created_at as Date).toISOString() : String(row.created_at ?? ""),
      });
    }
  }
  return map;
}

// ── Studio info (public for GPS-aware UI) ────────────────────────────────────
router.get("/attendance/studio-info", async (_req, res) => {
  const settingsR = await pool.query(`SELECT key, value FROM settings WHERE key IN ('studio_lat', 'studio_lng', 'attendance_radius_m')`);
  const map = Object.fromEntries(settingsR.rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  const lat = parseFloat(map.studio_lat ?? String(STUDIO_LAT));
  const lng = parseFloat(map.studio_lng ?? String(STUDIO_LNG));
  const radius = parseFloat(map.attendance_radius_m ?? String(DEFAULT_RADIUS_M));
  res.json({ lat, lng, radius });
});

// ── GET /me: Tổng hợp tháng ──────────────────────────────────────────────────
// ── Studio info (public for GPS-aware UI) ────────────────────────────────────
router.get("/attendance/studio-info", async (_req, res) => {
  const settingsR = await pool.query(`SELECT key, value FROM settings WHERE key IN ('studio_lat', 'studio_lng', 'attendance_radius_m')`);
  const map = Object.fromEntries(settingsR.rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  const lat = parseFloat(map.studio_lat ?? String(STUDIO_LAT));
  const lng = parseFloat(map.studio_lng ?? String(STUDIO_LNG));
  const radius = parseFloat(map.attendance_radius_m ?? String(DEFAULT_RADIUS_M));
  res.json({ lat, lng, radius });
});

// ── GET /me: Tổng hợp tháng ──────────────────────────────────────────────────
router.get("/attendance/me", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = await resolveAttendanceStaffId(req, callerId);

  const month = String(req.query.month || todayVN().slice(0, 7));

  const logsR = await pool.query(
    `SELECT id, staff_id, type, method, lat, lng, distance_m, work_type, notes, checkin_photo_url, created_at,
            to_char(created_at + interval '7 hours', 'HH24:MI') as local_time,
            to_char(created_at + interval '7 hours', 'YYYY-MM-DD') as local_date
     FROM attendance_logs WHERE staff_id = $1 AND to_char(created_at + interval '7 hours', 'YYYY-MM') = $2 ORDER BY created_at`,
    [callerId, month]
  );
  const rawLogs = (logsR.rows as Record<string, unknown>[]).map(l => ({
    id: l.id as number,
    staffId: l.staff_id,
    type: l.type,
    method: l.method,
    lat: l.lat,
    lng: l.lng,
    distanceM: l.distance_m != null ? parseFloat(String(l.distance_m)) : null,
    isOffsite: l.method === "offsite",
    workType: inferWorkType(l.method as string | null, l.work_type as string | null),
    notes: l.notes,
    checkinPhotoUrl: (l.checkin_photo_url as string | null) ?? null,
    localTime: l.local_time as string,
    localDate: l.local_date as string,
    createdAt: l.created_at instanceof Date ? l.created_at.toISOString() : String(l.created_at ?? ""),
  }));

  const overrideMap = await loadOverrides(rawLogs.map(l => l.id));
  const logs = rawLogs.map(l => {
    const ov = overrideMap.get(l.id);
    if (!ov) return { ...l, override: null as null | { time: string | null; isLate: number | null; reason: string; createdByName: string | null; createdAt: string } };
    return {
      ...l,
      localTime: ov.overrideTime ?? l.localTime,
      override: { time: ov.overrideTime, isLate: ov.overrideIsLate, reason: ov.reason, createdByName: ov.createdByName, createdAt: ov.createdAt },
    };
  });

  const checkIns = logs.filter(l => l.type === "check_in");

  const [rule] = await db.select().from(attendanceRulesTable).where(eq(attendanceRulesTable.isActive, 1));
  const lateRules = rule
    ? await db.select().from(attendanceLateRulesTable)
        .where(eq(attendanceLateRulesTable.ruleId, rule.id))
        .orderBy(attendanceLateRulesTable.lateFromTime)
    : [];
  const ruleCheckInTo = rule?.checkInTo ?? "08:10";
  // Task #505: nạp ca theo tháng cho staff này — late threshold dùng shift.startTime nếu có override
  const shiftMap = await getShiftsForMonth(callerId, month);

  // Load adjustments first so we can detect waivers per date
  const adjustmentsR = await pool.query(
    `SELECT a.id, a.staff_id, a.date, a.type, a.category, a.amount, a.reason, a.created_by, a.created_at,
            s.name as created_by_name
     FROM attendance_adjustments a
     LEFT JOIN staff s ON s.id = a.created_by
     WHERE a.staff_id = $1 AND to_char(a.date, 'YYYY-MM') = $2
     ORDER BY a.date`,
    [callerId, month]
  );
  const adjRows = (adjustmentsR.rows as Record<string, unknown>[]).map(a => ({
    id: a.id,
    staffId: a.staff_id,
    date: typeof a.date === "string" ? a.date : (a.date instanceof Date ? a.date.toISOString().slice(0, 10) : String(a.date)),
    type: a.type as string,
    category: (a.category as string | null) ?? null,
    amount: parseFloat(String(a.amount ?? "0")),
    reason: (a.reason as string | null) ?? null,
    createdByName: (a.created_by_name as string | null) ?? null,
    createdAt: String(a.created_at ?? ""),
  }));
  const waiverByDate = new Map<string, { reason: string | null; createdByName: string | null }>();
  for (const a of adjRows) {
    if (a.category === "waiver") {
      waiverByDate.set(a.date as string, { reason: a.reason, createdByName: a.createdByName });
    }
  }

  // Leave-aware: bỏ qua tính trễ cho ngày có leave approved trong cap 2/tháng
  const leaveInfo = await getExcusedLeaveDates(callerId, month);
  const showDayDates = await getShowDayDatesForStaff(callerId, month);

  let onTimeCount = 0;
  const bonusPenalty: { type: string; amount: number; description: string; date: string; isLate?: boolean; waived?: boolean; waiverReason?: string | null; overrideReason?: string | null }[] = [];

  checkIns.forEach(ci => {
    const localTime = ci.localTime;
    const dateStr = ci.localDate ?? ci.createdAt.slice(0, 10);
    if (leaveInfo.excused.has(dateStr)) {
      // Ngày được excused — không tính trễ, không tính bonus on-time
      return;
    }
    const mode = resolveAttendanceMode({
      hasBooking: showDayDates.has(dateStr),
      isLeaveExcused: leaveInfo.excused.has(dateStr),
      isWeekend: isSundayOff(dateStr),
    });
    if (!studioLatePenaltyApplies(mode)) {
      onTimeCount++;
      return;
    }
    const override = ci.override;
    const shift = shiftMap.get(dateStr);
    const effThreshold = shift ? shift.startTime : ruleCheckInTo;
    const computed = findPenalty(localTime, effThreshold, lateRules);
    // Honor explicit override of late state
    const isLate = override?.isLate === 0 ? false : override?.isLate === 1 ? true : computed.isLate;
    const penalty = isLate ? computed.penalty : 0;
    if (!isLate) {
      onTimeCount++;
    } else {
      const waiver = waiverByDate.get(dateStr);
      bonusPenalty.push({
        type: "penalty",
        amount: penalty,
        description: penalty > 0 ? `Đi trễ lúc ${localTime}` : `Trễ lúc ${localTime} (không phạt)`,
        date: dateStr,
        isLate: true,
        waived: !!waiver,
        waiverReason: waiver?.reason ?? null,
        overrideReason: override?.reason ?? null,
      });
    }
  });

  const bonusAdj = adjRows.filter(a => a.type === "bonus").reduce((s, a) => s + a.amount, 0);
  const penaltyAdj = adjRows.filter(a => a.type === "penalty").reduce((s, a) => s + a.amount, 0);

  const weeklyBonus = parseFloat(String(rule?.weeklyOnTimeBonus ?? "50000"));
  const weeksOnTime = Math.floor(onTimeCount / 5);

  const [y, mo] = month.split("-").map(Number);
  for (let w = 0; w < weeksOnTime; w++) {
    const weekEnd = new Date(y, mo - 1, (w + 1) * 7);
    bonusPenalty.push({
      type: "bonus",
      amount: weeklyBonus,
      description: `Bonus đúng giờ tuần ${w + 1}`,
      date: weekEnd.toISOString().slice(0, 10),
    });
  }

  bonusPenalty.sort((a, b) => a.date.localeCompare(b.date));

  const latePenaltyTotal = bonusPenalty.filter(bp => bp.type === "penalty").reduce((s, bp) => s + bp.amount, 0);
  const earnedBonus = weeksOnTime * weeklyBonus + bonusAdj;
  const totalPenalty = latePenaltyTotal + penaltyAdj;

  // Task #504: tổng hợp tăng ca trong tháng
  const otRate = parseFloat(String(rule?.overtimeRatePerHour ?? "30000"));
  const otLogs: OvertimeLog[] = logs
    .filter(l => l.type === "overtime_check_in" || l.type === "overtime_check_out")
    .map(l => ({ date: l.localDate, type: l.type as string, time: l.localTime }));
  const overtime = computeOvertimeForMonth(otLogs, otRate);

  res.json({
    month,
    logs,
    bonusPenalty,
    adjustments: adjRows,
    totalDays: checkIns.length,
    onTimeCount,
    onTimeRate: checkIns.length > 0 ? Math.round((onTimeCount / checkIns.length) * 100) : 0,
    earnedBonus,
    penalty: totalPenalty,
    overtime,
    net: earnedBonus - totalPenalty,
    checkInTo: ruleCheckInTo,
    // Task #505: shift map theo ngày (chỉ những ngày có override; default ẩn)
    shifts: Object.fromEntries([...shiftMap.entries()].map(([d, s]) => [d, {
      name: s.name, startTime: s.startTime, endTime: s.endTime,
      standardHours: s.standardHours, flexibleBreakHours: s.flexibleBreakHours,
      source: s.source, scope: s.scope,
    }])),
    todayShift: await (async () => {
      const t = todayVN();
      const sh = await getShiftForDate(callerId, t);
      return { date: t, name: sh.name, startTime: sh.startTime, endTime: sh.endTime,
        standardHours: sh.standardHours, flexibleBreakHours: sh.flexibleBreakHours, source: sh.source };
    })(),
    leave: {
      used: leaveInfo.used,
      cap: leaveInfo.cap,
      excusedDates: [...leaveInfo.excused],
      allLeaveDates: leaveInfo.allLeaveDates,
    },
    // Task #508: surface late rules + approved leaves để frontend resolve màu calendar
    lateRules: lateRules.map(lr => ({
      lateFromTime: lr.lateFromTime ?? null,
      lateToTime: lr.lateToTime ?? null,
      penaltyAmount: lr.penaltyAmount ? parseFloat(String(lr.penaltyAmount)) : 0,
    })),
    approvedLeaves: leaveInfo.allLeaveDates.map(d => ({ date: d })),
    showDayDates: [...showDayDates].sort(),
    todayMode: await (async () => {
      const t = todayVN();
      const hasBooking = showDayDates.has(t);
      return resolveAttendanceMode({
        hasBooking,
        isLeaveExcused: leaveInfo.excused.has(t),
        isWeekend: isSundayOff(t),
      });
    })(),
    todayBookings: await getBookingsForStaffOnDate(callerId, todayVN()),
  });
});

// ── Admin: xem tất cả nhân viên theo tháng ───────────────────────────────────
router.get("/attendance/admin", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const month = String(req.query.month || todayVN().slice(0, 7));
  const logsR = await pool.query(
    `SELECT al.id, al.staff_id, al.type, al.method, al.lat, al.lng, al.accuracy_m, al.distance_m, al.booking_id, al.work_type, al.notes, al.checkin_photo_url, al.created_at,
            to_char(al.created_at + interval '7 hours', 'HH24:MI') as local_time,
            to_char(al.created_at + interval '7 hours', 'YYYY-MM-DD') as local_date,
            s.name as staff_name
     FROM attendance_logs al
     JOIN staff s ON s.id = al.staff_id
     WHERE to_char(al.created_at + interval '7 hours', 'YYYY-MM') = $1 ORDER BY al.created_at`,
    [month]
  );
  const mappedRows = (logsR.rows as Record<string, unknown>[]).map(l => ({
    id: l.id as number,
    staffId: l.staff_id,
    staffName: l.staff_name,
    type: l.type,
    method: l.method,
    lat: l.lat,
    lng: l.lng,
    accuracyM: l.accuracy_m,
    distanceM: l.distance_m,
    bookingId: l.booking_id,
    workType: inferWorkType(l.method as string | null, l.work_type as string | null),
    isOffsite: l.method === "offsite",
    notes: l.notes,
    checkinPhotoUrl: (l.checkin_photo_url as string | null) ?? null,
    localTime: l.local_time as string,
    localDate: l.local_date as string,
    createdAt: l.created_at instanceof Date ? (l.created_at as Date).toISOString() : String(l.created_at ?? ""),
  }));
  const overrideMap = await loadOverrides(mappedRows.map(r => r.id));
  const withOverrides = mappedRows.map(r => {
    const ov = overrideMap.get(r.id);
    if (!ov) return { ...r, override: null };
    return {
      ...r,
      localTime: ov.overrideTime ?? r.localTime,
      override: { time: ov.overrideTime, isLate: ov.overrideIsLate, reason: ov.reason, createdByName: ov.createdByName, createdAt: ov.createdAt },
    };
  });

  // Leave-aware: gắn map ngày leave approved (cap 2) cho từng staff để UI ẩn cảnh báo trễ/vắng.
  const staffIds = [...new Set(mappedRows.map(r => Number(r.staffId)))];
  const leaveByStaff: Record<string, { excused: string[]; allLeaveDates: string[]; used: number; cap: number }> = {};
  const excusedSetByStaff = new Map<number, Set<string>>();
  for (const sid of staffIds) {
    const info = await getExcusedLeaveDates(sid, month);
    leaveByStaff[String(sid)] = {
      excused: [...info.excused],
      allLeaveDates: info.allLeaveDates,
      used: info.used,
      cap: info.cap,
    };
    excusedSetByStaff.set(sid, info.excused);
  }
  // Backward-compat: vẫn trả về array (consumer cũ). Đính kèm `isLeaveExcused` per-row.
  const enriched = withOverrides.map(r => {
    const set = excusedSetByStaff.get(Number(r.staffId));
    return { ...r, isLeaveExcused: !!(set && set.has(r.localDate)) };
  });
  // Trả về array với thuộc tính phụ `leaveByStaff` (qua header), giữ shape tương thích.
  res.setHeader("X-Leave-By-Staff", JSON.stringify(leaveByStaff));
  res.json(enriched);
});

// ── Today summary: dashboard cards ───────────────────────────────────────────
router.get("/attendance/today-summary", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const today = todayVN();

  const [rule] = await db.select().from(attendanceRulesTable).where(eq(attendanceRulesTable.isActive, 1));
  const ruleCheckInTo = rule?.checkInTo ?? "08:10";

  // Today's check-ins / outs (unique by staff)
  const logsR = await pool.query(
    `SELECT id, staff_id, type, method, work_type,
            to_char(created_at + interval '7 hours', 'HH24:MI') as local_time
     FROM attendance_logs
     WHERE (created_at + interval '7 hours')::date = $1::date
     ORDER BY created_at ASC`,
    [today]
  );
  type Row = { id: number; staff_id: number; type: string; method: string | null; work_type: string | null; local_time: string };
  const rows = logsR.rows as Row[];
  const overrideMap = await loadOverrides(rows.map(r => r.id));

  const checkInByStaff = new Map<number, Row>();
  const checkOutSet = new Set<number>();
  for (const r of rows) {
    const ov = overrideMap.get(r.id);
    const effective: Row = ov?.overrideTime ? { ...r, local_time: ov.overrideTime } : r;
    if (effective.type === "check_in" && !checkInByStaff.has(effective.staff_id)) checkInByStaff.set(effective.staff_id, effective);
    if (effective.type === "check_out") checkOutSet.add(effective.staff_id);
  }

  const showDayStaffIds = await getShowDayStaffIdsForDate(today);
  const isTodayOff = isSundayOff(today);

  const activeStaffR = await pool.query<{ id: number; name: string; role: string }>(
    `SELECT id, name, role FROM staff WHERE is_active = 1 ORDER BY name`,
  );
  const activeStaffList = activeStaffR.rows;

  let daVao = 0;
  let chuaVao = 0;
  let diTre = 0;
  let dangDiShow = 0;
  let chuaCheckOut = 0;
  let showDayCount = 0;
  let studioDayCount = 0;
  let offDayCount = 0;
  const notCheckedInStudio: typeof activeStaffList = [];
  const showDayStaff: Array<{ id: number; name: string; role: string; checkedIn: boolean; checkInTime?: string }> = [];

  for (const staff of activeStaffList) {
    const hasShowBooking = showDayStaffIds.has(staff.id);
    const mode: AttendanceMode = resolveAttendanceMode({
      hasBooking: hasShowBooking,
      isLeaveExcused: false,
      isWeekend: isTodayOff,
    });

    if (mode === "OFF") {
      offDayCount++;
      continue;
    }
    if (mode === "SHOW") {
      showDayCount++;
      const ci = checkInByStaff.get(staff.id);
      showDayStaff.push({
        id: staff.id,
        name: staff.name,
        role: staff.role,
        checkedIn: !!ci,
        checkInTime: ci?.local_time,
      });
      if (ci) {
        daVao++;
        if (!checkOutSet.has(staff.id)) chuaCheckOut++;
        const wt = inferWorkType(ci.method, ci.work_type);
        if ((wt === "di_show" || wt === "makeup_ngoai") && !checkOutSet.has(staff.id)) dangDiShow++;
      }
      continue;
    }

    // STUDIO mode
    studioDayCount++;
    const ci = checkInByStaff.get(staff.id);
    if (ci) {
      daVao++;
      const ov = overrideMap.get(ci.id);
      const shift = await getShiftForDate(staff.id, today);
      const effThreshold = shift.source === "override" ? shift.startTime : ruleCheckInTo;
      const computedLate = ci.local_time > effThreshold;
      const effLate = ov?.overrideIsLate === 0 ? false : ov?.overrideIsLate === 1 ? true : computedLate;
      if (effLate) diTre++;
      if (!checkOutSet.has(staff.id)) chuaCheckOut++;
    } else {
      chuaVao++;
      notCheckedInStudio.push(staff);
    }
  }

  res.json({
    daVao, chuaVao, diTre, dangDiShow, chuaCheckOut,
    showDayCount, studioDayCount, offDayCount,
    activeStaff: activeStaffList.length, checkInTo: ruleCheckInTo,
    showDayStaffIds: [...showDayStaffIds],
    showDayStaff,
    notCheckedIn: notCheckedInStudio,
  });
});

// ── Staff summary: monthly stats for profile page ────────────────────────────
router.get("/attendance/staff-summary", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));

  const parsed = req.query.staffId ? parseInt(String(req.query.staffId)) : NaN;
  const requested = !isNaN(parsed) && parsed > 0 ? parsed : callerId;
  const staffId = isAdmin ? requested : callerId;
  const month = String(req.query.month || todayVN().slice(0, 7));

  const [rule] = await db.select().from(attendanceRulesTable).where(eq(attendanceRulesTable.isActive, 1));
  const lateRules = rule
    ? await db.select().from(attendanceLateRulesTable)
        .where(eq(attendanceLateRulesTable.ruleId, rule.id))
        .orderBy(attendanceLateRulesTable.lateFromTime)
    : [];
  const ruleCheckInTo = rule?.checkInTo ?? "08:10";
  // Task #505: ca làm theo ngày cho staff này
  const shiftMap = await getShiftsForMonth(staffId, month);

  const logsR = await pool.query(
    `SELECT id, type, method, work_type,
            to_char(created_at + interval '7 hours', 'HH24:MI') as local_time,
            to_char(created_at + interval '7 hours', 'YYYY-MM-DD') as local_date
     FROM attendance_logs
     WHERE staff_id = $1 AND to_char(created_at + interval '7 hours', 'YYYY-MM') = $2
     ORDER BY created_at`,
    [staffId, month]
  );
  type Row = { id: number; type: string; method: string | null; work_type: string | null; local_time: string; local_date: string };
  const rows = logsR.rows as Row[];
  const overrideMap = await loadOverrides(rows.map(r => r.id));

  const ciByDate = new Map<string, Row & { override?: LogOverride }>();
  const coDates = new Set<string>();
  for (const r of rows) {
    const ov = overrideMap.get(r.id);
    const eff: Row & { override?: LogOverride } = ov?.overrideTime
      ? { ...r, local_time: ov.overrideTime, override: ov }
      : { ...r, override: ov };
    if (eff.type === "check_in" && !ciByDate.has(eff.local_date)) ciByDate.set(eff.local_date, eff);
    if (eff.type === "check_out") coDates.add(eff.local_date);
  }

  // Leave-aware: bỏ qua tính trễ/vắng cho ngày leave approved (cap 2)
  const leaveInfo = await getExcusedLeaveDates(staffId, month);
  const showDayDates = await getShowDayDatesForStaff(staffId, month);

  const totalDays = ciByDate.size;
  let lateCount = 0;
  let missedCheckout = 0;
  let showCount = 0;
  let totalLatePenalty = 0;
  for (const [date, ci] of ciByDate) {
    if (leaveInfo.excused.has(date)) continue;
    const mode = resolveAttendanceMode({
      hasBooking: showDayDates.has(date),
      isLeaveExcused: leaveInfo.excused.has(date),
      isWeekend: isSundayOff(date),
    });
    if (!studioLatePenaltyApplies(mode)) {
      if (!coDates.has(date)) missedCheckout++;
      const wt = inferWorkType(ci.method, ci.work_type);
      if (wt === "di_show" || wt === "makeup_ngoai" || mode === "SHOW") showCount++;
      continue;
    }
    const sh = shiftMap.get(date);
    const effThreshold = sh ? sh.startTime : ruleCheckInTo;
    const computed = findPenalty(ci.local_time, effThreshold, lateRules);
    const ov = ci.override;
    const isLate = ov?.overrideIsLate === 0 ? false : ov?.overrideIsLate === 1 ? true : computed.isLate;
    if (isLate) lateCount++;
    if (isLate && computed.penalty > 0) totalLatePenalty += computed.penalty;
    if (!coDates.has(date)) missedCheckout++;
    const wt = inferWorkType(ci.method, ci.work_type);
    if (wt === "di_show" || wt === "makeup_ngoai") showCount++;
  }
  const onTimeRate = totalDays > 0 ? Math.round(((totalDays - lateCount) / totalDays) * 100) : 0;

  const adjR = await pool.query(
    `SELECT a.id, a.date, a.type, a.category, a.amount, a.reason, s.name as created_by_name, a.created_at
     FROM attendance_adjustments a
     LEFT JOIN staff s ON s.id = a.created_by
     WHERE a.staff_id = $1 AND to_char(a.date::timestamp, 'YYYY-MM') = $2
     ORDER BY a.date`,
    [staffId, month]
  );
  const adjustments = (adjR.rows as Record<string, unknown>[]).map(a => ({
    id: a.id,
    date: typeof a.date === "string" ? a.date : (a.date instanceof Date ? a.date.toISOString().slice(0, 10) : String(a.date)),
    type: a.type as string,
    category: (a.category as string | null) ?? null,
    amount: parseFloat(String(a.amount ?? "0")),
    reason: (a.reason as string | null) ?? null,
    createdByName: (a.created_by_name as string | null) ?? null,
    createdAt: String(a.created_at ?? ""),
  }));
  let totalBonusAdj = 0;
  let totalPenaltyAdj = 0;
  for (const a of adjustments) {
    if (a.type === "bonus") totalBonusAdj += a.amount;
    else if (a.type === "penalty") totalPenaltyAdj += a.amount;
  }
  const totalBonus = totalBonusAdj;
  const totalPenalty = totalLatePenalty + totalPenaltyAdj;
  const net = totalBonus - totalPenalty;

  // Task #508: surface OT byDate + late rules + approved leaves cho visual calendar
  const otRate2 = parseFloat(String(rule?.overtimeRatePerHour ?? "30000"));
  const otLogsR = await pool.query(
    `SELECT type, to_char(created_at + interval '7 hours', 'HH24:MI') as time,
            to_char(created_at + interval '7 hours', 'YYYY-MM-DD') as date
     FROM attendance_logs
     WHERE staff_id = $1 AND to_char(created_at + interval '7 hours', 'YYYY-MM') = $2
       AND type IN ('overtime_check_in','overtime_check_out')
     ORDER BY created_at`, [staffId, month]);
  const otMonth = computeOvertimeForMonth(
    (otLogsR.rows as { type: string; time: string; date: string }[]).map(r => ({ date: r.date, type: r.type, time: r.time })),
    otRate2,
  );
  // Logs đầy đủ để LogDetailDialog render được
  const fullLogsR = await pool.query(
    `SELECT id, staff_id, type, method, work_type, lat, lng, distance_m, notes, checkin_photo_url, created_at,
            to_char(created_at + interval '7 hours', 'HH24:MI') as local_time,
            to_char(created_at + interval '7 hours', 'YYYY-MM-DD') as local_date
     FROM attendance_logs WHERE staff_id = $1 AND to_char(created_at + interval '7 hours', 'YYYY-MM') = $2
     ORDER BY created_at`, [staffId, month]);
  const fullLogs = (fullLogsR.rows as Record<string, unknown>[]).map(l => ({
    id: l.id, staffId: l.staff_id, type: l.type, method: l.method,
    workType: inferWorkType(l.method as string | null, l.work_type as string | null),
    isOffsite: l.method === "offsite",
    lat: l.lat, lng: l.lng, distanceM: l.distance_m != null ? parseFloat(String(l.distance_m)) : null,
    notes: l.notes, checkinPhotoUrl: (l.checkin_photo_url as string | null) ?? null,
    localTime: l.local_time, localDate: l.local_date,
    createdAt: l.created_at instanceof Date ? l.created_at.toISOString() : String(l.created_at ?? ""),
  }));

  res.json({
    staffId, month,
    totalDays, lateCount, missedCheckout, showCount, onTimeRate,
    totalPenalty, totalBonus, net,
    adjustments,
    checkInTo: ruleCheckInTo,
    shifts: Object.fromEntries([...shiftMap.entries()].map(([d, s]) => [d, {
      name: s.name, startTime: s.startTime, endTime: s.endTime,
      standardHours: s.standardHours, flexibleBreakHours: s.flexibleBreakHours,
      source: s.source, scope: s.scope,
    }])),
    leave: {
      used: leaveInfo.used,
      cap: leaveInfo.cap,
      excusedDates: [...leaveInfo.excused],
      allLeaveDates: leaveInfo.allLeaveDates,
    },
    // Task #508
    lateRules: lateRules.map(lr => ({
      lateFromTime: lr.lateFromTime ?? null,
      lateToTime: lr.lateToTime ?? null,
      penaltyAmount: lr.penaltyAmount ? parseFloat(String(lr.penaltyAmount)) : 0,
    })),
    approvedLeaves: leaveInfo.allLeaveDates.map(d => ({ date: d })),
    showDayDates: [...showDayDates].sort(),
    overtimeByDate: otMonth.byDate.filter(d => d.hours > 0).map(d => ({ date: d.date, hours: d.hours, amount: d.pay })),
    logs: fullLogs,
  });
});

// ── Task #508: Team matrix extras (admin) ───────────────────────────────────
// Trả về data per-staff (leaves, overtime) để frontend ghép vào team grid
// dùng cùng resolveDayStatus như per-staff calendar.
router.get("/attendance/team-extras", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const month = String(req.query.month || todayVN().slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;

  // Approved leaves all staff in month
  const lvR = await pool.query<{ staff_id: number; start_date: string; end_date: string; reason: string }>(`
    SELECT staff_id, to_char(start_date,'YYYY-MM-DD') as start_date,
           to_char(end_date,'YYYY-MM-DD') as end_date, reason
    FROM staff_leave_requests
    WHERE status = 'approved' AND start_date <= $2::date AND end_date >= $1::date
  `, [monthStart, monthEnd]);
  const staffLeaves: Record<string, { date: string; reason: string }[]> = {};
  for (const row of lvR.rows) {
    const s = row.start_date > monthStart ? row.start_date : monthStart;
    const e = row.end_date < monthEnd ? row.end_date : monthEnd;
    const sd = new Date(s), ed = new Date(e);
    for (let d = new Date(sd); d <= ed; d.setDate(d.getDate() + 1)) {
      const key = String(row.staff_id);
      (staffLeaves[key] ||= []).push({ date: d.toISOString().slice(0, 10), reason: row.reason });
    }
  }

  // Overtime per staff
  const [rule] = await db.select().from(attendanceRulesTable).where(eq(attendanceRulesTable.isActive, 1));
  const otRate = parseFloat(String(rule?.overtimeRatePerHour ?? "30000"));
  const ruleCheckInTo = rule?.checkInTo ?? "08:10";
  const lateRules = rule
    ? await db.select().from(attendanceLateRulesTable)
        .where(eq(attendanceLateRulesTable.ruleId, rule.id))
        .orderBy(attendanceLateRulesTable.lateFromTime)
    : [];

  const otR = await pool.query<{ staff_id: number; type: string; date: string; time: string }>(`
    SELECT staff_id, type,
           to_char(created_at + interval '7 hours','YYYY-MM-DD') as date,
           to_char(created_at + interval '7 hours','HH24:MI') as time
    FROM attendance_logs
    WHERE to_char(created_at + interval '7 hours','YYYY-MM') = $1
      AND type IN ('overtime_check_in','overtime_check_out')
    ORDER BY created_at`, [month]);
  const otByStaff = new Map<number, { date: string; type: string; time: string }[]>();
  for (const r of otR.rows) {
    const arr = otByStaff.get(r.staff_id) ?? [];
    arr.push({ date: r.date, type: r.type, time: r.time });
    otByStaff.set(r.staff_id, arr);
  }
  const staffOvertime: Record<string, { date: string; hours: number; amount: number }[]> = {};
  for (const [sid, logs] of otByStaff) {
    const res2 = computeOvertimeForMonth(logs, otRate);
    staffOvertime[String(sid)] = res2.byDate.filter(d => d.hours > 0).map(d => ({ date: d.date, hours: d.hours, amount: d.pay }));
  }

  // Shift overrides trong tháng — để TeamCalendar resolve per-staff/per-day shiftStart đúng.
  const soR = await pool.query<{ date: string; scope: string; start_time: string; staff_ids: number[] | null }>(`
    SELECT to_char(o.date,'YYYY-MM-DD') as date, o.scope, o.start_time,
           COALESCE((SELECT array_agg(staff_id) FROM attendance_shift_override_staff WHERE override_id = o.id), NULL) as staff_ids
    FROM attendance_shift_overrides o
    WHERE o.date BETWEEN $1::date AND $2::date
    ORDER BY o.date, o.created_at DESC
  `, [monthStart, monthEnd]);
  const shiftOverrides = soR.rows.map(r => ({
    date: r.date, scope: r.scope, startTime: r.start_time,
    staffIds: Array.isArray(r.staff_ids) ? r.staff_ids : [],
  }));

  const adjR = await pool.query<{ staff_id: number; date: string; type: string; category: string | null; amount: string; reason: string | null; created_by_name: string | null; created_at: string; id: number }>(`
    SELECT a.id, a.staff_id, to_char(a.date,'YYYY-MM-DD') as date, a.type, a.category, a.amount, a.reason,
           c.name as created_by_name, a.created_at::text as created_at
    FROM attendance_adjustments a
    LEFT JOIN staff c ON c.id = a.created_by
    WHERE to_char(a.date,'YYYY-MM') = $1
    ORDER BY a.date, a.created_at`, [month]);
  const staffWaivers: Record<string, Record<string, { amount: number; reason: string | null; createdByName: string | null; createdAt: string }>> = {};
  const staffAdjustments: Record<string, Array<{ id: number; date: string; type: string; category: string | null; amount: number; reason: string | null; createdByName: string | null; createdAt: string }>> = {};
  for (const row of adjR.rows) {
    const sid = String(row.staff_id);
    const amt = parseFloat(String(row.amount ?? "0"));
    const item = {
      id: row.id,
      date: row.date,
      type: row.type,
      category: row.category,
      amount: amt,
      reason: row.reason,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
    };
    (staffAdjustments[sid] ||= []).push(item);
    if (row.category === "waiver") {
      (staffWaivers[sid] ||= {})[row.date] = {
        amount: amt,
        reason: row.reason,
        createdByName: row.created_by_name,
        createdAt: row.created_at,
      };
    }
  }

  const staffIdsR = await pool.query<{ id: number }>(`SELECT id FROM staff WHERE is_active = 1`);
  const allStaffIds = staffIdsR.rows.map(r => r.id);
  const showDaysByStaff = await getShowDayDatesByStaffForMonth(allStaffIds, month);
  const staffShowDays: Record<string, string[]> = {};
  for (const [sid, dates] of showDaysByStaff) {
    if (dates.size > 0) staffShowDays[String(sid)] = [...dates].sort();
  }

  res.json({
    month,
    checkInTo: ruleCheckInTo,
    lateRules: lateRules.map(lr => ({
      lateFromTime: lr.lateFromTime ?? null,
      lateToTime: lr.lateToTime ?? null,
      penaltyAmount: lr.penaltyAmount ? parseFloat(String(lr.penaltyAmount)) : 0,
    })),
    staffLeaves,
    staffOvertime,
    shiftOverrides,
    staffWaivers,
    staffAdjustments,
    staffShowDays,
  });
});

// ── Quy tắc chấm công ────────────────────────────────────────────────────────
router.get("/attendance/rules", async (req, res) => {
  // Read-only: bất kỳ nhân viên đã đăng nhập đều xem được rules (admin mới được sửa).
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const [activeRule] = await db.select().from(attendanceRulesTable).where(eq(attendanceRulesTable.isActive, 1));
  const late = activeRule
    ? await db.select().from(attendanceLateRulesTable)
        .where(eq(attendanceLateRulesTable.ruleId, activeRule.id))
        .orderBy(attendanceLateRulesTable.lateFromTime)
    : [];
  const fmtLate = late.map(l => ({
    id: l.id,
    ruleId: l.ruleId,
    lateFromTime: l.lateFromTime ?? "08:00",
    lateToTime: l.lateToTime ?? null,
    penaltyAmount: l.penaltyAmount ? parseFloat(String(l.penaltyAmount)) : null,
  }));
  const rule = activeRule ? {
    id: activeRule.id,
    name: activeRule.name,
    checkinStartTime: activeRule.checkInFrom ?? "07:30",
    checkinEndTime: activeRule.checkInTo ?? "08:10",
    workStartTime: "08:00",
    checkoutTime: "17:30",
    weeklyBonusAmount: parseFloat(String(activeRule.weeklyOnTimeBonus ?? "50000")),
    // Task #504
    overtimeRatePerHour: parseFloat(String(activeRule.overtimeRatePerHour ?? "30000")),
    isActive: activeRule.isActive,
  } : null;
  res.json({ rule, lateRules: fmtLate });
});

router.put("/attendance/rules", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const { name, checkInFrom, checkInTo, weeklyOnTimeBonus, overtimeRatePerHour, lateRules } = req.body;
  const [existing] = await db.select().from(attendanceRulesTable).where(eq(attendanceRulesTable.isActive, 1));

  // Task #504: validate overtime rate nếu được gửi
  let otRateStr: string | undefined;
  if (overtimeRatePerHour !== undefined && overtimeRatePerHour !== null && String(overtimeRatePerHour) !== "") {
    const v = parseFloat(String(overtimeRatePerHour));
    if (Number.isNaN(v) || v < 0) {
      return res.status(400).json({ error: "Đơn giá tăng ca không hợp lệ" });
    }
    otRateStr = String(v);
  }

  let rule;
  if (existing) {
    [rule] = await db.update(attendanceRulesTable)
      .set({ name: name ?? existing.name, checkInFrom: checkInFrom ?? existing.checkInFrom,
             checkInTo: checkInTo ?? existing.checkInTo,
             weeklyOnTimeBonus: String(weeklyOnTimeBonus ?? existing.weeklyOnTimeBonus),
             overtimeRatePerHour: otRateStr ?? String(existing.overtimeRatePerHour ?? "30000") })
      .where(eq(attendanceRulesTable.id, existing.id)).returning();
  } else {
    [rule] = await db.insert(attendanceRulesTable)
      .values({ name: name || "Mặc định", checkInFrom: checkInFrom || "07:30",
                checkInTo: checkInTo || "08:10",
                weeklyOnTimeBonus: String(weeklyOnTimeBonus || "50000"),
                overtimeRatePerHour: otRateStr ?? "30000" })
      .returning();
  }

  if (Array.isArray(lateRules) && rule) {
    await db.delete(attendanceLateRulesTable).where(eq(attendanceLateRulesTable.ruleId, rule.id));
    for (const lr of lateRules) {
      await db.insert(attendanceLateRulesTable).values({
        ruleId: rule.id,
        lateFromTime: String(lr.lateFromTime ?? "08:00"),
        lateToTime: lr.lateToTime ? String(lr.lateToTime) : null,
        penaltyAmount: lr.penaltyAmount ? String(lr.penaltyAmount) : null,
      });
    }
  }

  res.json({ rule, lateRules: lateRules || [] });
});

// ── Điều chỉnh thủ công ───────────────────────────────────────────────────────
router.get("/attendance/adjustments", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const callerIsAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));

  const parsedStaffId = req.query.staffId ? parseInt(String(req.query.staffId)) : NaN;
  const requestedStaffId = (!isNaN(parsedStaffId) && parsedStaffId > 0) ? parsedStaffId : callerId;
  const staffId = callerIsAdmin ? requestedStaffId : callerId;
  const month = String(req.query.month || todayVN().slice(0, 7));

  const adj = await pool.query(
    `SELECT aa.*, s.name as staff_name, c.name as created_by_name
     FROM attendance_adjustments aa
     LEFT JOIN staff s ON s.id = aa.staff_id
     LEFT JOIN staff c ON c.id = aa.created_by
     WHERE aa.staff_id = $1 AND to_char(aa.date, 'YYYY-MM') = $2 ORDER BY aa.date`,
    [staffId, month]
  );
  res.json(adj.rows);
});

// ── Override 1 log cụ thể (admin sửa giờ/trạng thái có lý do bắt buộc) ───────
router.post("/attendance/logs/:id/override", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const logId = parseInt(String(req.params.id));
  if (!logId || Number.isNaN(logId)) return res.status(400).json({ error: "log id không hợp lệ" });
  const { overrideTime, overrideIsLate, reason } = req.body || {};
  const trimmedReason = String(reason || "").trim();
  if (trimmedReason.length < 5) return res.status(400).json({ error: "Lý do phải ít nhất 5 ký tự" });

  // Validate the log exists
  const exists = await pool.query(`SELECT id FROM attendance_logs WHERE id = $1`, [logId]);
  if (exists.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy log" });

  // Validate overrideTime format HH:MM if provided
  let timeVal: string | null = null;
  if (overrideTime !== undefined && overrideTime !== null && String(overrideTime).trim() !== "") {
    const t = String(overrideTime).trim();
    if (!/^\d{2}:\d{2}$/.test(t)) return res.status(400).json({ error: "Giờ override không hợp lệ (HH:MM)" });
    timeVal = t;
  }
  let isLateVal: number | null = null;
  if (overrideIsLate === 0 || overrideIsLate === false) isLateVal = 0;
  else if (overrideIsLate === 1 || overrideIsLate === true) isLateVal = 1;

  const [ov] = await db.insert(attendanceLogOverridesTable).values({
    logId,
    overrideTime: timeVal,
    overrideIsLate: isLateVal,
    reason: trimmedReason,
    createdBy: callerId,
  }).returning();
  res.status(201).json(ov);
});

// ── Gỡ phạt đi trễ cả ngày (tạo bonus adjustment category=waiver) ────────────
router.post("/attendance/penalty-waiver", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const { staffId, date, reason } = req.body || {};
  if (!staffId || !date) return res.status(400).json({ error: "Thiếu nhân viên hoặc ngày" });
  const trimmedReason = String(reason || "").trim();
  if (trimmedReason.length < 5) return res.status(400).json({ error: "Lý do phải ít nhất 5 ký tự" });
  const staffIdNum = parseInt(String(staffId));
  const dateStr = String(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: "Ngày không hợp lệ (YYYY-MM-DD)" });

  // Find that day's check-in for the staff (VN tz) → compute penalty
  const ciR = await pool.query(
    `SELECT id, to_char(created_at + interval '7 hours', 'HH24:MI') as local_time
     FROM attendance_logs
     WHERE staff_id = $1 AND type = 'check_in'
       AND (created_at + interval '7 hours')::date = $2::date
     ORDER BY created_at ASC LIMIT 1`,
    [staffIdNum, dateStr]
  );
  if (ciR.rows.length === 0) return res.status(400).json({ error: "Không tìm thấy check-in ngày này" });
  const ci = ciR.rows[0] as { id: number; local_time: string };

  const [rule] = await db.select().from(attendanceRulesTable).where(eq(attendanceRulesTable.isActive, 1));
  const lateRules = rule
    ? await db.select().from(attendanceLateRulesTable)
        .where(eq(attendanceLateRulesTable.ruleId, rule.id))
        .orderBy(attendanceLateRulesTable.lateFromTime)
    : [];
  const ruleCheckInTo = rule?.checkInTo ?? "08:10";
  // Task #505: dùng shift của staff cho ngày này
  const shift = await getShiftForDate(staffIdNum, dateStr);
  const effThreshold = shift.source === "override" ? shift.startTime : ruleCheckInTo;
  // Use effective time + isLate (honor override)
  const ovMap = await loadOverrides([ci.id]);
  const ov = ovMap.get(ci.id);
  const effTime = ov?.overrideTime ?? ci.local_time;
  const computed = findPenalty(effTime, effThreshold, lateRules);
  const effIsLate = ov?.overrideIsLate === 0 ? false : ov?.overrideIsLate === 1 ? true : computed.isLate;
  if (!effIsLate || computed.penalty <= 0) {
    return res.status(400).json({ error: "Ngày này không có phạt đi trễ để gỡ" });
  }

  // Atomic dedup via INSERT ... ON CONFLICT on partial unique index (waiver per staff+date)
  const ins = await pool.query(
    `INSERT INTO attendance_adjustments (staff_id, date, type, category, amount, reason, created_by)
     VALUES ($1, $2, 'bonus', 'waiver', $3, $4, $5)
     ON CONFLICT (staff_id, date) WHERE category = 'waiver' DO NOTHING
     RETURNING *`,
    [staffIdNum, dateStr, String(computed.penalty), trimmedReason, callerId]
  );
  if (ins.rowCount === 0) {
    return res.status(400).json({ error: "Ngày này đã được gỡ phạt rồi" });
  }
  res.status(201).json(ins.rows[0]);
});

router.post("/attendance/adjustments", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const { staffId, date, type, amount, reason, category } = req.body;
  if (!staffId || !date || !type || amount === undefined) {
    return res.status(400).json({ error: "Thiếu thông tin" });
  }
  const trimmedReason = String(reason || "").trim();
  if (trimmedReason.length < 5) return res.status(400).json({ error: "Lý do phải ít nhất 5 ký tự" });
  const [adj] = await db.insert(attendanceAdjustmentsTable).values({
    staffId: parseInt(String(staffId)), date, type,
    category: category || null,
    amount: String(Math.abs(parseFloat(String(amount)))),
    reason: trimmedReason, createdBy: callerId,
  }).returning();
  const detail = await pool.query(
    `SELECT a.*, c.name as created_by_name FROM attendance_adjustments a LEFT JOIN staff c ON c.id = a.created_by WHERE a.id = $1`,
    [adj.id]
  );
  res.status(201).json(detail.rows[0]);
});

// ── Admin sửa nhanh tiền phạt/thưởng (không đụng giờ chấm công) ─────────────
router.post("/attendance/money-edit", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const { staffId, date, action, amount, reason, systemPenalty } = req.body || {};
  if (!staffId || !date || !action || amount === undefined) {
    return res.status(400).json({ error: "Thiếu thông tin" });
  }
  const trimmedReason = String(reason || "").trim();
  if (trimmedReason.length < 5) return res.status(400).json({ error: "Lý do phải ít nhất 5 ký tự" });
  const dateStr = String(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: "Ngày không hợp lệ" });
  const staffIdNum = parseInt(String(staffId));
  const amt = Math.abs(parseFloat(String(amount)));
  if (!amt || amt <= 0) return res.status(400).json({ error: "Số tiền phải lớn hơn 0" });

  const auditNote = systemPenalty != null && systemPenalty > 0
    ? `${trimmedReason} [Hệ thống phạt: ${systemPenalty}đ → điều chỉnh: ${action === "penalty" ? "-" : "+"}${amt}đ]`
    : trimmedReason;

  if (action === "waiver") {
    // Gỡ phạt = thưởng bù (full waiver dùng category waiver nếu chưa có)
    const existing = await pool.query(
      `SELECT id FROM attendance_adjustments WHERE staff_id=$1 AND date=$2::date AND category='waiver' LIMIT 1`,
      [staffIdNum, dateStr]
    );
    const category = existing.rows.length === 0 && systemPenalty != null && amt >= systemPenalty ? "waiver" : "manual_edit";
    const [adj] = await db.insert(attendanceAdjustmentsTable).values({
      staffId: staffIdNum, date: dateStr, type: "bonus", category,
      amount: String(amt), reason: auditNote, createdBy: callerId,
    }).returning();
    const detail = await pool.query(
      `SELECT a.*, c.name as created_by_name FROM attendance_adjustments a LEFT JOIN staff c ON c.id = a.created_by WHERE a.id = $1`,
      [adj.id]
    );
    return res.status(201).json(detail.rows[0]);
  }
  if (action === "penalty") {
    const [adj] = await db.insert(attendanceAdjustmentsTable).values({
      staffId: staffIdNum, date: dateStr, type: "penalty", category: "manual_edit",
      amount: String(amt), reason: auditNote, createdBy: callerId,
    }).returning();
    const detail = await pool.query(
      `SELECT a.*, c.name as created_by_name FROM attendance_adjustments a LEFT JOIN staff c ON c.id = a.created_by WHERE a.id = $1`,
      [adj.id]
    );
    return res.status(201).json(detail.rows[0]);
  }
  if (action === "bonus") {
    const [adj] = await db.insert(attendanceAdjustmentsTable).values({
      staffId: staffIdNum, date: dateStr, type: "bonus", category: "manual_edit",
      amount: String(amt), reason: auditNote, createdBy: callerId,
    }).returning();
    const detail = await pool.query(
      `SELECT a.*, c.name as created_by_name FROM attendance_adjustments a LEFT JOIN staff c ON c.id = a.created_by WHERE a.id = $1`,
      [adj.id]
    );
    return res.status(201).json(detail.rows[0]);
  }
  return res.status(400).json({ error: "action không hợp lệ (waiver|penalty|bonus)" });
});

// ── Manual check-in by admin ───────────────────────────────────────────────────
router.post("/attendance/manual", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });

  const { staffId, type = "check_in", workType, notes } = req.body;
  const wt = workType && VALID_WORK_TYPES.has(String(workType)) ? String(workType) : null;
  const [log] = await db.insert(attendanceLogsTable).values({
    staffId: parseInt(String(staffId)), type, method: "manual",
    workType: wt,
    notes: notes || null,
  }).returning();
  res.status(201).json(log);
});

export default router;
