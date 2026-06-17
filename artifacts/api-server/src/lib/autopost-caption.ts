import { callChat } from "./ai-orchestrator";
import { fetchImageAsBase64, resolvePublicUrl } from "./autopost-images";
import { stripContacts } from "./autopost-sanitize";

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
      visionImageCount: number;
      provider: string;
    }
  | { ok: false; reason: string };

export type CaptionOpts = {
  tone?: string;
  bannedWords?: string[];
  /** Khối "văn phong mẫu" (đã build sẵn) nhét vào cuối system prompt — học giọng, không chép. */
  styleBlock?: string;
  /** Số caption muốn AI sinh (1–6). Mặc định 3. */
  captionCount?: number;
  /** Số ảnh tối đa cho AI đọc (vision). Mặc định 1 (giữ hành vi cũ). */
  maxVisionImages?: number;
  /** Phong cách/mood: preset (natural|emotional|elegant|fun|short) hoặc câu mô tả tự do. */
  style?: string;
};

/** Cụm "văn mẫu sáo rỗng vô hồn" cần TRÁNH nếu không có ngữ cảnh thật. */
export const CLICHE_PHRASES: string[] = [
  "lưu giữ khoảnh khắc tuyệt vời",
  "khoảnh khắc đáng nhớ",
  "hạnh phúc viên mãn",
  "sang trọng đẳng cấp",
  "đẳng cấp vượt trội",
  "trọn vẹn yêu thương",
  "lung linh huyền ảo",
];

/** Preset phong cách → 1 câu hướng dẫn ngắn cho AI. */
export const STYLE_PRESETS: Record<string, string> = {
  natural: "Phong cách: tự nhiên, đời thường, gần gũi, như đang kể chuyện thật.",
  emotional: "Phong cách: nhiều cảm xúc, ấm áp, chạm tới người đọc (không sến, không lố).",
  elegant: "Phong cách: sang nhẹ, tinh tế, chữ ít mà sâu, không phô trương.",
  fun: "Phong cách: vui tươi, dí dỏm, trẻ trung, có thể chèn 1 emoji hợp cảnh.",
  short: "Phong cách: RẤT ngắn, 1-2 câu, đi thẳng vào điểm nhấn, không lan man.",
};

