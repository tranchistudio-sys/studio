import { pgTable, serial, text, integer, timestamp, jsonb, boolean, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Não Sale AI "Lulu" — các bảng được TẠO LAZY lúc chạy (CREATE TABLE IF NOT EXISTS) ở:
 *   - artifacts/api-server/src/lib/sale-brain-lab.ts   (lulu_brain_*)
 *   - artifacts/api-server/src/lib/sale-human-review.ts (lulu_human_reviews)
 *
 * KHAI BÁO ở đây để drizzle-kit (bước "Generated migrations" khi deploy Replit) HIỂU rằng các bảng
 * này là CỐ Ý — KHÔNG còn tự sinh migration "DROP TABLE" làm mất dữ liệu thật trên production.
 * Cấu trúc cột phải khớp đúng CREATE TABLE trong 2 file trên. App KHÔNG dùng các object này (runtime
 * vẫn chạy raw SQL); đây thuần là khai báo để đồng bộ schema khi deploy.
 */

export const luluBrainVersions = pgTable("lulu_brain_versions", {
  id: serial("id").primaryKey(),
  versionNumber: integer("version_number").notNull(),
  title: text("title").notNull().default(""),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("draft"),
  promptContent: text("prompt_content").notNull().default(""),
  rulesJson: jsonb("rules_json"),
  createdBy: integer("created_by"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  appliedBy: integer("applied_by"),
  appliedByName: text("applied_by_name"),
  appliedAt: timestamp("applied_at"),
  basedOnVersionId: integer("based_on_version_id"),
  changeSummary: text("change_summary"),
  rollbackNote: text("rollback_note"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Chỉ 1 version 'active' tại một thời điểm (partial unique index).
  oneActive: uniqueIndex("idx_lulu_brain_one_active").on(t.status).where(sql`status = 'active'`),
}));

export const luluBrainChangeRequests = pgTable("lulu_brain_change_requests", {
  id: serial("id").primaryKey(),
  requesterId: integer("requester_id"),
  requesterName: text("requester_name"),
  issueTitle: text("issue_title").notNull().default(""),
  issueDescription: text("issue_description").notNull().default(""),
  exampleCustomerMessage: text("example_customer_message"),
  expectedBehavior: text("expected_behavior"),
  currentWrongBehavior: text("current_wrong_behavior"),
  screenshotUrl: text("screenshot_url"),
  status: text("status").notNull().default("open"),
  linkedVersionId: integer("linked_version_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const luluBrainTestCases = pgTable("lulu_brain_test_cases", {
  id: serial("id").primaryKey(),
  title: text("title").notNull().default(""),
  customerMessage: text("customer_message").notNull().default(""),
  optionalImage: text("optional_image"),
  expectedIntent: text("expected_intent"),
  expectedBehavior: text("expected_behavior"),
  mustNotDo: text("must_not_do"),
  serviceGroupExpected: text("service_group_expected"),
  isRequired: boolean("is_required").notNull().default(true),
  priorContextJson: jsonb("prior_context_json"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const luluBrainTestResults = pgTable("lulu_brain_test_results", {
  id: serial("id").primaryKey(),
  brainVersionId: integer("brain_version_id").notNull(),
  testCaseId: integer("test_case_id"),
  actualReply: text("actual_reply").notNull().default(""),
  detectedIntent: text("detected_intent"),
  sampleImagesJson: jsonb("sample_images_json"),
  passed: boolean("passed"),
  failReason: text("fail_reason"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byVersion: index("idx_lulu_brain_results_version").on(t.brainVersionId, t.createdAt),
}));

export const luluHumanReviews = pgTable("lulu_human_reviews", {
  id: serial("id").primaryKey(),
  facebookUserId: text("facebook_user_id").notNull(),
  channel: text("channel").notNull().default("messenger"),
  customerName: text("customer_name"),
  customerQuestion: text("customer_question").notNull().default(""),
  customerImagesJson: jsonb("customer_images_json"),
  detectedIntent: text("detected_intent"),
  confidence: numeric("confidence"),
  reasonForEscalation: text("reason_for_escalation").notNull().default(""),
  aiSuggestedReply: text("ai_suggested_reply"),
  staffReply: text("staff_reply"),
  staffId: integer("staff_id"),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull().default("normal"),
  savedToPlaybook: boolean("saved_to_playbook").notNull().default(false),
  holdMessageSentAt: timestamp("hold_message_sent_at"),
  followupHoldSentAt: timestamp("followup_hold_sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  sentAt: timestamp("sent_at"),
}, (t) => ({
  // 1 review 'open' / khách (partial unique) + tra cứu theo status.
  openUser: uniqueIndex("idx_lulu_hr_open_user").on(t.facebookUserId).where(sql`status = 'open'`),
  statusCreated: index("idx_lulu_hr_status_created").on(t.status, t.createdAt),
}));
