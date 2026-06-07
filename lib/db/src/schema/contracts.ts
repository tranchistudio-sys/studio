import { pgTable, serial, text, timestamp, integer, date, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { bookingsTable } from "./bookings";
import { customersTable } from "./customers";

export const contractsTable = pgTable("contracts", {
  id: serial("id").primaryKey(),
  contractCode: text("contract_code"),
  bookingId: integer("booking_id").references(() => bookingsTable.id),
  customerId: integer("customer_id").notNull().references(() => customersTable.id),
  title: text("title").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull().default("draft"),
  totalValue: numeric("total_value").default("0"),
  signedAt: date("signed_at"),
  expiresAt: date("expires_at"),
  fileUrl: text("file_url"),
  notes: text("notes"),
  signatureImageUrl: text("signature_image_url"),
  signerName: text("signer_name"),
  signerPhone: text("signer_phone"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertContractSchema = createInsertSchema(contractsTable).omit({ id: true, createdAt: true });
export type InsertContract = z.infer<typeof insertContractSchema>;
export type Contract = typeof contractsTable.$inferSelect;
