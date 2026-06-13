import { pgTable, serial, text, timestamp, integer, date, numeric, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { bookingsTable } from "./bookings";
import { servicePackagesTable } from "./pricing";

export const staffTable = pgTable("staff", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  role: text("role").notNull().default("assistant"),
  roles: jsonb("roles").notNull().default([]),
  email: text("email"),
  avatar: text("avatar"),
  banner: text("banner"),
  coverImageUrl: text("cover_image_url"),
  salary: text("salary"),
  baseSalaryAmount: numeric("base_salary_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  salaryType: text("salary_type").notNull().default("fixed"),
  commissionRate: numeric("commission_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  joinDate: date("join_date"),
  isActive: integer("is_active").notNull().default(1),
  status: text("status").notNull().default("active"), // active | inactive | probation
  staffType: text("staff_type").notNull().default("official"),
  // Nút gạt "Tính chấm công": chỉ NV chính thức + bật mới vào lịch/thống kê chấm công
  attendanceEnabled: boolean("attendance_enabled").notNull().default(true),
  notes: text("notes"),
  username: text("username"),
  passwordHash: text("password_hash"),
  color: text("color"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category").notNull().default("other"),
  assigneeId: integer("assignee_id").references(() => staffTable.id),
  bookingId: integer("booking_id").references(() => bookingsTable.id),
  servicePackageId: integer("service_package_id").references(() => servicePackagesTable.id),
  role: text("role"),          // photographer | makeup | photoshop | support | ...
  taskType: text("task_type"), // chup | makeup | pts | support | in | giao_file | goi_khach
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("todo"),
  dueDate: date("due_date"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  // Task #22: chi phí sản xuất của task này (tự tính từ staffRates khi tạo, có thể override)
  cost: numeric("cost", { precision: 12, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTaskSchema = createInsertSchema(tasksTable).omit({ id: true, createdAt: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;

export const insertStaffSchema = createInsertSchema(staffTable).omit({ id: true, createdAt: true });
export type InsertStaff = z.infer<typeof insertStaffSchema>;
export type StaffMember = typeof staffTable.$inferSelect;
