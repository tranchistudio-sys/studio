import type { ThreadState } from "./sale-thread-state";
import type { RouterDecision } from "./sale-workflow";
import { botAsksDate } from "./sale-slots";
import { detectServiceDrift, type KnownIntent } from "./sale-conversation-discipline";

/**
 * VALIDATOR V1 — kiểm tra câu trả lời SAU khi LLM sinh, TRƯỚC khi gửi khách.
 *
 * OFFLINE: chưa nối production. Chạy ở sân test (hiển thị verdict trong trace) và
 * unit test. Khi nối thật: BLOCK → tái sinh 1 lần / cắt câu vi phạm / escalate —
 * KHÔNG BAO GIỜ gửi response BLOCK cho khách.
 *
 * Mọi check đều DETERMINISTIC (regex/so số) — không gọi AI để chấm AI.
 */

export type CatalogItem = {
  code: string;
  name: string;
  /** Giá gốc (VND). */
  price: number;
  /** Giá sau ưu đãi nếu đang giảm (VND). */
  finalPrice?: number | null;
};

export type ValidatorInput = {
  threadState: ThreadState;
  decision: RouterDecision;
  /** Toàn bộ text bot định gửi (đã ghép các bubble). */
  reply: string;
  /** Catalog để đối chiếu giá — không truyền thì BỎ QUA check giá (không chặn oan). */
  catalog?: CatalogItem[];
};

export type ValidatorResult =
  | { verdict: "PASS" }
  | { verdict: "BLOCK"; reason: string; violatedRule: string; severity: "critical" | "major" | "minor"; suggestedRecovery: string };

function block(
  violatedRule: string,
  reason: string,
  suggestedRecovery: string,
  severity: "critical" | "major" | "minor" = "major",
): ValidatorResult {
  return { verdict: "BLOCK", reason, violatedRule, severity, suggestedRecovery };
}

function normalizeVi(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}

// ─── Trích số tiền trong reply (để so catalog) ────────────────────────────────
// Bắt các dạng: "3.900.000đ", "3,9 triệu", "3tr9", "3tr", "800k", "3 triệu 9".
// Trả về VND. Cố tình KHÔNG bắt số trần không đơn vị (tránh false positive "2-3 người").

const MONEY_RES: Array<{ re: RegExp; toVnd: (m: RegExpExecArray) => number | null }> = [
  // 3.900.000đ / 3900000 vnd
  {
    re: /(\d{1,3}(?:[.,]\d{3}){1,3})\s*(?:d|dong|vnd|vnđ)\b/g,
    toVnd: (m) => Number(m[1].replace(/[.,]/g, "")),
  },
  // 2.500.000 KHÔNG kèm đơn vị: ≥2 nhóm nghìn trong chat Việt gần như chắc chắn là tiền
  // (chặn lỗ giá bịa "2.500.000 ạ" lọt gate). Guard: không dính chuỗi số dài (SĐT) + biên hợp lý.
  {
    re: /(?<!\d)(\d{1,3}(?:[.,]\d{3}){2,3})(?![\d.,]?\d)/g,
    toVnd: (m) => {
      const v = Number(m[1].replace(/[.,]/g, ""));
      return v >= 100_000 && v <= 100_000_000 ? v : null;
    },
  },
  // 3tr9 / 3tr / 3,5tr / 3,95 triệu / 3 triệu rưỡi
  {
    re: /(\d{1,3})(?:[.,](\d{1,2}))?\s*tr(?:ieu)?\s*(?:(\d)\b|(ruoi)\b)?/g,
    toVnd: (m) => {
      const whole = Number(m[1]);
      if (!Number.isFinite(whole)) return null;
      if (m[4]) return whole * 1_000_000 + 500_000; // "3 triệu rưỡi"
      if (m[3] != null) return whole * 1_000_000 + Number(m[3]) * 100_000; // 3tr9
      if (m[2] != null) return whole * 1_000_000 + Math.round(Number(`0.${m[2]}`) * 1_000_000); // 3,95 triệu
      return whole * 1_000_000;
    },
  },
  // 800k / 950 k
  { re: /(\d{2,4})\s*k\b/g, toVnd: (m) => Number(m[1]) * 1_000 },
];

