import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn() },
}));
vi.mock("@workspace/db/schema", () => ({
  settingsTable: {},
}));
vi.mock("../lib/publicUrl.js", () => ({
  getPublicBaseUrl: () => "http://localhost",
}));

import * as aiEngine from "./ai-engine.js";
const { formatBubble, splitIntoChunks, buildFormatInstruction, buildSaleInstruction, isPricingBlock, mergePricingFragments, defaultAiSettings, buildStudioContext, naturalDelayMs, extractCustomerMemory } = aiEngine;

// ─── Customer Memory Extractor (anti-repeat questions) ──────────────────────

describe("extractCustomerMemory", () => {
  it("detects Tây Ninh location from various phrasings", () => {
    const cases = ["mình ở tây ninh mà", "tụi mình ở Tây Ninh nha", "em ở đây luôn", "gần studio thôi", "trong nội thành"];
    for (const msg of cases) {
      const m = extractCustomerMemory([], msg);
      expect(m.locationKnown).toBe("tay_ninh");
    }
  });

  it("detects off-province intent (Đà Lạt, Hội An, TP.HCM)", () => {
    expect(extractCustomerMemory([], "muốn chụp ở Đà Lạt").locationKnown).toBe("tinh_khac");
    expect(extractCustomerMemory([], "đi Hội An được không").locationKnown).toBe("tinh_khac");
    expect(extractCustomerMemory([], "trên TP.HCM nha").locationKnown).toBe("tinh_khac");
  });

  it("detects asked-price intent", () => {
    expect(extractCustomerMemory([], "Báo giá đi").askedPrice).toBe(true);
    expect(extractCustomerMemory([], "gói nào").askedPrice).toBe(true);
    expect(extractCustomerMemory([], "bao nhiêu tiền").askedPrice).toBe(true);
  });

  it("detects service group from history", () => {
    const m = extractCustomerMemory([{ direction: "incoming", message: "muốn chụp ảnh cưới" }], "");
    expect(m.serviceMentioned).toContain("cuoi");
  });

  it("counts outgoing and detects greetingSent", () => {
    const m = extractCustomerMemory(
      [
        { direction: "outgoing", message: "Dạ em chào bạn" },
        { direction: "incoming", message: "Hi" },
      ],
      "Báo giá đi",
    );
    expect(m.outgoingCount).toBe(1);
    expect(m.greetingSent).toBe(true);
  });

  it("detects budgetTier (tiet_kiem / vua_du / chin_chu)", () => {
    expect(extractCustomerMemory([], "muốn gói tiết kiệm thôi").budgetTier).toBe("tiet_kiem");
    expect(extractCustomerMemory([], "chụp đơn giản gọn nhẹ").budgetTier).toBe("tiet_kiem");
    expect(extractCustomerMemory([], "muốn chỉn chu cao cấp").budgetTier).toBe("chin_chu");
    expect(extractCustomerMemory([], "đầu tư đẹp thật xịn").budgetTier).toBe("chin_chu");
    expect(extractCustomerMemory([], "vừa đủ thôi").budgetTier).toBe("vua_du");
    expect(extractCustomerMemory([], "hi").budgetTier).toBeNull();
  });

  it("detects wantsOutdoor only when customer asks", () => {
    expect(extractCustomerMemory([], "Mình ở Tây Ninh").wantsOutdoor).toBe(false);
    expect(extractCustomerMemory([], "muốn chụp ngoại cảnh").wantsOutdoor).toBe(true);
    expect(extractCustomerMemory([], "đi Đà Lạt được không").wantsOutdoor).toBe(true);
    expect(extractCustomerMemory([], "muốn chụp ở Đà Lạt").wantsOutdoor).toBe(true);
    expect(extractCustomerMemory([], "định lên Hội An chụp").wantsOutdoor).toBe(true);
    expect(extractCustomerMemory([], "hi").wantsOutdoor).toBe(false);
  });

  it("does NOT mark wantsOutdoor for residence-only mentions (false-positive guard)", () => {
    // Khách ở tỉnh khác nhưng MUỐN đến Tây Ninh chụp — KHÔNG phải intent ngoại cảnh
    expect(extractCustomerMemory([], "Mình ở TP HCM").wantsOutdoor).toBe(false);
    expect(extractCustomerMemory([], "tụi mình ở Hà Nội nha").wantsOutdoor).toBe(false);
    expect(extractCustomerMemory([], "nhà mình ở Sài Gòn").wantsOutdoor).toBe(false);
  });

  it("detects priceQuoted from outgoing history", () => {
    const m = extractCustomerMemory(
      [
        { direction: "outgoing", message: "Dạ em chào bạn" },
        { direction: "incoming", message: "Báo giá" },
        { direction: "outgoing", message: "Gói Basic 2.900.000đ bạn nha" },
      ],
      "ok",
    );
    expect(m.priceQuoted).toBe(true);
    expect(m.packagesQuoted).toContain("basic");
  });

  it("detects objection (mắc/suy nghĩ/hỏi chỗ khác)", () => {
    expect(extractCustomerMemory([], "mắc quá vậy").objectionRaised).toBe(true);
    expect(extractCustomerMemory([], "để mình suy nghĩ thêm").objectionRaised).toBe(true);
    expect(extractCustomerMemory([], "để hỏi chỗ khác xem sao").objectionRaised).toBe(true);
    expect(extractCustomerMemory([], "ok đẹp quá").objectionRaised).toBe(false);
  });
});