/** Trả câu hướng dẫn phong cách từ preset hoặc dùng nguyên văn nếu là mô tả tự do. */
export function resolveStyleInstruction(style?: string): string {
  const s = (style ?? "").trim();
  if (!s) return "";
  return STYLE_PRESETS[s] ?? `Phong cách yêu cầu: ${s}.`;
}

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
export function parseCaptions(text: string, maxCount = 3): { captions: string[]; recommendedIndex: number } | null {
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
      .slice(0, Math.max(1, Math.min(6, Math.trunc(maxCount) || 3)));
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
export function buildSystemPrompt(item: CaptionItem, tone: string, banned: string[], captionCount = 3, style = ""): string {
  const bannedList = banned.join(", ");
  const n = Math.max(1, Math.min(6, Math.trunc(captionCount) || 3));
  const styleLine = resolveStyleInstruction(style);
  const lines = [
    `Bạn là người viết caption Facebook cho Amazing Studio — studio chụp ảnh cưới & beauty.`,
    `Giọng văn: ${tone}. Viết tự nhiên như người thật, có cảm xúc, có HOOK ở 3 giây đầu (câu mở phải hút); KHÔNG robot, KHÔNG nói quá lố, KHÔNG quá bán hàng.`,
    styleLine || null,
    `Chỉ dùng số tiền/khuyến mãi ĐÚNG theo dữ liệu được cung cấp; TUYỆT ĐỐI KHÔNG bịa giá hay tự thêm con số.`,
    `Viết đúng loại dịch vụ "${item.contentType}"; KHÔNG nói sai sang dịch vụ khác.`,
    `KHÔNG dùng từ ngữ nhạy cảm / bị Facebook hạn chế. Tránh các cụm sau: ${bannedList}.`,
    `TRÁNH văn mẫu sáo rỗng vô hồn (chỉ dùng khi CÓ ngữ cảnh thật cụ thể), ví dụ: ${CLICHE_PHRASES.map((p) => `"${p}"`).join(", ")}. Hãy tả CỤ THỂ điều thấy được thay vì nói chung chung.`,
    `KHÔNG tự thêm số điện thoại, địa chỉ, website, link Facebook/TikTok/Zalo, hay tên studio nào — phần thông tin liên hệ sẽ được hệ thống tự gắn ở CUỐI bài. Chỉ viết NỘI DUNG CHÍNH.`,
    `Mỗi caption ngắn gọn 2-4 câu, kèm 2-4 hashtag thuần tiếng Việt (không dấu cũng được).`,
    item.publicLink ? `Chèn đường link này ở CUỐI mỗi caption: ${item.publicLink}` : null,
    `Tạo ĐÚNG ${n} caption KHÁC NHAU rõ rệt (khác hook/góc nhìn), không trùng ý.`,
    `PHẢI trả về JSON đúng dạng {"captions":[${Array.from({ length: n }, () => '"..."').join(",")}],"recommendedIndex":0} và KHÔNG kèm bất kỳ văn bản nào khác.`,
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
    const captionCount = Math.max(1, Math.min(6, Math.trunc(opts?.captionCount ?? 0) || 3));
    const maxVision = Math.max(1, Math.min(10, Math.trunc(opts?.maxVisionImages ?? 0) || 1));
    const styleBlock = typeof opts?.styleBlock === "string" ? opts.styleBlock.trim() : "";

    // Resolve TỐI ĐA `maxVision` ảnh (bỏ ảnh fetch lỗi — fetchImageAsBase64 không throw).
    const imgs: { mediaType: string; dataBase64: string }[] = [];
    for (const url of (item.images ?? []).slice(0, maxVision)) {
      const got = await fetchImageAsBase64(resolvePublicUrl(url));
      if (got) imgs.push({ mediaType: got.mediaType, dataBase64: got.dataBase64 });
    }

    const system = buildSystemPrompt(item, tone, banned, captionCount, opts?.style) + (styleBlock ? "\n\n" + styleBlock : "");
    const userText = buildUserText(item);
    // Khi đọc nhiều ảnh, gợi ý AI quan sát toàn bộ để tả bối cảnh/trang phục/tông màu/cảm xúc.
    const visionHint =
      imgs.length > 1
        ? `\n\nBạn được xem ${imgs.length} ảnh của cùng bộ này — hãy quan sát bối cảnh, trang phục, tông màu, cảm xúc, điểm nổi bật để viết tự nhiên & cụ thể hơn.`
        : "";
    const maxTokens = Math.min(2200, 350 + captionCount * 280);

    const callOnce = async (withImage: boolean) => {
      const message =
        withImage && imgs.length > 0
          ? { role: "user" as const, content: userText + visionHint, images: imgs }
          : { role: "user" as const, content: userText };
      return await callChat({
        system,
        messages: [message],
        jsonMode: true,
        maxTokens,
        label: "autopost-caption",
      });
    };

    // Attempt 1 — kèm ảnh nếu có.
    const res1 = await callOnce(imgs.length > 0);
    if (res1.ok) {
      const parsed1 = parseCaptions(res1.text, captionCount);
      if (parsed1) return finalize(parsed1, item, banned, imgs.length > 0, imgs.length, res1.providerUsed);
    }

    // Fallback — chỉ khi attempt 1 fail VÀ ta đã dùng ảnh: thử lại KHÔNG ảnh (metadata-only).
    let lastRes: typeof res1 = res1;
    if (imgs.length > 0 && (!res1.ok || parseCaptions(res1.text, captionCount) == null)) {
      const res2 = await callOnce(false);
      lastRes = res2;
      if (res2.ok) {
        const parsed2 = parseCaptions(res2.text, captionCount);
        if (parsed2) return finalize(parsed2, item, banned, false, 0, res2.providerUsed);
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
  visionImageCount: number,
  provider: string,
): CaptionResult {
  const captions: CaptionOption[] = parsed.captions.map((rawText) => {
    // Sanitize TRƯỚC: xoá mọi liên hệ lạ AI lỡ thêm (footer chính chủ gắn lúc đăng).
    const raw = stripContacts(rawText);
    const guarded = priceGuard(raw, item);
    const bannedFound = bannedWordsGuard(guarded.text, banned);
    return {
      text: guarded.text,
      flags: { suspiciousPrice: guarded.suspicious, bannedWords: bannedFound },
    };
  });
  const recommendedIndex = clamp(parsed.recommendedIndex, 0, captions.length - 1);
  return { ok: true, captions, recommendedIndex, usedVision, visionImageCount, provider };
}
