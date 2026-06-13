import { pool } from "@workspace/db";

/**
 * CẦU DAO TỔNG Claude Sale — một công tắc DUY NHẤT cho toàn hệ thống chatbot
 * (Claude Sale Test, Facebook Messenger, follow-up). Lưu ở bảng `settings` dưới
 * key 'claude_sale_master_enabled' ('1'/'0').
 *
 * THIẾT KẾ AN TOÀN:
 *  - ĐỌC KHÔNG CACHE → tắt là dừng NGAY (emergency stop), không phải chờ TTL.
 *  - Chưa có row → lấy theo biến môi trường CLAUDE_FB_BOT_ENABLED (giữ nguyên
 *    hành vi production hiện tại ở lần đầu, trước khi admin bấm nút).
 *  - Lỗi đọc DB → FAIL-CLOSED (coi như TẮT) để không spam khách khi DB trục trặc.
 */

const KEY = "claude_sale_master_enabled";

function envDefault(): boolean {
  const v = (process.env.CLAUDE_FB_BOT_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export async function getMasterEnabled(): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = $1 LIMIT 1`, [KEY]);
    if (r.rows.length === 0) return envDefault();
    const v = String(r.rows[0].value ?? "").trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  } catch (err) {
    console.error("[ClaudeSale] getMasterEnabled lỗi → FAIL-CLOSED (tắt):", String(err).slice(0, 150));
    return false;
  }
}

export async function setMasterEnabled(enabled: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [KEY, enabled ? "1" : "0"],
  );
}
