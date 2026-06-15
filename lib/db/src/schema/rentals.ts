import { pgTable, serial, text, timestamp, integer, numeric, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { dressesTable } from "./dresses";

export const rentalsTable = pgTable("rentals", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customersTable.id),
  dressId: integer("dress_id").notNull().references(() => dressesTable.id),
  rentalDate: date("rental_date").notNull(),
  returnDate: date("return_date").notNull(),
  actualReturnDate: date("actual_return_date"),
  rentalPrice: numeric("rental_price", { precision: 12, scale: 2 }).notNull(),
  depositPaid: numeric("deposit_paid", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull().default("rented"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRentalSchema = createInsertSchema(rentalsTable).omit({ id: true, createdAt: true });
export type InsertRental = z.infer<typeof insertRentalSchema>;
export type Rental = typeof rentalsTable.$inferSelect;
