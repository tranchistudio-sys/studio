import { pgTable, serial, text, timestamp, integer, numeric, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { staffTable } from "./tasks";
import { bookingsTable } from "./bookings";
import { servicePackagesTable } from "./pricing";
import { payrollsTable } from "./payrolls";

// ─── Default salary rates per service × role ─────────────────────────────────
// serviceKey = free-text service name OR "default" for fallback
export const staffSalaryRatesTable = pgTable("staff_salary_rates", {
  id: serial("id").primaryKey(),
  serviceKey: text("service_key").notNull(),
  serviceName: text("service_name").notNull(),
  role: text("role").notNull(),
  rate: numeric("rate", { precision: 12, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Per-staff overrides (individual rate different from default) ──────────────
export const staffSalaryOverridesTable = pgTable("staff_salary_overrides", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  serviceKey: text("service_key").notNull(),
  role: text("role").notNull(),
  rate: numeric("rate", { precision: 12, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Per-job earnings (auto-generated when booking → completed) ───────────────
export const staffJobEarningsTable = pgTable("staff_job_earnings", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull().references(() => bookingsTable.id, { onDelete: "cascade" }),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  serviceKey: text("service_key").notNull().default(""),
  serviceName: text("service_name").notNull().default(""),
  rate: numeric("rate", { precision: 12, scale: 2 }).notNull().default("0"),
  earnedDate: date("earned_date").notNull(),
  month: integer("month").notNull(),
  year: integer("year").notNull(),
  status: text("status").notNull().default("pending"),
  payrollId: integer("payroll_id").references(() => payrollsTable.id, { onDelete: "set null" }),
  serviceBookingId: integer("service_booking_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Per-staff, per-role, per-task individual price list ─────────────────────
// This is the source of truth: each staff member has their own price per task.
// role = photographer/makeup/sale/photoshop/marketing
// taskKey = predefined task key (chup_cong, makeup_co_dau, sale_tron_goi, etc.)
// rate = null means "not set" (no rate configured yet)
// rateType = 'fixed' (VND amount) or 'percent' (% of booking total, for sale)
export const staffRatePricesTable = pgTable("staff_rate_prices", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  taskKey: text("task_key").notNull(),
  taskName: text("task_name").notNull(),
  rate: numeric("rate", { precision: 12, scale: 2 }),
  rateType: text("rate_type").notNull().default("fixed"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── KPI configuration ────────────────────────────────────────────────────────
export const staffKpiConfigTable = pgTable("staff_kpi_config", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").references(() => staffTable.id, { onDelete: "cascade" }),
  metric: text("metric").notNull().default("jobs_count"),
  targetValue: numeric("target_value", { precision: 12, scale: 2 }).notNull().default("0"),
  bonusAmount: numeric("bonus_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  period: text("period").notNull().default("monthly"),
  isActive: integer("is_active").notNull().default(1),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Per-show flexible allowances (phụ cấp linh hoạt) ───────────────────────
// Gắn với 1 booking + 1 staff. Không ảnh hưởng doanh thu / lợi nhuận booking;
// chỉ cộng vào lương nhân sự trong kỳ trả lương.
export const staffAllowancesTable = pgTable("staff_allowances", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull().references(() => bookingsTable.id, { onDelete: "cascade" }),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  // Task #487: role để gắn allowance vào đúng dòng nhân sự (nullable cho legacy rows)
  role: text("role"),
  // Task #487: optional reference to child service booking (multi-service contracts)
  serviceBookingId: integer("service_booking_id"),
  allowanceType: text("allowance_type").notNull(), // di_xa|tang_ca|xang_xe|gui_xe|an_uong|khac
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  note: text("note"),
  createdBy: integer("created_by").references(() => staffTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSalaryRateSchema = createInsertSchema(staffSalaryRatesTable).omit({ id: true, createdAt: true });
export type InsertSalaryRate = z.infer<typeof insertSalaryRateSchema>;
export type SalaryRate = typeof staffSalaryRatesTable.$inferSelect;

export const insertJobEarningSchema = createInsertSchema(staffJobEarningsTable).omit({ id: true, createdAt: true });
export type InsertJobEarning = z.infer<typeof insertJobEarningSchema>;
export type JobEarning = typeof staffJobEarningsTable.$inferSelect;

// ─── Staff cast rates per package ─────────────────────────────────────────────
// Cast là chi phí biến đổi theo: nhân viên + vai trò + gói dịch vụ (+ slot nếu gói có)
// key: staffId + role + packageId + slotKey → 1 mức cast duy nhất
export const staffCastRatesTable = pgTable("staff_cast_rates", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // photographer | makeup | photoshop | ...
  packageId: integer("package_id").notNull().references(() => servicePackagesTable.id, { onDelete: "cascade" }),
  // Slot nhân sự trong gói (vd gói 2 photo: 'traditional_photo' | 'reportage_photo')
  // để 1 gói chứa được 2 mức cast khác nhau cùng role. NULL = cast cấp role như
  // trước giờ — toàn bộ dữ liệu cũ giữ nguyên nghĩa, resolve không slot vẫn ra dòng NULL.
  slotKey: text("slot_key"),
  amount: numeric("amount", { precision: 12, scale: 2 }), // null = chưa nhập. Với rateType='percent' lưu giá trị % (vd 5 = 5%).
  rateType: text("rate_type").notNull().default("fixed"), // 'fixed' = VND cố định; 'percent' = % doanh thu (sale)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertStaffCastRateSchema = createInsertSchema(staffCastRatesTable).omit({ id: true, createdAt: true });
export type InsertStaffCastRate = z.infer<typeof insertStaffCastRateSchema>;
export type StaffCastRate = typeof staffCastRatesTable.$inferSelect;
