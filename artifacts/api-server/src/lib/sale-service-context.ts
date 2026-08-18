import { detectServiceIntentFromText } from "./sale-samples";

/**
 * SERVICE CONTEXT (GĐ2) — theo dõi khách đang bàn DỊCH VỤ nào giữa cuộc chat, đổi & quay lại.
 *
 * THUẦN (không DB, không AI): quét lịch sử tin KHÁCH theo thứ tự, mỗi tin dò service_intent
 * (bỏ 'unknown'/'new_concept_idea' = modifier). Khi intent MỚI khác dịch vụ đang bàn → đẩy
 * dịch vụ cũ sang previous, đổi current. referenced giữ MỌI dịch vụ từng nhắc (để nhận "quay lại").
 *
 * Dùng để: sandbox hiển thị "đang bàn / trước đó"; GĐ4 nối vào state thật (services_json) để
 * lấy đúng bảng giá + kịch bản của current_service, KHÔNG dùng nhầm của dịch vụ trước.
 */

export type ServiceTrail = {
  current: string | null;   // dịch vụ đang bàn
  previous: string | null;  // dịch vụ ngay trước khi đổi
  referenced: string[];     // mọi dịch vụ đã nhắc (thứ tự xuất hiện lần đầu)
  switched: boolean;        // lượt cuối có đổi dịch vụ không
};

type Msg = { direction: "incoming" | "outgoing"; message: string };

export function computeServiceTrail(messages: Msg[]): ServiceTrail {
  let current: string | null = null;
  let previous: string | null = null;
  const referenced: string[] = [];
  let switched = false;

  for (const m of messages) {
    if (m.direction !== "incoming") continue;
    const text = (m.message ?? "").trim();
    if (!text || text.startsWith("[image:")) continue;
    const intent = detectServiceIntentFromText(text);
    if (!intent || intent === "unknown" || intent === "new_concept_idea") { switched = false; continue; }
    if (intent !== current) {
      if (current) previous = current;
      current = intent;
      switched = true;
    } else {
      switched = false;
    }
    if (!referenced.includes(intent)) referenced.push(intent);
  }
  return { current, previous, referenced, switched };
}
