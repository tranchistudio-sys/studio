import type { ThreadState } from "./sale-thread-state";
import {
  routeSaleAction, enforcePlaybook, detectMessageSignals, SALE_PLAYBOOK_V1,
  type RouterDecision, type SaleAction, type MessageSignals,
} from "./sale-workflow";
import {
  type ScenarioDef, type TriggerKey, type KnowledgeKey,
  FORBIDDEN_EFFECTS, knowledgeKeysToNeeded,
} from "./sale-scenario-types";
// Trigger V2 (12 loại khách chưa chốt) — detector thuần từ sale-slots-extra.
import {
  detectPostpone, detectBrowsing, detectTrustConcern, detectDiscountRequest,
  detectBudgetConcern, detectObjection, detectStyle, UNKNOWN_VALID,
} from "./sale-slots-extra";

/**
 * SCENARIO RESOLVER — chọn ĐÚNG 1 thẻ kịch bản cho tin khách, đặt TRÊN Workflow V1.
 *
 * NGUYÊN TẮC (chốt với chủ studio):
 *  1. Core Guard (Workflow V1) chạy TRƯỚC và luôn thắng: escalation tiền/cọc/gặp người,
 *     cấm hỏi lại ngày, WAIT an toàn — thẻ KHÔNG bao giờ nới lỏng được.
 *  2. Thẻ chỉ được: chọn action trong giới hạn playbook, THÊM cấm, THÊM kiến thức,
 *     THÊM lời dẫn/câu kết. Không bớt cấm, không chặn ESCALATE_HUMAN, không đè WAIT.
 *  3. Deterministic: lọc bật → trigger → điều kiện → dữ liệu bắt buộc → ưu tiên (kéo thả)
 *     → độ cụ thể → scenario_key. Chỉ 1 thẻ thắng; thẻ thua có lý do trong trace.
 *  4. FAIL-OPEN: không thẻ nào khớp / danh sách rỗng / lỗi → dùng nguyên quyết định
 *     Workflow V1 (Messenger không bao giờ đứng vì tầng scenario).
 *
 * Module THUẦN (không DB/AI/IO) — caller tự nạp ScenarioDef từ store.
 */

export type LoserReason =
  | "dang_tat"              // thẻ đang tắt
  | "trigger_khong_khop"    // KHI KHÁCH... không khớp tin này
  | "dieu_kien_khong_khop"  // điều kiện trạng thái không đúng
  | "thieu_du_lieu"         // thiếu dữ liệu bắt buộc (nhóm dịch vụ / ngày)
  | "uu_tien_thap_hon";     // khớp nhưng thua thẻ ưu tiên cao hơn

export const LOSER_REASON_LABELS: Record<LoserReason, string> = {
  dang_tat: "thẻ đang tắt",
  trigger_khong_khop: "tình huống 'KHI KHÁCH…' không khớp tin này",
  dieu_kien_khong_khop: "điều kiện trạng thái không đúng",
  thieu_du_lieu: "thiếu dữ liệu bắt buộc (nhóm dịch vụ / ngày)",
  uu_tien_thap_hon: "khớp nhưng thua thẻ ưu tiên cao hơn",
};

export type ScenarioLoser = { key: string; name: string; reason: LoserReason; detail?: string };

export type ScenarioResolveInput = {
  customerMessage: string;
  threadState: ThreadState;
  isFirstContact: boolean;
  scenarios: ScenarioDef[];
};

export type ScenarioResolveResult = {
  /** Quyết định CUỐI (baseline Workflow V1 + overlay thẻ thắng, đã qua enforcePlaybook). */
  decision: RouterDecision;
  /** Quyết định GỐC của Workflow V1 (để so sánh / shadow). */
  baseline: RouterDecision;
  winner: ScenarioDef | null;
  losers: ScenarioLoser[];
  /** true nếu thẻ thật sự đổi action/cấm so với baseline (không chỉ thêm lời dẫn). */
  actionChanged: boolean;
  /** Lời dẫn + câu kết của thẻ thắng (đưa vào prompt như HƯỚNG DẪN). */
  guidance: string | null;
  closingLine: string | null;
  knowledge: KnowledgeKey[];
  source: "scenario" | "engine_fallback";
  /** Diễn giải VN ngắn cho trace ("vì sao chọn thẻ này"). */
  explain: string;
};

