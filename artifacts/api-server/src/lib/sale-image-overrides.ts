import type { ServiceIntent } from "./sale-vision";
import {
  type SampleImage, type SampleSourceType,
  normalizeIntent, detectServiceIntentFromText, toPublicImageUrl,
} from "./sale-samples";

/**
 * sale-image-overrides.ts — "Admin tự dạy Lulu chọn ảnh đúng".
 *
 * Việc chọn ảnh mẫu (sale-samples.ts) là DETERMINISTIC theo luật regex + DB. Khi nó chọn SAI,
 * trước đây phải sửa CODE. Module này cho phép admin DẠY bằng dữ liệu: với mỗi (intent + tone/gu),
 * admin chỉ định bộ ảnh ĐÚNG. Các "override" này lưu trong rulesJson của version não Lulu
 * (rulesJson.imageOverrides) — nên:
 *   - Lưu vào bản NHÁP → test ngay trong Brain Lab, CHƯA đụng bản chạy thật.
 *   - Khi admin "Áp dụng version" → rulesJson đi theo version thành active → LIVE tự dùng.
 *
 * AN TOÀN: thuần hàm, KHÔNG đụng DB, KHÔNG throw. Override chỉ THAY ảnh mẫu — KHÔNG đụng giá,
 * KHÔNG đụng marker, KHÔNG tạo booking. Không match → trả nguyên kết quả chọn ảnh cũ.
 */

/** Một ảnh admin đã chọn (đủ field để render ở Brain Lab + gửi Messenger). */
export type OverrideImage = {
  imageUrl: string;
  title: string;
  detailUrl?: string;
  sourceType: string;        // gallery | rental_item | photo_idea | service_package | manual
  serviceIntent?: string;
};

/** Một luật "ảnh đúng" admin đã dạy cho 1 tình huống (intent + tone/gu). */
export type ImageOverride = {
  id: string;
  /** Câu khách hỏi (ví dụ gốc admin báo lỗi). */
  customerQuestion: string;
  /** Nhóm nhu cầu (raw, chuẩn hóa khi match). null = áp cho mọi intent (hiếm dùng). */
  intent: string | null;
  /** Tone/gu (raw label, vd "nhẹ nhàng"). null = áp cho intent bất kể tone. */
  tone: string | null;
  /** Ảnh Lulu đã gửi SAI (chỉ để hiểu/đối chiếu, KHÔNG bắt buộc). */
  wrongImages: string[];
  /** Ảnh admin chọn ĐÚNG (1–4). */
  correctImages: OverrideImage[];
  /** Text admin sửa lại (tùy chọn). Vai trò tùy responseMode: câu nói y chang HOẶC câu mẫu. */
  editedText: string | null;
  /**
   * Cách Lulu dùng editedText cho tình huống này:
   *  - "exact_reply": Lulu nói Y CHANG editedText (KHÔNG cho AI viết lại text).
   *  - "learn_from_this": AI được viết lại cho tự nhiên nhưng phải BÁM editedText, giữ đúng ý chính.
   *  - null: không ép text (chỉ dùng ảnh đúng như cũ).
   */
  responseMode: "exact_reply" | "learn_from_this" | null;
  createdAt: string;
  createdByName: string | null;
};

// ─── Dò TONE / GU từ tin khách (chuẩn hóa về key chuẩn để match được dù chữ khác nhau) ──
const TONE_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: "nhe_nhang", re: /(nhẹ nhàng|nhe nhang|tự nhiên|tu nhien|trong sáng|trong sang|nhẹ|nhe\b|dịu dàng|diu dang|đời thường|doi thuong)/i },
  { key: "sang_trong", re: /(sang trọng|sang trong|sang chảnh|sang chanh|quý phái|quy phai|cổ điển|co dien|luxury|vip|đẳng cấp|dang cap|quyền lực|quyen luc)/i },
  { key: "hien_dai", re: /(hiện đại|hien dai|tối giản|toi gian|modern|minimal|trẻ trung|tre trung|năng động|nang dong)/i },
  { key: "han_quoc", re: /(hàn quốc|han quoc|korea|korean|nàng thơ|nang tho|\bthơ\b|\bhàn\b|\bhan\b)/i },
  { key: "ca_tinh", re: /(cá tính|ca tinh|ngầu|ngau|\bcool\b|cool boy|cá tánh|ca tanh|bụi|bui|\bchất\b|\bchat\b|cứng|lạnh lùng|lanh lung)/i },
  { key: "vintage", re: /(vintage|retro|hoài cổ|hoai co|cổ trang|co trang|xưa|xua)/i },
  { key: "tay_au", re: /(tây âu|tay au|châu âu|chau au|âu mỹ|au my|tone tây|tone tay|high fashion|tạp chí|tap chi)/i },
];

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "d")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

