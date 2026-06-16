import { pgTable, serial, text, timestamp, boolean, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const fbInboxMessagesTable = pgTable("fb_inbox_messages", {
  id: serial("id").primaryKey(),
  facebookUserId: text("facebook_user_id").notNull(),
  direction: text("direction").notNull(),
  message: text("message").notNull(),
  sentStatus: text("sent_status").notNull().default("received"),
  aiDecision: text("ai_decision"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  mid: text("mid"),
  sentBy: text("sent_by"),
});

export const aiServiceScriptsTable = pgTable("ai_service_scripts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  priceContent: text("price_content"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  priceImages: text("price_images"),
  aiRules: text("ai_rules"),
  followUpMessage: text("follow_up_message"),
  stepFollowUpMessages: jsonb("step_follow_up_messages"),
  aiSettings: jsonb("ai_settings"),
  conversationExamples: jsonb("conversation_examples"),
  stepFollowUpSlots: jsonb("step_follow_up_slots"),
  serviceGroup: text("service_group"),
});

export const aiScriptStepsTable = pgTable("ai_script_steps", {
  id: serial("id").primaryKey(),
  scriptId: integer("script_id").notNull(),
  step: integer("step").notNull(),
  stepLabel: text("step_label"),
  content: text("content"),
  variantsJson: text("variants_json"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const aiScriptQaRowsTable = pgTable("ai_script_qa_rows", {
  id: serial("id").primaryKey(),
  scriptId: integer("script_id"),
  step: integer("step").notNull(),
  question: text("question"),
  answer: text("answer"),
  sortOrder: integer("sort_order").default(0),
});

export const aiScriptQaRowsBak20260503Table = pgTable("ai_script_qa_rows_bak_20260503080544", {
  id: integer("id"),
  scriptId: integer("script_id"),
  step: integer("step"),
  question: text("question"),
  answer: text("answer"),
  sortOrder: integer("sort_order"),
});

export const aiTestSessionsTable = pgTable("ai_test_sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  customerName: text("customer_name").notNull().default("Khách Test"),
  scriptId: integer("script_id"),
  currentScriptId: integer("current_script_id"),
  currentSaleStep: integer("current_sale_step"),
  scriptUpdatedAt: timestamp("script_updated_at", { withTimezone: true }),
  lastCustomerMessageAt: timestamp("last_customer_message_at", { withTimezone: true }),
  followUpCount: integer("follow_up_count").notNull().default(0),
  lastFollowUpAt: timestamp("last_follow_up_at", { withTimezone: true }),
  lastFollowUpStep: integer("last_follow_up_step"),
  lastFollowUpSlotIndex: integer("last_follow_up_slot_index"),
  messageCount: integer("message_count").notNull().default(0),
  lastMessagePreview: text("last_message_preview"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const aiTestMessagesTable = pgTable("ai_test_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  text: text("text").notNull().default(""),
  type: text("type"),
  decision: text("decision"),
  currentStep: integer("current_step"),
  debugJson: jsonb("debug_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const aiServiceScriptsBak20260503Table = pgTable("ai_service_scripts_bak_20260503080544", {
  id: integer("id"),
  name: text("name"),
  priceContent: text("price_content"),
  isActive: boolean("is_active"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
  priceImages: text("price_images"),
  aiRules: text("ai_rules"),
  followUpMessage: text("follow_up_message"),
  stepFollowUpMessages: jsonb("step_follow_up_messages"),
  aiSettings: jsonb("ai_settings"),
  conversationExamples: jsonb("conversation_examples"),
  stepFollowUpSlots: jsonb("step_follow_up_slots"),
  serviceGroup: text("service_group"),
});

export const aiScriptStepsBak20260503Table = pgTable("ai_script_steps_bak_20260503080544", {
  id: integer("id"),
  scriptId: integer("script_id"),
  step: integer("step"),
  stepLabel: text("step_label"),
  content: text("content"),
  variantsJson: text("variants_json"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});
