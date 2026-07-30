import { askClaudeForReply, resolveModel, type ClaudeHistoryItem } from "./claude-sale";
import { type ClaudeProviderOverride } from "./ai-orchestrator";
import { formatLuluHumanChatMessages, splitExactReplyMessages, type LuluChatChunk } from "./sale-human-chat";
import {
  getSaleContext, resolvePriceImagesByCodes, wantsNewConcept, getPhotoIdeasBlock,
  auditPackages, pkgDiscountCfg, groupDiscountCfg,
} from "./sale-context";
import { resolveDiscount } from "./pricing-discount";
import { simulateThreadStateFromHistory, buildThreadStateBlock, type ThreadState } from "./sale-thread-state";
import { loadActiveScenarioDefs } from "./sale-scenario-store";
import { resolveScenario, buildScenarioGuidanceBlock, type ScenarioResolveResult } from "./sale-scenario-resolver";
import { getGoldenExamples, buildGoldenExamplesBlock, type GoldenExample } from "./sale-script-library";
import { resolveGroupNameForService } from "./sale-service-map";
import { slugifyGroup } from "./sale-scenario-steps";
import { getServicePricePreview } from "./sale-pricing";
import { validateSaleReply, extractMoneyVnd, type CatalogItem } from "./sale-workflow-validator";
import { finalizeSaleReply, type PipelineValidator, type PipelineFacts } from "./sale-pipeline";
import { formatVnd } from "./sale-reply-stitch";
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
  /** TEST-ONLY: override provider Claude (ShopAIKey) cho Brain Lab. undefined = Anthropic như cũ. */
  providerOverride?: ClaudeProviderOverride;
  /** Nhãn version não đang test (hiện trong trace) — vd "nháp #12" / "đang chạy thật". */
  brainVersionLabel?: string;
};

/** Cờ pipeline structured (mandate "nối dây điện"): state + scenario + golden + validator trong Brain Lab test. */
export function isBrainStructuredEnabled(): boolean {
  return (process.env.LULU_BRAIN_STRUCTURED_ENABLED ?? "").trim() === "1";
}

