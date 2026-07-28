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

// AUDIT: ai bật/tắt, lúc nào — sự cố 28/06 (bot bị tắt, 5 khách treo 7 ngày) không truy
// được thủ phạm vì switch không ghi vết. Lưu ở settings key riêng (KV — không cần DDL).
const META_KEY = "claude_sale_master_meta";

export type MasterMeta = { enabled: boolean; byStaffId: number | null; byName: string | null; at: string };

export async function getMasterMeta(): Promise<MasterMeta | null> {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = $1 LIMIT 1`, [META_KEY]);
    if (r.rows.length === 0) return null;
    const v = JSON.parse(String(r.rows[0].value ?? "null")) as MasterMeta | null;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export async function setMasterEnabled(
  enabled: boolean,
  by?: { staffId: number | null; name: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [KEY, enabled ? "1" : "0"],
  );
  const meta: MasterMeta = {
    enabled,
    byStaffId: by?.staffId ?? null,
    byName: by?.name ?? null,
    at: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_KEY, JSON.stringify(meta)],
  ).catch((err) => console.error("[ClaudeSale] ghi master meta lỗi (switch vẫn đã đổi):", String(err).slice(0, 120)));
  console.log(`[ClaudeSale] master ${enabled ? "BẬT" : "TẮT"} bởi staff#${meta.byStaffId ?? "?"} ${meta.byName ?? ""} lúc ${meta.at}`);
}