// ─── isPricingBlock ──────────────────────────────────────────────────────────

describe("isPricingBlock", () => {
  it("detects đ currency marker", () => {
    expect(isPricingBlock("GÓI BASIC: 2.900.000đ")).toBe(true);
  });

  it("detects VND currency marker", () => {
    expect(isPricingBlock("Giá gói: 5.000.000 VND")).toBe(true);
  });

  it("detects triệu keyword", () => {
    expect(isPricingBlock("Gói này giá 5 triệu bạn nhé")).toBe(true);
  });

  it("detects ngàn keyword", () => {
    expect(isPricingBlock("Phí thêm 500 ngàn")).toBe(true);
  });

  it("detects dot-thousands number format", () => {
    expect(isPricingBlock("Tổng: 2.900.000")).toBe(true);
  });

  it("detects GÓI keyword", () => {
    expect(isPricingBlock("GÓI LUXURY bao gồm váy cưới")).toBe(true);
  });

  it("detects BASIC keyword (all-caps)", () => {
    expect(isPricingBlock("GÓI BASIC phù hợp cho bạn")).toBe(true);
  });

  it("detects PREMIUM keyword", () => {
    expect(isPricingBlock("Gói PREMIUM cao cấp nhất")).toBe(true);
  });

  it("detects LUXURY keyword", () => {
    expect(isPricingBlock("LUXURY package")).toBe(true);
  });

  it("detects BAO GỒM keyword", () => {
    expect(isPricingBlock("BAO GỒM: 2 bộ váy cưới")).toBe(true);
  });

  it("returns false for normal chat text", () => {
    expect(isPricingBlock("Dạ bạn ơi, bên em có nhiều lựa chọn")).toBe(false);
  });

  it("returns false for short greeting", () => {
    expect(isPricingBlock("Dạ em chào bạn")).toBe(false);
  });

  it("returns false for question without price", () => {
    expect(isPricingBlock("Bạn muốn chụp trong hay ngoài studio?")).toBe(false);
  });

  it("returns false for lowercase 'gói' in conversational text (no price signal)", () => {
    expect(isPricingBlock("Bên em có gói chụp studio rất đẹp")).toBe(false);
  });

  it("returns false for lowercase 'basic' without price signal", () => {
    expect(isPricingBlock("Gói basic phù hợp cho bạn")).toBe(false);
  });
});

// ─── buildFormatInstruction ──────────────────────────────────────────────────

