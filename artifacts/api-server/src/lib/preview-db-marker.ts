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

/**
 * Dọn "phiên ma" trên database preview — bài học 31/07: deploy/restart kill tiến
 * trình GIỮA transaction migration → session phía server (nhất là qua cổng pooler
 * của Neon) sống thêm ~10 phút, ôm khoá ALTER TABLE → boot sau treo đúng chỗ đó
 * → deploy timeout dây chuyền.
 *
 * PHẢI được gọi từ `preview-boot.ts` — TRƯỚC khi `./app` được import, vì các route
 * tự mở kết nối (ensure*Schema) ngay lúc import; gọi muộn sẽ ngắt nhầm kết nối
 * đang làm việc của chính tiến trình này. Preview chỉ có MỘT máy (ha=false) nên
 * tại thời điểm đó mọi session khác của database đều là xác chết của boot trước.
 *
 * Fail-open: dọn không được (lỗi mạng thoáng qua) thì chỉ cảnh báo — migration
 * phía sau tự chịu, không chặn boot vì một bước dọn dẹp.
 */
export async function terminateGhostSessions(): Promise<void> {
  if (!isPreviewMode()) return;
  try {
    const res = await pool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    if (res.rowCount) {
      console.warn(`[preview-boot] Đã ngắt ${res.rowCount} phiên ma của boot trước (chống kẹt khoá migration).`);
    }
  } catch (err) {
    console.warn(`[preview-boot] Không dọn được phiên ma (bỏ qua): ${(err as Error).message}`);
  }
}
