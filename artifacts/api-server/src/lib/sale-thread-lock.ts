import { pool } from "@workspace/db";

/**
 * sale-thread-lock.ts — SERIALIZE + DEBOUNCE trả lời theo từng thread (Đợt 1 PR-C).
 *
 * VẤN ĐỀ: webhook gọi processIncomingFacebookMessage fire-and-forget, KHÔNG có khóa
 * theo psid → khách nhắn 3 tin liên tiếp ("chị muốn chụp cưới" / "nhưng chưa biết
 * ngày" / "gửi giá chị xem trước") = 3 lời gọi Claude SONG SONG, trả lời chéo nhau.
 *
 * GIẢI PHÁP (autoscale-safe — deploy Replit autoscale chạy NHIỀU instance, cấm
 * in-memory lock):
 *  1. DEBOUNCE "tin mới nhất thắng": handler ngủ N giây rồi so id tin mình với tin
 *     incoming MỚI NHẤT của psid (DB = nguồn sự thật chung mọi instance). Có tin mới
 *     hơn → mình NHƯỜNG (không trả lời) — tin của mình ĐÃ nằm trong history nên
 *     handler của tin mới nhất trả lời GỘP đủ ngữ cảnh. KHÔNG tin nào bị mất.
 *  2. ADVISORY LOCK per-psid (Postgres session-level, 2-key) serialize phần trả lời
 *     giữa mọi instance — tiền lệ trong repo: withStartupDdlLock (startup-ddl.ts,
 *     key 88442201). Namespace RIÊNG để không tranh khóa với DDL.
 *  3. Sau khi CÓ khóa: re-check tin mới nhất lần nữa (tin có thể đến trong lúc chờ).
 *
 * Cờ LULU_THREAD_LOCK_ENABLED (mặc định TẮT). Fail-open: lỗi DB khi debounce-check →
 * coi như không có tin mới hơn (vẫn trả lời như hành vi cũ); lỗi lấy khóa → bỏ lượt
 * có ghi vết (an toàn hơn trả lời chéo).
 */

// Namespace khóa 2-key: (LOCK_NS, hashtext(psid)). PHẢI khác 88442201 (startup DDL).
const LOCK_NS = 88442202;

/** Thời gian chờ lấy khóa tối đa (handler khác đang trả lời có thể mất 30-60s). */
const LOCK_WAIT_TIMEOUT_MS = 90_000;

export function isThreadLockEnabled(): boolean {
  return /^(1|true|yes)$/i.test((process.env.LULU_THREAD_LOCK_ENABLED ?? "").trim());
}

/** Debounce gộp tin (ms). Env LULU_DEBOUNCE_MS, mặc định 6000, clamp 0..20000. */
export function threadDebounceMs(): number {
  const n = Number((process.env.LULU_DEBOUNCE_MS ?? "").trim() || 6000);
  if (!Number.isFinite(n)) return 6000;
  return Math.min(20_000, Math.max(0, Math.round(n)));
}

/** Thuần (test được): tin của mình có bị tin MỚI HƠN vượt mặt không. */
export function isSuperseded(myId: number | null, latestId: number | null): boolean {
  if (myId == null || latestId == null) return false; // không đủ dữ kiện → không nhường (fail-open)
  return latestId > myId;
}

/** id tin incoming MỚI NHẤT của psid (null nếu lỗi/không có — fail-open). */
export async function latestIncomingId(psid: string): Promise<number | null> {
  try {
    const r = await pool.query(
      `SELECT id FROM fb_inbox_messages WHERE facebook_user_id = $1 AND direction = 'incoming' ORDER BY id DESC LIMIT 1`,
      [psid],
    );
    const id = r.rows[0]?.id;
    return typeof id === "number" ? id : id != null ? Number(id) : null;
  } catch (err) {
    console.error("[ThreadLock] latestIncomingId lỗi (fail-open):", String(err).slice(0, 120));
    return null;
  }
}

/** Ghi ai_decision cho ĐÚNG dòng tin (theo id) — dùng cho superseded/lock_timeout. */
export async function markDecisionById(msgId: number | null, decision: string): Promise<void> {
  if (msgId == null) return;
  try {
    await pool.query(`UPDATE fb_inbox_messages SET ai_decision = $1 WHERE id = $2`, [decision, msgId]);
  } catch (err) {
    console.error("[ThreadLock] markDecisionById lỗi:", String(err).slice(0, 120));
  }
}

export type ThreadLockResult<T> = { ran: true; result: T } | { ran: false; reason: string };

/**
 * Chạy fn dưới advisory lock per-psid. Giữ 1 connection RIÊNG suốt thời gian chạy
 * (yêu cầu pool.max >= 2 — cùng ràng buộc với withStartupDdlLock). Chờ khóa tối đa
 * LOCK_WAIT_TIMEOUT_MS (qua statement_timeout) — quá hạn → {ran:false} (handler khác
 * đang trả lời thread này; bỏ lượt an toàn hơn trả lời chéo).
 */
export async function withThreadLock<T>(psid: string, fn: () => Promise<T>): Promise<ThreadLockResult<T>> {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    return { ran: false, reason: `pool_connect: ${String(err).slice(0, 120)}` };
  }
  let locked = false;
  try {
    await client.query(`SET statement_timeout = ${LOCK_WAIT_TIMEOUT_MS}`);
    await client.query(`SELECT pg_advisory_lock($1, hashtext($2))`, [LOCK_NS, psid]);
    locked = true;
    await client.query(`SET statement_timeout = 0`);
    const result = await fn();
    return { ran: true, result };
  } catch (err) {
    if (!locked) return { ran: false, reason: `lock_wait: ${String(err).slice(0, 120)}` };
    throw err; // lỗi TRONG fn → nổi lên caller (finally vẫn nhả khóa)
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [LOCK_NS, psid]);
        client.release();
      } catch {
        // Không unlock được → HỦY connection để Postgres tự nhả khóa theo session
        // (cùng chiến thuật startup-ddl.ts) — tuyệt đối không trả connection còn giữ khóa về pool.
        client.release(true);
      }
    } else {
      client.release();
    }
  }
}
