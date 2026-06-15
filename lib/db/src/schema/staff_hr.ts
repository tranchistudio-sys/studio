import { pgTable, serial, text, timestamp, integer, date, time } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { staffTable } from "./tasks";

// ─── Đơn xin nghỉ ─────────────────────────────────────────────────────────────
export const staffLeaveRequestsTable = pgTable("staff_leave_requests", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | cancelled
  approvedByName: text("approved_by_name"),
  reviewedAt: timestamp("reviewed_at"),
  notes: text("notes"),
  // v2 — backward-compatible (nullable + default) extras for the Calendar overlay flow
  leaveType: text("leave_type").default("off"), // off | di_hoc | viec_rieng | benh | khac
  session: text("session").default("full_day"), // full_day | morning | afternoon | custom
  startTime: time("start_time"),
  endTime: time("end_time"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertLeaveRequestSchema = createInsertSchema(staffLeaveRequestsTable).omit({ id: true, createdAt: true, reviewedAt: true });
export type InsertLeaveRequest = z.infer<typeof insertLeaveRequestSchema>;
export type LeaveRequest = typeof staffLeaveRequestsTable.$inferSelect;

// ─── Ghi chú nội bộ ────────────────────────────────────────────────────────────
export const staffInternalNotesTable = pgTable("staff_internal_notes", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  skillsStrong: text("skills_strong"),
  workNotes: text("work_notes"),
  internalRating: integer("internal_rating"),
  generalNotes: text("general_notes"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInternalNotesSchema = createInsertSchema(staffInternalNotesTable).omit({ id: true, updatedAt: true });
export type InsertInternalNotes = z.infer<typeof insertInternalNotesSchema>;
export type InternalNotes = typeof staffInternalNotesTable.$inferSelect;