// ─── Trigger match ────────────────────────────────────────────────────────────

function triggerMatches(trigger: TriggerKey, s: MessageSignals, msg: string): boolean {
  switch (trigger) {
    // Tôn trọng THỨ TỰ ƯU TIÊN của engine (routeSaleAction): câu FAQ ("khi nào cho hình",
    // "gồm gì") được xử lý TRƯỚC giá/mẫu — nên trigger giá/mẫu KHÔNG nổ khi tin là câu FAQ.
    case "hoi_gia": return s.priceQuestion && !s.faqTopic;
    case "xin_bang_gia": return s.wantPricelist && !s.faqTopic;
    case "xin_xem_mau": return s.wantSample && !s.faqTopic;
    case "chao_hoi": return s.greetingOnly;
    case "tin_cut": return s.shortAckOrPresence;
    case "hoi_chi_tiet_goi": return s.faqTopic === "faq:package_detail";
    case "hoi_dia_chi_gio": return s.faqTopic === "faq:address" || s.faqTopic === "faq:hours";
    case "hoi_coc_thanh_toan": return s.faqTopic === "faq:payment";
    case "doi_gap_nguoi": return s.wantHuman || /gặp người|nhân viên/.test(s.escalation ?? "");
    case "cho_sdt": return s.hasPhone;
    case "muon_giu_lich": return s.bookingIntent || /chuyển khoản|đặt cọc/.test(s.escalation ?? "");
    case "chot_goi": return s.closeDeal;
    case "che_gia_xin_giam": return /giảm giá|so sánh|than mắc/.test(s.escalation ?? "");
    // ── V2: 12 loại khách chưa chốt (detector thuần sale-slots-extra, nhận raw message) ──
    case "hoi_chong_gia_dinh": return detectPostpone(msg)?.kind === "partner";
    case "xin_suy_nghi": return detectPostpone(msg)?.kind === "time";
    case "dang_ban": return detectPostpone(msg)?.kind === "busy";
    case "tham_khao_them": return detectBrowsing(msg);
    case "khong_tin_anh_that": return detectTrustConcern(msg);
    case "chua_biet_gu": return detectStyle(msg) === UNKNOWN_VALID;
    case "xin_giam_them": return detectDiscountRequest(msg);
    case "hoi_ngan_sach": return detectBudgetConcern(msg);
    case "so_sanh_ben_khac": return detectObjection(msg)?.type === "COMPARE_COMPETITOR";
    case "bat_ky": return true;
    default: return false;
  }
}

// ─── Match 1 thẻ với tin + state → {matched, specificity, reason} ─────────────

