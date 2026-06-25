/**
 * autopost-style-jobs.ts — Hàng chờ học "Văn phong mẫu" (async).
 *
 * Vì sao: thao tác "Đọc từ ảnh" / thêm bài mẫu phải gọi AI OCR (30–90s). Trước đây
 * xử lý ĐỒNG BỘ → admin phải chờ. Module này tách thành JOB: route tạo job rồi trả
 * ngay; worker nền (autopost-style-worker.ts) tự OCR + rút văn phong + lưu vào kho
 * autopost_style_samples. Admin thêm liên tục (kể cả 100 bài) không phải chờ.
 *
 * AN TOÀN: chỉ đụng bảng autopost_* (lazy CREATE IF NOT EXISTS), KHÔNG tự đăng bài,
 * KHÔNG đổi luồng AutoPost đang chạy. Bảng + endpoint là cộng-thêm.
 */
import { pool } from "@workspace/db";
import { ocrImageToText } from "./autopost-style";

export type StyleJobStatus = "pending" | "processing" | "done" | "failed";

/** Mỗi job xử lý 1 lần; lỗi → 'failed' để admin bấm Retry (không tự lặp vô hạn). */
export const STYLE_JOB_STATUSES: StyleJobStatus[] = ["pending", "processing", "done", "failed"];

export type StyleJobImage = { dataBase64: string; mediaType: string };

export type CreateStyleJobInput = {
  title: string;
  contentType?: string | null;
  tone?: string | null;
  tags?: string[];
  priority?: number;
  styleTopicKey?: string;
  styleTopicLabel?: string;
  pastedText?: string | null;
  imagesBase64?: StyleJobImage[]; // ảnh cần OCR
  imageUrls?: string[]; // ảnh đã lưu (hiển thị + gắn sample)
  createdBy?: number | null;
};

// ─────────────────────────── PURE HELPERS (unit-test, KHÔNG DB) ───────────────

export function isValidStatus(s: unknown): s is StyleJobStatus {
  return typeof s === "string" && (STYLE_JOB_STATUSES as string[]).includes(s);
}

/** Chỉ job đang 'failed' mới được retry. */
export function canRetry(status: unknown): boolean {
  return status === "failed";
}

/** Trạng thái sau khi worker chạy xong 1 lượt. */
export function nextStatusAfterRun(ok: boolean): StyleJobStatus {
  return ok ? "done" : "failed";
}

/** Rút gọn lỗi cho UI (1 dòng, cắt ngắn). */
export function summarizeError(err: unknown, max = 200): string {
  const msg = err instanceof Error ? err.message : String(err ?? "Lỗi không rõ");
  return msg.replace(/\s+/g, " ").trim().slice(0, max) || "Lỗi không rõ";
}

/** Gộp text dán + text OCR từ các ảnh thành nội dung bài mẫu. */
export function combineContent(pastedText: string | null | undefined, ocrTexts: string[]): string {
  const parts = [String(pastedText ?? "").trim(), ...ocrTexts.map((t) => String(t ?? "").trim())]
    .filter((p) => p.length > 0);
  return parts.join("\n\n").trim();
}

function toArr(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") { try { const j = JSON.parse(raw); return Array.isArray(j) ? j : []; } catch { return []; } }
  return [];
}

