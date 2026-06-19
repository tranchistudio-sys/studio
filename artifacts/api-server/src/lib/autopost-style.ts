import { pool } from "@workspace/db";
import { callChat } from "./ai-orchestrator";
import { stripContacts } from "./autopost-sanitize";

/**
 * KHO VĂN PHONG MẪU (RAG nhẹ) — admin dán các bài viết hay vào, hệ thống chọn
 * những mẫu PHÙ HỢP NHẤT (theo content_type + tags + priority) rồi nhét vào
 * system prompt để AI HỌC GIỌNG (nhịp câu, cách mở hook, độ dài, nói tự nhiên).
 *
 * QUAN TRỌNG: chỉ "học gu", AI bị cấm chép nguyên văn / lặp số liệu của mẫu.
 * Không train model thật — đây là few-shot context bank thuần.
 *
 * AN TOÀN: mọi hàm KHÔNG throw (lỗi DB → trả rỗng, caption vẫn chạy bình thường).
 */

export type StyleSample = {
  id: number;
  title: string;
  content: string;
  tags: string[];
  contentType: string | null;
  tone: string | null;
  priority: number;
  /** Chủ đề văn phong (1 trong 14 key dưới). Quyết định AI lấy mẫu cho loại bài nào. */
  styleTopicKey: string;
  styleTopicLabel: string;
};

/** 14 CHỦ ĐỀ VĂN PHONG — khớp đúng dropdown UI "Chủ đề văn phong". */
export const STYLE_TOPIC_LABELS: Record<string, string> = {
  all: "Tất cả / Dùng chung",
  beauty: "Chụp Beauty",
  album_cuoi: "Chụp Album cưới / Prewedding / Cổng cưới / Cưới studio",
  cuoi_ngoai_canh: "Chụp cưới ngoại cảnh",
  tiec_cuoi: "Tiệc cưới / Phóng sự cưới",
  ao_dai_co_trang: "Áo dài / Việt phục / Yếm / Sườn xám / Cổ trang",
  gia_dinh: "Chụp Gia đình",
  bau: "Chụp Bầu / Mẹ bầu",
  vay_cuoi: "Váy cưới / Váy mới",
  trang_phuc_beauty_moi: "Trang phục beauty mới",
  makeup: "Makeup / Khoe makeup / Layout makeup",
  hau_truong: "Hậu trường",
  feedback: "Feedback khách hàng",
  bill: "Bill chốt đơn",
};

export function styleTopicLabel(key: string): string {
  return STYLE_TOPIC_LABELS[key] ?? STYLE_TOPIC_LABELS.all;
}

export function isValidStyleTopic(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(STYLE_TOPIC_LABELS, key);
}

/**
 * Map content_type của KHO nội dung → chủ đề văn phong, để khi generate caption
 * tự chọn mẫu ĐÚNG chủ đề. content_type không có trong map → "all" (dùng mẫu chung).
 */
const CONTENT_TYPE_TO_STYLE_TOPIC: Record<string, string> = {
  beauty: "beauty",
  album_cuoi: "album_cuoi",
  cuoi_ngoai_canh: "cuoi_ngoai_canh",
  tiec_cuoi: "tiec_cuoi",
  ao_dai_cuoi: "ao_dai_co_trang",
  viet_phuc: "ao_dai_co_trang",
  gia_dinh: "gia_dinh",
  bau: "bau",
  vay_cuoi: "vay_cuoi",
  new_arrival: "vay_cuoi",
  makeup: "makeup",
  hau_truong: "hau_truong",
  feedback: "feedback",
  bill: "bill",
};

export function topicForContentType(ct?: string | null): string {
  const key = (ct ?? "").trim();
  return CONTENT_TYPE_TO_STYLE_TOPIC[key] ?? "all";
}

function toTags(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
}

function normalizeRow(r: any): StyleSample {
  const topicRaw = r.styleTopicKey ?? r.style_topic_key ?? "all";
  const topicKey = isValidStyleTopic(String(topicRaw)) ? String(topicRaw) : "all";
  return {
    id: Number(r.id),
    title: String(r.title ?? ""),
    content: String(r.content ?? ""),
    tags: toTags(r.tags),
    contentType: r.contentType ?? r.content_type ?? null,
    tone: r.tone ?? null,
    priority: Number(r.priority ?? 0) || 0,
    styleTopicKey: topicKey,
    styleTopicLabel: r.styleTopicLabel ?? r.style_topic_label ?? styleTopicLabel(topicKey),
  };
}

/**
 * Chọn tối đa `limit` mẫu ĐANG BẬT, ưu tiên: khớp content_type (mạnh) → trùng
 * tags → priority cao. Mẫu KHÔNG gán content_type được coi là "dùng chung".
 */
