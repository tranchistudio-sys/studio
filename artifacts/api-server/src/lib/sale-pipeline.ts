import type { GoldenExample } from "./sale-script-library";
import { stitchReplyFromGolden } from "./sale-reply-stitch";

/**
 * SALE PIPELINE — TẦNG CHỐT CÂU TRẢ LỜI (mandate "NỐI DÂY ĐIỆN LULU" mục F/VI).
 *
 * Đứng SAU khi context đã lắp (state → scenario → golden → facts → style) và LLM
 * được gọi. Nhiệm vụ: đảm bảo câu trả lời cuối LUÔN qua validator, theo đúng thang:
 *
 *   LLM reply → validator
 *     BLOCK → regenerate ĐÚNG 1 LẦN (kèm lý do validator)
 *       vẫn BLOCK → stitched fallback (golden + facts CRM, deterministic)
 *         vẫn BLOCK / không stitch được → CÂU AN TOÀN + needsHuman (chuyển người thật)
 *   Không có LLM (thiếu key / lỗi) → stitched fallback → validator → an toàn nếu BLOCK.
 *
 * Ưu tiên: CORE SAFETY > REALTIME DATA > STATE > SCENARIO > ACTION > STYLE > WORDING.
 * Module THUẦN — LLM và validator được TIÊM vào (test được không cần key/DB).
 */

export type PipelineValidator = { verdict: string; severity?: string; reason?: string; violatedRule?: string; suggestedRecovery?: string };

export type PipelineLlmResult = { text: string | null; provider: string; error?: string | null };
/** Gọi LLM; `regenFeedback` != null nghĩa là lần tái sinh (chèn lý do validator vào prompt). */
export type PipelineLlmCall = (regenFeedback: string | null) => Promise<PipelineLlmResult>;

export type PipelineFacts = {
  crmPriceVnd: number | null;
  promoActive: boolean;
  packageName?: string | null;
  packageContent?: string | null;
  promotion?: string | null;
  /** Tên nhóm dịch vụ đang khoá (hiển thị cho khách) — dùng cho fallback theo intent. */
  serviceName?: string | null;
};

export type FinalizeInput = {
  /** null = không có provider nào khả dụng → đi thẳng stitched fallback. */
  callLlm: PipelineLlmCall | null;
  golden: GoldenExample[];
  facts: PipelineFacts;
  validate: (reply: string) => PipelineValidator;
  /** Detector giọng catalogue (chống DATABASE VOICE) — fail → regenerate/naturalize. Tuỳ chọn. */
  voiceCheck?: (reply: string) => { ok: boolean; reason: string | null };
  /** Action Router quyết định (dùng chọn câu fallback THEO INTENT khi stitch không có/bị chặn). */
  action?: string | null;
  /** Hội thoại đã có lượt bot XÁC NHẬN dịch vụ này rồi → không lặp câu "bên em có X" nữa. */
  alreadyConfirmedService?: boolean;
};

export type FinalizeResult = {
  replyText: string | null;
  replyError: string | null;
  provider: string; // 'anthropic'|'shopaikey'|... | 'stitched-fallback' | 'intent-fallback' | 'safe-fallback'
  validator: PipelineValidator;
  regenerated: boolean;
  fallbackUsed: "none" | "stitched" | "intent" | "safe";
  needsHuman: boolean;
  /** Lý do lần chặn CUỐI trước khi rơi xuống fallback (debug/trace) — null nếu không bị chặn. */
  blockedReason: string | null;
};

/**
 * FALLBACK THEO INTENT (mandate IX) — câu trung lập tự nhiên theo ACTION + FACT của
 * ĐÚNG dịch vụ đang khoá. Dùng khi golden không có/bị chặn — KHÔNG lấy câu dịch vụ khác,
 * KHÔNG dump database. null = action không có mẫu → rơi xuống câu an toàn.
 */
