import { describe, it, expect, vi } from "vitest";
// sale-workflow → sale-lead-flags → @workspace/db (throw nếu thiếu DATABASE_URL) → mock theo convention.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { allGoldenCases } from "./sale-workflow-golden-set";
import { simulateThreadStateFromHistory, type ThreadState } from "./sale-thread-state";
import { routeSaleAction, SALE_PLAYBOOK_V1 } from "./sale-workflow";
import { resolveScenario } from "./sale-scenario-resolver";
import { cardToDef, type ScenarioDef } from "./sale-scenario-types";
import { compileCard } from "./sale-scenario-compiler";
import { SEED_SCENARIOS } from "./sale-scenario-seed";

const NOW = new Date(2026, 6, 28, 10, 0, 0);
const GOLDEN_CASES = allGoldenCases();

/** Bộ def y hệt store seed (compileCard + sort_order 10,20,30…). */
function seedDefs(): ScenarioDef[] {
  return SEED_SCENARIOS.map((s, i) => cardToDef(s.key, compileCard(s.card).card, (i + 1) * 10, true));
}

function freshState(patch?: Partial<ThreadState>): ThreadState {
  return {
    facebookUserId: "(test)", currentStage: "new", previousStage: null,
    serviceIntent: null, customerStatus: "lead", lastAction: null,
    slots: {}, askedQuestions: [], quotedPackages: [], sentAssets: {},
    lastUserMessageAt: null, lastBotMessageAt: null, version: 0,
    ...patch,
  };
}

// ─── GOLDEN PARITY: resolver + 12 thẻ seed PHẢI ra đúng quyết định như engine ──
// Đây là hợp đồng an toàn số 1: seed thẻ = externalize logic Router, hành vi KHÔNG đổi.

describe("Golden parity — resolver(seed 12 thẻ) ≡ Workflow V1", () => {
  const defs = seedDefs();
  for (const c of GOLDEN_CASES) {
    it(`${c.id} — ${c.name}`, () => {
      const full = [...c.history, { direction: "incoming" as const, message: c.message }];
      const state = simulateThreadStateFromHistory(full, { quotedCodes: c.quotedCodes ?? [], now: NOW });
      const baseline = routeSaleAction({ customerMessage: c.message, threadState: state, isFirstContact: c.history.length === 0 });
      const r = resolveScenario({ customerMessage: c.message, threadState: state, isFirstContact: c.history.length === 0, scenarios: defs });
      expect(r.decision.action, `action phải y hệt engine (baseline=${baseline.action})`).toBe(baseline.action);
      expect(r.decision.stage).toBe(baseline.stage);
      expect(r.decision.shouldEscalate).toBe(baseline.shouldEscalate);
      // Cấm chỉ được THÊM, không được BỚT.
      for (const q of baseline.forbiddenQuestions) {
        expect(r.decision.forbiddenQuestions, `không được bớt cấm '${q}'`).toContain(q);
      }
      // Action cuối luôn hợp lệ theo playbook.
      expect(SALE_PLAYBOOK_V1[r.decision.stage].allowedActions).toContain(r.decision.action);
    });
  }
});

// ─── Chọn thẻ: bật/tắt, trigger, điều kiện, dữ liệu, ưu tiên, độ cụ thể ───────