export async function pickRelevantSamples(opts: {
  /** Chủ đề văn phong cần lấy (1 trong 14 key). Mặc định "all". */
  topicKey?: string | null;
  tags?: string[];
  limit?: number;
}): Promise<StyleSample[]> {
  const limit = Math.max(1, Math.min(8, opts.limit ?? 4));
  const topic = (opts.topicKey ?? "all").trim() || "all";
  try {
    const r = await pool.query(
      `SELECT id, title, content, tags, content_type, tone, priority, style_topic_key, style_topic_label
         FROM autopost_style_samples
        WHERE is_active = true
        ORDER BY priority DESC, id DESC
        LIMIT 200`,
    );
    const rows = r.rows.map(normalizeRow);
    if (rows.length === 0) return [];
    const tagSet = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
    // CHỈ lấy mẫu ĐÚNG chủ đề HOẶC "Dùng chung" — TUYỆT ĐỐI không lấy chủ đề khác.
    // Ưu tiên 1: mẫu đúng chủ đề (score +100). Ưu tiên 2 (fallback): mẫu "all" (+20).
    const candidates = rows.filter((s) => s.styleTopicKey === topic || s.styleTopicKey === "all");
    const scored = candidates.map((s) => {
      let score = s.priority;
      if (topic !== "all" && s.styleTopicKey === topic) score += 100; // đúng chủ đề
      else if (s.styleTopicKey === "all") score += 20; // dùng chung (fallback)
      const overlap = s.tags.filter((t) => tagSet.has(t.toLowerCase())).length;
      score += overlap * 10;
      return { s, score };
    });
    scored.sort((a, b) => b.score - a.score || b.s.priority - a.s.priority || b.s.id - a.s.id);
    return scored.slice(0, limit).map((x) => x.s);
  } catch (e) {
    console.error("[AutoPost] pickRelevantSamples lỗi:", String(e).slice(0, 150));
    return [];
  }
}

/** Lấy mẫu theo danh sách id cụ thể (cho nút "Test viết theo văn phong này"). */
export async function getSamplesByIds(ids: number[]): Promise<StyleSample[]> {
  const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (clean.length === 0) return [];
  try {
    const r = await pool.query(
      `SELECT id, title, content, tags, content_type, tone, priority, style_topic_key, style_topic_label
         FROM autopost_style_samples WHERE id = ANY($1::int[])`,
      [clean],
    );
    return r.rows.map(normalizeRow);
  } catch (e) {
    console.error("[AutoPost] getSamplesByIds lỗi:", String(e).slice(0, 150));
    return [];
  }
}

/**
 * Dựng "khối văn phong" để nhét vào CUỐI system prompt. Mỗi mẫu cắt tối đa 600
 * ký tự để khỏi phình token. Rỗng nếu không có mẫu (caption chạy như cũ).
 */
export function buildStyleBlock(samples: StyleSample[]): string {
  if (!samples.length) return "";
  const lines: string[] = [];
  lines.push("===== VĂN PHONG MẪU CỦA AMAZING STUDIO (HỌC GIỌNG — KHÔNG CHÉP) =====");
  lines.push(
    "Dưới đây là vài bài viết hay. HÃY HỌC: cách mở hook trong 3 giây đầu, nhịp câu, " +
      "độ dài, cách nói đời thường - duyên - gần gũi mà vẫn sang. " +
      "TUYỆT ĐỐI KHÔNG sao chép câu chữ; KHÔNG lặp lại số liệu/tên riêng/địa điểm trong mẫu; " +
      "KHÔNG bịa thông tin từ mẫu vào bài mới. Chỉ bắt chước GIỌNG VĂN.",
  );
  samples.forEach((s, i) => {
    lines.push(`--- Mẫu ${i + 1}${s.tone ? ` (giọng: ${s.tone})` : ""} ---`);
    // Sanitize: bỏ hotline/website/tên tiệm khác của nguồn → AI chỉ học GIỌNG.
    lines.push(stripContacts(s.content).trim().slice(0, 600));
  });
  lines.push("===== HẾT VĂN PHONG MẪU =====");
  return lines.join("\n");
}

/**
 * OCR 1 ảnh screenshot → trích NGUYÊN VĂN phần caption/chữ trong ảnh (dùng vision).
 * KHÔNG throw. Chỉ chạy được khi có provider vision (ANTHROPIC_API_KEY trên Replit).
 * Ảnh này CHỈ dùng để đọc chữ lúc thêm mẫu — KHÔNG lưu để gửi lại khi generate.
 */
export async function ocrImageToText(image: {
  mediaType: string;
  dataBase64: string;
}): Promise<{ ok: boolean; text: string; provider?: string; reason?: string }> {
  const system =
    "Bạn là công cụ OCR cho ảnh chụp màn hình bài viết Facebook. Nhiệm vụ DUY NHẤT: ĐỌC và " +
    "TRÍCH NGUYÊN VĂN phần nội dung/caption chữ trong ảnh, giữ đúng xuống dòng, emoji, hashtag. " +
    "CHỈ trả về phần chữ đó, KHÔNG mô tả ảnh, KHÔNG thêm lời dẫn như 'đây là...', KHÔNG bình luận. " +
    "Bỏ qua các thành phần giao diện (tên trang, nút Thích/Bình luận/Chia sẻ, thời gian, số like). " +
    "Nếu ảnh không có chữ caption, trả về chuỗi rỗng.";
  try {
    const res = await callChat({
      system,
      messages: [{ role: "user", content: "Trích nguyên văn phần caption chữ trong ảnh này:", images: [image] }],
      maxTokens: 1000,
      label: "style-ocr",
    });
    if (res.ok) return { ok: true, text: (res.text ?? "").trim(), provider: res.providerUsed };
    return { ok: false, text: "", reason: res.adminAlert || res.reason || "ocr_failed" };
  } catch (e) {
    return { ok: false, text: "", reason: "exception:" + String((e as Error)?.message ?? e) };
  }
}
