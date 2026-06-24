/**
 * sale-human-chat — "human chat pacing" cho Lulu Sale.
 *
 * Sau khi AI tạo câu trả lời (đã strip marker <<...>> ở claude-sale.ts), văn bản đi qua
 * formatLuluHumanChatMessages() để TÁCH thành nhiều bong bóng ngắn (mỗi bubble ~1 ý) kèm
 * delayMs — để Messenger / sân test gửi tuần tự cách nhau 1–3s giống NGƯỜI SALE THẬT đang gõ,
 * thay vì bắn một đoạn dài lộ cảm giác chatbot.
 *
 * THUẦN (không I/O) để dễ test. Quy tắc:
 *  - Cắt theo dòng trống trước (giữ ý AI đã tự tách); bubble dài thì cắt tiếp theo câu / emoji.
 *  - GIỮ NGUYÊN khối báo giá / liệt kê gói (không cắt vụn, cho phép dài).
 *  - Tối đa 1 emoji cho cả lượt; KHÔNG emoji ở bubble nhạy cảm (giá/cọc/chốt lịch/ngày).
 *  - Không bao giờ phát chuỗi marker giả ({delay}/[typing]...) ra ngoài.
 */

export type LuluChatChunk = { text: string; delayMs: number };

export type FormatOpts = {
  /** Độ dài tối đa "mềm" của 1 bubble thường (ký tự). Khối giá được phép vượt. Mặc định 120. */
  maxLen?: number;
  /** false = bỏ sạch emoji (vd câu admin ghim exact_reply — chỉ chia bubble, không thêm/sửa). */
  allowEmoji?: boolean;
};

// Emoji + ký hiệu pictographic + cờ + variation selector + ZWJ — để đếm/bỏ.
const EMOJI_CHAR_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;
// 1 "cụm" emoji (gồm modifier/ZWJ) — để tách ranh giới sau emoji ở câu chào.
const EMOJI_CLUSTER_RE = /\p{Extended_Pictographic}(\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])?(\u{200D}\p{Extended_Pictographic}(\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])?)*/gu;

function countEmoji(s: string): number {
  const m = s.match(EMOJI_CLUSTER_RE);
  return m ? m.length : 0;
}
function tidySpacing(s: string): string {
  return s.replace(/ {2,}/g, " ").replace(/\s+([.,;:!?…])/g, "$1").trim();
}
function stripEmoji(s: string): string {
  return tidySpacing(s.replace(EMOJI_CHAR_RE, ""));
}

/**
 * Bubble "nhạy cảm" → KHÔNG để emoji + KHÔNG cắt theo câu (giữ nguyên con số/khối).
 * Dấu hiệu: có số tiền (1.900.000đ / 1tr9 / 300k), "cọc"/"chuyển khoản"/"stk", "Gồm:",
 * mã gói [CG-...], hoặc ngày dd/mm.
 */
function isSensitive(s: string): boolean {
  return (
    /\d[\d.,]*\s*(đ|vnđ|vnd|k|tr|triệu|trieu|nghìn|nghin|ngàn|ngan)\b/i.test(s) ||
    /\b\d{1,2}\s*\/\s*\d{1,2}(\s*\/\s*\d{2,4})?\b/.test(s) ||
    /(cọc|coc|đặt cọc|dat coc|chuyển khoản|chuyen khoan|\bstk\b|số tài khoản|so tai khoan)/i.test(s) ||
    /gồm\s*:/i.test(s) ||
    /\[[A-Z]{2,}[A-Z0-9]*-/.test(s)
  );
}

/** Khối báo giá / liệt kê: nhiều dòng, có bullet, mã gói, hoặc nhạy cảm → giữ nguyên 1 bubble. */
function isBlock(paragraph: string): boolean {
  const lines = paragraph.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.some((l) => /^[*•\-–]\s+/.test(l) || /\[[A-Z]{2,}[A-Z0-9]*-/.test(l))) return true;
  if (lines.length >= 3) return true; // danh sách nhiều dòng → giữ nguyên
  return isSensitive(paragraph) && paragraph.length > 60;
}

/** Cắt 1 đoạn thường thành các câu (theo dấu kết câu + xuống dòng). Không phá giữa câu. */
function splitSentences(paragraph: string): string[] {
  // Xuống dòng đơn trong đoạn thường = ranh giới câu mềm.
  const byLine = paragraph.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of byLine) {
    // Tách sau . ? ! … và sau MỘT cụm emoji giữa câu (emoji hay kết thúc lời chào).
    const re = /[^.?!…]*(?:[.?!…]+|$)/g;
    let buf = "";
    let m: RegExpExecArray | null;
    // Bước 1: tách theo dấu kết câu.
    const sentences: string[] = [];
    while ((m = re.exec(line)) !== null) {
      if (m[0].trim()) sentences.push(m[0].trim());
      if (re.lastIndex >= line.length) break;
    }
    if (sentences.length === 0) sentences.push(line);
    // Bước 2: với câu chào có emoji giữa câu, tách thêm sau cụm emoji đầu tiên.
    for (const sent of sentences) {
      const em = sent.match(EMOJI_CLUSTER_RE);
      if (em) {
        const idx = sent.indexOf(em[0]) + em[0].length;
        const head = sent.slice(0, idx).trim();
        const tail = sent.slice(idx).trim();
        // chỉ tách nếu cả 2 vế đủ "có nghĩa" (đầu là lời chào ngắn, đuôi còn chữ)
        if (head.length >= 3 && tail.length >= 8) { out.push(head); out.push(tail); buf = ""; continue; }
      }
      out.push(sent);
    }
    void buf;
  }
  return out.filter(Boolean);
}

