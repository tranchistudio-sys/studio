import { askClaudeForReply, resolveModel, type ClaudeHistoryItem } from "./claude-sale";
import {
  getSaleContext, resolvePriceImagesByCodes, wantsNewConcept, getPhotoIdeasBlock,
} from "./sale-context";
import { classifyCustomerImageFromData, buildImageRoutingBlock } from "./sale-vision";
import { selectSampleImages, extractRecentSampleUrls, SAMPLES_EXHAUSTED_NOTE } from "./sale-samples";
import { applyImageOverrides, type ImageOverride } from "./sale-image-overrides";
import { getActivePlaybook } from "./sale-playbook";
import { getClaudeSaleSettings, computeReplyDelayMs } from "./sale-settings";
import { getScheduleContext } from "./sale-calendar";
import { detectEscalation } from "./sale-lead-flags";
import { HOLD_MESSAGE, imageEscalationReason } from "./sale-human-review";

/**
 * sale-brain-runner — mô phỏng 1 lượt trả lời của Lulu với MỘT bộ luật não cụ thể (brainRules).
 *
 * Dùng ĐÚNG các lib như sân test/Messenger (getSaleContext, AI Vision, selectSampleImages,
 * askClaudeForReply) nhưng cho phép TRUYỀN brainRules để Lulu Brain Lab chạy:
 *   - bản đang chạy thật (brainRules = null → version active / mặc định), và
 *   - bản nháp (brainRules = promptContent của bản nháp)
 * để so sánh cạnh nhau.
 *
 * AN TOÀN: KHÔNG ghi DB nghiệp vụ, KHÔNG gửi Messenger, KHÔNG tạo booking/CRM. Chỉ trả dữ liệu.
 */

export type SimulateInput = {
  message: string;
  /** Lịch sử trước đó (không gồm tin mới). */
  prior: ClaudeHistoryItem[];
  imageBase64?: string;
  imageMediaType?: string;
  /** Bộ luật não để chạy lượt này. null/undefined → version active / mặc định. */
  brainRules?: string | null;
  /** Override ảnh "admin dạy" của version đang test (rulesJson.imageOverrides). Rỗng → không thay ảnh. */
  imageOverrides?: ImageOverride[] | null;
};

export type SimulateResult = {
  reply: string[];
  raw: string;
  model: string;
  responseTimeMs: number;
  replyDelayMs: number;
  escalation: string | null;
  learnedName: string | null;
  escalated: boolean;
  escalationReason: string | null;
  holdMessage: string | null;
  botPaused: boolean;
  detectedIntent: string | null;
  priceImages: string[];
  sampleImages: Awaited<ReturnType<typeof selectSampleImages>>["images"];
  sampleLinks: Awaited<ReturnType<typeof selectSampleImages>>["links"];
  sampleNote: string | null;
  imageIntent: Awaited<ReturnType<typeof classifyCustomerImageFromData>> | null;
  /** true nếu ảnh mẫu lượt này được THAY bằng ảnh admin đã dạy (override khớp). */
  overrideApplied: boolean;
};

