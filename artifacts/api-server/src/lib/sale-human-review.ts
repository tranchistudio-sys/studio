import { pool } from "@workspace/db";

/**
 * Lulu Human Review — "Câu hỏi lạ cần xử lý".
 *
 * Khi Lulu KHÔNG chắc (câu lạ, deal giá sâu, khiếu nại, ảnh không rõ nhu cầu, lịch/cam kết...)
 * → KHÔNG tự trả lời nội dung chính. Thay vào đó gửi 1 câu giữ khách, tạo 1 "báo đỏ" ở đây cho
 * nhân viên thật trả lời, rồi mới gửi cho khách.
 *
 * AN TOÀN: bảng RIÊNG của module sale AI. KHÔNG đụng booking/payment/calendar/attendance/CRM.
 * Khóa theo facebook_user_id (psid) — KHÔNG ràng buộc FK. Tạm dừng bot dùng crm_leads.ai_mode
 * (KHÔNG có cờ bot_paused riêng để tránh 2 nguồn sự thật).
 */

/** Câu giữ khách mặc định khi escalate (gửi 1 lần / mỗi escalation). */
export const HOLD_MESSAGE = "Dạ để em kiểm tra kỹ lại phần này cho mình xíu nha.";

export type HumanReviewStatus = "open" | "sent" | "ignored";
export type HumanReviewPriority = "normal" | "high" | "urgent";

