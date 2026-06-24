import { askClaudeForReply, resolveModel, type ClaudeHistoryItem } from "./claude-sale";
import { formatLuluHumanChatMessages, type LuluChatChunk } from "./sale-human-chat";
import {
  getSaleContext, resolvePriceImagesByCodes, wantsNewConcept, getPhotoIdeasBlock,
} from "./sale-context";
import { classifyCustomerImageFromData, buildImageRoutingBlock } from "./sale-vision";
import { selectSampleImages, extractRecentSampleUrls, SAMPLES_EXHAUSTED_NOTE } from "./sale-samples";
import { applyImageOverrides, matchResponseOverride, type ImageOverride } from "./sale-image-overrides";
import { getActivePlaybook } from "./sale-playbook";
import { getClaudeSaleSettings, computeReplyDelayMs } from "./sale-settings";
import { getScheduleContext } from "./sale-calendar";
import { detectEscalation } from "./sale-lead-flags";
import { HOLD_MESSAGE, imageEscalationReason } from "./sale-human-review";

/**
 * URL ảnh có hợp lệ để gửi/hiển thị không? Chặn trường hợp lỡ dùng TIÊU ĐỀ (title tiếng Việt có dấu /
 * khoảng trắng) làm đường dẫn ảnh — sẽ render thành ảnh bể ở Chat test. URL thật luôn là http(s)://
 * hoặc đường dẫn nội bộ (/objects, /uploads, /public-objects…), KHÔNG chứa khoảng trắng.
 */
function isPlausibleImageUrl(u: string | null | undefined): boolean {
  const s = (u ?? "").trim();
  if (!s) return false;
  if (/\s/.test(s)) return false; // URL không có khoảng trắng; title tiếng Việt thì có → loại
  return /^https?:\/\//i.test(s) || s.startsWith("/") || /^[\w.\-]+\/\S+$/.test(s);
}

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
  /** Bong bóng có nhịp (human chat pacing): text + delayMs từng bubble. reply = chunks.map(c=>c.text). */
  chunks: LuluChatChunk[];
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
  /**
   * Cách lượt này dùng câu sửa tay của admin (nếu khớp override có ghim text):
   *  - "exact_reply": câu trả lời LÀ y chang câu admin (không qua AI viết lại).
   *  - "learn_from_this": AI viết lại nhưng bám câu mẫu admin.
   *  - null: không áp text admin (AI tự trả lời như thường).
   */
  responseMode: "exact_reply" | "learn_from_this" | null;
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

  // ── ĐIỀU KHIỂN TEXT (responseMode) — khớp override TRƯỚC khi gọi AI ──
  // learn_from_this: chèn câu mẫu admin vào prompt để AI bám theo (giữ đúng ý chính).
  // exact_reply: xử lý SAU khi có reply (thay text bằng câu admin), để ảnh vẫn dùng marker của AI.
  const priorContextText = prior.filter((h) => !h.message.startsWith("[image:")).slice(-4)
    .map((h) => h.message).join("\n");
  const respOverride = matchResponseOverride(incomingText, priorContextText, input.imageOverrides ?? []);
  if (respOverride?.responseMode === "learn_from_this" && respOverride.editedText) {
    context += `\n\nGỢI Ý CÂU TRẢ LỜI (admin đã duyệt cho tình huống tương tự — BÁM SÁT ý chính & giọng của câu mẫu, được viết lại cho tự nhiên hơn nhưng KHÔNG đổi ý chính):\n"""\n${respOverride.editedText.trim()}\n"""`;
    console.log("[SaleBrain] responseMode=learn_from_this (chèn câu mẫu admin vào prompt)");
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
    // VALIDATE URL ảnh trước khi trả về FE: loại ảnh có URL không hợp lệ (tránh render ảnh bể / lỡ
    // dùng tiêu đề làm URL). Log rõ từng ảnh để debug.
    sampleImages = applied.images.filter((im) => {
      const ok = isPlausibleImageUrl(im.imageUrl);
      if (ok) console.log(`[SaleBrain] image render url valid=true source=${im.sourceType ?? "?"}`);
      else console.warn(`[SaleBrain] image render url invalid reason=bad_url value="${String(im.imageUrl).slice(0, 80)}" title="${String(im.title).slice(0, 40)}"`);
      return ok;
    });
    sampleLinks = applied.links;
    overrideApplied = applied.overrideApplied && sampleImages.length > 0;
    if (applied.exhausted) sampleNote = SAMPLES_EXHAUSTED_NOTE;
    if (overrideApplied) console.log(`[SaleBrain] image override applied id=${applied.overrideId} count=${sampleImages.length}`);
  } catch (e) { console.error("[BrainRunner] sampleImages lỗi:", String(e).slice(0, 160)); }

  const escalationReason =
    reply.escalation
    || detectEscalation(incomingText)
    || imageEscalationReason(imageIntent, settings.lowConfidenceThreshold);
  const wouldEscalate = !!escalationReason && settings.humanReviewEnabled;

  // EXACT REPLY: admin yêu cầu Lulu nói Y CHANG câu đã ghim cho tình huống này → dùng đúng câu đó,
  // KHÔNG dùng text AI, KHÔNG escalate (admin đã cho câu chốt). Ảnh vẫn theo luồng ảnh ở trên.
  const aiChunks: LuluChatChunk[] = reply.messageChunks.length > 0
    ? reply.messageChunks
    : (reply.raw ? [{ text: reply.raw, delayMs: 900 }] : [{ text: "(Lulu không trả về nội dung)", delayMs: 900 }]);
  const exactPinned = respOverride?.responseMode === "exact_reply" && (respOverride.editedText ?? "").trim()
    ? (respOverride.editedText as string).trim() : null;
  // EXACT REPLY: chia bong bóng đúng nhịp người thật NHƯNG giữ NGUYÊN chữ admin (không thêm/sửa,
  // bỏ emoji theo cấu hình admin — formatter chỉ tách câu, không đổi từ).
  const exactChunks = exactPinned ? formatLuluHumanChatMessages(exactPinned, { allowEmoji: false }) : [];
  const finalChunks: LuluChatChunk[] = exactPinned
    ? (exactChunks.length ? exactChunks : [{ text: exactPinned, delayMs: 900 }])
    : aiChunks;
  const finalReply = finalChunks.map((c) => c.text);
  const finalEscalated = exactPinned ? false : wouldEscalate;
  const responseMode: SimulateResult["responseMode"] = respOverride?.responseMode ?? null;
  if (exactPinned) console.log(`[SaleBrain] responseMode=exact_reply (nói y chang câu admin, ${finalReply.length} bubble)`);

  const detectedIntent =
    imageIntent?.service_intent
    || (reply.sampleIntents && reply.sampleIntents.length ? reply.sampleIntents[0] : null)
    || (sampleImages[0]?.serviceIntent ?? null);

  return {
    reply: finalReply,
    chunks: finalChunks,
    raw: reply.raw,
    model,
    responseTimeMs,
    replyDelayMs: computeReplyDelayMs(incomingText, settings),
    escalation: exactPinned ? null : reply.escalation,
    learnedName: reply.learnedName,
    escalated: finalEscalated,
    escalationReason: exactPinned ? null : escalationReason,
    holdMessage: finalEscalated ? HOLD_MESSAGE : null,
    botPaused: finalEscalated && settings.autoPauseThreadWhenEscalated,
    detectedIntent,
    priceImages,
    sampleImages,
    sampleLinks,
    sampleNote,
    imageIntent,
    overrideApplied,
    responseMode,
  };
}
