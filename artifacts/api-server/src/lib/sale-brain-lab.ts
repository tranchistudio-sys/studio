import { pool } from "@workspace/db";
import {
  DEFAULT_BRAIN_RULES,
  SAMPLE_IMAGE_INSTRUCTION, PRICE_IMAGE_INSTRUCTION, SPECIAL_CONCEPT_ESCALATION_RULE,
} from "./claude-sale";
import {
  type ImageOverride, parseImageOverrides, withImageOverrides,
} from "./sale-image-overrides";

/**
 * Lulu Brain Lab — quản lý / sửa / test / lưu version cho "não Sale AI Lulu".
 *
 * "Não" ở đây = BỘ LUẬT NÃO LULU (rule chọn ảnh, rule beauty/cưới/váy, văn phong người thật,
 * hướng dẫn gửi ảnh mẫu / ảnh bảng giá) = 5 khối luật trước đây hard-code trong claude-sale.ts.
 * Version 1 seed nguyên văn DEFAULT_BRAIN_RULES → ngày đầu hành vi y hệt.
 *
 * AN TOÀN (theo yêu cầu chủ studio):
 *  - 4 bảng RIÊNG, tạo lazy bằng CREATE TABLE IF NOT EXISTS. KHÔNG drop/rename/xoá bảng khác.
 *  - KHÔNG đụng booking/payment/calendar/attendance/CRM hay claude_sale_settings.
 *  - Khối RÀNG BUỘC giá/booking vẫn khoá cứng trong code (không nằm trong bộ luật version-hóa).
 *  - getActiveBrainRules() nằm trên luồng trả lời SỐNG → KHÔNG bao giờ throw (lỗi DB → null = dùng mặc định).
 *  - AI chỉ tạo BẢN NHÁP; áp dụng/khôi phục là hành động của admin (gác ở route).
 */

// ─── Dấu hiệu kỹ thuật (markers) — lưới an toàn ───────────────────────────────
//
// Các marker <<...>> là TÍN HIỆU HỆ THỐNG: parser trong claude-sale.ts dựa vào chúng để
// gửi ảnh mẫu / ảnh bảng giá / học tên / chuyển người thật. Nếu một bản nháp ĐÁNH MẤT
// marker đang có trong bản chạy thật rồi bị áp dụng → Lulu mất chức năng tương ứng.
// Dùng CHUNG cho: cảnh báo khi AI tạo nháp, khoá nút Áp dụng (FE), và CHẶN ở route apply (BE).

export const BRAIN_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /<<\s*SAMPLE/i, label: "<<SAMPLE>>" },
  { re: /<<\s*PRICE_IMAGE/i, label: "<<PRICE_IMAGE>>" },
  { re: /<<\s*NAME/i, label: "<<NAME>>" },
  { re: /<<\s*NEEDS_HUMAN/i, label: "<<NEEDS_HUMAN>>" },
];

/** Marker nào CÓ trong `reference` (bản chạy thật) mà THIẾU trong `candidate` (bản nháp). */
export function missingMarkers(candidate: string, reference: string): string[] {
  const c = candidate ?? "";
  const ref = reference ?? "";
  return BRAIN_MARKERS.filter(({ re }) => re.test(ref) && !re.test(c)).map(({ label }) => label);
}

// Khối hướng dẫn GỐC của từng marker — để TỰ CHÈN LẠI khi AI viết lại lỡ bỏ mất (chữa gốc "báo đỏ").
const MARKER_RECOVERY: Array<{ re: RegExp; label: string; block: string }> = [
  { re: /<<\s*SAMPLE/i, label: "<<SAMPLE>>", block: SAMPLE_IMAGE_INSTRUCTION },
  { re: /<<\s*PRICE_IMAGE/i, label: "<<PRICE_IMAGE>>", block: PRICE_IMAGE_INSTRUCTION },
  { re: /<<\s*NEEDS_HUMAN/i, label: "<<NEEDS_HUMAN>>", block: SPECIAL_CONCEPT_ESCALATION_RULE },
];

/**
 * Tự khôi phục marker bị thiếu: marker nào CÓ trong `reference` mà THIẾU trong `candidate`
 * → chèn lại NGUYÊN khối hướng dẫn gốc vào cuối candidate. Đảm bảo bản nháp không bao giờ mất
 * chức năng gửi ảnh mẫu / ảnh bảng giá / chuyển người thật dù AI lỡ bỏ khi viết lại.
 */
export function recoverMissingMarkers(candidate: string, reference: string): { content: string; recovered: string[] } {
  const ref = reference ?? "";
  let out = candidate ?? "";
  const recovered: string[] = [];
  for (const { re, label, block } of MARKER_RECOVERY) {
    if (re.test(ref) && !re.test(out)) { out = `${out.trimEnd()}\n\n${block}`; recovered.push(label); }
  }
  return { content: out, recovered };
}

// ─── Kiểu dữ liệu ─────────────────────────────────────────────────────────────

export type BrainVersionStatus = "draft" | "active" | "archived" | "rejected";
export type ChangeRequestStatus = "open" | "drafted" | "testing" | "applied" | "rejected";

