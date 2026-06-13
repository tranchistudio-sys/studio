import { pgTable, serial, text, timestamp, integer, numeric, date, unique, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { staffTable } from "./tasks";
import { bookingsTable } from "./bookings";

// ─── Nhật ký chấm công ────────────────────────────────────────────────────────
// type: check_in | check_out
// method: qr | gps_auto | gps_selfie | offsite | manual
export const attendanceLogsTable = pgTable("attendance_logs", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("check_in"),
  method: text("method").notNull().default("qr"),
  lat: numeric("lat", { precision: 10, scale: 7 }),
  lng: numeric("lng", { precision: 10, scale: 7 }),
  accuracyM: numeric("accuracy_m", { precision: 8, scale: 2 }),
  distanceM: numeric("distance_m", { precision: 8, scale: 2 }),
  bookingId: integer("booking_id").references(() => bookingsTable.id, { onDelete: "set null" }),
  workType: text("work_type"), // studio | studio_auto | di_show | makeup_ngoai | hau_ky | linh_dong
  attendanceType: text("attendance_type"),
  locationVerified: boolean("location_verified").default(false).notNull(),
  selfieRequired: boolean("selfie_required").default(false).notNull(),
  qrRequired: boolean("qr_required").default(false).notNull(),
  notes: text("notes"),
  // ADD-ONLY: giữ lại để dev là superset của prod (không drop khi publish)
  checkinPhotoUrl: text("checkin_photo_url"),
  checkoutPhotoUrl: text("checkout_photo_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Quy tắc chấm công ────────────────────────────────────────────────────────
export const attendanceRulesTable = pgTable("attendance_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().default("Mặc định"),
  checkInFrom: text("check_in_from").notNull().default("07:30"),
  checkInTo: text("check_in_to").notNull().default("08:10"),
  weeklyOnTimeBonus: numeric("weekly_on_time_bonus", { precision: 12, scale: 2 }).notNull().default("50000"),
  // Task #504: đơn giá tăng ca / giờ (VND). Admin sửa được, default 30k.
  overtimeRatePerHour: numeric("overtime_rate_per_hour", { precision: 12, scale: 2 }).notNull().default("30000"),
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Quy tắc phạt đi muộn ─────────────────────────────────────────────────────
// lateFromTime / lateToTime: HH:mm format, e.g. "08:05"
// lateToTime = null means "from lateFromTime and beyond"
export const attendanceLateRulesTable = pgTable("attendance_late_rules", {
  id: serial("id").primaryKey(),
  ruleId: integer("rule_id").notNull().references(() => attendanceRulesTable.id, { onDelete: "cascade" }),
  lateFromTime: text("late_from_time").notNull().default("08:00"),
  lateToTime: text("late_to_time"),
  penaltyAmount: numeric("penalty_amount", { precision: 12, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Điều chỉnh thủ công ──────────────────────────────────────────────────────
// type: bonus | penalty | manual
// category: null (default) | "waiver" (gỡ phạt — admin huỷ phạt đi trễ)
export const attendanceAdjustmentsTable = pgTable("attendance_adjustments", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  type: text("type").notNull().default("bonus"),
  category: text("category"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  reason: text("reason"),
  createdBy: integer("created_by").references(() => staffTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Override layer cho từng log (admin sửa giờ/trạng thái có audit) ────────
// override_time: HH:MM, nếu set thì coi giờ này thay cho giờ thật của log
// override_is_late: 1=force late, 0=force on-time, null=dùng logic mặc định
export const attendanceLogOverridesTable = pgTable("attendance_log_overrides", {
  id: serial("id").primaryKey(),
  logId: integer("log_id").notNull().references(() => attendanceLogsTable.id, { onDelete: "cascade" }),
  overrideTime: text("override_time"),
  overrideIsLate: integer("override_is_late"),
  reason: text("reason").notNull(),
  createdBy: integer("created_by").references(() => staffTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Task #505: Ca làm linh hoạt theo ngày ─────────────────────────────────
// scope: 'all' áp dụng toàn bộ nhân viên; 'selected' chỉ áp cho staff trong bảng N-N.
export const attendanceShiftOverridesTable = pgTable("attendance_shift_overrides", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  name: text("name").notNull().default("Ca đặc biệt"),
  startTime: text("start_time").notNull(),  // HH:MM
  endTime: text("end_time").notNull(),      // HH:MM
  standardHours: numeric("standard_hours", { precision: 4, scale: 2 }).notNull().default("8"),
  flexibleBreakHours: numeric("flexible_break_hours", { precision: 4, scale: 2 }).notNull().default("2"),
  notes: text("notes"),
  scope: text("scope").notNull().default("all"), // 'all' | 'selected'
  createdBy: integer("created_by").references(() => staffTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const attendanceShiftOverrideStaffTable = pgTable("attendance_shift_override_staff", {
  id: serial("id").primaryKey(),
  overrideId: integer("override_id").notNull().references(() => attendanceShiftOverridesTable.id, { onDelete: "cascade" }),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
});

export type AttendanceShiftOverride = typeof attendanceShiftOverridesTable.$inferSelect;
export type AttendanceShiftOverrideStaff = typeof attendanceShiftOverrideStaffTable.$inferSelect;

// ─── Chốt công/lương theo tháng — ADD-ONLY: giữ lại để dev là superset của prod
export const attendanceMonthClosuresTable = pgTable("attendance_month_closures", {
  id: serial("id").primaryKey(),
  month: text("month").notNull(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id),
  staffName: text("staff_name").notNull().default(""),
  workDays: integer("work_days").notNull().default(0),
  onTimeCount: integer("on_time_count").notNull().default(0),
  lateCount: integer("late_count").notNull().default(0),
  latePenaltyTotal: numeric("late_penalty_total", { precision: 12, scale: 2 }).notNull().default("0"),
  forgotCheckoutPenaltyTotal: numeric("forgot_checkout_penalty_total", { precision: 12, scale: 2 }).notNull().default("0"),
  attendanceBonusTotal: numeric("attendance_bonus_total", { precision: 12, scale: 2 }).notNull().default("0"),
  overtimeHours: numeric("overtime_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  overtimePay: numeric("overtime_pay", { precision: 12, scale: 2 }).notNull().default("0"),
  netAmount: numeric("net_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  closedAt: timestamp("closed_at").notNull().defaultNow(),
  closedBy: integer("closed_by").references(() => staffTable.id, { onDelete: "set null" }),
  closedByName: text("closed_by_name"),
}, (t) => ({
  monthStaffUnique: unique("attendance_month_closures_month_staff_unique").on(t.month, t.staffId),
}));

export type AttendanceMonthClosure = typeof attendanceMonthClosuresTable.$inferSelect;

export const insertAttendanceLogSchema = createInsertSchema(attendanceLogsTable).omit({ id: true, createdAt: true });
export type InsertAttendanceLog = z.infer<typeof insertAttendanceLogSchema>;
export type AttendanceLog = typeof attendanceLogsTable.$inferSelect;

export const insertAttendanceRuleSchema = createInsertSchema(attendanceRulesTable).omit({ id: true, createdAt: true });
export type InsertAttendanceRule = z.infer<typeof insertAttendanceRuleSchema>;
export type AttendanceRule = typeof attendanceRulesTable.$inferSelect;
