import { pool } from "@workspace/db";

/**
 * Cờ AI tự ghi cho TỪNG lead — bảng RIÊNG của module Claude Sale.
 *
 * AN TOÀN: KHÔNG đụng crm_leads, customers, bookings, payments. Bảng này chỉ lưu
 * "thành tích / trạng thái do AI ghi nhận" để hiển thị ở Claude Sale Monitor:
 *   - phone_captured: AI đã khai thác được SĐT trong hội thoại.
 *   - appointment_intent: khách thể hiện ý muốn hẹn lịch (AI ghi nhận, KHÔNG phải booking).
 *   - needs_human: cần nhân viên thật tiếp quản (escalation / NEEDS_HUMAN_CONFIRMATION).
 *
 * Khóa theo facebook_user_id (psid) — cùng khóa với crm_leads.facebook_user_id,
 * nhưng KHÔNG ràng buộc FK để không phụ thuộc/đụng vào bảng CRM.
 */

let createdTable = false;
export async function ensureLeadFlagsTable(): Promise<void> {
  if (createdTable) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS claude_sale_lead_flags (
      facebook_user_id     TEXT PRIMARY KEY,
      phone_captured       BOOLEAN NOT NULL DEFAULT false,
      phone_captured_at    TIMESTAMP,
      appointment_intent   BOOLEAN NOT NULL DEFAULT false,
      appointment_intent_at TIMESTAMP,
      needs_human          BOOLEAN NOT NULL DEFAULT false,
      escalation_reason    TEXT,
      escalated_at         TIMESTAMP,
      profile_sync_status  TEXT,
      profile_synced_at    TIMESTAMP,
      updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE claude_sale_lead_flags ADD COLUMN IF NOT EXISTS profile_sync_status TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE claude_sale_lead_flags ADD COLUMN IF NOT EXISTS profile_synced_at TIMESTAMP`).catch(() => {});
  createdTable = true;
}

/** Trạng thái đồng bộ profile FB: 'synced' (có tên/avatar) | 'unavailable' (FB trống) | 'failed' (lỗi). */
export type ProfileSyncStatus = "synced" | "unavailable" | "failed";

export async function setProfileSyncStatus(psid: string, status: ProfileSyncStatus): Promise<void> {
  try {
    await ensureLeadFlagsTable();
    await pool.query(
      `INSERT INTO claude_sale_lead_flags (facebook_user_id, profile_sync_status, profile_synced_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (facebook_user_id) DO UPDATE
         SET profile_sync_status = EXCLUDED.profile_sync_status,
             profile_synced_at = NOW(),
             updated_at = NOW()`,
      [psid, status],
    );
  } catch (err) {
    console.error("[ClaudeSale] setProfileSyncStatus lỗi:", String(err).slice(0, 150));
  }
}

export type LeadFlags = {
  facebookUserId: string;
  phoneCaptured: boolean;
  phoneCapturedAt: string | null;
  appointmentIntent: boolean;
  appointmentIntentAt: string | null;
  needsHuman: boolean;
  escalationReason: string | null;
  escalatedAt: string | null;
  updatedAt: string;
};

export async function markPhoneCaptured(psid: string): Promise<void> {
  try {
    await ensureLeadFlagsTable();
    await pool.query(
      `INSERT INTO claude_sale_lead_flags (facebook_user_id, phone_captured, phone_captured_at, updated_at)
       VALUES ($1, true, NOW(), NOW())
       ON CONFLICT (facebook_user_id) DO UPDATE
         SET phone_captured = true,
             phone_captured_at = COALESCE(claude_sale_lead_flags.phone_captured_at, NOW()),
             updated_at = NOW()`,
      [psid],
    );
  } catch (err) {
    console.error("[ClaudeSale] markPhoneCaptured lỗi:", String(err).slice(0, 150));
  }
}

export async function markAppointmentIntent(psid: string): Promise<void> {
  try {
    await ensureLeadFlagsTable();
    await pool.query(
      `INSERT INTO claude_sale_lead_flags (facebook_user_id, appointment_intent, appointment_intent_at, updated_at)
       VALUES ($1, true, NOW(), NOW())
       ON CONFLICT (facebook_user_id) DO UPDATE
         SET appointment_intent = true,
             appointment_intent_at = COALESCE(claude_sale_lead_flags.appointment_intent_at, NOW()),
             updated_at = NOW()`,
      [psid],
    );
  } catch (err) {
    console.error("[ClaudeSale] markAppointmentIntent lỗi:", String(err).slice(0, 150));
  }
}

export async function markNeedsHuman(psid: string, reason: string): Promise<void> {
  try {
    await ensureLeadFlagsTable();
    await pool.query(
      `INSERT INTO claude_sale_lead_flags (facebook_user_id, needs_human, escalation_reason, escalated_at, updated_at)
       VALUES ($1, true, $2, NOW(), NOW())
       ON CONFLICT (facebook_user_id) DO UPDATE
         SET needs_human = true,
             escalation_reason = EXCLUDED.escalation_reason,
             escalated_at = NOW(),
             updated_at = NOW()`,
      [psid, reason.slice(0, 300)],
    );
  } catch (err) {
    console.error("[ClaudeSale] markNeedsHuman lỗi:", String(err).slice(0, 150));
  }
}

/** Gỡ cờ cần-tiếp-quản (khi nhân viên đã xử lý xong). */
export async function clearNeedsHuman(psid: string): Promise<void> {
  await ensureLeadFlagsTable();
  await pool.query(
    `UPDATE claude_sale_lead_flags SET needs_human = false, updated_at = NOW() WHERE facebook_user_id = $1`,
    [psid],
  );
}

export type MonitorStats = {
  aiActive: number;
  takeover: number;
  paused: number;
  needsHuman: number;
  phoneCaptured: number;
  appointmentIntent: number;
  converted: number;
  total: number;
};

/**
 * Số liệu tổng cho Claude Sale Monitor.
 * - ai_mode / converted: ĐỌC từ crm_leads (chỉ đọc, không sửa).
 * - phone/appointment/needs_human: từ bảng cờ riêng của module.
 */
export async function getMonitorStats(): Promise<MonitorStats> {
  await ensureLeadFlagsTable();
  const leadsRes = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(ai_mode,'active') = 'active')  AS ai_active,
      COUNT(*) FILTER (WHERE ai_mode = 'takeover')                   AS takeover,
      COUNT(*) FILTER (WHERE ai_mode = 'paused')                     AS paused,
      COUNT(*) FILTER (WHERE customer_id IS NOT NULL)                AS converted,
      COUNT(*)                                                       AS total
    FROM crm_leads
    WHERE COALESCE(source,'facebook') = 'facebook'
  `);
  const flagsRes = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE phone_captured)     AS phone_captured,
      COUNT(*) FILTER (WHERE appointment_intent) AS appointment_intent,
      COUNT(*) FILTER (WHERE needs_human)        AS needs_human
    FROM claude_sale_lead_flags
  `);
  const l = leadsRes.rows[0] ?? {};
  const f = flagsRes.rows[0] ?? {};
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    aiActive: n(l.ai_active),
    takeover: n(l.takeover),
    paused: n(l.paused),
    needsHuman: n(f.needs_human),
    phoneCaptured: n(f.phone_captured),
    appointmentIntent: n(f.appointment_intent),
    converted: n(l.converted),
    total: n(l.total),
  };
}

export type MonitorLead = {
  facebookUserId: string;
  name: string | null;
  avatarUrl: string | null;
  aiMode: string;
  phone: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  phoneCaptured: boolean;
  appointmentIntent: boolean;
  needsHuman: boolean;
  escalationReason: string | null;
};

/**
 * Danh sách lead cho Monitor (đọc crm_leads + LEFT JOIN bảng cờ).
 * Chỉ đọc — không sửa CRM. Sắp xếp ưu tiên cần-tiếp-quản, rồi mới nhất.
 */
export async function getMonitorLeads(limit = 200): Promise<MonitorLead[]> {
  await ensureLeadFlagsTable();
  const res = await pool.query(
    `SELECT l.facebook_user_id, l.name, l.avatar_url, COALESCE(l.ai_mode,'active') AS ai_mode,
            l.phone, l.last_message, l.last_message_at,
            COALESCE(f.phone_captured, false)     AS phone_captured,
            COALESCE(f.appointment_intent, false) AS appointment_intent,
            COALESCE(f.needs_human, false)        AS needs_human,
            f.escalation_reason
       FROM crm_leads l
       LEFT JOIN claude_sale_lead_flags f ON f.facebook_user_id = l.facebook_user_id
      WHERE l.facebook_user_id IS NOT NULL
        AND COALESCE(l.source,'facebook') = 'facebook'
      ORDER BY COALESCE(f.needs_human, false) DESC, l.last_message_at DESC NULLS LAST, l.id DESC
      LIMIT $1`,
    [limit],
  );
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    facebookUserId: String(r.facebook_user_id),
    name: (r.name as string) ?? null,
    avatarUrl: (r.avatar_url as string) ?? null,
    aiMode: (r.ai_mode as string) ?? "active",
    phone: (r.phone as string) ?? null,
    lastMessage: (r.last_message as string) ?? null,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at as string).toISOString() : null,
    phoneCaptured: !!r.phone_captured,
    appointmentIntent: !!r.appointment_intent,
    needsHuman: !!r.needs_human,
    escalationReason: (r.escalation_reason as string) ?? null,
  }));
}

// ─── Heuristic phát hiện SĐT & ý định hẹn / chuyển khoản trong tin khách ───────

// SĐT VN: 09xxxxxxxx / 84xxxxxxxxx / có thể có dấu cách, chấm, gạch.
const PHONE_RE = /(?:\+?84|0)(?:[\s.\-]?\d){8,10}/;
export function detectPhone(text: string): boolean {
  const digits = (text.match(PHONE_RE)?.[0] ?? "").replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 12;
}

const APPOINTMENT_KEYWORDS = [
  "đặt lịch", "dat lich", "hẹn lịch", "hen lich", "book lịch", "giữ lịch", "giu lich",
  "đặt chụp", "dat chup", "chốt lịch", "chot lich", "đăng ký chụp", "muốn chụp ngày",
];
export function detectAppointmentIntent(text: string): boolean {
  const t = text.toLowerCase();
  return APPOINTMENT_KEYWORDS.some((k) => t.includes(k));
}

// Tình huống cần nhân viên thật xác nhận (escalation backup, không phụ thuộc Claude).
const ESCALATION_KEYWORDS: Array<{ re: RegExp; reason: string }> = [
  { re: /chuy[eể]n kho[aả]n|ck cho|s[ốo] t[àa]i kho[aả]n|stk\b/i, reason: "Khách muốn chuyển khoản" },
  { re: /đặt c[oọ]c|dat coc|ti[eề]n c[oọ]c|c[oọ]c gi[ữu] l[iị]ch/i, reason: "Khách muốn đặt cọc" },
  { re: /g[ặa]p ng[uư][oơ]i th[aậ]t|g[ặa]p nh[aâ]n vi[eê]n|n[oó]i chuy[eệ]n v[oớ]i ng[uư][oơ]i/i, reason: "Khách muốn gặp người thật" },
  // Deal giá sâu / than mắc / so sánh giá → không tự deal, để nhân viên xử lý.
  { re: /gi[ảa]m th[eê]m|gi[ảa]m gi[áa]|b[ớo]t (ch[uú]t|gi[áa]|th[eê]m)|r[ẻe] h[ơo]n|b[eê]n kia r[ẻe]|m[ắa]c qu[áa]|đ[ắa]t qu[áa]|\bdeal\b/i, reason: "Khách xin giảm giá / so sánh giá / than mắc" },
  // Hủy / dời lịch / hoàn cọc / phát sinh → cần nhân viên xác nhận.
  { re: /h[ủu]y l[ịi]ch|h[ủu]y đơn|d[ờo]i l[ịi]ch|đ[ổo]i l[ịi]ch|ho[àa]n c[ọo]c|ho[àa]n ti[eề]n|ph[áa]t sinh/i, reason: "Khách muốn hủy/dời lịch hoặc có phát sinh" },
  // Phàn nàn / không hài lòng / bức xúc / tức giận → người thật xoa dịu, AI không tự xử lý khiếu nại.
  // Lookahead (?![\p{L}]) chặn dương tính giả: "dịch vụ team", "quá team"… (cụm "te" lọt vào "team"/"test").
  { re: /ph[àa]n n[àa]n|than phi[eề]n|khi[eế]u n[ạa]i|th[ấa]t v[ọo]ng|kh[ôo]ng h[àa]i l[òo]ng|d[ịi]ch v[ụu] (t[ệe]|k[ée]m)(?![\p{L}])|(t[ệe] qu[áa]|qu[áa] t[ệe])(?![\p{L}])|l[ừu]a (đ[ảa]o|d[ảa]o)|b[ứu]c x[úu]c|t[ứu]c gi[ậa]n|n[ổo]i gi[ậa]n/iu, reason: "Khách phàn nàn / không hài lòng / bức xúc / tức giận" },
];
export function detectEscalation(text: string): string | null {
  for (const k of ESCALATION_KEYWORDS) if (k.re.test(text)) return k.reason;
  return null;
}
