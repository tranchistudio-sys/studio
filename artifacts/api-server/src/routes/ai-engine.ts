import { db, pool } from "@workspace/db";
import { settingsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { getPublicBaseUrl } from "../lib/publicUrl";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a stored /objects/... path (or already-absolute URL) to an
 * absolute public URL suitable for sending to Facebook Graph API or
 * embedding in the Test Room frontend.
 */
export function resolveImagePath(path: string): string {
  if (!path || !path.trim()) return "";
  const p = path.trim();
  // Already an absolute URL → return as-is
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  // /objects/<uuid> → resolve via storage route
  const clean = p.replace(/^\/objects\//, "");
  return `${getPublicBaseUrl()}/api/storage/objects/${clean}`;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type AiSettings = {
  // Behavior
  minDelayMs: number;
  maxDelayMs: number;
  typingIndicator: boolean;
  chunkMessages: boolean;
  maxSentencesPerBubble: number;
  // Tone & Style
  pronounStyle: "em_ban" | "minh_ban" | "custom";
  customPronounSelf: string;
  customPronounCustomer: string;
  useEmoji: boolean;
  bannedKeywords: string[];
  // Sale Settings
  autoPriceQuote: boolean;
  maxDiscountPercent: number;
  priceImageSteps: number[];
  autoSendPriceImage: boolean;
  priceImageSendSteps: number[];
  sendPriceTextAfterImage: boolean;
  // Fallback
  fallbackMessages: string[];
  gptErrorMessages: string[];
  saveUnknownQuestions: boolean;
  // Debug
  logDecisions: boolean;
  forceQaOnly: boolean;
  forceGptOnly: boolean;
};

export function defaultAiSettings(): AiSettings {
  return {
    minDelayMs: 800,
    maxDelayMs: 2500,
    typingIndicator: true,
    chunkMessages: true,
    maxSentencesPerBubble: 3,
    pronounStyle: "em_ban",
    customPronounSelf: "em",
    customPronounCustomer: "bạn",
    useEmoji: false,
    bannedKeywords: ["trợ lý AI", "ChatGPT", "OpenAI"],
    autoPriceQuote: true,
    maxDiscountPercent: 10,
    priceImageSteps: [4],
    autoSendPriceImage: false,
    priceImageSendSteps: [4],
    sendPriceTextAfterImage: true,
    fallbackMessages: [
      "Dạ bạn chờ em xíu nha, em kiểm tra lại cho mình ạ",
      "Dạ để em xem lại thông tin chính xác rồi báo mình liền nha",
    ],
    gptErrorMessages: [
      "Dạ bạn chờ em xíu nha, em kiểm tra lại cho mình ạ",
      "Dạ để em xem lại thông tin chính xác rồi báo mình liền nha",
    ],
    saveUnknownQuestions: true,
    logDecisions: true,
    forceQaOnly: false,
    forceGptOnly: false,
  };
}

export function normalizeAiSettings(raw: unknown): AiSettings {
  const d = defaultAiSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const s = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(v);
    return isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
  };
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;
  const strArr = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string") : fallback;
  const numArr = (v: unknown, fallback: number[]): number[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "number" && !isNaN(x)) : fallback;
  const pronounStyles = ["em_ban", "minh_ban", "custom"] as const;
  const normalized: AiSettings = {
    minDelayMs: num(s.minDelayMs, d.minDelayMs, 0, 20000),
    maxDelayMs: num(s.maxDelayMs, d.maxDelayMs, 0, 20000),
    typingIndicator: bool(s.typingIndicator, d.typingIndicator),
    chunkMessages: bool(s.chunkMessages, d.chunkMessages),
    maxSentencesPerBubble: Math.max(1, num(s.maxSentencesPerBubble, d.maxSentencesPerBubble, 1, 10)),
    pronounStyle: pronounStyles.includes(s.pronounStyle as typeof pronounStyles[number])
      ? (s.pronounStyle as AiSettings["pronounStyle"])
      : d.pronounStyle,
    customPronounSelf: typeof s.customPronounSelf === "string" ? s.customPronounSelf : d.customPronounSelf,
    customPronounCustomer: typeof s.customPronounCustomer === "string" ? s.customPronounCustomer : d.customPronounCustomer,
    useEmoji: bool(s.useEmoji, d.useEmoji),
    bannedKeywords: strArr(s.bannedKeywords, d.bannedKeywords),
    autoPriceQuote: bool(s.autoPriceQuote, d.autoPriceQuote),
    maxDiscountPercent: num(s.maxDiscountPercent, d.maxDiscountPercent, 0, 100),
    priceImageSteps: numArr(s.priceImageSteps, d.priceImageSteps),
    autoSendPriceImage: bool(s.autoSendPriceImage, d.autoSendPriceImage),
    priceImageSendSteps: Array.isArray(s.priceImageSendSteps)
      ? [...new Set((s.priceImageSendSteps as unknown[]).map(Number).filter(n => !isNaN(n) && n > 0 && Number.isFinite(n)))].sort()
      : d.priceImageSendSteps,
    sendPriceTextAfterImage: bool(s.sendPriceTextAfterImage, d.sendPriceTextAfterImage),
    fallbackMessages: strArr(s.fallbackMessages, d.fallbackMessages),
    gptErrorMessages: strArr(s.gptErrorMessages, d.gptErrorMessages),
    saveUnknownQuestions: bool(s.saveUnknownQuestions, d.saveUnknownQuestions),
    logDecisions: bool(s.logDecisions, d.logDecisions),
    forceQaOnly: bool(s.forceQaOnly, d.forceQaOnly),
    forceGptOnly: bool(s.forceGptOnly, d.forceGptOnly),
  };
  // Ràng buộc: forceQaOnly và forceGptOnly không thể đồng thời = true
  if (normalized.forceQaOnly && normalized.forceGptOnly) normalized.forceGptOnly = false;
  // Ràng buộc: minDelayMs phải <= maxDelayMs
  if (normalized.minDelayMs > normalized.maxDelayMs) normalized.maxDelayMs = normalized.minDelayMs;
  return normalized;
}

export async function loadScriptSettings(scriptId: number | null): Promise<AiSettings> {
  const def = defaultAiSettings();
  if (!scriptId) return def;
  try {
    const res = await pool.query(
      `SELECT ai_settings FROM ai_service_scripts WHERE id = $1`,
      [scriptId],
    );
    if (res.rows.length === 0) return def;
    const raw = res.rows[0].ai_settings;
    return normalizeAiSettings({ ...def, ...(typeof raw === "object" && raw && !Array.isArray(raw) ? raw : {}) });
  } catch (err) {
    console.error("[AI] loadScriptSettings error:", err);
    return def;
  }
}

export type ConversationMessage = { role: "user" | "assistant"; content: string };
export type ConversationExample = ConversationMessage[];

export type SaleScript = {
  id: number;
  name: string;
  serviceGroup: string | null;
  priceContent: string | null;
  priceImages: string[] | null;
  aiRules: string | null;
  conversationExamples: ConversationExample[] | null;
  steps: Array<{
    step: number;
    stepLabel: string;
    content: string | null;
    variantsJson: string | null;
  }>;
};

export type AiSaleReply = {
  scriptId: number | null;
  serviceGroup: string | null;
  step: number | null;
  messages: string[];
  reason: string;
  isOutOfScope: boolean;
  shouldHandoff: boolean;
  usedFallback: boolean;
  sendPriceImages: boolean;
  sendPriceTextAfterImage: boolean;
  priceImages: string[];
};

export type QaMatchResult = {
  matched: boolean;
  rowId: number | null;
  answer: string | null;
  score: number;
  chunks: string[];
};

// ─── Utilities ──────────────────────────────────────────────────────────────

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Format a bubble for display: trim whitespace + remove trailing , and .
// (keeps ? and ! — those are natural in chat)
export function formatBubble(text: string): string {
  return text.trim().replace(/[,.]+$/, "");
}

// Strict-priority bubble splitter — each split unit = 1 bubble, no sentence grouping.
// Priority: \n → . → ? → ! → , (soft, >80 chars only)
function _splitSingleLine(text: string): string[] {
  // Priority 2: .
  const dotParts = _extractBySentenceEnder(text, ".");
  if (dotParts.length > 1) return dotParts.flatMap(_splitByCommaIfLong);
  // Priority 3: ?
  const qParts = _extractBySentenceEnder(text, "?");
  if (qParts.length > 1) return qParts.flatMap(_splitByCommaIfLong);
  // Priority 4: !
  const exParts = _extractBySentenceEnder(text, "!");
  if (exParts.length > 1) return exParts.flatMap(_splitByCommaIfLong);
  // Priority 5: , (soft)
  return _splitByCommaIfLong(text);
}

function _extractBySentenceEnder(text: string, ender: string): string[] {
  if (!text.includes(ender)) return [];
  const escaped = ender === "." ? "\\." : ender;
  const regex = new RegExp(`[^${escaped}]+[${escaped}]+`, "g");
  const parts: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const chunk = formatBubble(m[0]);
    if (chunk) parts.push(chunk);
    lastIndex = regex.lastIndex;
  }
  const remainder = formatBubble(text.slice(lastIndex));
  if (remainder) parts.push(remainder);
  return parts;
}

function _splitByCommaIfLong(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length > 80 && trimmed.includes(",")) {
    const parts = trimmed.split(",").map((s) => formatBubble(s)).filter(Boolean);
    if (parts.length > 1) return parts;
  }
  const single = formatBubble(trimmed);
  return single ? [single] : [];
}

