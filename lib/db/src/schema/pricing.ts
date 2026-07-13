import { pgTable, serial, text, timestamp, numeric, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const serviceGroupsTable = pgTable("service_groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: integer("is_active").notNull().default(1),
  /** Ảnh bảng giá của nhóm để Sale AI gửi cho khách (object-storage path, vd /objects/...). */
  aiImageUrl: text("ai_image_url"),
  /** Chỉ cho Sale AI gửi ảnh nhóm này khi = true (gate an toàn). */
  publicForCustomer: boolean("public_for_customer").notNull().default(true),
  // ── Chương trình giảm giá CẤP NHÓM — áp cho MỌI gói active trong nhóm chưa có
  //    giảm giá riêng. Helper resolveDiscount() (pricing-discount.ts) là nơi tính
  //    DUY NHẤT; ưu tiên giảm-gói > giảm-nhóm, KHÔNG cộng dồn. ──
  discountEnabled: boolean("discount_enabled").notNull().default(false),
  discountType: text("discount_type"), // 'percent' | 'fixed'
  discountValue: numeric("discount_value", { precision: 12, scale: 2 }),
  discountStartDate: timestamp("discount_start_date", { withTimezone: true }),
  discountEndDate: timestamp("discount_end_date", { withTimezone: true }),
  discountName: text("discount_name"),
  discountDescription: text("discount_description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Giờ vàng — campaign giảm giá theo nhóm danh mục (cms_categories) hoặc sản phẩm (dresses). */
export const goldenHourCampaignsTable = pgTable("golden_hour_campaigns", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull(),
  refId: integer("ref_id").notNull(),
  name: text("name").notNull().default("Giờ vàng"),
  percent: numeric("percent", { precision: 5, scale: 2 }).notNull().default("0"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const servicePackagesTable = pgTable("service_packages", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").references(() => serviceGroupsTable.id),
  code: text("code"),
  name: text("name").notNull(),
  price: numeric("price", { precision: 12, scale: 2 }).notNull().default("0"),
  printCost: numeric("print_cost", { precision: 12, scale: 2 }).notNull().default("0"),           // in ấn
  operatingCost: numeric("operating_cost", { precision: 12, scale: 2 }).notNull().default("0"),   // vận hành
  salePercent: numeric("sale_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  description: text("description"),
  notes: text("notes"),
  addons: text("addons"),
  products: text("products"),
  serviceType: text("service_type"),
  photoCount: integer("photo_count").notNull().default(1),
  includesMakeup: integer("includes_makeup").notNull().default(1),
  includedRetouchedPhotos: integer("included_retouched_photos").notNull().default(0),
  // Task #383 Bước 2: số ngày hậu kỳ mặc định cho gói (nullable → fallback sang
  // logic daysForService cũ). Booking/job mới tạo sẽ dùng giá trị này nếu có.
  defaultEditingDays: integer("default_editing_days"),
  /** When true, booking creates a post-production (photoshop) job. */
  requiresPostProduction: boolean("requires_post_production").notNull().default(false),
  /** When true, job shows "Đã xuất in" tracking (physical print). */
  requiresPrinting: boolean("requires_printing").notNull().default(false),
  /** Bật cảnh báo lấy/trả váy trên lịch cho đơn dùng gói này (chip kiểu Xin nghỉ/Off).
   *  Thuần hiển thị — KHÔNG đụng tiền/đơn/công nợ. */
  warnUpcomingShow: boolean("warn_upcoming_show").notNull().default(false),
  // ── Chương trình giảm giá RIÊNG cho gói — ưu tiên hơn giảm giá nhóm (KHÔNG cộng
  //    dồn). KHÁC salePercent (salePercent = % margin nội bộ trong breakdown chi phí,
  //    KHÔNG phải ưu đãi cho khách). Tính giá sau giảm bằng resolveDiscount(). ──
  discountEnabled: boolean("discount_enabled").notNull().default(false),
  discountType: text("discount_type"), // 'percent' | 'fixed'
  discountValue: numeric("discount_value", { precision: 12, scale: 2 }),
  discountStartDate: timestamp("discount_start_date", { withTimezone: true }),
  discountEndDate: timestamp("discount_end_date", { withTimezone: true }),
  discountName: text("discount_name"),
  discountDescription: text("discount_description"),
  isActive: integer("is_active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const packageItemsTable = pgTable("package_items", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id").references(() => servicePackagesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  quantity: text("quantity").notNull().default("1"),
  unit: text("unit"),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const surchargesTable = pgTable("surcharges", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category"),
  price: numeric("price", { precision: 12, scale: 2 }).notNull().default("0"),
  unit: text("unit").notNull().default("lần"),
  description: text("description"),
  isActive: integer("is_active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertServiceGroupSchema = createInsertSchema(serviceGroupsTable).omit({ id: true, createdAt: true });
export const insertServicePackageSchema = createInsertSchema(servicePackagesTable).omit({ id: true, createdAt: true });
export const insertPackageItemSchema = createInsertSchema(packageItemsTable).omit({ id: true });
export const insertSurchargeSchema = createInsertSchema(surchargesTable).omit({ id: true, createdAt: true });

export type InsertServiceGroup = z.infer<typeof insertServiceGroupSchema>;
export type ServiceGroup = typeof serviceGroupsTable.$inferSelect;
export type InsertServicePackage = z.infer<typeof insertServicePackageSchema>;
export type ServicePackage = typeof servicePackagesTable.$inferSelect;
export type InsertPackageItem = z.infer<typeof insertPackageItemSchema>;
export type PackageItem = typeof packageItemsTable.$inferSelect;
export type InsertSurcharge = z.infer<typeof insertSurchargeSchema>;
export type Surcharge = typeof surchargesTable.$inferSelect;
