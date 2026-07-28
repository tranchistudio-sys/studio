import { describe, it, expect, vi } from "vitest";
// sale-workflow → sale-lead-flags → @workspace/db (throw nếu thiếu DATABASE_URL) → mock theo convention.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import { allGoldenCases, type GoldenCase } from "./sale-workflow-golden-set";
const GOLDEN_CASES = allGoldenCases();
import { simulateThreadStateFromHistory } from "./sale-thread-state";
import { routeSaleAction, type RouterDecision } from "./sale-workflow";
import type { ThreadState } from "./sale-thread-state";

const NOW = new Date(2026, 6, 28, 10, 0, 0);

function runCase(c: GoldenCase): { state: ThreadState; decision: RouterDecision } {
  const full = [...c.history, { direction: "incoming" as const, message: c.message }];
  const state = simulateThreadStateFromHistory(full, { quotedCodes: c.quotedCodes ?? [], now: NOW });
  const decision = routeSaleAction({
    customerMessage: c.message,
    threadState: state,
    isFirstContact: c.history.length === 0,
  });
  return { state, decision };
}

describe("GOLDEN TEST SET V1 — chấm bằng expected có cấu trúc", () => {
  for (const c of GOLDEN_CASES) {
    it(`${c.id} — ${c.name}`, () => {
      const { state, decision } = runCase(c);
      const e = c.expected;
      if (e.dateStatus !== undefined) {
        if (e.dateStatus === "unset") expect(state.slots.date_status, "dateStatus phải chưa được ghi").toBeUndefined();
        else expect(state.slots.date_status).toBe(e.dateStatus);
      }
      if (e.eventDate !== undefined) expect(state.slots.event_date ?? null).toBe(e.eventDate);
      if (e.serviceIntent !== undefined) expect(state.serviceIntent).toBe(e.serviceIntent);
      if (e.stage !== undefined) expect(decision.stage).toBe(e.stage);
      if (e.action !== undefined) expect(decision.action).toBe(e.action);
      if (e.forbiddenAction !== undefined) {
        expect(decision.action, `KHÔNG được chọn ${e.forbiddenAction}`).not.toBe(e.forbiddenAction);
      }
      if (e.forbiddenQuestionsInclude) {
        for (const q of e.forbiddenQuestionsInclude) {
          expect(decision.forbiddenQuestions, `forbiddenQuestions phải chứa ${q}`).toContain(q);
        }
      }
      if (e.shouldEscalate !== undefined) expect(decision.shouldEscalate).toBe(e.shouldEscalate);
    });
  }
});

describe("RULE CỨNG bất biến trên toàn bộ golden set", () => {
  it("Router KHÔNG BAO GIỜ trả ASK_DATE khi ask_date đang bị cấm (Repeated Question Rate = 0%)", () => {
    for (const c of GOLDEN_CASES) {
      const { decision } = runCase(c);
      if (decision.action === "ASK_DATE") {
        expect(decision.forbiddenQuestions, `${c.id}: ASK_DATE nhưng ask_date bị cấm`).not.toContain("ask_date");
      }
    }
  });

  it("Action luôn nằm trong allowedActions của playbook stage (Business Rule Violation = 0%)", async () => {
    const { SALE_PLAYBOOK_V1 } = await import("./sale-workflow");
    for (const c of GOLDEN_CASES) {
      const { decision } = runCase(c);
      expect(
        SALE_PLAYBOOK_V1[decision.stage].allowedActions,
        `${c.id}: action ${decision.action} không được phép ở stage ${decision.stage}`,
      ).toContain(decision.action);
    }
  });
});

// ─── BÁO CÁO CHẤT LƯỢNG (mục 9) — in bảng metric khi chạy test ────────────────