/**
 * Detect whether a text line is a "pricing block" that should never be split.
 * Matches lines containing explicit Vietnamese price indicators or all-caps
 * package keywords. Normal chat text (e.g. "gói" in lowercase) is NOT matched.
 */
export function isPricingBlock(text: string): boolean {
  // Explicit đ currency marker after digits (e.g. "2.900.000đ" or "đ")
  if (/\dđ/.test(text)) return true;
  // Standalone đ as price unit (preceded by space or digit)
  if (/[\s\d]đ(\b|$)/.test(text)) return true;
  // VND currency marker
  if (/VND/.test(text)) return true;
  // A digit immediately followed by triệu/ngàn/nghìn (e.g. "5 triệu", "500ngàn")
  if (/\d\s*(triệu|ngàn|nghìn)/.test(text)) return true;
  // Number formatted with dot-thousands separator (e.g. 2.900.000 or 10.000.000)
  if (/\d+\.\d{3}/.test(text)) return true;
  // All-caps package keywords (pricing blocks use all-caps headers)
  if (/GÓI|BASIC|STANDARD|PREMIUM|LUXURY|BAO GỒM/.test(text)) return true;
  return false;
}

/**
 * Detect a pure number fragment — a bubble that is only digits (and optional
 * dot-thousands separators + trailing đ). These are produced when the AI
 * splits a formatted price like 2.900.000đ at its dot separators.
 * Match: "900", "000đ", "000 đ", "900.000đ" — No match: "Gói Basic", "triệu"
 */
function isPureNumberFragment(msg: string): boolean {
  return /^\s*[\d.]+\s*đ?\s*$/.test(msg) && msg.trim().length > 0 && /\d/.test(msg);
}

/**
 * Returns true when a bubble already contains a complete price indicator
 * (formatted number with currency or a "triệu/ngàn" unit).
 */
function hasCompletePrice(msg: string): boolean {
  return (
    /\d+[.,]\d{3}/.test(msg) ||
    /\dđ/.test(msg) ||
    /\d\s*(triệu|ngàn|nghìn)/i.test(msg) ||
    /\d+\s*VND/i.test(msg)
  );
}

/**
 * Re-join bubbles that the AI split at the dot-thousands separators of a
 * formatted Vietnamese price (e.g. 2.900.000đ), or at a currency marker.
 *
 * Handles three fragment patterns:
 *   Pattern A — dot-split number:
 *     ["GÓI BASIC: 2", "900", "000đ"] → "GÓI BASIC: 2.900.000đ"
 *   Pattern B — trailing currency marker only:
 *     ["GÓI BASIC: 2.900.000", "đ"] → "GÓI BASIC: 2.900.000đ"
 *   Pattern C — package-name fragment + price fragment:
 *     ["GÓI BASIC:", "2.900.000đ"] → "GÓI BASIC: 2.900.000đ"
 */
export function mergePricingFragments(messages: string[]): string[] {
  if (messages.length <= 1) return messages;
  const result: string[] = [];
  let i = 0;
  while (i < messages.length) {
    const current = messages[i].trimEnd();
    const next = i + 1 < messages.length ? messages[i + 1].trim() : null;

    // Pattern A: current ends with digit AND is pricing-related → next is a pure number/currency fragment
    // Require isPricingBlock(current) to avoid accidentally merging non-pricing numeric bubbles.
    if (next !== null && /\d$/.test(current) && isPricingBlock(current) && isPureNumberFragment(next)) {
      let merged = current;
      let j = i + 1;
      while (j < messages.length && isPureNumberFragment(messages[j].trim())) {
        merged = merged + "." + messages[j].trim();
        j++;
      }
      result.push(merged);
      i = j;
      continue;
    }

    // Pattern B: current ends with digit → next is a standalone "đ" or "VND"
    if (next !== null && /\d$/.test(current) && /^\s*(đ|VND)\s*$/i.test(next)) {
      result.push(current + next.trim());
      i += 2;
      continue;
    }

    // Pattern C: pricing keyword block without a complete price → merge with following price
    // Handles two sub-cases:
    //   C1 simple: ["GÓI BASIC:", "2.900.000đ"] → next has complete price
    //   C2 chained: ["GÓI BASIC:", "2", "900", "000đ"] → next is a number fragment chain
    if (next !== null && isPricingBlock(current) && !hasCompletePrice(current)) {
      const sep = current.endsWith(":") || current.endsWith(" ") ? " " : ": ";
      if (hasCompletePrice(next)) {
        // C1: next already has the full price
        result.push(current + sep + next);
        i += 2;
        continue;
      }
      if (isPureNumberFragment(next)) {
        // C2: next is a number fragment — accumulate all consecutive fragments with "."
        let price = "";
        let j = i + 1;
        while (j < messages.length && isPureNumberFragment(messages[j].trim())) {
          price = price ? price + "." + messages[j].trim() : messages[j].trim();
          j++;
        }
        result.push(current + sep + price);
        i = j;
        continue;
      }
    }

    result.push(current);
    i++;
  }
  return result;
}

export function splitIntoChunks(text: string, settings?: AiSettings): string[] {
  if (settings?.chunkMessages === false) {
    const b = formatBubble(text);
    return b ? [b] : [];
  }

  // Priority 1: \n — each non-empty line is recursively split
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length > 1) {
    const result: string[] = [];
    for (const line of lines) {
      // Pricing lines are kept as a single bubble — never split further
      if (isPricingBlock(line)) {
        const b = formatBubble(line);
        if (b) result.push(b);
      } else {
        result.push(..._splitSingleLine(line));
      }
    }
    return result.length > 0 ? result : (formatBubble(text) ? [formatBubble(text)] : []);
  }

  // Single line: protect pricing blocks from dot-splitting
  if (isPricingBlock(text)) {
    const b = formatBubble(text);
    return b ? [b] : [];
  }

  return _splitSingleLine(text);
}

export function buildFormatInstruction(): string {
  return `
QUY TẮC FORMAT TIN NHẮN (BẮT BUỘC):
- Viết ngắn, tự nhiên như người thật đang chat — KHÔNG viết văn bản hoàn chỉnh
- Mỗi ý là 1 bubble RIÊNG BIỆT trong mảng "messages[]" — KHÔNG gộp nhiều ý vào 1 phần tử
- Mỗi phần tử messages[] chỉ chứa 1 câu ngắn hoặc 1 ý nhỏ — tối đa 15 từ mỗi bubble
- Nếu cần nói nhiều ý, tách thành 2–3 phần tử messages[] riêng, KHÔNG nối bằng dấu phẩy hay dấu chấm trong cùng 1 bubble
- Tách bubble sau các từ mở đầu: dạ, vâng, à, ủa, hihi, hehe
- Câu chuyển ý bắt đầu bubble mới: tại vì, kiểu như, nếu mà, thật ra
- Chỉ chào "dạ em chào" tối đa 1 lần nếu CHƯA từng chào trong lịch sử — các tin sau KHÔNG chào lại
- Kết thúc bằng 1 câu hỏi ngắn (bubble riêng) liên quan trực tiếp đến nội dung vừa trả lời — câu hỏi phải tiến kịch bản (ví dụ: "Bạn muốn xem thêm ảnh mẫu không?" hoặc "Bạn dự tính chụp khoảng tháng mấy ạ?") — KHÔNG hỏi chung chung kiểu "Bạn muốn biết thêm gì không?" hay "Bạn cần em hỗ trợ gì không?"

PRICING RULE — BẮT BUỘC KHI BÁO GIÁ (KHÔNG ĐƯỢC VI PHẠM):
- Số tiền PHẢI viết dạng số có dấu chấm phân cách hàng nghìn + đ: ví dụ 2.900.000đ, 5.500.000đ
- TUYỆT ĐỐI KHÔNG viết giá bằng chữ (ví dụ: "hai triệu chín", "ba triệu rưỡi") — phải là chữ số
- TUYỆT ĐỐI KHÔNG viết giá liền không dấu chấm (ví dụ: "2900000đ") — phải có dấu chấm hàng nghìn
- Tên gói phải VIẾT HOA TOÀN BỘ: GÓI BASIC, GÓI STANDARD, GÓI PREMIUM, GÓI LUXURY
- Số tiền dạng 2.900.000đ là 1 số NGUYÊN — dấu chấm là dấu phân cách hàng nghìn, KHÔNG phải dấu kết thúc câu
- Tên gói + số tiền PHẢI nằm trong CÙNG 1 phần tử messages[] — KHÔNG tách thành nhiều phần tử riêng
- Ví dụ ĐÚNG: ["GÓI BASIC: 2.900.000đ", "GÓI PREMIUM: 3.900.000đ", "GÓI LUXURY: 5.900.000đ"]
- Ví dụ SAI (nghiêm cấm): ["GÓI BASIC: 2", "900", "000đ"] — lỗi này làm vỡ giao diện chat
- Ví dụ SAI (nghiêm cấm): ["gói basic: hai triệu chín"] — sai cả format số lẫn viết hoa tên gói
- Rule "tối đa 15 từ" KHÔNG áp dụng cho dòng báo giá — mỗi dòng báo giá = 1 bubble hoàn chỉnh

CẤM TUYỆT ĐỐI câu đệm vô nghĩa — KHÔNG ĐƯỢC xuất hiện trong bất kỳ bubble nào:
  "bạn hỏi thoải mái nha", "cứ hỏi nhé", "bạn cứ thoải mái", "mình cứ hỏi đi",
  "bạn có thể hỏi thêm", "hỏi thêm nha", "thoải mái hỏi", "cứ nhắn hỏi nhé",
  "bạn cứ hỏi", "em luôn sẵn sàng", "bạn muốn biết gì cứ hỏi"
Quy tắc: mỗi bubble phải cung cấp thông tin cụ thể HOẶC đặt câu hỏi có mục đích rõ ràng để tiến kịch bản — KHÔNG gửi câu đệm không có thông tin hữu ích`.trim();
}

