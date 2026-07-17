// Test composer: AI chỉ DIỄN ĐẠT facts đã xác minh — không đổi số, không bịa,
// mọi lỗi đều trả null để route rơi về câu deterministic (Copilot sống không cần AI).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
// Composer chỉ dùng callChat (ChatMessage là type, bị erase khi build) — mock gọn.
vi.mock("./ai-orchestrator", () => ({ callChat: vi.fn() }));

import { callChat } from "./ai-orchestrator";
import {
  composeNaturalAnswer,
  stripMarkdownArtifacts,
  buildComposerSystemPrompt,
  extractNumberTokens,
  aiNumbersWithinFacts,
} from "./copilot-composer";
import type { CopilotFacts } from "./studio-copilot";

const mockChat = callChat as ReturnType<typeof vi.fn>;

const FACTS: CopilotFacts = {
  intent: "revenue",
  period: "2026-07",
  scopeDescription: "phiếu thu thực tế trong tháng 7/2026",
  facts: { collectedAmount: 24699006, bookingCount: 40, paymentCount: 24 },
};
const DET_ANSWER =
  "Tháng 7/2026 studio đã thu thực tế 24.699.006 đ, ghi nhận qua 24 phiếu thu. Trong tháng có 40 đơn chụp.";
const MSGS = [{ role: "user" as const, content: "doanh thu tháng này bao nhiêu?" }];

