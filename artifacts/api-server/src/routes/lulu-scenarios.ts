import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import {
  listScenarios, getScenario, createScenario, saveDraft, discardDraft, toggleScenario,
  reorderScenarios, cloneScenario, archiveScenario, applyAllDrafts, listVersions,
  rollbackToVersion, loadDefsWithDraftOf, loadActiveScenarioDefs, recordTestRun, type Actor,
} from "../lib/sale-scenario-store";
import { compileCard, validateEnsemble } from "../lib/sale-scenario-compiler";
import { resolveScenario, buildScenarioGuidanceBlock, LOSER_REASON_LABELS } from "../lib/sale-scenario-resolver";
import {
  isScenarioManagerEnabled, isScenarioShadowEnabled,
  TRIGGER_LABELS, CONDITION_LABELS, ACTION_LABELS, FORBIDDEN_LABELS, KNOWLEDGE_LABELS,
  CORE_FORBIDDEN_KEYS, type ScenarioCard,
} from "../lib/sale-scenario-types";
import { askClaudeForReply, type ClaudeHistoryItem } from "../lib/claude-sale";
import { callChat, resolveTestProviderOverride } from "../lib/ai-orchestrator";
import { getSaleContext, auditPackages, pkgDiscountCfg, groupDiscountCfg } from "../lib/sale-context";
import { resolveDiscount } from "../lib/pricing-discount";
import { getActivePlaybook } from "../lib/sale-playbook";
import { getActiveBrainRules } from "../lib/sale-brain-lab";
import { getClaudeSaleSettings } from "../lib/sale-settings";
import { simulateThreadStateFromHistory, buildThreadStateBlock } from "../lib/sale-thread-state";
import { validateSaleReply, type CatalogItem } from "../lib/sale-workflow-validator";

/**
 * API "Kịch bản tư vấn Lulu" (Scenario Manager).
 *
 * AN TOÀN:
 *  - TOÀN BỘ sau cờ LULU_SCENARIO_MANAGER_ENABLED (mặc định TẮT) → 403 khi chưa bật.
 *  - Xem/Test: mọi nhân viên đăng nhập. Sửa/Bật-tắt/Apply/Rollback: admin.
 *  - KHÔNG endpoint nào gửi tin ra Messenger; test chỉ mô phỏng (giống Claude Sale Test).
 *  - Core Rules chỉ-đọc: API không có đường tắt validator; compileCard chặn thẻ vi phạm.
 */

const router: IRouter = Router();

type Caller = { id: number; name: string | null; isAdmin: boolean };

