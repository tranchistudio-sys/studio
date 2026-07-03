import { pgTable, serial, text, timestamp, integer, date, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { bookingsTable } from "./bookings";
import { customersTable } from "./customers";
import { staffTable } from "./tasks";

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
  // Hợp đồng online v2 — link public cố định + chữ ký Bên A + phát hiện sửa sau khi ký
  publicToken: text("public_token"), // unique partial index tạo trong migrations.ts
  studioSignatureImageUrl: text("studio_signature_image_url"),
  studioSignedAt: timestamp("studio_signed_at"),
  studioSignedById: integer("studio_signed_by_id").references(() => staffTable.id, { onDelete: "set null" }),
  signedSnapshot: jsonb("signed_snapshot"),
  resignRequestedAt: timestamp("resign_requested_at"), // admin chủ động yêu cầu khách ký lại; null = không
});

// Lịch sử chỉnh sửa hợp đồng — CHỈ nội bộ, không bao giờ trả ra public API (mirror bookingChangeLogTable)
export const contractChangeLogTable = pgTable("contract_change_log", {
  id: serial("id").primaryKey(),
  contractId: integer("contract_id")
    .notNull()
    .references(() => contractsTable.id, { onDelete: "cascade" }),
  fieldChanged: text("field_changed").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  reason: text("reason"),
  changedById: integer("changed_by_id").references(() => staffTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertContractSchema = createInsertSchema(contractsTable).omit({ id: true, createdAt: true });
export type InsertContract = z.infer<typeof insertContractSchema>;
export type Contract = typeof contractsTable.$inferSelect;
export type ContractChangeLog = typeof contractChangeLogTable.$inferSelect;
