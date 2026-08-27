import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import { capLegacyAdmin } from "../lib/legacy-auth-token";
import { askClaudeForReply, resolveModel, type ClaudeHistoryItem } from "../lib/claude-sale";
import { resolveTestProviderOverride } from "../lib/ai-orchestrator";
import { getSaleContext, getSaleContextInfo, resolvePriceImagesByCodes, wantsNewConcept, getPhotoIdeasBlock } from "../lib/sale-context";
import { classifyCustomerImageFromData, buildImageRoutingBlock } from "../lib/sale-vision";
import { selectSampleImages, extractRecentSampleUrls, SAMPLES_EXHAUSTED_NOTE } from "../lib/sale-samples";
import { getActivePlaybook } from "../lib/sale-playbook";
import { getActiveBrainRules, getActiveImageOverrides } from "../lib/sale-brain-lab";
import { applyImageOverrides } from "../lib/sale-image-overrides";
import { getClaudeSaleSettings, computeReplyDelayMs } from "../lib/sale-settings";
import { getScheduleContext } from "../lib/sale-calendar";
import { getMasterEnabled } from "../lib/sale-master";
import { detectEscalation } from "../lib/sale-lead-flags";
import { HOLD_MESSAGE, imageEscalationReason } from "../lib/sale-human-review";
import { simulateThreadStateFromHistory, buildThreadStateBlock } from "../lib/sale-thread-state";
import { routeSaleAction } from "../lib/sale-workflow";
import { validateSaleReply, type CatalogItem } from "../lib/sale-workflow-validator";
import { detectDateSlot } from "../lib/sale-slots";
import { detectServiceIntentFromText } from "../lib/sale-samples";
import { auditPackages, pkgDiscountCfg, groupDiscountCfg } from "../lib/sale-context";
import { resolveDiscount } from "../lib/pricing-discount";
import { getCommonSaleScript } from "../lib/sale-common-script";

/**
 * KARU / Claude Sale Test — sân test nội bộ cho admin.
 *
 * Dùng ĐÚNG askClaudeForReply() + sale-context.ts như luồng Facebook, NHƯNG:
 *  - KHÔNG gửi tin ra Messenger.
 *  - KHÔNG ghi fb_inbox_messages, KHÔNG tạo/sửa crm_leads, KHÔNG tạo booking.
 *  - Chỉ mô phỏng khách → trả về câu trả lời của Claude để admin xem.
 * Không phụ thuộc CLAUDE_FB_BOT_ENABLED (đây là công cụ test trước khi bật).
 */

