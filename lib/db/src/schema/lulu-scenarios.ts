import { pgTable, serial, text, integer, timestamp, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Lulu Sale Scenario Manager — bảng được TẠO LAZY lúc chạy (CREATE TABLE IF NOT EXISTS) ở:
 *   - artifacts/api-server/src/lib/sale-scenario-store.ts
 *
 * KHAI BÁO ở đây để drizzle-kit (bước "Generated migrations" khi deploy Replit) HIỂU rằng
 * các bảng này là CỐ Ý — KHÔNG tự sinh migration "DROP TABLE" làm mất dữ liệu thật trên
 * production (đúng runbook chống DROP-drift PR #132). Cấu trúc cột phải khớp CREATE TABLE
 * trong store. App KHÔNG dùng các object này (runtime chạy raw SQL) — thuần khai báo schema.
 */

export const luluSaleScenarios = pgTable("lulu_sale_scenarios", {
  id: serial("id").primaryKey(),
  scenarioKey: text("scenario_key").notNull(),
  sortOrder: integer("sort_order").notNull().default(100),
  status: text("status").notNull().default("draft"),
  enabled: boolean("enabled").notNull().default(true),
  isCore: boolean("is_core").notNull().default(false),
  version: integer("version").notNull().default(1),
  cardJson: jsonb("card_json"),
  draftJson: jsonb("draft_json"),
  runCount: integer("run_count").notNull().default(0),
  lastRunAt: timestamp("last_run_at"),
  lastTestResult: text("last_test_result"),
  createdBy: integer("created_by"),
  createdByName: text("created_by_name"),
  updatedBy: integer("updated_by"),
  updatedByName: text("updated_by_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  keyUnique: uniqueIndex("idx_lulu_scenarios_key").on(t.scenarioKey),
  orderIdx: index("idx_lulu_scenarios_order").on(t.sortOrder, t.scenarioKey),
}));

export const luluScenarioVersions = pgTable("lulu_scenario_versions", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull().default("apply"),
  note: text("note"),
  snapshotJson: jsonb("snapshot_json").notNull(),
  createdBy: integer("created_by"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  atIdx: index("idx_lulu_scenario_versions_at").on(t.createdAt),
}));

export const luluSaleScriptExamples = pgTable("lulu_sale_script_examples", {
  id: serial("id").primaryKey(),
  nodeKey: text("node_key").notNull(),
  scenarioKey: text("scenario_key"),
  groupLabel: text("group_label").notNull().default(""),
  situationLabel: text("situation_label").notNull().default(""),
  customerText: text("customer_text").notNull().default(""),
  idealResponse: text("ideal_response").notNull().default(""),
  notes: text("notes").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  nodeIdx: index("idx_lulu_script_node").on(t.nodeKey, t.sortOrder),
  scenarioIdx: index("idx_lulu_script_scenario").on(t.scenarioKey),
}));

export const luluScenarioTree = pgTable("lulu_scenario_tree", {
  id: serial("id").primaryKey(),
  nodeKey: text("node_key").notNull(),
  parentKey: text("parent_key"),
  nodeType: text("node_type").notNull().default("group"),
  title: text("title").notNull().default(""),
  serviceKey: text("service_key"),
  priceSource: text("price_source"),
  scenarioKey: text("scenario_key"),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  keyUnique: uniqueIndex("idx_lulu_tree_key").on(t.nodeKey),
  parentIdx: index("idx_lulu_tree_parent").on(t.parentKey, t.sortOrder),
}));

export const luluScenarioTestRuns = pgTable("lulu_scenario_test_runs", {
  id: serial("id").primaryKey(),
  scenarioKey: text("scenario_key"),
  inputMessage: text("input_message").notNull().default(""),
  historyJson: jsonb("history_json"),
  stateBefore: jsonb("state_before"),
  winnerKey: text("winner_key"),
  losersJson: jsonb("losers_json"),
  action: text("action"),
  forbiddenJson: jsonb("forbidden_json"),
  knowledgeJson: jsonb("knowledge_json"),
  replyText: text("reply_text"),
  validatorJson: jsonb("validator_json"),
  verdict: text("verdict"),
  stateAfter: jsonb("state_after"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  scenarioAtIdx: index("idx_lulu_scenario_test_runs_at").on(t.scenarioKey, t.createdAt),
}));
