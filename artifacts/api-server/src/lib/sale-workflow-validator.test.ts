import { describe, it, expect } from "vitest";
import { validateSaleReply, extractMoneyVnd, countQuestions, type CatalogItem } from "./sale-workflow-validator";
import type { RouterDecision } from "./sale-workflow";
import type { ThreadState } from "./sale-thread-state";

const AT = "2026-07-28T10:00:00.000Z";

function state(over: Partial<ThreadState> = {}): ThreadState {
  return {
    facebookUserId: "t", currentStage: "new", previousStage: null, serviceIntent: null,
    customerStatus: "lead", lastAction: null, slots: {}, askedQuestions: [], quotedPackages: [],
    sentAssets: {}, lastUserMessageAt: null, lastBotMessageAt: null, version: 0, ...over,
  };
}

function decision(over: Partial<RouterDecision> = {}): RouterDecision {
  return {
    stage: "CONSULTING", action: "ANSWER_FAQ", reason: "test", requiredData: [], missingData: [],
    allowedQuestions: [], forbiddenQuestions: [], knowledgeNeeded: [], shouldEscalate: false, ...over,
  };
}

const CATALOG: CatalogItem[] = [
  { code: "ST-BASIC", name: "Album cơ bản", price: 3_900_000, finalPrice: 3_500_000 },
  { code: "CG-BASIC", name: "Cổng cơ bản", price: 1_900_000 },
];

describe("extractMoneyVnd", () => {
  it("bắt đủ các dạng tiền Việt", () => {
    expect(extractMoneyVnd("gói này 3.900.000đ ạ")).toEqual([3_900_000]);
    expect(extractMoneyVnd("chỉ 3tr9 thôi ạ")).toEqual([3_900_000]);
    expect(extractMoneyVnd("phụ thu 800k")).toEqual([800_000]);
    expect(extractMoneyVnd("khoảng 3,5 triệu")).toEqual([3_500_000]);
  });
  it("KHÔNG bắt số trần không đơn vị (2-3 người, ngày 20/12)", () => {
    expect(extractMoneyVnd("nhà mình 2-3 người, chụp 20/12 nha")).toEqual([]);
  });
});

describe("validateSaleReply — từng rule", () => {
  it("PASS: reply chuẩn (giá đúng catalog, 1 câu hỏi, đúng nhóm)", () => {
    const r = validateSaleReply({
      threadState: state({ serviceIntent: "wedding_album" }),
      decision: decision({ action: "QUOTE_REFERENCE", forbiddenQuestions: ["ask_date"] }),
      reply: "Dạ gói album bên em 3.900.000đ ạ. Khi mình có ngày cụ thể em kiểm tra lịch xác nhận lại cho mình nha. Mình thích tone nhẹ nhàng hay sang trọng ạ?",
      catalog: CATALOG,
    });
    expect(r.verdict).toBe("PASS");
  });

  it("BLOCK forbidden_ask_date: hỏi ngày khi đang cấm", () => {
    const r = validateSaleReply({
      threadState: state(),
      decision: decision({ forbiddenQuestions: ["ask_date"] }),
      reply: "Dạ em gửi giá nha. Mà mình định chụp khi nào ạ?",
    });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("forbidden_ask_date");
  });

  it("BLOCK repeated_question: đã hỏi ngày 2 lần vẫn hỏi tiếp", () => {
    const r = validateSaleReply({
      threadState: state({ askedQuestions: [{ key: "ask_date", at: AT, count: 2 }] }),
      decision: decision(),
      reply: "Anh dự định chụp khi nào ạ?",
    });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("repeated_question");
  });

  it("BLOCK response_not_matching_action: router không chọn ASK_DATE mà reply chèn câu hỏi ngày", () => {
    const r = validateSaleReply({
      threadState: state(),
      decision: decision({ action: "SEND_SAMPLE" }),
      reply: "Em gửi mẫu nha. Mình định chụp ngày nào ạ?",
    });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("response_not_matching_action");
  });

  it("BLOCK price_mismatch: số tiền không có trong catalog (Price Accuracy gate)", () => {
    const r = validateSaleReply({
      threadState: state(),
      decision: decision(),
      reply: "Gói này bên em 3tr2 thôi ạ",
      catalog: CATALOG,
    });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("price_mismatch");
  });

  it("PASS giá sau ưu đãi trong catalog (finalPrice)", () => {
    const r = validateSaleReply({
      threadState: state(),
      decision: decision(),
      reply: "Đang ưu đãi còn 3,5 triệu ạ",
      catalog: CATALOG,
    });
    expect(r.verdict).toBe("PASS");
  });

  it("BLOCK self_discount: bot tự bớt giá", () => {
    const r = validateSaleReply({
      threadState: state(),
      decision: decision(),
      reply: "Thôi em bớt cho chị chút xíu nha, đừng nói ai",
    });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("self_discount");
  });

  it("BLOCK service_drift: khách beauty mà reply lôi cưới ra", () => {
    const r = validateSaleReply({
      threadState: state({ serviceIntent: "beauty" }),
      decision: decision(),
      reply: "Bên em còn có album chụp cưới cô dâu đẹp lắm nè",
    });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("service_drift");
  });

  it("BLOCK too_many_questions: 3 câu hỏi một lượt", () => {
    const r = validateSaleReply({
      threadState: state(),
      decision: decision(),
      reply: "Mình thích tone nào ạ? Chụp trong studio hay ngoại cảnh ạ? Đi mấy người ạ?",
    });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("too_many_questions");
    expect(countQuestions("a? b? c?")).toBe(3);
  });

  it("Validator Catch Rate: 100% các reply lỗi trong bộ này bị chặn", () => {
    const bad = [
      { reply: "Mình định chụp khi nào ạ?", d: decision({ forbiddenQuestions: ["ask_date"] }), catalog: undefined },
      { reply: "Gói này 2tr2 ạ", d: decision(), catalog: CATALOG },
      { reply: "Em giảm còn 3 triệu cho mình nha", d: decision(), catalog: undefined },
    ];
    const caught = bad.filter((b) =>
      validateSaleReply({ threadState: state(), decision: b.d, reply: b.reply, catalog: b.catalog }).verdict === "BLOCK",
    );
    expect(caught.length).toBe(bad.length);
  });
});