// HỌ dịch vụ — gom các intent gần nhau (cưới: gate/album/party) để match NỚI. Lý do: phát hiện
// intent từ tên album rất yếu (album đặt theo tên cặp đôi/mood), nên gate/album/party hay lẫn nhau.
// Match theo họ giúp "dạy cho chụp cổng" vẫn áp cho lượt được nhận là album cưới (và ngược lại).
const INTENT_FAMILY: Record<string, string> = {
  wedding_album: "wedding", wedding_gate: "wedding", wedding_party: "wedding",
  beauty: "beauty", rental_outfit: "rental", maternity: "maternity",
  family: "family", new_concept_idea: "concept",
};
export function intentFamily(intent: string | null | undefined): string {
  const k = norm(intent).replace(/ /g, "_");
  return INTENT_FAMILY[k] ?? k;
}

/** Tập key tone xuất hiện trong text (rỗng nếu không thấy tone nào). */
export function detectTones(text: string | null | undefined): string[] {
  const t = (text ?? "").toString();
  if (!t.trim()) return [];
  const out: string[] = [];
  for (const { key, re } of TONE_PATTERNS) if (re.test(t) && !out.includes(key)) out.push(key);
  return out;
}

/**
 * Chuẩn hóa nhãn tone admin lưu thành tập key để match. Nếu không khớp pattern nào,
 * giữ lại nhãn đã norm để có thể match bằng substring (tone tự do admin gõ).
 */
export function toneKeysFromLabel(label: string | null | undefined): string[] {
  const keys = detectTones(label);
  if (keys.length) return keys;
  const n = norm(label);
  return n ? [n] : [];
}

// ─── Parse / serialize overrides trong rulesJson ──────────────────────────────

/** rulesJson có thể là object/string/null → lấy ra mảng imageOverrides an toàn. */
export function parseImageOverrides(rulesJson: unknown): ImageOverride[] {
  let obj: unknown = rulesJson;
  if (typeof obj === "string") { try { obj = JSON.parse(obj); } catch { return []; } }
  if (!obj || typeof obj !== "object") return [];
  const arr = (obj as { imageOverrides?: unknown }).imageOverrides;
  if (!Array.isArray(arr)) return [];
  const out: ImageOverride[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const correct = Array.isArray(o.correctImages)
      ? (o.correctImages as unknown[]).map(mapOverrideImage).filter((x): x is OverrideImage => !!x)
      : [];
    const editedText = o.editedText != null ? String(o.editedText) : null;
    const rmRaw = o.responseMode != null ? String(o.responseMode) : null;
    const responseMode: ImageOverride["responseMode"] =
      (rmRaw === "exact_reply" || rmRaw === "learn_from_this") && editedText && editedText.trim() ? rmRaw : null;
    // Bỏ override vô nghĩa: KHÔNG ảnh ĐÚNG và cũng KHÔNG ghim text → không có gì để áp.
    if (correct.length === 0 && !responseMode) continue;
    out.push({
      id: String(o.id ?? `${out.length}`),
      customerQuestion: String(o.customerQuestion ?? "").slice(0, 1000),
      intent: o.intent != null ? String(o.intent) : null,
      tone: o.tone != null ? String(o.tone) : null,
      wrongImages: Array.isArray(o.wrongImages) ? (o.wrongImages as unknown[]).map((u) => String(u)).filter(Boolean) : [],
      correctImages: correct.slice(0, 4),
      editedText,
      responseMode,
      createdAt: String(o.createdAt ?? ""),
      createdByName: o.createdByName != null ? String(o.createdByName) : null,
    });
  }
  return out;
}

function mapOverrideImage(raw: unknown): OverrideImage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const imageUrl = String(o.imageUrl ?? "").trim();
  if (!imageUrl) return null;
  return {
    imageUrl,
    title: String(o.title ?? "").trim() || "Ảnh mẫu",
    detailUrl: o.detailUrl != null && String(o.detailUrl).trim() ? String(o.detailUrl).trim() : undefined,
    sourceType: String(o.sourceType ?? "gallery"),
    serviceIntent: o.serviceIntent != null ? String(o.serviceIntent) : undefined,
  };
}

