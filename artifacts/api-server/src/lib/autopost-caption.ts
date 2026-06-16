import { callChat } from "./ai-orchestrator";
import { fetchImageAsBase64, resolvePublicUrl } from "./autopost-images";

/**
 * TASK 4 — Sinh caption Facebook cho AutoPost (Amazing Studio).
 *
 * Tổng đài AI (callChat) trả 1–3 caption dưới dạng JSON. Module này build prompt,
 * (tuỳ chọn) đính kèm ảnh đầu tiên để dùng vision, parse JSON an toàn, rồi chạy
 * các "guard" thuần (kiểm tra giá bịa + từ cấm) trước khi trả về cho admin duyệt.
 *
 * AN TOÀN: generateCaptions KHÔNG BAO GIỜ throw. Mọi helper thuần đều không chạm
 * network/DB; chỉ generateCaptions mới gọi callChat / fetchImageAsBase64.
 */

export type CaptionItem = {
  contentType: string;
  title: string;
  images: string[];
  price?: number | null;
  salePrice?: number | null;
  goldenHourPercent?: number | null;
  goldenHourName?: string | null;
  category?: string | null;
  badge?: string | null;
  publicLink?: string | null;
};

export type CaptionFlags = { suspiciousPrice: boolean; bannedWords: string[] };

export type CaptionOption = { text: string; flags: CaptionFlags };

export type CaptionResult =
  | {
      ok: true;
      captions: CaptionOption[];
      recommendedIndex: number;
      usedVision: boolean;
      provider: string;
    }
  | { ok: false; reason: string };

export type CaptionOpts = { tone?: string; bannedWords?: string[] };

/**
 * Danh sách (nhỏ) các cụm từ nhạy cảm / spam mà Facebook hay phạt. Admin có thể
 * mở rộng danh sách này qua settings (truyền opts.bannedWords) — đây chỉ là mặc định.
 */
export const DEFAULT_BANNED_WORDS: string[] = [
  "rẻ nhất",
  "giảm sốc",
  "cam kết 100%",
  "số 1",
  "duy nhất",
  "tuyệt đối",
  "lừa đảo",
  "hàng nhái",
];

const DEFAULT_TONE = "ấm áp, tự nhiên, sang trọng";

// ─── Helpers thuần (export hết để test; KHÔNG chạm network/DB) ────────────────

/**
 * Định dạng số tiền VND: làm tròn, nhóm hàng nghìn bằng dấu chấm, thêm "đ".
 * Trả chuỗi rỗng cho null / 0 / NaN. Vd 1500000 -> "1.500.000đ".
 */