async function requireStaff(req: Request, res: Response): Promise<Caller | null> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    return null;
  }
  const r = await pool.query(`SELECT id, name, role, roles FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
  const u = r.rows[0] as { id: number; name?: string; role?: string; roles?: unknown } | undefined;
  if (!u) {
    res.status(401).json({ error: "Tài khoản không hợp lệ" });
    return null;
  }
  const isAdmin = u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin"));
  return { id: u.id, name: u.name ?? null, isAdmin };
}

function requireAdmin(caller: Caller, res: Response): boolean {
  if (!caller.isAdmin) {
    res.status(403).json({ error: "Chỉ admin/chủ studio được sửa hoặc áp dụng kịch bản" });
    return false;
  }
  return true;
}

function requireFeature(res: Response): boolean {
  if (!isScenarioManagerEnabled()) {
    res.status(403).json({
      error: "Tính năng Kịch bản tư vấn Lulu chưa được bật (LULU_SCENARIO_MANAGER_ENABLED).",
      featureOff: true,
    });
    return false;
  }
  return true;
}

const actorOf = (c: Caller): Actor => ({ id: c.id, name: c.name });

/** Làm sạch history từ body: bỏ phần tử không phải object (null → TypeError), cap độ dài
 *  từng tin (chống nhồi prompt khổng lồ đốt token / phình bảng test_runs) + cap số lượng. */
function sanitizeHistory(raw: unknown): Array<{ direction: "incoming" | "outgoing"; message: string }> {
  return (Array.isArray(raw) ? raw : [])
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
    .map((h) => ({
      direction: h.direction === "outgoing" ? "outgoing" as const : "incoming" as const,
      message: String(h.message ?? "").slice(0, 4000),
    }))
    .filter((h) => h.message)
    .slice(-40);
}
const MAX_TEST_MESSAGE = 4000;

// Lượt bot synthetic khi thiếu AI key — đúng dấu vết mỗi action (botAsksDate…).
const SYNTH_BOT_LINE: Record<string, string> = {
  GREET: "Dạ em chào mình ạ, mình đang quan tâm dịch vụ nào ạ?",
  ASK_SERVICE: "Dạ mình đang cần chụp cưới, beauty hay gia đình ạ?",
  IDENTIFY_SERVICE: "Dạ mình thích tone nhẹ nhàng hay sang trọng ạ?",
  ASK_DATE: "Dạ mình dự định chụp khi nào ạ?",
  QUOTE_REFERENCE: "Dạ em gửi mình mức giá tham khảo nha.",
  QUOTE_EXACT: "Dạ giá gói của mình đây ạ.",
  SEND_PRICE: "Dạ em gửi bảng giá cho mình nha.",
  SEND_SAMPLE: "Em gửi mình 2 mẫu gần gu nhất nha.",
  ANSWER_FAQ: "Dạ em trả lời mình nè.",
  HANDLE_OBJECTION: "Dạ em hiểu mà, để em nói rõ quyền lợi cho mình nha.",
  ASK_FOR_BOOKING: "Mình muốn em giữ lịch giúp không ạ?",
  ASK_PHONE: "Mình để lại số điện thoại giúp em nha.",
  ESCALATE_HUMAN: "Dạ em báo nhân viên hỗ trợ mình ngay nha.",
  WAIT: "Dạ vâng ạ, mình cứ thoải mái nha.",
};

// ─── Diễn giải tiếng Việt cho sandbox (mục 15 Sales Brain — chủ không đọc JSON) ──

const STAGE_VN: Record<string, string> = {
  NEW_LEAD: "Khách mới — chào hỏi", DISCOVERY: "Đang xác định nhu cầu",
  CONSULTING: "Đang tư vấn", QUOTE_REFERENCE: "Báo giá tham khảo (chưa chốt ngày)",
  QUOTED: "Đã báo giá", CONSIDERING: "Khách đang cân nhắc", BOOKING_INTENT: "Sẵn sàng chốt",
  WAITING: "Chờ khách", HUMAN_REVIEW: "Người thật xử lý", BOOKED: "Đã thành khách",
  LOST: "Khách đã từ chối",
};

const INTENT_VN: Record<string, string> = {
  beauty: "chụp beauty", wedding_album: "album cưới", wedding_gate: "chụp cổng",
  wedding_party: "chụp tiệc cưới", rental_outfit: "thuê váy/đồ", maternity: "chụp bầu",
  family: "chụp gia đình", new_concept_idea: "concept mới lạ",
};

/** "Lulu đang nhớ" — từ trí nhớ thật, tiếng Việt đời thường. */
function describeMemoryVN(state: import("../lib/sale-thread-state").ThreadState): string[] {
  const out: string[] = [];
  const s = state.slots;
  if (state.serviceIntent) out.push(`Dịch vụ quan tâm: ${INTENT_VN[state.serviceIntent] ?? state.serviceIntent}`);
  if (s.date_status === "known") out.push(`Ngày chụp: ${s.date_text || s.event_date}`);
  else if (s.date_status === "not_decided") out.push("Ngày chụp: khách ĐÃ NÓI chưa chốt (không hỏi lại)");
  if (s.style && s.style !== "UNKNOWN_VALID") out.push(`Gu: ${s.style}`);
  else if (s.style === "UNKNOWN_VALID") out.push("Gu: khách chưa biết (gợi hướng, không hỏi trần)");
  if (s.location_type && s.location_type !== "UNKNOWN_VALID") {
    out.push(`Địa điểm: ${s.location_type === "studio" ? "studio" : s.location_type === "outdoor" ? "ngoại cảnh" : "studio + ngoại cảnh"}`);
  }
  if (typeof s.headcount === "number") out.push(`Số người: ${s.headcount}`);
  if (s.budget_text && s.budget_text !== "UNKNOWN_VALID") out.push(`Ngân sách khách nhắc: ${s.budget_text}`);
  if (s.decision_maker === "partner") out.push("Người quyết: cần bàn với chồng/gia đình");
  if (state.quotedPackages.length) out.push(`Đã báo giá gói: ${state.quotedPackages.map((p) => p.code).join(", ")}`);
  const asked = state.askedQuestions.find((q) => q.key === "ask_date");
  if (asked) out.push(`Đã hỏi ngày ${asked.count} lần (không lặp lại)`);
  const objs = s.objections ?? [];
  if (objs.length) out.push(`Khách từng phân vân: ${objs.map((o) => `"${o.quote.slice(0, 40)}"`).join(" · ")}`);
  if (s.lost_reason) out.push(`Từng từ chối: "${s.lost_reason}"`);
  return out.length ? out : ["(chưa có gì đáng nhớ)"];
}

/** "Dữ liệu lấy từ" — map knowledgeNeeded → nguồn tiếng Việt. */
function describeDataSources(knowledge: string[]): string[] {
  const out = new Set<string>();
  for (const k of knowledge ?? []) {
    if (k.startsWith("pricing:")) out.add(`Bảng giá nhóm "${INTENT_VN[k.split(":")[1]] ?? k.split(":")[1]}" (Dịch vụ & Bảng giá)`);
    else if (k.startsWith("gallery:")) out.add("Ảnh mẫu đã duyệt cho khách (thư viện ảnh)");
    else if (k === "price_images") out.add("Ảnh bảng giá theo nhóm");
    else if (k.startsWith("services:")) out.add("Danh mục dịch vụ studio");
    else if (k === "booking") out.add("Quy trình giữ lịch (nhân viên xác nhận)");
    else if (k === "value_points") out.add("Điểm mạnh / quyền lợi studio");
    else if (k.startsWith("faq:")) out.add("Thông tin studio (địa chỉ / giờ / chính sách)");
    else out.add(k);
  }
  return [...out];
}

// ─── Trạng thái + danh mục nhãn (FE render tiếng Việt từ đây — 1 nguồn) ───────

router.get("/lulu-scenarios/status", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  res.json({
    managerEnabled: isScenarioManagerEnabled(),
    shadowEnabled: isScenarioShadowEnabled(),
    labels: {
      triggers: TRIGGER_LABELS,
      conditions: CONDITION_LABELS,
      actions: ACTION_LABELS,
      forbidden: FORBIDDEN_LABELS,
      knowledge: KNOWLEDGE_LABELS,
      loserReasons: LOSER_REASON_LABELS,
      coreForbidden: CORE_FORBIDDEN_KEYS,
    },
  });
});

// ─── Danh sách / chi tiết ─────────────────────────────────────────────────────

router.get("/lulu-scenarios", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  if (!requireFeature(res)) return;
  try {
    res.json({ scenarios: await listScenarios() });
  } catch (err) {
    console.error("[ScenarioMgr] list lỗi:", String(err).slice(0, 200));
    res.status(500).json({ error: "Không tải được danh sách kịch bản" });
  }
});

router.get("/lulu-scenarios/versions", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  if (!requireFeature(res)) return;
  res.json({ versions: await listVersions(50) });
});

router.get("/lulu-scenarios/:key", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  if (!requireFeature(res)) return;
  const rec = await getScenario(String(req.params.key));
  if (!rec) { res.status(404).json({ error: "Không tìm thấy kịch bản" }); return; }
  res.json({ scenario: rec });
});

// ─── Tạo / sửa nháp / hủy nháp / nhân bản / lưu trữ ──────────────────────────

router.post("/lulu-scenarios", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const b = req.body as { key?: string; card?: unknown };
  const compiled = compileCard(b?.card);
  if (!compiled.ok) { res.status(400).json({ error: "Thẻ chưa hợp lệ", issues: compiled.errors }); return; }
  const key = (b?.key ?? compiled.card.name).toString();
  const out = await createScenario(key, compiled.card, actorOf(caller));
  if (!out.ok) { res.status(400).json({ error: out.error }); return; }
  res.json({ scenario: out.record, warnings: compiled.warnings });
});

router.put("/lulu-scenarios/:key", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const cur = await getScenario(String(req.params.key));
  if (!cur) { res.status(404).json({ error: "Không tìm thấy kịch bản" }); return; }
  const compiled = compileCard((req.body as { card?: unknown })?.card);
  // Lưu NHÁP vẫn cho phép khi có lỗi? KHÔNG — chặn sớm cho chủ sửa ngay (lỗi kèm gợi ý VN).
  if (!compiled.ok) { res.status(400).json({ error: "Thẻ chưa hợp lệ — sửa theo gợi ý bên dưới.", issues: compiled.errors }); return; }
  const rec = await saveDraft(cur.scenarioKey, compiled.card, actorOf(caller));
  res.json({ scenario: rec, warnings: compiled.warnings });
});

router.post("/lulu-scenarios/:key/discard-draft", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const rec = await discardDraft(String(req.params.key), actorOf(caller));
  if (!rec) { res.status(404).json({ error: "Không tìm thấy kịch bản" }); return; }
  res.json({ scenario: rec });
});

router.post("/lulu-scenarios/:key/clone", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const out = await cloneScenario(String(req.params.key), actorOf(caller));
  if (!out.ok) { res.status(400).json({ error: out.error }); return; }
  res.json({ scenario: out.record });
});

router.post("/lulu-scenarios/:key/toggle", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const enabled = !!(req.body as { enabled?: boolean })?.enabled;
  const rec = await toggleScenario(String(req.params.key), enabled, actorOf(caller));
  if (!rec) { res.status(404).json({ error: "Không tìm thấy kịch bản" }); return; }
  res.json({ scenario: rec });
});

router.post("/lulu-scenarios/:key/archive", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const out = await archiveScenario(String(req.params.key), actorOf(caller));
  if (!out.ok) { res.status(400).json({ error: out.error }); return; }
  res.json({ scenario: out.record });
});

router.post("/lulu-scenarios/reorder", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const keys = ((req.body as { keys?: unknown })?.keys ?? []) as string[];
  if (!Array.isArray(keys) || keys.length === 0) { res.status(400).json({ error: "Thiếu danh sách thứ tự" }); return; }
  const n = await reorderScenarios(keys.map(String), actorOf(caller));
  res.json({ updated: n });
});

// ─── Apply / Rollback (nguyên bộ) ─────────────────────────────────────────────

router.post("/lulu-scenarios/apply", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const note = String((req.body as { note?: string })?.note ?? "");
  const out = await applyAllDrafts(actorOf(caller), note);
  if (!out.ok) { res.status(400).json(out); return; }
  res.json(out);
});

router.post("/lulu-scenarios/rollback", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const versionId = Number((req.body as { versionId?: number })?.versionId);
  if (!Number.isFinite(versionId)) { res.status(400).json({ error: "Thiếu versionId" }); return; }
  const out = await rollbackToVersion(versionId, actorOf(caller));
  if (!out.ok) { res.status(400).json({ error: out.error }); return; }
  res.json(out);
});

// ─── Resolve preview (không gọi LLM — trace nhanh) ────────────────────────────

router.post("/lulu-scenarios/resolve-preview", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res)) return;
  const b = req.body as { message?: string; history?: unknown; draftOf?: string };
  const message = String(b?.message ?? "").trim().slice(0, MAX_TEST_MESSAGE);
  if (!message) { res.status(400).json({ error: "Thiếu câu khách" }); return; }
  try {
  const history = sanitizeHistory(b?.history);
  const defs = b?.draftOf ? await loadDefsWithDraftOf(String(b.draftOf)) : await loadActiveScenarioDefs();
  const state = simulateThreadStateFromHistory([...history, { direction: "incoming" as const, message }]);
  const result = resolveScenario({ customerMessage: message, threadState: state, isFirstContact: history.length === 0, scenarios: defs });
  res.json({
    stateBefore: state,
    winner: result.winner ? { key: result.winner.key, name: result.winner.name } : null,
    losers: result.losers,
    action: result.decision.action,
    stage: result.decision.stage,
    forbiddenQuestions: result.decision.forbiddenQuestions,
    knowledge: result.decision.knowledgeNeeded,
    explain: result.explain,
    baselineAction: result.baseline.action,
    actionChanged: result.actionChanged,
    source: result.source,
  });
  } catch (err) {
    console.error("[ScenarioMgr] resolve-preview lỗi:", String(err).slice(0, 160));
    res.status(500).json({ error: "Xem trước lỗi: " + String(err).slice(0, 120) });
  }
});

// ─── Test thử (1 câu hoặc nhiều lượt) — mô phỏng + gọi LLM + validator ────────

async function runScenarioTest(opts: {
  message: string;
  history: Array<{ direction: "incoming" | "outgoing"; message: string }>;
  draftOf: string | null;   // test bản NHÁP của thẻ này (các thẻ khác dùng active)
  /** Mã gói đã báo ở các lượt trước (multi-turn tích luỹ — thiếu LLM vẫn giữ trí nhớ đã-báo-giá). */
  quotedCodes?: string[];
  useDraft: boolean;        // false = bộ ACTIVE thuần (cột "trước khi sửa")
  caller: Caller;
  record: boolean;
}) {
  const defs = opts.useDraft && opts.draftOf ? await loadDefsWithDraftOf(opts.draftOf) : await loadActiveScenarioDefs();
  // State NUỐT tin khách hiện tại (đúng chuẩn simState của claude-sale-test + golden harness):
  // slot "chưa chốt ngày"/nhóm dịch vụ trong CHÍNH câu đang test phải được tính cho lượt này.
  const stateBefore = simulateThreadStateFromHistory(opts.history, { quotedCodes: opts.quotedCodes ?? [] });
  const state = simulateThreadStateFromHistory(
    [...opts.history, { direction: "incoming" as const, message: opts.message }],
    { quotedCodes: opts.quotedCodes ?? [] },
  );
  const resolve = resolveScenario({
    customerMessage: opts.message, threadState: state,
    isFirstContact: opts.history.length === 0, scenarios: defs,
  });

  // Gọi LLM viết lời (giống Claude Sale Test — KHÔNG gửi Messenger). Không có key → trace-only.
  let replyText: string | null = null;
  let replyError: string | null = null;
  let providerLabel = "anthropic";
  const testOverride = resolveTestProviderOverride();
  if (testOverride) providerLabel = testOverride.label ?? "shopaikey";
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  // Tổng đài (callChat) tự resolve chuỗi provider Claude → OpenAI — route chỉ cần biết
  // CÓ ÍT NHẤT 1 provider khả dụng (kể cả cổng OpenAI fallback), không tự gate hẹp hơn tổng đài.
  const anyProvider = !!(
    testOverride || apiKey
    || (process.env.OPENAI_API_KEY ?? "").trim()
    || (process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? "").trim()
  );
  if (anyProvider) {
    try {
      let context = await getSaleContext();
      const stateBlock = buildThreadStateBlock(state);
      if (stateBlock) context += `\n\n${stateBlock}`;
      const guidanceBlock = buildScenarioGuidanceBlock(resolve);
      if (guidanceBlock) context += `\n\n${guidanceBlock}`;
      const [styleGuide, brainRules, settings] = await Promise.all([
        getActivePlaybook(), getActiveBrainRules(), getClaudeSaleSettings(),
      ]);
      const reply = await askClaudeForReply({
        apiKey,
        customerMessage: opts.message,
        customerName: "Khách test",
        history: opts.history as ClaudeHistoryItem[],
        context, styleGuide, settings, scheduleContext: "", brainRules,
        providerOverride: testOverride,
      });
      replyText = reply.raw || null;
      if (!replyText && reply.providerUsed === null) replyError = "AI đang lỗi — câu này sẽ chuyển người thật.";
    } catch (err) {
      replyError = `Gọi AI lỗi: ${String((err as Error)?.message ?? err).slice(0, 150)}`;
    }
  } else {
    replyError = "Chưa cấu hình AI key — chỉ hiển thị phần phân tích, không có câu trả lời thử.";
  }

  // Validator trên câu trả lời thật (nếu có) — catalog giá thật, fail-open.
  let validator: ReturnType<typeof validateSaleReply> = { verdict: "PASS" };
  if (replyText) {
    try {
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
      validator = validateSaleReply({ threadState: state, decision: resolve.decision, reply: replyText, catalog });
    } catch { validator = { verdict: "PASS" }; }
  }

  const stateAfter = simulateThreadStateFromHistory([
    ...opts.history,
    { direction: "incoming", message: opts.message },
    ...(replyText ? [{ direction: "outgoing" as const, message: replyText }] : []),
  ]);

  const verdict = validator.verdict === "BLOCK"
    ? (validator.severity === "minor" ? "WARN" : "BLOCK")
    : "PASS";

  if (opts.record) {
    await recordTestRun({
      scenarioKey: opts.draftOf, inputMessage: opts.message, history: opts.history,
      stateBefore, winnerKey: resolve.winner?.key ?? null, losers: resolve.losers,
      action: resolve.decision.action, forbidden: resolve.decision.forbiddenQuestions,
      knowledge: resolve.decision.knowledgeNeeded, replyText, validator, verdict,
      stateAfter, createdBy: opts.caller.id,
    });
  }

  return {
    stateBefore,
    // Sandbox tiếng Việt (mục 15): giai đoạn / đang nhớ / dữ liệu lấy từ.
    stageVn: STAGE_VN[resolve.decision.stage] ?? resolve.decision.stage,
    memoryVN: describeMemoryVN(state),
    dataSources: describeDataSources(resolve.decision.knowledgeNeeded),
    winner: resolve.winner ? { key: resolve.winner.key, name: resolve.winner.name } : null,
    losers: resolve.losers,
    explain: resolve.explain,
    action: resolve.decision.action,
    stage: resolve.decision.stage,
    baselineAction: resolve.baseline.action,
    actionChanged: resolve.actionChanged,
    forbiddenQuestions: resolve.decision.forbiddenQuestions,
    knowledge: resolve.decision.knowledgeNeeded,
    guidance: resolve.guidance,
    closingLine: resolve.closingLine,
    replyText, replyError, provider: providerLabel,
    validator, verdict, stateAfter,
  };
}

router.post("/lulu-scenarios/:key/test", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res)) return;
  const b = req.body as { message?: string; history?: unknown; compare?: boolean };
  const message = String(b?.message ?? "").trim().slice(0, MAX_TEST_MESSAGE);
  if (!message) { res.status(400).json({ error: "Nhập câu khách để test" }); return; }
  const history = sanitizeHistory(b?.history);
  const key = String(req.params.key);
  try {
    const after = await runScenarioTest({ message, history, draftOf: key, useDraft: true, caller, record: true });
    // So sánh TRƯỚC/SAU: chỉ chạy thêm cột "trước" khi thẻ đang có nháp và client yêu cầu.
    let before: Awaited<ReturnType<typeof runScenarioTest>> | null = null;
    if (b?.compare) {
      const rec = await getScenario(key);
      if (rec?.draftCard) {
        before = await runScenarioTest({ message, history, draftOf: key, useDraft: false, caller, record: false });
      }
    }
    res.json({ after, before });
  } catch (err) {
    console.error("[ScenarioMgr] test lỗi:", String(err).slice(0, 200));
    res.status(500).json({ error: "Test lỗi: " + String(err).slice(0, 150) });
  }
});

router.post("/lulu-scenarios/test-conversation", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res)) return;
  const b = req.body as { messages?: string[]; draftOf?: string };
  const msgs = (Array.isArray(b?.messages) ? b.messages : []).map((m) => String(m ?? "").trim().slice(0, MAX_TEST_MESSAGE)).filter(Boolean).slice(0, 8);
  if (msgs.length === 0) { res.status(400).json({ error: "Nhập ít nhất 1 câu khách" }); return; }
  const draftOf = b?.draftOf ? String(b.draftOf) : null;
  try {
    const turns: Array<Awaited<ReturnType<typeof runScenarioTest>> & { message: string }> = [];
    let history: Array<{ direction: "incoming" | "outgoing"; message: string }> = [];
    const quotedCodes: string[] = [];
    for (const message of msgs) {
      const t = await runScenarioTest({ message, history, draftOf, useDraft: !!draftOf, caller, record: false, quotedCodes });
      if (["QUOTE_REFERENCE", "QUOTE_EXACT", "SEND_PRICE"].includes(t.action)) quotedCodes.push(`GOI-${quotedCodes.length + 1}`);
      turns.push({ ...t, message });
      // KHÔNG có LLM (thiếu key) → vẫn phải chèn LƯỢT BOT synthetic theo action để trí nhớ
      // multi-turn trung thực (bot đã hỏi ngày / đã gửi mẫu... — nếu thiếu, state các lượt sau sai).
      const botLine = t.replyText ?? SYNTH_BOT_LINE[t.action] ?? "Dạ vâng ạ.";
      history = [
        ...history,
        { direction: "incoming", message },
        ...(t.action === "SEND_SAMPLE" && !t.replyText
          ? [{ direction: "outgoing" as const, message: "[image:https://sandbox/mau.jpg]" }] : []),
        { direction: "outgoing" as const, message: botLine },
      ];
    }
    res.json({ turns });
  } catch (err) {
    console.error("[ScenarioMgr] test-conversation lỗi:", String(err).slice(0, 200));
    res.status(500).json({ error: "Test hội thoại lỗi: " + String(err).slice(0, 150) });
  }
});

// ─── Nhờ AI viết kịch bản (draft — KHÔNG tự áp dụng) ──────────────────────────

router.post("/lulu-scenarios/ai-draft", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res) || !requireAdmin(caller, res)) return;
  const b = req.body as { description?: string; transcript?: string };
  const description = String(b?.description ?? "").trim().slice(0, 2000);
  const transcript = String(b?.transcript ?? "").trim().slice(0, 6000);
  if (!description && !transcript) { res.status(400).json({ error: "Mô tả tình huống hoặc dán đoạn chat lỗi" }); return; }

  const existing = await listScenarios();
  const keysList = existing.map((s) => `- ${s.scenarioKey}: ${s.card?.name ?? s.draftCard?.name ?? ""}`).join("\n");

  const system = `Bạn là chuyên gia thiết kế kịch bản sale cho studio ảnh cưới. Hãy tạo MỘT thẻ kịch bản dạng JSON cho bot sale Lulu.
Trả về DUY NHẤT một JSON object (không markdown) với các field:
{"name": string, "description": string,
 "triggers": string[] (chọn trong: hoi_gia, xin_bang_gia, xin_xem_mau, chao_hoi, tin_cut, hoi_chi_tiet_goi, hoi_dia_chi_gio, hoi_coc_thanh_toan, doi_gap_nguoi, cho_sdt, muon_giu_lich, chot_goi, che_gia_xin_giam, bat_ky),
 "conditions": {"serviceIntent": "known"|"unknown"|"any", "dateStatus": "known"|"not_decided"|"unset"|"any", "quoted": "yes"|"no"|"any", "firstContact": "yes"|"no"|"any"},
 "requiredSlots": string[] (trong: service_intent, event_date),
 "primaryAction": string (chọn trong: theo_he_thong, chao_hoi, hoi_nhu_cau, dao_sau_gu, hoi_ngay, bao_gia_tham_khao, bao_gia_chinh_thuc, gui_bang_gia, gui_anh_mau, tra_loi_cau_hoi, xu_ly_ban_khoan, moi_giu_lich, hoi_sdt, chuyen_nguoi_that, dap_nhe_cho),
 "guidance": string (tiếng Việt đời thường — Lulu NÊN làm gì),
 "forbiddenExtra": string[] (trong: hoi_lai_ngay, ep_giu_lich, hoi_sdt_som, gui_lai_bang_gia, spam_anh, hoi_don_nhieu_cau, noi_xau_ben_khac),
 "knowledge": string[] (trong: bang_gia, anh_mau, chi_tiet_goi, dat_lich, dia_chi_gio, danh_muc_dich_vu, diem_manh),
 "closingLine": string, "exitConditions": string[],
 "nextScenarios": [{"whenVn": string, "scenarioKey": string}] (scenarioKey PHẢI có trong danh sách dưới)}
LUẬT CỨNG: không tự giảm giá, không ghi con số tiền, không tự chốt cọc, không hỏi lại ngày khi khách đã nói chưa chốt.
Danh sách kịch bản hiện có (để chuyển tiếp):\n${keysList}`;

  const userMsg = description
    ? `Chủ studio mô tả vấn đề: "${description}"${transcript ? `\n\nĐoạn chat thật (Lulu trả lời chưa tốt):\n${transcript}` : ""}\n\nHãy tạo thẻ kịch bản khắc phục đúng vấn đề này.`
    : `Đoạn chat thật (Lulu trả lời chưa tốt):\n${transcript}\n\nHãy tạo thẻ kịch bản khắc phục.`;

  try {
    const result = await callChat({
      system, messages: [{ role: "user", content: userMsg }],
      maxTokens: 1500, timeoutMs: 60000, label: "scenario-ai-draft",
      claudeOverride: resolveTestProviderOverride(), // TEST-ONLY provider (ShopAIKey) nếu bật; undefined = Anthropic
    });
    if (!result.ok) { res.status(502).json({ error: `AI lỗi: ${result.adminAlert}` }); return; }
    const m = result.text.match(/\{[\s\S]*\}/);
    if (!m) { res.status(502).json({ error: "AI không trả về JSON hợp lệ — thử mô tả rõ hơn." }); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(m[0]); } catch { { res.status(502).json({ error: "JSON của AI bị hỏng — thử lại." }); return; } }
    const compiled = compileCard(parsed);
    // Trả cả card + lỗi (nếu có) để chủ sửa trong editor — KHÔNG tự lưu, KHÔNG tự bật.
    res.json({ card: compiled.card, issues: compiled.errors, warnings: compiled.warnings, ok: compiled.ok });
  } catch (err) {
    console.error("[ScenarioMgr] ai-draft lỗi:", String(err).slice(0, 200));
    res.status(502).json({ error: "Nhờ AI viết lỗi: " + String(err).slice(0, 150) });
  }
});

// ─── Kiểm tra hợp lệ nhanh (FE gọi khi gõ — không lưu) ────────────────────────

router.post("/lulu-scenarios/validate", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireFeature(res)) return;
  const compiled = compileCard((req.body as { card?: unknown })?.card);
  const rows = await listScenarios();
  const keys = rows.map((r) => ({ key: r.scenarioKey, card: (r.draftCard ?? r.card) as ScenarioCard })).filter((x) => x.card);
  const withThis = [...keys.filter((k) => k.key !== String((req.body as { key?: string })?.key ?? "")),
    { key: String((req.body as { key?: string })?.key ?? "__new__"), card: compiled.card }];
  const ens = validateEnsemble(withThis);
  res.json({ ok: compiled.ok && ens.ok, issues: [...compiled.errors, ...ens.errors.filter((e) => e.scenarioKey === (String((req.body as { key?: string })?.key ?? "__new__")))], warnings: compiled.warnings });
});

export default router;
