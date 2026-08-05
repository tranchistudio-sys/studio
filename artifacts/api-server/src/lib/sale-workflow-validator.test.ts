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

  it("Regression review #137: giảm-còn hợp lệ / mức giảm / giá không đơn vị / rưỡi / drift-gate / leak", () => {
    // "giảm còn <finalPrice>" + catalog → PASS (promo thật, số đã qua rule 4).
    expect(validateSaleReply({
      threadState: state(), decision: decision(),
      reply: "Dạ gói này đang chương trình ưu đãi, giảm còn 3.500.000đ ạ", catalog: CATALOG,
    }).verdict).toBe("PASS");
    // Mức giảm (price − finalPrice = 400k? no: 3.9-3.5=400.000) là số hợp lệ.
    expect(validateSaleReply({
      threadState: state(), decision: decision(),
      reply: "Đang ưu đãi giảm 400.000đ, còn 3.500.000đ (giá gốc 3.900.000đ) ạ", catalog: CATALOG,
    }).verdict).toBe("PASS");
    // "giảm còn" KHÔNG kèm catalog/số → vẫn block (hứa suông).
    expect(validateSaleReply({
      threadState: state(), decision: decision(), reply: "Để em giảm còn xíu cho mình nha",
    }).verdict).toBe("BLOCK");
    // Giá KHÔNG kèm đơn vị "2.500.000" giờ bị bắt (lỗ giá bịa đã vá).
    const r1 = validateSaleReply({
      threadState: state(), decision: decision(), reply: "Dạ gói này bên em 2.500.000 ạ", catalog: CATALOG,
    });
    expect(r1.verdict).toBe("BLOCK");
    if (r1.verdict === "BLOCK") expect(r1.violatedRule).toBe("price_mismatch");
    // "3 triệu rưỡi" = 3.500.000 (finalPrice) → PASS.
    expect(validateSaleReply({
      threadState: state(), decision: decision(), reply: "Dạ gói đang ưu đãi 3 triệu rưỡi ạ", catalog: CATALOG,
    }).verdict).toBe("PASS");
    // Drift-gate: chưa khóa nhu cầu + router yêu cầu hỏi dịch vụ → KHÔNG chặn câu hỏi đó.
    expect(validateSaleReply({
      threadState: state(), decision: decision({ action: "ASK_SERVICE" }),
      reply: "Dạ mình đang muốn chụp gì ạ — chụp cưới, gia đình hay bé ạ?",
    }).verdict).toBe("PASS");
    expect(validateSaleReply({
      threadState: state(), decision: decision({ action: "GREET" }),
      reply: "Dạ em chào chị ạ! Chị muốn chụp gì để em tư vấn đúng nhất ạ?",
    }).verdict).toBe("PASS");
    // "không có đâu ạ" với intent beauty — hết bị bắt oan offintent:co dau.
    expect(validateSaleReply({
      threadState: state({ serviceIntent: "beauty" }), decision: decision(),
      reply: "Dạ không có đâu ạ, gói đã bao gồm makeup rồi ạ",
    }).verdict).toBe("PASS");
    // Leak marker nội bộ → BLOCK critical.
    const r2 = validateSaleReply({
      threadState: state(), decision: decision(), reply: "Dạ em gửi giá nha <<PRICE_IMAGE: ST-BASIC>>",
    });
    expect(r2.verdict).toBe("BLOCK");
    if (r2.verdict === "BLOCK") expect(r2.violatedRule).toBe("leak_internal");
    // Escalate nhưng vẫn cố bán → BLOCK.
    const r3 = validateSaleReply({
      threadState: state(), decision: decision({ action: "ESCALATE_HUMAN", shouldEscalate: true }),
      reply: "Dạ em báo nhân viên nha. Mà gói này 3.900.000đ ạ, mình lấy không ạ?", catalog: CATALOG,
    });
    expect(r3.verdict).toBe("BLOCK");
    // Escalate + câu giữ khách chuẩn → PASS.
    expect(validateSaleReply({
      threadState: state(), decision: decision({ action: "ESCALATE_HUMAN", shouldEscalate: true }),
      reply: "Dạ để em báo nhân viên bên em liên hệ mình ngay nha.",
    }).verdict).toBe("PASS");
  });

  it("Ma trận 30 case PASS/BLOCK (đủ ≥50 case validator tổng)", () => {
    const cases: Array<{ reply: string; d?: Partial<RouterDecision>; s?: Partial<ThreadState>; cat?: CatalogItem[]; want: "PASS" | "BLOCK" }> = [
      // Giá đúng các định dạng
      { reply: "Gói cổng 1.900.000đ ạ", cat: CATALOG, want: "PASS" },
      { reply: "Gói cổng 1.900.000 nha", cat: CATALOG, want: "PASS" },
      { reply: "Dạ 3tr9 ạ", cat: CATALOG, want: "PASS" },
      { reply: "Khoảng 3,9 triệu ạ", cat: CATALOG, want: "PASS" },
      { reply: "Đang ưu đãi còn 3,5 triệu", cat: CATALOG, want: "PASS" },
      // Giá sai các định dạng
      { reply: "Chỉ 2tr9 thôi ạ", cat: CATALOG, want: "BLOCK" },
      { reply: "Dạ 4.200.000đ ạ", cat: CATALOG, want: "BLOCK" },
      { reply: "Tầm 950k ạ", cat: CATALOG, want: "BLOCK" },
      { reply: "Dạ 2 triệu rưỡi ạ", cat: CATALOG, want: "BLOCK" },
      // Không catalog → không check giá
      { reply: "Dạ tầm 5 triệu ạ", want: "PASS" },
      // Số không phải tiền → không dính
      { reply: "Nhà mình 2-3 người chụp thoải mái ạ", cat: CATALOG, want: "PASS" },
      { reply: "Mình chụp ngày 20/12 nha", cat: CATALOG, want: "PASS" },
      { reply: "Bé 3 tháng 10 ngày chụp được nha mình", cat: CATALOG, want: "PASS" },
      // Tự giảm giá
      { reply: "Em bớt cho chị 100k nha", want: "BLOCK" },
      { reply: "Shop giảm riêng cho mình nha", want: "BLOCK" },
      { reply: "Em tặng riêng mình voucher nha", want: "BLOCK" },
      // Hỏi ngày khi cấm
      { reply: "Mình định chụp ngày nào ạ?", d: { forbiddenQuestions: ["ask_date"] }, want: "BLOCK" },
      { reply: "Dạ em gửi giá tham khảo trước nha.", d: { forbiddenQuestions: ["ask_date"] }, want: "PASS" },
      // Lặp câu hỏi (count>=2)
      { reply: "Anh chụp khi nào ạ?", s: { askedQuestions: [{ key: "ask_date", at: AT, count: 2 }] }, want: "BLOCK" },
      // Action mismatch
      { reply: "Em gửi mẫu nè. Mình chụp ngày nào ạ?", d: { action: "SEND_SAMPLE" }, want: "BLOCK" },
      { reply: "Em gửi mẫu mình xem nha.", d: { action: "SEND_SAMPLE" }, want: "PASS" },
      // Drift khi ĐÃ khóa
      { reply: "Bên em có gói chụp cưới cô dâu chú rể đẹp lắm", s: { serviceIntent: "beauty" }, want: "BLOCK" },
      { reply: "Tone beauty nhẹ nhàng hợp mình nè", s: { serviceIntent: "beauty" }, want: "PASS" },
      // Quá nhiều câu hỏi
      { reply: "Tone nào ạ? Studio hay ngoại cảnh ạ? Mấy người ạ?", want: "BLOCK" },
      { reply: "Mình thích tone nhẹ nhàng hay sang trọng hơn ạ?", want: "PASS" },
      // Leak
      { reply: "TRẠNG THÁI KHÁCH: khách chưa chốt ngày", want: "BLOCK" },
      { reply: "<<NEEDS_HUMAN: check>> Dạ em xem nha", want: "BLOCK" },
      // Escalate hợp lệ / vi phạm
      { reply: "Dạ em chuyển thông tin cho nhân viên liên hệ mình ngay ạ.", d: { action: "ESCALATE_HUMAN", shouldEscalate: true }, want: "PASS" },
      { reply: "Nhân viên sẽ gọi ạ. Mà mình thích gói nào ạ? Chụp mấy người ạ?", d: { action: "ESCALATE_HUMAN", shouldEscalate: true }, want: "BLOCK" },
      // Câu tư vấn thường sạch
      { reply: "Dạ bên em có cổng, album với ngoại cảnh ạ. Mình thích dạng nào hơn ạ?", s: { serviceIntent: "wedding_album" }, want: "PASS" },
    ];
    for (const c of cases) {
      const r = validateSaleReply({
        threadState: state(c.s ?? {}),
        decision: decision(c.d ?? {}),
        reply: c.reply,
        catalog: c.cat,
      });
      expect(r.verdict, c.reply).toBe(c.want);
    }
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

// ─── STATIC-vs-DYNAMIC: CRM là nguồn sự thật, kịch bản KHÔNG override (luật chủ) ──
describe("Validator STATIC-vs-DYNAMIC — CRM authoritative", () => {
  const base = { threadState: state({ serviceIntent: "wedding_album" }), decision: decision({ action: "QUOTE_REFERENCE" }) };
  // CRM hiện tại: giá thường 9.5tr (không promo).
  const CRM_NOW: CatalogItem[] = [{ code: "AL", name: "Album", price: 9_500_000, finalPrice: null }];

  it("TEST6: fail-CLOSED — reply có giá nhưng KHÔNG load được CRM → BLOCK (không fail-open)", () => {
    const r = validateSaleReply({ ...base, reply: "Dạ gói này 8.900.000đ ạ", catalog: undefined, catalogAuthoritative: true });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("price_unverifiable");
  });

  it("Không authoritative + không catalog → BỎ QUA check giá (back-compat, không chặn oan)", () => {
    const r = validateSaleReply({ ...base, reply: "Dạ gói này 8.900.000đ ạ", catalog: undefined });
    expect(r.verdict).toBe("PASS");
  });

  it("TEST1: kịch bản ghi 8.9tr, CRM 9.5tr → reply lặp 8.9tr bị BLOCK price_mismatch", () => {
    const r = validateSaleReply({ ...base, reply: "Dạ gói này hiện bên em là 8.900.000đ ạ", catalog: CRM_NOW, catalogAuthoritative: true });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("price_mismatch");
  });

  it("TEST1 (mặt đúng): reply dùng đúng giá CRM 9.5tr → PASS", () => {
    const r = validateSaleReply({ ...base, reply: "Dạ gói này hiện bên em là 9.500.000đ ạ", catalog: CRM_NOW, catalogAuthoritative: true });
    expect(r.verdict).toBe("PASS");
  });

  it("TEST2: CRM tắt promo (promoActive=false) → reply nói 'đang có ưu đãi' bị BLOCK promo_not_active", () => {
    const r = validateSaleReply({ ...base, reply: "Dạ bên em đang có ưu đãi cho mình nha", catalog: CRM_NOW, catalogAuthoritative: true, promoActive: false });
    expect(r.verdict).toBe("BLOCK");
    if (r.verdict === "BLOCK") expect(r.violatedRule).toBe("promo_not_active");
  });

  it("TEST2 (phủ định OK): CRM tắt promo nhưng reply nói 'hiện chưa có ưu đãi' → PASS", () => {
    const r = validateSaleReply({ ...base, reply: "Dạ hiện bên em chưa có ưu đãi ạ, giá gói là 9.500.000đ nha", catalog: CRM_NOW, catalogAuthoritative: true, promoActive: false });
    expect(r.verdict).toBe("PASS");
  });

  it("TEST3: CRM bật promo (promoActive=true) → reply nói 'đang ưu đãi' KHÔNG bị chặn theo promo", () => {
    const PROMO: CatalogItem[] = [{ code: "AL", name: "Album", price: 10_000_000, finalPrice: 8_900_000 }];
    const r = validateSaleReply({ ...base, reply: "Dạ đang có ưu đãi, giá còn 8.900.000đ ạ", catalog: PROMO, catalogAuthoritative: true, promoActive: true });
    expect(r.verdict).toBe("PASS");
  });
});