export function intentFallbackLine(
  action: string | null | undefined, facts: PipelineFacts,
  opts: { alreadyConfirmedService?: boolean } = {},
): string | null {
  const svc = (facts.serviceName ?? "").trim();
  const price = facts.crmPriceVnd != null && facts.crmPriceVnd > 0
    ? `${Math.round(facts.crmPriceVnd).toLocaleString("vi-VN").replace(/,/g, ".")}đ` : null;
  const pkg = (facts.packageName ?? "").trim();
  // CONTROLLED VARIATION cho câu xác nhận dịch vụ — cùng nghĩa, wording xoay vòng.
  // ĐÃ xác nhận dịch vụ trước đó → câu TIẾP NỐI (không lặp "bên em có X").
  const confirmSvc = (name: string) => {
    const variants = opts.alreadyConfirmedService
      ? [
          `Dạ em đây ạ, mình muốn xem tiếp phần nào của ${name} để em gửi liền nè?`,
          "Mình cứ hỏi thoải mái nha, em đang hỗ trợ mình đây ạ.",
          "Dạ em nghe mình nè, mình cần em tư vấn thêm phần nào ạ?",
        ]
      : [
          `Dạ có mình nha, bên em có ${name} ạ.\nMình thích kiểu nào để em tư vấn sát hơn ạ?`,
          `Có luôn ạ, ${name} là một trong những mảng bên em làm nhiều nhất nè.\nMình đang nghiêng về kiểu nhẹ nhàng hay cá tính hơn ạ?`,
          `Dạ bên em nhận ${name} nha mình.\nĐể em tư vấn đúng ý, mình muốn chụp theo phong cách nào ạ?`,
        ];
    return variants[Math.floor(Math.random() * variants.length)];
  };
  switch ((action ?? "").toUpperCase()) {
    case "GREET":
    case "ASK_SERVICE":
      // Khách mở lời ĐÃ nêu dịch vụ ("có chụp beauty ko") → xác nhận đúng dịch vụ + 1 câu định hướng.
      return svc
        ? confirmSvc(svc)
        : "Dạ em chào mình ạ. Mình đang quan tâm dịch vụ nào bên em để em tư vấn đúng ạ?";
    case "IDENTIFY_SERVICE":
      return svc
        ? confirmSvc(svc)
        : "Dạ bên em có nhiều gói chụp lắm ạ. Mình đang muốn chụp cho dịp nào để em tư vấn đúng ạ?";
    case "ASK_DATE":
      return "Dạ để em tư vấn lịch và gói chính xác, mình dự định chụp khoảng thời gian nào ạ?\nChưa chốt ngày cũng không sao, em gửi mức tham khảo trước cho mình ạ.";
    case "QUOTE_REFERENCE":
    case "QUOTE_EXACT":
      return price
        ? `Dạ gói ${pkg || "bên em"} hiện là ${price} ạ.\nMình muốn em gửi thêm phần gói gồm những gì không ạ?`
        : null;
    case "HANDLE_OBJECTION":
      return "Dạ em hiểu mình đang cân nhắc ạ.\nMình cho em biết phần mình ưu tiên nhất, em xem phương án phù hợp hơn cho mình nha.";
    case "ASK_PHONE":
      return "Dạ để bạn phụ trách hỗ trợ mình nhanh nhất, em xin số điện thoại liên hệ được không ạ?";
    case "SEND_SAMPLE":
      return "Dạ em gửi mình vài bộ ảnh thật đúng kiểu mình thích nha.\nMình nghiêng về tông nhẹ nhàng hay sang trọng hơn ạ?";
    case "ANSWER_FAQ":
    case "WAIT":
      return "Dạ mình cứ xem thoải mái nha, cần thêm thông tin gì mình nhắn em liền ạ.";
    default:
      return null;
  }
}

/** Câu an toàn cuối cùng khi mọi tầng đều fail — không bịa, chuyển người thật. */
export const SAFE_REPLY_LINE =
  "Dạ phần này em xin phép kiểm tra kỹ lại để báo mình chính xác nhất ạ.\n" +
  "Em chuyển bạn phụ trách hỗ trợ mình ngay nha, mình chờ em xíu ạ.";

