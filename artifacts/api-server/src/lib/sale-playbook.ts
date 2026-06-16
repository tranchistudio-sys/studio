import { pool } from "@workspace/db";

/**
 * Sale Playbook — phong cách tư vấn (học từ chat thật, CÓ KIỂM DUYỆT).
 *
 * Playbook CHỈ dùng để học GIỌNG ĐIỆU / CÁCH DẪN KHÁCH / XỬ LÝ TÌNH HUỐNG.
 * KHÔNG dùng cho giá — bảng giá luôn lấy từ sale-context.ts đã lọc an toàn.
 * Chỉ bản status='active' mới được Claude Sale đọc. Admin phải tự duyệt + áp dụng.
 */

export type PlaybookStatus = "draft" | "approved" | "rejected" | "active";

let createdTable = false;
export async function ensureSalePlaybookTable(): Promise<void> {
  if (createdTable) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sale_playbooks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Sale Playbook',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','active')),
      content TEXT NOT NULL DEFAULT '',
      content_original TEXT,
      conversations_used INTEGER NOT NULL DEFAULT 0,
      source_summary TEXT,
      created_by INTEGER,
      created_by_name TEXT,
      approved_by INTEGER,
      approved_by_name TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMP,
      activated_at TIMESTAMP
    )
  `);
  createdTable = true;
}

// Cache bản active để Claude đọc nhanh; xóa cache khi admin đổi trạng thái.
let cache: { content: string | null; at: number } | null = null;
const TTL_MS = 60 * 1000;

export function clearPlaybookCache(): void {
  cache = null;
}

/** Nội dung playbook ĐANG ACTIVE (null nếu chưa có bản nào active). */
export async function getActivePlaybook(): Promise<string | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.content;
  try {
    await ensureSalePlaybookTable();
    const r = await pool.query(
      `SELECT content FROM sale_playbooks WHERE status = 'active' ORDER BY activated_at DESC NULLS LAST, id DESC LIMIT 1`,
    );
    const content = r.rows[0]?.content?.trim() || null;
    cache = { content, at: Date.now() };
    return content;
  } catch (err) {
    console.error("[SaleLearning] getActivePlaybook lỗi:", String(err).slice(0, 150));
    return null;
  }
}