/** Mọi số tiền (VND) xuất hiện trong reply. Export để test. */
export function extractMoneyVnd(reply: string): number[] {
  const t = normalizeVi(reply);
  const out: number[] = [];
  for (const { re, toVnd } of MONEY_RES) {
    const rex = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = rex.exec(t)) !== null) {
      const v = toVnd(m);
      if (v != null && Number.isFinite(v) && v >= 50_000) out.push(v);
    }
  }
  return [...new Set(out)];
}

// ─── Các rule ─────────────────────────────────────────────────────────────────

// Tự giảm giá / tự hứa ưu đãi — bot không có quyền deal. Check trên text đã bỏ dấu.
// "giam con" TÁCH RIÊNG: là cách nói chuẩn khi báo finalPrice của ưu đãi thật ("đang ưu đãi
// giảm còn 3.500.000đ") — chỉ block khi KHÔNG có catalog đối chiếu / không kèm số (hứa suông).
const SELF_DISCOUNT_NORM_RE =
  /((em|ben em|ben minh|shop)\s*(chac\s*|se\s*)?(giam|bot|tang them|khuyen mai rieng)|bot cho (anh|chi|minh)|em bot\b|giam them cho|tang rieng|uu dai rieng cho|gia dac biet cho)/;
const GIAM_CON_RE = /giam con\b/;
// Lộ nội bộ: marker hệ thống / khối prompt — TUYỆT ĐỐI không được ra khách.
const LEAK_INTERNAL_RE = /(<<|>>|TRẠNG THÁI KHÁCH|system prompt|instruction nội bộ|RÀNG BUỘC \(BẮT BUỘC)/i;

// Map ServiceIntent (thread state) → KnownIntent (detectServiceDrift).
const INTENT_TO_KNOWN: Record<string, KnownIntent> = {
  wedding_album: "wedding",
  wedding_party: "wedding",
  wedding_gate: "wedding_gate",
  rental_outfit: "rental",
  maternity: "maternity",
  family: "family",
  beauty: "beauty",
};

/** Đếm câu hỏi trong reply (mỗi lượt chỉ nên hỏi 1 câu chính). */
export function countQuestions(reply: string): number {
  return (reply.match(/\?/g) ?? []).length;
}

export function validateSaleReply(input: ValidatorInput): ValidatorResult {
  const { threadState: state, decision, reply } = input;
  const t = normalizeVi(reply);

  // 1. Hỏi lại ngày sai quy tắc (forbidden_questions của Router là luật).
  if (decision.forbiddenQuestions.includes("ask_date") && botAsksDate(reply)) {
    return block(
      "forbidden_ask_date",
      "Reply hỏi ngày trong khi ask_date đang bị cấm (khách đã nói chưa chốt / đã hỏi rồi / đã có ngày)",
      "Tái sinh reply với lệnh cứng không nhắc ngày; nếu vẫn vi phạm → cắt câu hỏi ngày khỏi reply",
    );
  }

  // 2. Hỏi lại câu đã hỏi ≥2 lần (V1 phát hiện được ask_date; key khác chờ detector riêng).
  const askedDate = state.askedQuestions.find((q) => q.key === "ask_date");
  if (askedDate && (askedDate.count ?? 0) >= 2 && botAsksDate(reply)) {
    return block(
      "repeated_question",
      `Đã hỏi ngày ${askedDate.count} lần, reply lại hỏi tiếp`,
      "Tái sinh, chuyển sang bước khác (gu/mẫu/giá tham khảo)",
    );
  }

  // 3. Response không khớp action Router (check chiều mạnh, tránh chặn oan):
  //    Router KHÔNG chọn ASK_DATE mà reply lại hỏi ngày (khi không được phép).
  if (decision.action !== "ASK_DATE" && botAsksDate(reply) && !decision.allowedQuestions.includes("ask_date")) {
    return block(
      "response_not_matching_action",
      `Router chọn ${decision.action} nhưng reply chèn câu hỏi ngày không được phép`,
      "Tái sinh giữ đúng action; nếu vẫn vi phạm → cắt câu hỏi ngày",
    );
  }

  // 4. Báo giá không khớp catalog (chỉ khi có catalog — fail-open, không chặn oan).
  if (input.catalog && input.catalog.length > 0) {
    const validPrices = new Set<number>();
    for (const c of input.catalog) {
      if (Number.isFinite(c.price)) validPrices.add(c.price);
      if (c.finalPrice != null && Number.isFinite(c.finalPrice)) {
        validPrices.add(c.finalPrice);
        // MỨC GIẢM (price − finalPrice) cũng là số hợp lệ — chính context bắt Lulu nêu
        // "giảm 500.000đ" khi có ưu đãi fixed (sale-context.ts khối ƯU ĐÃI).
        if (Number.isFinite(c.price) && c.price > c.finalPrice) validPrices.add(c.price - c.finalPrice);
      }
    }
    for (const amount of extractMoneyVnd(reply)) {
      if (!validPrices.has(amount)) {
        return block(
          "price_mismatch",
          `Reply nêu số tiền ${amount.toLocaleString("vi-VN")}đ không có trong catalog`,
          "Tái sinh với bảng giá chèn lại; vẫn sai → escalate người thật, KHÔNG gửi giá sai",
          "critical",
        );
      }
    }
  }

  // 5. Tự giảm giá / tự hứa ưu đãi. "giảm còn <số>" hợp lệ khi có catalog đối chiếu
  // (số bậy đã bị rule 4 chặn trước đó); không catalog / không số = hứa suông → block.
  if (
    SELF_DISCOUNT_NORM_RE.test(t) ||
    (GIAM_CON_RE.test(t) && !(input.catalog?.length && extractMoneyVnd(reply).length > 0))
  ) {
    return block(
      "self_discount",
      "Reply tự giảm giá / hứa ưu đãi ngoài catalog — bot không có quyền deal",
      "Thay bằng câu 'để em hỏi quản lý giúp mình' + escalate",
      "critical",
    );
  }

  // 5b. Lộ marker/prompt nội bộ ra khách.
  if (LEAK_INTERNAL_RE.test(reply)) {
    return block(
      "leak_internal",
      "Reply chứa marker/khối prompt nội bộ (<<...>>, TRẠNG THÁI KHÁCH...)",
      "Cắt phần nội bộ khỏi reply; tái sinh nếu phần còn lại rỗng",
      "critical",
    );
  }

  // 6. Trôi dịch vụ (service drift) — nâng từ log-only thành CHẶN, NHƯNG chỉ khi ĐÃ khóa
  // nhu cầu và Router không chủ động yêu cầu hỏi/chào (GREET/ASK_SERVICE/IDENTIFY_SERVICE
  // có nhiệm vụ hỏi "mình muốn chụp gì" — không được chặn chính câu Router yêu cầu).
  const known = state.serviceIntent ? INTENT_TO_KNOWN[state.serviceIntent] ?? null : null;
  const driftExempt =
    decision.action === "GREET" || decision.action === "ASK_SERVICE" || decision.action === "IDENTIFY_SERVICE";
  const drift = known && !driftExempt ? detectServiceDrift(reply, known) : [];
  if (drift.length > 0) {
    return block(
      "service_drift",
      `Reply trôi khỏi nhu cầu đang khóa (${state.serviceIntent}): ${drift.join(", ")}`,
      "Tái sinh với khóa nhu cầu nhấn mạnh; vẫn trôi → escalate",
    );
  }

  // 7. Hỏi quá nhiều câu trong 1 lượt.
  if (countQuestions(reply) >= 3) {
    return block(
      "too_many_questions",
      `Reply chứa ${countQuestions(reply)} câu hỏi — quy tắc mỗi lượt 1 câu chính`,
      "Tái sinh chỉ giữ 1 câu hỏi quan trọng nhất",
      "minor",
    );
  }

  // 8. Cần người thật nhưng reply vẫn "cố bán" (bung giá / hỏi dồn) — phải DỪNG đúng lúc,
  // chỉ được giữ khách lịch sự rồi bàn giao.
  if (decision.shouldEscalate && decision.action === "ESCALATE_HUMAN") {
    if (extractMoneyVnd(reply).length > 0 || countQuestions(reply) >= 2) {
      return block(
        "escalate_but_selling",
        "Decision là bàn giao người thật nhưng reply vẫn bung giá / hỏi dồn tiếp",
        "Thay bằng câu giữ khách ngắn + xác nhận nhân viên sẽ liên hệ",
      );
    }
  }

  return { verdict: "PASS" };
}
