import { callChat, type ChatImage } from "./ai-orchestrator";

/**
 * sale-vision.ts — Lulu HIỂU ẢNH khách gửi qua Messenger.
 *
 * Khi khách gửi hình ("bộ này chụp được không?"), ta:
 *   1) tải ảnh FB → base64 (an toàn, có giới hạn dung lượng),
 *   2) cho AI Vision phân loại NHU CẦU → JSON có service_intent trong 9 nhóm,
 *   3) dựng khối routing để Lulu lấy ĐÚNG nguồn dữ liệu thật (không lẫn nhóm,
 *      không mặc định dùng "Ý tưởng chụp ảnh").
 *
 * Mọi hàm KHÔNG throw (lỗi → trả 'unknown'/null → Lulu hỏi lại, không gửi bừa).
 */

export const SERVICE_INTENTS = [
  "beauty",
  "wedding_album",
  "wedding_gate",
  "wedding_party",
  "rental_outfit",
  "maternity",
  "family",
  "new_concept_idea",
  "unknown",
] as const;

export type ServiceIntent = (typeof SERVICE_INTENTS)[number];

export type CustomerImageIntent = {
  image_type: string;
  service_intent: ServiceIntent;
  confidence: number;
  visual_description: string;
  outfit: string;
  mood: string;
  location_type: string;
  required_items: string[];
  can_studio_do: boolean;
  should_use_photo_ideas: boolean;
  recommended_data_source: string;
};

const UNKNOWN_INTENT: CustomerImageIntent = {
  image_type: "unknown",
  service_intent: "unknown",
  confidence: 0,
  visual_description: "",
  outfit: "",
  mood: "",
  location_type: "",
  required_items: [],
  can_studio_do: false,
  should_use_photo_ideas: false,
  recommended_data_source: "ask_customer",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB — đủ cho ảnh Messenger, tránh tải file khổng lồ.

/** Tải ảnh từ URL FB → {mediaType, dataBase64}. null nếu lỗi/quá lớn. KHÔNG throw. */
export async function fetchImageAsBase64(url: string): Promise<ChatImage | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const mediaType = ct.startsWith("image/") ? ct : "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return { mediaType, dataBase64: buf.toString("base64") };
  } catch (e) {
    console.error("[Vision] fetchImageAsBase64 lỗi:", String(e).slice(0, 150));
    return null;
  }
}

function clampIntent(raw: any): CustomerImageIntent {
  const si = String(raw?.service_intent ?? "").trim();
  const service_intent: ServiceIntent =
    (SERVICE_INTENTS as readonly string[]).includes(si) ? (si as ServiceIntent) : "unknown";
  const conf = Number(raw?.confidence);
  const items = Array.isArray(raw?.required_items)
    ? raw.required_items.filter((x: unknown) => typeof x === "string" && x.trim()).map((s: string) => s.trim())
    : typeof raw?.required_items === "string" && raw.required_items.trim()
      ? [raw.required_items.trim()]
      : [];
  return {
    image_type: String(raw?.image_type ?? "").slice(0, 80),
    service_intent,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    visual_description: String(raw?.visual_description ?? "").slice(0, 600),
    outfit: String(raw?.outfit ?? "").slice(0, 200),
    mood: String(raw?.mood ?? "").slice(0, 200),
    location_type: String(raw?.location_type ?? "").slice(0, 120),
    required_items: items.slice(0, 12),
    can_studio_do: Boolean(raw?.can_studio_do),
    should_use_photo_ideas: Boolean(raw?.should_use_photo_ideas),
    recommended_data_source: String(raw?.recommended_data_source ?? "").slice(0, 120),
  };
}