export type BrainVersion = {
  id: number;
  versionNumber: number;
  title: string;
  description: string;
  status: BrainVersionStatus;
  promptContent: string;
  rulesJson: unknown | null;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  appliedBy: number | null;
  appliedByName: string | null;
  appliedAt: string | null;
  basedOnVersionId: number | null;
  changeSummary: string | null;
  rollbackNote: string | null;
  updatedAt: string;
};

export type ChangeRequest = {
  id: number;
  requesterId: number | null;
  requesterName: string | null;
  issueTitle: string;
  issueDescription: string;
  exampleCustomerMessage: string | null;
  expectedBehavior: string | null;
  currentWrongBehavior: string | null;
  screenshotUrl: string | null;
  status: ChangeRequestStatus;
  linkedVersionId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type BrainTestCase = {
  id: number;
  title: string;
  customerMessage: string;
  optionalImage: string | null;
  expectedIntent: string | null;
  expectedBehavior: string | null;
  mustNotDo: string | null;
  serviceGroupExpected: string | null;
  isRequired: boolean;
  priorContext: Array<{ direction: "incoming" | "outgoing"; text: string }>;
  sortOrder: number;
  createdAt: string;
};

export type BrainTestResult = {
  id: number;
  brainVersionId: number;
  testCaseId: number | null;
  actualReply: string;
  detectedIntent: string | null;
  sampleImages: string[];
  passed: boolean | null;
  failReason: string | null;
  createdBy: number | null;
  createdAt: string;
};

// ─── Tạo bảng (lazy) + seed Version 1 + bộ test case mặc định ──────────────────

let ensured = false;
export async function ensureBrainLabTables(): Promise<void> {
  if (ensured) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_brain_versions (
      id                   SERIAL PRIMARY KEY,
      version_number       INTEGER NOT NULL,
      title                TEXT NOT NULL DEFAULT '',
      description          TEXT NOT NULL DEFAULT '',
      status               TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','active','archived','rejected')),
      prompt_content       TEXT NOT NULL DEFAULT '',
      rules_json           JSONB,
      created_by           INTEGER,
      created_by_name      TEXT,
      created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
      applied_by           INTEGER,
      applied_by_name      TEXT,
      applied_at           TIMESTAMP,
      based_on_version_id  INTEGER,
      change_summary       TEXT,
      rollback_note        TEXT,
      updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  // Chỉ cho phép TỐI ĐA 1 version 'active' (unique trên hằng số khi status='active').
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lulu_brain_one_active
     ON lulu_brain_versions ((status)) WHERE status = 'active'`,
  ).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_brain_change_requests (
      id                       SERIAL PRIMARY KEY,
      requester_id             INTEGER,
      requester_name           TEXT,
      issue_title              TEXT NOT NULL DEFAULT '',
      issue_description        TEXT NOT NULL DEFAULT '',
      example_customer_message TEXT,
      expected_behavior        TEXT,
      current_wrong_behavior   TEXT,
      screenshot_url           TEXT,
      status                   TEXT NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('open','drafted','testing','applied','rejected')),
      linked_version_id        INTEGER,
      created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_brain_test_cases (
      id                     SERIAL PRIMARY KEY,
      title                  TEXT NOT NULL DEFAULT '',
      customer_message       TEXT NOT NULL DEFAULT '',
      optional_image         TEXT,
      expected_intent        TEXT,
      expected_behavior      TEXT,
      must_not_do            TEXT,
      service_group_expected TEXT,
      is_required            BOOLEAN NOT NULL DEFAULT true,
      prior_context_json     JSONB,
      sort_order             INTEGER NOT NULL DEFAULT 0,
      created_at             TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_brain_test_results (
      id                SERIAL PRIMARY KEY,
      brain_version_id  INTEGER NOT NULL,
      test_case_id      INTEGER,
      actual_reply      TEXT NOT NULL DEFAULT '',
      detected_intent   TEXT,
      sample_images_json JSONB,
      passed            BOOLEAN,
      fail_reason       TEXT,
      created_by        INTEGER,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_lulu_brain_results_version
     ON lulu_brain_test_results (brain_version_id, created_at DESC)`,
  ).catch(() => {});

  ensured = true;

  // Seed Version 1 = prompt/luật hiện tại (chỉ khi chưa có version nào) — PHẦN 9.
  await seedInitialVersion();
  await seedDefaultTestCases();
}

async function seedInitialVersion(): Promise<void> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM lulu_brain_versions`);
  if (Number(r.rows[0]?.n ?? 0) > 0) return;
  await pool.query(
    `INSERT INTO lulu_brain_versions
       (version_number, title, description, status, prompt_content, created_by_name, change_summary)
     VALUES (1, $1, $2, 'active', $3, 'Hệ thống', $4)`,
    [
      "Bản gốc — bộ luật não Lulu hiện tại",
      "Tự động tạo từ bộ luật đang chạy trong code (rule chọn ảnh, beauty/cưới/váy, văn phong, gửi ảnh mẫu). Ngày đầu hành vi y hệt trước khi có Brain Lab.",
      DEFAULT_BRAIN_RULES,
      "Khởi tạo Version 1 từ prompt/luật gốc.",
    ],
  );
  clearActiveRulesCache(); clearActiveOverridesCache();
}

// 10 test case mặc định (PHẦN 6). Chỉ seed khi bảng đang rỗng.
const DEFAULT_TEST_CASES: Array<Omit<BrainTestCase, "id" | "createdAt">> = [
  {
    title: "CASE 1 — Cool boy", customerMessage: "Anh muốn chụp cool boy",
    optionalImage: null, expectedIntent: "beauty",
    expectedBehavior: "Nhận là beauty/chụp cá nhân nam; nếu gửi mẫu thì gửi beauty/cool boy đúng giới tính nam.",
    mustNotDo: "Không gửi album cưới, không gửi cô dâu/váy cưới.",
    serviceGroupExpected: "beauty", isRequired: true, priorContext: [], sortOrder: 1,
  },
  {
    title: "CASE 2 — Xem mẫu beauty", customerMessage: "Cho anh xem mẫu beauty",
    optionalImage: null, expectedIntent: "beauty",
    expectedBehavior: "Lấy ảnh nhóm Beauty.",
    mustNotDo: "Không lấy ảnh Wedding/cưới.",
    serviceGroupExpected: "beauty", isRequired: true, priorContext: [], sortOrder: 2,
  },
  {
    title: "CASE 3 — Ảnh cô dâu chú rể", customerMessage: "Bộ này bên mình chụp được không?",
    optionalImage: null, expectedIntent: "wedding_album",
    expectedBehavior: "Coi là cưới (wedding_album hoặc wedding_gate), tư vấn cưới.",
    mustNotDo: "Không gửi beauty cá nhân.",
    serviceGroupExpected: "wedding_album", isRequired: true,
    priorContext: [], sortOrder: 3,
  },
  {
    title: "CASE 4 — Hỏi váy cưới", customerMessage: "Bên em có váy cưới không?",
    optionalImage: null, expectedIntent: "rental_outfit",
    expectedBehavior: "Điều hướng Cho thuê đồ; nếu gửi mẫu thì lấy váy cưới từ Cho thuê đồ.",
    mustNotDo: "Không lấy concept cưới demo.",
    serviceGroupExpected: "rental_outfit", isRequired: true, priorContext: [], sortOrder: 4,
  },
  {
    title: "CASE 5 — Concept lạ", customerMessage: "Mình muốn concept lạ hơn",
    optionalImage: null, expectedIntent: "new_concept_idea",
    expectedBehavior: "Có thể dùng Ý tưởng chụp ảnh; phải nói rõ là concept tham khảo, cần kiểm tra đồ/đạo cụ/địa điểm.",
    mustNotDo: "Không khẳng định chắc làm được, không trình bày ý tưởng như sản phẩm có sẵn.",
    serviceGroupExpected: "new_concept_idea", isRequired: true, priorContext: [], sortOrder: 5,
  },
  {
    title: "CASE 6 — Chụp cổng", customerMessage: "Chụp cổng bao nhiêu?",
    optionalImage: null, expectedIntent: "wedding_gate",
    expectedBehavior: "Nhận là chụp cổng; hỏi gu trước rồi mới tư vấn gói chụp cổng.",
    mustNotDo: "Không gửi album ngoại cảnh khi khách chưa hỏi; không gộp 'chụp cổng' với 'ngày cưới'.",
    serviceGroupExpected: "wedding_gate", isRequired: true, priorContext: [], sortOrder: 6,
  },
  {
    title: "CASE 7 — 'Có mẫu không?' sau khi hỏi beauty", customerMessage: "Có mẫu không?",
    optionalImage: null, expectedIntent: "beauty",
    expectedBehavior: "Gửi mẫu beauty (giữ đúng nhu cầu beauty đã nói trước đó).",
    mustNotDo: "Không tự đổi sang cưới.",
    serviceGroupExpected: "beauty", isRequired: true,
    priorContext: [
      { direction: "incoming", text: "Anh muốn chụp beauty" },
      { direction: "outgoing", text: "Dạ beauty bên em nhiều mood lắm ạ. Anh thích nhẹ nhàng hay cá tính ạ?" },
    ], sortOrder: 7,
  },
  {
    title: "CASE 8 — 'Có mẫu không?' sau khi hỏi chụp cổng", customerMessage: "Có mẫu không?",
    optionalImage: null, expectedIntent: "wedding_gate",
    expectedBehavior: "Gửi mẫu chụp cổng (giữ đúng nhu cầu chụp cổng trước đó).",
    mustNotDo: "Không gửi beauty.",
    serviceGroupExpected: "wedding_gate", isRequired: true,
    priorContext: [
      { direction: "incoming", text: "Anh muốn chụp cổng" },
      { direction: "outgoing", text: "Dạ chụp cổng đó anh 😊. Anh thích kiểu nhẹ nhàng hay sang trọng ạ?" },
    ], sortOrder: 8,
  },
  {
    title: "CASE 9 — Ảnh khó phân biệt", customerMessage: "Bên mình chụp kiểu này nha",
    optionalImage: null, expectedIntent: null,
    expectedBehavior: "Hỏi lại khách muốn chụp cá nhân hay cưới (không đoán bừa).",
    mustNotDo: "Không gửi link/ảnh bừa khi chưa rõ nhu cầu.",
    serviceGroupExpected: null, isRequired: true, priorContext: [], sortOrder: 9,
  },
  {
    title: "CASE 10 — Kiểm tra văn phong", customerMessage: "Bên mình tư vấn giúp anh với",
    optionalImage: null, expectedIntent: null,
    expectedBehavior: "Văn phong tự nhiên như nhân viên Hoa: có xuống dòng, câu ngắn gọn, lễ phép, không quá quảng cáo.",
    mustNotDo: "Không dùng nhiều dấu gạch ngang dài '—'; không nói như robot/quảng cáo lố.",
    serviceGroupExpected: null, isRequired: true, priorContext: [], sortOrder: 10,
  },
];

async function seedDefaultTestCases(): Promise<void> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM lulu_brain_test_cases`);
  if (Number(r.rows[0]?.n ?? 0) > 0) return;
  for (const tc of DEFAULT_TEST_CASES) {
    await pool.query(
      `INSERT INTO lulu_brain_test_cases
         (title, customer_message, optional_image, expected_intent, expected_behavior,
          must_not_do, service_group_expected, is_required, prior_context_json, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tc.title, tc.customerMessage, tc.optionalImage, tc.expectedIntent, tc.expectedBehavior,
       tc.mustNotDo, tc.serviceGroupExpected, tc.isRequired,
       JSON.stringify(tc.priorContext ?? []), tc.sortOrder],
    );
  }
}

// ─── Cache "bộ luật active" cho luồng trả lời sống ────────────────────────────

let activeRulesCache: { value: string | null; at: number } | null = null;
const TTL_MS = 30 * 1000;

export function clearActiveRulesCache(): void {
  activeRulesCache = null;
}

/**
 * Bộ luật não Lulu của version ĐANG ÁP DỤNG (active). null nếu chưa có version active / lỗi DB
 * → caller truyền null vào askClaudeForReply → claude-sale.ts tự dùng DEFAULT_BRAIN_RULES.
 * KHÔNG bao giờ throw (giống getClaudeSaleSettings).
 */
export async function getActiveBrainRules(): Promise<string | null> {
  if (activeRulesCache && Date.now() - activeRulesCache.at < TTL_MS) return activeRulesCache.value;
  try {
    await ensureBrainLabTables();
    const r = await pool.query(
      `SELECT prompt_content FROM lulu_brain_versions WHERE status = 'active' LIMIT 1`,
    );
    const value = r.rows.length > 0 ? String(r.rows[0].prompt_content ?? "").trim() || null : null;
    activeRulesCache = { value, at: Date.now() };
    return value;
  } catch (err) {
    console.error("[BrainLab] getActiveBrainRules — dùng mặc định:", String(err).slice(0, 200));
    return null;
  }
}

// ─── Override ẢNH "admin dạy Lulu" (rulesJson.imageOverrides) ─────────────────
//
// Lưu trong rulesJson của version → đi theo version: nháp test riêng, áp dụng thì active dùng.
// getActiveImageOverrides() nằm trên luồng SỐNG (Messenger) → KHÔNG bao giờ throw (lỗi → []).

let activeOverridesCache: { value: ImageOverride[]; at: number } | null = null;

export function clearActiveOverridesCache(): void {
  activeOverridesCache = null;
}

/** Override ảnh của version ĐANG ÁP DỤNG (active). [] nếu chưa có / lỗi DB. */
export async function getActiveImageOverrides(): Promise<ImageOverride[]> {
  if (activeOverridesCache && Date.now() - activeOverridesCache.at < TTL_MS) return activeOverridesCache.value;
  try {
    await ensureBrainLabTables();
    const r = await pool.query(`SELECT rules_json FROM lulu_brain_versions WHERE status = 'active' LIMIT 1`);
    const value = r.rows.length > 0 ? parseImageOverrides(r.rows[0].rules_json) : [];
    activeOverridesCache = { value, at: Date.now() };
    return value;
  } catch (err) {
    console.error("[BrainLab] getActiveImageOverrides — bỏ qua override:", String(err).slice(0, 200));
    return [];
  }
}

/** Đọc override ảnh của 1 version bất kỳ (dùng cho test bản nháp). [] nếu lỗi. */
export async function getImageOverridesForVersion(versionId: number): Promise<ImageOverride[]> {
  try {
    const v = await getVersion(versionId);
    return v ? parseImageOverrides(v.rulesJson) : [];
  } catch { return []; }
}

/**
 * Thêm 1 override ảnh vào BẢN NHÁP (rulesJson.imageOverrides). Chỉ sửa được version draft.
 * Giữ các field rulesJson khác. Trả version sau cập nhật (null nếu không phải nháp / không tìm thấy).
 */
export async function appendImageOverrideToDraft(
  draftId: number, override: ImageOverride,
): Promise<{ version: BrainVersion | null; total: number }> {
  await ensureBrainLabTables();
  const cur = await getVersion(draftId);
  if (!cur || cur.status !== "draft") return { version: null, total: 0 };
  const existing = parseImageOverrides(cur.rulesJson);
  // Cùng intent+tone (đã chuẩn hóa) coi như cùng tình huống → THAY (mới nhất thắng), không nhân bản.
  const sameSit = (a: ImageOverride, b: ImageOverride) =>
    (a.intent ?? "").trim().toLowerCase() === (b.intent ?? "").trim().toLowerCase() &&
    (a.tone ?? "").trim().toLowerCase() === (b.tone ?? "").trim().toLowerCase();
  const kept = existing.filter((o) => !sameSit(o, override));
  const next = [...kept, override];
  const updated = await updateDraftVersion(draftId, { rulesJson: withImageOverrides(cur.rulesJson, next) });
  return { version: updated, total: next.length };
}

// ─── Map row ──────────────────────────────────────────────────────────────────

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

function mapVersion(r: Record<string, unknown>): BrainVersion {
  return {
    id: Number(r.id),
    versionNumber: Number(r.version_number),
    title: (r.title as string) ?? "",
    description: (r.description as string) ?? "",
    status: (r.status as BrainVersionStatus) ?? "draft",
    promptContent: (r.prompt_content as string) ?? "",
    rulesJson: r.rules_json ?? null,
    createdBy: r.created_by != null ? Number(r.created_by) : null,
    createdByName: (r.created_by_name as string) ?? null,
    createdAt: iso(r.created_at) ?? "",
    appliedBy: r.applied_by != null ? Number(r.applied_by) : null,
    appliedByName: (r.applied_by_name as string) ?? null,
    appliedAt: iso(r.applied_at),
    basedOnVersionId: r.based_on_version_id != null ? Number(r.based_on_version_id) : null,
    changeSummary: (r.change_summary as string) ?? null,
    rollbackNote: (r.rollback_note as string) ?? null,
    updatedAt: iso(r.updated_at) ?? "",
  };
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === "string" && raw.trim()) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p.map((x) => String(x)); } catch { /* ignore */ }
  }
  return [];
}

function mapChangeRequest(r: Record<string, unknown>): ChangeRequest {
  return {
    id: Number(r.id),
    requesterId: r.requester_id != null ? Number(r.requester_id) : null,
    requesterName: (r.requester_name as string) ?? null,
    issueTitle: (r.issue_title as string) ?? "",
    issueDescription: (r.issue_description as string) ?? "",
    exampleCustomerMessage: (r.example_customer_message as string) ?? null,
    expectedBehavior: (r.expected_behavior as string) ?? null,
    currentWrongBehavior: (r.current_wrong_behavior as string) ?? null,
    screenshotUrl: (r.screenshot_url as string) ?? null,
    status: (r.status as ChangeRequestStatus) ?? "open",
    linkedVersionId: r.linked_version_id != null ? Number(r.linked_version_id) : null,
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

function mapTestCase(r: Record<string, unknown>): BrainTestCase {
  let prior: BrainTestCase["priorContext"] = [];
  const raw = r.prior_context_json;
  const arr = Array.isArray(raw) ? raw : (typeof raw === "string" && raw.trim() ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : []);
  if (Array.isArray(arr)) {
    prior = arr
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        const o = x as Record<string, unknown>;
        return { direction: o.direction === "outgoing" ? "outgoing" as const : "incoming" as const, text: String(o.text ?? "") };
      })
      .filter((x) => x.text.trim());
  }
  return {
    id: Number(r.id),
    title: (r.title as string) ?? "",
    customerMessage: (r.customer_message as string) ?? "",
    optionalImage: (r.optional_image as string) ?? null,
    expectedIntent: (r.expected_intent as string) ?? null,
    expectedBehavior: (r.expected_behavior as string) ?? null,
    mustNotDo: (r.must_not_do as string) ?? null,
    serviceGroupExpected: (r.service_group_expected as string) ?? null,
    isRequired: !!r.is_required,
    priorContext: prior,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: iso(r.created_at) ?? "",
  };
}

function mapTestResult(r: Record<string, unknown>): BrainTestResult {
  return {
    id: Number(r.id),
    brainVersionId: Number(r.brain_version_id),
    testCaseId: r.test_case_id != null ? Number(r.test_case_id) : null,
    actualReply: (r.actual_reply as string) ?? "",
    detectedIntent: (r.detected_intent as string) ?? null,
    sampleImages: parseJsonArray(r.sample_images_json),
    passed: r.passed == null ? null : !!r.passed,
    failReason: (r.fail_reason as string) ?? null,
    createdBy: r.created_by != null ? Number(r.created_by) : null,
    createdAt: iso(r.created_at) ?? "",
  };
}

// ─── Version: đọc ─────────────────────────────────────────────────────────────

export async function listVersions(limit = 200): Promise<BrainVersion[]> {
  await ensureBrainLabTables();
  const res = await pool.query(
    `SELECT * FROM lulu_brain_versions
      ORDER BY version_number DESC
      LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  return (res.rows as Array<Record<string, unknown>>).map(mapVersion);
}

export async function getVersion(id: number): Promise<BrainVersion | null> {
  await ensureBrainLabTables();
  const res = await pool.query(`SELECT * FROM lulu_brain_versions WHERE id = $1`, [id]);
  return res.rows.length ? mapVersion(res.rows[0] as Record<string, unknown>) : null;
}

export async function getActiveVersion(): Promise<BrainVersion | null> {
  await ensureBrainLabTables();
  const res = await pool.query(`SELECT * FROM lulu_brain_versions WHERE status = 'active' LIMIT 1`);
  return res.rows.length ? mapVersion(res.rows[0] as Record<string, unknown>) : null;
}

/**
 * BẢN NHÁP ĐANG MỞ = bản nháp (status='draft') MỚI NHẤT. null nếu không có.
 * Đây là "một bản nháp duy nhất" mà mọi lần sửa/báo lỗi sẽ gom vào (không đẻ version rác).
 * Có thể tồn tại nhiều dòng 'draft' cũ trong DB (lịch sử) → luôn lấy version_number lớn nhất.
 */
export async function getOpenDraftVersion(): Promise<BrainVersion | null> {
  await ensureBrainLabTables();
  const res = await pool.query(
    `SELECT * FROM lulu_brain_versions WHERE status = 'draft' ORDER BY version_number DESC LIMIT 1`,
  );
  return res.rows.length ? mapVersion(res.rows[0] as Record<string, unknown>) : null;
}

/**
 * Gom về đúng MỘT bản nháp đang mở: đánh dấu các nháp khác thành 'rejected' (KHÔNG xoá — giữ lịch sử).
 * Gọi khi vừa tạo một nháp mới, để dọn các nháp rác cũ một cách an toàn. Chỉ đụng status='draft'.
 */
export async function rejectOtherDrafts(keepId: number): Promise<number> {
  await ensureBrainLabTables();
  const r = await pool.query(
    `UPDATE lulu_brain_versions
        SET status = 'rejected',
            rollback_note = COALESCE(rollback_note, 'Tự dọn: gom về 1 bản nháp đang mở'),
            updated_at = NOW()
      WHERE status = 'draft' AND id <> $1`,
    [keepId],
  );
  return r.rowCount ?? 0;
}

async function nextVersionNumber(): Promise<number> {
  const r = await pool.query(`SELECT COALESCE(MAX(version_number), 0) AS n FROM lulu_brain_versions`);
  return Number(r.rows[0]?.n ?? 0) + 1;
}

// ─── Version: tạo / sửa nháp ──────────────────────────────────────────────────

export type CreateDraftInput = {
  title: string;
  description?: string;
  promptContent: string;
  rulesJson?: unknown;
  basedOnVersionId?: number | null;
  changeSummary?: string | null;
  createdBy?: number | null;
  createdByName?: string | null;
};

/** Tạo BẢN NHÁP mới (status='draft'). KHÔNG áp dụng. */
export async function createDraftVersion(input: CreateDraftInput): Promise<BrainVersion> {
  await ensureBrainLabTables();
  const vn = await nextVersionNumber();
  const res = await pool.query(
    `INSERT INTO lulu_brain_versions
       (version_number, title, description, status, prompt_content, rules_json,
        based_on_version_id, change_summary, created_by, created_by_name)
     VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [vn, input.title.slice(0, 200), (input.description ?? "").slice(0, 4000),
     input.promptContent, input.rulesJson != null ? JSON.stringify(input.rulesJson) : null,
     input.basedOnVersionId ?? null, (input.changeSummary ?? "").slice(0, 4000) || null,
     input.createdBy ?? null, input.createdByName ?? null],
  );
  return mapVersion(res.rows[0] as Record<string, unknown>);
}

export type UpdateDraftInput = {
  title?: string;
  description?: string;
  promptContent?: string;
  rulesJson?: unknown;
  changeSummary?: string | null;
};

/** Sửa tay bản nháp (chỉ version status='draft'). Trả null nếu không phải nháp. */
export async function updateDraftVersion(id: number, patch: UpdateDraftInput): Promise<BrainVersion | null> {
  await ensureBrainLabTables();
  const cur = await getVersion(id);
  if (!cur) return null;
  if (cur.status !== "draft") return null; // chỉ sửa được bản nháp — không sửa version đã active/archived
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (typeof patch.title === "string") add("title", patch.title.slice(0, 200));
  if (typeof patch.description === "string") add("description", patch.description.slice(0, 4000));
  if (typeof patch.promptContent === "string") add("prompt_content", patch.promptContent);
  if (patch.rulesJson !== undefined) add("rules_json", patch.rulesJson != null ? JSON.stringify(patch.rulesJson) : null);
  if (patch.changeSummary !== undefined) add("change_summary", (patch.changeSummary ?? "").slice(0, 4000) || null);
  if (sets.length === 0) return cur;
  params.push(id);
  const res = await pool.query(
    `UPDATE lulu_brain_versions SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return res.rows.length ? mapVersion(res.rows[0] as Record<string, unknown>) : null;
}

/** Hủy bản nháp → status='rejected' (giữ lịch sử, KHÔNG xoá). */
export async function rejectVersion(id: number, note?: string): Promise<BrainVersion | null> {
  await ensureBrainLabTables();
  const cur = await getVersion(id);
  if (!cur || cur.status !== "draft") return null;
  const res = await pool.query(
    `UPDATE lulu_brain_versions SET status = 'rejected', rollback_note = COALESCE($2, rollback_note), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, note ?? null],
  );
  return res.rows.length ? mapVersion(res.rows[0] as Record<string, unknown>) : null;
}

// ─── Version: áp dụng (admin) — PHẦN 7 ────────────────────────────────────────

/**
 * Áp dụng bản nháp:
 *  1. version active hiện tại → archived.
 *  2. bản nháp → active (+ applied_by/applied_at).
 *  Giao dịch (transaction) để không có 2 active. Không xoá version cũ.
 */
export async function applyDraftVersion(
  id: number, appliedBy: number | null, appliedByName: string | null,
): Promise<{ ok: boolean; version?: BrainVersion; error?: string; missingMarkers?: string[] }> {
  await ensureBrainLabTables();
  const cur = await getVersion(id);
  if (!cur) return { ok: false, error: "Không tìm thấy version" };
  if (cur.status === "active") return { ok: false, error: "Version này đang là bản chạy thật rồi" };
  if (cur.status !== "draft") return { ok: false, error: "Chỉ áp dụng được bản nháp (draft)" };

  // LƯỚI AN TOÀN (chặn cứng ở backend, không chỉ UI): bản nháp KHÔNG được đánh mất marker
  // kỹ thuật đang có trong bản chạy thật — nếu mất, Lulu sẽ hỏng chức năng gửi ảnh mẫu/giá/handoff.
  const activeRef = await getActiveVersion();
  const referenceContent = activeRef?.promptContent?.trim() || DEFAULT_BRAIN_RULES;
  const lost = missingMarkers(cur.promptContent, referenceContent);
  if (lost.length) {
    return {
      ok: false,
      missingMarkers: lost,
      error: `Bản nháp đang thiếu dấu hiệu kỹ thuật quan trọng: ${lost.join(", ")}. `
        + "Hãy sửa tay thêm lại đủ marker rồi mới áp dụng (tránh Lulu mất chức năng gửi ảnh mẫu / ảnh bảng giá / chuyển người thật).",
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE lulu_brain_versions SET status = 'archived', updated_at = NOW() WHERE status = 'active'`,
    );
    const res = await client.query(
      `UPDATE lulu_brain_versions
         SET status = 'active', applied_by = $2, applied_by_name = $3, applied_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, appliedBy, appliedByName],
    );
    await client.query("COMMIT");
    clearActiveRulesCache(); clearActiveOverridesCache();
    return { ok: true, version: mapVersion(res.rows[0] as Record<string, unknown>) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, error: String(err).slice(0, 200) };
  } finally {
    client.release();
  }
}

// ─── Version: khôi phục (admin) — PHẦN 8 ──────────────────────────────────────

/**
 * Khôi phục một version cũ: TẠO version MỚI dựa trên nội dung version cũ rồi set active
 * (archive active hiện tại). KHÔNG xoá lịch sử.
 */
export async function rollbackToVersion(
  sourceId: number, appliedBy: number | null, appliedByName: string | null, note?: string,
): Promise<{ ok: boolean; version?: BrainVersion; error?: string }> {
  await ensureBrainLabTables();
  const src = await getVersion(sourceId);
  if (!src) return { ok: false, error: "Không tìm thấy version nguồn" };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const vnRes = await client.query(`SELECT COALESCE(MAX(version_number), 0) AS n FROM lulu_brain_versions`);
    const vn = Number(vnRes.rows[0]?.n ?? 0) + 1;
    await client.query(
      `UPDATE lulu_brain_versions SET status = 'archived', updated_at = NOW() WHERE status = 'active'`,
    );
    const res = await client.query(
      `INSERT INTO lulu_brain_versions
         (version_number, title, description, status, prompt_content, rules_json,
          based_on_version_id, change_summary, rollback_note,
          created_by, created_by_name, applied_by, applied_by_name, applied_at)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$9,$10,NOW())
       RETURNING *`,
      [vn,
       `Khôi phục từ Version ${src.versionNumber}`,
       `Khôi phục nội dung của Version ${src.versionNumber}: ${src.title}`,
       src.promptContent,
       src.rulesJson != null ? JSON.stringify(src.rulesJson) : null,
       src.id,
       `Khôi phục (rollback) về Version ${src.versionNumber}.`,
       (note ?? "").slice(0, 2000) || `Khôi phục về Version ${src.versionNumber}`,
       appliedBy, appliedByName],
    );
    await client.query("COMMIT");
    clearActiveRulesCache(); clearActiveOverridesCache();
    return { ok: true, version: mapVersion(res.rows[0] as Record<string, unknown>) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, error: String(err).slice(0, 200) };
  } finally {
    client.release();
  }
}

// ─── Change Request (báo lỗi / góp ý) ─────────────────────────────────────────

export type CreateChangeRequestInput = {
  requesterId?: number | null;
  requesterName?: string | null;
  issueTitle: string;
  issueDescription?: string;
  exampleCustomerMessage?: string | null;
  expectedBehavior?: string | null;
  currentWrongBehavior?: string | null;
  screenshotUrl?: string | null;
};

export async function createChangeRequest(input: CreateChangeRequestInput): Promise<ChangeRequest> {
  await ensureBrainLabTables();
  const res = await pool.query(
    `INSERT INTO lulu_brain_change_requests
       (requester_id, requester_name, issue_title, issue_description,
        example_customer_message, expected_behavior, current_wrong_behavior, screenshot_url, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')
     RETURNING *`,
    [input.requesterId ?? null, input.requesterName ?? null,
     input.issueTitle.slice(0, 300), (input.issueDescription ?? "").slice(0, 4000),
     input.exampleCustomerMessage ?? null, input.expectedBehavior ?? null,
     input.currentWrongBehavior ?? null, input.screenshotUrl ?? null],
  );
  return mapChangeRequest(res.rows[0] as Record<string, unknown>);
}

export async function listChangeRequests(status?: ChangeRequestStatus | "all", limit = 200): Promise<ChangeRequest[]> {
  await ensureBrainLabTables();
  const params: unknown[] = [];
  let where = "";
  if (status && status !== "all") { params.push(status); where = `WHERE status = $1`; }
  params.push(Math.min(500, Math.max(1, limit)));
  const res = await pool.query(
    `SELECT * FROM lulu_brain_change_requests ${where}
      ORDER BY (status='open') DESC, created_at DESC LIMIT $${params.length}`,
    params,
  );
  return (res.rows as Array<Record<string, unknown>>).map(mapChangeRequest);
}

export async function setChangeRequestStatus(
  id: number, status: ChangeRequestStatus, linkedVersionId?: number | null,
): Promise<ChangeRequest | null> {
  await ensureBrainLabTables();
  const res = await pool.query(
    `UPDATE lulu_brain_change_requests
        SET status = $2, linked_version_id = COALESCE($3, linked_version_id), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, status, linkedVersionId ?? null],
  );
  return res.rows.length ? mapChangeRequest(res.rows[0] as Record<string, unknown>) : null;
}

// ─── Test cases ───────────────────────────────────────────────────────────────

export async function listTestCases(): Promise<BrainTestCase[]> {
  await ensureBrainLabTables();
  const res = await pool.query(`SELECT * FROM lulu_brain_test_cases ORDER BY sort_order ASC, id ASC`);
  return (res.rows as Array<Record<string, unknown>>).map(mapTestCase);
}

export async function getTestCase(id: number): Promise<BrainTestCase | null> {
  await ensureBrainLabTables();
  const res = await pool.query(`SELECT * FROM lulu_brain_test_cases WHERE id = $1`, [id]);
  return res.rows.length ? mapTestCase(res.rows[0] as Record<string, unknown>) : null;
}

export type CreateTestCaseInput = {
  title: string;
  customerMessage: string;
  expectedIntent?: string | null;
  expectedBehavior?: string | null;
  mustNotDo?: string | null;
  serviceGroupExpected?: string | null;
  isRequired?: boolean;
  priorContext?: Array<{ direction: "incoming" | "outgoing"; text: string }>;
};

export async function createTestCase(input: CreateTestCaseInput): Promise<BrainTestCase> {
  await ensureBrainLabTables();
  const orderRes = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) AS n FROM lulu_brain_test_cases`);
  const order = Number(orderRes.rows[0]?.n ?? 0) + 1;
  const res = await pool.query(
    `INSERT INTO lulu_brain_test_cases
       (title, customer_message, expected_intent, expected_behavior, must_not_do,
        service_group_expected, is_required, prior_context_json, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [input.title.slice(0, 300), input.customerMessage, input.expectedIntent ?? null,
     input.expectedBehavior ?? null, input.mustNotDo ?? null, input.serviceGroupExpected ?? null,
     input.isRequired ?? true, JSON.stringify(input.priorContext ?? []), order],
  );
  return mapTestCase(res.rows[0] as Record<string, unknown>);
}

