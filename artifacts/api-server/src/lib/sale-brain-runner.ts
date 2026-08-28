import { askClaudeForReply, resolveModel, type ClaudeHistoryItem } from "./claude-sale";
import { formatLuluHumanChatMessages, splitExactReplyMessages, type LuluChatChunk } from "./sale-human-chat";
import {
  getSaleContext, resolvePriceImagesByCodes, wantsNewConcept, getPhotoIdeasBlock,
} from "./sale-context";
import { classifyCustomerImageFromData, buildImageRoutingBlock } from "./sale-vision";
import {
  buildWorkflowSampleReply,
  selectSampleImages,
  extractRecentSampleUrls,
  isExplicitSampleRequest,
  SAMPLES_EXHAUSTED_NOTE,
} from "./sale-samples";
import { applyImageOverrides, matchResponseOverride, type ImageOverride } from "./sale-image-overrides";
import { getActivePlaybook } from "./sale-playbook";
import { getClaudeSaleSettings, computeReplyDelayMs } from "./sale-settings";
import { getScheduleContext } from "./sale-calendar";
import { detectEscalation } from "./sale-lead-flags";
import { HOLD_MESSAGE, imageEscalationReason } from "./sale-human-review";
import {
  buildPriceSheetReply,
  buildPackageComparisonReply,
  PRICE_SHEET_SEND_FAILED_MESSAGE,
  resolvePriceSheetRequest,
  type PriceSheetTrace,
} from "./sale-price-sheet";
import { buildSaleWorkflowBlock, evaluateSaleWorkflow, type SaleWorkflowDecision } from "./sale-workflow";
import {
  appendScriptTraceData,
  bindWeddingGateDraftRow,
  preventRawPlaceholderLeak,
  selectSaleScriptResponse,
  type SaleScriptQuestionAnswerSheets,
  type SaleScriptNodeOverrides,
  type LuluResponseTrace,
} from "./sale-script-registry";
import {
  buildWeddingGiftReply,
  buildWeddingGiftPromptBlock,
  evaluateWeddingGiftTrace,
  loadWeddingGiftProgram,
  type WeddingGiftTrace,
} from "./sale-wedding-gifts";

function normalizeDecisionText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

function decisionPackageFromVerifiedSource(message: string, packages: PriceSheetTrace["includedPackages"]) {
  const text = normalizeDecisionText(message);
  const priceMillions = text.match(/\b(1[.,]9|2[.,]9|3[.,]9|4[.,]5|5[.,]9)\b/)?.[1]?.replace(",", ".");
  if (priceMillions) {
    const wanted = Math.round(Number(priceMillions) * 1_000_000);
    return packages.find((pkg) => pkg.finalPrice === wanted || pkg.price === wanted) ?? null;
  }
  if (/\b(photo master|ekip master)\b/.test(text)) {
    return packages.find((pkg) => /master/i.test(`${pkg.name} ${pkg.benefits}`)) ?? null;
  }
  const aliases = ["tiet kiem", "basic", "premium", "luxury"];
  const alias = aliases.find((name) => new RegExp(`\\b${name}\\b`).test(text));
  if (!alias) return null;
  return packages.find((pkg) => normalizeDecisionText(pkg.name).includes(alias)) ?? null;
}

