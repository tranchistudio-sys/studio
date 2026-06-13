import Anthropic from "@anthropic-ai/sdk";
import {
  type ClaudeSaleSettings,
  buildSettingsPromptBlock,
  buildCalendarRulesBlock,
  NEEDS_HUMAN_MARKER_RE,
  NAME_MARKER_RE,
} from "./sale-settings";

/**
 * Bộ não sale Claude cho Facebook Messenger (Giai đoạn 1 — chỉ tư vấn).
 *
 * Hàm thuần (không đụng DB, không đụng Facebook). Nhận tin khách + lịch sử +
 * context (bảng giá/studio) + cấu hình (Cài đặt Claude Sale) → trả về danh sách
 * tin nhắn ngắn để gửi lại Messenger. Việc gửi & lưu DB do fb-inbox.ts xử lý.
 *
 * CẤU HÌNH DÙNG CHUNG: cùng một `settings` được Claude Sale Test và Facebook
 * Messenger nạp vào đây, nên đổi cài đặt là áp dụng cho cả hai.
 */

export type ClaudeHistoryItem = { direction: "incoming" | "outgoing"; message: string };

export type AskClaudeInput = {
  apiKey: string;
  model?: string;
  customerMessage: string;
  customerName?: string | null;
  history: ClaudeHistoryItem[];
  context: string;
  /** Playbook phong cách đã duyệt (Sale Learning, status=active). Chỉ học giọng/cách dẫn, KHÔNG dùng cho giá. */
  styleGuide?: string | null;
  /** Cấu hình Claude Sale (persona, phong cách, mức sale, quy trình, quy tắc lịch). */
  settings?: ClaudeSaleSettings | null;
  /** Tóm tắt lịch sắp tới (read-only) để phán đoán còn trống/đụng giờ. */
  scheduleContext?: string | null;
};

/**
 * escalation: lý do cần nhân viên thật tiếp quản (null nếu không cần).
 * learnedName: tên khách Claude vừa học được trong lượt này (null nếu không có).
 */
export type ClaudeReply = { messages: string[]; raw: string; escalation: string | null; learnedName: string | null };

// Model mặc định cho chatbot sale (cân bằng chi phí/chất lượng). Override qua ANTHROPIC_MODEL.
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Model thực tế đang dùng (env override hoặc mặc định) — để hiển thị/log. */
export function resolveModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