export async function deleteTestCase(id: number): Promise<boolean> {
  await ensureBrainLabTables();
  const r = await pool.query(`DELETE FROM lulu_brain_test_cases WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

// ─── Test results ─────────────────────────────────────────────────────────────

export type SaveTestResultInput = {
  brainVersionId: number;
  testCaseId?: number | null;
  actualReply: string;
  detectedIntent?: string | null;
  sampleImages?: string[];
  passed?: boolean | null;
  failReason?: string | null;
  createdBy?: number | null;
};

export async function saveTestResult(input: SaveTestResultInput): Promise<BrainTestResult> {
  await ensureBrainLabTables();
  const res = await pool.query(
    `INSERT INTO lulu_brain_test_results
       (brain_version_id, test_case_id, actual_reply, detected_intent, sample_images_json,
        passed, fail_reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [input.brainVersionId, input.testCaseId ?? null, (input.actualReply ?? "").slice(0, 8000),
     input.detectedIntent ?? null,
     input.sampleImages && input.sampleImages.length ? JSON.stringify(input.sampleImages) : null,
     input.passed ?? null, input.failReason ?? null, input.createdBy ?? null],
  );
  return mapTestResult(res.rows[0] as Record<string, unknown>);
}

export async function listTestResults(brainVersionId: number, limit = 100): Promise<BrainTestResult[]> {
  await ensureBrainLabTables();
  const res = await pool.query(
    `SELECT * FROM lulu_brain_test_results WHERE brain_version_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [brainVersionId, Math.min(500, Math.max(1, limit))],
  );
  return (res.rows as Array<Record<string, unknown>>).map(mapTestResult);
}
