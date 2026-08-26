import { describe, expect, it, vi } from "vitest";
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import {
  getScriptCatalog,
  selectSaleScriptResponse,
  type SaleScriptQuestionAnswerSheets,
} from "./sale-script-registry";
import { evaluateSaleWorkflow, type SaleWorkflowDecision } from "./sale-workflow";
import type { SaleHistoryItem } from "./sale-price-sheet";

function trace(
  message: string,
  prior: SaleHistoryItem[] = [],
  questionAnswerSheets?: SaleScriptQuestionAnswerSheets,
) {
  const workflowBefore = evaluateSaleWorkflow({ message: "", prior });
  const workflow = evaluateSaleWorkflow({ message, prior });
  return {
    workflow,
    result: selectSaleScriptResponse({
      message,
      workflow,
      workflowBefore,
      questionAnswerSheets,
    }),
  };
}

describe("SALE_WEDDING_GATE v1", () => {
  it("exposes every sale step in the wedding-gate script catalog", () => {
    const script = getScriptCatalog().find((item) => item.scriptKey === "SALE_WEDDING_GATE");

    expect(script).toBeDefined();
    expect(new Set(script?.nodes.map((node) => node.stepNumber))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    expect(script?.nodes.find((node) => node.stepNumber === 1)?.nodeKey).toBe("COMMON.GREETING");
  });

  it("traces every turn in the required regression conversation", () => {
    const history: SaleHistoryItem[] = [];

    const greeting = trace("hi", history);
    expect(greeting.result.nodeKey).toBe("COMMON.GREETING");
    expect(greeting.result.renderedText).toContain("dịch vụ nào");
    history.push({ direction: "incoming", message: "hi" }, { direction: "outgoing", message: greeting.result.renderedText, aiDecision: greeting.result.nodeKey });

    const confirm = trace("bên bạn có chụp cổng ko?", history);
    expect(confirm.result.nodeKey).toBe("WEDDING_GATE.DISCOVERY.CONFIRM_SERVICE");
    expect(confirm.result.stateAfter.pendingQuestion).toBe("gate_count");
    expect(confirm.result.renderedText).toContain("Dạ có mình nha");
    history.push({ direction: "incoming", message: "bên bạn có chụp cổng ko?" }, { direction: "outgoing", message: confirm.result.renderedText, aiDecision: confirm.result.nodeKey });

    const explain = trace("nghĩa là sao ạ", history);
    expect(explain.workflow.action).toBe("EXPLAIN_PENDING");
    expect(explain.result.nodeKey).toBe("WEDDING_GATE.DISCOVERY.EXPLAIN_PENDING");
    expect(explain.result.nodeKey).not.toContain("SAMPLE");
    history.push({ direction: "incoming", message: "nghĩa là sao ạ" }, { direction: "outgoing", message: explain.result.renderedText, aiDecision: explain.result.nodeKey });

    const price = trace("giá nhiêu ạ", history);
    expect(price.workflow.action).toBe("SEND_PRICE_SHEET");
    expect(price.result.nodeKey).toBe("WEDDING_GATE.PRICING.SEND_RETAIL_PRICE");
    expect(price.result.stepNumber).toBe(4);
    history.push({ direction: "incoming", message: "giá nhiêu ạ" }, { direction: "outgoing", message: "[image:/objects/gate-price]", aiDecision: "price_sheet" }, { direction: "outgoing", message: "Bảng giá chụp cổng", aiDecision: "price_sheet" });

    const captureStyle = trace("tinh tế", history);
    expect(captureStyle.result.nodeKey).toBe("WEDDING_GATE.DISCOVERY.CAPTURE_STYLE");
    expect(captureStyle.result.renderedText).toContain("Em ghi nhận gu này rồi");
    expect(captureStyle.result.renderedText).not.toContain("Em nhớ phần mình đã trao đổi");
    history.push({ direction: "incoming", message: "tinh tế" }, { direction: "outgoing", message: captureStyle.result.renderedText, aiDecision: captureStyle.result.nodeKey });

    const next = trace("RỒI SAO NỮA", history);
    expect(next.workflow.stage).toBe("RECOMMEND_PACKAGE");
    expect(next.result.nodeKey).toBe("WEDDING_GATE.CLOSING.CONFIRM_PACKAGE");
    expect(next.result.status).toBe("MAPPED");
  });

  it("allows direct price and direct samples without letting a price turn select samples", () => {
    const price = trace("chụp cổng giá bao nhiêu?");
    expect(price.result.nodeKey).toBe("WEDDING_GATE.PRICING.SEND_RETAIL_PRICE");
    expect(price.result.stepNumber).toBe(4);
    expect(price.result.renderedText).toContain("bảng giá chụp cổng");

    const samples = trace("chụp cổng cho xem mẫu");
    expect(samples.result.nodeKey).toBe("WEDDING_GATE.SAMPLE.SEND_MATCHED");
    expect(samples.result.dataSources).toContain("image_store:wedding_gate");
  });

  it("routes every recognized service without asking the service question again", () => {
    const album = trace("cho mình hỏi album studio");
    expect(album.result.status).toBe("MAPPED");
    expect(album.result.nodeKey).toBe("COMMON.SERVICE_ROUTING.MATCHED");
    expect(album.result.routeKey).toBe("SALE_STUDIO_ALBUM");
    expect(album.result.stateAfter.serviceType).toBe("STUDIO_ALBUM");
    expect(album.result.stateAfter.askedServiceQuestion).toBe(false);
  });

  it("asks one focused clarification for a generic wedding request", () => {
    const generic = trace("Em muốn chụp hình cưới");
    expect(generic.result.nodeKey).toBe("COMMON.SERVICE_ROUTING.WEDDING_CLARIFY");
    expect(generic.result.stateAfter.serviceCandidates).toEqual([
      "WEDDING_GATE",
      "STUDIO_ALBUM",
      "OUTDOOR_ALBUM",
    ]);
    expect(generic.result.renderedText).toContain("album ngoại cảnh");
  });

  it("does not randomly select one route when several services are requested", () => {
    const multiple = trace("Cho em hỏi chụp cổng với album ngoại cảnh");
    expect(multiple.result.nodeKey).toBe("COMMON.SERVICE_ROUTING");
    expect(multiple.result.routeKey).toBeNull();
    expect(multiple.result.decisionRule).toBe("multiple_services_ask_which_to_view_first");
  });

  it("hands off instead of asking the service question repeatedly", () => {
    const prior: SaleHistoryItem[] = [
      { direction: "outgoing", message: "Dạ mình đang quan tâm dịch vụ nào ạ?", aiDecision: "COMMON.SERVICE_ROUTING" },
    ];
    const unresolved = trace("Em chưa biết nữa", prior);
    expect(unresolved.result.nodeKey).toBe("COMMON.HANDOFF.UNMAPPED_REQUEST");
    expect(unresolved.result.status).toBe("UNMAPPED_RESPONSE");
    expect(unresolved.result.decisionRule).toBe("service_still_unknown_after_one_question");
  });

  it("uses a saved greeting row for a longer natural-language variation", () => {
    const sheets: SaleScriptQuestionAnswerSheets = {
      "COMMON.GREETING": [{
        id: "greeting-chao-shop",
        stepId: 1,
        question: "Chào shop",
        answer: "Dạ em đây ạ, em hỗ trợ mình nha.",
        source: "manual",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }],
    };

    const matched = trace("chào buổi trưa nha shop", [], sheets);
    expect(matched.result.nodeKey).toBe("COMMON.GREETING");
    expect(matched.result.renderedText).toBe("Dạ em đây ạ, em hỗ trợ mình nha.");
    expect(matched.result.decisionRule).toContain("question_answer_greeting_match:greeting-chao-shop");
  });

  it("keeps saved greeting rows testable after an earlier greeting turn", () => {
    const sheets: SaleScriptQuestionAnswerSheets = {
      "COMMON.GREETING": [{
        id: "greeting-chao-shop",
        stepId: 1,
        question: "Chào shop",
        answer: "Dạ em nghe mình nè.",
        source: "manual",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }],
    };
    const prior: SaleHistoryItem[] = [
      { direction: "incoming", message: "Alo" },
      { direction: "outgoing", message: "Dạ mình đang quan tâm dịch vụ nào ạ?", aiDecision: "COMMON.GREETING" },
    ];

    const matched = trace("chào buổi trưa nha shop", prior, sheets);
    expect(matched.result.status).toBe("MAPPED");
    expect(matched.result.renderedText).toBe("Dạ em nghe mình nè.");
    expect(matched.result.nodeKey).toBe("COMMON.GREETING");
  });

  it("uses the saved routing row answer and configured route", () => {
    const sheets: SaleScriptQuestionAnswerSheets = {
      "COMMON.SERVICE_ROUTING": [{
        id: "routing-profile",
        stepId: 1,
        question: "Mình cần bộ ảnh profile công việc",
        answer: "Dạ em chuyển mình sang phần tư vấn ảnh profile nha.",
        serviceKey: "beauty",
        routeKey: "SALE_BEAUTY",
        source: "manual",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }],
    };

    const matched = trace("mình cần bộ ảnh profile cho công việc", [], sheets);
    expect(matched.result.nodeKey).toBe("COMMON.SERVICE_ROUTING.MATCHED");
    expect(matched.result.routeKey).toBe("SALE_BEAUTY");
    expect(matched.result.renderedText).toBe("Dạ em chuyển mình sang phần tư vấn ảnh profile nha.");
  });

  it("does not use a saved routing row until its service is configured", () => {
    const sheets: SaleScriptQuestionAnswerSheets = {
      "COMMON.SERVICE_ROUTING": [{
        id: "routing-draft",
        stepId: 1,
        question: "Mình cần chụp profile công việc",
        answer: "Câu trả lời đang soạn dở.",
        source: "manual",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }],
    };

    const matched = trace("mình cần chụp profile cho công việc", [], sheets);
    expect(matched.result.renderedText).not.toBe("Câu trả lời đang soạn dở.");
    expect(matched.result.decisionRule).not.toContain("routing-draft");
  });
});
