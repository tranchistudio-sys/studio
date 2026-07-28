/**
 * sale-slots.ts — RÚT THÔNG TIN CÓ CẤU TRÚC (slot) từ tin nhắn cho trí nhớ Lulu.
 *
 * THUẦN regex/keyword — không AI, không I/O (cùng triết lý sale-conversation-discipline.ts)
 * nên test được không cần API key. Phiên bản đầu phủ SLOT NGÀY CHỤP:
 *   - Khách CHO ngày cụ thể ("20/12", "ngày 5 tháng 9", "cuối tháng 12") → status "known".
 *   - Khách nói CHƯA CHỐT ("chưa biết ngày", "chỉ tham khảo", "không cần ngày, xin giá
 *     trước") → status "not_decided" — để hệ thống KHÔNG hỏi lại ngày nữa.
 *   - botAsksDate(): nhận diện câu BOT vừa hỏi ngày (chạy trên tin gửi đi) để ghi
 *     asked_questions["ask_date"] — nền cho rule "không hỏi một câu hai lần".
 *
 * BẢO THỦ CÓ CHỦ ĐÍCH: cụm mơ hồ ("chưa chốt", "tham khảo", "để mình xem lại") CHỈ được
 * hiểu là chưa-chốt-ngày khi bot ĐÃ HỎI ngày trước đó (opts.botAskedDate) — tránh dương
 * tính giả khi khách nói "chưa chốt gói" hay "tham khảo bảng giá".
 */

export type DateStatus = "unknown" | "not_decided" | "known";

export type DateSlotResult = {
  status: Exclude<DateStatus, "unknown">;
  /** YYYY-MM-DD khi parse được ngày đầy đủ; null nếu chỉ có mốc mơ hồ (vd "cuối tháng 12"). */
  eventDate: string | null;
  /** Nguyên văn mốc thời gian khách nói (để Lulu nhắc lại đúng lời khách). */
  dateText: string | null;
} | null;

/** Bỏ dấu tiếng Việt + lowercase (bản sao cục bộ — cùng cách làm với sale-samples.ts). */
function normalizeVi(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}

// ── Cụm "chưa chốt ngày" ──────────────────────────────────────────────────────
// MẠNH: tự nhắc tới ngày/lịch → hiểu được ngay cả khi bot chưa hỏi ngày.
const NOT_DECIDED_STRONG = [
  "chua biet ngay", "chua chot ngay", "chua co ngay", "chua ro ngay",
  "chua dinh ngay", "chua len ngay", "chua tinh ngay", "chua quyet ngay",
  "khong can ngay", "chua co lich", "chua chot lich", "chua biet khi nao",
  "chua biet chung nao", "khi nao cung duoc", "ngay nao cung duoc",
];
// YẾU: chỉ tính khi bot ĐÃ hỏi ngày (khách đang trả lời câu hỏi ngày).
const NOT_DECIDED_WEAK = [
  "chua biet", "chua chot", "chua quyet", "chua tinh", "tinh sau",
  "tham khao", "xem lai", "de minh xem", "de em xem", "de tui xem",
  "chua co ke hoach", "hoi gia truoc", "xin gia truoc", "xem gia truoc",
  "coi gia truoc", "chua nghi toi", "chua nghi den",
];

function hasPhrase(normalized: string, phrases: string[]): boolean {
  return phrases.some((p) => normalized.includes(p));
}

const MONTH_WORD_RE = /thang\s*(\d{1,2})/;
// dd/mm — dấu "/" luôn được tính; dấu "-" hoặc "." CHỈ tính khi câu có nhắc ngày/lịch
// (chống nhầm khoảng số "2-3 triệu", "2-3 người"). Từ chối khi dính đơn vị tiền ngay sau.
const DMY_RE = /(?:^|[^\d/.-])(\d{1,2})\s*([/.-])\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?/;
const MONEY_AFTER_RE = /^\s*(trieu|tr\b|k\b|%|nghin|ngan)/;
const DATE_CONTEXT_RE = /\b(ngay|lich|hom|bua)\b/;
// "ngày 5 tháng 9" / "5 tháng 9"
const DAY_MONTH_WORD_RE = /(?:ngay\s*)?(\d{1,2})\s*thang\s*(\d{1,2})/;
// "đầu/giữa/cuối tháng 9"
const PART_MONTH_RE = /(dau|giua|cuoi)\s*thang\s*(\d{1,2})/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Suy năm cho dd/mm không kèm năm: mốc đã qua trong năm nay → hiểu là năm sau. */
function inferYear(day: number, month: number, now: Date): number {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (month < m || (month === m && day < now.getDate())) return y + 1;
  return y;
}