/** Ghép overrides vào object rulesJson (giữ các field rulesJson khác nếu có). */
export function withImageOverrides(rulesJson: unknown, overrides: ImageOverride[]): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  let obj: unknown = rulesJson;
  if (typeof obj === "string") { try { obj = JSON.parse(obj); } catch { obj = null; } }
  if (obj && typeof obj === "object") base = { ...(obj as Record<string, unknown>) };
  return { ...base, imageOverrides: overrides };
}

// ─── Map OverrideImage → SampleImage (khuôn dùng chung cho test & Messenger) ───
const VALID_SOURCE: SampleSourceType[] = ["service_package", "rental_item", "gallery", "photo_idea"];
function toSampleSourceType(s: string): SampleSourceType {
  return (VALID_SOURCE as string[]).includes(s) ? (s as SampleSourceType) : "gallery";
}
function toSampleImage(o: OverrideImage): SampleImage {
  return {
    title: o.title,
    imageUrl: o.imageUrl,
    detailUrl: o.detailUrl,
    sourceType: toSampleSourceType(o.sourceType),
    serviceIntent: o.serviceIntent,
  };
}

// ─── Match 1 override cho tình huống hiện tại ─────────────────────────────────

export type OverrideMatchCtx = {
  /** Intent đã suy ra (vd từ marker/Vision). Rỗng/unknown → tự suy từ message + context. */
  detectedIntent?: string | null;
  messageText?: string | null;
  contextText?: string | null;
};

export type OverrideMatch = {
  override: ImageOverride;
  /** Tone hiện trong tin khách trùng tone của override (→ được phép FORCE gửi ảnh dù cổng chưa mở). */
  toneTriggered: boolean;
};

/** Suy intent hiệu lực: ưu tiên detectedIntent, rồi message, rồi context. null nếu không rõ. */
function resolveIntent(ctx: OverrideMatchCtx): ServiceIntent | null {
  const fromDetected = normalizeIntent(ctx.detectedIntent ?? null);
  if (fromDetected) return fromDetected;
  const fromMsg = detectServiceIntentFromText(ctx.messageText ?? "");
  if (fromMsg !== "unknown") return fromMsg;
  const fromCtx = detectServiceIntentFromText(ctx.contextText ?? "");
  return fromCtx !== "unknown" ? fromCtx : null;
}

/**
 * Khớp override ĐIỀU KHIỂN TEXT (responseMode) cho 1 lượt — chạy TRƯỚC khi gọi AI:
 *  - exact_reply       → caller trả đúng editedText, KHÔNG gọi AI viết text.
 *  - learn_from_this   → caller chèn editedText làm câu mẫu vào prompt cho AI bám theo.
 * Khớp theo: TRÙNG câu hỏi gốc (customerQuestion) HOẶC cùng HỌ dịch vụ (intent suy từ tin khách / ngữ cảnh).
 * Chỉ xét override có responseMode + editedText. Trả null nếu không khớp.
 */
export function matchResponseOverride(
  message: string | null | undefined,
  contextText: string | null | undefined,
  overrides: ImageOverride[],
): ImageOverride | null {
  const cands = (overrides ?? []).filter((o) => o.responseMode && (o.editedText ?? "").trim());
  if (cands.length === 0) return null;

  // 1) Trùng câu hỏi gốc admin đã dạy (mạnh nhất, bất kể intent/tone).
  const msgNorm = norm(message);
  if (msgNorm) {
    for (const o of cands) {
      const q = norm(o.customerQuestion);
      if (!q) continue;
      if (q === msgNorm || (q.length >= 8 && msgNorm.length >= 8 && (q.includes(msgNorm) || msgNorm.includes(q)))) return o;
    }
  }
  // 2) Cùng họ dịch vụ (intent suy từ tin khách, rồi tới ngữ cảnh).
  let intent = detectServiceIntentFromText(message ?? "");
  if (intent === "unknown") intent = detectServiceIntentFromText(contextText ?? "");
  if (intent !== "unknown") {
    for (const o of cands) {
      if (!o.intent) return o;
      const oi = normalizeIntent(o.intent);
      if (oi && intentFamily(oi) === intentFamily(intent)) return o;
    }
  }
  return null;
}

/**
 * Tìm override khớp nhất cho tình huống. Quy tắc:
 *  - intent của override (chuẩn hóa) phải TRÙNG intent hiệu lực (nếu override có intent).
 *  - Trong các ứng viên cùng intent: ưu tiên override có TONE trùng tone đang nói; nếu không có,
 *    lấy override KHÔNG ghi tone (generic cho intent đó).
 *  - toneTriggered = tin khách lượt này CÓ nêu tone và trùng tone override → cho phép FORCE gửi ảnh
 *    (đáp ứng "khách chỉ chọn gu/tone → phải gửi ảnh mẫu, không bung bảng giá").
 */
