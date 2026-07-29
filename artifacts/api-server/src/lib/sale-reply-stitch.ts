import { extractMoneyVnd } from "./sale-workflow-validator";

/**
 * REPLY-STITCH — hiện thực DETERMINISTIC của công thức trả lời (luật chủ mục F):
 *
 *   CÂU TRẢ LỜI = KỊCH BẢN (cách nói) + DỮ LIỆU CRM (giá thật) + LUẬT AN TOÀN
 *
 * Dùng cho 2 việc:
 *   1) BẰNG CHỨNG cho chủ studio: chứng minh "giữ CÁCH NÓI của kịch bản, THAY con số cũ
 *      bằng giá CRM hiện tại" — xem được ngay cả khi CHƯA cấu hình AI key.
 *   2) Bản nháp fallback khi không có LLM.
 *
 * STATIC (kịch bản/golden) = guidance. DYNAMIC (CRM) = facts. CRM luôn thắng (mục C, E, G).
 * THUẦN chuỗi — không DB, không AI — nên unit-test được và không có side effect.
 */

/** 9500000 → "9.500.000đ" (định dạng validator parse lại được → khớp validPrices). */
export function formatVnd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${Math.round(n).toLocaleString("vi-VN").replace(/,/g, ".")}đ`;
}

// Token số tiền để THAY trong câu (đủ dạng người viết kịch bản hay dùng).
const MONEY_TOKEN_RE =
  /(\d{1,3}(?:[.,]\d{3}){1,3}\s*(?:đ|d|vnd|vnđ|đồng|dong)?|\d{1,3}(?:[.,]\d{1,2})?\s*(?:triệu|tr)\b\d?|\d{2,4}\s*k\b)/gi;

// Placeholder chủ nên dùng thay số tiền — luôn nội suy bằng giá CRM.
const PRICE_PLACEHOLDER_RE = /\{\{\s*price\s*\}\}/gi;

/**
 * Thay MỌI con số tiền (và {{PRICE}}) trong câu kịch bản bằng giá CRM hiện tại.
 * Giữ nguyên câu chữ xung quanh (cách nói). Trả về câu mới + các số cũ đã bị thay.
 */
export function replacePricesWith(text: string, crmPriceVnd: number): { text: string; replacedOld: number[] } {
  const priceStr = formatVnd(crmPriceVnd);
  const replacedOld = extractMoneyVnd(text).filter((v) => v !== crmPriceVnd);
  let out = (text ?? "").replace(PRICE_PLACEHOLDER_RE, priceStr || "{{PRICE}}");
  if (priceStr) out = out.replace(MONEY_TOKEN_RE, priceStr);
  return { text: out, replacedOld };
}

// Mệnh đề khẳng định ĐANG có ưu đãi — gỡ khi CRM tắt promo (mục D).
// KHÔNG dùng \b: ký tự có dấu (đ/ư/gi) không phải \w nên \b không neo đúng.
const PROMO_CLAUSE_RE =
  /[^.,;!?]*(đang giảm|đang có (chương trình )?(khuyến mãi|ưu đãi|giảm)|khuyến mãi|ưu đãi|giảm giá|sale off|flash sale|giữ ưu đãi)[^.,;!?]*/gi;
const PROMO_CLAUSE_NEGATED_RE = /(không|chưa|hết|chẳng)\s*(còn\s*)?(có\s*)?(chương trình\s*)?(khuyến mãi|ưu đãi|giảm|sale)/i;

/**
 * Gỡ các mệnh đề "đang giảm/khuyến mãi" khỏi câu khi CRM KHÔNG có promo active.
 * Bảo toàn mệnh đề PHỦ ĐỊNH ("hiện chưa có ưu đãi"). Trả về câu đã dọn + có gỡ gì không.
 */
export function stripPromoClaims(text: string): { text: string; stripped: boolean } {
  let stripped = false;
  const out = (text ?? "")
    .replace(PROMO_CLAUSE_RE, (clause) => {
      if (PROMO_CLAUSE_NEGATED_RE.test(clause)) return clause; // giữ câu phủ định
      stripped = true;
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;!?])/g, "$1")
    .replace(/([.,;])\1+/g, "$1")
    .replace(/^[\s.,;]+/, "")
    .trim();
  return { text: out, stripped };
}

export type StitchInput = {
  /** Câu sale mẫu trong kịch bản (golden) — nguồn CÁCH NÓI. */
  idealResponse: string;
  /** Giá KHÁCH THẬT SỰ trả hiện tại từ CRM (effectivePrice). */
  crmPriceVnd: number;
  /** CRM có promo active không (để gỡ tuyên bố giảm nếu tắt). */
  promoActive: boolean;
};

/**
 * Ghép câu trả lời cuối: GIỮ cách nói của kịch bản, THAY số cũ = giá CRM, GỠ tuyên bố
 * ưu đãi nếu CRM tắt promo. Đây là mục F/E/D thể hiện bằng code (không cần AI).
 */
export function stitchReplyFromGolden(input: StitchInput): string {
  let text = input.idealResponse ?? "";
  if (!input.promoActive) text = stripPromoClaims(text).text;
  text = replacePricesWith(text, input.crmPriceVnd).text;
  return text.trim();
}
