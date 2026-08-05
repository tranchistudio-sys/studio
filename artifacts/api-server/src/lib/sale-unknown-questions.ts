import { pool } from "@workspace/db";
import { tokens, tokenSetKey } from "./sale-text-normalize";
import { detectMessageSignals } from "./sale-workflow";

/**
 * UNKNOWN-QUESTION QUEUE — "Câu hỏi chưa có kịch bản" (luật chủ 29/07, mục 1–19).
 *
 * Khi Lulu KHÔNG tìm được golden phù hợp cho câu khách → KHÔNG bịa; ghi câu vào hàng đợi
 * này, gắn ĐÚNG dịch vụ (nếu phân loại được), GOM trùng-nghĩa + đếm số lần. Admin (hoặc AI
 * gợi ý NHÁP) điền câu trả lời → admin DUYỆT → mới thành Golden Q&A. TUYỆT ĐỐI không tự học.
 *
 * BẢNG RIÊNG (không nhồi vào lulu_sale_script_examples) vì saveScripts xoá-hết-ghi-lại theo
 * node sẽ wipe dữ liệu tự thu. Additive, tạo lazy, mirror drizzle (chống DROP-drift PR #132).
 * Câu ở đây CHƯA có ideal_response nên KHÔNG bao giờ lọt đường retrieval golden của Lulu.
 */

export type UnknownStatus = "pending" | "suggested" | "answered" | "ignored";

export type UnknownQuestionRow = {
  id: number;
  customerText: string;
  normalizedIntent: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sampleVariants: string[];
  serviceKey: string | null;
  scenarioKey: string | null;
  nodeKey: string | null;
  status: UnknownStatus;
  suggestedAnswer: string | null;
  suggestedAt: string | null;
  reviewedBy: number | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  promotedScriptId: number | null;
};

let ensured = false;
export async function ensureUnknownQuestionsTable(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_unknown_questions (
      id                 SERIAL PRIMARY KEY,
      customer_text      TEXT NOT NULL DEFAULT '',
      normalized_intent  TEXT NOT NULL DEFAULT '',
      occurrence_count   INTEGER NOT NULL DEFAULT 1,
      first_seen_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      last_seen_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      sample_variants    JSONB NOT NULL DEFAULT '[]'::jsonb,
      service_key        TEXT,
      scenario_key       TEXT,
      node_key           TEXT,
      status             TEXT NOT NULL DEFAULT 'pending',
      suggested_answer   TEXT,
      suggested_at       TIMESTAMP,
      reviewed_by        INTEGER,
      reviewed_by_name   TEXT,
      reviewed_at        TIMESTAMP,
      promoted_script_id INTEGER,
      created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  // Dedup: cùng normalized_intent + cùng service_key = MỘT nhóm (đếm số lần). COALESCE để
  // null service_key (câu lạ chung) vẫn gom được. Dùng expression index cho phần null.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lulu_unknown_key
     ON lulu_unknown_questions (normalized_intent, COALESCE(service_key, ''))`,
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lulu_unknown_status ON lulu_unknown_questions (status, last_seen_at DESC)`);
  ensured = true;
}

function mapRow(r: Record<string, unknown>): UnknownQuestionRow {
  const variants = r.sample_variants;
  return {
    id: Number(r.id),
    customerText: (r.customer_text as string) ?? "",
    normalizedIntent: (r.normalized_intent as string) ?? "",
    occurrenceCount: Number(r.occurrence_count ?? 1),
    firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at as string).toISOString() : "",
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at as string).toISOString() : "",
    sampleVariants: Array.isArray(variants) ? (variants as string[]) : [],
    serviceKey: (r.service_key as string) ?? null,
    scenarioKey: (r.scenario_key as string) ?? null,
    nodeKey: (r.node_key as string) ?? null,
    status: ((r.status as string) ?? "pending") as UnknownStatus,
    suggestedAnswer: (r.suggested_answer as string) ?? null,
    suggestedAt: r.suggested_at ? new Date(r.suggested_at as string).toISOString() : null,
    reviewedBy: r.reviewed_by != null ? Number(r.reviewed_by) : null,
    reviewedByName: (r.reviewed_by_name as string) ?? null,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at as string).toISOString() : null,
    promotedScriptId: r.promoted_script_id != null ? Number(r.promoted_script_id) : null,
  };
}

/**
 * Câu KHÔNG đáng ghi (noise/spam): chào hỏi thuần, ack ngắn ("ok/dạ"), ảnh/sticker [image:…],
 * emoji, hoặc <2 token nội dung. Dùng lại detectMessageSignals (cùng nguồn với Router → nhất quán).
 */
export function isNoiseForCapture(rawMsg: string): boolean {
  const t = (rawMsg ?? "").trim();
  if (!t) return true;
  if (t.startsWith("[image:") || t.startsWith("[sticker")) return true;
  const sig = detectMessageSignals(t);
  if (sig.greetingOnly || sig.shortAckOrPresence) return true;
  if (tokens(t).length < 2) return true; // quá ngắn/mơ hồ để thành 1 câu hỏi riêng
  return false;
}

export type CaptureInput = {
  customerText: string;
  serviceKey?: string | null;
  scenarioKey?: string | null;
  nodeKey?: string | null;
};
export type CaptureResult =
  | { captured: false; reason: "noise" | "empty_key" | "error" }
  | { captured: true; created: boolean; id: number; occurrenceCount: number };

/**
 * Ghi nhận 1 câu MISS vào hàng đợi. Fail-SAFE tuyệt đối: mọi lỗi → {captured:false} (KHÔNG
 * throw) vì hàm này nằm trên đường sinh reply. Gom theo (normalized_intent, service_key):
 * đã có → occurrence_count++ + last_seen + thêm biến thể; chưa có → tạo mới status='pending'.
 */
