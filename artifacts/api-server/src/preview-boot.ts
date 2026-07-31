/**
 * preview-boot.ts — module CHỈ CÓ TÁC DỤNG PHỤ, phải được import ĐẦU TIÊN trong
 * `index.ts`. ES module chạy theo đúng thứ tự import, nên đặt ở dòng đầu bảo đảm
 * chốt an toàn preview chạy TRƯỚC khi `./app` (và mọi route đọc env lúc import)
 * được nạp.
 *
 * Không ở chế độ preview → cả hai hàm dưới đây đều no-op, không tốn gì.
 */
import { enforcePreviewSafety, isPreviewMode, PreviewGuardError } from "./lib/preview-guard";
import { installPreviewNetGuard } from "./lib/preview-net-guard";

try {
  enforcePreviewSafety();
  installPreviewNetGuard();
} catch (err) {
  if (err instanceof PreviewGuardError) {
    console.error("\n\x1b[41m\x1b[97m  PREVIEW GUARD CHẶN KHỞI ĐỘNG  \x1b[0m");
    console.error("\x1b[31m" + err.message + "\x1b[0m\n");
    process.exit(1);
  }
  throw err;
}

export const previewModeActive = isPreviewMode();