const VISION_SYSTEM = `Bạn là bộ PHÂN LOẠI ảnh khách gửi cho Amazing Studio (studio chụp ảnh cưới, beauty/thời trang, áo dài/việt phục, gia đình, mẹ bầu, cho thuê trang phục cưới).
Nhìn ẢNH + tin nhắn khách, xác định khách đang muốn dịch vụ gì. CHỈ trả về 1 object JSON, KHÔNG văn bản thừa, KHÔNG markdown.

JSON gồm đúng các khóa:
- "image_type": loại ảnh ngắn gọn (vd "beauty nam", "ảnh cưới ngoại cảnh", "váy cưới", "cổng cưới", "concept decor").
- "service_intent": CHỈ 1 trong: "beauty" | "wedding_album" | "wedding_gate" | "wedding_party" | "rental_outfit" | "maternity" | "family" | "new_concept_idea" | "unknown".
- "confidence": số 0..1.
- "visual_description": mô tả ngắn những gì thấy trong ảnh (tiếng Việt).
- "outfit": trang phục trong ảnh.
- "mood": tông/mood (vd "cá tính, lạnh", "nhẹ nhàng sang").
- "location_type": bối cảnh (vd "studio", "ngoại cảnh biển", "cổng cưới", "phòng").
- "required_items": mảng đạo cụ/trang phục/bối cảnh cần để làm được (có thể rỗng).
- "can_studio_do": true nếu studio làm được theo hướng tương tự.
- "should_use_photo_ideas": true CHỈ khi đây là concept lạ/độc đáo chưa chắc có sẵn đạo cụ (nên tham khảo module Ý tưởng).
- "recommended_data_source": 1 trong "beauty_service" | "wedding_album" | "wedding_gate" | "rental_outfit" | "maternity" | "family" | "photo_ideas" | "ask_customer".

QUY TẮC:
- beauty / cool boy / chân dung cá nhân / nàng thơ → "beauty".
- cô dâu chú rể / ảnh cưới / ngoại cảnh → "wedding_album". Cổng cưới riêng → "wedding_gate". Tiệc cưới/phóng sự → "wedding_party".
- chỉ có váy cưới / áo dài / vest / trang phục (không có người mẫu chụp concept) → "rental_outfit".
- mẹ bầu → "maternity". Gia đình nhiều người → "family".
- concept hoa/decor/setup lạ, độc đáo, khó xác định dịch vụ → "new_concept_idea" + should_use_photo_ideas=true.
- Ảnh mờ/khó phân biệt/không rõ nhu cầu → "unknown", confidence thấp, recommended_data_source="ask_customer".`;

/** Lõi: phân loại 1 ChatImage (đã có base64). KHÔNG throw → 'unknown' nếu lỗi. */
async function classifyChatImage(
  img: ChatImage,
  messageText?: string | null,
  conversationContext?: string | null,
): Promise<CustomerImageIntent> {
  const caption = (messageText ?? "").trim();
  const convo = (conversationContext ?? "").trim();
  const userText =
    `Phân loại ảnh này. ${caption ? `Khách nhắn kèm: "${caption}".` : "Khách gửi ảnh không kèm chữ."}` +
    (convo ? `\nNgữ cảnh hội thoại gần đây:\n${convo.slice(0, 800)}` : "") +
    `\nTrả về JSON theo đúng cấu trúc đã nêu.`;
  try {
    const res = await callChat({
      system: VISION_SYSTEM,
      messages: [{ role: "user", content: userText, images: [img] }],
      maxTokens: 600,
      jsonMode: true,
      label: "sale-vision",
    });
    if (!res.ok || !res.text?.trim()) return UNKNOWN_INTENT;
    const jsonText = res.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start < 0 || end <= start) return UNKNOWN_INTENT;
    const parsed = JSON.parse(jsonText.slice(start, end + 1));
    return clampIntent(parsed);
  } catch (e) {
    console.error("[Vision] classifyChatImage lỗi:", String(e).slice(0, 150));
    return UNKNOWN_INTENT;
  }
}

/** Phân loại ảnh từ URL (luồng Messenger: tải ảnh FB → base64). 'unknown' nếu lỗi. */
export async function classifyCustomerImageIntent(args: {
  imageUrl: string;
  messageText?: string | null;
  conversationContext?: string | null;
}): Promise<CustomerImageIntent> {
  const img = await fetchImageAsBase64(args.imageUrl);
  if (!img) return UNKNOWN_INTENT;
  return classifyChatImage(img, args.messageText, args.conversationContext);
}

/** Phân loại ảnh từ base64 (luồng sân test admin: upload/paste/drag). 'unknown' nếu lỗi. */
export async function classifyCustomerImageFromData(args: {
  mediaType?: string | null;
  dataBase64: string;
  messageText?: string | null;
  conversationContext?: string | null;
}): Promise<CustomerImageIntent> {
  const b64 = (args.dataBase64 ?? "").replace(/^data:[^;]+;base64,/, "").trim();
  if (!b64) return UNKNOWN_INTENT;
  const mediaType = (args.mediaType || "image/jpeg").trim() || "image/jpeg";
  return classifyChatImage({ mediaType, dataBase64: b64 }, args.messageText, args.conversationContext);
}