export function formatVnd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  const rounded = Math.round(n);
  if (rounded === 0) return "";
  const sign = rounded < 0 ? "-" : "";
  const digits = Math.abs(rounded).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${grouped}đ`;
}

/**
 * Chuẩn hóa một chuỗi "money-ish" về số VND. Bỏ dấu phân tách hàng nghìn
 * (chấm/phẩy/khoảng trắng). Hỗ trợ hậu tố: "k"/"nghìn" ×1.000, "tr"/"triệu"
 * ×1.000.000 (vd "1tr5" / "1.5 triệu" -> 1500000; "1500k" -> 1500000;
 * "1.500.000" -> 1500000). Trả null nếu không parse được.
 */
export function parseMoneyToken(raw: string): number | null {
  if (!raw) return null;
  let s = raw.toLowerCase().trim();
  // Bỏ ký hiệu tiền tệ rõ ràng ở cuối (đ / d / vnd) — chúng không đổi giá trị.
  s = s.replace(/(đ|vnd|d)\s*$/i, "").trim();

  // Hậu tố "triệu" / "tr" — có thể kèm phần thập phân kiểu "1tr5" hoặc "1.5 triệu".
  const trMatch = s.match(/^([\d.,\s]+?)\s*(?:triệu|tr)\s*(\d+)?$/i);
  if (trMatch) {
    const wholeRaw = trMatch[1];
    const tailRaw = trMatch[2]; // phần sau "tr", vd "1tr5" -> "5"
    const whole = normalizeDecimal(wholeRaw);
    if (whole == null) return null;
    let value = whole * 1_000_000;
    if (tailRaw != null && tailRaw !== "") {
      // "1tr5" => 1.5 triệu: mỗi chữ số sau là phần thập phân của triệu.
      const frac = Number(`0.${tailRaw}`);
      if (Number.isFinite(frac)) value += frac * 1_000_000;
    }
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  // Hậu tố "nghìn" / "k" — ×1.000.
  const kMatch = s.match(/^([\d.,\s]+?)\s*(?:nghìn|k)$/i);
  if (kMatch) {
    const num = normalizeDecimal(kMatch[1]);
    if (num == null) return null;
    const value = num * 1000;
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  // Không hậu tố: coi dấu chấm/phẩy/khoảng trắng là phân tách hàng nghìn.
  const digits = s.replace(/[.,\s]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/**
 * Chuẩn hóa một số có thể chứa phần thập phân ("1.5", "1,5") hoặc phân tách hàng
 * nghìn ("1.500"). Heuristic: nếu chỉ có MỘT dấu phân tách và phần sau ≤ 2 chữ số
 * thì coi là thập phân; ngược lại coi mọi dấu là phân tách hàng nghìn.
 */
function normalizeDecimal(raw: string): number | null {
  const s = raw.replace(/\s/g, "").trim();
  if (!s) return null;
  const seps = s.match(/[.,]/g);
  if (seps && seps.length === 1) {
    const idx = s.search(/[.,]/);
    const after = s.slice(idx + 1);
    if (after.length > 0 && after.length <= 2 && /^\d+$/.test(after) && /^\d+$/.test(s.slice(0, idx))) {
      const n = Number(`${s.slice(0, idx)}.${after}`);
      return Number.isFinite(n) ? n : null;
    }
  }
  const digits = s.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

// Tìm token tiền tệ: chuỗi chữ số có thể kèm . , và khoảng trắng, tuỳ chọn hậu tố.
// Cho phép phần thập phân dính sau "tr"/"triệu"/"k"/... (vd "1tr5" = 1.500.000) để
// cả token được giữ nguyên và chuyển cho parseMoneyToken (vốn đã hiểu dạng "1tr5").
const MONEY_REGEX = /\d[\d.,\s]*\s*(?:đ|d|k|vnd|nghìn|triệu|tr)?\d{0,2}/gi;

/**
 * Kiểm tra giá trong caption có khớp dữ liệu thật không. KHÔNG sửa số; nếu nghi
 * ngờ thì gắn tiền tố cảnh báo để admin tự kiểm. Cẩn thận KHÔNG cờ các số nhỏ
 * như năm 4 chữ số hay "2-4 câu" (yêu cầu có hậu tố tiền HOẶC ≥5 chữ số / có
 * dấu phân tách thì mới coi là tiền).
 */
export function priceGuard(caption: string, item: CaptionItem): { text: string; suspicious: boolean } {
  const allowed: number[] = [];
  for (const p of [item.price, item.salePrice]) {
    if (p != null && Number.isFinite(p)) {
      const r = Math.round(p);
      if (r > 0) allowed.push(r);
    }
  }
  const tolerance = 1000;
  let suspicious = false;

  const matches = caption.match(MONEY_REGEX) ?? [];
  for (const rawMatch of matches) {
    const token = rawMatch.trim().replace(/[.,\s]+$/, ""); // bỏ dấu phân tách/khoảng trắng thừa ở cuối
    if (!token) continue;
    // Hậu tố tiền tệ; cho phép phần thập phân dính sau "tr"/"triệu" kiểu "1tr5".
    const hasSuffix = /(đ|d|k|vnd|nghìn|triệu|tr)\s*\d{0,2}$/i.test(token);
    // Dấu phân tách chỉ tính khi nằm GIỮA chữ số (vd "1.500"), không tính dấu
    // dính ở cuối kiểu năm "2024," → tránh cờ nhầm năm / "2-4 câu".
    const hasInnerSeparator = /\d[.,]\d/.test(token);
    const digitCount = (token.match(/\d/g) ?? []).length;
    // Chỉ coi là "tiền" khi có hậu tố tiền tệ, hoặc đủ lớn / có dấu phân tách trong.
    const looksLikeMoney = hasSuffix || hasInnerSeparator || digitCount >= 5;
    if (!looksLikeMoney) continue;

    const value = parseMoneyToken(token);
    if (value == null) continue;

    if (allowed.length === 0) {
      // Item không có giá nào → mọi token tiền đều đáng ngờ.
      suspicious = true;
      continue;
    }
    const matchesAllowed = allowed.some((a) => Math.abs(a - value) <= tolerance);
    if (!matchesAllowed) suspicious = true;
  }

  const text = suspicious ? `⚠️[KIỂM TRA GIÁ] ${caption}` : caption;
  return { text, suspicious };
}

/**
 * Trả danh sách (đã khử trùng lặp) các cụm từ cấm xuất hiện trong caption.
 * So khớp substring không phân biệt HOA/thường, CÓ phân biệt dấu.
 */
export function bannedWordsGuard(caption: string, banned: string[]): string[] {
  const lower = (caption ?? "").toLowerCase();
  const found: string[] = [];
  for (const phrase of banned) {
    if (!phrase) continue;
    if (lower.includes(phrase.toLowerCase()) && !found.includes(phrase)) {
      found.push(phrase);
    }
  }
  return found;
}

/**
 * Trích JSON một cách bền bỉ: gỡ code fence markdown, lấy khối {...} đầu tiên,
 * JSON.parse; validate captions là mảng chuỗi không rỗng (giữ tối đa 3),
 * recommendedIndex là số (mặc định 0). Trả null khi BẤT KỲ lỗi nào (không throw).
 */
export function parseCaptions(text: string): { captions: string[]; recommendedIndex: number } | null {
  try {
    if (!text || typeof text !== "string") return null;
    let s = text.trim();

    // Gỡ code fence ```json ... ``` hoặc ``` ... ```.
    const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) s = fenceMatch[1].trim();

    // Lấy khối {...} đầu tiên (từ "{" đầu tới "}" cuối).
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end < 0 || end <= start) return null;
    const jsonSlice = s.slice(start, end + 1);

    const parsed = JSON.parse(jsonSlice) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as { captions?: unknown; recommendedIndex?: unknown };

    if (!Array.isArray(obj.captions)) return null;
    const captions = obj.captions
      .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      .map((c) => c.trim())
      .slice(0, 3);
    if (captions.length === 0) return null;

    let recommendedIndex = 0;
    if (typeof obj.recommendedIndex === "number" && Number.isFinite(obj.recommendedIndex)) {
      recommendedIndex = Math.trunc(obj.recommendedIndex);
    }

    return { captions, recommendedIndex };
  } catch {
    return null;
  }
}

/** Build system prompt (tiếng Việt) — persona + ràng buộc cứng. */
export function buildSystemPrompt(item: CaptionItem, tone: string, banned: string[]): string {
  const bannedList = banned.join(", ");
  const lines = [
    `Bạn là người viết caption Facebook cho Amazing Studio — studio chụp ảnh cưới & beauty.`,
    `Giọng văn: ${tone}. Viết tự nhiên như người thật, KHÔNG robot, KHÔNG văn mẫu sáo rỗng.`,
    `Chỉ dùng số tiền/khuyến mãi ĐÚNG theo dữ liệu được cung cấp; TUYỆT ĐỐI KHÔNG bịa giá hay tự thêm con số.`,
    `Viết đúng loại dịch vụ "${item.contentType}"; KHÔNG nói sai sang dịch vụ khác.`,
    `KHÔNG dùng từ ngữ nhạy cảm / bị Facebook hạn chế. Tránh các cụm sau: ${bannedList}.`,
    `Mỗi caption ngắn gọn 2-4 câu, kèm 2-4 hashtag thuần tiếng Việt (không dấu cũng được).`,
    item.publicLink ? `Chèn đường link này ở CUỐI mỗi caption: ${item.publicLink}` : null,
    `PHẢI trả về JSON đúng dạng {"captions":["...","...","..."],"recommendedIndex":0} và KHÔNG kèm bất kỳ văn bản nào khác.`,
  ].filter((l): l is string => !!l);
  return lines.join("\n");
}

/** Build phần user text: liệt kê metadata có sẵn, bỏ qua dòng thiếu dữ liệu. */
export function buildUserText(item: CaptionItem): string {
  const lines: string[] = [];
  lines.push(`Tên: ${item.title}`);
  const priceStr = formatVnd(item.price);
  if (priceStr) lines.push(`Giá thuê: ${priceStr}`);
  const saleStr = formatVnd(item.salePrice);
  if (saleStr) lines.push(`Giá sale: ${saleStr}`);
  if (item.goldenHourPercent != null && Number.isFinite(item.goldenHourPercent) && item.goldenHourPercent > 0) {
    const ghName = item.goldenHourName ? ` (${item.goldenHourName})` : "";
    lines.push(`Giờ vàng: giảm ${item.goldenHourPercent}%${ghName}`);
  }
  if (item.category) lines.push(`Danh mục: ${item.category}`);
  if (item.badge) lines.push(`Nhãn: ${item.badge}`);
  lines.push(`Loại dịch vụ: ${item.contentType}`);
  return lines.join("\n");
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

/**
 * Sinh caption cho 1 item. KHÔNG BAO GIỜ throw — mọi lỗi → { ok:false, reason }.
 * Thử lần 1 kèm ảnh (nếu có); nếu thất bại thì fallback metadata-only (bỏ ảnh).
 */
export async function generateCaptions(item: CaptionItem, opts?: CaptionOpts): Promise<CaptionResult> {
  try {
    const tone = opts?.tone || DEFAULT_TONE;
    const banned = opts?.bannedWords && opts.bannedWords.length ? opts.bannedWords : DEFAULT_BANNED_WORDS;

    // Resolve ảnh đầu tiên (null nếu thất bại — fetchImageAsBase64 không throw).
    const img =
      item.images && item.images[0]
        ? await fetchImageAsBase64(resolvePublicUrl(item.images[0]))
        : null;

    const system = buildSystemPrompt(item, tone, banned);
    const userText = buildUserText(item);

    const callOnce = async (withImage: boolean) => {
      const message =
        withImage && img
          ? { role: "user" as const, content: userText, images: [{ mediaType: img.mediaType, dataBase64: img.dataBase64 }] }
          : { role: "user" as const, content: userText };
      return await callChat({
        system,
        messages: [message],
        jsonMode: true,
        maxTokens: 700,
        label: "autopost-caption",
      });
    };

    // Attempt 1 — kèm ảnh nếu có.
    const res1 = await callOnce(!!img);
    if (res1.ok) {
      const parsed1 = parseCaptions(res1.text);
      if (parsed1) return finalize(parsed1, item, banned, !!img, res1.providerUsed);
    }

    // Fallback — chỉ khi attempt 1 fail VÀ ta đã dùng ảnh: thử lại không ảnh.
    let lastRes: typeof res1 = res1;
    if (img && (!res1.ok || parseCaptions(res1.text) == null)) {
      const res2 = await callOnce(false);
      lastRes = res2;
      if (res2.ok) {
        const parsed2 = parseCaptions(res2.text);
        if (parsed2) return finalize(parsed2, item, banned, false, res2.providerUsed);
      }
    }

    // Vẫn không thành công.
    const reason = lastRes.ok === false ? lastRes.adminAlert || lastRes.reason : "parse_failed";
    return { ok: false, reason };
  } catch (e) {
    return { ok: false, reason: "exception:" + String((e as Error)?.message ?? e) };
  }
}

function finalize(
  parsed: { captions: string[]; recommendedIndex: number },
  item: CaptionItem,
  banned: string[],
  usedVision: boolean,
  provider: string,
): CaptionResult {
  const captions: CaptionOption[] = parsed.captions.map((raw) => {
    const guarded = priceGuard(raw, item);
    const bannedFound = bannedWordsGuard(guarded.text, banned);
    return {
      text: guarded.text,
      flags: { suspiciousPrice: guarded.suspicious, bannedWords: bannedFound },
    };
  });
  const recommendedIndex = clamp(parsed.recommendedIndex, 0, captions.length - 1);
  return { ok: true, captions, recommendedIndex, usedVision, provider };
}
