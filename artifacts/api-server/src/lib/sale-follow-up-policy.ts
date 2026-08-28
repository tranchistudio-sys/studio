export type FollowUpStopReason =
  | "DO_NOT_CONTACT"
  | "NO_LONGER_INTERESTED"
  | "CHOSE_ANOTHER_STUDIO"
  | null;

export type FollowUpMessageControl = {
  stop: boolean;
  stopReason: FollowUpStopReason;
  requestedContactText: string | null;
  deferWithoutSchedule: boolean;
};

function normalize(value: string): string {
  return value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const DO_NOT_CONTACT_RE = /\b(dung nhan|dung nhan nua|dung nhan tin|khong lien he|dung lien he|stop|unsubscribe|opt out|xoa toi|xoa so)\b/;
const OTHER_STUDIO_RE = /\b(dat ben khac|chon studio khac|chon ben khac|lam ben khac|book ben khac)\b/;
const NO_INTEREST_RE = /\b(khong lam nua|khong can nua|khong co nhu cau|khong quan tam|thoi khong|huy nhu cau)\b/;
const REQUESTED_LATER_RE = /\b((?:thu hai|thu ba|thu tu|thu nam|thu sau|thu bay|chu nhat|tuan sau|cuoi thang|thang sau|\d+\s*ngay nua).{0,20}(?:nhan|lien he)|(?:nhan|lien he).{0,20}(?:thu hai|thu ba|thu tu|thu nam|thu sau|thu bay|chu nhat|tuan sau|cuoi thang|thang sau|\d+\s*ngay nua))\b/;
const NOT_NOW_RE = /\b(gio chua tinh|chua can gap|de gan cuoi|de sau tinh|chua tinh dau|chua can luc nay)\b/;

export function followUpControlFromMessage(message: string): FollowUpMessageControl {
  const text = normalize(message);
  if (DO_NOT_CONTACT_RE.test(text)) return { stop: true, stopReason: "DO_NOT_CONTACT", requestedContactText: null, deferWithoutSchedule: false };
  if (OTHER_STUDIO_RE.test(text)) return { stop: true, stopReason: "CHOSE_ANOTHER_STUDIO", requestedContactText: null, deferWithoutSchedule: false };
  if (NO_INTEREST_RE.test(text)) return { stop: true, stopReason: "NO_LONGER_INTERESTED", requestedContactText: null, deferWithoutSchedule: false };
  const requested = text.match(REQUESTED_LATER_RE)?.[0] ?? null;
  return {
    stop: false,
    stopReason: null,
    requestedContactText: requested,
    deferWithoutSchedule: NOT_NOW_RE.test(text) && !requested,
  };
}

export function followUpEligibility(input: {
  optedOut: boolean;
  aiMode: string | null;
  customerId: number | null;
  followUpCount: number;
  customerRepliedAfterSnapshot?: boolean;
}): { allowed: boolean; reason: string } {
  if (input.optedOut) return { allowed: false, reason: "opted_out" };
  if ((input.aiMode ?? "active") !== "active") return { allowed: false, reason: `ai_mode_${input.aiMode ?? "unknown"}` };
  // Existing architecture links a confirmed/converted customer through customer_id.
  // Sale follow-up stops here; booking/payment workflows remain separate.
  if (input.customerId != null) return { allowed: false, reason: "customer_converted" };
  if (input.customerRepliedAfterSnapshot) return { allowed: false, reason: "customer_replied_after_snapshot" };
  if (input.followUpCount >= 3) return { allowed: false, reason: "follow_up_limit_reached" };
  return { allowed: true, reason: "eligible" };
}
