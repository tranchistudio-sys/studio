import { maybeTenantDatabaseContext, pool } from "@workspace/db";
import { isPlatformDatabaseConfigured } from "@workspace/platform-db";

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
const STARTUP_DDL_LOCK_HEARTBEAT_MS = 10_000;

let loggedSkip = false;
const deferredTenantDdl = new Set<() => Promise<unknown>>();
let localDdlTail: Promise<void> = Promise.resolve();

export function skipStartupDdl(): boolean {
  if (process.env.SKIP_STARTUP_MIGRATIONS === "1") {
    if (!loggedSkip) {
      loggedSkip = true;
      console.warn(
        "[startup-ddl] SKIP_STARTUP_MIGRATIONS=1 — BỎ QUA toàn bộ migration/DDL lúc khởi động. " +
          "Schema mới (nếu có) sẽ KHÔNG tự áp — chạy migration thủ công trong workspace khi cần.",
      );
    }
    return true;
  }
  // FAIL-CLOSED (sự cố DROP-TABLE 24/07/2026): production KHÔNG BAO GIỜ tự chạy
  // DDL lúc khởi động, kể cả khi quên đặt SKIP_STARTUP_MIGRATIONS trong
  // Deployment env. Muốn cố tình chạy (rất hiếm — chỉ khi chủ chủ động migrate
  // qua app) phải đặt tường minh ALLOW_STARTUP_DDL_IN_PRODUCTION=1.
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_STARTUP_DDL_IN_PRODUCTION !== "1") {
    if (!loggedSkip) {
      loggedSkip = true;
      console.warn(
        "[startup-ddl] NODE_ENV=production — mặc định BỎ QUA mọi migration/DDL lúc khởi động (fail-closed). " +
          "Đặt ALLOW_STARTUP_DDL_IN_PRODUCTION=1 nếu thực sự muốn chạy DDL trên production.",
      );
    }
    return true;
  }
  return false;
}

// Chạy fn dưới pg_advisory_lock: các instance (và các luồng ensure* trong cùng
// instance) chạy DDL TUẦN TỰ thay vì song song. Mọi lệnh bên trong đều dạng
// IF NOT EXISTS nên lượt chạy sau chỉ lướt qua.
// Lưu ý: client giữ khoá chiếm 1 slot pool trong khi fn dùng thêm connection khác
// → yêu cầu pool.max >= 2 (lib/db hiện để mặc định max=10).
export async function withStartupDdlLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (skipStartupDdl()) return undefined;
  if (isPlatformDatabaseConfigured() && !maybeTenantDatabaseContext()) {
    // Route modules are evaluated before index.ts can resolve the registered
    // Amazing tenant. Queue their idempotent ensure functions instead of ever
    // touching an implicit DATABASE_URL.
    deferredTenantDdl.add(fn as () => Promise<unknown>);
    return undefined;
  }
  const previous = localDdlTail;
  let releaseLocalQueue!: () => void;
  localDdlTail = new Promise<void>((resolve) => { releaseLocalQueue = resolve; });
  await previous;
  let lock: Awaited<ReturnType<typeof pool.connect>> | undefined;
  let unlockFailed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let rejectLockLost: ((error: Error) => void) | undefined;
  let handleLockError: ((error: Error) => void) | undefined;
  try {
    lock = await pool.connect();
    const lockLost = new Promise<never>((_resolve, reject) => { rejectLockLost = reject; });
    handleLockError = (error: Error) => rejectLockLost?.(error);
    lock.on("error", handleLockError);
    await lock.query("SELECT pg_advisory_lock($1)", [STARTUP_DDL_LOCK_KEY]);
    // Fly's local proxy can reap a checked-out connection that is idle while
    // the protected DDL uses other pool clients. Keep the lock session active;
    // if it is ever lost, fail the protected work instead of continuing without
    // the cross-process advisory lock.
    heartbeat = setInterval(() => {
      void lock?.query("SELECT 1").catch((error: Error) => rejectLockLost?.(error));
    }, STARTUP_DDL_LOCK_HEARTBEAT_MS);
    return await Promise.race([fn(), lockLost]);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (lock) {
      try {
        await lock.query("SELECT pg_advisory_unlock($1)", [STARTUP_DDL_LOCK_KEY]);
      } catch {
        // Unlock lỗi mà connection còn sống thì khoá vẫn bị giữ nếu trả về pool —
        // huỷ hẳn connection để Postgres nhả khoá theo session.
        unlockFailed = true;
      }
      if (handleLockError) lock.removeListener("error", handleLockError);
      lock.release(unlockFailed);
    }
    releaseLocalQueue();
  }
}

export async function runDeferredTenantStartupDdl(): Promise<void> {
  if (isPlatformDatabaseConfigured() && !maybeTenantDatabaseContext()) {
    throw new Error("Deferred tenant DDL requires an explicit tenant context");
  }
  const queued = [...deferredTenantDdl];
  deferredTenantDdl.clear();
  for (const work of queued) await withStartupDdlLock(work);
}