function matchScenario(
  def: ScenarioDef, signals: MessageSignals, state: ThreadState, isFirstContact: boolean, msg: string,
): { matched: boolean; specificity: number; reason?: LoserReason; detail?: string } {
  if (!def.enabled) return { matched: false, specificity: 0, reason: "dang_tat" };

  // Trigger: ít nhất 1 khớp. "bat_ky" khớp mọi tin nhưng KHÔNG cộng điểm cụ thể.
  const hit = def.triggers.filter((t) => triggerMatches(t, signals, msg));
  if (hit.length === 0) return { matched: false, specificity: 0, reason: "trigger_khong_khop" };
  let specificity = hit.filter((t) => t !== "bat_ky").length;

  // Điều kiện trạng thái: mọi điều kiện KHÁC "any" phải đúng; mỗi cái đúng +1 điểm cụ thể.
  const c = def.conditions;
  const checks: Array<[boolean, string]> = [];
  if (c.serviceIntent !== "any") checks.push([(c.serviceIntent === "known") === !!state.serviceIntent, "nhóm dịch vụ"]);
  if (c.dateStatus !== "any") {
    const ds = state.slots.date_status ?? "unset";
    checks.push([c.dateStatus === (ds === "unknown" ? "unset" : ds), "trạng thái ngày"]);
  }
  if (c.quoted !== "any") checks.push([(c.quoted === "yes") === state.quotedPackages.length > 0, "đã báo giá hay chưa"]);
  if (c.firstContact !== "any") checks.push([(c.firstContact === "yes") === isFirstContact, "tin đầu hay không"]);
  for (const [ok, label] of checks) {
    if (!ok) return { matched: false, specificity: 0, reason: "dieu_kien_khong_khop", detail: label };
  }
  specificity += checks.length;

  // Dữ liệu bắt buộc.
  for (const slot of def.requiredSlots) {
    if (slot === "service_intent" && !state.serviceIntent)
      return { matched: false, specificity: 0, reason: "thieu_du_lieu", detail: "chưa rõ nhóm dịch vụ" };
    if (slot === "event_date" && state.slots.date_status !== "known")
      return { matched: false, specificity: 0, reason: "thieu_du_lieu", detail: "chưa có ngày chụp" };
  }

  return { matched: true, specificity };
}

// ─── Overlay thẻ thắng lên baseline (chỉ SIẾT, không NỚI) ─────────────────────

