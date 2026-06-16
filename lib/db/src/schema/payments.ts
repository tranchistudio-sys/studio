import { pgTable, serial, text, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { bookingsTable } from "./bookings";
import { rentalsTable } from "./rentals";

export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").references(() => bookingsTable.id),
  rentalId: integer("rental_id").references(() => rentalsTable.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull(),
  paymentType: text("payment_type").notNull(),
  collectorName: text("collector_name"),
  bankName: text("bank_name"),
  proofImageUrl: text("proof_image_url"),
  proofImageUrls: text("proof_image_urls").array().default([]),
  paidDate: text("paid_date"),
  notes: text("notes"),
  paidAt: timestamp("paid_at").defaultNow().notNull(),
  // Task #390 — phiếu thu lẻ (ad-hoc): không gắn booking/rental
  payerName: text("payer_name"),
  payerPhone: text("payer_phone"),
  description: text("description"),
  adHocCategory: text("ad_hoc_category"),
  // Task #397 — huỷ phiếu thu (soft delete)
  status: text("status").default("active"),
  voidedAt: timestamp("voided_at"),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
});

export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({ id: true, paidAt: true });
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof paymentsTable.$inferSelect;
