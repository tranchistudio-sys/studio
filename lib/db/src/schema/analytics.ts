import { pgTable, serial, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const analyticsEventsTable = pgTable("analytics_events", {
  id: serial("id").primaryKey(),
  eventKey: text("event_key").notNull(),
  eventName: text("event_name").notNull(),
  eventId: text("event_id").notNull(),
  provider: text("provider").notNull().default("meta_capi"),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  payload: jsonb("payload").notNull().default({}),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("analytics_events_event_key_uidx").on(table.eventKey)]);