export function naturalDelayMs(text: string, settings?: AiSettings): number {
  const min = settings?.minDelayMs ?? 800;
  const max = settings?.maxDelayMs ?? 2500;
  const charDelay = text.length * 20;
  const base = Math.min(max, min + charDelay);
  const headroom = max - base;
  const jitter = headroom > 0 ? Math.floor(Math.random() * headroom * 0.4) : 0;
  return base + jitter;
}

export function normalizeText(s: string): string {
  let n = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
  // Abbreviation substitutions
  n = n
    .replace(/\bko\b/g, "khong")
    .replace(/\bk\b/g, "khong")
    .replace(/\bdc\b/g, "duoc")
    .replace(/\ba\b/g, "")  // strip courtesy particle "a"
    .replace(/\s+/g, " ")
    .trim();
  return n;
}

// ─── QA Matching ────────────────────────────────────────────────────────────

type QaRowDb = { id: number; question: string; answer: string | null };

export async function loadQaRows(): Promise<QaRowDb[]> {
  const qaRes = await pool.query(
    `SELECT r.id, r.question, r.answer
     FROM ai_script_qa_rows r
     WHERE r.question IS NOT NULL AND r.question != ''
       AND (
         -- Shared rows: script_id IS NULL, only steps 1–3
         (r.script_id IS NULL AND r.step BETWEEN 1 AND 3)
         OR
         -- Script-specific rows: only steps 4–7 from active scripts
         (r.script_id IS NOT NULL AND r.step >= 4
          AND EXISTS (SELECT 1 FROM ai_service_scripts s WHERE s.id = r.script_id AND s.is_active = true))
       )
     ORDER BY r.script_id ASC NULLS FIRST, r.sort_order ASC`,
  );
  return qaRes.rows as QaRowDb[];
}