export function matchImageOverride(overrides: ImageOverride[], ctx: OverrideMatchCtx): OverrideMatch | null {
  if (!overrides || overrides.length === 0) return null;
  const intent = resolveIntent(ctx);
  const msgTones = detectTones(ctx.messageText);
  const allTones = msgTones.length ? msgTones : detectTones(ctx.contextText);

  // Ứng viên cùng HỌ dịch vụ (hoặc override không ghi intent → áp mọi intent).
  // So theo họ (wedding_gate ~ wedding_album ~ wedding_party) vì phát hiện intent từ tên album yếu.
  const candidates = overrides.filter((o) => {
    if (!o.intent) return true;
    const oi = normalizeIntent(o.intent);
    return oi != null && intent != null && intentFamily(oi) === intentFamily(intent);
  });
  if (candidates.length === 0) return null;

  // 1) Trùng tone (ưu tiên tone trong CHÍNH tin khách lượt này → toneTriggered).
  for (const o of candidates) {
    if (!o.tone) continue;
    const oKeys = toneKeysFromLabel(o.tone);
    if (oKeys.some((k) => msgTones.includes(k))) return { override: o, toneTriggered: true };
  }
  // 2) Trùng tone theo NGỮ CẢNH gần đây (không force, chỉ thay khi cổng đã mở).
  for (const o of candidates) {
    if (!o.tone) continue;
    const oKeys = toneKeysFromLabel(o.tone);
    if (oKeys.some((k) => allTones.includes(k))) return { override: o, toneTriggered: false };
  }
  // 3) Override generic cho intent (không ghi tone). Force khi khách vừa nêu tone bất kỳ.
  const generic = candidates.find((o) => !o.tone);
  if (generic) return { override: generic, toneTriggered: msgTones.length > 0 };

  return null;
}

// ─── Áp override vào kết quả chọn ảnh ─────────────────────────────────────────

export type SampleSelection = {
  images: SampleImage[];
  links: { title: string; url: string }[];
  resolvedIntents: ServiceIntent[];
  exhausted: boolean;
};

export type ApplyOverrideResult = SampleSelection & {
  /** true nếu đã thay bằng ảnh admin dạy. */
  overrideApplied: boolean;
  overrideId: string | null;
};

/**
 * Thay ảnh mẫu bằng ảnh admin đã dạy NẾU khớp. CỔNG GỬI:
 *   - Cổng đã mở (sel.images.length > 0): thay ảnh sai bằng ảnh đúng (giữ đúng số lượng tối đa).
 *   - toneTriggered (khách vừa nêu tone/gu trùng override): FORCE gửi ảnh dù sel rỗng.
 * Loại ảnh ĐÃ GỬI (excludeUrls) để không spam trùng; nếu sau loại còn rỗng → giữ kết quả cũ.
 * KHÔNG match → trả nguyên sel + overrideApplied=false.
 */
export function applyImageOverrides(
  sel: SampleSelection,
  overrides: ImageOverride[],
  ctx: OverrideMatchCtx & { excludeUrls?: string[]; maxTotal?: number },
): ApplyOverrideResult {
  const base: ApplyOverrideResult = { ...sel, overrideApplied: false, overrideId: null };
  const match = matchImageOverride(overrides, ctx);
  if (!match) return base;

  const gateOpen = sel.images.length > 0;
  if (!gateOpen && !match.toneTriggered) return base; // chưa tới lúc gửi ảnh → không tự bung

  const maxTotal = Math.max(1, Math.min(4, ctx.maxTotal ?? 4));
  const exclude = new Set((ctx.excludeUrls ?? []).map((u) => toPublicImageUrl(u)).filter(Boolean));
  const picked: SampleImage[] = [];
  for (const oi of match.override.correctImages) {
    if (picked.length >= maxTotal) break;
    const key = toPublicImageUrl(oi.imageUrl);
    if (!key || exclude.has(key)) continue;
    picked.push(toSampleImage(oi));
    exclude.add(key);
  }
  if (picked.length === 0) return base; // ảnh đúng đều đã gửi rồi → giữ nguyên (caller tự xử exhausted)

  return {
    images: picked,
    links: [], // ảnh admin dạy không kèm link "xem thêm" (gửi ảnh + link trông quá chỉn chu → lộ bot)
    resolvedIntents: sel.resolvedIntents,
    exhausted: false,
    overrideApplied: true,
    overrideId: match.override.id,
  };
}