/**
 * Rút slot NGÀY từ tin khách. Trả null nếu tin không nói gì về ngày (giữ nguyên state cũ).
 * Ngày cụ thể LUÔN thắng cụm "chưa chốt" trong cùng tin ("chưa chốt hẳn, chắc 20/12" → known).
 */
export function detectDateSlot(
  message: string,
  opts: { botAskedDate: boolean; now?: Date },
): DateSlotResult {
  const raw = (message ?? "").trim();
  if (!raw || raw.startsWith("[image:")) return null;
  const t = normalizeVi(raw);
  const now = opts.now ?? new Date();

  // 1) Ngày đầy đủ dd/mm(/yyyy)
  const dmy = DMY_RE.exec(t);
  if (dmy) {
    const after = t.slice((dmy.index ?? 0) + dmy[0].length);
    const sep = dmy[2];
    const sepOk = sep === "/" || DATE_CONTEXT_RE.test(t);
    if (sepOk && !MONEY_AFTER_RE.test(after)) {
      const d = Number(dmy[1]);
      const m = Number(dmy[3]);
      const yRaw = dmy[4] ? Number(dmy[4]) : null;
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
        const y = yRaw == null ? inferYear(d, m, now) : yRaw < 100 ? 2000 + yRaw : yRaw;
        if (y >= now.getFullYear() && y <= now.getFullYear() + 3) {
          return { status: "known", eventDate: `${y}-${pad2(m)}-${pad2(d)}`, dateText: dmy[0].trim() };
        }
      }
    }
  }

  // 2) "ngày 5 tháng 9"
  const dmw = DAY_MONTH_WORD_RE.exec(t);
  if (dmw) {
    const d = Number(dmw[1]);
    const m = Number(dmw[2]);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      const y = inferYear(d, m, now);
      return { status: "known", eventDate: `${y}-${pad2(m)}-${pad2(d)}`, dateText: dmw[0].trim() };
    }
  }

  // 3) "cuối tháng 12" → mốc mơ hồ nhưng ĐÃ có định hướng thời gian.
  const pm = PART_MONTH_RE.exec(t);
  if (pm) {
    const m = Number(pm[2]);
    if (m >= 1 && m <= 12) {
      const label = pm[1] === "dau" ? "đầu" : pm[1] === "giua" ? "giữa" : "cuối";
      return { status: "known", eventDate: null, dateText: `${label} tháng ${m}` };
    }
  }

  // 4) "tháng 12" trần (số đứng SAU chữ "tháng" — "3 tháng nữa" không khớp).
  const mw = MONTH_WORD_RE.exec(t);
  if (mw && !PART_MONTH_RE.test(t)) {
    const m = Number(mw[1]);
    if (m >= 1 && m <= 12) {
      return { status: "known", eventDate: null, dateText: `tháng ${m}` };
    }
  }

  // 5) Chưa chốt ngày.
  if (hasPhrase(t, NOT_DECIDED_STRONG)) {
    return { status: "not_decided", eventDate: null, dateText: null };
  }
  if (opts.botAskedDate && hasPhrase(t, NOT_DECIDED_WEAK)) {
    return { status: "not_decided", eventDate: null, dateText: null };
  }

  return null;
}

// ── Nhận diện BOT vừa hỏi ngày (chạy trên text gửi đi) ────────────────────────
// Bảo thủ: phải là câu hỏi về thời điểm chụp/tổ chức, không bắt nhầm câu báo lịch trống.
const BOT_ASK_WHEN_RE = /(khi nao|chung nao|bao gio|thoi gian nao|dip nao)/;
const BOT_ASK_SUBJECT_RE = /(chup|to chuc|lam le|cuoi|tiec|su kien|ke hoach|du dinh|dam)/;
const BOT_ASK_DATE_DIRECT_RE =
  /(ngay (nao|bao nhieu|may)\b|ngay du dinh|(co|chot|dinh|len) ngay (chua|chua a)|da co ngay|minh dinh ngay)/;

/** true nếu câu trả lời của bot CHỨA câu hỏi về ngày chụp (để ghi asked_questions). */
export function botAsksDate(replyText: string): boolean {
  const t = normalizeVi(replyText ?? "");
  if (!t) return false;
  if (BOT_ASK_DATE_DIRECT_RE.test(t)) return true;
  return BOT_ASK_WHEN_RE.test(t) && BOT_ASK_SUBJECT_RE.test(t);
}
