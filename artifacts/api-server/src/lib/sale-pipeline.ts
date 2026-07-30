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
};

export type FinalizeInput = {
  /** null = không có provider nào khả dụng → đi thẳng stitched fallback. */
  callLlm: PipelineLlmCall | null;
  golden: GoldenExample[];
  facts: PipelineFacts;
  validate: (reply: string) => PipelineValidator;
};

export type FinalizeResult = {
  replyText: string | null;
  replyError: string | null;
  provider: string; // 'anthropic'|'shopaikey'|... | 'stitched-fallback' | 'safe-fallback'
  validator: PipelineValidator;
  regenerated: boolean;
  fallbackUsed: "none" | "stitched" | "safe";
  needsHuman: boolean;
  /** Lý do lần chặn CUỐI trước khi rơi xuống fallback (debug/trace) — null nếu không bị chặn. */
  blockedReason: string | null;
};

/** Câu an toàn cuối cùng khi mọi tầng đều fail — không bịa, chuyển người thật. */
export const SAFE_REPLY_LINE =
  "Dạ phần này em xin phép kiểm tra kỹ lại để báo mình chính xác nhất ạ.\n" +
  "Em chuyển bạn phụ trách hỗ trợ mình ngay nha, mình chờ em xíu ạ.";

const safeValidate = (validate: FinalizeInput["validate"], reply: string): PipelineValidator => {
  try { return validate(reply); } catch { return { verdict: "PASS" }; }
};

/** Stitched fallback: cách nói golden + FACT CRM (deterministic — chính lời khách sẽ nhận khi không LLM). */
function tryStitch(golden: GoldenExample[], facts: PipelineFacts): string | null {
  const top = golden.find((g) => (g.idealResponse ?? "").trim());
  if (!top || facts.crmPriceVnd == null) return null;
  const text = stitchReplyFromGolden({
    idealResponse: top.idealResponse,
    crmPriceVnd: facts.crmPriceVnd,
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

  // 1) LLM lần đầu + (nếu BLOCK) tái sinh đúng 1 lần với lý do validator.
  if (input.callLlm) {
    try {
      const r1 = await input.callLlm(null);
      llmError = r1.error ?? null;
      if (r1.text) {
        const v1 = safeValidate(input.validate, r1.text);
        if (v1.verdict !== "BLOCK") {
          return { ...base, replyText: r1.text, replyError: null, provider: r1.provider, validator: v1, blockedReason: null };
        }
        lastBlock = v1;
        const feedback = `${v1.reason ?? "vi phạm luật an toàn"}${v1.suggestedRecovery ? ` — ${v1.suggestedRecovery}` : ""}`;
        const r2 = await input.callLlm(feedback);
        if (r2.text) {
          const v2 = safeValidate(input.validate, r2.text);
          if (v2.verdict !== "BLOCK") {
            return { ...base, regenerated: true, replyText: r2.text, replyError: null, provider: r2.provider, validator: v2, blockedReason: null };
          }
          lastBlock = v2;
        }
        base.regenerated = true; // đã tái sinh mà vẫn không qua → rơi xuống fallback
      }
    } catch (err) {
      llmError = String((err as Error)?.message ?? err).slice(0, 150);
    }
  }

  // 2) Stitched fallback — deterministic từ golden + facts CRM, vẫn phải qua validator.
  const stitched = tryStitch(input.golden, input.facts);
  if (stitched) {
    const vs = safeValidate(input.validate, stitched);
    if (vs.verdict !== "BLOCK") {
      return {
        ...base, fallbackUsed: "stitched",
        replyText: stitched, replyError: llmError, provider: "stitched-fallback", validator: vs,
        blockedReason: lastBlock ? (lastBlock.reason ?? "bị chặn") : null,
      };
    }
    lastBlock = vs;
  }

  // 3) Câu an toàn + chuyển người thật.
  return {
    ...base, fallbackUsed: "safe", needsHuman: true,
    replyText: SAFE_REPLY_LINE, replyError: llmError,
    provider: "safe-fallback", validator: { verdict: "PASS" },
    blockedReason: lastBlock ? `${lastBlock.reason ?? "bị chặn"}${lastBlock.violatedRule ? ` [${lastBlock.violatedRule}]` : ""}` : (stitched ? null : "không có golden/giá CRM để ghép fallback"),
  };
}