function recommendPackageFromVerifiedSource(
  message: string,
  prior: ClaudeHistoryItem[],
  packages: PriceSheetTrace["includedPackages"],
): { pkg: PriceSheetTrace["includedPackages"][number] | null; reason: string } {
  const sorted = [...packages].sort((a, b) => a.finalPrice - b.finalPrice);
  const context = normalizeDecisionText([...prior.map((item) => item.message), message].join("\n"));
  const details = (pkg: PriceSheetTrace["includedPackages"][number]) => normalizeDecisionText(`${pkg.name} ${pkg.benefits}`);
  const wantsMaster = /\b(photo master|makeup master|ekip master|tho chup.*master|uu tien.*(?:tho chup|makeup|ekip))\b/.test(context);
  if (wantsMaster) {
    const master = sorted.find((pkg) => /master/.test(details(pkg)));
    if (master) return { pkg: master, reason: "đúng ưu tiên ekip Master của mình" };
  }
  const wantsTwoGates = /\b(2|hai)\s*(?:hinh\s+)?cong\b/.test(context);
  const wantsMica = /\bmica\b/.test(context);
  if (wantsTwoGates || wantsMica) {
    const matched = sorted.find((pkg) => (!wantsTwoGates || /\b(2|hai)\s*(?:hinh\s+)?cong\b/.test(details(pkg))) && (!wantsMica || /mica/.test(details(pkg))));
    if (matched) return { pkg: matched, reason: wantsTwoGates && wantsMica ? "đúng nhu cầu 2 cổng mica" : wantsTwoGates ? "đúng nhu cầu 2 cổng" : "đúng phần sản phẩm mica mình ưu tiên" };
  }
  const budgetMatch = context.match(/(?:ngan sach|tam|khoang|toi da|trong muc)\D{0,12}(\d+(?:[.,]\d+)?)\s*(?:trieu|tr)/);
  const budget = budgetMatch ? Math.round(Number(budgetMatch[1].replace(",", ".")) * 1_000_000) : null;
  const oneGate = /\b(1|mot)\s*(?:hinh\s+)?cong\b/.test(context);
  const simpleNeed = /\b(gon|don gian|tiet kiem|khong can nhieu|ngan sach thap)\b/.test(context);
  if (budget) {
    const affordable = sorted.filter((pkg) => pkg.finalPrice <= budget);
    if (affordable.length > 0) {
      const chosen = simpleNeed ? affordable[0] : oneGate && affordable.length > 1 ? affordable[1] : affordable[affordable.length - 1];
      return { pkg: chosen, reason: `vừa ngân sách khoảng ${budgetMatch?.[1]} triệu và không mua dư quyền lợi` };
    }
  }
  if (simpleNeed && sorted[0]) return { pkg: sorted[0], reason: "nhu cầu của mình gọn và ưu tiên tiết kiệm" };
  const lastFocused = [...prior].reverse().map((item) => decisionPackageFromVerifiedSource(item.message, sorted)).find(Boolean) ?? null;
  return lastFocused ? { pkg: lastFocused, reason: "khớp nhất với phần mình vừa cân nhắc" } : { pkg: null, reason: "chưa đủ một tiêu chí để chọn duy nhất" };
}

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

function workflowControlledReply(workflow: SaleWorkflowDecision, sampleStyleMatched?: boolean): string | null {
  if (workflow.reason === "customer_wants_time_to_consider") {
    return "Dạ mình cứ xem kỹ và cân nhắc thoải mái nha. Khi nào cần em so sánh thêm các gói hoặc giữ lịch thì nhắn em ạ.";
  }
  if (workflow.action === "ASK_SERVICE") {
    return "Dạ mình đang cần chụp cổng, album studio, album ngoại cảnh, tiệc cưới, beauty hay dịch vụ khác ạ?";
  }
  if (workflow.action === "ASK_DISCOVERY") {
    const questions: Record<string, string> = {
      style: "mình thích hướng sang trọng, nàng thơ, nhẹ nhàng, tinh tế hay tối giản hơn ạ?",
      location_need: "mình thích cảnh thiên nhiên, Núi Bà Đen, hồ, quán cà phê hay kiến trúc nào tại Tây Ninh ạ?",
      beauty_type: "mình muốn chụp sinh nhật, beauty cá nhân, nàng thơ, ngọt ngào, sexy, sang trọng, cool boy, cổ trang hay chụp bầu ạ?",
      pregnancy_month: "mình đang ở tháng thai kỳ thứ mấy ạ?",
      participants: "mình muốn chụp cá nhân hay cùng gia đình ạ?",
      wedding_date: "mình cho em xin ngày cưới theo ngày dương lịch nha.",
      bride_location: "nhà cô dâu ở khu vực nào ạ?",
      groom_location: "nhà chú rể ở khu vực nào ạ?",
      venue_format: "tiệc mình làm tại nhà hay nhà hàng ạ?",
      table_count: "mình dự kiến khoảng bao nhiêu bàn ạ?",
      use_date: "mình cần dùng vào ngày nào ạ?",
      outfit_type: "mình cần thuê loại trang phục nào ạ?",
      size_need: "mình thường mặc size nào hoặc cần ghé thử đồ không ạ?",
      wedding_kind: "mình đang quan tâm album/prewedding hay chụp ngày cưới, tiệc cưới ạ?",
      album_location_type: "mình muốn chụp album tại studio hay ngoại cảnh ạ?",
      primary_need: "mình cho em xin nhu cầu chính để em tư vấn đúng dịch vụ ạ?",
    };
    const question = workflow.nextSlot ? questions[workflow.nextSlot.key] : null;
    return `Dạ ${question ?? "mình cho em xin thêm nhu cầu để em tư vấn đúng dịch vụ ạ?"}`;
  }
  if (workflow.action === "SEND_SAMPLE") {
    return buildWorkflowSampleReply({
      serviceKey: workflow.serviceKey,
      style: workflow.style,
      styleMatched: sampleStyleMatched,
    });
  }
  if (workflow.action === "ASK_SAMPLE_CONFIRMATION") {
    return "M\u00ecnh th\u1ea5y nh\u1eefng m\u1eabu em v\u1eeba g\u1eedi c\u00f3 h\u1ee3p gu kh\u00f4ng \u1ea1? M\u00ecnh \u01b0ng h\u01b0\u1edbng n\u00e0o th\u00ec em g\u1eedi b\u1ea3ng gi\u00e1 \u0111\u00fang nh\u00f3m \u0111\u1ec3 m\u00ecnh xem ti\u1ebfp nha.";
  }
  return null;
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
  /** Node sửa tay của phiên bản đang test. Chỉ Brain Lab mới nhận bản nháp này. */
  scriptOverrides?: SaleScriptNodeOverrides | null;
  /** Các dòng Khách có thể nói / Lulu trả lời của phiên bản đang test. */
  scriptQuestionAnswerSheets?: SaleScriptQuestionAnswerSheets | null;
};