/**
 * Mỗi câu = 1 bubble (sale thật tách từng ý) — KHÔNG gộp các câu trọn vẹn lại chỉ vì vừa maxLen.
 * Chỉ gộp MẢNH quá ngắn (< 25 ký tự, vd "ạ.", "hihi") vào bubble liền trước cho tự nhiên.
 */
function regroup(sentences: string[], maxLen: number): string[] {
  const chunks: string[] = [];
  for (const s of sentences) {
    const last = chunks[chunks.length - 1];
    if (last && s.length < 25 && (last.length + 1 + s.length) <= maxLen + 40) {
      chunks[chunks.length - 1] = `${last} ${s}`;
      continue;
    }
    chunks.push(s);
  }
  return chunks;
}

/** Bỏ marker kỹ thuật giả lỡ còn sót (không để khách thấy). KHÔNG đụng marker thật <<...>> (đã strip trước). */
function stripFakeMarkers(s: string): string {
  return s
    .replace(/\{[^}]*\}/g, "")                                   // {delay 3s}, {xuống dòng...}
    .replace(/\[\s*(typing|delay|pause|chờ|cho)[^\]]*\]/gi, "")    // [typing], [delay 1s]
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Delay cho bubble theo vị trí + độ dài (jitter nhẹ). Bubble 0 nhanh, các bubble sau 1.5–3s. */
function delayFor(index: number, text: string): number {
  if (index === 0) return 800 + Math.floor(Math.random() * 400);          // 800–1200ms
  const base = 1500 + Math.min(1200, text.length * 12);                    // dài hơn → "gõ" lâu hơn
  return Math.min(3000, base + Math.floor(Math.random() * 300));           // cap 3000ms
}

/**
 * Tách câu trả lời AI thành nhiều bong bóng ngắn + delay. Trả [] nếu rỗng.
 */
export function formatLuluHumanChatMessages(text: string, opts: FormatOpts = {}): LuluChatChunk[] {
  const maxLen = opts.maxLen ?? 120;
  const allowEmoji = opts.allowEmoji !== false;

  let raw = stripFakeMarkers((text ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
  if (!raw) return [];

  // 1) Tách theo dòng trống (ý AI đã tự tách).
  const paragraphs = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // 2) Mỗi đoạn: khối giá → giữ nguyên; đoạn còn lại → tách theo CÂU (mỗi câu ~1 bubble), kể cả
  //    khi tổng ngắn (chào + giới thiệu + hỏi nhu cầu phải thành 2–3 bubble như sale thật).
  let chunks: string[] = [];
  for (const para of paragraphs) {
    if (isBlock(para)) { chunks.push(para); continue; }
    const sents = splitSentences(para);
    if (sents.length <= 1 && para.length <= maxLen && !/\n/.test(para)) { chunks.push(para); continue; }
    const grouped = regroup(sents, maxLen);
    chunks.push(...(grouped.length ? grouped : [para]));
  }
  chunks = chunks.map((c) => tidySpacing(c)).filter(Boolean);
  if (chunks.length === 0) return [];

  // 3) Emoji: bỏ ở bubble nhạy cảm; tổng cả lượt ≤ 1 (giữ emoji đầu tiên ở bubble không nhạy cảm).
  let emojiKept = 0;
  chunks = chunks.map((c) => {
    if (!allowEmoji || isSensitive(c)) return stripEmoji(c);
    const n = countEmoji(c);
    if (n === 0) return c;
    if (emojiKept === 0) {
      // giữ đúng 1 emoji (cụm đầu), bỏ phần còn lại trong bubble này
      let seen = false;
      const kept = c.replace(EMOJI_CLUSTER_RE, (m) => { if (!seen) { seen = true; return m; } return ""; });
      emojiKept = 1;
      return kept.replace(/ {2,}/g, " ").trim();
    }
    return stripEmoji(c);
  }).filter(Boolean);

  // 4) Gắn delay theo vị trí.
  return chunks.map((c, i) => ({ text: c, delayMs: delayFor(i, c) }));
}
