import { describe, it, expect } from "vitest";
import { formatVnd, replacePricesWith, stripPromoClaims, stitchReplyFromGolden } from "./sale-reply-stitch";
import { extractMoneyVnd } from "./sale-workflow-validator";

/**
 * STATIC-vs-DYNAMIC (luật chủ mục K): kịch bản = CÁCH NÓI (static), giá = CRM (dynamic).
 * Chứng minh: giữ cách nói của kịch bản, THAY con số cũ bằng giá CRM hiện tại.
 */

describe("formatVnd", () => {
  it("định dạng VND parse lại được", () => {
    expect(formatVnd(9_500_000)).toBe("9.500.000đ");
    expect(extractMoneyVnd(formatVnd(9_500_000))).toEqual([9_500_000]);
    expect(formatVnd(0)).toBe("");
  });
});

describe("replacePricesWith — thay số cũ = giá CRM", () => {
  it("thay số tiền hardcode và trả về số cũ", () => {
    const { text, replacedOld } = replacePricesWith("Dạ gói này 8.900.000đ ạ", 9_500_000);
    expect(text).toContain("9.500.000đ");
    expect(text).not.toContain("8.900.000");
    expect(replacedOld).toEqual([8_900_000]);
  });
  it("thay {{PRICE}} placeholder", () => {
    const { text } = replacePricesWith("Dạ gói hiện tại là {{PRICE}} ạ", 9_500_000);
    expect(text).toBe("Dạ gói hiện tại là 9.500.000đ ạ");
  });
});

describe("stripPromoClaims — gỡ tuyên bố ưu đãi (mục D)", () => {
  it("gỡ mệnh đề đang giảm/ưu đãi", () => {
    const { text, stripped } = stripPromoClaims("Dạ bên em đang có ưu đãi, giá gói rất tốt ạ");
    expect(stripped).toBe(true);
    expect(text.toLowerCase()).not.toContain("ưu đãi");
    expect(text).toContain("giá gói rất tốt");
  });
  it("GIỮ câu phủ định 'chưa có ưu đãi'", () => {
    const { text } = stripPromoClaims("Dạ hiện chưa có ưu đãi nha");
    expect(text.toLowerCase()).toContain("chưa có ưu đãi");
  });
});

describe("stitchReplyFromGolden — công thức trả lời (mục F)", () => {
  const GOLDEN_OLD = "Dạ gói này hiện bên em là 8.900.000đ ạ, chị yên tâm về chất lượng nha";

  it("TEST5: giữ CÁCH NÓI, thay giá cũ = giá CRM mới", () => {
    const out = stitchReplyFromGolden({ idealResponse: GOLDEN_OLD, crmPriceVnd: 9_500_000, promoActive: false });
    expect(out).toContain("9.500.000đ");
    expect(out).not.toContain("8.900.000");
    expect(out).toContain("chị yên tâm về chất lượng nha"); // cách nói giữ nguyên
    expect(extractMoneyVnd(out)).toEqual([9_500_000]); // chỉ còn giá CRM
  });

  it("TEST4: KHÔNG sửa kịch bản — cùng golden, đổi giá CRM ⇒ câu tự ra giá mới", () => {
    const a = stitchReplyFromGolden({ idealResponse: GOLDEN_OLD, crmPriceVnd: 9_500_000, promoActive: false });
    const b = stitchReplyFromGolden({ idealResponse: GOLDEN_OLD, crmPriceVnd: 11_000_000, promoActive: false });
    expect(extractMoneyVnd(a)).toEqual([9_500_000]);
    expect(extractMoneyVnd(b)).toEqual([11_000_000]);
  });

  it("TEST2: CRM tắt promo → gỡ 'đang giảm' trong kịch bản cũ", () => {
    const golden = "Dạ bên em đang giảm còn 8.900.000đ nha, mẫu này đẹp lắm ạ";
    const out = stitchReplyFromGolden({ idealResponse: golden, crmPriceVnd: 10_000_000, promoActive: false });
    expect(out.toLowerCase()).not.toContain("đang giảm");
    expect(out).toContain("mẫu này đẹp lắm");
  });

  it("TEST3: CRM bật promo → giữ cách nói ưu đãi, số = giá ưu đãi CRM", () => {
    const golden = "Dạ đang ưu đãi, giá còn 8.900.000đ ạ";
    const out = stitchReplyFromGolden({ idealResponse: golden, crmPriceVnd: 8_500_000, promoActive: true });
    expect(out.toLowerCase()).toContain("ưu đãi");
    expect(extractMoneyVnd(out)).toEqual([8_500_000]);
  });

  it("golden dùng {{PRICE}} → nội suy giá CRM", () => {
    const out = stitchReplyFromGolden({ idealResponse: "Dạ gói hiện tại là {{PRICE}} ạ", crmPriceVnd: 9_500_000, promoActive: false });
    expect(out).toBe("Dạ gói hiện tại là 9.500.000đ ạ");
  });
});