/** Map 1 row DB → DTO an toàn cho FE (KHÔNG trả base64 ảnh). */
export function jobRowToDto(r: Record<string, unknown>) {
  const imgs = toArr(r.images_base64);
  const urls = toArr(r.image_urls);
  return {
    id: Number(r.id),
    status: r.status as StyleJobStatus,
    title: String(r.title ?? ""),
    contentType: (r.content_type as string | null) ?? null,
    tone: (r.tone as string | null) ?? null,
    priority: Number(r.priority ?? 0),
    styleTopicLabel: (r.style_topic_label as string | null) ?? null,
    imageCount: imgs.length || urls.length,
    error: (r.error as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    resultSampleId: r.result_sample_id != null ? Number(r.result_sample_id) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─────────────────────────── SCHEMA (lazy) ───────────────────────────────────

let ensured = false;
export async function ensureStyleJobsTable(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS autopost_style_jobs (
      id serial PRIMARY KEY,
      status text NOT NULL DEFAULT 'pending',
      title text NOT NULL DEFAULT '',
      content_type text,
      tone text,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      priority integer NOT NULL DEFAULT 0,
      style_topic_key text NOT NULL DEFAULT 'all',
      style_topic_label text NOT NULL DEFAULT 'Tất cả / Dùng chung',
      pasted_text text,
      images_base64 jsonb NOT NULL DEFAULT '[]'::jsonb,
      image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
      result_sample_id integer,
      error text,
      attempts integer NOT NULL DEFAULT 0,
      claimed_at timestamptz,
      created_by integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_autopost_style_jobs_status ON autopost_style_jobs(status, id)`);
  ensured = true;
}

// ─────────────────────────── DB OPERATIONS ───────────────────────────────────

export async function createStyleJob(input: CreateStyleJobInput): Promise<number> {
  await ensureStyleJobsTable();
  const r = await pool.query(
    `INSERT INTO autopost_style_jobs
       (status, title, content_type, tone, tags, priority, style_topic_key, style_topic_label,
        pasted_text, images_base64, image_urls, created_by)
     VALUES ('pending', $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
     RETURNING id`,
    [
      input.title || "Bài mẫu", input.contentType ?? null, input.tone ?? null,
      JSON.stringify(input.tags ?? []), input.priority ?? 0,
      input.styleTopicKey ?? "all", input.styleTopicLabel ?? "Tất cả / Dùng chung",
      input.pastedText ?? null, JSON.stringify(input.imagesBase64 ?? []),
      JSON.stringify(input.imageUrls ?? []), input.createdBy ?? null,
    ],
  );
  return Number((r.rows[0] as { id: number }).id);
}

export async function listStyleJobs(limit = 50): Promise<ReturnType<typeof jobRowToDto>[]> {
  await ensureStyleJobsTable();
  const r = await pool.query(`SELECT * FROM autopost_style_jobs ORDER BY id DESC LIMIT $1`, [limit]);
  return r.rows.map((row) => jobRowToDto(row as Record<string, unknown>));
}

/** Đưa job 'failed' về 'pending' để worker xử lý lại. Trả false nếu không đủ điều kiện. */
export async function retryStyleJob(id: number): Promise<boolean> {
  await ensureStyleJobsTable();
  const r = await pool.query(
    `UPDATE autopost_style_jobs SET status='pending', error=NULL, updated_at=now()
      WHERE id=$1 AND status='failed' RETURNING id`,
    [id],
  );
  return r.rows.length > 0;
}

/** Atomic-claim 1 job pending (FOR UPDATE SKIP LOCKED → an toàn nhiều worker). */
export async function claimNextStyleJob(): Promise<Record<string, unknown> | null> {
  await ensureStyleJobsTable();
  const r = await pool.query(
    `UPDATE autopost_style_jobs
        SET status='processing', attempts=attempts+1, claimed_at=now(), updated_at=now()
      WHERE id = (SELECT id FROM autopost_style_jobs WHERE status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
  );
  return r.rows[0] ? (r.rows[0] as Record<string, unknown>) : null;
}

/** Xử lý 1 job đã claim: OCR ảnh + gộp text + lưu vào autopost_style_samples. */
async function runStyleJob(job: Record<string, unknown>): Promise<number> {
  const images = toArr(job.images_base64) as StyleJobImage[];
  const ocrTexts: string[] = [];
  for (const img of images) {
    if (!img?.dataBase64) continue;
    const ocr = await ocrImageToText({ mediaType: img.mediaType || "image/jpeg", dataBase64: img.dataBase64 });
    if (ocr.ok && ocr.text.trim()) ocrTexts.push(ocr.text);
    else if (!ocr.ok) throw new Error(`OCR thất bại: ${ocr.reason || "không rõ"}`);
  }
  const content = combineContent(job.pasted_text as string | null, ocrTexts);
  if (!content) throw new Error("Không đọc được nội dung nào từ ảnh/text");

  const tags = toArr(job.tags);
  const urls = toArr(job.image_urls);
  const ins = await pool.query(
    `INSERT INTO autopost_style_samples
       (title, content, tags, content_type, tone, is_active, priority, images, style_topic_key, style_topic_label, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, true, $6, $7::jsonb, $8, $9, now()) RETURNING id`,
    [
      String(job.title ?? "Bài mẫu"), content, JSON.stringify(tags),
      (job.content_type as string | null) ?? null, (job.tone as string | null) ?? null,
      Number(job.priority ?? 0), JSON.stringify(urls),
      (job.style_topic_key as string | null) ?? "all",
      (job.style_topic_label as string | null) ?? "Tất cả / Dùng chung",
    ],
  );
  return Number((ins.rows[0] as { id: number }).id);
}

async function markDone(id: number, sampleId: number): Promise<void> {
  // Xoá base64 ảnh sau khi xong để không phình DB (giữ lại image_urls + result).
  await pool.query(
    `UPDATE autopost_style_jobs
        SET status='done', result_sample_id=$2, error=NULL, images_base64='[]'::jsonb, updated_at=now()
      WHERE id=$1`,
    [id, sampleId],
  );
}

async function markFailed(id: number, error: string): Promise<void> {
  await pool.query(`UPDATE autopost_style_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [id, error]);
}

/**
 * Claim + xử lý 1 job. Trả 'idle' nếu không có job pending. Dùng bởi worker.
 * KHÔNG throw ra ngoài (mọi lỗi → markFailed).
 */
export async function processNextStyleJob(): Promise<"idle" | "done" | "failed"> {
  const job = await claimNextStyleJob();
  if (!job) return "idle";
  const id = Number(job.id);
  try {
    const sampleId = await runStyleJob(job);
    await markDone(id, sampleId);
    return "done";
  } catch (err) {
    await markFailed(id, summarizeError(err));
    return "failed";
  }
}