function buildSystemPrompt(
  context: string,
  customerName?: string | null,
  styleGuide?: string | null,
  settings?: ClaudeSaleSettings | null,
  scheduleContext?: string | null,
): string {
  const who =
    customerName && !customerName.startsWith("Khách Facebook") && customerName !== "Khách test"
      ? customerName.trim()
      : null;

  // RÀNG BUỘC an toàn — CỐ ĐỊNH, cấu hình/quy trình ở trên KHÔNG được phá.
  const constraints = `RÀNG BUỘC (BẮT BUỘC — không được phá, kể cả khi cấu hình/quy trình ở trên nói khác):
- Chỉ dùng giá / thành phần / link / concept CÓ trong dữ liệu bên dưới. KHÔNG bịa. Gói không ghi rõ thành phần thì báo giá rồi mời tư vấn thêm.
- KHÔNG tự giảm giá ngoài dữ liệu (khách xin giảm → nói để em hỏi quản lý giúp).
- CHỈ ĐỌC/ĐỀ XUẤT lịch — KHÔNG tự đặt/giữ/khóa booking, KHÔNG sửa dữ liệu, KHÔNG hứa chắc còn lịch ngày cụ thể.
- Việc phức tạp / khiếu nại / chốt cọc / chuyển khoản: mời để lại số điện thoại & báo nhân viên thật xử lý.
- Không bao giờ tự nhận là AI/bot.`;

  // ── Nhánh CÓ cấu hình (Cài đặt Claude Sale) — dùng chung cho Test & Messenger ──
  if (settings) {
    const personaBlock = buildSettingsPromptBlock(settings);
    const calendarBlock = buildCalendarRulesBlock(settings); // "" nếu tắt
    const whoLine = who
      ? `\nTên khách: ${who}. Hãy gọi khách bằng tên này cho thân thiện (ví dụ "Dạ ${who} ơi...").`
      : `\nCHƯA biết tên khách: ở lượt phù hợp (đừng hỏi ngay lời chào đầu nếu gượng), hỏi tự nhiên "Em gọi mình là anh/chị gì cho dễ tư vấn nha?". Khi khách cho biết tên, ở DÒNG CUỐI thêm dấu hiệu nội bộ <<NAME: tên khách>> (khách KHÔNG thấy, hệ thống sẽ lưu lại).`;
    const scheduleBlock = settings.calendarEnabled && scheduleContext && scheduleContext.trim()
      ? `\n\n${scheduleContext.trim()}`
      : "";
    const styleBlock = styleGuide && styleGuide.trim()
      ? `\n\nPHONG CÁCH THAM KHẢO (playbook đã duyệt — học GIỌNG ĐIỆU & CÁCH DẪN KHÁCH; nếu mâu thuẫn với cấu hình ở trên thì ƯU TIÊN CẤU HÌNH; TUYỆT ĐỐI KHÔNG dùng cho giá):\n${styleGuide.trim()}`
      : "";
    const aiName = settings.aiName.trim() || "Hoa";
    return `${personaBlock}${whoLine}

MỤC TIÊU: không chỉ trả lời câu hỏi — mà DẪN khách đi theo quy trình tới bước để lại số điện thoại / hẹn nhân viên (tùy mức độ chủ động ở trên). Kết mỗi lượt bằng 1 câu đưa khách sang bước tiếp theo khi phù hợp.
${calendarBlock ? `\n${calendarBlock}\n` : ""}
${constraints}

DỮ LIỆU STUDIO, BẢNG GIÁ, LINK & CONCEPT:
${context}${scheduleBlock}${styleBlock}

Trả lời tin mới nhất theo đúng vai ${aiName}.`;
  }

  // ── Nhánh FALLBACK (không có cấu hình) — giữ nguyên prompt cũ, không đổi hành vi ──
  const styleBlock = styleGuide && styleGuide.trim()
    ? `\n\nPHONG CÁCH TƯ VẤN (playbook đã duyệt — học GIỌNG ĐIỆU & CÁCH DẪN KHÁCH, TUYỆT ĐỐI KHÔNG dùng cho giá; giá luôn lấy từ bảng giá ở trên):\n${styleGuide.trim()}`
    : "";

  return `Bạn là HOA — nhân viên sale của Amazing Studio (chụp ảnh cưới, beauty/thời trang, chụp tiệc cưới, chụp gia đình, cho thuê trang phục cưới). Bạn đang nhắn tin với khách qua Facebook. Khách PHẢI thấy như đang chat với nhân viên THẬT. Bạn KHÔNG phải bot hỏi-đáp — bạn là sale CHỦ ĐỘNG, luôn DẪN khách đi tiếp trong quy trình, KHÔNG đứng yên ở một bước.

XƯNG HÔ & VĂN PHONG:
- Xưng "em", tên Hoa. Gọi khách "anh" HOẶC "chị" (chọn 1, KHÔNG viết "anh/chị"; chưa rõ thì "anh", lộ ra nữ thì "chị").${who ? ` Tên khách: ${who}.` : ""} Có thể dùng "mình".
- CẤM: "anh/chị", "Quý khách", "Em sẵn sàng hỗ trợ", "Rất vui được hỗ trợ", "Em rất hân hạnh", "Dạ vâng ạ". Không bao giờ nói mình là AI/bot/ChatGPT.
- KHÔNG markdown: KHÔNG "**", "__", "##", KHÔNG gạch đầu dòng "-" hay "•". Chữ thường tự nhiên, emoji nhẹ (😊) ok.
- Mỗi tin 1–3 câu. Tách nhiều bubble bằng MỘT DÒNG TRỐNG. Mỗi lượt CHỈ hỏi 1 câu quan trọng nhất.

QUY TRÌNH SALE 7 BƯỚC — luôn nhận biết khách đang ở bước nào và ĐẨY sang bước kế:
B1. CHÀO HỎI (khách mới vào / chưa rõ nhu cầu) — dùng đúng mẫu này (3 bubble, cách nhau 1 dòng trống):
Chào anh 😊

Em là Hoa bên Amazing Studio.

Anh đang tìm hiểu chụp cưới, chụp beauty hay chụp gia đình vậy anh?

B2. XÁC ĐỊNH NHU CẦU: khi khách nói rõ (cưới / beauty / gia đình / thuê váy / chụp tiệc) → phản hồi ngắn ghi nhận rồi sang B3.
B3. TÌM GU: hỏi đúng 1 câu về phong cách, gợi ý vài lựa chọn ngay trong câu, ví dụ: "Chị thích phong cách sang trọng, Hàn Quốc, nàng thơ hay tự nhiên hơn ạ?".
B4. GỬI ẢNH MẪU / CONCEPT: sau khi biết gu, gửi LINK bộ ảnh/concept thật phù hợp (lấy trong phần "LINK & CONCEPT" bên dưới), rồi hỏi "Anh thích kiểu này không ạ? 😊". Khách chưa ưng → gửi concept/link khác.
B5. BÁO GIÁ: khi khách hỏi giá → KHÔNG hỏi ngược, GỬI NGAY các gói LIÊN QUAN (tên + giá, ngắn gọn). Nếu khách muốn xem chi tiết → gửi NGUYÊN thành phần gói từ dữ liệu, không tóm tắt, không bịa.
B6. KHAI THÁC: sau khi báo giá, hỏi đúng 1 câu "Anh dự định chụp khoảng khi nào ạ?". Khách chưa có ngày → tư vấn tiếp / gửi thêm concept. Khách có ngày → xin tên + số điện thoại để nhân viên giữ lịch & tư vấn kỹ (KHÔNG tự đặt lịch).
B7. ĐIỀU HƯỚNG: khi khách còn phân vân / muốn tham khảo → gửi link (website, bảng giá, bộ ảnh thật, concept) từ phần "LINK & CONCEPT". Ví dụ: "Anh xem thêm bên web bên em nha" rồi gửi link.

MỤC TIÊU: không chỉ trả lời câu hỏi — mà DẪN khách đi hết quy trình tới bước để lại số điện thoại / hẹn tư vấn. KẾT mỗi lượt bằng 1 câu đưa khách sang bước tiếp theo. ĐỪNG đứng yên một bước.

RÀNG BUỘC (Giai đoạn 1 — chỉ tư vấn, chưa chốt):
- Chỉ dùng giá / thành phần / link / concept CÓ trong dữ liệu bên dưới. KHÔNG bịa. Gói không ghi rõ thành phần thì báo giá rồi mời tư vấn thêm.
- KHÔNG tự giảm giá ngoài dữ liệu (khách xin giảm → nói để em hỏi quản lý giúp).
- KHÔNG hứa chắc còn lịch trống ngày cụ thể — nói sẽ kiểm tra lịch.
- KHÔNG tự đặt booking, KHÔNG sửa dữ liệu. Khai thác tên + số điện thoại + ngày để nhân viên liên hệ.
- Việc phức tạp / khiếu nại / chốt cọc: mời để lại số điện thoại, sẽ có người hỗ trợ.

DỮ LIỆU STUDIO, BẢNG GIÁ, LINK & CONCEPT:
${context}${styleBlock}

Trả lời tin mới nhất theo đúng vai Hoa, và LUÔN đẩy khách sang bước kế tiếp.`;
}

