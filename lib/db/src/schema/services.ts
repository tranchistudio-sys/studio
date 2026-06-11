import { pgTable, serial, text, timestamp, numeric, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const servicesTable = pgTable("services", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code"),
  category: text("category").notNull().default("other"),
  description: text("description"),
  type: text("type").notNull().default("package"),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  costPrice: numeric("cost_price", { precision: 12, scale: 2 }).notNull().default("0"),
  duration: text("duration"),
  includes: jsonb("includes").notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Per-service role split: how much each role earns per job for this service
export const serviceJobSplitsTable = pgTable("service_job_splits", {
  id: serial("id").primaryKey(),
  serviceId: integer("service_id").notNull().references(() => servicesTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // photographer | makeup | sale | photoshop | assistant
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  rateType: text("rate_type").notNull().default("fixed"), // fixed | percent
  notes: text("notes"),
});

export const insertServiceSchema = createInsertSchema(servicesTable).omit({ id: true, createdAt: true });
export const insertServiceJobSplitSchema = createInsertSchema(serviceJobSplitsTable).omit({ id: true });
export type InsertService = z.infer<typeof insertServiceSchema>;
export type Service = typeof servicesTable.$inferSelect;
export type ServiceJobSplit = typeof serviceJobSplitsTable.$inferSelect;