function overlayWinner(
  baseline: RouterDecision, winner: ScenarioDef, intent: string | null,
  dateStatus: string | undefined,
): {
  decision: RouterDecision; actionChanged: boolean; note: string;
} {
  let d: RouterDecision = { ...baseline, forbiddenQuestions: [...baseline.forbiddenQuestions], knowledgeNeeded: [...baseline.knowledgeNeeded] };
  let note = "";

  // 1. CẤM BỔ SUNG từ thẻ (union — không bao giờ bớt cấm sẵn có).
  const extraForbiddenActions = new Set<SaleAction>();
  for (const f of winner.forbiddenExtra) {
    const eff = FORBIDDEN_EFFECTS[f];
    for (const q of eff?.questions ?? []) if (!d.forbiddenQuestions.includes(q)) d.forbiddenQuestions.push(q);
    for (const a of eff?.actions ?? []) extraForbiddenActions.add(a);
  }

  // 2. ACTION của thẻ — CHỈ áp khi an toàn tuyệt đối:
  //    - baseline không escalation (Core Guard thắng — thẻ không chặn được ESCALATE_HUMAN);
  //    - baseline không phải WAIT an toàn (không cho thẻ đè WAIT để "cố bán");
  //    - action nằm trong allowedActions của playbook stage hiện tại;
  //    - không nằm trong cấm bổ sung của chính thẻ;
  //    - action-hỏi (ASK_DATE/ASK_PHONE) không được mở lại câu hỏi ĐANG BỊ CẤM
  //      (rule cứng "hỏi >=2 lần thì cấm" áp cho MỌI câu hỏi, không riêng ask_date).
  let actionChanged = false;
  const want = winner.primaryAction;
  const questionOf: Partial<Record<SaleAction, string>> = { ASK_DATE: "ask_date", ASK_PHONE: "ask_phone" };
  const wantQuestion = want ? questionOf[want] : undefined;
  if (
    want != null && want !== d.action
    && !baseline.shouldEscalate && baseline.action !== "ESCALATE_HUMAN" && baseline.action !== "WAIT"
    && SALE_PLAYBOOK_V1[d.stage].allowedActions.includes(want)
    && !extraForbiddenActions.has(want)
    && !(wantQuestion && d.forbiddenQuestions.includes(wantQuestion))
  ) {
    d = { ...d, action: want, reason: `${d.reason} → thẻ '${winner.name}' chọn hành động '${want}'` };
    // Thẻ chuyển người thật → cờ escalate phải bật cùng (không "bàn giao câm").
    if (want === "ESCALATE_HUMAN") d.shouldEscalate = true;
    actionChanged = true;
  }

  // 3. Action hiện tại dính cấm bổ sung của thẻ → hạ về fallback an toàn (ANSWER_FAQ/WAIT).
  if (extraForbiddenActions.has(d.action)) {
    const allowed = SALE_PLAYBOOK_V1[d.stage].allowedActions;
    const fallback: SaleAction = allowed.includes("ANSWER_FAQ") ? "ANSWER_FAQ" : "WAIT";
    d = { ...d, action: fallback, reason: `${d.reason} → action bị thẻ '${winner.name}' cấm, hạ về ${fallback}` };
    actionChanged = true;
    note = "action gốc bị thẻ cấm → hạ an toàn";
  }

  // 4. Kiến thức: union baseline + thẻ.
  for (const k of knowledgeKeysToNeeded(winner.knowledge, intent)) {
    if (!d.knowledgeNeeded.includes(k)) d.knowledgeNeeded.push(k);
  }

  // 5. Lưới cuối: playbook enforce (dùng CHUNG hàm của Workflow V1).
  d = enforcePlaybook(d);

  // 6. Action ĐÃ ĐỔI → tính lại requiredData/missingData/knowledge theo ĐÚNG luật của
  //    router (invariant "action↔knowledge↔missingData nhất quán" — sale-workflow.ts finish()):
  //    thẻ không bao giờ được tạo decision báo-giá mà thiếu cờ thiếu-dữ-liệu / thiếu pricing.
  if (actionChanged) {
    if (d.action === "QUOTE_EXACT") d.requiredData = ["service_intent", "event_date"];
    else if (d.action === "QUOTE_REFERENCE" || d.action === "SEND_PRICE" || d.action === "SEND_SAMPLE") d.requiredData = ["service_intent"];
    else d.requiredData = [];
    d.missingData = d.requiredData.filter((k) =>
      k === "service_intent" ? !intent : k === "event_date" ? dateStatus !== "known" : false,
    );
    const needK =
      d.action === "QUOTE_EXACT" || d.action === "QUOTE_REFERENCE" || d.action === "SEND_PRICE"
        ? [`pricing:${intent ?? "all"}`]
        : d.action === "SEND_SAMPLE" ? [`gallery:${intent ?? "all"}`] : [];
    for (const k of needK) if (!d.knowledgeNeeded.includes(k)) d.knowledgeNeeded.push(k);
  }
  return { decision: d, actionChanged, note };
}

// ─── Resolver chính ───────────────────────────────────────────────────────────

export function resolveScenario(input: ScenarioResolveInput): ScenarioResolveResult {
  // Workflow V1 = Core Guard + Router — LUÔN chạy (kể cả khi có thẻ) để làm baseline an toàn.
  const baseline = routeSaleAction({
    customerMessage: input.customerMessage,
    threadState: input.threadState,
    isFirstContact: input.isFirstContact,
  });

  // FAIL-OPEN THẬT SỰ: bất kỳ lỗi nào ở tầng scenario (def bẩn từ DB, bug matching…)
  // → trả nguyên quyết định Workflow V1, không bao giờ throw ra caller.
  try {
    return resolveWithBaseline(input, baseline);
  } catch (err) {
    console.error("[ScenarioResolver] lỗi (fail-open về Workflow V1):", String(err).slice(0, 160));
    return {
      decision: baseline, baseline, winner: null, losers: [],
      actionChanged: false, guidance: null, closingLine: null, knowledge: [],
      source: "engine_fallback",
      explain: "Tầng kịch bản gặp lỗi — dùng nguyên quyết định của hệ thống (Workflow V1).",
    };
  }
}