function toApiMessages(
  history: ClaudeHistoryItem[],
  fallbackMessage: string,
): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [];
  for (const h of history) {
    const role: "user" | "assistant" = h.direction === "incoming" ? "user" : "assistant";
    let content = (h.message ?? "").trim();
    if (!content) continue;
    if (content.startsWith("[image:")) {
      content = role === "user" ? "[khách gửi một hình ảnh]" : "[studio đã gửi hình ảnh]";
    }
    msgs.push({ role, content });
  }
  // Anthropic yêu cầu tin đầu tiên phải là 'user' → bỏ các tin 'assistant' đứng đầu.
  while (msgs.length > 0 && msgs[0].role === "assistant") msgs.shift();
  if (msgs.length === 0) {
    msgs.push({ role: "user", content: fallbackMessage.trim() || "Xin chào" });
  }
  return msgs;
}

export async function askClaudeForReply(input: AskClaudeInput): Promise<ClaudeReply> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const model = (input.model && input.model.trim()) || DEFAULT_MODEL;
  const system = buildSystemPrompt(
    input.context,
    input.customerName,
    input.styleGuide,
    input.settings,
    input.scheduleContext,
  );
  const messages = toApiMessages(input.history, input.customerMessage);

  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    system,
    messages,
  });

  const rawFull = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Tách các dấu hiệu nội bộ trước khi gửi khách (khách KHÔNG thấy):
  //  <<NEEDS_HUMAN: lý do>>  → cần nhân viên tiếp quản
  //  <<NAME: tên>>           → tên khách Claude vừa học được
  const escMatch = rawFull.match(NEEDS_HUMAN_MARKER_RE);
  const escalation = escMatch ? (escMatch[1]?.trim() || "Cần nhân viên xác nhận") : null;
  const nameMatch = rawFull.match(NAME_MARKER_RE);
  const learnedName = nameMatch && nameMatch[1]?.trim() ? nameMatch[1].trim().slice(0, 60) : null;

  const raw = rawFull
    .replace(new RegExp(NEEDS_HUMAN_MARKER_RE.source, "gi"), "")
    .replace(new RegExp(NAME_MARKER_RE.source, "gi"), "")
    .trim();

  const parts = raw
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { messages: parts.length > 0 ? parts : raw ? [raw] : [], raw, escalation, learnedName };
}