const safeValidate = (validate: FinalizeInput["validate"], reply: string): PipelineValidator => {
  try { return validate(reply); } catch { return { verdict: "PASS" }; }
};

/** Câu có nhắc TIỀN/token giá không? (câu chào hỏi thuần không cần giá CRM vẫn stitch được) */
const MENTIONS_PRICE_RE = /\{\{\s*price\s*\}\}|(\d{1,3}([.,]\d{3}){1,3}\s*(đ|d|vnd)|\d+\s*(triệu|tr)\b|\d{2,4}\s*k\b)/i;

/** Stitched fallback: cách nói golden + FACT CRM (deterministic — chính lời khách sẽ nhận khi không LLM).
 *  CONTROLLED VARIATION: các golden ĐỒNG HẠNG (cùng điểm khớp cao nhất) được chọn luân phiên —
 *  cùng meaning anchor, wording khác nhau giữa các hội thoại. */
function tryStitch(golden: GoldenExample[], facts: PipelineFacts): string | null {
  const usable = golden.filter((g) => (g.idealResponse ?? "").trim());
  if (!usable.length) return null;
  const topScore = usable[0].score ?? 0;
  const ties = usable.filter((g) => (g.score ?? 0) === topScore);
  const top = ties[Math.floor(Math.random() * ties.length)];
  if (!top) return null;
  // Câu cần GIÁ mà chưa có giá CRM → không stitch (không được bịa/để trống giá).
  if (facts.crmPriceVnd == null && MENTIONS_PRICE_RE.test(top.idealResponse)) return null;
  const text = stitchReplyFromGolden({
    idealResponse: top.idealResponse,
    crmPriceVnd: facts.crmPriceVnd ?? 0, // 0 = không thay giá (formatVnd(0) rỗng → giữ nguyên câu không-token)
    promoActive: !!facts.promoActive,
    packageName: facts.packageName ?? null,
    packageContent: facts.packageContent ?? null,
    promotion: facts.promotion ?? null,
  }).trim();
  return text || null;
}

