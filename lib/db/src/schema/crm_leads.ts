import { pgTable, serial, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const crmLeadsTable = pgTable("crm_leads", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  zalo: text("zalo"),
  message: text("message"),
  lastMessage: text("last_message"),
  lastMessageAt: timestamp("last_message_at"),
  source: text("source").default("facebook"),
  status: text("status").default("new"),
  type: text("type").default("unknown"),
  channel: text("channel").default("inbox"),
  facebookUserId: text("facebook_user_id").unique(),
  avatarUrl: text("avatar_url"),
  notes: text("notes"),
  aiPerThreadEnabled: boolean("ai_per_thread_enabled"),
  aiMode: text("ai_mode").default("active"),
  customerId: integer("customer_id"),
  // Legacy AI script fields — kept to preserve existing prod data; no longer actively used
  currentScriptId: integer("current_script_id"),
  currentSaleStep: integer("current_sale_step"),
  serviceGroup: text("service_group"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCrmLeadSchema = createInsertSchema(crmLeadsTable).omit({ id: true, createdAt: true });
export type NewCrmLead = z.infer<typeof insertCrmLeadSchema>;
export type CrmLead = typeof crmLeadsTable.$inferSelect;
