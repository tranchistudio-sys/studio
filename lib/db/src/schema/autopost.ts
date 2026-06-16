import { pgTable, serial, text, timestamp, numeric, boolean, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const autopostContentPool = pgTable("autopost_content_pool", {
  id: serial("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceTable: text("source_table"),
  sourceItemId: text("source_item_id"),
  contentType: text("content_type").notNull(),
  title: text("title").notNull(),
  images: jsonb("images").notNull().default(sql`'[]'::jsonb`),
  price: numeric("price", { precision: 12, scale: 2 }),
  salePrice: numeric("sale_price", { precision: 12, scale: 2 }),
  goldenHourPercent: numeric("golden_hour_percent", { precision: 5, scale: 2 }),
  goldenHourName: text("golden_hour_name"),
  category: text("category"),
  badge: text("badge"),
  publicLink: text("public_link"),
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  imageHash: text("image_hash"),
  isEligible: boolean("is_eligible").notNull().default(true),
  ineligibleReason: text("ineligible_reason"),
  lastPostedAt: timestamp("last_posted_at", { withTimezone: true }),
  timesPosted: integer("times_posted").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uqSource: uniqueIndex("uq_autopost_pool_source").on(t.sourceTable, t.sourceItemId) }));

export const autopostSchedules = pgTable("autopost_schedules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  pageId: text("page_id"),
  timezone: text("timezone").notNull().default("Asia/Ho_Chi_Minh"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const autopostScheduleSlots = pgTable("autopost_schedule_slots", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull(),
  postTime: text("post_time").notNull(),
  contentType: text("content_type").notNull(),
  imageCount: integer("image_count").notNull().default(1),
  sourcePriority: text("source_priority").notNull().default("app_web"),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const autopostPosts = pgTable("autopost_posts", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id"),
  slotId: integer("slot_id"),
  contentPoolId: integer("content_pool_id"),
  pageId: text("page_id"),
  contentType: text("content_type"),
  images: jsonb("images").notNull().default(sql`'[]'::jsonb`),
  captionOptions: jsonb("caption_options").notNull().default(sql`'[]'::jsonb`),
  captionRecommendedIndex: integer("caption_recommended_index"),
  captionFinal: text("caption_final"),
  status: text("status").notNull().default("draft_ai"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  approvedBy: integer("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  facebookPostId: text("facebook_post_id"),
  facebookPostLink: text("facebook_post_link"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  captionHash: text("caption_hash"),
  imageHash: text("image_hash"),
  sourceType: text("source_type"),
  sourceItemId: text("source_item_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byStatus: index("ix_autopost_posts_status_sched").on(t.status, t.scheduledAt) }));

export const autopostSettings = pgTable("autopost_settings", {
  id: integer("id").primaryKey().default(1),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: integer("updated_by"),
});
