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
  /**
   * CRM/DB là NGUỒN SỰ THẬT bắt buộc cho câu này (STATIC-vs-DYNAMIC, luật chủ mục J):
   * true → mọi số tiền PHẢI verify được với `catalog`. Nếu reply có tiền mà catalog rỗng/thiếu
   * ⇒ BLOCK (KHÔNG fail-open). Mặc định undefined = hành vi cũ (fail-open, không chặn oan).
   */
  catalogAuthoritative?: boolean;
  /**
   * Trạng thái KHUYẾN MÃI thật từ CRM tại thời điểm trả lời (mục D):
   * false → CRM KHÔNG có ưu đãi active ⇒ reply tuyên bố "đang giảm/khuyến mãi/ưu đãi" bị BLOCK.
   * true/undefined → không chặn theo promo (đúng/không rõ đều để qua, giá vẫn bị rule giá soi).
   */
  promoActive?: boolean;
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
// (Mục D) Tuyên bố ĐANG có ưu đãi/khuyến mãi — chỉ chặn khi CRM nói promoActive===false.
// Bắt các cách nói khẳng định có chương trình giảm; loại trừ câu PHỦ ĐỊNH ("không/chưa/hết có ưu đãi").
const PROMO_CLAIM_RE =
  /(dang (co |ap dung )?(chuong trinh )?(khuyen mai|uu dai|giam gia|sale)|khuyen mai|uu dai|sale off|flash sale|dang giam|dang sale|giu (lai )?uu dai|co (chuong trinh )?(khuyen mai|uu dai))/;
const PROMO_NEGATED_RE =
  /(khong|khong con|chua|hien chua|het|hong|chang)\s*(con\s*)?(co\s*)?(chuong trinh\s*)?(khuyen mai|uu dai|giam|sale)/;
// Lộ nội bộ: marker hệ thống / khối prompt — TUYỆT ĐỐI không được ra khách.
const LEAK_INTERNAL_RE = /(<<|>>|TRẠNG THÁI KHÁCH|system prompt|instruction nội bộ|RÀNG BUỘC \(BẮT BUỘC)/i;
// (V2) Chê đối thủ — check trên text đã bỏ dấu.
const COMPETITOR_BASH_RE =
  /(ben (kia|do|khac|x)\s*(thi\s*)?(te|xau|dom|kem|re tien|chup xau|khong dep|lua)|(cho|studio) (do|kia|khac) (te|xau|dom|kem|lua)|dung (chup|lam|dat) (o )?(ben|cho) (kia|do|khac))/;
// (V2) Bot tự xác nhận cọc / thanh toán / đưa STK.
const DEPOSIT_CONFIRM_RE =
  /((em|ben em)?\s*(da |xin )?xac nhan (da )?(coc|dat coc|thanh toan|chuyen khoan)|(da )?nhan (duoc )?(tien )?coc|coc thanh cong|so tai khoan|\bstk\b)/;
// (V2) Hứa chắc còn lịch — bot chỉ đọc lịch, không cam kết.
const SCHEDULE_PROMISE_RE =
  /((chac chan|dam bao|bao dam|100%|cam ket).{0,15}(con lich|con trong|giu duoc (lich|ngay)|trong lich)|ngay (do|nay) chac chan (con|trong))/;

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

  // 4. Báo giá không khớp CRM. STATIC-vs-DYNAMIC (luật chủ): con số giá là DYNAMIC FACT,
  //    chỉ CRM mới quyết. Kịch bản/golden KHÔNG override được.
  const moneyInReply = extractMoneyVnd(reply);
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
    for (const amount of moneyInReply) {
      if (!validPrices.has(amount)) {
        return block(
          "price_mismatch",
          `Reply nêu số tiền ${amount.toLocaleString("vi-VN")}đ không khớp bảng giá CRM hiện tại`,
          "Tái sinh với bảng giá CRM chèn lại; vẫn sai → escalate người thật, KHÔNG gửi giá sai",
          "critical",
        );
      }
    }
  } else if (input.catalogAuthoritative && moneyInReply.length > 0) {
    // (Mục J) CRM là nguồn bắt buộc nhưng KHÔNG load được bảng giá để đối chiếu → KHÔNG fail-open.
    return block(
      "price_unverifiable",
      `Reply có số tiền (${moneyInReply.map((a) => a.toLocaleString("vi-VN")).join(", ")}đ) nhưng không đối chiếu được với CRM`,
      "Không gửi giá khi chưa đọc được bảng giá; escalate người thật hoặc tái sinh sau khi load được CRM",
      "critical",
    );
  }

  // 4b. (Mục D) Tuyên bố đang có KHUYẾN MÃI khi CRM KHÔNG có promo active → BLOCK.
  //     Kịch bản cũ còn ghi "đang giảm" KHÔNG được lặp lại nếu CRM đã tắt ưu đãi.
  if (input.promoActive === false && PROMO_CLAIM_RE.test(t) && !PROMO_NEGATED_RE.test(t)) {
    return block(
      "promo_not_active",
      "Reply nói đang có ưu đãi/khuyến mãi nhưng CRM hiện KHÔNG có promo active",
      "Bỏ mọi câu nói đang giảm/ưu đãi; báo đúng giá thường hiện tại từ CRM",
      "critical",
    );
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

  // 5c. (V2 Sales Brain) Chê/nói xấu đối thủ — mất uy tín studio, cấm tuyệt đối.
  if (COMPETITOR_BASH_RE.test(t)) {
    return block(
      "competitor_bashing",
      "Reply chê bai/nói xấu bên khác — chỉ được nêu điểm mạnh của mình",
      "Tái sinh: bỏ mọi nhận xét về đối thủ, thay bằng khác biệt cụ thể của studio",
      "major",
    );
  }

  // 5d. (V2) Bot tự xác nhận cọc / đưa số tài khoản — việc tiền bạc là của người thật.
  if (DEPOSIT_CONFIRM_RE.test(t)) {
    return block(
      "deposit_confirmed_by_bot",
      "Reply tự xác nhận cọc/thanh toán hoặc đưa số tài khoản — bot không được đụng tiền",
      "Thay bằng: xin ngày + SĐT rồi hẹn nhân viên xác nhận giữ chỗ; escalate",
      "critical",
    );
  }

  // 5e. (V2) Hứa CHẮC CHẮN còn lịch — bot chỉ đọc lịch, không có quyền cam kết.
  if (SCHEDULE_PROMISE_RE.test(t)) {
    return block(
      "schedule_promised",
      "Reply cam kết chắc chắn còn lịch/giữ được ngày — bot chỉ được nói 'em kiểm tra lịch giúp mình'",
      "Tái sinh: đổi thành sẽ kiểm tra lịch và nhờ nhân viên xác nhận",
      "major",
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
