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
};

function toTags(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
}

function normalizeRow(r: any): StyleSample {
  return {
    id: Number(r.id),
    title: String(r.title ?? ""),
    content: String(r.content ?? ""),
    tags: toTags(r.tags),
    contentType: r.contentType ?? r.content_type ?? null,
    tone: r.tone ?? null,
    priority: Number(r.priority ?? 0) || 0,
  };
}

/**
 * Chọn tối đa `limit` mẫu ĐANG BẬT, ưu tiên: khớp content_type (mạnh) → trùng
 * tags → priority cao. Mẫu KHÔNG gán content_type được coi là "dùng chung".
 */
export async function pickRelevantSamples(opts: {
  contentType?: string | null;
  tags?: string[];
  limit?: number;
}): Promise<StyleSample[]> {
  const limit = Math.max(1, Math.min(8, opts.limit ?? 4));
  try {
    const r = await pool.query(
      `SELECT id, title, content, tags, content_type, tone, priority
         FROM autopost_style_samples
        WHERE is_active = true
        ORDER BY priority DESC, id DESC
        LIMIT 200`,
    );
    const rows = r.rows.map(normalizeRow);
    if (rows.length === 0) return [];
    const ct = (opts.contentType ?? "").trim();
    const tagSet = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
    const scored = rows.map((s) => {
      let score = s.priority;
      if (ct && s.contentType === ct) score += 100; // đúng loại nội dung
      else if (!s.contentType) score += 20; // mẫu dùng chung
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
      `SELECT id, title, content, tags, content_type, tone, priority
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
