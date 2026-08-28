import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import {
  bindWeddingGateDraftRow,
  preventRawPlaceholderLeak,
  selectSaleScriptResponse,
  type SaleScriptQuestionAnswerSheets,
} from "./sale-script-registry";
import { evaluateSaleWorkflow } from "./sale-workflow";
import type { SaleHistoryItem } from "./sale-price-sheet";
import { BRAIN_LAB_DRY_RUN_SIDE_EFFECTS } from "./sale-brain-runner";

const row = (id: string, stepId: number, question: string, answer: string) => ({
  id, stepId, question, answer, source: "manual" as const, updatedAt: "2026-08-28T00:00:00.000Z",
});

const draftSheets: SaleScriptQuestionAnswerSheets = {
  SALE_WEDDING_GATE: [
    row("gate-1", 1, "Bên mình có chụp cổng không?", "Dạ có mình nha. Mình cần một cổng hay hai cổng ạ?"),
    row("gate-2", 2, "Cho xem mẫu.", "Dạ em gửi mẫu {{STYLE}} cho mình nha."),
    row("gate-3", 3, "Giá sao?", "Dạ em gửi bảng giá hiện hành: {{RETAIL_PACKAGE_LIST}}"),
    row("gate-4", 4, "Basic với Premium khác gì?", "Dạ em so đúng hai gói từ bảng hiện hành nha."),
    row("gate-5", 5, "Có khuyến mãi không?", "Dạ em kiểm tra quà đang áp dụng: {{PROMOTION_REPLY}}"),
    row("gate-6", 6, "Mắc quá.", "Dạ em hiểu phần ngân sách, mình không cần cố lên gói cao hơn nha."),
    row("gate-7", 7, "Em chọn giúp chị.", "Dạ em chọn một gói theo đúng nhu cầu mình đã nói nha."),
    row("gate-8", 8, "Chốt Premium.", "Dạ em ghi nhận Premium và chỉ mô phỏng bước chuyển nhân viên nha."),
    row("gate-9", 9, "Liên hệ chị tuần sau.", "Dạ em ghi nhận đề nghị liên hệ lại, Brain Lab chỉ mô phỏng nha."),
  ],
  "COMMON.GREETING": [
    row("common-address", 1, "Tiệm ở đâu?", "Dạ Amazing Studio ở Tây Ninh ạ."),
  ],
};

function route(message: string, prior: SaleHistoryItem[] = []) {
  const workflowBefore = evaluateSaleWorkflow({ message: "", prior });
  const workflow = evaluateSaleWorkflow({ message, prior });
  const structural = selectSaleScriptResponse({
    message, workflow, workflowBefore, questionAnswerSheets: draftSheets,
  });
  return {
    workflow,
    trace: bindWeddingGateDraftRow(structural, message, draftSheets),
  };
}

describe("Wedding Gate pilot integration", () => {
  it("keeps every production side effect at zero in Brain Lab", () => {
    expect(BRAIN_LAB_DRY_RUN_SIDE_EFFECTS).toEqual({
      messengerOutbound: 0,
      bookingsCreated: 0,
      paymentsCreated: 0,
      depositsMutated: 0,
      revenueMutated: 0,
    });
  });
  it.each([
    ["Bên mình có chụp cổng không?", 1, "gate-1"],
    ["Cho xem mẫu.", 2, "gate-2"],
    ["Giá sao?", 3, "gate-3"],
    ["Basic với Premium khác gì?", 4, "gate-4"],
    ["Có khuyến mãi không?", 5, "gate-5"],
    ["Mắc quá.", 6, "gate-6"],
    ["Em chọn giúp chị.", 7, "gate-7"],
    ["Chốt Premium.", 8, "gate-8"],
    ["Liên hệ chị tuần sau.", 9, "gate-9"],
  ])("routes %s to its one owner and binds the draft row", (message, step, id) => {
    const prior: SaleHistoryItem[] = message === "Bên mình có chụp cổng không?" ? [] : [
      { direction: "incoming", message: "Bên mình có chụp cổng không?" },
      { direction: "outgoing", message: "Dạ em đang tư vấn chụp cổng cho mình nha." },
    ];
    const result = route(message, prior).trace;
    expect(result.scriptKey).toBe("SALE_WEDDING_GATE");
    expect(result.stepNumber).toBe(step);
    expect(result.matchedQuestionAnswerId).toBe(id);
    expect(result.responseSource).toBe("SALE_SCRIPT_DRAFT_ROW");
  });

  it("keeps Wedding Gate context through a COMMON address owner", () => {
    const prior: SaleHistoryItem[] = [
      { direction: "incoming", message: "Chụp cổng giá sao?" },
      { direction: "outgoing", message: "Dạ em đang tư vấn chụp cổng cho mình nha." },
    ];
    const common = route("Tiệm ở đâu?", prior).trace;
    expect(common.scriptKey).toBe("SALE_COMMON");
    expect(common.renderedText).toContain("Tây Ninh");
    expect(common.stateAfter.serviceIntent).toBe("wedding_gate");

    const returned = route("Premium bao nhiêu?", [
      ...prior,
      { direction: "incoming", message: "Tiệm ở đâu?" },
      { direction: "outgoing", message: common.renderedText },
    ]).trace;
    expect(returned.scriptKey).toBe("SALE_WEDDING_GATE");
    expect(returned.stepNumber).toBe(3);
  });

  it("switches Wedding Gate to Album and restores Wedding Gate when explicitly requested", () => {
    const gate: SaleHistoryItem[] = [{ direction: "incoming", message: "Chụp cổng giá sao?" }];
    const album = evaluateSaleWorkflow({ message: "Bên mình có album studio không?", prior: gate });
    expect(album.serviceKey).toBe("album_studio");
    expect(album.requestedAction).toBe("service_switch");

    const restored = evaluateSaleWorkflow({
      message: "Quay lại gói cổng lúc nãy.",
      prior: [...gate, { direction: "incoming", message: "Bên mình có album studio không?" }],
    });
    expect(restored.serviceKey).toBe("wedding_gate");
    expect(restored.requestedAction).toBe("service_switch");
  });

  it("blocks every unresolved raw placeholder before customer output", () => {
    const draft = route("Giá sao?", [
      { direction: "incoming", message: "Bên mình có chụp cổng không?" },
    ]).trace;
    const leaked = { ...draft, renderedText: "Giá: {{RETAIL_PACKAGE_LIST}} / {{PENDING_QUESTION}}" };
    const safe = preventRawPlaceholderLeak(leaked);
    expect(safe.renderedText).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(safe.stateAfter.humanHandoff).toBe(true);
    expect(safe.validatorResults).toContainEqual(expect.objectContaining({ name: "no_raw_placeholder", passed: false }));
  });
});
