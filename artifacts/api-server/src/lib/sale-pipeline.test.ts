import { describe, it, expect } from "vitest";
import { finalizeSaleReply, intentFallbackLine, SAFE_REPLY_LINE, type PipelineValidator } from "./sale-pipeline";

/**
 * Tầng chốt pipeline (mandate F/VI): LLM → validator → regenerate 1 lần → stitched
 * fallback → câu an toàn. Module thuần — LLM/validator tiêm giả.
 */

const GOLDEN = [{ customerText: "Gói này bao nhiêu?", idealResponse: "Dạ gói {{PACKAGE_NAME}} hiện là {{PRICE}}, gồm {{PACKAGE_CONTENT}} ạ.", notes: "", score: 1 }];
const FACTS = { crmPriceVnd: 3_900_000, promoActive: false, packageName: "Chụp cổng Premium", packageContent: "2 hình cổng + 10 hình nhỏ" };
const passAll = (): PipelineValidator => ({ verdict: "PASS" });

describe("finalizeSaleReply", () => {
  it("LLM PASS ngay → dùng lời LLM, không fallback", async () => {
    const r = await finalizeSaleReply({
      callLlm: async () => ({ text: "Dạ gói Premium hiện là 3.900.000đ ạ.", provider: "shopaikey" }),
      golden: GOLDEN, facts: FACTS, validate: passAll,
    });
    expect(r.replyText).toContain("3.900.000đ");
    expect(r.provider).toBe("shopaikey");
    expect(r.fallbackUsed).toBe("none");
    expect(r.regenerated).toBe(false);
  });

  it("LLM BLOCK lần 1 → regenerate ĐÚNG 1 lần với feedback validator", async () => {
    const calls: Array<string | null> = [];
    const r = await finalizeSaleReply({
      callLlm: async (fb) => {
        calls.push(fb);
        return calls.length === 1
          ? { text: "Giá 9.999.999đ nha chị", provider: "anthropic" }   // sai giá
          : { text: "Dạ gói hiện tại 3.900.000đ ạ", provider: "anthropic" };
      },
      golden: GOLDEN, facts: FACTS,
      validate: (reply) => reply.includes("9.999.999") ? { verdict: "BLOCK", reason: "giá không khớp CRM" } : { verdict: "PASS" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeNull();
    expect(calls[1]).toContain("giá không khớp CRM"); // feedback được chuyển vào lần tái sinh
    expect(r.regenerated).toBe(true);
    expect(r.replyText).toContain("3.900.000đ");
    expect(r.fallbackUsed).toBe("none");
  });

  it("LLM BLOCK cả 2 lần → stitched fallback (golden + giá CRM) qua validator", async () => {
    const r = await finalizeSaleReply({
      callLlm: async () => ({ text: "Em giảm 30% cho chị nha", provider: "anthropic" }),
      golden: GOLDEN, facts: FACTS,
      validate: (reply) => reply.includes("giảm 30%") ? { verdict: "BLOCK", reason: "tự giảm giá" } : { verdict: "PASS" },
    });
    expect(r.fallbackUsed).toBe("stitched");
    expect(r.provider).toBe("stitched-fallback");
    expect(r.replyText).toContain("3.900.000đ");        // {{PRICE}} nội suy CRM
    expect(r.replyText).toContain("Chụp cổng Premium"); // {{PACKAGE_NAME}}
    expect(r.regenerated).toBe(true);
  });

  it("KHÔNG có LLM (thiếu key) → stitched fallback deterministic", async () => {
    const r = await finalizeSaleReply({ callLlm: null, golden: GOLDEN, facts: FACTS, validate: passAll });
    expect(r.fallbackUsed).toBe("stitched");
    expect(r.replyText).toContain("3.900.000đ");
    expect(r.needsHuman).toBe(false);
  });

  it("mọi tầng fail (không golden/không giá) → CÂU AN TOÀN + needsHuman", async () => {
    const r = await finalizeSaleReply({ callLlm: null, golden: [], facts: { crmPriceVnd: null, promoActive: false }, validate: passAll });
    expect(r.replyText).toBe(SAFE_REPLY_LINE);
    expect(r.fallbackUsed).toBe("safe");
    expect(r.needsHuman).toBe(true);
    expect(r.provider).toBe("safe-fallback");
  });

  it("PRE-SERVICE ('em cần tư vấn ạ'): không golden/không giá → INTENT fallback, KHÔNG safe/chuyển người", async () => {
    const r = await finalizeSaleReply({
      callLlm: null, golden: [], facts: { crmPriceVnd: null, promoActive: false },
      validate: passAll, action: "ASK_SERVICE",
    });
    expect(r.fallbackUsed).toBe("intent");
    expect(r.needsHuman).toBe(false);
    expect(r.replyText).toContain("dịch vụ nào");
  });

  it("IDENTIFY_SERVICE có serviceName → câu fallback nêu ĐÚNG dịch vụ đang khoá", async () => {
    const r = await finalizeSaleReply({
      callLlm: null, golden: [], facts: { crmPriceVnd: null, promoActive: false, serviceName: "BEAUTY / THỜI TRANG" },
      validate: passAll, action: "IDENTIFY_SERVICE",
    });
    expect(r.fallbackUsed).toBe("intent");
    expect(r.replyText).toContain("BEAUTY / THỜI TRANG");
    expect(r.replyText).not.toMatch(/cưới|Dâu/);
  });

  it("intentFallbackLine: QUOTE cần giá — thiếu giá → null (không bịa)", () => {
    expect(intentFallbackLine("QUOTE_REFERENCE", { crmPriceVnd: null, promoActive: false })).toBeNull();
    const line = intentFallbackLine("QUOTE_REFERENCE", { crmPriceVnd: 3_900_000, promoActive: false, packageName: "Chụp beauty master" });
    expect(line).toContain("3.900.000đ");
    expect(line).toContain("Chụp beauty master");
  });

  it("stitched cũng BLOCK → câu an toàn (validator là lớp cuối tuyệt đối)", async () => {
    const r = await finalizeSaleReply({
      callLlm: null, golden: GOLDEN, facts: FACTS,
      validate: () => ({ verdict: "BLOCK", reason: "catalog không tải được (fail-closed)" }),
    });
    expect(r.replyText).toBe(SAFE_REPLY_LINE);
    expect(r.needsHuman).toBe(true);
  });
});