describe("buildFormatInstruction", () => {
  it("returns a non-empty string", () => {
    const result = buildFormatInstruction();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("mentions messages[] array concept", () => {
    expect(buildFormatInstruction()).toContain("messages[]");
  });

  it("does not instruct model to use \\n within a single bubble (no ambiguity)", () => {
    const instruction = buildFormatInstruction();
    expect(instruction).not.toContain("\\n để hệ thống tự split");
  });

  it("instructs model to separate ideas into distinct bubbles", () => {
    const instruction = buildFormatInstruction();
    expect(instruction).toContain("RIÊNG BIỆT");
  });

  it("instructs model to use dot-thousands format with đ suffix", () => {
    const instruction = buildFormatInstruction();
    expect(instruction).toContain("2.900.000đ");
  });

  it("forbids writing prices as words (hai triệu chín style)", () => {
    const instruction = buildFormatInstruction();
    expect(instruction).toContain("KHÔNG viết giá bằng chữ");
  });

  it("forbids writing prices without dot-thousands separator", () => {
    const instruction = buildFormatInstruction();
    expect(instruction).toContain("KHÔNG viết giá liền không dấu chấm");
  });

  it("instructs model to write package names in ALL-CAPS", () => {
    const instruction = buildFormatInstruction();
    expect(instruction).toContain("VIẾT HOA TOÀN BỘ");
    expect(instruction).toContain("GÓI BASIC");
    expect(instruction).toContain("GÓI PREMIUM");
  });

  it("shows a correct example that isPricingBlock() can detect", () => {
    const instruction = buildFormatInstruction();
    const exampleMatch = instruction.match(/GÓI BASIC: [\d.]+đ/);
    expect(exampleMatch).not.toBeNull();
    if (exampleMatch) {
      expect(isPricingBlock(exampleMatch[0])).toBe(true);
    }
  });
});

// ─── buildSaleInstruction ─────────────────────────────────────────────────────

describe("buildSaleInstruction", () => {
  it("includes pricing format rule", () => {
    const settings = defaultAiSettings();
    const instruction = buildSaleInstruction(settings);
    expect(instruction).toContain("FORMAT GIÁ BẮT BUỘC");
    expect(instruction).toContain("2.900.000đ");
  });

  it("includes package name capitalisation rule", () => {
    const settings = defaultAiSettings();
    const instruction = buildSaleInstruction(settings);
    expect(instruction).toContain("TÊN GÓI BẮT BUỘC VIẾT HOA");
    expect(instruction).toContain("GÓI BASIC");
  });

  it("returns empty string when no settings provided", () => {
    expect(buildSaleInstruction(undefined)).toBe("");
  });

  it("format rules are always included regardless of autoPriceQuote setting", () => {
    const withAuto = defaultAiSettings();
    withAuto.autoPriceQuote = true;
    const withoutAuto = defaultAiSettings();
    withoutAuto.autoPriceQuote = false;
    expect(buildSaleInstruction(withAuto)).toContain("FORMAT GIÁ BẮT BUỘC");
    expect(buildSaleInstruction(withoutAuto)).toContain("FORMAT GIÁ BẮT BUỘC");
  });

  it("always includes B1-B3 guardrail regardless of autoPriceQuote", () => {
    const withAuto = defaultAiSettings();
    withAuto.autoPriceQuote = true;
    const withoutAuto = defaultAiSettings();
    withoutAuto.autoPriceQuote = false;
    expect(buildSaleInstruction(withAuto)).toContain("GUARDRAIL B1–B3");
    expect(buildSaleInstruction(withoutAuto)).toContain("GUARDRAIL B1–B3");
  });

  it("B1-B3 guardrail explicitly blocks pricing, package names and images", () => {
    const settings = defaultAiSettings();
    const instruction = buildSaleInstruction(settings);
    expect(instruction).toContain("TUYỆT ĐỐI không báo giá");
    expect(instruction).toContain("Basic/Premium/Luxury");
    expect(instruction).toContain("bước 1, 2, 3");
  });

  it("image send rule restricts images to step 4 when priceImageSteps contains step < 4", () => {
    const settings = defaultAiSettings();
    settings.priceImageSteps = [2, 4]; // step 2 is misconfigured
    const instruction = buildSaleInstruction(settings);
    // Should still include both steps in the prompt instruction
    expect(instruction).toContain("2, 4");
    // But the hard guardrail should also be present to override it
    expect(instruction).toContain("GUARDRAIL B1–B3");
  });

  it("image send rule includes 'chỉ gửi ở bước 4' when priceImageSteps is default", () => {
    const settings = defaultAiSettings();
    settings.priceImageSteps = [4];
    const instruction = buildSaleInstruction(settings);
    expect(instruction).toContain("bước 4");
    expect(instruction).toContain("KHÔNG gửi trước bước 4");
  });

  it("image send rule falls back to step 4 wording when priceImageSteps is empty", () => {
    const settings = defaultAiSettings();
    settings.priceImageSteps = [];
    const instruction = buildSaleInstruction(settings);
    expect(instruction).toContain("chỉ gửi ở bước 4");
  });
});

// ─── formatBubble ────────────────────────────────────────────────────────────

describe("formatBubble", () => {
  it("trims leading and trailing whitespace", () => {
    expect(formatBubble("  hello  ")).toBe("hello");
  });

  it("removes trailing comma", () => {
    expect(formatBubble("dạ bạn ơi,")).toBe("dạ bạn ơi");
  });

  it("removes trailing period", () => {
    expect(formatBubble("bên em có nhiều gói.")).toBe("bên em có nhiều gói");
  });

  it("removes multiple trailing punctuation", () => {
    expect(formatBubble("ok bạn nhé,.")).toBe("ok bạn nhé");
  });

  it("keeps trailing question mark", () => {
    expect(formatBubble("bạn muốn chụp trong hay ngoài studio?")).toBe(
      "bạn muốn chụp trong hay ngoài studio?"
    );
  });

  it("keeps trailing exclamation mark", () => {
    expect(formatBubble("bên em đang có khuyến mãi!")).toBe(
      "bên em đang có khuyến mãi!"
    );
  });

  it("returns empty string for blank input", () => {
    expect(formatBubble("   ")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(formatBubble("")).toBe("");
  });
});

// ─── splitIntoChunks ─────────────────────────────────────────────────────────

describe("splitIntoChunks", () => {
  it("splits on newlines into separate bubbles", () => {
    const input = "Dạ bạn ơi\nBên em có gói basic và premium\nBạn muốn gói nào?";
    const result = splitIntoChunks(input);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("Dạ bạn ơi");
    expect(result[1]).toBe("Bên em có gói basic và premium");
    expect(result[2]).toBe("Bạn muốn gói nào?");
  });

  it("splits on period within a single line", () => {
    const input = "Dạ em chào. Bạn cần tư vấn gói nào ạ";
    const result = splitIntoChunks(input);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toBe("Dạ em chào");
  });

  it("splits on question mark within a single line", () => {
    const input = "Bạn muốn chụp ngoại cảnh? Hay studio?";
    const result = splitIntoChunks(input);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("returns single bubble for short text without separators", () => {
    const input = "Dạ bạn chờ em xíu";
    const result = splitIntoChunks(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Dạ bạn chờ em xíu");
  });

  it("newline takes priority over period", () => {
    const input = "Câu một.\nCâu hai.";
    const result = splitIntoChunks(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("Câu một");
    expect(result[1]).toBe("Câu hai");
  });

  it("filters out empty lines", () => {
    const input = "Dạ bạn\n\n\nChờ em xíu";
    const result = splitIntoChunks(input);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty string", () => {
    expect(splitIntoChunks("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(splitIntoChunks("   ")).toEqual([]);
  });

  it("does not split when chunkMessages=false", () => {
    const input = "Câu một.\nCâu hai.";
    const result = splitIntoChunks(input, {
      chunkMessages: false,
      minDelayMs: 800,
      maxDelayMs: 2500,
      typingIndicator: true,
      maxSentencesPerBubble: 3,
      pronounStyle: "em_ban",
      customPronounSelf: "em",
      customPronounCustomer: "bạn",
      useEmoji: false,
      bannedKeywords: [],
      autoPriceQuote: true,
      maxDiscountPercent: 10,
      priceImageSteps: [4],
      autoSendPriceImage: false,
      priceImageSendSteps: [4],
      sendPriceTextAfterImage: true,
      fallbackMessages: [],
      gptErrorMessages: [],
      saveUnknownQuestions: true,
      logDecisions: true,
      forceQaOnly: false,
      forceGptOnly: false,
    });
    expect(result).toHaveLength(1);
  });

  it("splits multiple \n lines each recursively on period", () => {
    const input = "Dạ em chào. Bạn hỏi về gì ạ\nBên em có váy và chụp ảnh cưới";
    const result = splitIntoChunks(input);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toBe("Dạ em chào");
  });

  it("splits long comma-separated line (>80 chars) into bubbles", () => {
    const input =
      "Bên em có gói chụp studio, gói chụp ngoại cảnh công viên, gói chụp biển miền Trung rất đẹp";
    const result = splitIntoChunks(input);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("does not split short comma-separated line (<80 chars)", () => {
    const input = "Dạ, bạn ơi";
    const result = splitIntoChunks(input);
    expect(result).toHaveLength(1);
  });

  it("keeps 'GÓI BASIC: 2.900.000đ' as a single bubble", () => {
    const input = "GÓI BASIC: 2.900.000đ";
    const result = splitIntoChunks(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("GÓI BASIC: 2.900.000đ");
  });

  it("keeps pricing line intact when mixed with regular lines via newline", () => {
    const input = "Bên em có các gói sau\nGÓI BASIC: 2.900.000đ\nGÓI PREMIUM: 5.500.000đ\nBạn muốn chọn gói nào?";
    const result = splitIntoChunks(input);
    expect(result).toContain("GÓI BASIC: 2.900.000đ");
    expect(result).toContain("GÓI PREMIUM: 5.500.000đ");
    const basicIdx = result.indexOf("GÓI BASIC: 2.900.000đ");
    expect(basicIdx).toBeGreaterThanOrEqual(0);
  });

  it("does not split a line with dot-thousands number like 2.900.000", () => {
    const input = "Tổng chi phí là 2.900.000 bạn nhé";
    const result = splitIntoChunks(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("2.900.000");
  });

  it("does not split a line containing triệu", () => {
    const input = "Gói này giá 5 triệu bạn nhé";
    const result = splitIntoChunks(input);
    expect(result).toHaveLength(1);
  });

  it("does not split a single-line pricing text", () => {
    const input = "GÓI LUXURY: 10.000.000đ bao gồm váy và album.";
    const result = splitIntoChunks(input);
    expect(result).toHaveLength(1);
  });
});

// ─── mergePricingFragments ────────────────────────────────────────────────────

describe("mergePricingFragments", () => {
  it("merges 3-part split price into one bubble", () => {
    const input = ["GÓI BASIC: 2", "900", "000đ"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("GÓI BASIC: 2.900.000đ");
  });

  it("merges 2-part split price into one bubble", () => {
    const input = ["GÓI PREMIUM: 3", "900.000đ"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("GÓI PREMIUM: 3.900.000đ");
  });

  it("leaves complete pricing bubbles untouched", () => {
    const input = ["GÓI BASIC: 2.900.000đ", "GÓI PREMIUM: 3.900.000đ"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("GÓI BASIC: 2.900.000đ");
    expect(result[1]).toBe("GÓI PREMIUM: 3.900.000đ");
  });

  it("leaves normal chat bubbles untouched", () => {
    const input = ["Dạ em chào anh", "Anh hỏi về gói chụp ảnh nào ạ"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("Dạ em chào anh");
    expect(result[1]).toBe("Anh hỏi về gói chụp ảnh nào ạ");
  });

  it("merges multiple split groups in one pass", () => {
    const input = ["GÓI BASIC: 2", "900", "000đ", "GÓI PREMIUM: 3", "900", "000đ"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("GÓI BASIC: 2.900.000đ");
    expect(result[1]).toBe("GÓI PREMIUM: 3.900.000đ");
  });

  it("handles empty array", () => {
    expect(mergePricingFragments([])).toEqual([]);
  });

  it("handles single bubble", () => {
    const input = ["GÓI BASIC: 2.900.000đ"];
    expect(mergePricingFragments(input)).toEqual(["GÓI BASIC: 2.900.000đ"]);
  });

  it("does not merge if next bubble is not a pure number fragment", () => {
    const input = ["Bên em có 3 gói", "phù hợp nhu cầu của anh"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(2);
  });

  it("Pattern B: merges trailing standalone đ into price bubble", () => {
    const input = ["GÓI BASIC: 2.900.000", "đ"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("GÓI BASIC: 2.900.000đ");
  });

  it("Pattern B: merges trailing VND into price bubble", () => {
    const input = ["GÓI LUXURY: 5.900.000", "VND"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("GÓI LUXURY: 5.900.000VND");
  });

  it("Pattern C: merges package-name fragment with price fragment", () => {
    const input = ["GÓI BASIC:", "2.900.000đ"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("GÓI BASIC: 2.900.000đ");
  });

  it("Pattern C: merges PREMIUM fragment with price fragment", () => {
    const input = ["GÓI PREMIUM", "3.900.000đ bao gồm váy"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("GÓI PREMIUM: 3.900.000đ bao gồm váy");
  });

  it("Pattern C2: merges package-name colon fragment with multi-part number chain", () => {
    const input = ["GÓI BASIC:", "2", "900", "000đ"];
    const result = mergePricingFragments(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("GÓI BASIC: 2.900.000đ");
  });
});

// ─── askChatGptFallback split behaviour (via splitIntoChunks) ────────────────
// askChatGptFallback pipes its `reply` string through splitIntoChunks before
// returning messages[]. The tests below verify that the split logic produces
// the correct bubbles for the typical reply shapes the fallback prompt elicits.

describe("askChatGptFallback split behaviour", () => {
  it("multi-line reply splits into one bubble per line", () => {
    const reply = "Dạ bạn ơi\nBên em có nhiều gói\nBạn muốn gói nào?";
    const messages = splitIntoChunks(reply);
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages[0]).toBe("Dạ bạn ơi");
    expect(messages[messages.length - 1]).toBe("Bạn muốn gói nào?");
  });

  it("single-line reply without separators stays as one bubble", () => {
    const reply = "Dạ bạn chờ em xíu";
    const messages = splitIntoChunks(reply);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe("Dạ bạn chờ em xíu");
  });

  it("period-separated reply within one line splits into multiple bubbles", () => {
    const reply = "Dạ em chào. Bên em luôn sẵn sàng tư vấn cho bạn.";
    const messages = splitIntoChunks(reply);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]).toBe("Dạ em chào");
  });

  it("empty reply string produces no bubbles", () => {
    expect(splitIntoChunks("")).toEqual([]);
  });

  it("whitespace-only reply produces no bubbles", () => {
    expect(splitIntoChunks("   \n  \n  ")).toEqual([]);
  });
});

// ─── askChatGptFallback integration (fetch-mocked) ───────────────────────────
// These tests stub globalThis.fetch so callOpenAI never hits the network.
// buildStudioContext wraps all DB calls in try/catch → empty string on the
// mocked db:{}. Both paths are entirely in-process and deterministic.

function makeFetchStub(reply: object) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
  });
}

describe("askChatGptFallback (fetch-mocked)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("splits a multi-line reply into multiple bubbles", async () => {
    vi.stubGlobal("fetch", makeFetchStub({
      inScope: true,
      reply: "Dạ bạn ơi\nBên em có nhiều gói\nBạn muốn gói nào?",
      reason: "ok",
    }));
    const result = await aiEngine.askChatGptFallback({
      apiKey: "test",
      customerMessage: "Giá?",
      customerName: "Lan",
      history: [],
    });
    expect(result.usedFallback).toBe(true);
    expect(result.isOutOfScope).toBe(false);
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    expect(result.messages[0]).toBe("Dạ bạn ơi");
    expect(result.messages[result.messages.length - 1]).toBe("Bạn muốn gói nào?");
  });

  it("returns isOutOfScope=true and empty messages when inScope=false", async () => {
    vi.stubGlobal("fetch", makeFetchStub({
      inScope: false,
      reply: "",
      reason: "out_of_scope",
    }));
    const result = await aiEngine.askChatGptFallback({
      apiKey: "test",
      customerMessage: "Câu hỏi nhạy cảm",
      customerName: "Lan",
      history: [],
    });
    expect(result.isOutOfScope).toBe(true);
    expect(result.messages).toHaveLength(0);
  });
});

// ─── buildStudioContext – few-shot examples ──────────────────────────────────

function makeScript(conversationExamples: aiEngine.ConversationExample[] | null): aiEngine.SaleScript {
  return {
    id: 1,
    name: "Test Script",
    priceContent: null,
    priceImages: null,
    aiRules: null,
    conversationExamples,
    steps: [],
  };
}

describe("buildStudioContext – few-shot examples", () => {
  it("injects VÍ DỤ HỘI THOẠI MẪU section when examples are valid", async () => {
    const script = makeScript([
      [
        { role: "user", content: "Giá chụp cổng bao nhiêu?" },
        { role: "assistant", content: "Dạ bên em có gói từ 1.5 triệu ạ!" },
      ],
    ]);
    const prompt = await buildStudioContext([script]);
    expect(prompt).toContain("VÍ DỤ HỘI THOẠI MẪU");
    expect(prompt).toContain("Khách: Giá chụp cổng bao nhiêu?");
    expect(prompt).toContain("Studio: Dạ bên em có gói từ 1.5 triệu ạ!");
  });

  it("omits few-shot section when conversationExamples is null", async () => {
    const script = makeScript(null);
    const prompt = await buildStudioContext([script]);
    expect(prompt).not.toContain("VÍ DỤ HỘI THOẠI MẪU");
  });

  it("omits few-shot section when example has only 1 message (invalid)", async () => {
    const script = makeScript([
      [{ role: "user", content: "Giá?" }],
    ]);
    const prompt = await buildStudioContext([script]);
    expect(prompt).not.toContain("VÍ DỤ HỘI THOẠI MẪU");
  });

  it("labels messages correctly as Khách and Studio", async () => {
    const script = makeScript([
      [
        { role: "user", content: "Hỏi về dịch vụ" },
        { role: "assistant", content: "Bên em có nhiều gói" },
        { role: "user", content: "Gói nào rẻ nhất?" },
        { role: "assistant", content: "Gói cơ bản 1.5 triệu" },
      ],
    ]);
    const prompt = await buildStudioContext([script]);
    expect(prompt).toContain("Khách: Hỏi về dịch vụ");
    expect(prompt).toContain("Studio: Bên em có nhiều gói");
    expect(prompt).toContain("Khách: Gói nào rẻ nhất?");
    expect(prompt).toContain("Studio: Gói cơ bản 1.5 triệu");
  });

  it("skips examples with empty content and omits section if all invalid", async () => {
    const script = makeScript([
      [
        { role: "user", content: "   " },
        { role: "assistant", content: "" },
      ],
    ]);
    const prompt = await buildStudioContext([script]);
    expect(prompt).not.toContain("VÍ DỤ HỘI THOẠI MẪU");
  });
});

// ─── naturalDelayMs ──────────────────────────────────────────────────────────

describe("naturalDelayMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns min when text is empty and jitter is 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const delay = naturalDelayMs("", { minDelayMs: 500, maxDelayMs: 2000 } as ReturnType<typeof defaultAiSettings>);
    expect(delay).toBe(500);
  });

  it("is always >= min", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const delay = naturalDelayMs("xin chào", { minDelayMs: 800, maxDelayMs: 2500 } as ReturnType<typeof defaultAiSettings>);
    expect(delay).toBeGreaterThanOrEqual(800);
  });

  it("is always <= max", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const longText = "a".repeat(300);
    const delay = naturalDelayMs(longText, { minDelayMs: 800, maxDelayMs: 2500 } as ReturnType<typeof defaultAiSettings>);
    expect(delay).toBeLessThanOrEqual(2500);
  });

  it("adds up to 40% of headroom as jitter when Math.random = 1", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const settings = { minDelayMs: 1000, maxDelayMs: 2000 } as ReturnType<typeof defaultAiSettings>;
    const delay = naturalDelayMs("", settings);
    expect(delay).toBeLessThanOrEqual(2000);
    expect(delay).toBeGreaterThan(1000);
  });

  it("uses defaults when settings is undefined", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const delay = naturalDelayMs("hi", undefined);
    expect(delay).toBeGreaterThanOrEqual(800);
    expect(delay).toBeLessThanOrEqual(2500);
  });

  it("returns exactly max when text is very long", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const longText = "a".repeat(1000);
    const delay = naturalDelayMs(longText, { minDelayMs: 100, maxDelayMs: 500 } as ReturnType<typeof defaultAiSettings>);
    expect(delay).toBe(500);
  });

  it("returns min when min equals max (no headroom)", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const delay = naturalDelayMs("", { minDelayMs: 1000, maxDelayMs: 1000 } as ReturnType<typeof defaultAiSettings>);
    expect(delay).toBe(1000);
  });
});