const router: IRouter = Router();

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    return false;
  }
  const r = await pool.query(`SELECT role, roles FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
  const u = r.rows[0] as { role?: string; roles?: unknown } | undefined;
  const isAdmin = capLegacyAdmin(
    req.headers.authorization,
    Boolean(u && (u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin")))),
  );
  if (!isAdmin) {
    res.status(403).json({ error: "Chỉ admin được dùng Claude Sale Test" });
    return false;
  }
  return true;
}

// Thông tin để hiển thị: model, số gói context, đã có API key chưa
router.get("/claude-sale-test/info", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY ?? "").trim();
  let packageCount = 0;
  let totalActive = 0;
  try {
    const info = await getSaleContextInfo();
    packageCount = info.packageCount;
    totalActive = info.totalActive;
  } catch { /* để 0 nếu lỗi đọc DB */ }
  const playbookActive = !!(await getActivePlaybook());
  const masterEnabled = await getMasterEnabled();
  res.json({
    model: resolveModel(),
    hasApiKey,
    packageCount,
    totalActive,
    playbookActive,
    // fbBotEnabled = cầu dao tổng (DB) — nguồn duy nhất cho cả Test & Messenger.
    fbBotEnabled: masterEnabled,
    masterEnabled,
  });
});

// Gửi 1 tin khách (mô phỏng) → nhận câu trả lời của Claude
router.post("/claude-sale-test/chat", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;

  const body = req.body as {
    message?: string;
    messages?: Array<{ direction?: string; text?: string }>;
    imageBase64?: string;
    imageMediaType?: string;
    /** Mã gói đã báo giá ở các lượt trước (FE tích lũy từ field quotedCodes của response) — để mô phỏng trí nhớ "ĐÃ BÁO GIÁ". */
    quotedCodes?: string[];
  };
  const message = (body.message ?? "").trim();
  const imageBase64 = (body.imageBase64 ?? "").trim();
  const hasImage = imageBase64.length > 0;
  if (!message && !hasImage) return res.status(400).json({ error: "Thiếu nội dung tin nhắn hoặc ảnh" });

  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    return res.status(400).json({ error: "Chưa cấu hình ANTHROPIC_API_KEY trong .env" });
  }

  // Lịch sử trước đó (admin gửi lên) → chuẩn hóa, rồi nối tin mới ở cuối (incoming)
  const prior: ClaudeHistoryItem[] = Array.isArray(body.messages)
    ? body.messages
        .filter((m) => m && typeof m.text === "string" && m.text.trim())
        .map((m) => ({
          direction: m.direction === "outgoing" ? "outgoing" : "incoming",
          message: String(m.text).trim(),
        }))
    : [];
  const incomingText = message || (hasImage ? "[Khách gửi một hình ảnh]" : "");
  const history: ClaudeHistoryItem[] = [...prior, { direction: "incoming", message: incomingText }];

  const model = resolveModel();
  const startedAt = Date.now();
  try {
    let context = await getSaleContext();
    // "Ý tưởng chụp ảnh" là NGUỒN PHỤ: chỉ nạp khi khách thật sự muốn concept mới/lạ.
    if (wantsNewConcept(message)) {
      const ideas = await getPhotoIdeasBlock();
      if (ideas) context += `\n\n${ideas}`;
    }
    // ẢNH (sân test): AI Vision phân loại → route đúng nguồn dữ liệu, giống luồng Messenger.
    let imageIntent: Awaited<ReturnType<typeof classifyCustomerImageFromData>> | null = null;
    if (hasImage) {
      const convo = prior.filter((h) => !h.message.startsWith("[image:")).slice(-6)
        .map((h) => `${h.direction === "incoming" ? "Khách" : "Em"}: ${h.message}`).join("\n");
      imageIntent = await classifyCustomerImageFromData({
        dataBase64: imageBase64,
        mediaType: body.imageMediaType,
        messageText: message,
        conversationContext: convo,
      });
      context += `\n\n${buildImageRoutingBlock(imageIntent)}`;
      if (imageIntent.service_intent === "new_concept_idea" || imageIntent.should_use_photo_ideas) {
        const ideas = await getPhotoIdeasBlock();
        if (ideas) context += `\n\n${ideas}`;
      }
    }
    // TRÍ NHỚ MÔ PHỎNG (sân test LUÔN bật — không phụ thuộc LULU_STATE_ENABLED, KHÔNG đụng
    // bảng lulu_thread_state thật): replay history qua đúng bộ extractor của luồng Messenger
    // rồi chèn khối "TRẠNG THÁI KHÁCH" y hệt. Admin dùng đây để nghiệm thu trước khi bật prod.
    const simQuotedCodes = Array.isArray(body.quotedCodes)
      ? body.quotedCodes.filter((c): c is string => typeof c === "string").slice(0, 30)
      : [];
    const simState = simulateThreadStateFromHistory(history, { quotedCodes: simQuotedCodes });
    const stateBlock = buildThreadStateBlock(simState);
    if (stateBlock) context += `\n\n${stateBlock}`;

    // DEBUG TRACE (shadow mode): tính từng tầng của pipeline để admin thấy "vì sao Lulu nói
    // câu này" — Router/Validator V1 CHƯA ép câu trả lời (chỉ quan sát), đúng chỉ đạo
    // "State ổn mới bật Router+Validator".
    const stateBefore = simulateThreadStateFromHistory(prior, { quotedCodes: simQuotedCodes });
    const botAskedDateBefore = stateBefore.askedQuestions.some((q) => q.key === "ask_date");
    const extractedSlots = {
      dateSlot: detectDateSlot(incomingText, { botAskedDate: botAskedDateBefore }),
      serviceIntent: incomingText.startsWith("[image:") ? null : detectServiceIntentFromText(incomingText),
    };
    const routerDecision = routeSaleAction({
      customerMessage: incomingText,
      threadState: simState,
      isFirstContact: prior.length === 0,
    });

    const styleGuide = await getActivePlaybook();
    const brainRules = await getActiveBrainRules();
    const settings = await getClaudeSaleSettings();
    let scheduleContext = "";
    if (settings.calendarEnabled) {
      try { scheduleContext = await getScheduleContext(settings.calWindowDays); } catch { /* bỏ qua */ }
    }
    // TEST-ONLY: sân test dùng ShopAIKey nếu bật cờ (LULU_TEST_PROVIDER=shopaikey). undefined = Anthropic như cũ.
    const testOverride = resolveTestProviderOverride();
    const commonScript = await getCommonSaleScript();
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
      brainRules,
      commonScript,
      providerOverride: testOverride,
    });
    const responseTimeMs = Date.now() - startedAt;
    // Ảnh bảng giá nhóm (theo marker <<PRICE_IMAGE: MÃ>> của Claude) → trả objectPath
    // để sân test render INLINE. Đã qua gate ai_image_url + public_for_customer.
    let priceImages: string[] = [];
    let newQuotedCodes: string[] = [];
    try {
      const hits = await resolvePriceImagesByCodes(reply.priceImageCodes ?? []);
      priceImages = hits.map((h) => h.objectPath);
      // Mã gói THẬT SỰ có ảnh bảng giá để hiển thị (giống điều kiện "đến được khách" ở
      // luồng Messenger) — FE cộng dồn vào body.quotedCodes cho lượt sau.
      newQuotedCodes = hits.map((h) => h.code).filter(Boolean);
    } catch { /* không chặn câu trả lời nếu lỗi ảnh */ }

    // ẢNH MẪU THẬT (gallery / cho thuê đồ / ý tưởng) — gửi HÌNH trực tiếp thay vì link.
    // Marker <<SAMPLE>> của Claude hoặc tự suy nhóm từ ảnh/tin khách. [] nếu không có ảnh đúng nhóm.
    let sampleImages: Awaited<ReturnType<typeof selectSampleImages>>["images"] = [];
    let sampleLinks: Awaited<ReturnType<typeof selectSampleImages>>["links"] = [];
    let sampleNote: string | null = null;
    try {
      const contextText = prior
        .filter((h) => !h.message.startsWith("[image:"))
        .slice(-4)
        .map((h) => h.message)
        .join("\n");
      // Tin nhắn gần nhất của bot (để xét khách "đồng ý" sau khi bot mời gửi mẫu).
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
      // ÁP OVERRIDE "ADMIN DẠY" của version đang chạy thật (rỗng → hành vi cũ).
      const activeOverrides = await getActiveImageOverrides();
      const detectedIntentForOverride =
        (reply.sampleIntents && reply.sampleIntents.length ? reply.sampleIntents[0] : null)
        || (imageIntent?.service_intent ?? null);
      const finalSel = applyImageOverrides(sel, activeOverrides, {
        detectedIntent: detectedIntentForOverride,
        messageText: incomingText,
        contextText,
        excludeUrls,
        maxTotal: 4,
      });
      sampleImages = finalSel.images;
      sampleLinks = finalSel.links;
      if (finalSel.exhausted) sampleNote = SAMPLES_EXHAUSTED_NOTE;
    } catch (e) { console.error("[ClaudeSaleTest] sampleImages lỗi:", String(e).slice(0, 160)); }

    // ── DEV MODE: mô phỏng Human Review (KHÔNG ghi DB, KHÔNG pause thread thật) ──
    const escalationReason =
      reply.escalation
      || detectEscalation(incomingText)
      || imageEscalationReason(imageIntent, settings.lowConfidenceThreshold);
    const wouldEscalate = !!escalationReason && settings.humanReviewEnabled;

    // ── VALIDATOR (shadow): chấm câu trả lời THẬT của LLM trên catalog giá thật ──
    // Lỗi dựng catalog → bỏ qua check giá (fail-open, không chặn oan) — bench chỉ hiển thị.
    let validatorResult: ReturnType<typeof validateSaleReply>;
    try {
      let catalog: CatalogItem[] | undefined;
      try {
        const { kept } = await auditPackages();
        catalog = kept.map((r) => {
          const d = resolveDiscount({ basePrice: r.price, pkg: pkgDiscountCfg(r), group: groupDiscountCfg(r) });
          return {
            code: (r.code ?? "").trim().toUpperCase(),
            name: r.pkg_name,
            price: Math.round(Number(r.price)),
            finalPrice: d.discountApplied ? Math.round(Number(d.finalPrice)) : null,
          };
        });
      } catch { catalog = undefined; }
      validatorResult = validateSaleReply({ threadState: simState, decision: routerDecision, reply: reply.raw, catalog });
    } catch {
      validatorResult = { verdict: "PASS" };
    }

    return res.json({
      reply: reply.messages.length > 0 ? reply.messages : reply.raw ? [reply.raw] : ["(Claude không trả về nội dung)"],
      // Bong bóng có nhịp (human chat pacing) — FE render tuần tự theo delayMs.
      chunks: reply.messageChunks.length > 0 ? reply.messageChunks : (reply.raw ? [{ text: reply.raw, delayMs: 900 }] : []),
      raw: reply.raw,
      replyText: reply.raw,
      model,
      // TEST-ONLY: provider + model THỰC TẾ đã trả lời (panel/log biết đang chạy ShopAIKey hay Anthropic).
      provider: testOverride?.label ?? "anthropic",
      aiModelUsed: reply.modelUsed ?? model,
      responseTimeMs,
      // Delay cấu hình theo độ dài tin khách (để sân test mô phỏng đúng tốc độ Fanpage).
      replyDelayMs: computeReplyDelayMs(incomingText, settings),
      // Sân test KHÔNG đụng DB: chỉ hiển thị để admin thấy AI sẽ làm gì.
      escalation: reply.escalation,
      learnedName: reply.learnedName,
      // DEV MODE — Human Review (mô phỏng; test không ghi DB nên humanReviewId luôn null).
      escalated: wouldEscalate,
      escalationReason,
      holdMessage: wouldEscalate ? HOLD_MESSAGE : null,
      botPaused: wouldEscalate && settings.autoPauseThreadWhenEscalated,
      usedPlaybook: !!styleGuide,
      humanReviewId: null,
      // Ảnh bảng giá nhóm để render inline (objectPath /objects/...; FE dùng getImageSrc).
      priceImages,
      // Ảnh mẫu thật (gửi HÌNH trực tiếp) + link xem thêm. DEV MODE hiển thị nguồn ảnh.
      sampleImages,
      sampleLinks,
      // Khách đòi xem thêm nhưng đã hết mẫu mới → câu nhắn khéo (null nếu không rơi vào case này).
      sampleNote,
      // Kết quả AI Vision (DEV MODE) — null nếu khách không gửi ảnh.
      imageIntent,
      // DEBUG TRACE (DEV MODE, shadow): toàn bộ pipeline từng tầng — khi Lulu trả lời sai,
      // nhìn trace biết sai Ở TẦNG NÀO (extractor / state / router / LLM / validator),
      // không sửa prompt theo cảm giác.
      trace: {
        shadowMode: true, // Router/Validator chỉ QUAN SÁT — chưa ép câu trả lời
        message: incomingText,
        extractedSlots,
        stateBefore: {
          dateStatus: stateBefore.slots.date_status ?? "unset",
          serviceIntent: stateBefore.serviceIntent,
          askedQuestions: stateBefore.askedQuestions,
          quotedPackages: stateBefore.quotedPackages.map((p) => p.code),
        },
        // State SAU khi nuốt tin khách, TRƯỚC câu trả lời bot lượt này — hành động bot
        // (câu hỏi ngày / gói vừa báo) chỉ vào state ở lượt kế tiếp (FE cộng dồn quotedCodes).
        stateAfterIncoming: {
          dateStatus: simState.slots.date_status ?? "unset",
          eventDate: simState.slots.event_date ?? null,
          serviceIntent: simState.serviceIntent,
          askedQuestions: simState.askedQuestions,
          quotedPackages: simState.quotedPackages.map((p) => p.code),
        },
        routerDecision,
        knowledgeUsed: routerDecision.knowledgeNeeded,
        validator: validatorResult,
      },
      // TRÍ NHỚ MÔ PHỎNG (DEV MODE): state suy từ history + khối đã chèn vào prompt —
      // admin nghiệm thu hành vi trí nhớ (không hỏi lại ngày, không bung lại bảng giá...).
      threadState: {
        simulated: true,
        slots: simState.slots,
        serviceIntent: simState.serviceIntent,
        askedQuestions: simState.askedQuestions,
        quotedPackages: simState.quotedPackages,
        sentSampleCount: simState.sentAssets.sample_urls?.length ?? 0,
        block: stateBlock || null,
      },
      // Mã gói vừa được báo giá lượt này — FE cộng dồn rồi gửi lại qua body.quotedCodes.
      quotedCodes: newQuotedCodes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ClaudeSaleTest] lỗi gọi Claude:", msg);
    // Không crash — trả lỗi gọn để UI hiển thị
    return res.status(502).json({ error: `Claude lỗi: ${msg.slice(0, 300)}`, model, responseTimeMs: Date.now() - startedAt });
  }
});

export default router;
