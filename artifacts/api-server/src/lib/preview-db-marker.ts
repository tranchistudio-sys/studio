/**
 * preview-db-marker.ts — LỚP PHÒNG THỦ THỨ BA cho database preview.
 *
 * Allowlist trong `preview-guard.ts` chặn theo host/tên DB đọc từ env. Nếu ai đó
 * lỡ tay đưa nhầm chuỗi kết nối production VÀO CẢ allowlist lẫn DATABASE_URL thì
 * allowlist tự nó không phát hiện được. Chốt này kiểm tra chính DATABASE:
 * chỉ database do `scripts/seed-preview-db.mjs` dựng mới có bảng đánh dấu này.
 * Production không bao giờ có nó → preview không thể khởi động trên DB production.
 *
 * Chạy TRƯỚC mọi migration/DDL. No-op tuyệt đối khi không ở chế độ preview.
 */
import { pool } from "@workspace/db";
import { isPreviewMode } from "./preview-guard";
import { PreviewGuardError } from "./preview-guard";

export const PREVIEW_MARKER_TABLE = "preview_db_marker";

export async function assertPreviewDatabaseMarker(): Promise<void> {
  if (!isPreviewMode()) return;

  const { rows } = await pool.query<{ is_preview: boolean | null; seeded_at: Date | null }>(
    `SELECT is_preview, seeded_at
       FROM ${PREVIEW_MARKER_TABLE}
      ORDER BY seeded_at DESC NULLS LAST
      LIMIT 1`,
  ).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42P01") {
      throw new PreviewGuardError(
        `Database này KHÔNG có bảng đánh dấu '${PREVIEW_MARKER_TABLE}' → không phải database preview. ` +
          "Từ chối khởi động. Hãy chạy 'node scripts/seed-preview-db.mjs' để dựng database preview đúng cách.",
      );
    }
    throw err;
  });

  if (!rows[0]?.is_preview) {
    throw new PreviewGuardError(
      `Bảng '${PREVIEW_MARKER_TABLE}' tồn tại nhưng không xác nhận đây là database preview (is_preview != true). ` +
        "Từ chối khởi động.",
    );
  }
}