describe("Chọn thẻ thắng/thua với lý do", () => {
  const mk = (over: Partial<ScenarioDef>): ScenarioDef => ({
    key: "t", name: "Thẻ test", priority: 10, enabled: true,
    triggers: ["hoi_gia"], conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "any" },
    requiredSlots: [], primaryAction: null, forbiddenExtra: [], knowledge: [],
    guidance: "", closingLine: "", nextScenarios: [], ...over,
  });
  const stateKnown = freshState({ serviceIntent: "wedding_album" });

  it("thẻ tắt → thua với lý do 'dang_tat'", () => {
    const r = resolveScenario({
      customerMessage: "chụp cưới giá bao nhiêu", threadState: stateKnown, isFirstContact: false,
      scenarios: [mk({ enabled: false })],
    });
    expect(r.winner).toBeNull();
    expect(r.losers[0]).toMatchObject({ key: "t", reason: "dang_tat" });
    expect(r.source).toBe("engine_fallback");
  });

  it("trigger không khớp → thua 'trigger_khong_khop'", () => {
    const r = resolveScenario({
      customerMessage: "cho xem mẫu với", threadState: stateKnown, isFirstContact: false,
      scenarios: [mk({ triggers: ["hoi_gia"] })],
    });
    expect(r.losers[0].reason).toBe("trigger_khong_khop");
  });

  it("điều kiện không đúng → thua 'dieu_kien_khong_khop'", () => {
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu vậy", threadState: stateKnown, isFirstContact: false,
      scenarios: [mk({ conditions: { serviceIntent: "unknown", dateStatus: "any", quoted: "any", firstContact: "any" } })],
    });
    expect(r.losers[0].reason).toBe("dieu_kien_khong_khop");
  });

  it("thiếu dữ liệu bắt buộc → thua 'thieu_du_lieu'", () => {
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu vậy", threadState: freshState(), isFirstContact: false,
      scenarios: [mk({ requiredSlots: ["service_intent"] })],
    });
    expect(r.losers[0].reason).toBe("thieu_du_lieu");
  });

  it("ưu tiên kéo thả: priority nhỏ thắng; thẻ thua ghi 'uu_tien_thap_hon'", () => {
    const a = mk({ key: "a", name: "A", priority: 20 });
    const b = mk({ key: "b", name: "B", priority: 10 });
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu", threadState: stateKnown, isFirstContact: false, scenarios: [a, b],
    });
    expect(r.winner?.key).toBe("b");
    expect(r.losers.find((l) => l.key === "a")?.reason).toBe("uu_tien_thap_hon");
  });

  it("cùng priority: thẻ CỤ THỂ hơn (nhiều điều kiện khớp) thắng", () => {
    const generic = mk({ key: "generic", priority: 10 });
    const specific = mk({
      key: "specific", priority: 10,
      conditions: { serviceIntent: "known", dateStatus: "any", quoted: "any", firstContact: "no" },
    });
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu", threadState: stateKnown, isFirstContact: false,
      scenarios: [generic, specific],
    });
    expect(r.winner?.key).toBe("specific");
  });

  it("cùng priority + cùng cụ thể: tie-break theo scenario_key (ổn định)", () => {
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu", threadState: stateKnown, isFirstContact: false,
      scenarios: [mk({ key: "zz" }), mk({ key: "aa" })],
    });
    expect(r.winner?.key).toBe("aa");
  });

  it("danh sách rỗng → fail-open về engine (không lỗi)", () => {
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu", threadState: stateKnown, isFirstContact: false, scenarios: [],
    });
    expect(r.source).toBe("engine_fallback");
    expect(r.decision.action).toBeTruthy();
  });
});

// ─── Overlay: thẻ chỉ SIẾT, không NỚI (bảo vệ Core Rules) ─────────────────────

