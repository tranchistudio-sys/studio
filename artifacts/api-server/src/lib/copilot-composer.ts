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
    return text || null;
  } catch (err) {
    console.error("copilot-composer error:", err);
    return null;
  }
}
