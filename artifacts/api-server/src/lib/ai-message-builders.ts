import type Anthropic from "@anthropic-ai/sdk";

/**
 * Builders thuần (KHÔNG side-effect, KHÔNG import @workspace/db / ./ai-provider) —
 * chuyển ChatMessage[] sang định dạng từng provider. Tách riêng để unit-test được
 * mà không cần DATABASE_URL.
 *
 * BẢO TƯƠNG THÍCH: message KHÔNG có images → content vẫn là plain string y như cũ.
 */

/** Một ảnh đính kèm: media type (vd "image/png") + dữ liệu base64 (không kèm tiền tố data URL). */
export type ChatImage = { mediaType: string; dataBase64: string };

/** Một tin hội thoại; `images` tuỳ chọn để hỗ trợ vision (block ảnh). */
export type ChatMessage = { role: "user" | "assistant"; content: string; images?: ChatImage[] };

/** Union media_type mà Anthropic SDK chấp nhận cho Base64ImageSource. */
type ClaudeMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Build messages cho Claude (Anthropic).
 * - Có ảnh → content là mảng: [<block ảnh>..., <block text cuối>] (ảnh TRƯỚC, text SAU).
 * - Không ảnh → content là plain string (Y HỆT hành vi cũ).
 */
export function buildClaudeMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.images && m.images.length > 0) {
      const imageBlocks = m.images.map((img) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: img.mediaType as ClaudeMediaType,
          data: img.dataBase64,
        },
      }));
      const textBlock = { type: "text" as const, text: m.content };
      return { role: m.role, content: [...imageBlocks, textBlock] };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Build messages cho OpenAI (Chat Completions).
 * - Bắt đầu bằng { role: "system", content: system }.
 * - Có ảnh → content là mảng [{type:"text"...}, {type:"image_url", image_url:{url: DATA_URL}}...]
 *   với DATA_URL = "data:" + mediaType + ";base64," + dataBase64.
 * - Không ảnh → content là plain string.
 */
export function buildOpenAIMessages(
  system: string,
  messages: ChatMessage[],
): Array<{ role: string; content: unknown }> {
  const out: Array<{ role: string; content: unknown }> = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.images && m.images.length > 0) {
      const content: unknown[] = [{ type: "text", text: m.content }];
      for (const img of m.images) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
        });
      }
      out.push({ role: m.role, content });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}