describe("Quality report", () => {
  it("tổng hợp metric golden set", () => {
    let slotChecked = 0, slotOk = 0;
    let actionChecked = 0, actionOk = 0;
    let stageChecked = 0, stageOk = 0;
    let escChecked = 0, escOk = 0;
    let repeatedViolations = 0;
    let forbiddenViolations = 0;

    for (const c of GOLDEN_CASES) {
      const { state, decision } = runCase(c);
      const e = c.expected;
      const slotFields: Array<[unknown, unknown]> = [];
      if (e.dateStatus !== undefined) slotFields.push([e.dateStatus === "unset" ? undefined : e.dateStatus, state.slots.date_status]);
      if (e.eventDate !== undefined) slotFields.push([e.eventDate, state.slots.event_date ?? null]);
      if (e.serviceIntent !== undefined) slotFields.push([e.serviceIntent, state.serviceIntent]);
      if (slotFields.length) {
        slotChecked++;
        if (slotFields.every(([exp, got]) => exp === got)) slotOk++;
      }
      if (e.action !== undefined) { actionChecked++; if (decision.action === e.action) actionOk++; }
      if (e.stage !== undefined) { stageChecked++; if (decision.stage === e.stage) stageOk++; }
      if (e.shouldEscalate !== undefined) { escChecked++; if (decision.shouldEscalate === e.shouldEscalate) escOk++; }
      if (decision.action === "ASK_DATE" && decision.forbiddenQuestions.includes("ask_date")) repeatedViolations++;
      if (e.forbiddenAction && decision.action === e.forbiddenAction) forbiddenViolations++;
    }

    const pct = (ok: number, total: number) => (total === 0 ? "n/a" : `${((ok / total) * 100).toFixed(1)}% (${ok}/${total})`);
    console.log("\n══ GOLDEN QUALITY REPORT V1 ══");
    console.log(`  Cases:                        ${GOLDEN_CASES.length}`);
    console.log(`  Slot Accuracy:                ${pct(slotOk, slotChecked)}`);
    console.log(`  Correct Action Rate:          ${pct(actionOk, actionChecked)}`);
    console.log(`  Correct Stage Rate:           ${pct(stageOk, stageChecked)}`);
    console.log(`  Escalation Accuracy:          ${pct(escOk, escChecked)}`);
    console.log(`  Repeated Question Violations: ${repeatedViolations} (target 0)`);
    console.log(`  Business Rule Violations:     ${forbiddenViolations} (target 0)`);
    console.log("══════════════════════════════\n");

    // Mục tiêu V1 trước pilot (chỉ đạo mục 9): rule cứng phải tuyệt đối.
    expect(repeatedViolations).toBe(0);
    expect(forbiddenViolations).toBe(0);
    expect(slotOk).toBe(slotChecked);
    expect(actionOk).toBe(actionChecked);
  });
});

// ─── DEBUG TRACE MẪU (chạy: GOLDEN_TRACE=1 pnpm exec vitest run ...golden...) ─

describe.runIf(process.env.GOLDEN_TRACE === "1")("Trace 5 hội thoại tiêu biểu", () => {
  it("in trace", () => {
    for (const id of ["G01", "G02", "G04", "G26", "G31"]) {
      const c = GOLDEN_CASES.find((x) => x.id === id)!;
      const before = simulateThreadStateFromHistory(c.history, { quotedCodes: c.quotedCodes ?? [], now: NOW });
      const { state, decision } = runCase(c);
      console.log(`\n──── TRACE ${c.id}: ${c.name} ────`);
      console.log(`MESSAGE        : ${c.message}`);
      console.log(`STATE BEFORE   : date=${before.slots.date_status ?? "unset"} intent=${before.serviceIntent ?? "-"} asked=${JSON.stringify(before.askedQuestions)} quoted=${before.quotedPackages.map((p) => p.code).join(",") || "-"}`);
      console.log(`STATE AFTER    : date=${state.slots.date_status ?? "unset"}${state.slots.event_date ? `(${state.slots.event_date})` : ""} intent=${state.serviceIntent ?? "-"}`);
      console.log(`ROUTER         : stage=${decision.stage} action=${decision.action} escalate=${decision.shouldEscalate}`);
      console.log(`REASON         : ${decision.reason}`);
      console.log(`ALLOWED/FORBID : allowed=[${decision.allowedQuestions.join(",")}] forbidden=[${decision.forbiddenQuestions.join(",")}]`);
      console.log(`KNOWLEDGE      : [${decision.knowledgeNeeded.join(", ")}] missing=[${decision.missingData.join(",")}]`);
    }
    expect(true).toBe(true);
  });
});
