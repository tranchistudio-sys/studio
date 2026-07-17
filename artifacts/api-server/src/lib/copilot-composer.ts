import { callChat, type ChatMessage } from "./ai-orchestrator";
import { COPILOT_SYSTEM_PROMPT, isLlmConfigured, type CopilotFacts } from "./studio-copilot";

/**
 * Composer: AI chỉ DIỄN ĐẠT lại số liệu đã xác minh từ DB (CopilotFacts) —
 * không tự query, không tự tạo hay sửa số. Mọi lỗi (chưa cấu hình key, provider
 * chết, trả rỗng...) đều trả null để route rơi về câu deterministic, bảo đảm
 * Copilot luôn dùng được kể cả khi không có AI.
 */

/**
 * Frontend render tin nhắn dạng plain text (không có markdown renderer) —
 * lột dấu bold (2 dấu sao), gạch dưới đôi và heading # khỏi output LLM
 * để không hiện nguyên ký tự markdown.
 */
export function stripMarkdownArtifacts(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
}

/** Mọi cụm chữ số trong chuỗi, đã bỏ dấu phân tách nghìn (24.699.006 → "24699006"). */
export function extractNumberTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/\d[\d.,]*\d|\d/g)) {
    out.add(m[0].replace(/[.,]/g, ""));
  }
  return out;
}

/**
 * Chốt chặn CỨNG "AI không được đổi số" — dạng tổng quát cho MỌI đường Copilot:
 * mọi con số từ 4 chữ số trở lên (cỡ tiền) trong câu AI phải xuất hiện y nguyên
 * trong ÍT NHẤT một nguồn cho phép (facts / câu deterministic / analysis context).
 * AI làm tròn / tự cộng / bịa số → false → route vứt câu AI, dùng deterministic.
 * (Số ngắn 1–3 chữ số bỏ qua để không chặn nhầm ngày/giờ/số đếm.)
 */
export function aiNumbersWithinSources(aiText: string, allowSources: readonly string[]): boolean {
  const allow = new Set<string>();
  for (const src of allowSources) {
    for (const t of extractNumberTokens(src)) allow.add(t);
  }
  for (const token of extractNumberTokens(aiText)) {
    if (token.length >= 4 && !allow.has(token)) return false;
  }
  return true;
}

/** Bản chuyên cho composer facts — giữ nguyên API cũ, delegate về guard tổng quát. */
export function aiNumbersWithinFacts(
  aiText: string,
  facts: CopilotFacts,
  deterministicAnswer: string,
): boolean {
  return aiNumbersWithinSources(aiText, [deterministicAnswer, JSON.stringify(facts)]);
}

export function buildComposerSystemPrompt(facts: CopilotFacts, deterministicAnswer: string): string {
  return `${COPILOT_SYSTEM_PROMPT}

## NHIỆM VỤ
Diễn đạt lại CÂU TRẢ LỜI THAM KHẢO bên dưới thành lời hội thoại tự nhiên cho chủ studio, dựa DUY NHẤT trên FACTS đã xác minh.

## QUY TẮC BẮT BUỘC
1. Mọi con số giữ NGUYÊN như FACTS — không làm tròn, không tự tính số mới, không bịa.
2. Không thêm dữ kiện ngoài FACTS, không suy diễn, không nhắc SQL hay cấu trúc database.
3. Tiếng Việt tự nhiên, xưng "em", gọi người dùng là "anh". Trả lời thẳng vào câu hỏi trước.
4. Tối đa MỘT gợi ý bước tiếp theo, chỉ khi FACTS có căn cứ. Không dùng câu khuyên chung chung (kiểu "so sánh với mục tiêu") khi FACTS không có dữ liệu đó.
5. KHÔNG dùng markdown (không **, không #). Hạn chế emoji (nhiều nhất 1). Giữ nguyên các dòng bắt đầu bằng "• " khi cần liệt kê.
6. Ngắn gọn: ngoài phần liệt kê, tối đa khoảng 5 câu. Nếu FACTS ghi phạm vi số liệu (scopeDescription) thì diễn đạt đúng phạm vi đó.
7. KHÔNG nhắc các từ kỹ thuật nội bộ trong câu trả lời: "FACTS", "database", "SQL", "intent", "hệ thống truy vấn".
8. Nếu câu hỏi vượt phạm vi FACTS: trả lời phần CÓ số liệu và nói thẳng phần còn lại em chưa theo dõi được — TUYỆT ĐỐI KHÔNG gợi ý "hỏi lại theo cách khác để lấy thêm dữ liệu", không hứa hẹn khả năng chưa tồn tại, không bảo người dùng đổi cách hỏi.
9. Nếu FACTS có "caveats" thì PHẢI nói ĐẦY ĐỦ các lưu ý đó bằng lời tự nhiên (vd lợi nhuận chưa trừ hết cast, chưa gồm hoa hồng sale) — không được giấu, bỏ bớt hay giảm nhẹ. Nếu "status" là "partial"/"missing"/"unknown" thì nói rõ số liệu chưa đầy đủ/chưa chốt, không trình bày như con số cuối cùng.

## FACTS (JSON — nguồn số liệu duy nhất)
${JSON.stringify(facts, null, 2)}

## CÂU TRẢ LỜI THAM KHẢO (số liệu đúng, cần diễn đạt tự nhiên hơn)
${deterministicAnswer}`;
}

export async function composeNaturalAnswer(opts: {
  facts: CopilotFacts;
  deterministicAnswer: string;
  /** Hội thoại gần nhất (tin cuối là câu hỏi hiện tại) — để AI nối mạch trò chuyện. */
  messages: ChatMessage[];
}): Promise<string | null> {
  if (!isLlmConfigured()) return null;
  try {
    const result = await callChat({
      system: buildComposerSystemPrompt(opts.facts, opts.deterministicAnswer),
      messages: opts.messages,
      maxTokens: 1024,
      label: "copilot-composer",
    });
    if (!result.ok) return null;
    const text = stripMarkdownArtifacts(result.text);
    if (!text) return null;
    // AI đổi/bịa/làm tròn số so với facts → vứt bản AI, dùng câu deterministic
    // (độ chính xác tài chính đặt trên độ mượt câu chữ — yêu cầu chủ 14/07).
    if (!aiNumbersWithinFacts(text, opts.facts, opts.deterministicAnswer)) {
      console.warn("[copilot-composer] AI đổi số so với facts — fallback deterministic");
      return null;
    }
    return text;
  } catch (err) {
    console.error("copilot-composer error:", err);
    return null;
  }
}