// service_intent → câu chỉ dẫn nguồn dữ liệu thật cho Lulu (không lẫn nhóm).
const SOURCE_GUIDANCE: Record<ServiceIntent, string> = {
  beauty:
    'Khách muốn BEAUTY/chân dung cá nhân/cool boy. CHỈ gửi ảnh/bộ/dịch vụ nhóm Beauty (hoặc bộ cá tính gần gu). TUYỆT ĐỐI KHÔNG gửi album cưới.',
  wedding_album:
    'Khách muốn ẢNH CƯỚI/ngoại cảnh (cô dâu chú rể). Gửi bộ ảnh/album cưới, gói ngoại cảnh. KHÔNG gửi beauty cá nhân (trừ khi khách hỏi makeup/beauty riêng).',
  wedding_gate:
    'Khách quan tâm CỔNG CƯỚI. Gửi ảnh/dịch vụ cổng cưới (chụp cổng tại studio). KHÔNG gửi beauty.',
  wedding_party:
    'Khách muốn TIỆC CƯỚI/phóng sự cưới. Gửi dịch vụ chụp tiệc cưới. KHÔNG gửi beauty cá nhân.',
  rental_outfit:
    'Khách hỏi TRANG PHỤC (váy cưới/áo dài/vest). Điều hướng trang Cho thuê trang phục. KHÔNG gửi concept cưới nếu khách chỉ hỏi xem đồ.',
  maternity:
    'Khách muốn chụp MẸ BẦU. Gửi dịch vụ/bộ ảnh nhóm bầu. KHÔNG gửi album cưới/beauty.',
  family:
    'Khách muốn chụp GIA ĐÌNH. Gửi dịch vụ/bộ ảnh nhóm gia đình. KHÔNG gửi ảnh cưới/beauty cá nhân.',
  new_concept_idea:
    'Ảnh là CONCEPT LẠ/độc đáo. Được phép tham khảo "Ý TƯỞNG CHỤP" (nếu có ở dưới). PHẢI nói rõ làm theo hướng tương tự, cần kiểm tra trang phục/đạo cụ/địa điểm có sẵn hay cần đầu tư thêm. KHÔNG hứa làm y chang.',
  unknown:
    'CHƯA rõ nhu cầu từ ảnh. HỎI LẠI khách để xác nhận (cưới/beauty/gia đình/thuê đồ...). KHÔNG gửi link bừa.',
};

/**
 * Khối routing để append vào context khi khách gửi ảnh — Lulu đọc rồi lấy ĐÚNG
 * nguồn dữ liệu + trả lời đúng văn phong (không hứa y chang, không lẫn nhóm).
 */
export function buildImageRoutingBlock(intent: CustomerImageIntent): string {
  const lowConf = intent.confidence < 0.45 || intent.service_intent === "unknown";
  const guidance = lowConf ? SOURCE_GUIDANCE.unknown : SOURCE_GUIDANCE[intent.service_intent];
  const seen = [
    intent.image_type ? `loại: ${intent.image_type}` : "",
    intent.outfit ? `trang phục: ${intent.outfit}` : "",
    intent.mood ? `mood: ${intent.mood}` : "",
    intent.location_type ? `bối cảnh: ${intent.location_type}` : "",
  ].filter(Boolean).join(", ");

  return `KHÁCH VỪA GỬI 1 ẢNH — đã phân tích (AI Vision):
- Nhận diện: ${intent.visual_description || "(không rõ)"}${seen ? ` (${seen})` : ""}
- Nhóm nhu cầu: ${intent.service_intent} (độ chắc ${(intent.confidence * 100).toFixed(0)}%).
ĐỊNH HƯỚNG LẤY DỮ LIỆU: ${guidance}

CÁCH TRẢ LỜI KHI KHÁCH GỬI ẢNH (BẮT BUỘC):
- Tự nhiên như nhân viên thật, có xuống dòng, KHÔNG dùng gạch ngang dài "—".
- KHÔNG nói chắc 100% nếu chưa kiểm tra đạo cụ/địa điểm. KHÔNG hứa làm y chang ảnh mẫu.
- Dùng cách nói: "làm được theo hướng tương tự", "gần mood này", "em kiểm tra thêm đồ/địa điểm cho mình nha".
- Gửi tối đa 2-3 bộ/link ĐÚNG nhóm, mỗi cái có tên dễ hiểu, rồi hỏi gu khách.${
    lowConf ? "\n- Ảnh chưa rõ nhu cầu → HỎI LẠI khách trước, CHƯA gửi link." : ""
  }${
    intent.service_intent === "new_concept_idea" || intent.should_use_photo_ideas
      ? '\n- Concept lạ → nói: "Dạ concept này làm được theo hướng tương tự, nhưng em cần kiểm tra lại trang phục/đạo cụ/địa điểm có sẵn hay cần đầu tư thêm nha." Trình bày Ý tưởng là GỢI Ý, không phải sản phẩm có sẵn.'
      : ""
  }`;
}