export function matchQaRow(message: string, qaRows: QaRowDb[]): { row: QaRowDb | null; score: number } {
  const THRESHOLD = 0.5;
  const normMsg = normalizeText(message);
  let bestRow: QaRowDb | null = null;
  let bestScore = 0;

  for (const row of qaRows) {
    if (!row.answer?.trim()) continue;
    const normQ = normalizeText(row.question);
    if (!normQ) continue;

    let score = 0;
    if (normMsg === normQ) {
      score = 1;
    } else if (normMsg.includes(normQ) || normQ.includes(normMsg)) {
      const shorter = Math.min(normMsg.length, normQ.length);
      const longer = Math.max(normMsg.length, normQ.length);
      score = shorter / longer;
    } else {
      const wordsQ = normQ.split(/\s+/).filter(Boolean);
      const wordsMsg = normMsg.split(/\s+/).filter(Boolean);
      const matchCount = wordsQ.filter((w) => wordsMsg.includes(w)).length;
      if (wordsQ.length > 0) score = matchCount / wordsQ.length;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }

  console.log(`[QA-Match] input="${normMsg}" bestScore=${bestScore.toFixed(2)} matched=${bestScore >= THRESHOLD}`);
  return bestScore >= THRESHOLD ? { row: bestRow, score: bestScore } : { row: null, score: bestScore };
}

// ─── Script Loading ──────────────────────────────────────────────────────────

export async function loadSaleScripts(): Promise<SaleScript[]> {
  try {
    const res = await pool.query(
      `SELECT s.id, s.name, s.service_group, s.price_content, s.price_images, s.ai_rules, s.conversation_examples,
              json_agg(st ORDER BY st.step) AS steps
       FROM ai_service_scripts s
       LEFT JOIN ai_script_steps st ON st.script_id = s.id
       WHERE s.is_active = true
       GROUP BY s.id
       ORDER BY s.id ASC`,
    );
    return (res.rows as Array<{
      id: number;
      name: string;
      service_group: string | null;
      price_content: string | null;
      price_images: string | null;
      ai_rules: string | null;
      conversation_examples: unknown;
      steps: Array<{ step: number; step_label: string; content: string | null; variants_json: string | null }> | null;
    }>).map((row) => {
      let parsedImages: string[] | null = null;
      try { parsedImages = row.price_images ? JSON.parse(row.price_images) : null; } catch { /* bỏ qua */ }
      let parsedExamples: ConversationExample[] | null = null;
      try {
        const raw = row.conversation_examples;
        if (Array.isArray(raw) && raw.length > 0) parsedExamples = raw as ConversationExample[];
      } catch { /* bỏ qua */ }
      return {
        id: row.id,
        name: row.name,
        serviceGroup: row.service_group ?? null,
        priceContent: row.price_content,
        priceImages: parsedImages,
        aiRules: row.ai_rules,
        conversationExamples: parsedExamples,
        steps: (row.steps ?? []).filter(Boolean).map((s) => ({
          step: s.step,
          stepLabel: s.step_label,
          content: s.content,
          variantsJson: s.variants_json,
        })),
      };
    });
  } catch (err) {
    console.error("[AI] loadSaleScripts error:", err);
    return [];
  }
}

// ─── Studio Context Builder ─────────────────────────────────────────────────

export async function buildStudioContext(scripts?: SaleScript[]): Promise<string> {
  const resolvedScripts = scripts ?? [];
  const lines: string[] = [];

  if (resolvedScripts.length > 0) {
    lines.push("=== KỊCH BẢN SALE AI THEO TỪNG DỊCH VỤ ===");
    for (const sc of resolvedScripts) {
      lines.push(`\n--- DỊCH VỤ #${sc.id}: ${sc.name} ---`);
      if (sc.priceContent) {
        lines.push("TEXT BÁO GIÁ (dùng cho bước 4 - Báo giá):");
        lines.push(sc.priceContent);
      }
      if (sc.priceImages && sc.priceImages.length > 0) {
        const domain = process.env.REPLIT_DEV_DOMAIN || "amazing-studio-manager.replit.app";
        lines.push(`ẢNH BÁO GIÁ (${sc.priceImages.length} ảnh, gửi kèm khi báo giá bước 4):`);
        sc.priceImages.forEach((path, i) => {
          const clean = path.replace(/^\/objects\//, "");
          lines.push(`  Ảnh ${i + 1}: https://${domain}/api/storage/objects/${clean}`);
        });
      }
      if (sc.aiRules) {
        lines.push("QUY ĐỊNH AI (bắt buộc tuân theo khi báo giá và tư vấn):");
        lines.push(sc.aiRules);
      }
      if (sc.conversationExamples && sc.conversationExamples.length > 0) {
        const validExamples = sc.conversationExamples.filter(
          (ex) => Array.isArray(ex) && ex.length >= 2 && ex.every((m) => m.content && m.content.trim()),
        );
        if (validExamples.length > 0) {
          lines.push("VÍ DỤ HỘI THOẠI MẪU (few-shot — học cách trả lời tự nhiên):");
          validExamples.forEach((ex, idx) => {
            lines.push(`--- Ví dụ ${idx + 1} ---`);
            for (const msg of ex) {
              const speaker = msg.role === "user" ? "Khách" : "Studio";
              lines.push(`${speaker}: ${msg.content.trim()}`);
            }
          });
        }
      }
      if (sc.steps.length > 0) {
        lines.push("KỊCH BẢN 7 BƯỚC:");
        lines.push("  [Bước 1–3: CHUNG — dùng để xác định nhóm dịch vụ, KHÔNG báo giá, KHÔNG gửi ảnh]");
        lines.push("  [Bước 4–7: RIÊNG theo nhóm dịch vụ — chỉ dùng sau khi đã xác định rõ nhóm]");
        for (const st of sc.steps) {
          const tag = st.step <= 3 ? "[CHUNG]" : "[RIÊNG-nhóm-DV]";
          lines.push(`  Bước ${st.step} ${tag} — ${st.stepLabel}:`);
          if (st.content) lines.push(`    Nội dung: ${st.content}`);
          if (st.variantsJson) {
            const variants = st.variantsJson.split("\n").filter((v) => v.trim());
            if (variants.length) lines.push(`    Biến thể: ${variants.join(" | ")}`);
          }
        }
      }
    }
    lines.push("\n=== HẾT KỊCH BẢN SALE ===\n");
  }

  try {
    const settingRows = await db.select().from(settingsTable).where(eq(settingsTable.key, "aiPricingInfo")).limit(1);
    const aiPricingInfo = settingRows[0]?.value?.trim();
    if (aiPricingInfo) {
      lines.push("=== THÔNG TIN BỔ SUNG TỪ ADMIN ===");
      lines.push(aiPricingInfo);
      lines.push("=== HẾT THÔNG TIN BỔ SUNG ===\n");
    }
  } catch { /* bỏ qua */ }

  try {
    const services = await pool.query(`
      SELECT name, code, price, description
      FROM services
      WHERE is_active = 1
      ORDER BY id ASC
      LIMIT 30
    `);
    const serviceLines = (services.rows as Array<{ name: string; code: string; price: string; description: string | null }>).map(
      (s) => `- ${s.name}${s.code ? ` (${s.code})` : ""}: ${Number(s.price || 0).toLocaleString("vi-VN")} đ${s.description ? ` — ${s.description}` : ""}`,
    );
    if (serviceLines.length) lines.push("Dịch vụ hệ thống:", ...serviceLines, "");
  } catch { /* bỏ qua */ }

  try {
    const now = new Date();
    const to = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const bookings = await pool.query(
      `SELECT b.shoot_date, b.shoot_time, b.package_type, b.status, c.name AS customer_name
       FROM bookings b
       LEFT JOIN customers c ON c.id = b.customer_id
       WHERE b.shoot_date BETWEEN $1 AND $2 AND b.status != 'cancelled'
       ORDER BY b.shoot_date, b.shoot_time LIMIT 10`,
      [now.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
    );
    const bookingLines = (bookings.rows as Array<{ shoot_date: string; shoot_time: string; package_type: string; status: string; customer_name: string }>).map(
      (b) => `- ${b.shoot_date} ${b.shoot_time ?? ""}: ${b.customer_name ?? "Khách"} [${b.status}]`,
    );
    lines.push("Lịch chụp 7 ngày tới:", ...(bookingLines.length ? bookingLines : ["- Chưa có lịch"]));
  } catch { /* bỏ qua */ }

  return lines.join("\n");
}

// ─── OpenAI Calls ───────────────────────────────────────────────────────────

export async function callOpenAI(apiKey: string, prompt: string): Promise<string> {
  const baseUrl = (process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "Bạn là AI của studio ảnh cưới. Trả về JSON hợp lệ, không thêm markdown." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`OpenAI error ${r.status}: ${err}`);
  }
  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "{}";
}

function buildToneInstruction(settings?: AiSettings): string {
  if (!settings) return "";
  const lines: string[] = [];
  // Pronoun
  if (settings.pronounStyle === "em_ban") lines.push("- Xưng hô: AI tự xưng là 'em', gọi khách là 'bạn'.");
  else if (settings.pronounStyle === "minh_ban") lines.push("- Xưng hô: AI tự xưng là 'mình', gọi khách là 'bạn'.");
  else if (settings.pronounStyle === "custom") {
    const self = settings.customPronounSelf || "em";
    const cust = settings.customPronounCustomer || "bạn";
    lines.push(`- Xưng hô: AI tự xưng là '${self}', gọi khách là '${cust}'.`);
  }
  // Emoji
  if (settings.useEmoji) lines.push("- Có thể dùng emoji phù hợp để tin nhắn thân thiện hơn.");
  else lines.push("- KHÔNG dùng emoji.");
  // Banned keywords
  if (settings.bannedKeywords.length > 0) {
    lines.push(`- TUYỆT ĐỐI không nhắc đến các từ: ${settings.bannedKeywords.map(k => `'${k}'`).join(", ")}.`);
  }
  return lines.length > 0 ? `\nQUY TẮC GIỌNG ĐIỆU:\n${lines.join("\n")}` : "";
}

export function buildSaleInstruction(settings?: AiSettings): string {
  if (!settings) return "";
  const lines: string[] = [];
  // B1-B3 hard guardrail (always applies regardless of autoPriceQuote)
  lines.push("- GUARDRAIL B1–B3: TUYỆT ĐỐI không báo giá, không nêu tên gói (Basic/Premium/Luxury), không gửi ảnh bảng giá ở bước 1, 2, 3 — dù khách hỏi trực tiếp. Ở B1–B3 chỉ được hỏi để xác định nhóm dịch vụ.");
  if (settings.autoPriceQuote) {
    lines.push("- Bước 4 (báo giá): TỰ ĐỘNG gợi ý bảng giá khi khách đã hỏi đến gói dịch vụ — gửi ảnh mẫu chung của nhóm trước, sau đó mới gửi text bảng giá.");
  } else {
    lines.push("- KHÔNG tự động báo giá trừ khi khách hỏi rõ ràng và đã đến bước 4.");
  }
  if (settings.maxDiscountPercent > 0) {
    lines.push(`- Mức giảm giá TỐI ĐA được phép: ${settings.maxDiscountPercent}%. KHÔNG đề xuất hoặc đồng ý giảm quá mức này.`);
    lines.push(`- THỜI ĐIỂM GIẢM GIÁ: chỉ được đề xuất ở bước 7, CHỈ khi khách đã xác nhận muốn đặt nhưng còn phân vân về giá. TUYỆT ĐỐI không chủ động giảm giá ở bước 1–6 dù khách có hỏi.`);
  }
  if (settings.priceImageSteps?.length > 0) {
    lines.push(`- Ảnh mẫu và bảng giá: chỉ gửi ở bước ${settings.priceImageSteps.join(", ")} — KHÔNG gửi trước bước 4, KHÔNG lặp lại ở bước 5–7.`);
  } else {
    lines.push("- Ảnh mẫu và bảng giá: chỉ gửi ở bước 4 — KHÔNG gửi trước bước 4, KHÔNG lặp lại ở bước 5–7.");
  }
  lines.push("- FORMAT GIÁ BẮT BUỘC: số tiền dùng dấu chấm hàng nghìn + đ (ví dụ: 2.900.000đ). KHÔNG viết bằng chữ, KHÔNG viết liền không dấu chấm.");
  lines.push("- TÊN GÓI BẮT BUỘC VIẾT HOA: GÓI BASIC, GÓI STANDARD, GÓI PREMIUM, GÓI LUXURY (không được viết thường).");
  return lines.length > 0 ? `\nQUY TẮC SALE:\n${lines.join("\n")}` : "";
}

function applyBannedKeywords(messages: string[], settings?: AiSettings): string[] {
  if (!settings?.bannedKeywords?.length) return messages;
  return messages.map(msg => {
    let out = msg;
    for (const kw of settings.bannedKeywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(escaped, "gi"), "***");
    }
    return out;
  });
}

// ─── Conversation Memory Extractor ──────────────────────────────────────────
// Trích xuất thông tin khách đã cung cấp trong hội thoại để AI KHÔNG hỏi lại.
// Studio mặc định ở Tây Ninh — nếu khách nói "tây ninh / ở đây / gần studio /
// nội thành / trong tỉnh" thì lock location = "tay_ninh", AI không được hỏi
// "TP hay đi tỉnh" nữa. Chỉ hỏi đi tỉnh khi khách chủ động nói "Đà Lạt /
// Hội An / TP.HCM / Sài Gòn / ngoại tỉnh / đi tỉnh khác / chụp xa".
export type CustomerMemory = {
  outgoingCount: number;
  greetingSent: boolean;
  locationKnown: "tay_ninh" | "tinh_khac" | null;
  serviceMentioned: string[];
  shootDateMentioned: boolean;
  budgetMentioned: boolean;
  askedPrice: boolean;
  // Mở rộng spec booking-centric:
  budgetTier: "tiet_kiem" | "vua_du" | "chin_chu" | null;
  wantsOutdoor: boolean;            // chỉ true khi khách CHỦ ĐỘNG nói ngoại cảnh / đi tỉnh
  priceQuoted: boolean;              // Studio đã từng báo giá trong lịch sử chưa
  packagesQuoted: string[];          // tên gói đã đề cập (basic, normal, gold, luxury, diamond)
  objectionRaised: boolean;          // khách đã có phản ứng "mắc/đắt/suy nghĩ" chưa
};

const STRIP_DIACRITICS = (s: string) => s
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d");

function detectLocation(textNoDiacritics: string): "tay_ninh" | "tinh_khac" | null {
  const offProvince = [
    "da lat", "dalat", "hoi an", "tp hcm", "tp.hcm", "tphcm", "sai gon", "saigon",
    "ha noi", "hanoi", "nha trang", "vung tau", "phu quoc", "ngoai tinh",
    "di tinh khac", "chup xa", "tinh khac",
  ];
  for (const k of offProvince) if (textNoDiacritics.includes(k)) return "tinh_khac";
  const local = [
    "tay ninh", "o day", "gan studio", "noi thanh", "trong tinh", "trong thanh pho",
    "o tinh nay", "tai tay ninh", "minh o tn", "o tn",
  ];
  for (const k of local) if (textNoDiacritics.includes(k)) return "tay_ninh";
  return null;
}

function detectService(textNoDiacritics: string): string[] {
  const map: Record<string, string[]> = {
    "cuoi":     ["chup cuoi", "anh cuoi", "ngay cuoi", "tiec cuoi", "cuoi hoi", "an hoi"],
    "tiec":     ["chup tiec", "tiec sinh nhat", "su kien", "tat nien", "tan gia"],
    "cong":     ["chup cong", "cong cuoi"],
    "beauty":   ["beauty", "ky niem", "chup ca nhan", "chup co", "chup nghe thuat"],
    "sinh_nhat":["sinh nhat", "thoi noi", "day thang"],
    "ky_yeu":   ["ky yeu", "ky niem lop", "tot nghiep"],
    "gia_dinh": ["gia dinh", "ca nha", "pho gia dinh"],
    "thai_san": ["thai san", "bau bi", "bau"],
    "tre_em":   ["tre em", "be", "em be"],
  };
  const found: string[] = [];
  for (const [grp, kws] of Object.entries(map)) {
    if (kws.some((k) => textNoDiacritics.includes(k))) found.push(grp);
  }
  return found;
}

function detectShootDate(textNoDiacritics: string): boolean {
  if (/\b(thang|cuoi thang|dau thang|giua thang|tuan sau|tuan toi|cuoi tuan|chu nhat|hom nay|mai|mot|thu \d|ngay \d{1,2})\b/.test(textNoDiacritics)) return true;
  if (/\d{1,2}[\/\-]\d{1,2}/.test(textNoDiacritics)) return true;
  return false;
}

function detectBudget(textNoDiacritics: string): boolean {
  return /\b(ngan sach|chi phi tam|khoang \d|trieu|tr|toi da|toi thieu|trong khoang)\b/.test(textNoDiacritics);
}

function detectAskedPrice(textNoDiacritics: string): boolean {
  return /\b(bao gia|gia bao nhieu|gia goi|goi nao|chi phi|bao nhieu tien|gia the nao|tham khao gia|cho gia)\b/.test(textNoDiacritics);
}

// Khách CHỦ ĐỘNG muốn ngoại cảnh / đi xa — KHÁC với "đã rõ ở Tây Ninh"
// và KHÁC với "khách ở tỉnh khác nhưng đến Tây Ninh chụp".
// Nếu false: AI tuyệt đối không tự gợi ý Đà Lạt / Hội An / Sài Gòn / ngoại tỉnh.
//
// Logic:
//  - Cụm "ngoại cảnh / ngoại trời / chụp ngoài / đi tỉnh / chụp xa" → true (intent rõ ràng)
//  - Tên địa điểm (Đà Lạt, Hội An, Sài Gòn...) → CHỈ true khi có verb intent
//    (muốn / thích / định / đi / chụp / qua / lên / ra / vô / về / tới / đến / sang)
//    đi kèm. Tránh false-positive với "mình ở TP HCM" (residence, không phải shoot location).
function detectWantsOutdoor(textNoDiacritics: string): boolean {
  // Intent rõ ràng — chấp nhận luôn
  if (/\b(ngoai canh|ngoai troi|chup ngoai|di tinh khac|chup xa)\b/.test(textNoDiacritics)) return true;

  // Tên địa điểm — yêu cầu có intent verb đi kèm trong cùng câu
  const locationRe = /(da lat|dalat|hoi an|sai gon|saigon|tp hcm|tp\.hcm|tphcm|nha trang|vung tau|phu quoc|ha noi|hanoi)/;
  if (!locationRe.test(textNoDiacritics)) return false;

  const intentVerbs = /(mu[ou]n|thich|dinh|can|di|chup|qua|len|ra|vo|ve|toi|den|sang|du dinh|len ke hoach)/;
  // Tách câu (theo dấu câu) và check từng câu chứa cả intent + location
  const sentences = textNoDiacritics.split(/[.!?\n]+/);
  for (const s of sentences) {
    if (locationRe.test(s) && intentVerbs.test(s)) return true;
  }

  // Fallback: nếu khách chỉ nhắc "ở TP HCM / ở Hà Nội" thì coi là residence, KHÔNG phải intent
  // → trả false
  return false;
}

// Phân tầng ngân sách / nhu cầu chất lượng dựa vào ngôn ngữ khách
function detectBudgetTier(textNoDiacritics: string): "tiet_kiem" | "vua_du" | "chin_chu" | null {
  if (/\b(re|tiet kiem|gia re|sinh vien|it tien|khong nhieu tien|don gian|co ban|basic|gon nhe|toi gian)\b/.test(textNoDiacritics)) return "tiet_kiem";
  if (/\b(chin chu|cao cap|sang trong|day du|full|luxury|diamond|premium|xin|sang|chuyen nghiep|dep that|that dep|dau tu)\b/.test(textNoDiacritics)) return "chin_chu";
  if (/\b(vua du|trung binh|tam tam|on on|du dung|don gian dep|basic ma dep)\b/.test(textNoDiacritics)) return "vua_du";
  return null;
}

// Khách phản đối / chần chừ → đặt cờ objection để AI vào BƯỚC 8 (xử lý từ chối, không tự giảm giá)
function detectObjection(textNoDiacritics: string): boolean {
  return /\b(mac qua|mac wa|dat qua|dat wa|cao qua|cao wa|hoi cao|hoi mac|suy nghi|de tinh|de coi|chua co tien|khong du tien|de hoi|de ban|hoi cho khac|tham khao them|cho khac re hon|sao mac vay|sao cao vay)\b/.test(textNoDiacritics);
}

// Studio đã báo giá chưa → scan outgoing có chứa giá (đ, triệu, gói)
function detectPriceQuotedInOutgoing(outgoingTextsNorm: string[]): boolean {
  return outgoingTextsNorm.some((t) => /\d[\d.,]*\s*(d|đ|vnd|trieu|tr\b|ngan)\b|\bgoi\s+(basic|normal|gold|luxury|diamond|premium)/i.test(t));
}

// Tên gói AI đã đề cập trong outgoing
function detectPackagesQuoted(outgoingTextsNorm: string[]): string[] {
  const names = ["basic", "normal", "gold", "silver", "platinum", "luxury", "diamond", "premium", "vip"];
  const found = new Set<string>();
  for (const t of outgoingTextsNorm) {
    for (const n of names) {
      if (new RegExp(`\\bgoi\\s+${n}\\b|\\b${n}\\b`).test(t)) found.add(n);
    }
  }
  return Array.from(found);
}

export function extractCustomerMemory(
  history: Array<{ direction: "incoming" | "outgoing"; message: string }>,
  currentMessage: string,
): CustomerMemory {
  const outgoing = history.filter((m) => m.direction === "outgoing");
  const outgoingTextsNorm = outgoing.map((m) => STRIP_DIACRITICS(m.message));
  const incomingTexts = history.filter((m) => m.direction === "incoming").map((m) => m.message).concat(currentMessage);
  const allIncomingNorm = STRIP_DIACRITICS(incomingTexts.join(" \n "));

  // Greeting đã gửi nếu bất kỳ tin outgoing nào chứa "chao"
  const greetingSent = outgoing.some((m) => /chao|xin chao|hi |hello/i.test(STRIP_DIACRITICS(m.message)));

  let locationKnown: "tay_ninh" | "tinh_khac" | null = null;
  for (const t of incomingTexts) {
    const det = detectLocation(STRIP_DIACRITICS(t));
    if (det === "tinh_khac") { locationKnown = "tinh_khac"; break; }
    if (det === "tay_ninh") locationKnown = "tay_ninh";
  }

  // Quét toàn bộ tin khách (kể cả lịch sử) cho budget tier — ưu tiên tier mới nhất
  let budgetTier: "tiet_kiem" | "vua_du" | "chin_chu" | null = null;
  for (const t of incomingTexts) {
    const det = detectBudgetTier(STRIP_DIACRITICS(t));
    if (det) budgetTier = det; // overwrite — last mention wins
  }

  return {
    outgoingCount: outgoing.length,
    greetingSent,
    locationKnown,
    serviceMentioned: detectService(allIncomingNorm),
    shootDateMentioned: detectShootDate(allIncomingNorm),
    budgetMentioned: detectBudget(allIncomingNorm),
    askedPrice: detectAskedPrice(allIncomingNorm),
    budgetTier,
    wantsOutdoor: detectWantsOutdoor(allIncomingNorm),
    priceQuoted: detectPriceQuotedInOutgoing(outgoingTextsNorm),
    packagesQuoted: detectPackagesQuoted(outgoingTextsNorm),
    objectionRaised: detectObjection(allIncomingNorm),
  };
}

function buildMemorySection(mem: CustomerMemory): string {
  const lines: string[] = ["=== ĐÃ BIẾT VỀ KHÁCH (TUYỆT ĐỐI KHÔNG HỎI LẠI NHỮNG Ý NÀY) ==="];
  lines.push(`- Số tin Studio đã gửi: ${mem.outgoingCount} ${mem.outgoingCount > 0 ? "→ KHÔNG được chào lại, KHÔNG dùng 'dạ em chào', 'xin chào', 'hi'" : "→ được chào lần đầu"}`);
  if (mem.locationKnown === "tay_ninh") {
    lines.push("- Khu vực: Khách Ở TÂY NINH (gần studio). KHÔNG được hỏi 'trong TP hay đi tỉnh', 'chụp ở đâu', 'TP hay tỉnh khác'. Mặc định tư vấn theo Tây Ninh.");
  } else if (mem.locationKnown === "tinh_khac") {
    lines.push("- Khu vực: Khách muốn chụp NGOẠI TỈNH. Có thể hỏi rõ tỉnh nào nếu chưa biết.");
  } else {
    lines.push("- Khu vực: Chưa rõ. MẶC ĐỊNH coi như Tây Ninh (studio ở Tây Ninh). KHÔNG hỏi 'TP hay tỉnh' nếu khách không tự đề cập đi xa.");
  }
  if (mem.serviceMentioned.length > 0) {
    lines.push(`- Dịch vụ khách quan tâm: ${mem.serviceMentioned.join(", ")} → đã rõ nhóm dịch vụ, KHÔNG hỏi lại 'bạn quan tâm dịch vụ gì'.`);
  } else {
    lines.push("- Dịch vụ: chưa rõ → có thể hỏi 1 câu duy nhất để xác định nhóm.");
  }
  if (mem.shootDateMentioned) lines.push("- Ngày chụp: khách đã đề cập → KHÔNG hỏi lại 'dự kiến chụp ngày nào'.");
  if (mem.budgetMentioned) lines.push("- Ngân sách: khách đã đề cập → KHÔNG hỏi lại.");
  if (mem.askedPrice) {
    lines.push("- Khách ĐÃ HỎI GIÁ → ƯU TIÊN BÁO GIÁ NHANH. Tối đa 1 câu hỏi quan trọng nhất nếu thiếu thông tin (ưu tiên hỏi nhóm dịch vụ nếu chưa rõ). KHÔNG hỏi 3 câu liên tiếp.");
  }
  if (mem.budgetTier) {
    const tierLabel = mem.budgetTier === "tiet_kiem" ? "TIẾT KIỆM (gợi ý gói Basic)" : mem.budgetTier === "chin_chu" ? "CHỈN CHU/CAO CẤP (gợi ý Luxury/Diamond)" : "VỪA ĐỦ (gợi ý Normal/Gold)";
    lines.push(`- Mức ngân sách: ${tierLabel} → KHÔNG hỏi lại "muốn tiết kiệm hay chỉn chu".`);
  }
  if (mem.wantsOutdoor) {
    lines.push("- Khách CHỦ ĐỘNG muốn ngoại cảnh / đi tỉnh → được tư vấn ngoại cảnh thoải mái.");
  } else {
    lines.push("- Khách CHƯA yêu cầu ngoại cảnh/đi tỉnh → TUYỆT ĐỐI KHÔNG tự gợi ý Đà Lạt, Hội An, Sài Gòn, Nha Trang, ngoại tỉnh. Mặc định tư vấn CHỤP TẠI STUDIO TÂY NINH (tiện, tiết kiệm, kiểm soát ánh sáng/váy/makeup tốt).");
  }
  if (mem.priceQuoted) {
    lines.push(`- Studio ĐÃ TỪNG báo giá trong lịch sử (${mem.packagesQuoted.length > 0 ? `gói đã đề cập: ${mem.packagesQuoted.join(", ")}` : "đã có giá trong outgoing"}) → KHÔNG báo lại bảng giá nguyên xi. Thay vào đó: tư vấn chọn gói, hỏi chốt lịch, hoặc xử lý từ chối.`);
  }
  if (mem.objectionRaised) {
    lines.push("- Khách CÓ DẤU HIỆU CHẦN CHỪ / PHẢN ĐỐI GIÁ (mắc/suy nghĩ/để hỏi). Vào BƯỚC 8 — XỬ LÝ TỪ CHỐI: KHÔNG tự giảm giá, KHÔNG tự tặng quà, giải thích GIÁ TRỊ gói + có thể gợi ý gói thấp hơn phù hợp + mời giữ lịch nếu đã chốt ngày.");
  }
  lines.push("=== HẾT MEMORY ===\n");
  return lines.join("\n");
}

// Loại bỏ bubble lời chào nếu đã có hội thoại, loại câu hỏi đã biết.
function postProcessMessages(messages: string[], mem: CustomerMemory): string[] {
  let out = messages.slice();

  // 1. Strip greeting nếu đã có outgoing
  if (mem.outgoingCount > 0 || mem.greetingSent) {
    const greetingRe = /^(d[ạa]\s*(em\s+)?ch[àa]o|xin\s+ch[àa]o|ch[àa]o\s+b[ạa]n|hi+\b|hello)/i;
    out = out.filter((m) => !greetingRe.test(m.trim()));
  }

  // 2. Strip câu hỏi "TP hay đi tỉnh" nếu đã biết khách ở Tây Ninh
  if (mem.locationKnown === "tay_ninh" || mem.locationKnown === null) {
    const offProvinceQuestion = /(trong\s+(tp|th[àa]nh\s+ph[ốo])\s+hay\s+(đi\s+)?t[ỉi]nh)|(t[ỉi]nh\s+hay\s+(tp|th[àa]nh\s+ph[ốo]))|(ch[ụu]p\s+(ở\s+)?(đ[âa]u|t[ỉi]nh\s+n[àa]o))|(đi\s+t[ỉi]nh\s+kh[áa]c)/i;
    out = out.filter((m) => !offProvinceQuestion.test(m));
  }

  // 3. Strip câu hỏi "dịch vụ gì" nếu đã rõ nhóm dịch vụ
  if (mem.serviceMentioned.length > 0) {
    const serviceQuestion = /(quan\s+t[âa]m\s+(đ[ếe]n\s+)?d[ịi]ch\s+v[ụu])|(d[ịi]ch\s+v[ụu]\s+(g[ìi]|n[àa]o))|(ch[ụu]p\s+lo[ạa]i\s+g[ìi])/i;
    out = out.filter((m) => !serviceQuestion.test(m));
  }

  // 4. Strip câu hỏi ngày nếu đã có
  if (mem.shootDateMentioned) {
    const dateQuestion = /(d[ựu]\s+(ki[ếe]n|t[íi]nh)\s+ch[ụu]p\s+(v[àa]o\s+)?ng[àa]y\s+n[àa]o)|(ch[ụu]p\s+ng[àa]y\s+n[àa]o)|(d[ựu]\s+ki[ếe]n\s+v[àa]o\s+kho[ảa]ng)|(ng[àa]y\s+n[àa]o\s+(b[ạa]n\s+)?d[ựu]\s+ki[ếe]n)/i;
    out = out.filter((m) => !dateQuestion.test(m));
  }

  // 5. Strip gợi ý tự đẩy đi tỉnh khi khách KHÔNG yêu cầu — bảo vệ studio-first bias
  if (!mem.wantsOutdoor) {
    const offProvinceSuggest = /(đ[àa]\s*l[ạa]t|h[ộo]i\s*an|s[àa]i\s*g[òo]n|nha\s+trang|v[ũu]ng\s+t[àa]u|ph[úu]\s*qu[ốo]c|h[àa]\s*n[ộo]i|tp\.?\s*hcm|tphcm|chụp\s+ngo[ạa]i\s+t[ỉi]nh|đi\s+t[ỉi]nh\s+kh[áa]c)/i;
    out = out.filter((m) => !offProvinceSuggest.test(m));
  }

  // 6. Strip câu hỏi "album bao nhiêu trang" / "hình cổng" khi dịch vụ là CHỤP TIỆC (không có album)
  if (mem.serviceMentioned.includes("tiec") && !mem.serviceMentioned.includes("cuoi")) {
    const albumQuestion = /(album\s+(bao\s+nhi[êe]u|m[ấa]y)\s+trang)|(c[ầa]n\s+album)|(h[ìi]nh\s+c[ổo]ng)|(c[ổo]ng\s+mica)/i;
    out = out.filter((m) => !albumQuestion.test(m));
  }

  // 7. Strip câu hỏi mức ngân sách nếu đã rõ tier
  if (mem.budgetTier) {
    const tierQuestion = /(mu[ốo]n\s+(ti[ếe]t\s+ki[ệe]m|chi(?:n|ng)\s+chu|cao\s+c[ấa]p))|(ng[âa]n\s+s[áa]ch\s+kho[ảa]ng)|(ti[ếe]t\s+ki[ệe]m\s+hay\s+(đ[ầa]y\s+đ[ủu]|chi(?:n|ng)\s+chu))/i;
    out = out.filter((m) => !tierQuestion.test(m));
  }

  // 8. Cap số bubble: nếu khách hỏi giá → tối đa 3, ngược lại tối đa 4 (theo spec: 2-3 bubbles/lượt là chuẩn)
  const maxBubbles = mem.askedPrice ? 3 : 4;
  if (out.length > maxBubbles) out = out.slice(0, maxBubbles);

  // 9. Cleanup: trim, bỏ rỗng
  out = out.map((m) => m.trim()).filter(Boolean);
  return out;
}

export async function askChatGptForReply(input: {
  apiKey: string;
  customerMessage: string;
  customerName: string;
  history: Array<{ direction: "incoming" | "outgoing"; message: string }>;
  currentScriptId: number | null;
  currentSaleStep: number | null;
  settings?: AiSettings;
}): Promise<AiSaleReply> {
  const scripts = await loadSaleScripts();

  if (scripts.length === 0) {
    return askChatGptFallback(input);
  }

  const context = await buildStudioContext(scripts);
  const historyText = input.history
    .slice(-10)
    .map((m) => `${m.direction === "incoming" ? "Khách" : "Studio"}: ${m.message}`)
    .join("\n");

  const memory = extractCustomerMemory(input.history, input.customerMessage);
  const memorySection = buildMemorySection(memory);

  // Studio-first bias chỉ áp dụng KHI khách CHƯA tự yêu cầu ngoại cảnh.
  // Nếu khách đã chủ động muốn Đà Lạt/Hội An/ngoại cảnh → bỏ rule này, để AI tư vấn đúng yêu cầu.
  const studioFirstRule = memory.wantsOutdoor
    ? "- KHÁCH ĐÃ CHỦ ĐỘNG yêu cầu NGOẠI CẢNH (có nói tên địa điểm cụ thể như Đà Lạt, Hội An, ngoại cảnh, v.v.) → TƯ VẤN TRỰC TIẾP địa điểm khách yêu cầu, NHẮC LẠI tên địa điểm đó trong tin nhắn. KHÔNG né tránh sang Tây Ninh, KHÔNG đề nghị thay thế bằng studio."
    : "- STUDIO-FIRST BIAS: Studio Amazing đặt tại Tây Ninh, ƯU TIÊN dẫn khách chụp TẠI STUDIO vì tiện cho khách + tiết kiệm + ekip kiểm soát ánh sáng/váy/makeup/bối cảnh tốt + tối ưu lịch. CHỈ tư vấn ngoại cảnh / đi tỉnh KHI khách CHỦ ĐỘNG yêu cầu. TUYỆT ĐỐI không tự đẩy khách đi Đà Lạt, Hội An, Sài Gòn, Nha Trang.";

  const scriptList = scripts.map((s) => `#${s.id}: ${s.name}`).join(", ");
  const toneInstruction = buildToneInstruction(input.settings);
  const saleInstruction = buildSaleInstruction(input.settings);
  const formatInstruction = buildFormatInstruction();

  const prompt = `
Bạn là NHÂN VIÊN SALE của Amazing Studio — studio ảnh cưới & cho thuê váy ĐẶT TẠI TÂY NINH. Tên khách: ${input.customerName}.
Trạng thái hiện tại: scriptId=${input.currentScriptId ?? "chưa chọn"}, bước=${input.currentSaleStep ?? "chưa bắt đầu"}.
${toneInstruction}${saleInstruction}

${formatInstruction}

${memorySection}
LUẬT VÀNG (vi phạm = sai):
- KHÔNG hỏi lại bất kỳ thông tin nào đã có trong "ĐÃ BIẾT VỀ KHÁCH" ở trên.
${studioFirstRule}
- KHU VỰC MẶC ĐỊNH = TÂY NINH. Chỉ hỏi "đi tỉnh / ngoại cảnh tỉnh khác" KHI VÀ CHỈ KHI khách tự nói tên tỉnh khác.
- KHÔNG chào lại nếu Studio đã gửi ≥ 1 tin trong lịch sử.
- KHÔNG hỏi "album mấy trang / hình cổng mica" nếu nhóm là CHỤP TIỆC (tiệc không có album).
- Khi khách nói "báo giá", "giá bao nhiêu", "gói nào", "cho xin giá" → ƯU TIÊN BÁO GIÁ NGAY. Nếu thiếu thông tin tối quan trọng (chưa biết nhóm dịch vụ) → CHỈ ĐƯỢC HỎI 1 CÂU NGẮN NHẤT: "Dạ mình cần báo giá chụp cưới studio, chụp tiệc hay combo ngày cưới ạ?" rồi báo giá. TUYỆT ĐỐI không hỏi 2-3 câu liên tiếp trước khi báo giá.
- Nếu nhóm dịch vụ đã rõ + khách hỏi giá → bỏ qua bước hỏi, vào BƯỚC 4 báo giá luôn dựa trên priceContent của script đó.
- Bubble cuối cùng (nếu có câu hỏi) phải là 1 câu mới, KHÔNG lặp câu đã hỏi trong lịch sử.

LUẬT CỨNG VỀ GIÁ & QUYỀN LỢI (vi phạm = NGUY HIỂM):
- Giá, quyền lợi, ưu đãi, quà tặng, số lượng váy/vest/album/hình cổng/makeup CHỈ ĐƯỢC LẤY từ priceContent + priceImages của script trong database.
- TUYỆT ĐỐI KHÔNG tự bịa giá, KHÔNG tự giảm giá, KHÔNG tự thêm quà tặng, KHÔNG nói sai số lượng sản phẩm.
- Nếu chưa có priceContent phù hợp → hỏi thêm để xác định nhóm, KHÔNG tự sáng tạo bảng giá.

LUẬT XỬ LÝ TỪ CHỐI (BƯỚC 8):
- Khi khách nói "mắc quá", "đắt", "suy nghĩ thêm", "để hỏi chỗ khác", "chưa có tiền":
  + KHÔNG giảm giá bừa, KHÔNG tự tặng thêm.
  + Giải thích GIÁ TRỊ gói (album dày, số hình cổng, số váy, makeup chuyên nghiệp...).
  + Có thể gợi ý gói THẤP HƠN phù hợp hơn nếu có.
  + Mời giữ lịch bằng cọc nếu đã chốt ngày ("ngày đẹp dễ kín lịch, mình giữ lịch sớm nha").

Danh sách kịch bản dịch vụ: ${scriptList}

${context}

Lịch sử hội thoại gần đây:
${historyText || "(chưa có lịch sử)"}

Tin nhắn mới từ khách:
"${input.customerMessage}"

BƯỚC 0 — PHÁT HIỆN Ý ĐỊNH (làm trước mọi thứ):
Phân loại tin nhắn khách vào 1 trong các intent:
  - "greeting" → khách chào hỏi chung, không kèm câu hỏi cụ thể
  - "asking_price" → khách hỏi giá / gói / chi phí cụ thể
  - "asking_service" → khách hỏi về dịch vụ nào đó (chụp cổng, chụp kỷ yếu, thuê váy…)
  - "asking_time" → khách hỏi về lịch / thời điểm / địa điểm
  - "objection" → khách phản đối giá hoặc điều khoản
  - "ready_to_close" → khách có dấu hiệu muốn đặt lịch / đặt cọc

QUY TẮC ƯU TIÊN TUYỆT ĐỐI:
- Nếu intent = "asking_price" / "asking_service" / "asking_time" → messages[0] PHẢI là câu trả lời TRỰC TIẾP cho câu hỏi đó
  KHÔNG được: chào lại, hỏi ngược không liên quan, nói "bạn hỏi gì em nghe nha"
  VÍ DỤ ĐÚNG: Khách hỏi "chụp ảnh cổng có gói nào không?" → messages[0] = "Dạ bên em có gói chụp cổng riêng ạ"
  VÍ DỤ SAI: messages[0] = "Dạ em chào bạn" hoặc "Bạn muốn biết thêm gì không?"

GREETING GATE — kiểm tra lịch sử trước khi chào:
- Lịch sử outgoing = số tin nhắn direction="Studio" (outgoing) trong lịch sử hội thoại trên
- Nếu outgoing ≥ 1 → step phải ≥ 2, TUYỆT ĐỐI không xuất hiện "dạ em chào", "em chào bạn", hay bất kỳ lời chào mở đầu nào trong messages
- Chỉ được chào (bước 1) khi lịch sử HOÀN TOÀN TRỐNG (0 tin outgoing)

STEP FLOOR — không lùi bước:
- step phải ≥ ${input.currentSaleStep ?? 1} (bước hiện tại)
- Ngoại lệ DUY NHẤT: khách hỏi về dịch vụ hoàn toàn khác → được đổi scriptId và reset step về 2 (không về 1 nếu đã từng chào)

NHIỆM VỤ (làm theo thứ tự):
1. CHỌN SCRIPT: Phân tích nội dung khách → xác định dịch vụ phù hợp → chọn scriptId.
   - Nếu đã có scriptId (${input.currentScriptId ?? "chưa"}) và khách chưa hỏi về dịch vụ khác → giữ nguyên scriptId đó.
   - Nếu chưa rõ dịch vụ → đặt scriptId = null, hỏi thêm để xác định.

2. XÁC ĐỊNH BƯỚC: Dựa vào lịch sử hội thoại + bước hiện tại (${input.currentSaleStep ?? "chưa bắt đầu"}) → chọn bước tiếp theo (1-7).

   === BƯỚC CHUNG (1–3): XÁC ĐỊNH NHÓM DỊCH VỤ ===
   Bước 1–3 dùng CHUNG cho mọi nhóm dịch vụ. Mục tiêu duy nhất: tìm hiểu khách thuộc nhóm dịch vụ nào.
   TUYỆT ĐỐI KHÔNG báo giá, KHÔNG gửi ảnh, KHÔNG nêu tên gói (Basic/Premium/Luxury) ở bước 1–3.
   Nếu khách hỏi giá ở bước 1–2–3 → trả lời: "Em xin phép hỏi thêm vài điều để tư vấn đúng cho mình nhé" rồi hỏi tiếp để xác định nhóm.

   - Bước 1 [CHUNG]: chỉ khi lịch sử HOÀN TOÀN trống (0 tin outgoing) — chào hỏi lần đầu, hỏi khách quan tâm dịch vụ gì
   - Bước 2 [CHUNG]: khai thác nhu cầu — hỏi để phân loại nhóm dịch vụ (chụp cổng / ngoại cảnh / tiệc / beauty / gia đình…), hỏi ngày cưới, sở thích phong cách
   - Bước 3 [CHUNG]: xác nhận nhóm dịch vụ — tóm tắt lại nhóm vừa xác định, hỏi thêm nếu chưa rõ; KHÔNG gợi ý gói cụ thể, KHÔNG báo giá

   === BƯỚC RIÊNG THEO NHÓM DỊCH VỤ (4–7): CHỈ SAU KHI ĐÃ BIẾT NHÓM ===
   Từ bước 4 trở đi mới dùng nội dung riêng của scriptId đã xác định.

   - Bước 4 [RIÊNG]: báo giá — gửi ảnh mẫu chung của nhóm trước, sau đó giới thiệu bảng giá; lấy từ priceContent + priceImages của script
   - Bước 5 [RIÊNG]: xử lý từ chối, giải đáp thắc mắc về giá/quyền lợi
   - Bước 6 [RIÊNG]: chốt đơn — hỏi khách muốn đặt lịch / đặt cọc
   - Bước 7 [RIÊNG]: chỉ dùng khi khách đã muốn chốt (bước 6) nhưng phân vân về giá → mới được đề xuất giảm giá

3. VIẾT TIN NHẮN: Tách thành 2–4 bubble ngắn theo QUY TẮC FORMAT ở trên.
   - Mỗi element trong mảng "messages" = 1 bubble riêng biệt, tối đa 15 từ
   - TUYỆT ĐỐI không gộp nhiều ý vào 1 phần tử — vi phạm làm bot trả lời như robot
   - Ví dụ ĐÚNG: ["Dạ bạn hỏi về gói chụp ảnh cưới ạ", "Bên em có 3 gói phổ biến nè", "Bạn muốn chụp trong hay ngoài studio?"]
   - Ví dụ SAI: ["Dạ bạn hỏi về gói chụp ảnh cưới ạ. Bên em có 3 gói phổ biến nè. Bạn muốn chụp trong hay ngoài studio?"]

4. QUYẾT ĐỊNH: Nếu câu hỏi nhạy cảm / ngoài phạm vi / không chắc → shouldHandoff=true

Trả về JSON duy nhất:
{
  "scriptId": <số hoặc null>,
  "step": <1-7>,
  "messages": ["bubble 1", "bubble 2", "bubble 3"],
  "reason": "lý do ngắn gọn",
  "isOutOfScope": <boolean>,
  "shouldHandoff": <boolean>
}
`.trim();

  const rawJson = await callOpenAI(input.apiKey, prompt);

  let parsed: Partial<AiSaleReply & { messages?: unknown }> = {};
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    console.error("[AI] JSON parse error:", rawJson.slice(0, 200));
    return { scriptId: null, serviceGroup: null, step: null, messages: [], reason: "JSON parse error", isOutOfScope: true, shouldHandoff: false, usedFallback: false, sendPriceImages: false, sendPriceTextAfterImage: true, priceImages: [] };
  }

  const rawMessages = Array.isArray(parsed.messages)
    ? (parsed.messages as unknown[]).filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    : [];

  const cleanedByBan = applyBannedKeywords(rawMessages, input.settings);
  const memoryFiltered = postProcessMessages(cleanedByBan, memory);
  const messages = mergePricingFragments(memoryFiltered);
  if (memoryFiltered.length !== cleanedByBan.length) {
    console.log(`[AI] memory post-process: ${cleanedByBan.length} → ${memoryFiltered.length} bubbles (stripped greeting/dup-questions). loc=${memory.locationKnown ?? "unknown"} svc=[${memory.serviceMentioned.join(",")}] askedPrice=${memory.askedPrice} outgoing=${memory.outgoingCount}`);
  }

  const resolvedStep = typeof parsed.step === "number" ? parsed.step : null;

  // Determine sendPriceImages: true only when all 3 conditions met
  const settings = input.settings;
  const resolvedScriptId = typeof parsed.scriptId === "number" ? parsed.scriptId : input.currentScriptId;
  const chosenScript = scripts.find((s) => s.id === resolvedScriptId) ?? null;
  if (chosenScript) {
    console.log(`[AI] script id=${chosenScript.id} name="${chosenScript.name}" service_group=${chosenScript.serviceGroup ?? "null"}`);
  }
  const validPriceImages: string[] = [];
  if (settings?.autoSendPriceImage) {
    if (chosenScript?.priceImages && Array.isArray(chosenScript.priceImages)) {
      for (const img of chosenScript.priceImages) {
        if (typeof img === "string" && img.trim()) {
          const resolved = resolveImagePath(img);
          if (resolved) validPriceImages.push(resolved);
        }
      }
    }
  }
  // Hard guardrail: normalize priceImageSendSteps to exclude steps < 4 at runtime
  // B1–B3 are common steps and must never receive price images regardless of settings
  const rawPriceImageSendSteps = settings?.priceImageSendSteps ?? [4];
  const priceImageSendSteps = rawPriceImageSendSteps.filter(s => s >= 4);
  if (priceImageSendSteps.length < rawPriceImageSendSteps.length) {
    console.warn(`[AI] priceImageSendSteps normalised: removed steps < 4 (B1-B3 guardrail). Before: [${rawPriceImageSendSteps}] After: [${priceImageSendSteps}]`);
  }
  const shouldSendImages =
    !!settings?.autoSendPriceImage &&
    resolvedStep !== null &&
    resolvedStep >= 4 &&
    priceImageSendSteps.includes(resolvedStep) &&
    validPriceImages.length > 0;
  if (!shouldSendImages && !!settings?.autoSendPriceImage && resolvedStep !== null && resolvedStep < 4) {
    console.log(`[AI] autoSendPriceImage suppressed: step=${resolvedStep} < 4 (B1-B3 guardrail)`);
  }

  return {
    scriptId: typeof parsed.scriptId === "number" ? parsed.scriptId : null,
    serviceGroup: chosenScript?.serviceGroup ?? null,
    step: resolvedStep,
    messages,
    reason: String(parsed.reason ?? ""),
    isOutOfScope: !!parsed.isOutOfScope,
    shouldHandoff: !!parsed.shouldHandoff,
    usedFallback: false,
    sendPriceImages: shouldSendImages,
    sendPriceTextAfterImage: input.settings?.sendPriceTextAfterImage ?? true,
    priceImages: validPriceImages,
  };
}

