import { pgTable, serial, text, numeric, boolean, timestamp } from "drizzle-orm/pg-core";

export const fixedCostsTable = pgTable("fixed_costs", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type FixedCost = typeof fixedCostsTable.$inferSelect;
