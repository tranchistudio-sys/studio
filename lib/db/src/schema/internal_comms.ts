import { pgTable, serial, integer, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  recipientStaffId: integer("recipient_staff_id"),
  senderStaffId: integer("sender_staff_id"),
  type: text("type").notNull().default("info"),
  priority: text("priority").notNull().default("normal"),
  title: text("title").notNull().default(""),
  body: text("body").notNull().default(""),
  linkType: text("link_type").default(""),
  linkId: integer("link_id"),
  bookingId: integer("booking_id"),
  isRead: boolean("is_read").notNull().default(false),
  dedupeKey: text("dedupe_key"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  dedupeKeyUnique: uniqueIndex("notifications_dedupe_key_unique")
    .on(t.dedupeKey)
    .where(sql`${t.dedupeKey} IS NOT NULL`),
}));

export const messageRoomsTable = pgTable("message_rooms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull().default("group"),
  linkType: text("link_type").default(""),
  linkId: integer("link_id"),
  createdByStaffId: integer("created_by_staff_id"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const roomMembersTable = pgTable("room_members", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id").notNull(),
  staffId: integer("staff_id").notNull(),
  joinedAt: timestamp("joined_at").defaultNow(),
  lastReadAt: timestamp("last_read_at").defaultNow(),
});

export const pushSubscriptionsTable = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull(),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const internalMessagesTable = pgTable("internal_messages", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id").notNull(),
  senderStaffId: integer("sender_staff_id"),
  senderName: text("sender_name").notNull().default("Hệ thống"),
  content: text("content").notNull(),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});
