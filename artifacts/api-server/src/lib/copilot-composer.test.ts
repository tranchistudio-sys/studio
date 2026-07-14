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