function resolveWithBaseline(input: ScenarioResolveInput, baseline: RouterDecision): ScenarioResolveResult {
  const signals = detectMessageSignals(input.customerMessage);
  const losers: ScenarioLoser[] = [];
  const matched: Array<{ def: ScenarioDef; specificity: number }> = [];

  // filter(Boolean): phần tử null/undefined trong danh sách (dữ liệu bẩn) bị bỏ qua an toàn.
  for (const def of (input.scenarios ?? []).filter((d): d is ScenarioDef => !!d)) {
    const m = matchScenario(def, signals, input.threadState, input.isFirstContact, input.customerMessage);
    if (m.matched) matched.push({ def, specificity: m.specificity });
    else losers.push({ key: def.key, name: def.name, reason: m.reason ?? "trigger_khong_khop", detail: m.detail });
  }

  // Sắp: ưu tiên kéo thả (nhỏ = cao) → độ cụ thể (cao thắng) → scenario_key (ổn định).
  matched.sort((a, b) =>
    a.def.priority - b.def.priority
    || b.specificity - a.specificity
    || a.def.key.localeCompare(b.def.key),
  );

  const winner = matched.length > 0 ? matched[0].def : null;
  for (let i = 1; i < matched.length; i++) {
    losers.push({
      key: matched[i].def.key, name: matched[i].def.name,
      reason: "uu_tien_thap_hon",
      detail: `thua '${winner?.name}' (ưu tiên ${winner?.priority} so với ${matched[i].def.priority})`,
    });
  }

  if (!winner) {
    return {
      decision: baseline, baseline, winner: null, losers,
      actionChanged: false, guidance: null, closingLine: null, knowledge: [],
      source: "engine_fallback",
      explain: "Không thẻ nào khớp — dùng nguyên quyết định của hệ thống (Workflow V1).",
    };
  }

  const { decision, actionChanged, note } = overlayWinner(
    baseline, winner, input.threadState.serviceIntent, input.threadState.slots.date_status,
  );
  const explain =
    `Chọn thẻ '${winner.name}' (khớp tình huống${matched[0].specificity > 0 ? `, độ cụ thể ${matched[0].specificity}` : ""}). `
    + (actionChanged ? `Hành động: ${decision.action}. ` : `Giữ hành động hệ thống: ${decision.action}. `)
    + (note ? `${note}. ` : "")
    + (baseline.shouldEscalate ? "Có tín hiệu chuyển người thật — luật lõi giữ quyền quyết định. " : "");

  return {
    decision, baseline, winner, losers, actionChanged,
    guidance: winner.guidance || null,
    closingLine: winner.closingLine || null,
    knowledge: winner.knowledge,
    source: "scenario",
    explain: explain.trim(),
  };
}

// ─── Khối "HƯỚNG DẪN TÌNH HUỐNG" chèn vào context LLM (chỉ khi enforce/test) ──

export function buildScenarioGuidanceBlock(r: ScenarioResolveResult): string {
  if (!r.winner) return "";
  const lines: string[] = [];
  if (r.guidance) lines.push(`- Cách xử lý: ${r.guidance}`);
  if (r.closingLine) lines.push(`- Câu kết gợi ý (diễn đạt lại tự nhiên, không đọc y nguyên như máy): "${r.closingLine}"`);
  const cam = r.decision.forbiddenQuestions.filter((q) => q !== "self_discount");
  if (cam.includes("ask_date")) lines.push("- TUYỆT ĐỐI không hỏi ngày chụp trong lượt này.");
  if (cam.includes("ask_phone")) lines.push("- Chưa xin số điện thoại ở lượt này.");
  if (lines.length === 0) return "";
  return `TÌNH HUỐNG HIỆN TẠI (hệ thống nhận diện: ${r.winner.name}) — làm theo hướng dẫn này, ưu tiên cao:\n${lines.join("\n")}`;
}