/** Contract an toàn của Brain Lab. Đây là invariant của runner mô phỏng, không
 * phải số liệu suy đoán từ UI. Runner không import bất kỳ outbound sender hay
 * booking/payment writer nào. */
export const BRAIN_LAB_DRY_RUN_SIDE_EFFECTS = Object.freeze({
  messengerOutbound: 0,
  bookingsCreated: 0,
  paymentsCreated: 0,
  depositsMutated: 0,
  revenueMutated: 0,
});

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
  priceSheetTrace: PriceSheetTrace | null;
  saleWorkflow: SaleWorkflowDecision;
  scriptTrace: LuluResponseTrace;
  weddingGiftTrace: WeddingGiftTrace;
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
  const message = (input.message ?? "").trim();
  const imageBase64 = (input.imageBase64 ?? "").trim();
  const hasImage = imageBase64.length > 0;
  const incomingText = message || (hasImage ? "[Khách gửi một hình ảnh]" : "");
  const prior = input.prior ?? [];
  const workflowBefore = evaluateSaleWorkflow({ message: "", prior });
  let saleWorkflow = evaluateSaleWorkflow({ message: incomingText, prior });
  let scriptTrace = selectSaleScriptResponse({
    message: incomingText,
    workflow: saleWorkflow,
    workflowBefore,
    overrides: input.scriptOverrides ?? undefined,
    questionAnswerSheets: input.scriptQuestionAnswerSheets ?? undefined,
  });
  scriptTrace = bindWeddingGateDraftRow(
    scriptTrace,
    incomingText,
    input.scriptQuestionAnswerSheets ?? undefined,
  );
  const weddingGiftProgram = await loadWeddingGiftProgram();
  const weddingGiftTrace = evaluateWeddingGiftTrace({
    message: incomingText,
    prior,
    currentServiceKey: saleWorkflow.serviceKey,
    program: weddingGiftProgram,
  });
  const history: ClaudeHistoryItem[] = [...prior, { direction: "incoming", message: incomingText }];

  const model = resolveModel();
  const startedAt = Date.now();

  let context = await getSaleContext();
  context += `\n\n${buildSaleWorkflowBlock(saleWorkflow)}`;
  const weddingGiftBlock = buildWeddingGiftPromptBlock(weddingGiftTrace);
  if (weddingGiftBlock) context += `\n\n${weddingGiftBlock}`;
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

  const priceSheet = await resolvePriceSheetRequest({
    message: incomingText,
    prior,
    force: saleWorkflow.action === "SEND_PRICE_SHEET",
    serviceKey: saleWorkflow.serviceKey,
  });
  if (saleWorkflow.action === "SEND_PRICE_SHEET" && priceSheet.requested) {
    let finalReply: string[] = [];
    let quoteChunks: LuluChatChunk[] = [];
    let quoteRaw = "";
    if (priceSheet.needsClarification) {
      finalReply = [priceSheet.clarificationMessage ?? "Mình muốn xem bảng giá dịch vụ nào ạ?"];
    } else if (priceSheet.trace?.validator.passed) {
      finalReply = buildPriceSheetReply(priceSheet, incomingText);
      if (saleWorkflow.reason.startsWith("discovery_question_skipped_provisional_quote:")) {
        finalReply = [
          "Dạ với thông tin mình đang có, em xin phép gửi báo giá tham khảo trước để mình xem nha.",
          ...finalReply,
        ];
      }
    } else {
      finalReply = [PRICE_SHEET_SEND_FAILED_MESSAGE];
    }
    if (finalReply.length === 0) finalReply = [PRICE_SHEET_SEND_FAILED_MESSAGE];
    const priceSnapshot = priceSheet.trace?.includedPackages.map((pkg) => ({
      packageId: pkg.id,
      price: pkg.price,
      finalPrice: pkg.finalPrice,
    })) ?? [];
    scriptTrace = appendScriptTraceData(scriptTrace, {
      renderedText: finalReply.join("\n\n"),
      assetIds: priceSheet.trace?.assetId ? [priceSheet.trace.assetId] : [],
      dataSources: ["service_groups", "service_packages", "service_groups.ai_image_url"],
      priceSnapshot,
      validatorResults: priceSheet.trace
        ? [
          { name: "official_price_asset", passed: !priceSheet.trace.validator.reasons.includes("price_sheet_missing") && !priceSheet.trace.validator.reasons.includes("price_sheet_asset_not_official_storage") },
          { name: "asset_group_matches_service", passed: !priceSheet.trace.validator.reasons.includes("price_sheet_group_mismatch") },
          { name: "public_for_customer", passed: !priceSheet.trace.validator.reasons.includes("price_sheet_not_public") },
          { name: "retail_packages_only", passed: !priceSheet.trace.validator.reasons.includes("no_retail_packages") },
          { name: "image_before_text", passed: priceSheet.trace.validator.passed },
        ]
        : [{ name: "price_resolution", passed: false, detail: "missing_price_trace" }],
      stateAfter: { priceSheetSent: !!priceSheet.trace?.validator.passed, currentStep: 3, pendingQuestion: "gate_count" },
    });
    scriptTrace = preventRawPlaceholderLeak(scriptTrace);
    const chunks = quoteChunks.length === finalReply.length
      ? quoteChunks
      : finalReply.map((text) => ({ text, delayMs: 900 }));
    const escalated = !priceSheet.needsClarification && !priceSheet.trace?.validator.passed && settings.humanReviewEnabled;
    return {
      reply: finalReply,
      chunks,
      raw: quoteRaw || finalReply.join("\n\n"),
      model,
      responseTimeMs: Date.now() - startedAt,
      replyDelayMs: computeReplyDelayMs(incomingText, settings),
      escalation: null,
      learnedName: null,
      escalated,
      escalationReason: escalated ? priceSheet.escalationReason : null,
      holdMessage: escalated ? HOLD_MESSAGE : null,
      botPaused: escalated && settings.autoPauseThreadWhenEscalated,
      detectedIntent: "price_sheet",
      priceImages: priceSheet.trace?.validator.passed && priceSheet.assetUrl ? [priceSheet.assetUrl] : [],
      priceSheetTrace: priceSheet.trace,
      saleWorkflow,
      scriptTrace,
      weddingGiftTrace,
      sampleImages: [],
      sampleLinks: [],
      sampleNote: null,
      imageIntent,
      overrideApplied: false,
      responseMode: null,
    };
  }

  if (scriptTrace.nodeKey === "WEDDING_GATE.COMPARE.PACKAGES") {
    const comparisonData = await resolvePriceSheetRequest({
      message: incomingText,
      prior,
      force: true,
      serviceKey: "wedding_gate",
    });
    const comparisonReply = buildPackageComparisonReply(comparisonData, incomingText, prior);
    scriptTrace = appendScriptTraceData(scriptTrace, {
      renderedText: comparisonReply,
      dataSources: ["service_packages", "conversation_state"],
      priceSnapshot: comparisonData.trace?.includedPackages.map((pkg) => ({
        packageId: pkg.id,
        price: pkg.price,
        finalPrice: pkg.finalPrice,
      })) ?? [],
      stateAfter: { currentStep: 4 },
      validatorResults: [{
        name: "retail_package_comparison_from_verified_db",
        passed: Boolean(comparisonData.trace?.validator.passed),
        detail: comparisonData.trace?.validator.reasons.join(", ") || undefined,
      }],
    });
  }

  if (scriptTrace.nodeKey === "WEDDING_GATE.PROMOTION.CHECK_ELIGIBILITY") {
    const promotionReply = buildWeddingGiftReply({
      message: incomingText,
      trace: weddingGiftTrace,
      program: weddingGiftProgram,
    });
    scriptTrace = appendScriptTraceData(scriptTrace, {
      renderedText: promotionReply,
      dataSources: ["wedding_gift_programs", "wedding_gift_eligible_groups", "conversation_state"],
      stateAfter: { currentStep: 5 },
      validatorResults: [
        { name: "promotion_is_current", passed: weddingGiftTrace.programStatus === "active" },
        { name: "beauty_is_not_eligible", passed: !weddingGiftProgram.eligibleServiceKeys.includes("beauty") },
        { name: "highest_tier_only", passed: weddingGiftProgram.accumulationPolicy === "highest_tier_only" },
      ],
    });
  }

  if (scriptTrace.nodeKey === "WEDDING_GATE.DECISION.RECOMMEND_PACKAGE") {
    const packageSource = await resolvePriceSheetRequest({ message: incomingText, prior, force: true, serviceKey: "wedding_gate" });
    const verifiedPackages = packageSource.trace?.includedPackages ?? [];
    const recommendation = recommendPackageFromVerifiedSource(incomingText, prior, verifiedPackages);
    const reply = recommendation.pkg
      ? `Dạ với nhu cầu mình đã nói thì em nghiêng ${recommendation.pkg.name} nhất nha 😄 Gói này ${recommendation.reason}, nên chưa cần cố lên gói cao hơn. Nếu mình thấy ổn hướng này thì em chuyển qua kiểm tra lịch cho mình nha?`
      : "Dạ em muốn chọn đúng một gói cho mình, nhưng hiện còn thiếu đúng một điểm phân định: mình chắc chắn cần một cổng hay hai cổng ạ? Có câu này em sẽ đề xuất một gói duy nhất, không đọc lại cả bảng giá nha.";
    scriptTrace = appendScriptTraceData(scriptTrace, {
      renderedText: reply,
      dataSources: ["service_packages", "conversation_state"],
      priceSnapshot: recommendation.pkg ? [{ packageId: recommendation.pkg.id, price: recommendation.pkg.price, finalPrice: recommendation.pkg.finalPrice }] : [],
      stateAfter: {
        currentStep: 7,
        recommendedPackageName: recommendation.pkg?.name ?? null,
        recommendationReason: recommendation.reason,
      },
      validatorResults: [
        { name: "one_primary_recommendation", passed: Boolean(recommendation.pkg) },
        { name: "verified_package_data_only", passed: Boolean(packageSource.trace?.validator.passed) },
        { name: "no_booking_creation", passed: true },
        { name: "no_pressure_sale", passed: true },
      ],
    });
  }

  if (scriptTrace.nodeKey === "WEDDING_GATE.DECISION.PACKAGE_SELECTED") {
    const packageSource = await resolvePriceSheetRequest({
      message: incomingText,
      prior,
      force: true,
      serviceKey: "wedding_gate",
    });
    const verifiedPackages = packageSource.trace?.includedPackages ?? [];
    const selectedPackage = decisionPackageFromVerifiedSource(incomingText, verifiedPackages);
    const decision = saleWorkflow.packageDecision;
    let decisionReply = scriptTrace.renderedText;
    if (decision.resolution === "AMBIGUOUS_BENEFIT") {
      const micaMatches = verifiedPackages.filter((pkg) => /2\s*(?:hinh\s+)?cong/i.test(normalizeDecisionText(`${pkg.name} ${pkg.benefits}`)) && /mica/i.test(`${pkg.name} ${pkg.benefits}`));
      if (micaMatches.length === 1) {
        decisionReply = `Dạ em hiểu mình chọn gói có 2 cổng mica nha 👍 Theo bảng đang bán hiện tại là ${micaMatches[0].name}. Em ghi nhận đúng lựa chọn này và chuyển qua phần xác nhận thông tin nha.`;
      }
    } else if (selectedPackage) {
      decisionReply = decision.status === "TENTATIVE"
        ? `Dạ hiện mình đang nghiêng ${selectedPackage.name} nha. Em chưa tạo booking hay giữ lịch vội; khi mình xác nhận chắc thì em tiếp tục đúng gói này ạ.`
        : decision.bookingReady === false
          ? `Dạ em ghi nhận mình đã chọn ${selectedPackage.name} nha. Phần booking em chưa làm vội theo ý mình; khi sẵn sàng em tiếp tục đúng từ gói này ạ.`
          : `Dạ ${selectedPackage.name} nha mình 👍 Em ghi nhận đúng lựa chọn này, không đổi hay đẩy mình lên gói khác. Mình qua phần xác nhận thông tin và kiểm tra lịch nha.`;
    }
    scriptTrace = appendScriptTraceData(scriptTrace, {
      renderedText: decisionReply,
      dataSources: ["service_packages", "conversation_state"],
      priceSnapshot: selectedPackage ? [{ packageId: selectedPackage.id, price: selectedPackage.price, finalPrice: selectedPackage.finalPrice }] : [],
      stateAfter: { selectedPackageName: selectedPackage?.name ?? scriptTrace.stateAfter.selectedPackageName, currentStep: 8 },
      validatorResults: [
        { name: "retail_package_resolution_from_verified_db", passed: decision.resolution === "CONTEXT" || decision.resolution === "SERVICE_ONLY" || decision.resolution === "UNKNOWN_PRICE" || decision.resolution === "AMBIGUOUS_BENEFIT" || Boolean(selectedPackage) },
        { name: "no_booking_creation", passed: true },
        { name: "no_payment_mutation", passed: true },
        { name: "no_deposit_mutation", passed: true },
      ],
    });
  }

  // The rebuilt script path is intentionally deterministic: no Claude prompt may fill a missing node.
  if (scriptTrace.status === "UNMAPPED_RESPONSE") {
    scriptTrace = preventRawPlaceholderLeak(scriptTrace);
    return {
      reply: [scriptTrace.renderedText],
      chunks: [{ text: scriptTrace.renderedText, delayMs: 900 }],
      raw: scriptTrace.renderedText,
      model,
      responseTimeMs: Date.now() - startedAt,
      replyDelayMs: computeReplyDelayMs(incomingText, settings),
      escalation: "UNMAPPED_RESPONSE",
      learnedName: null,
      escalated: true,
      escalationReason: "UNMAPPED_RESPONSE",
      holdMessage: HOLD_MESSAGE,
      botPaused: false,
      detectedIntent: saleWorkflow.serviceKey,
      priceImages: [],
      priceSheetTrace: null,
      saleWorkflow,
      scriptTrace,
      weddingGiftTrace,
      sampleImages: [],
      sampleLinks: [],
      sampleNote: "Không có node kịch bản phù hợp; Lulu không tự tạo câu trả lời.",
      imageIntent,
      overrideApplied: false,
      responseMode: null,
    };
  }

  if (scriptTrace.scriptKey === "SALE_WEDDING_GATE" || scriptTrace.scriptKey === "SALE_COMMON") {
    let sampleImages: SimulateResult["sampleImages"] = [];
    let sampleLinks: SimulateResult["sampleLinks"] = [];
    let sampleNote: string | null = null;
    if (scriptTrace.nodeKey === "WEDDING_GATE.SAMPLE.SEND_MATCHED") {
      const contextText = prior.filter((h) => !h.message.startsWith("[image:")).slice(-4).map((h) => h.message).join("\n");
      const lastBotText = [...prior].reverse().find((h) => h.direction === "outgoing")?.message ?? null;
      const selected = await selectSampleImages({
        sampleRequested: true,
        sampleIntents: ["wedding_gate"],
        intentLocked: true,
        messageText: [incomingText, ...saleWorkflow.filledSlots.map((slot) => slot.value ?? "")].join("\n"),
        contextText,
        lastBotText,
        visionIntent: imageIntent,
        settings,
        excludeUrls: extractRecentSampleUrls(prior),
        maxTotal: 2,
      });
      sampleImages = selected.images.filter((image) => isPlausibleImageUrl(image.imageUrl));
      sampleLinks = selected.links;
      if (sampleImages.length === 0) {
        sampleNote = "Không tìm được ảnh mẫu chụp cổng hợp lệ để gửi; đã chặn trả lời tự do và cần nhân viên kiểm tra kho ảnh.";
        scriptTrace = appendScriptTraceData(scriptTrace, {
          validatorResults: [
            { name: "service_key_is_wedding_gate", passed: true },
            { name: "sample_asset_not_previously_sent", passed: true },
            { name: "sample_asset_available", passed: false },
          ],
        });
      } else {
        saleWorkflow = { ...saleWorkflow, sampleSent: true, sampleAsset: sampleImages[0].imageUrl };
        scriptTrace = appendScriptTraceData(scriptTrace, {
          assetIds: sampleImages.map((image) => image.imageUrl),
          dataSources: ["image_store:wedding_gate", "conversation_state.sent_assets"],
          stateAfter: { sampleSent: true, currentStep: 2 },
          validatorResults: [
            { name: "service_key_is_wedding_gate", passed: true },
            { name: "sample_asset_not_previously_sent", passed: true },
            { name: "not_price_request", passed: true },
          ],
        });
      }
    }
    const deterministicHandoff = scriptTrace.stateAfter.humanHandoff;
    const deterministicEscalationReason = deterministicHandoff
      ? `sale_script_handoff:${scriptTrace.nodeKey}`
      : null;
    scriptTrace = preventRawPlaceholderLeak(scriptTrace);
    return {
      reply: [scriptTrace.renderedText],
      chunks: [{ text: scriptTrace.renderedText, delayMs: 900 }],
      raw: scriptTrace.renderedText,
      model,
      responseTimeMs: Date.now() - startedAt,
      replyDelayMs: computeReplyDelayMs(incomingText, settings),
      escalation: deterministicEscalationReason ?? (sampleImages.length === 0 && scriptTrace.nodeKey === "WEDDING_GATE.SAMPLE.SEND_MATCHED" ? "sample_asset_unavailable" : null),
      learnedName: null,
      escalated: deterministicHandoff,
      escalationReason: deterministicEscalationReason,
      holdMessage: deterministicHandoff ? HOLD_MESSAGE : null,
      botPaused: deterministicHandoff,
      detectedIntent: saleWorkflow.serviceKey,
      priceImages: [],
      priceSheetTrace: null,
      saleWorkflow,
      scriptTrace,
      weddingGiftTrace,
      sampleImages,
      sampleLinks,
      sampleNote,
      imageIntent,
      overrideApplied: false,
      responseMode: null,
    };
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

  const reply = await askClaudeForReply({
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
  let sampleUnavailableReason: string | null = null;
  let overrideApplied = false;
  let sampleStyleMatched: boolean | undefined;
  try {
    const contextText = prior.filter((h) => !h.message.startsWith("[image:")).slice(-4)
      .map((h) => h.message).join("\n");
    const lastBotText = [...prior].reverse().find((h) => h.direction === "outgoing")?.message ?? null;
    const excludeUrls = extractRecentSampleUrls(prior);
    const workflowLocksSampleIntent = !!saleWorkflow.serviceKey && (
      saleWorkflow.action === "SEND_SAMPLE"
      || (saleWorkflow.sampleRequired && isExplicitSampleRequest(incomingText))
    );
    const sampleSelectionText = saleWorkflow.action === "SEND_SAMPLE"
      ? [incomingText, ...saleWorkflow.filledSlots.map((slot) => slot.value ?? "")].join("\n")
      : incomingText;
    const sel = await selectSampleImages({
      sampleRequested: saleWorkflow.action === "SEND_SAMPLE" || (!saleWorkflow.sampleRequired && reply.sampleRequested),
      sampleIntents: workflowLocksSampleIntent && saleWorkflow.serviceKey
        ? [saleWorkflow.serviceKey]
        : reply.sampleIntents,
      intentLocked: workflowLocksSampleIntent,
      messageText: sampleSelectionText,
      contextText,
      lastBotText,
      visionIntent: imageIntent,
      settings,
      excludeUrls,
      maxTotal: 2,
    });
    sampleStyleMatched = sel.styleMatched;
    // ÁP OVERRIDE "ADMIN DẠY": nếu khớp (intent + tone/gu) → thay ảnh mẫu bằng ảnh admin chọn.
    const overrides = input.imageOverrides ?? [];
    const detectedIntentForOverride =
      workflowLocksSampleIntent && saleWorkflow.serviceKey
        ? saleWorkflow.serviceKey
        : (reply.sampleIntents && reply.sampleIntents.length ? reply.sampleIntents[0] : null)
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
    if (sampleImages.length > 0 && saleWorkflow.action === "SEND_SAMPLE") {
      saleWorkflow = { ...saleWorkflow, sampleSent: true, sampleAsset: sampleImages[0].imageUrl };
    }
    overrideApplied = applied.overrideApplied && sampleImages.length > 0;
    if (applied.exhausted) sampleNote = SAMPLES_EXHAUSTED_NOTE;
    if ((isExplicitSampleRequest(incomingText) || saleWorkflow.action === "SEND_SAMPLE") && sampleImages.length === 0 && !applied.exhausted) {
      sampleUnavailableReason = "Khách xin xem mẫu nhưng hệ thống không tìm được ảnh đúng nhóm";
      sampleNote = "Hiện em chưa tìm được ảnh mẫu đúng nhóm để gửi ngay. Em chuyển nhân viên lọc đúng mẫu cho mình nha.";
    }
    if (overrideApplied) console.log(`[SaleBrain] image override applied id=${applied.overrideId} count=${sampleImages.length}`);
  } catch (e) { console.error("[BrainRunner] sampleImages lỗi:", String(e).slice(0, 160)); }

  const escalationReason =
    reply.escalation
    || detectEscalation(incomingText)
    || imageEscalationReason(imageIntent, settings.lowConfidenceThreshold)
    || sampleUnavailableReason;
  const wouldEscalate = !!escalationReason && settings.humanReviewEnabled;

  // EXACT REPLY: admin yêu cầu Lulu nói Y CHANG câu đã ghim cho tình huống này → dùng đúng câu đó,
  // KHÔNG dùng text AI, KHÔNG escalate (admin đã cho câu chốt). Ảnh vẫn theo luồng ảnh ở trên.
  const controlledWorkflowReply = workflowControlledReply(saleWorkflow, sampleStyleMatched);
  const aiChunks: LuluChatChunk[] = reply.messageChunks.length > 0
    ? reply.messageChunks
    : (reply.raw ? [{ text: reply.raw, delayMs: 900 }] : [{ text: "(Lulu không trả về nội dung)", delayMs: 900 }]);
  // GIỮ NGUYÊN câu admin gõ (KHÔNG .trim() để khỏi mất xuống dòng/đoạn) — chỉ cần có nội dung.
  const exactPinned = respOverride?.responseMode === "exact_reply" && (respOverride.editedText ?? "").trim()
    ? (respOverride.editedText as string) : null;
  // EXACT REPLY ("nói y chang"): tách bong bóng THEO ĐOẠN (dòng trống), GIỮ NGUYÊN xuống dòng +
  // chữ + emoji admin gõ. KHÔNG tách theo câu, KHÔNG gộp một dòng (xem splitExactReplyMessages).
  const exactChunks = exactPinned ? splitExactReplyMessages(exactPinned) : [];
  const finalChunks: LuluChatChunk[] = controlledWorkflowReply
    ? [{ text: controlledWorkflowReply, delayMs: 900 }]
    : exactPinned
    ? (exactChunks.length ? exactChunks : [{ text: exactPinned.trim(), delayMs: 900 }])
    : aiChunks;
  const finalReply = finalChunks.map((c) => c.text);
  const finalEscalated = controlledWorkflowReply || exactPinned ? false : wouldEscalate;
  const responseMode: SimulateResult["responseMode"] = respOverride?.responseMode ?? null;
  if (exactPinned) console.log(`[SaleBrain] responseMode=exact_reply (nói y chang câu admin, ${finalReply.length} bubble)`);

  const detectedIntent =
    imageIntent?.service_intent
    || (reply.sampleIntents && reply.sampleIntents.length ? reply.sampleIntents[0] : null)
    || (sampleImages[0]?.serviceIntent ?? null)
    || saleWorkflow.serviceKey;

  return {
    reply: finalReply,
    chunks: finalChunks,
    raw: reply.raw,
    model,
    responseTimeMs,
    replyDelayMs: computeReplyDelayMs(incomingText, settings),
    escalation: controlledWorkflowReply || exactPinned ? null : reply.escalation,
    learnedName: reply.learnedName,
    escalated: finalEscalated,
    escalationReason: controlledWorkflowReply || exactPinned ? null : escalationReason,
    holdMessage: finalEscalated ? HOLD_MESSAGE : null,
    botPaused: finalEscalated && settings.autoPauseThreadWhenEscalated,
    detectedIntent,
    priceImages,
    priceSheetTrace: null,
    saleWorkflow,
    scriptTrace,
    weddingGiftTrace,
    sampleImages,
    sampleLinks,
    sampleNote,
    imageIntent,
    overrideApplied,
    responseMode,
  };
}