export async function askChatGptFallback(input: {
  apiKey: string;
  customerMessage: string;
  customerName: string;
  history: Array<{ direction: "incoming" | "outgoing"; message: string }>;
}): Promise<AiSaleReply> {
  const context = await buildStudioContext([]);
  const historyText = input.history
    .slice(-8)
    .map((m) => `${m.direction === "incoming" ? "Khách" : "Studio"}: ${m.message}`)
    .join("\n");

  const formatInstruction = buildFormatInstruction();

  const prompt = `
Bạn là AI CSKH của studio ảnh cưới. Tên khách: ${input.customerName}.
Chỉ trả lời các câu phổ biến (giá, dịch vụ, lịch chụp, chính sách). Câu hỏi mơ hồ hoặc nhạy cảm → không tự trả lời.

${formatInstruction}

QUAN TRỌNG: Trường "reply" là 1 chuỗi duy nhất — dùng ký tự \\n để phân tách các ý/bubble riêng biệt. Hệ thống sẽ tự tách thành nhiều bubble khi gửi cho khách.

Lịch sử: ${historyText || "(chưa có)"}
Tin nhắn mới: "${input.customerMessage}"
Ngữ cảnh: ${context}

Trả JSON: {"inScope": boolean, "reply": string, "reason": string}
`.trim();

  const rawJson = await callOpenAI(input.apiKey, prompt);
  let parsed: { inScope?: boolean; reply?: string; reason?: string } = {};
  try { parsed = JSON.parse(rawJson); } catch { /* ignore */ }

  const reply = parsed.reply?.trim() ?? "";
  if (!parsed.inScope || !reply) {
    return { scriptId: null, serviceGroup: null, step: null, messages: [], reason: parsed.reason ?? "out_of_scope", isOutOfScope: true, shouldHandoff: false, usedFallback: true, sendPriceImages: false, sendPriceTextAfterImage: true, priceImages: [] };
  }

  const messages = splitIntoChunks(reply);
  return { scriptId: null, serviceGroup: null, step: null, messages, reason: parsed.reason ?? "", isOutOfScope: false, shouldHandoff: false, usedFallback: true, sendPriceImages: false, sendPriceTextAfterImage: true, priceImages: [] };
}

// ─── OpenAI Config ──────────────────────────────────────────────────────────

export async function getOpenAiKey(): Promise<string | null> {
  try {
    const rows = await db
      .select()
      .from(settingsTable)
      .where(inArray(settingsTable.key, ["openai_api_key"]));
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return (
      map.get("openai_api_key") ??
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??
      process.env.OPENAI_API_KEY ??
      null
    );
  } catch {
    return process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
  }
}