export async function captureUnknownQuestion(input: CaptureInput): Promise<CaptureResult> {
  try {
    const text = String(input.customerText ?? "").trim().slice(0, 2000);
    if (isNoiseForCapture(text)) return { captured: false, reason: "noise" };
    const key = tokenSetKey(text);
    if (!key) return { captured: false, reason: "empty_key" };
    await ensureUnknownQuestionsTable();
    const serviceKey = input.serviceKey ?? null;

    // Upsert theo (normalized_intent, COALESCE(service_key,'')).
    const existing = await pool.query(
      `SELECT id, occurrence_count, customer_text, sample_variants FROM lulu_unknown_questions
       WHERE normalized_intent = $1 AND COALESCE(service_key,'') = COALESCE($2,'') LIMIT 1`,
      [key, serviceKey],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { id: number; occurrence_count: number; customer_text: string; sample_variants: unknown };
      const variants: string[] = Array.isArray(row.sample_variants) ? (row.sample_variants as string[]) : [];
      const known = new Set([row.customer_text, ...variants]);
      if (!known.has(text) && variants.length < 12) variants.push(text);
      const next = Number(row.occurrence_count) + 1;
      await pool.query(
        `UPDATE lulu_unknown_questions
           SET occurrence_count = $1, last_seen_at = NOW(), sample_variants = $2::jsonb,
               scenario_key = COALESCE(scenario_key, $3), node_key = COALESCE(node_key, $4), updated_at = NOW()
         WHERE id = $5`,
        [next, JSON.stringify(variants), input.scenarioKey ?? null, input.nodeKey ?? null, row.id],
      );
      return { captured: true, created: false, id: Number(row.id), occurrenceCount: next };
    }

    const ins = await pool.query(
      `INSERT INTO lulu_unknown_questions (customer_text, normalized_intent, service_key, scenario_key, node_key, status)
       VALUES ($1,$2,$3,$4,$5,'pending')
       RETURNING id, occurrence_count`,
      [text, key, serviceKey, input.scenarioKey ?? null, input.nodeKey ?? null],
    );
    const r = ins.rows[0] as { id: number; occurrence_count: number };
    return { captured: true, created: true, id: Number(r.id), occurrenceCount: Number(r.occurrence_count) };
  } catch (err) {
    console.error("[UnknownQ] capture lỗi (fail-safe):", String(err).slice(0, 160));
    return { captured: false, reason: "error" };
  }
}

export type UnknownListFilter = { status?: UnknownStatus | "all"; serviceKey?: string | null };

export async function listUnknownQuestions(filter: UnknownListFilter = {}): Promise<UnknownQuestionRow[]> {
  await ensureUnknownQuestionsTable();
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status && filter.status !== "all") { args.push(filter.status); where.push(`status = $${args.length}`); }
  if (filter.serviceKey) { args.push(filter.serviceKey); where.push(`service_key = $${args.length}`); }
  const sql = `SELECT * FROM lulu_unknown_questions ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY (status='pending') DESC, occurrence_count DESC, last_seen_at DESC LIMIT 500`;
  const r = await pool.query(sql, args);
  return (r.rows as Array<Record<string, unknown>>).map(mapRow);
}

/** Đếm câu chưa xử lý (badge đỏ), gom theo service_key (null → '__general__'). */
export async function countPendingByService(): Promise<Record<string, number>> {
  await ensureUnknownQuestionsTable();
  const r = await pool.query(
    `SELECT COALESCE(service_key,'__general__') AS k, COUNT(*)::int AS c
     FROM lulu_unknown_questions WHERE status IN ('pending','suggested') GROUP BY 1`,
  );
  const out: Record<string, number> = {};
  for (const row of r.rows as Array<{ k: string; c: number }>) out[row.k] = Number(row.c);
  return out;
}

export async function setUnknownStatus(id: number, status: UnknownStatus, by?: { id: number; name: string }): Promise<void> {
  await ensureUnknownQuestionsTable();
  await pool.query(
    `UPDATE lulu_unknown_questions SET status = $1, reviewed_by = $2, reviewed_by_name = $3, reviewed_at = NOW(), updated_at = NOW() WHERE id = $4`,
    [status, by?.id ?? null, by?.name ?? null, id],
  );
}

export async function setSuggestedAnswer(id: number, suggested: string): Promise<void> {
  await ensureUnknownQuestionsTable();
  await pool.query(
    `UPDATE lulu_unknown_questions SET suggested_answer = $1, suggested_at = NOW(), status = CASE WHEN status='pending' THEN 'suggested' ELSE status END, updated_at = NOW() WHERE id = $2`,
    [String(suggested ?? "").slice(0, 4000), id],
  );
}

/** Đánh dấu đã promote thành golden (status='answered' + trỏ script id). */
export async function markPromoted(id: number, scriptId: number | null, by?: { id: number; name: string }): Promise<void> {
  await ensureUnknownQuestionsTable();
  await pool.query(
    `UPDATE lulu_unknown_questions SET status='answered', promoted_script_id = $1, reviewed_by = $2, reviewed_by_name = $3, reviewed_at = NOW(), updated_at = NOW() WHERE id = $4`,
    [scriptId, by?.id ?? null, by?.name ?? null, id],
  );
}

export async function getUnknownQuestion(id: number): Promise<UnknownQuestionRow | null> {
  await ensureUnknownQuestionsTable();
  const r = await pool.query(`SELECT * FROM lulu_unknown_questions WHERE id = $1 LIMIT 1`, [id]);
  return r.rows.length ? mapRow(r.rows[0] as Record<string, unknown>) : null;
}