export async function finalizeSaleReply(input: FinalizeInput): Promise<FinalizeResult> {
  const base: Pick<FinalizeResult, "regenerated" | "fallbackUsed" | "needsHuman"> = {
    regenerated: false, fallbackUsed: "none", needsHuman: false,
  };
  let llmError: string | null = null;
  let lastBlock: PipelineValidator | null = null;

  // Cổng kép trên 1 câu: validator AN TOÀN + voiceCheck GIỌNG (chống database voice).
  const gate = (reply: string): { pass: boolean; v: PipelineValidator; reason: string | null } => {
    const v = safeValidate(input.validate, reply);
    if (v.verdict === "BLOCK") return { pass: false, v, reason: v.reason ?? "vi phạm luật an toàn" };
    if (input.voiceCheck) {
      try {
        const vc = input.voiceCheck(reply);
        if (!vc.ok) return { pass: false, v: { verdict: "BLOCK", reason: `giọng catalogue: ${vc.reason}`, violatedRule: "database_voice" }, reason: `giọng catalogue/database — ${vc.reason}. Nói NGẮN tự nhiên như sale thật, không đọc nguyên mô tả gói` };
      } catch { /* detector lỗi → bỏ qua */ }
    }
    return { pass: true, v, reason: null };
  };

  // 1) LLM lần đầu + (nếu BỊ CHẶN bởi an toàn HOẶC giọng) tái sinh đúng 1 lần với lý do.
  if (input.callLlm) {
    try {
      const r1 = await input.callLlm(null);
      llmError = r1.error ?? null;
      if (r1.text) {
        const g1 = gate(r1.text);
        if (g1.pass) {
          return { ...base, replyText: r1.text, replyError: null, provider: r1.provider, validator: g1.v, blockedReason: null };
        }
        lastBlock = g1.v;
        const feedback = `${g1.reason}${g1.v.suggestedRecovery ? ` — ${g1.v.suggestedRecovery}` : ""}`;
        const r2 = await input.callLlm(feedback);
        if (r2.text) {
          const g2 = gate(r2.text);
          if (g2.pass) {
            return { ...base, regenerated: true, replyText: r2.text, replyError: null, provider: r2.provider, validator: g2.v, blockedReason: null };
          }
          lastBlock = g2.v;
        }
        base.regenerated = true; // đã tái sinh mà vẫn không qua → rơi xuống fallback
      }
    } catch (err) {
      llmError = String((err as Error)?.message ?? err).slice(0, 150);
    }
  }

  // 2a) Câu "bên em có X không?": chuẩn là XÁC NHẬN ĐÚNG DỊCH VỤ + 1 câu định hướng —
  // ưu tiên intent-line TRƯỚC golden (situation-script dễ lệch nghĩa khi điểm keyword thấp).
  // Áp cho IDENTIFY_SERVICE, và GREET/ASK_SERVICE khi khách ĐÃ nêu dịch vụ (serviceName có) —
  // NHƯNG KHÔNG lặp lại nếu hội thoại đã xác nhận dịch vụ rồi (chống REPEATED_OPENER).
  const actionU = (input.action ?? "").toUpperCase();
  let intentTried = false;
  const tryIntentLine = (): FinalizeResult | null => {
    if (intentTried) return null;
    intentTried = true;
    const line = intentFallbackLine(input.action, input.facts, { alreadyConfirmedService: input.alreadyConfirmedService });
    if (!line) return null;
    const gl = gate(line);
    if (gl.pass) {
      return {
        ...base, fallbackUsed: "intent",
        replyText: line, replyError: llmError, provider: "intent-fallback", validator: gl.v,
        blockedReason: lastBlock ? (lastBlock.reason ?? "bị chặn") : null,
      };
    }
    lastBlock = gl.v;
    return null;
  };
  const intentFirst = !input.alreadyConfirmedService && (
    actionU === "IDENTIFY_SERVICE"
    || ((actionU === "GREET" || actionU === "ASK_SERVICE") && !!(input.facts.serviceName ?? "").trim())
  );
  if (intentFirst) {
    const r = tryIntentLine();
    if (r) return r;
  }

  // 2b-pre) GOLDEN "MÙ" (không dòng nào trùng từ khoá với câu khách) → câu situation-script
  // chỉ là "giọng chung" dễ lệch nghĩa — ưu tiên intent-line theo action trước.
  const goldenBlind = !input.golden.length || (input.golden[0]?.kw ?? 0) < 1;
  if (goldenBlind) {
    const r = tryIntentLine();
    if (r) return r;
  }

  // 2) Stitched fallback — deterministic từ golden + facts CRM, vẫn phải qua CẢ 2 cổng.
  const stitched = tryStitch(input.golden, input.facts);
  if (stitched) {
    const gs = gate(stitched);
    if (gs.pass) {
      return {
        ...base, fallbackUsed: "stitched",
        replyText: stitched, replyError: llmError, provider: "stitched-fallback", validator: gs.v,
        blockedReason: lastBlock ? (lastBlock.reason ?? "bị chặn") : null,
      };
    }
    lastBlock = gs.v;
  }

  // 2c) Fallback THEO INTENT — câu trung lập của ĐÚNG dịch vụ (action + facts), qua cả 2 cổng.
  {
    const r = tryIntentLine();
    if (r) return r;
  }

  // 3) Câu an toàn + chuyển người thật.
  return {
    ...base, fallbackUsed: "safe", needsHuman: true,
    replyText: SAFE_REPLY_LINE, replyError: llmError,
    provider: "safe-fallback", validator: { verdict: "PASS" },
    blockedReason: lastBlock ? `${lastBlock.reason ?? "bị chặn"}${lastBlock.violatedRule ? ` [${lastBlock.violatedRule}]` : ""}` : (stitched ? null : "không có golden/giá CRM để ghép fallback"),
  };
}