beforeEach(() => {
  mockChat.mockReset();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("stripMarkdownArtifacts — frontend hiển thị plain text, không được lộ dấu **", () => {
  it("lột **đậm**, ** lẻ, __gạch__, # heading nhưng giữ nguyên nội dung", () => {
    expect(stripMarkdownArtifacts("**Doanh thu tháng 7/2026** là 24.699.006 đ")).toBe(
      "Doanh thu tháng 7/2026 là 24.699.006 đ",
    );
    expect(stripMarkdownArtifacts("đơn ** lẻ")).toBe("đơn  lẻ");
    expect(stripMarkdownArtifacts("__quan trọng__")).toBe("quan trọng");
    expect(stripMarkdownArtifacts("## Tổng quan\nnội dung")).toBe("Tổng quan\nnội dung");
  });

  it("giữ nguyên dòng liệt kê '• ' và số liệu", () => {
    const s = "• Khách A: còn nợ 42.798.994 đ\n• Khách B: còn nợ 500.000 đ";
    expect(stripMarkdownArtifacts(s)).toBe(s);
  });
});

describe("buildComposerSystemPrompt — facts vào prompt phải y nguyên, không tạo fact mới", () => {
  it("JSON facts trong prompt parse ngược ra đúng bằng facts đầu vào", () => {
    const prompt = buildComposerSystemPrompt(FACTS, DET_ANSWER);
    const jsonStart = prompt.indexOf("{", prompt.indexOf("## FACTS"));
    const jsonEnd = prompt.indexOf("## CÂU TRẢ LỜI THAM KHẢO");
    const parsed = JSON.parse(prompt.slice(jsonStart, jsonEnd).trim());
    expect(parsed).toEqual(FACTS); // số liệu không bị composer thay đổi
    expect(prompt).toContain("không bịa");
    expect(prompt).toContain(DET_ANSWER);
  });

  it("guardrail sự cố 14/07: cấm bịa khả năng + cấm lộ từ kỹ thuật nội bộ", () => {
    const prompt = buildComposerSystemPrompt(FACTS, DET_ANSWER);
    // AI từng trả lời "hỏi lại kiểu X để hệ thống lấy đủ dữ liệu" (khả năng không có)
    expect(prompt).toContain("không hứa hẹn khả năng chưa tồn tại");
    expect(prompt).toContain("KHÔNG gợi ý");
    // AI từng lộ chữ "FACTS" ra câu trả lời cho chủ studio
    expect(prompt).toContain("KHÔNG nhắc các từ kỹ thuật nội bộ");
  });
});

describe("composeNaturalAnswer — fallback deterministic là hợp đồng bắt buộc", () => {
  it("chưa cấu hình LLM → null ngay, KHÔNG gọi AI", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const r = await composeNaturalAnswer({ facts: FACTS, deterministicAnswer: DET_ANSWER, messages: MSGS });
    expect(r).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("AI trả lời OK → dùng text đã lột markdown", async () => {
    mockChat.mockResolvedValue({ ok: true, text: "**Tháng 7/2026** em thu 24.699.006 đ anh nha." });
    const r = await composeNaturalAnswer({ facts: FACTS, deterministicAnswer: DET_ANSWER, messages: MSGS });
    expect(r).toBe("Tháng 7/2026 em thu 24.699.006 đ anh nha.");
    // system prompt gửi đi chứa đúng số liệu đã xác minh
    const sentSystem = (mockChat.mock.calls[0][0] as { system: string }).system;
    expect(sentSystem).toContain('"collectedAmount": 24699006');
    expect(sentSystem).toContain('"bookingCount": 40');
  });

  it("AI lỗi (ok:false) → null để route dùng câu deterministic", async () => {
    mockChat.mockResolvedValue({ ok: false, needsHuman: true, reason: "all_failed", adminAlert: "x", attempts: [] });
    const r = await composeNaturalAnswer({ facts: FACTS, deterministicAnswer: DET_ANSWER, messages: MSGS });
    expect(r).toBeNull();
  });

  it("AI throw exception → null, không nổ route", async () => {
    mockChat.mockRejectedValue(new Error("network boom"));
    const r = await composeNaturalAnswer({ facts: FACTS, deterministicAnswer: DET_ANSWER, messages: MSGS });
    expect(r).toBeNull();
  });

  it("AI trả chuỗi rỗng sau khi lột markdown → null", async () => {
    mockChat.mockResolvedValue({ ok: true, text: "**" });
    const r = await composeNaturalAnswer({ facts: FACTS, deterministicAnswer: DET_ANSWER, messages: MSGS });
    expect(r).toBeNull();
  });
});

// ─── Chốt chặn CỨNG "AI không được đổi số" (GĐ1e-2, gộp từ WIP 14/07) ──────────

describe("extractNumberTokens / aiNumbersWithinFacts", () => {
  it("bóc số bỏ dấu phân tách: 24.699.006 và 24,699,006 là CÙNG một số", () => {
    const t = extractNumberTokens("thu 24.699.006 đ qua 24 phiếu, kiểu Mỹ 24,699,006");
    expect(t.has("24699006")).toBe(true);
    expect(t.has("24")).toBe(true);
  });

  it("AI giữ nguyên số (đổi định dạng phân tách) → hợp lệ", () => {
    expect(
      aiNumbersWithinFacts("Em thu được 24,699,006 đ với 40 đơn anh nha.", FACTS, DET_ANSWER),
    ).toBe(true);
  });

  it("AI bịa số tiền mới → không hợp lệ", () => {
    expect(
      aiNumbersWithinFacts("Em thu được 25.000.000 đ anh nha.", FACTS, DET_ANSWER),
    ).toBe(false);
  });

  it("AI tự cộng/làm tròn ra số khác → không hợp lệ", () => {
    // 24699006 làm tròn thành 24700000 — phải chặn
    expect(
      aiNumbersWithinFacts("Khoảng 24.700.000 đ anh nha.", FACTS, DET_ANSWER),
    ).toBe(false);
  });

  it("số nhỏ (ngày/giờ/số đếm 1-3 chữ số) không bị chặn nhầm", () => {
    expect(
      aiNumbersWithinFacts("Ngày 15/8 em sẽ nhắc lại lúc 09:30 nha (99 việc).", FACTS, DET_ANSWER),
    ).toBe(true);
  });

  it("số trong caveats của facts được coi là hợp lệ", () => {
    const factsWithCaveat: CopilotFacts = {
      ...FACTS,
      caveats: ["Sổ cast mới phủ 118/256 đơn hợp lệ (409 khoản)."],
    };
    // 256 (3 chữ số, bỏ qua) + 118, 409 (3 chữ số) — không chặn; kiểm số ≥4 chữ số trong caveat
    const factsBig: CopilotFacts = { ...FACTS, caveats: ["còn treo 1234567 đ chưa ghi sổ"] };
    expect(aiNumbersWithinFacts("Còn 1.234.567 đ chưa ghi sổ anh nha.", factsBig, DET_ANSWER)).toBe(true);
    expect(aiNumbersWithinFacts("phủ 118/256 đơn (409 khoản)", factsWithCaveat, DET_ANSWER)).toBe(true);
  });
});

describe("composeNaturalAnswer — AI đổi số thì bị vứt, fallback deterministic", () => {
  it("AI trả số không có trong facts → null (route sẽ dùng câu deterministic)", async () => {
    mockChat.mockResolvedValue({ ok: true, text: "Tháng 7/2026 em thu 99.999.999 đ anh nha." });
    const r = await composeNaturalAnswer({ facts: FACTS, deterministicAnswer: DET_ANSWER, messages: MSGS });
    expect(r).toBeNull();
  });

  it("AI giữ đúng số → dùng bản AI", async () => {
    mockChat.mockResolvedValue({ ok: true, text: "Tháng 7/2026 em thu 24.699.006 đ, đủ 24 phiếu thu anh nha." });
    const r = await composeNaturalAnswer({ facts: FACTS, deterministicAnswer: DET_ANSWER, messages: MSGS });
    expect(r).toBe("Tháng 7/2026 em thu 24.699.006 đ, đủ 24 phiếu thu anh nha.");
  });
});

// ─── PR #103: guard tổng quát cho MỌI đường Copilot (kể cả nhánh analysis) ───
import { aiNumbersWithinSources } from "./copilot-composer.js";

describe("aiNumbersWithinSources — AI đổi bất kỳ con số cỡ tiền nào là VỨT", () => {
  const analysisContext = "Doanh thu tháng 7: 34.198.006 ₫ (12 đơn chụp)\nCông nợ: 5 khách, tổng 409.927.995 ₫";
  const deterministic = "Tháng này em thu 34.198.006 ₫ từ 12 đơn.";

  it("AI giữ nguyên số từ dữ liệu Engine → pass", () => {
    expect(aiNumbersWithinSources(
      "Anh ơi tháng này thu 34.198.006 đ, công nợ còn 409.927.995 đ nha.",
      [analysisContext, deterministic],
    )).toBe(true);
  });

  it("AI LÀM TRÒN (34,2 triệu → 34.200.000) → fail, phải fallback deterministic", () => {
    expect(aiNumbersWithinSources("Tháng này thu khoảng 34.200.000 đ.", [analysisContext, deterministic])).toBe(false);
  });

  it("AI TỰ CỘNG số mới (thu + nợ) → fail", () => {
    expect(aiNumbersWithinSources("Tổng cộng em tính ra 444.126.001 đ.", [analysisContext, deterministic])).toBe(false);
  });

  it("AI BỊA số không có trong nguồn → fail", () => {
    expect(aiNumbersWithinSources("Lợi nhuận ước tính 12.345.678 đ.", [analysisContext, deterministic])).toBe(false);
  });

  it("số nhỏ 1–3 chữ số (ngày/giờ/số đếm) không bị chặn nhầm", () => {
    expect(aiNumbersWithinSources("Ngày 15/7 có 3 show, em nhắc anh 2 việc.", [analysisContext, deterministic])).toBe(true);
  });

  it("định dạng khác nhau nhưng cùng giá trị (34,198,006 vs 34.198.006) vẫn khớp", () => {
    expect(aiNumbersWithinSources("Doanh thu 34,198,006 dong.", [analysisContext, deterministic])).toBe(true);
  });
});
