import { pgTable, serial, text, timestamp, integer, numeric, date, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";

// "Báo giá tạm tính" — bảng giá nháp khách xem trước. Chỉ là thông tin
// tham khảo: không chiếm lịch, không hiện trong lịch show, không tính
// doanh thu chốt. Khi khách đồng ý → chuyển thành booking thật và lưu
// liên kết bookingId.
export const quotesTable = pgTable("quotes", {
  id: serial("id").primaryKey(),
  // customerId optional: cho phép báo giá khách mới chưa có hồ sơ
  customerId: integer("customer_id").references(() => customersTable.id),
  // Snapshot khách hàng (nếu chưa có customerId hoặc làm freelance)
  customerName: text("customer_name"),
  phone: text("phone"),
  title: text("title").notNull(),
  // items giữ format cũ: [{ name, quantity, unitPrice, total }]
  items: jsonb("items").notNull().default([]),
  // Phụ thu: [{ label, amount }]
  surcharges: jsonb("surcharges").notNull().default([]),
  // Giảm trừ (admin): [{ label, amount }]
  deductions: jsonb("deductions").notNull().default([]),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  discount: numeric("discount", { precision: 12, scale: 2 }).notNull().default("0"),
  finalAmount: numeric("final_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  // Tiền cọc tham khảo (nếu khách đã ứng trước khi chuyển booking)
  depositAmount: numeric("deposit_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  // Trạng thái: draft | sent | considering | converted | cancelled
  status: text("status").notNull().default("draft"),
  validUntil: date("valid_until"),
  // Ngày dự kiến chụp — chỉ tham khảo, không chiếm lịch
  expectedDate: date("expected_date"),
  expectedTime: text("expected_time"),
  notes: text("notes"),
  // Liên kết booking nếu đã chuyển — dùng để chống convert trùng
  convertedBookingId: integer("converted_booking_id"),
  convertedAt: timestamp("converted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({ id: true, createdAt: true });
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;

export const QUOTE_STATUSES = ["draft", "sent", "considering", "converted", "cancelled"] as const;
export type QuoteStatus = typeof QUOTE_STATUSES[number];