describe("Overlay an toàn — thẻ không nới lỏng được luật lõi", () => {
  const mk = (over: Partial<ScenarioDef>): ScenarioDef => ({
    key: "t", name: "Thẻ test", priority: 10, enabled: true,
    triggers: ["bat_ky"], conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "any" },
    requiredSlots: [], primaryAction: null, forbiddenExtra: [], knowledge: [],
    guidance: "g", closingLine: "c", nextScenarios: [], ...over,
  });

  it("thẻ đổi được action khi AN TOÀN (trong playbook allowed, không cấm)", () => {
    // Khách hỏi giá + intent đã rõ + chưa hỏi ngày lần nào → baseline ASK_DATE (CONSULTING).
    // Thẻ chọn SEND_SAMPLE (CONSULTING cho phép) → action đổi.
    const state = freshState({ serviceIntent: "beauty" });
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu", threadState: state, isFirstContact: false,
      scenarios: [mk({ triggers: ["hoi_gia"], primaryAction: "SEND_SAMPLE" })],
    });
    expect(r.baseline.action).toBe("ASK_DATE");
    expect(r.decision.action).toBe("SEND_SAMPLE");
    expect(r.actionChanged).toBe(true);
  });

  it("KHÔNG chặn được ESCALATE_HUMAN (khách đòi gặp người thật)", () => {
    const r = resolveScenario({
      customerMessage: "cho gặp người thật đi", threadState: freshState({ serviceIntent: "beauty" }), isFirstContact: false,
      scenarios: [mk({ primaryAction: "SEND_SAMPLE" })],
    });
    expect(r.baseline.action).toBe("ESCALATE_HUMAN");
    expect(r.decision.action).toBe("ESCALATE_HUMAN");
    expect(r.actionChanged).toBe(false);
  });

  it("KHÔNG đè được WAIT an toàn (tin ack cụt không bị ép bán)", () => {
    const state = freshState({ serviceIntent: "beauty", quotedPackages: [{ code: "A", at: "x" }] });
    const r = resolveScenario({
      customerMessage: "ok ạ", threadState: state, isFirstContact: false,
      scenarios: [mk({ primaryAction: "ASK_FOR_BOOKING" })],
    });
    expect(r.baseline.action).toBe("WAIT");
    expect(r.decision.action).toBe("WAIT");
  });

  it("thẻ muốn ASK_DATE nhưng ask_date bị cấm (khách đã nói chưa chốt) → giữ baseline", () => {
    const state = freshState({ serviceIntent: "wedding_album", slots: { date_status: "not_decided" } });
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu", threadState: state, isFirstContact: false,
      scenarios: [mk({ triggers: ["hoi_gia"], primaryAction: "ASK_DATE" })],
    });
    expect(r.decision.action).not.toBe("ASK_DATE");
    expect(r.decision.forbiddenQuestions).toContain("ask_date");
  });

  it("cấm bổ sung của thẻ đè lên action baseline → hạ fallback an toàn", () => {
    // Khách xin bảng giá + intent rõ → baseline SEND_PRICE; thẻ cấm gửi lại bảng giá → hạ ANSWER_FAQ.
    const state = freshState({ serviceIntent: "wedding_album" });
    const r = resolveScenario({
      customerMessage: "gửi bảng giá đầy đủ cho chị", threadState: state, isFirstContact: false,
      scenarios: [mk({ triggers: ["xin_bang_gia"], forbiddenExtra: ["gui_lai_bang_gia"] })],
    });
    expect(r.baseline.action).toBe("SEND_PRICE");
    expect(r.decision.action).toBe("ANSWER_FAQ");
    expect(r.actionChanged).toBe(true);
  });

  it("cấm bổ sung hoi_lai_ngay thêm ask_date vào forbiddenQuestions (union, không bớt)", () => {
    const state = freshState({ serviceIntent: "beauty" });
    const r = resolveScenario({
      customerMessage: "giá sao em", threadState: state, isFirstContact: false,
      scenarios: [mk({ triggers: ["hoi_gia"], forbiddenExtra: ["hoi_lai_ngay"] })],
    });
    expect(r.decision.forbiddenQuestions).toContain("ask_date");
    expect(r.decision.action).not.toBe("ASK_DATE"); // baseline ASK_DATE bị cấm bởi thẻ → guard đổi hướng
  });

  it("kiến thức: union baseline + thẻ (không mất knowledge của engine)", () => {
    const state = freshState({ serviceIntent: "beauty", slots: { date_status: "not_decided" } });
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu", threadState: state, isFirstContact: false,
      scenarios: [mk({ triggers: ["hoi_gia"], knowledge: ["anh_mau"] })],
    });
    expect(r.decision.knowledgeNeeded).toEqual(expect.arrayContaining(["pricing:beauty", "gallery:beauty"]));
  });

  it("guidance + closing của thẻ thắng được trả ra cho prompt", () => {
    const state = freshState({ serviceIntent: "beauty", slots: { date_status: "not_decided" } });
    const r = resolveScenario({
      customerMessage: "giá bao nhiêu", threadState: state, isFirstContact: false,
      scenarios: [mk({ triggers: ["hoi_gia"], guidance: "Báo giá tham khảo nhẹ nhàng", closingLine: "Có ngày em xác nhận lại nha" })],
    });
    expect(r.guidance).toContain("tham khảo");
    expect(r.closingLine).toContain("xác nhận lại");
  });
});
