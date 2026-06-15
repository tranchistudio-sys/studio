import { pgTable, serial, text, timestamp, integer, date, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { bookingsTable } from "./bookings";
import { dressesTable } from "./dresses";

export const bookingDressesTable = pgTable("booking_dresses", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull().references(() => bookingsTable.id, { onDelete: "cascade" }),
  dressId: integer("dress_id").notNull().references(() => dressesTable.id, { onDelete: "cascade" }),
  outfitCode: text("outfit_code").notNull(),
  outfitName: text("outfit_name").notNull(),
  outfitImage: text("outfit_image"),
  category: text("category"),
  size: text("size"),
  rentalPrice: numeric("rental_price", { precision: 12, scale: 2 }).notNull().default("0"),
  pickupDate: date("pickup_date").notNull(),
  returnDate: date("return_date").notNull(),
  status: text("status").notNull().default("reserved"), // reserved | picked_up | returned | cancelled
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBookingDressSchema = createInsertSchema(bookingDressesTable).omit({ id: true, createdAt: true });
export type InsertBookingDress = z.infer<typeof insertBookingDressSchema>;
export type BookingDress = typeof bookingDressesTable.$inferSelect;
