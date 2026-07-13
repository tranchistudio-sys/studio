import { pgTable, serial, text, timestamp, integer, numeric, date, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { staffTable } from "./tasks";
import { servicePackagesTable } from "./pricing";

export const bookingsTable = pgTable("bookings", {
  id: serial("id").primaryKey(),
  orderCode: text("order_code"),
  customerId: integer("customer_id").notNull().references(() => customersTable.id),
  shootDate: date("shoot_date").notNull(),
  shootTime: text("shoot_time"),
  serviceCategory: text("service_category").notNull().default("wedding"),
  packageType: text("package_type").notNull(),
  location: text("location"),
  status: text("status").notNull().default("pending"),
  items: jsonb("items").notNull().default([]),
  surcharges: jsonb("surcharges").notNull().default([]),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
  depositAmount: numeric("deposit_amount", { precision: 12, scale: 2 }).notNull(),
  paidAmount: numeric("paid_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discount_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  assignedStaff: jsonb("assigned_staff").notNull().default([]),
  internalNotes: text("internal_notes"),
  notes: text("notes"),
  // Multi-service contract support
  parentId: integer("parent_id"),
  serviceLabel: text("service_label"),
  isParentContract: boolean("is_parent_contract").notNull().default(false),
  photoCount: integer("photo_count"),
  bannerUrl: text("banner_url"),
  // Task #13: ảnh hậu kỳ
  includedRetouchedPhotosSnapshot: integer("included_retouched_photos_snapshot").notNull().default(0),
  // Task #24: link gói dịch vụ (tracking only, không cascade khi sửa bảng giá)
  servicePackageId: integer("service_package_id").references(() => servicePackagesTable.id, { onDelete: "set null" }),
  // Task #22: vai trò bắt buộc cho buổi chụp (VD: ["photographer","makeup","videographer"])
  requiredRoles: jsonb("required_roles").notNull().default([]),
  // Task #55: Giảm trừ dịch vụ — array of { label: string, amount: number }, amount always positive in DB
  deductions: jsonb("deductions").notNull().default([]),
  // Task #293: người tạo đơn — dùng để hiển thị màu lịch đúng với NV tạo booking
  createdByStaffId: integer("created_by_staff_id").references(() => staffTable.id, { onDelete: "set null" }),
  // Dịch vụ cộng thêm (qty × unitPrice + staff assignments) — additive, không đụng items[]
  additionalServices: jsonb("additional_services").notNull().default([]),
  // Setting nhắc lấy/trả đồ trên Lịch (gói bật warn_upcoming_show).
  // NULL = mặc định (lấy trước 3 ngày, trả sau 2 ngày). Thuần lịch nhắc, không đụng tiền.
  dressWarnPickupDays: integer("dress_warn_pickup_days"),
  dressWarnReturnDays: integer("dress_warn_return_days"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Thùng rác Booking (soft-delete): deletedAt != null = đã vào thùng rác.
  // Mọi query active phải lọc deletedAt IS NULL; chỉ admin xem/khôi phục/xoá vĩnh viễn.
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by").references(() => staffTable.id, { onDelete: "set null" }),
  deleteReason: text("delete_reason"),
});

// ─── Task #10: Booking items (hạng mục & upsell) ──────────────────────────────
// type: base_package | addon | manual | upgrade_delta | extra_retouched
export const bookingItemsTable = pgTable("booking_items", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull().references(() => bookingsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("addon"),
  title: text("title").notNull(),
  qty: integer("qty").notNull().default(1),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull().default("0"),
  totalPrice: numeric("total_price", { precision: 12, scale: 2 }).notNull().default("0"),
  soldByStaffId: integer("sold_by_staff_id").references(() => staffTable.id, { onDelete: "set null" }),
  isActive: integer("is_active").notNull().default(1),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Task #11: Booking change log (lịch sử đổi lịch) ─────────────────────────
export const bookingChangeLogTable = pgTable("booking_change_log", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull().references(() => bookingsTable.id, { onDelete: "cascade" }),
  fieldChanged: text("field_changed").notNull().default("schedule"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  reason: text("reason"),
  changedById: integer("changed_by_id").references(() => staffTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBookingSchema = createInsertSchema(bookingsTable).omit({ id: true, createdAt: true });
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Booking = typeof bookingsTable.$inferSelect;

export const insertBookingItemSchema = createInsertSchema(bookingItemsTable).omit({ id: true, createdAt: true });
export type InsertBookingItem = z.infer<typeof insertBookingItemSchema>;
export type BookingItem = typeof bookingItemsTable.$inferSelect;

export const insertBookingChangeLogSchema = createInsertSchema(bookingChangeLogTable).omit({ id: true, createdAt: true });
export type InsertBookingChangeLog = z.infer<typeof insertBookingChangeLogSchema>;

// ─── Ngày thực hiện PHỤ của booking (dịch vụ nhiều ngày) ─────────────────────
// Ngày 1 = bookings.shoot_date/shoot_time (giữ nguyên mọi logic cũ: công nợ,
// lương, hậu kỳ, hợp đồng). Bảng này CHỈ lưu ngày 2 trở đi — thuần lịch trình
// + nhãn ("Nhà gái", "Rước dâu"...), KHÔNG có bất kỳ trường tiền nào để không
// thể nhân đôi doanh thu/công nợ/hoa hồng by-construction.
export const bookingOccurrencesTable = pgTable("booking_occurrences", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull().references(() => bookingsTable.id, { onDelete: "cascade" }),
  shootDate: date("shoot_date").notNull(),
  shootTime: text("shoot_time"),
  label: text("label"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
});

export const insertBookingOccurrenceSchema = createInsertSchema(bookingOccurrencesTable).omit({ id: true, createdAt: true });
export type InsertBookingOccurrence = z.infer<typeof insertBookingOccurrenceSchema>;
export type BookingOccurrence = typeof bookingOccurrencesTable.$inferSelect;