let createdTable = false;
export async function ensureHumanReviewTable(): Promise<void> {
  if (createdTable) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_human_reviews (
      id                    SERIAL PRIMARY KEY,
      facebook_user_id      TEXT NOT NULL,
      channel               TEXT NOT NULL DEFAULT 'messenger',
      customer_name         TEXT,
      customer_question     TEXT NOT NULL DEFAULT '',
      customer_images_json  JSONB,
      detected_intent       TEXT,
      confidence            NUMERIC,
      reason_for_escalation TEXT NOT NULL DEFAULT '',
      ai_suggested_reply    TEXT,
      staff_reply           TEXT,
      staff_id              INTEGER,
      status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','sent','ignored')),
      priority              TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
      saved_to_playbook     BOOLEAN NOT NULL DEFAULT false,
      hold_message_sent_at  TIMESTAMP,
      followup_hold_sent_at TIMESTAMP,
      created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMP NOT NULL DEFAULT NOW(),
      sent_at               TIMESTAMP
    )
  `);
  // 1 review "open" / khách → tra cứu nhanh + chống tạo trùng báo đỏ.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lulu_hr_open_user
     ON lulu_human_reviews (facebook_user_id) WHERE status = 'open'`,
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_lulu_hr_status_created
     ON lulu_human_reviews (status, created_at DESC)`,
  ).catch(() => {});
  createdTable = true;
}

/**
 * Lý do escalate phát sinh TỪ ẢNH khách gửi (chỉ khi có imageIntent).
 * - can_studio_do=false → concept lạ cần kiểm đồ/đạo cụ.
 * - confidence < threshold → không chắc nhu cầu → cần người thật (đừng gửi ảnh bừa).
 * Trả null nếu ảnh đủ chắc / không có ảnh.
 */
export function imageEscalationReason(
  intent: { confidence?: number | null; can_studio_do?: boolean; service_intent?: string } | null | undefined,
  threshold: number,
): string | null {
  if (!intent) return null;
  if (intent.can_studio_do === false) {
    return "Ảnh concept lạ — chưa chắc studio làm được, cần kiểm tra đồ/đạo cụ";
  }
  if (typeof intent.confidence === "number" && intent.confidence < threshold) {
    return "Ảnh khách gửi không rõ nhu cầu (độ tin thấp) — cần nhân viên xác nhận";
  }
  return null;
}

export type UpsertReviewInput = {
  facebookUserId: string;
  channel?: string;
  customerName?: string | null;
  customerQuestion: string;
  customerImages?: string[] | null;
  detectedIntent?: string | null;
  confidence?: number | null;
  reasonForEscalation: string;
  aiSuggestedReply?: string | null;
  priority?: HumanReviewPriority;
};

/**
 * Tạo MỚI hoặc CẬP NHẬT báo đỏ đang "open" cho cùng 1 khách (chống spam — điểm 3).
 * Trả { id, created, holdAlreadySent } để bên gọi quyết định có gửi hold message không.
 */
export async function upsertOpenHumanReview(
  input: UpsertReviewInput,
): Promise<{ id: number; created: boolean; holdAlreadySent: boolean }> {
  await ensureHumanReviewTable();
  const channel = input.channel ?? "messenger";
  const imagesJson = input.customerImages && input.customerImages.length > 0
    ? JSON.stringify(input.customerImages)
    : null;
  const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence)
    ? input.confidence
    : null;

  const existing = await pool.query(
    `SELECT id, hold_message_sent_at FROM lulu_human_reviews
      WHERE facebook_user_id = $1 AND status = 'open'
      ORDER BY id DESC LIMIT 1`,
    [input.facebookUserId],
  );
  if (existing.rows.length > 0) {
    const id = Number(existing.rows[0].id);
    const holdAlreadySent = !!existing.rows[0].hold_message_sent_at;
    await pool.query(
      `UPDATE lulu_human_reviews SET
         customer_question = $2,
         customer_images_json = COALESCE($3, customer_images_json),
         detected_intent = $4,
         confidence = $5,
         reason_for_escalation = $6,
         ai_suggested_reply = $7,
         customer_name = COALESCE($8, customer_name),
         updated_at = NOW()
       WHERE id = $1`,
      [id, input.customerQuestion.slice(0, 4000), imagesJson, input.detectedIntent ?? null,
        confidence, input.reasonForEscalation.slice(0, 300), input.aiSuggestedReply ?? null,
        input.customerName ?? null],
    );
    return { id, created: false, holdAlreadySent };
  }

  const ins = await pool.query(
    `INSERT INTO lulu_human_reviews
       (facebook_user_id, channel, customer_name, customer_question, customer_images_json,
        detected_intent, confidence, reason_for_escalation, ai_suggested_reply, priority, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')
     RETURNING id`,
    [input.facebookUserId, channel, input.customerName ?? null, input.customerQuestion.slice(0, 4000),
      imagesJson, input.detectedIntent ?? null, confidence, input.reasonForEscalation.slice(0, 300),
      input.aiSuggestedReply ?? null, input.priority ?? "normal"],
  );
  return { id: Number(ins.rows[0].id), created: true, holdAlreadySent: false };
}

/** Đánh dấu đã gửi câu giữ khách (để không lặp — điểm 4). */
export async function markHoldSent(id: number): Promise<void> {
  await ensureHumanReviewTable();
  await pool.query(
    `UPDATE lulu_human_reviews SET hold_message_sent_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND hold_message_sent_at IS NULL`,
    [id],
  );
}

export type HumanReviewRow = {
  id: number;
  facebookUserId: string;
  channel: string;
  customerName: string | null;
  customerQuestion: string;
  customerImages: string[];
  detectedIntent: string | null;
  confidence: number | null;
  reasonForEscalation: string;
  aiSuggestedReply: string | null;
  staffReply: string | null;
  staffId: number | null;
  status: HumanReviewStatus;
  priority: HumanReviewPriority;
  savedToPlaybook: boolean;
  holdMessageSentAt: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
};

function mapRow(r: Record<string, unknown>): HumanReviewRow {
  let images: string[] = [];
  const raw = r.customer_images_json;
  if (Array.isArray(raw)) images = raw.map((x) => String(x));
  else if (typeof raw === "string" && raw.trim()) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) images = p.map((x) => String(x)); } catch { /* ignore */ }
  }
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    id: Number(r.id),
    facebookUserId: String(r.facebook_user_id),
    channel: String(r.channel ?? "messenger"),
    customerName: (r.customer_name as string) ?? null,
    customerQuestion: (r.customer_question as string) ?? "",
    customerImages: images,
    detectedIntent: (r.detected_intent as string) ?? null,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    reasonForEscalation: (r.reason_for_escalation as string) ?? "",
    aiSuggestedReply: (r.ai_suggested_reply as string) ?? null,
    staffReply: (r.staff_reply as string) ?? null,
    staffId: r.staff_id != null ? Number(r.staff_id) : null,
    status: (r.status as HumanReviewStatus) ?? "open",
    priority: (r.priority as HumanReviewPriority) ?? "normal",
    savedToPlaybook: !!r.saved_to_playbook,
    holdMessageSentAt: iso(r.hold_message_sent_at),
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
    sentAt: iso(r.sent_at),
  };
}

export async function listHumanReviews(opts?: {
  status?: HumanReviewStatus | "all";
  priority?: HumanReviewPriority | "all";
  limit?: number;
}): Promise<HumanReviewRow[]> {
  await ensureHumanReviewTable();
  const where: string[] = [];
  const params: unknown[] = [];
  const status = opts?.status ?? "open";
  if (status !== "all") { params.push(status); where.push(`status = $${params.length}`); }
  if (opts?.priority && opts.priority !== "all") { params.push(opts.priority); where.push(`priority = $${params.length}`); }
  params.push(Math.min(500, Math.max(1, opts?.limit ?? 200)));
  const limitIdx = params.length;
  const res = await pool.query(
    `SELECT * FROM lulu_human_reviews
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY (status='open') DESC,
               CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               created_at DESC
      LIMIT $${limitIdx}`,
    params,
  );
  return (res.rows as Array<Record<string, unknown>>).map(mapRow);
}

export async function getHumanReview(id: number): Promise<HumanReviewRow | null> {
  await ensureHumanReviewTable();
  const res = await pool.query(`SELECT * FROM lulu_human_reviews WHERE id = $1`, [id]);
  return res.rows.length ? mapRow(res.rows[0] as Record<string, unknown>) : null;
}

/** Nhân viên đã gửi câu trả lời cho khách → status=sent + lưu nguyên văn staffReply. */
export async function markReviewSent(id: number, staffReply: string, staffId: number | null): Promise<void> {
  await ensureHumanReviewTable();
  await pool.query(
    `UPDATE lulu_human_reviews SET status = 'sent', staff_reply = $2, staff_id = $3,
       sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id, staffReply, staffId],
  );
}

export async function markReviewIgnored(id: number): Promise<void> {
  await ensureHumanReviewTable();
  await pool.query(
    `UPDATE lulu_human_reviews SET status = 'ignored', updated_at = NOW() WHERE id = $1`,
    [id],
  );
}

export async function markReviewSavedToPlaybook(id: number): Promise<void> {
  await ensureHumanReviewTable();
  await pool.query(
    `UPDATE lulu_human_reviews SET saved_to_playbook = true, updated_at = NOW() WHERE id = $1`,
    [id],
  );
}

export async function countOpenReviews(): Promise<number> {
  await ensureHumanReviewTable();
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM lulu_human_reviews WHERE status = 'open'`);
  return Number(r.rows[0]?.n ?? 0) || 0;
}
