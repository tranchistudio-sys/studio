import { describe, expect, it } from "vitest";
import {
  applyCustomerAddress,
  buildCustomerAddressRule,
  extractMoneyValues,
  guardSaleResponse,
  inferCustomerAddress,
} from "./sale-response-guard";

const context = `BẢNG GIÁ BÁN LẺ CHÍNH THỨC
[CHỤP CỔNG TẠI STUDIO]
[CG-BASIC] Chụp cổng Basic — 1.500.000đ. Gồm: 10 ảnh chỉnh, 1 váy
[CG-PREMIUM] Chụp cổng Premium — 2.500.000đ. Gồm: 20 ảnh chỉnh, 2 váy
[BEAUTY / THỜI TRANG]
[BEAUTY-01] Beauty — 900.000đ`;

describe("sale-response-guard", () => {
  it("parses common Vietnamese money formats", () => {
    expect(extractMoneyValues("1.500.000đ, 900k, 2 triệu 500, 1tr9")).toEqual([
      1_500_000, 900_000, 2_500_000, 1_900_000,
    ]);
  });

  it("allows prices grounded in the official context", () => {
    const result = guardSaleResponse({
      text: "Dạ gói Basic hiện là 1.500.000đ ạ.",
      context,
      history: [],
      customerMessage: "Chụp cổng giá bao nhiêu?",
    });
    expect(result.blocked).toBe(false);
  });

  it("answers a broad price question with one grounded starting price", () => {
    const result = guardSaleResponse({
      text: "Dạ bên em có gói Basic 1.500.000đ và Premium 2.500.000đ ạ.",
      context,
      history: [],
      customerMessage: "Chụp cổng giá bao nhiêu?",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("từ 1.500.000đ");
    expect(result.text).not.toContain("2.500.000đ");
    expect(result.violations).toContain("broad_price_answer_normalized");
  });

  it("fills a grounded starting price when the model dodges a clear price question", () => {
    const result = guardSaleResponse({
      text: "Dạ bên em có nhiều gói từ Basic đến Premium ạ.",
      context,
      history: [],
      customerMessage: "Chụp cổng bao nhiêu?",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("từ 1.500.000đ");
  });

  it("uses the locked service for a short follow-up price question", () => {
    const result = guardSaleResponse({
      text: "Mình thích tone nào hơn ạ?",
      context,
      history: [{ direction: "incoming", message: "Anh muốn chụp cổng." }],
      customerMessage: "bao nhiêu",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("chụp cổng hiện có gói từ 1.500.000đ");
  });

  it("does not reuse an older service price after the customer switches service", () => {
    const result = guardSaleResponse({
      text: "Dạ mình đang hỏi thuê váy đúng không ạ?",
      context,
      history: [{ direction: "incoming", message: "Anh muốn chụp beauty." }],
      customerMessage: "Giờ em hỏi giá thuê váy cưới.",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).not.toContain("900.000đ");
  });

  it("recommends the grounded entry price for a low-budget request", () => {
    const outdoorContext = `${context}\n[ALBUM NGOẠI CẢNH]\n[NC-BASIC] Album ngoại cảnh Basic — 7.500.000đ\n[NC-LUXURY] Album ngoại cảnh Luxury — 11.000.000đ`;
    const result = guardSaleResponse({
      text: "Dạ bên em có nhiều lựa chọn phù hợp ngân sách ạ.",
      context: outdoorContext,
      history: [],
      customerMessage: "Em muốn chụp ngoại cảnh nhưng ngân sách ít.",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("album ngoại cảnh có gói từ 7.500.000đ");
    expect(result.violations).toContain("budget_answer_normalized");
  });

  it("answers no active discount deterministically instead of escalating invented promo", () => {
    const result = guardSaleResponse({
      text: "Dạ gói này đang giảm còn 1.300.000đ ạ.",
      context,
      history: [{ direction: "incoming", message: "Anh muốn chụp cổng gói Basic." }],
      customerMessage: "Có giảm giá không?",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("chưa thấy chương trình giảm nào đang bật");
    expect(result.text).not.toContain("1.300.000đ");
    expect(result.violations).toContain("inactive_discount_answer_normalized");
  });

  it("normalizes spaced thousands separators before validating", () => {
    const result = guardSaleResponse({
      text: "Dạ gói Basic là 1. 500. 000đ ạ.",
      context,
      history: [],
      customerMessage: "Gói Basic giá bao nhiêu?",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("1.500.000đ");
  });

  it("blocks invented prices before send", () => {
    const result = guardSaleResponse({
      text: "Dạ gói này giá 1.700.000đ ạ.",
      context,
      history: [],
      customerMessage: "Chụp cổng giá bao nhiêu?",
    });
    expect(result.blocked).toBe(true);
    expect(result.violations).toContain("unverified_money:1700000");
    expect(result.escalationReason).toContain("Hậu kiểm Lulu");
  });

  it("blocks monetary answers when canonical pricing failed to load", () => {
    const result = guardSaleResponse({
      text: "Dạ giá là 1.500.000đ ạ.",
      context: "THÔNG TIN STUDIO\nBẢNG GIÁ tham khảo, liên hệ nhân viên.",
      history: [],
      customerMessage: "Bao nhiêu?",
    });
    expect(result.blocked).toBe(true);
    expect(result.violations).toContain("pricing_context_unavailable");
  });

  it("blocks stale unsolicited promotions and invented package quantities", () => {
    const promo = guardSaleResponse({
      text: "Gói này đang giảm 10% nha mình.",
      context,
      history: [],
      customerMessage: "Gói này gồm những gì?",
    });
    expect(promo.blocked).toBe(true);
    expect(promo.violations).toContain("inactive_or_unverified_promotion");

    const quantity = guardSaleResponse({
      text: "Gói Basic gồm 30 ảnh chỉnh nha mình.",
      context,
      history: [],
      customerMessage: "Gói này gồm gì?",
    });
    expect(quantity.blocked).toBe(true);
    expect(quantity.violations).toContain("unverified_package_quantity:30:anh");
  });

  it("does not borrow package quantities from another tier in the same group", () => {
    const scopedContext = `BẢNG GIÁ BÁN LẺ CHÍNH THỨC
[CHỤP CỔNG TẠI STUDIO]
[CG-BASIC] Chụp cổng Basic — 1.500.000đ
[CG-PREMIUM] Chụp cổng Premium — 2.500.000đ. Gồm: 20 ảnh chỉnh`;
    const result = guardSaleResponse({
      text: "Gói Basic gồm 20 ảnh chỉnh nha anh.",
      context: scopedContext,
      history: [{ direction: "incoming", message: "Anh muốn chụp cổng gói Basic." }],
      customerMessage: "Gói này gồm những gì?",
    });
    expect(result.blocked).toBe(true);
    expect(result.violations).toContain("unverified_package_quantity:20:anh");
  });

  it("removes fake link placeholders before the reply is shown", () => {
    const result = guardSaleResponse({
      text: "Dạ em gửi mẫu beauty ở đây [link] nha mình.",
      context,
      history: [],
      customerMessage: "Cho xem mẫu beauty.",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).not.toContain("[link]");
    expect(result.violations).toContain("fake_link_placeholder_removed");
  });

  it("infers pregnancy as female and stays neutral when unknown", () => {
    expect(inferCustomerAddress([], "Em đang bầu 7 tháng muốn chụp ảnh.")).toBe("female");
    expect(applyCustomerAddress("Dạ anh muốn chụp lúc nào ạ?", "female")).toBe("Dạ chị muốn chụp lúc nào ạ?");
    expect(inferCustomerAddress([], "Cho xem mẫu beauty.")).toBe("neutral");
    expect(buildCustomerAddressRule([], "Cho xem mẫu beauty.")).toContain("gọi trung tính là mình");
  });

  it("replaces a repeated intent confirmation with a useful next question", () => {
    const result = guardSaleResponse({
      text: "Dạ chúc mừng anh nha! Anh đang muốn chụp ảnh bầu đúng không ạ?",
      context,
      history: [],
      customerMessage: "Em đang bầu 7 tháng muốn chụp ảnh.",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("chúc mừng chị");
    expect(result.text).not.toMatch(/đúng không/iu);
    expect(result.text).toContain("nhẹ nhàng tự nhiên hay sang trọng");
    expect(result.violations).toContain("redundant_intent_question_removed");
  });

  it("removes repeated date questions and limits the turn to one question", () => {
    const result = guardSaleResponse({
      text: "Dạ em hiểu ạ. Anh dự định chụp khi nào? Anh thích tone nào? Anh muốn xem mẫu không?",
      context,
      history: [{ direction: "incoming", message: "Anh chụp ngày 20/8 nha" }],
      customerMessage: "Anh đã nói ngày chụp rồi mà.",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).not.toMatch(/khi nào/iu);
    expect((result.text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("removes a repeated question even when the model paraphrases it", () => {
    const result = guardSaleResponse({
      text: "Dạ em hiểu. Mình thích phong cách nhẹ nhàng hay sang trọng hơn ạ?",
      context,
      history: [{ direction: "outgoing", message: "Mình thích tone nhẹ nhàng hay sang trọng hơn ạ?" }],
      customerMessage: "Em nói rồi mà.",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).not.toContain("?");
    expect(result.violations).toContain("repeated_question_removed");
  });

  it("removes empty sales praise and a premature booking question", () => {
    const result = guardSaleResponse({
      text: "Dạ gói Premium là lựa chọn tuyệt vời ạ. Giá gói là 2.500.000đ. Mình có muốn giữ lịch cho gói này không?",
      context,
      history: [{ direction: "incoming", message: "Anh muốn chụp cổng." }],
      customerMessage: "Anh muốn hình ảnh chỉn chu hơn.",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toMatch(/gói Premium phù hợp hơn/iu);
    expect(result.text).toContain("2.500.000đ");
    expect(result.text).not.toMatch(/tuyệt vời|giữ lịch|\?/iu);
    expect(result.violations).toContain("sales_cliche_removed");
    expect(result.violations).toContain("premature_close_question_removed");
  });

  it("keeps a package recommendation direct without another question or booking push", () => {
    const workflowContext = `${context}\n\nWORKFLOW SALE BAT BUOC\n- Stage: RECOMMEND_PACKAGE\n- Action this turn: CONTINUE_CONVERSATION`;
    const result = guardSaleResponse({
      text: "Dạ gói Premium 2.500.000đ sẽ rất phù hợp với nhu cầu của mình. Mình thấy gói này ổn không ạ? Nếu đồng ý, mình có thể giữ lịch chụp.",
      context: workflowContext,
      history: [{ direction: "incoming", message: "Anh muốn chụp cổng." }],
      customerMessage: "Anh muốn hình ảnh chỉn chu hơn.",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("gói Premium 2.500.000đ");
    expect(result.text).not.toMatch(/rất phù hợp|giữ lịch|\?/iu);
    expect(result.violations).toContain("sales_cliche_removed");
    expect(result.violations).toContain("premature_close_question_removed");
    expect(result.violations).toContain("unnecessary_question_removed");
  });

  it("blocks service drift for a locked intent", () => {
    const result = guardSaleResponse({
      text: "Dạ beauty bên em đẹp lắm. Mình có muốn xem album cưới không?",
      context,
      history: [{ direction: "incoming", message: "Anh muốn chụp cool boy." }],
      customerMessage: "Tone lạnh nha",
    });
    expect(result.blocked).toBe(true);
    expect(result.violations.some((v) => v.startsWith("service_drift:"))).toBe(true);
  });

  it("strips markdown-like output", () => {
    const result = guardSaleResponse({
      text: "**Dạ mình xem hai lựa chọn nha:**\n- Basic\n- Premium",
      context,
      history: [],
      customerMessage: "Cho xem lựa chọn.",
    });
    expect(result.blocked).toBe(false);
    expect(result.text).not.toContain("**");
    expect(result.text).not.toMatch(/^-/m);
  });
});