export async function simulateReply(input: SimulateInput): Promise<SimulateResult> {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("Chưa cấu hình ANTHROPIC_API_KEY trong .env");

  const message = (input.message ?? "").trim();
  const imageBase64 = (input.imageBase64 ?? "").trim();
  const hasImage = imageBase64.length > 0;
  const incomingText = message || (hasImage ? "[Khách gửi một hình ảnh]" : "");
  const prior = input.prior ?? [];
  const history: ClaudeHistoryItem[] = [...prior, { direction: "incoming", message: incomingText }];

  const model = resolveModel();
  const startedAt = Date.now();

  let context = await getSaleContext();
  if (wantsNewConcept(message)) {
    const ideas = await getPhotoIdeasBlock();
    if (ideas) context += `\n\n${ideas}`;
  }

  let imageIntent: SimulateResult["imageIntent"] = null;
  if (hasImage) {
    const convo = prior.filter((h) => !h.message.startsWith("[image:")).slice(-6)
      .map((h) => `${h.direction === "incoming" ? "Khách" : "Em"}: ${h.message}`).join("\n");
    imageIntent = await classifyCustomerImageFromData({
      dataBase64: imageBase64,
      mediaType: input.imageMediaType,
      messageText: message,
      conversationContext: convo,
    });
    context += `\n\n${buildImageRoutingBlock(imageIntent)}`;
    if (imageIntent.service_intent === "new_concept_idea" || imageIntent.should_use_photo_ideas) {
      const ideas = await getPhotoIdeasBlock();
      if (ideas) context += `\n\n${ideas}`;
    }
  }

  const styleGuide = await getActivePlaybook();
  const settings = await getClaudeSaleSettings();
  let scheduleContext = "";
  if (settings.calendarEnabled) {
    try { scheduleContext = await getScheduleContext(settings.calWindowDays); } catch { /* bỏ qua */ }
  }

  const reply = await askClaudeForReply({
    apiKey,
    model,
    customerMessage: incomingText,
    customerName: "Khách test",
    history,
    context,
    styleGuide,
    settings,
    scheduleContext,
    brainRules: input.brainRules ?? null,
  });
  const responseTimeMs = Date.now() - startedAt;

  let priceImages: string[] = [];
  try {
    const hits = await resolvePriceImagesByCodes(reply.priceImageCodes ?? []);
    priceImages = hits.map((h) => h.objectPath);
  } catch { /* không chặn câu trả lời nếu lỗi ảnh */ }

  let sampleImages: SimulateResult["sampleImages"] = [];
  let sampleLinks: SimulateResult["sampleLinks"] = [];
  let sampleNote: string | null = null;
  let overrideApplied = false;
  try {
    const contextText = prior.filter((h) => !h.message.startsWith("[image:")).slice(-4)
      .map((h) => h.message).join("\n");
    const lastBotText = [...prior].reverse().find((h) => h.direction === "outgoing")?.message ?? null;
    const excludeUrls = extractRecentSampleUrls(prior);
    const sel = await selectSampleImages({
      sampleRequested: reply.sampleRequested,
      sampleIntents: reply.sampleIntents,
      messageText: incomingText,
      contextText,
      lastBotText,
      visionIntent: imageIntent,
      settings,
      excludeUrls,
      maxTotal: 2,
    });
    // ÁP OVERRIDE "ADMIN DẠY": nếu khớp (intent + tone/gu) → thay ảnh mẫu bằng ảnh admin chọn.
    const overrides = input.imageOverrides ?? [];
    const detectedIntentForOverride =
      (reply.sampleIntents && reply.sampleIntents.length ? reply.sampleIntents[0] : null)
      || (imageIntent?.service_intent ?? null);
    const applied = applyImageOverrides(sel, overrides, {
      detectedIntent: detectedIntentForOverride,
      messageText: incomingText,
      contextText,
      excludeUrls,
      maxTotal: 4,
    });
    sampleImages = applied.images;
    sampleLinks = applied.links;
    overrideApplied = applied.overrideApplied;
    if (applied.exhausted) sampleNote = SAMPLES_EXHAUSTED_NOTE;
    if (applied.overrideApplied) console.log(`[BrainRunner] dùng ẢNH ADMIN DẠY (override ${applied.overrideId})`);
  } catch (e) { console.error("[BrainRunner] sampleImages lỗi:", String(e).slice(0, 160)); }

  const escalationReason =
    reply.escalation
    || detectEscalation(incomingText)
    || imageEscalationReason(imageIntent, settings.lowConfidenceThreshold);
  const wouldEscalate = !!escalationReason && settings.humanReviewEnabled;

  const detectedIntent =
    imageIntent?.service_intent
    || (reply.sampleIntents && reply.sampleIntents.length ? reply.sampleIntents[0] : null)
    || (sampleImages[0]?.serviceIntent ?? null);

  return {
    reply: reply.messages.length > 0 ? reply.messages : reply.raw ? [reply.raw] : ["(Lulu không trả về nội dung)"],
    raw: reply.raw,
    model,
    responseTimeMs,
    replyDelayMs: computeReplyDelayMs(incomingText, settings),
    escalation: reply.escalation,
    learnedName: reply.learnedName,
    escalated: wouldEscalate,
    escalationReason,
    holdMessage: wouldEscalate ? HOLD_MESSAGE : null,
    botPaused: wouldEscalate && settings.autoPauseThreadWhenEscalated,
    detectedIntent,
    priceImages,
    sampleImages,
    sampleLinks,
    sampleNote,
    imageIntent,
    overrideApplied,
  };
}
