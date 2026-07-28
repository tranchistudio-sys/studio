import { createHash } from "crypto";

/**
 * webhook-events.ts — xử lý POSTBACK / OPTIN từ Meta webhook (thuần, test được).
 *
 * VẤN ĐỀ (backlog điều tra 09/07, mục 4): khách bấm nút Click-to-Messenger /
 * ice-breaker / Get Started gửi event `postback` (KHÔNG có message.text, KHÔNG có
 * message.mid) → webhook hiện skip ở nhánh `if (!senderId || !text)` → khách RƠI
 * hoàn toàn: không lưu, không rep, không lead.
 *
 * Meta giao webhook AT-LEAST-ONCE (retry khi không nhận 200 kịp) → postback không có
 * mid phải tự sinh PSEUDO-MID ổn định từ (psid, timestamp, payload) để tái dùng
 * unique index idx_fb_inbox_mid chống trùng — retry cùng event = cùng pseudo-mid
 * = INSERT ... ON CONFLICT DO NOTHING.
 */

export function isPostbackEnabled(): boolean {
  return /^(1|true|yes)$/i.test((process.env.WEBHOOK_POSTBACK_ENABLED ?? "").trim());
}

type PostbackPayload = { title?: unknown; payload?: unknown; referral?: unknown };
type OptinPayload = { ref?: unknown; payload?: unknown };

/** Text hiển thị/đưa vào bot cho postback: ưu tiên title (điều khách THẤY trên nút). */
export function extractPostbackText(pb: PostbackPayload | undefined): string {
  const title = typeof pb?.title === "string" ? pb.title.trim() : "";
  const payload = typeof pb?.payload === "string" ? pb.payload.trim() : "";
  return (title || payload || "[khách bấm nút menu]").slice(0, 500);
}

/** Text cho optin (khách opt-in qua checkbox plugin / ref link). */
export function extractOptinText(op: OptinPayload | undefined): string {
  const ref = typeof op?.ref === "string" ? op.ref.trim() : "";
  return (ref ? `[khách opt-in: ${ref}]` : "[khách opt-in nhận tin]").slice(0, 500);
}

/**
 * Pseudo-mid ỔN ĐỊNH cho event không có mid: cùng (psid, timestamp, payload) → cùng
 * mid → Meta retry bị unique index chặn trùng. Prefix "pb:" để phân biệt mid thật.
 */
export function buildPostbackPseudoMid(psid: string, timestamp: unknown, payload: unknown): string {
  const ts = typeof timestamp === "number" || typeof timestamp === "string" ? String(timestamp) : "0";
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 12);
  return `pb:${psid}:${ts}:${hash}`;
}
