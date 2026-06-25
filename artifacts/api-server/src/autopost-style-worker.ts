/**
 * autopost-style-worker.ts — Worker nền xử lý HÀNG CHỜ học Văn phong mẫu.
 *
 * Theo khuôn các scheduler khác (setTimeout→setInterval). LUÔN bật: chỉ xử lý job
 * do admin chủ động tạo (OCR ảnh → lưu bài mẫu); khi không có job thì poll rất rẻ
 * (1 SELECT). KHÔNG tự đăng bài, KHÔNG đụng luồng AutoPost — chỉ ghi autopost_style_*.
 *
 * ENV (đọc lúc runtime, KHÔNG sửa .env):
 *  - AUTOPOST_STYLE_WORKER_INTERVAL_SEC: chu kỳ poll (giây). Mặc định 5, tối thiểu 2.
 */
import { processNextStyleJob, ensureStyleJobsTable } from "./lib/autopost-style-jobs";

const TAG = "[AutoPostStyleWorker]";
let running = false;

async function tick(): Promise<void> {
  if (running) return; // chống chồng tick khi 1 job đang xử lý lâu
  running = true;
  try {
    // Xử lý tối đa vài job/tick để không giữ event loop quá lâu (mỗi OCR có thể 30–90s).
    for (let i = 0; i < 3; i++) {
      const r = await processNextStyleJob();
      if (r === "idle") break;
    }
  } catch (e) {
    console.error(`${TAG} tick lỗi:`, e);
  } finally {
    running = false;
  }
}

/** Khởi động worker (gọi 1 lần ở app.ts). */
export function startStyleSampleWorker(): void {
  const raw = parseInt(process.env.AUTOPOST_STYLE_WORKER_INTERVAL_SEC ?? "", 10);
  const sec = Number.isNaN(raw) || raw < 2 ? 5 : raw;
  setTimeout(() => {
    ensureStyleJobsTable().catch((e) => console.error(`${TAG} ensure table lỗi:`, e));
    tick();
    setInterval(() => { tick().catch(() => {}); }, sec * 1000);
  }, 10_000);
  console.log(`${TAG} khởi động — poll mỗi ${sec}s`);
}
