import { pool } from "@workspace/db";

// ── Guard + khoá chung cho MỌI DDL lúc khởi động ─────────────────────────────
// Gồm: runMigrations (migrations.ts) và các ensure*Schema chạy lúc import trong
// routes/ (auth, customers, attendance, fb-inbox, cms, wedding-cards, autopost).
//
// Vì sao cần:
// 1. Replit Autoscale promote khởi động NHIỀU instance song song; mỗi instance
//    tự bắn DDL (ALTER TABLE giữ AccessExclusiveLock) → "deadlock detected"
//    → process exit(1) → healthcheck /api 500 → Promote fail.
// 2. Deploy production cần tắt hẳn DDL lúc start: đặt SKIP_STARTUP_MIGRATIONS=1
//    trong Deployment env. CHỈ dùng biến riêng này — KHÔNG tái dùng
//    SAFE_PRODUCTION/SKIP_DB_PUSH (2 biến đó là guard của scripts/post-merge.sh,
//    nằm trong Secrets dùng chung workspace + deploy; nếu runtime cũng đọc thì
//    dev bị tắt migration im lặng → schema drift rất khó lần).

// Số bất kỳ, chỉ cần duy nhất trong app cho nhóm khoá này.
const STARTUP_DDL_LOCK_KEY = 88442201;

let loggedSkip = false;

export function skipStartupDdl(): boolean {
  const skip = process.env.SKIP_STARTUP_MIGRATIONS === "1";
  if (skip && !loggedSkip) {
    loggedSkip = true;
    console.warn(
      "[startup-ddl] SKIP_STARTUP_MIGRATIONS=1 — BỎ QUA toàn bộ migration/DDL lúc khởi động. " +
        "Schema mới (nếu có) sẽ KHÔNG tự áp — chạy migration thủ công trong workspace khi cần.",
    );
  }
  return skip;
}

// Chạy fn dưới pg_advisory_lock: các instance (và các luồng ensure* trong cùng
// instance) chạy DDL TUẦN TỰ thay vì song song. Mọi lệnh bên trong đều dạng
// IF NOT EXISTS nên lượt chạy sau chỉ lướt qua.
// Lưu ý: client giữ khoá chiếm 1 slot pool trong khi fn dùng thêm connection khác
// → yêu cầu pool.max >= 2 (lib/db hiện để mặc định max=10).
export async function withStartupDdlLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (skipStartupDdl()) return undefined;
  const lock = await pool.connect();
  let unlockFailed = false;
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [STARTUP_DDL_LOCK_KEY]);
    return await fn();
  } finally {
    try {
      await lock.query("SELECT pg_advisory_unlock($1)", [STARTUP_DDL_LOCK_KEY]);
    } catch {
      // Unlock lỗi mà connection còn sống thì khoá vẫn bị giữ nếu trả về pool —
      // huỷ hẳn connection để Postgres nhả khoá theo session.
      unlockFailed = true;
    }
    lock.release(unlockFailed);
  }
}
