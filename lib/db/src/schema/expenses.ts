import { pgTable, serial, text, timestamp, integer, numeric, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { bookingsTable } from "./bookings";
import { staffTable } from "./tasks";

export const expensesTable = pgTable("expenses", {
  id: serial("id").primaryKey(),
  type: text("type").notNull().default("operational"),
  category: text("category").notNull(),
  // Task #363: phân loại chi phí theo mô hình tài chính chuẩn
  // direct = chi phí trực tiếp cho show; operating = vận hành; depreciation = khấu hao;
  // interest = lãi vay; loan_principal = trả gốc khoản vay (KHÔNG ảnh hưởng lợi nhuận)
  costClass: text("cost_class").notNull().default("operating"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  description: text("description").notNull(),
  bookingId: integer("booking_id").references(() => bookingsTable.id),
  paymentMethod: text("payment_method").notNull().default("cash"),
  expenseDate: date("expense_date").notNull(),
  // Task: Phiếu chi datetime — lưu thời điểm thật (ngày + giờ + phút) lúc chi tiền.
  // Mặc định = thời điểm tạo phiếu chi. expense_date được derive từ expenseAt
  // (theo Asia/Ho_Chi_Minh) để các thống kê hiện có vẫn hoạt động.
  expenseAt: timestamp("expense_at"),
  expenseCode: text("expense_code"),
  receiptUrl: text("receipt_url"),
  receiptUrls: text("receipt_urls").array().default([]),
  bankName: text("bank_name"),
  bankAccount: text("bank_account"),
  createdBy: text("created_by"),
  notes: text("notes"),
  // Task #12: phân quyền chi tiền
  status: text("status").notNull().default("approved"),          // submitted | approved | paid | rejected
  createdByStaffId: integer("created_by_staff_id").references(() => staffTable.id, { onDelete: "set null" }),
  approvedByStaffId: integer("approved_by_staff_id").references(() => staffTable.id, { onDelete: "set null" }),
  paidByStaffId: integer("paid_by_staff_id").references(() => staffTable.id, { onDelete: "set null" }),
  paidFrom: text("paid_from"),                                   // mom | owner | company
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertExpenseSchema = createInsertSchema(expensesTable).omit({ id: true, createdAt: true });
export type InsertExpense = z.infer<typeof insertExpenseSchema>;
export type Expense = typeof expensesTable.$inferSelect;