/** Trace X-quang 1 lượt pipeline — additive, FE cũ bỏ qua field này vẫn chạy. */
export type PipelineTrace = {
  structured: boolean;
  service: string | null;          // serviceIntent từ state
  serviceGroup: string | null;     // tên nhóm bảng giá đã map
  stage: string;
  scenarioWinner: string | null;
  scenarioName: string | null;
  action: string;
  goldenCount: number;
  crmPriceText: string | null;     // giá gói đại diện realtime (nguồn Dịch vụ & Bảng giá)
  priceSource: string;             // luôn "Dịch vụ & Bảng giá"
  brainVersion: string;
  provider: string;
  fallbackUsed: "none" | "stitched" | "safe";
  regenerated: boolean;
  validator: PipelineValidator;
  /** Lý do lần chặn cuối trước khi rơi fallback (null = không bị chặn). */
  blockedReason: string | null;
  stateBefore: unknown;
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
  /** X-quang pipeline (chỉ khi LULU_BRAIN_STRUCTURED_ENABLED=1) — FE cũ bỏ qua vẫn chạy. */
  trace?: PipelineTrace | null;
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
  // Có ÍT NHẤT 1 provider LLM khả dụng? (Anthropic / ShopAIKey override / cổng OpenAI fallback)
  const hasLlm = !!apiKey || !!input.providerOverride
    || !!(process.env.OPENAI_API_KEY ?? "").trim()
    || !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? "").trim();
  const structured = isBrainStructuredEnabled();
  // Structured mode chạy được KHÔNG cần LLM (stitched fallback deterministic);
  // legacy mode giữ gate cũ nhưng nhận cả ShopAIKey (fix bug: trước chỉ nhìn ANTHROPIC).
  if (!hasLlm && !structured) throw new Error("Chưa cấu hình AI key (ANTHROPIC_API_KEY hoặc ShopAIKey) trong .env");

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
  const respOverride = matchResponseOverride(incomingText, priorContextText, input.imageOverrides ?? [], { hasImage });
  if (respOverride?.responseMode === "learn_from_this" && respOverride.editedText) {
    context += `\n\nGỢI Ý CÂU TRẢ LỜI (admin đã duyệt cho tình huống tương tự — BÁM SÁT ý chính & giọng của câu mẫu, được viết lại cho tự nhiên hơn nhưng KHÔNG đổi ý chính):\n"""\n${respOverride.editedText.trim()}\n"""`;
    console.log("[SaleBrain] responseMode=learn_from_this (chèn câu mẫu admin vào prompt)");
  }

  // ── PIPELINE STRUCTURED (cờ LULU_BRAIN_STRUCTURED_ENABLED) — "nối dây điện" ──
  // State → Scenario (đúng dịch vụ) → Golden service-first → Facts CRM realtime →
  // rồi mới tới LLM; validator + fallback ở tầng finalize bên dưới. Fail-open toàn khối.
  type PipelineCtx = {
    state: ThreadState; resolve: ScenarioResolveResult; golden: GoldenExample[];
    facts: PipelineFacts; catalog?: CatalogItem[]; groupName: string | null; crmPriceText: string | null;
  };
  let pipeline: PipelineCtx | null = null;
  if (structured) {
    try {
      const state = simulateThreadStateFromHistory(history);
      const defs = await loadActiveScenarioDefs();
      const resolve = resolveScenario({
        customerMessage: incomingText, threadState: state,
        isFirstContact: prior.length === 0, scenarios: defs,
      });
      const stateBlock = buildThreadStateBlock(state);
      if (stateBlock) context += `\n\n${stateBlock}`;
      const guidanceBlock = buildScenarioGuidanceBlock(resolve);
      if (guidanceBlock) context += `\n\n${guidanceBlock}`;
      let serviceSlug: string | null = null;
      let groupName: string | null = null;
      if (state.serviceIntent) {
        try {
          groupName = await resolveGroupNameForService(state.serviceIntent);
          if (groupName) serviceSlug = slugifyGroup(groupName);
        } catch { /* fail-soft */ }
      }
      const golden = await getGoldenExamples(resolve.winner?.key ?? null, incomingText, 4, serviceSlug);
      const goldenBlock = buildGoldenExamplesBlock(golden);
      if (goldenBlock) context += `\n\n${goldenBlock}`;
      let facts: PipelineFacts = { crmPriceVnd: null, promoActive: false };
      let crmPriceText: string | null = null;
      if (state.serviceIntent) {
        try {
          const groups = await getServicePricePreview(state.serviceIntent);
          const pkgs = groups.flatMap((g) => g.packages);
          if (pkgs.length > 0) {
            const rep = pkgs[0];
            const promoPkg = pkgs.find((p) => p.promoActive);
            facts = {
              crmPriceVnd: rep.effectivePrice, promoActive: pkgs.some((p) => p.promoActive),
              packageName: rep.name || null, packageContent: rep.description || null,
              promotion: promoPkg
                ? `${promoPkg.promoName || "đang có ưu đãi"}${promoPkg.savedAmount ? ` (tiết kiệm ${formatVnd(promoPkg.savedAmount)})` : ""}`
                : null,
            };
            crmPriceText = formatVnd(rep.effectivePrice);
          }
        } catch { /* fail-soft */ }
      }
      let catalog: CatalogItem[] | undefined;
      try {
        const { kept } = await auditPackages();
        catalog = kept.map((r) => {
          const d = resolveDiscount({ basePrice: r.price, pkg: pkgDiscountCfg(r), group: groupDiscountCfg(r) });
          return {
            code: (r.code ?? "").trim().toUpperCase(), name: r.pkg_name,
            price: Math.round(Number(r.price)),
            finalPrice: d.discountApplied ? Math.round(Number(d.finalPrice)) : null,
          };
        });
      } catch { catalog = undefined; }
      pipeline = { state, resolve, golden, facts, catalog, groupName, crmPriceText };
    } catch (e) {
      console.error("[BrainRunner] structured enrich lỗi (fail-open về legacy):", String(e).slice(0, 160));
      pipeline = null;
    }
  }

  const providerLabel = input.providerOverride?.label ?? (apiKey ? "anthropic" : "openai");
  let reply: Awaited<ReturnType<typeof askClaudeForReply>> | null = null;
  let fin: Awaited<ReturnType<typeof finalizeSaleReply>> | null = null;

  if (pipeline) {
    const p = pipeline;
    // Số tiền nằm TRONG FACT CRM (mô tả gói có phụ thu "+200.000đ", text ưu đãi…) là dữ liệu
    // THẬT từ Bảng giá → hợp lệ. Thêm vào catalog để validator không chặn oan câu nói đúng FACT.
    const factAmounts = [
      ...(p.facts.crmPriceVnd != null ? [p.facts.crmPriceVnd] : []),
      ...extractMoneyVnd(p.facts.packageContent ?? ""),
      ...extractMoneyVnd(p.facts.promotion ?? ""),
    ];
    const factCatalog: CatalogItem[] = factAmounts.map((v, i) => ({ code: `FACT-${i}`, name: "CRM fact", price: v, finalPrice: null }));
    // Đoạn FACT CRM chèn verbatim (nội dung gói/ưu đãi của CHÍNH dịch vụ đang khoá) không được
    // tính là "trôi dịch vụ"/từ khoá lạ — gột bỏ trước khi validator soi (số tiền đã có factCatalog).
    // Match linh hoạt khoảng trắng: stitch có chuẩn hoá space nên KHÔNG thể split verbatim.
    const factTexts = [p.facts.packageContent, p.facts.promotion].filter((s): s is string => !!s && s.length >= 12);
    const flexPattern = (s: string) => s.trim().split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s]+");
    const scrubFacts = (r: string) => factTexts.reduce((acc, s) => {
      try { return acc.replace(new RegExp(flexPattern(s), "g"), " (thông tin gói theo bảng giá) "); }
      catch { return acc; }
    }, r);
    const validate = (r: string): PipelineValidator => {
      try {
        return validateSaleReply({
          threadState: p.state, decision: p.resolve.decision, reply: scrubFacts(r),
          catalog: [...(p.catalog ?? []), ...factCatalog],
          catalogAuthoritative: true, promoActive: p.facts.promoActive,
        }) as PipelineValidator;
      } catch { return { verdict: "PASS" }; }
    };
    const callLlm = hasLlm
      ? async (regenFeedback: string | null) => {
          const ctx = regenFeedback
            ? `${context}\n\nLƯU Ý TÁI SINH — câu trước bị lớp an toàn chặn (${regenFeedback}). Viết lại câu trả lời tuân thủ ĐÚNG bảng giá CRM và luật an toàn, không tự giảm giá/bịa ưu đãi.`
            : context;
          const r = await askClaudeForReply({
            apiKey, model, customerMessage: incomingText, customerName: "Khách test", history,
            context: ctx, styleGuide, settings, scheduleContext,
            brainRules: input.brainRules ?? null, providerOverride: input.providerOverride,
          });
          reply = r;
          return { text: r.raw || null, provider: providerLabel, error: !r.raw ? "AI không trả nội dung" : null };
        }
      : null;
    fin = await finalizeSaleReply({ callLlm, golden: p.golden, facts: p.facts, validate });
    // Fallback (stitched/safe) → text KHÔNG phải của LLM: bỏ marker/ảnh của bản reply bị chặn.
    if (fin.fallbackUsed !== "none") reply = null;
  } else {
    reply = await askClaudeForReply({
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
      providerOverride: input.providerOverride,
    });
  }
  const responseTimeMs = Date.now() - startedAt;

  let priceImages: string[] = [];
  try {
    const hits = await resolvePriceImagesByCodes(reply?.priceImageCodes ?? []);
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
      sampleRequested: reply?.sampleRequested ?? false,
      sampleIntents: reply?.sampleIntents ?? [],
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
      (reply?.sampleIntents && reply.sampleIntents.length ? reply.sampleIntents[0] : null)
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
    reply?.escalation
    || detectEscalation(incomingText)
    || imageEscalationReason(imageIntent, settings.lowConfidenceThreshold)
    || (fin?.needsHuman ? "pipeline_an_toan_chuyen_nguoi" : null);
  const wouldEscalate = !!escalationReason && settings.humanReviewEnabled;

  // EXACT REPLY: admin yêu cầu Lulu nói Y CHANG câu đã ghim cho tình huống này → dùng đúng câu đó,
  // KHÔNG dùng text AI, KHÔNG escalate (admin đã cho câu chốt). Ảnh vẫn theo luồng ảnh ở trên.
  // Pipeline fallback (stitched/safe): text từ finalize — tách bubble theo đoạn.
  const finText = fin && fin.fallbackUsed !== "none" ? (fin.replyText ?? "") : null;
  const aiChunks: LuluChatChunk[] = finText
    ? (splitExactReplyMessages(finText).length
        ? splitExactReplyMessages(finText)
        : [{ text: finText, delayMs: 900 }])
    : (reply && reply.messageChunks.length > 0
        ? reply.messageChunks
        : (reply?.raw ? [{ text: reply.raw, delayMs: 900 }] : [{ text: "(Lulu không trả về nội dung)", delayMs: 900 }]));
  // GIỮ NGUYÊN câu admin gõ (KHÔNG .trim() để khỏi mất xuống dòng/đoạn) — chỉ cần có nội dung.
  const exactPinned = respOverride?.responseMode === "exact_reply" && (respOverride.editedText ?? "").trim()
    ? (respOverride.editedText as string) : null;
  // EXACT REPLY ("nói y chang"): tách bong bóng THEO ĐOẠN (dòng trống), GIỮ NGUYÊN xuống dòng +
  // chữ + emoji admin gõ. KHÔNG tách theo câu, KHÔNG gộp một dòng (xem splitExactReplyMessages).
  const exactChunks = exactPinned ? splitExactReplyMessages(exactPinned) : [];
  const finalChunks: LuluChatChunk[] = exactPinned
    ? (exactChunks.length ? exactChunks : [{ text: exactPinned.trim(), delayMs: 900 }])
    : aiChunks;
  const finalReply = finalChunks.map((c) => c.text);
  const finalEscalated = exactPinned ? false : wouldEscalate;
  const responseMode: SimulateResult["responseMode"] = respOverride?.responseMode ?? null;
  if (exactPinned) console.log(`[SaleBrain] responseMode=exact_reply (nói y chang câu admin, ${finalReply.length} bubble)`);

  const detectedIntent =
    imageIntent?.service_intent
    || (reply?.sampleIntents && reply.sampleIntents.length ? reply.sampleIntents[0] : null)
    || (sampleImages[0]?.serviceIntent ?? null);

  // X-quang pipeline — chỉ khi structured chạy được (fail-open → null, FE cũ bỏ qua).
  const trace: PipelineTrace | null = pipeline && fin ? {
    structured: true,
    service: pipeline.state.serviceIntent ?? null,
    serviceGroup: pipeline.groupName,
    stage: pipeline.resolve.decision.stage,
    scenarioWinner: pipeline.resolve.winner?.key ?? null,
    scenarioName: pipeline.resolve.winner?.name ?? null,
    action: pipeline.resolve.decision.action,
    goldenCount: pipeline.golden.length,
    crmPriceText: pipeline.crmPriceText,
    priceSource: "Dịch vụ & Bảng giá",
    brainVersion: input.brainVersionLabel ?? "đang chạy thật",
    provider: fin.provider,
    fallbackUsed: fin.fallbackUsed,
    regenerated: fin.regenerated,
    validator: fin.validator,
    blockedReason: fin.blockedReason,
    stateBefore: pipeline.state,
  } : null;

  return {
    reply: finalReply,
    chunks: finalChunks,
    raw: finText ?? reply?.raw ?? "",
    model,
    responseTimeMs,
    replyDelayMs: computeReplyDelayMs(incomingText, settings),
    escalation: exactPinned ? null : (reply?.escalation ?? null),
    learnedName: reply?.learnedName ?? null,
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
    trace,
  };
}
