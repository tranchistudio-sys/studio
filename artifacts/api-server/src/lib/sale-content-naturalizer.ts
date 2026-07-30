/**
 * NATURALIZER — tầng "FACT SELECTION → SALE CONTENT" (mandate chống DATABASE VOICE).
 *
 * Database là SOURCE OF TRUTH để Lulu HIỂU — không phải văn bản để COPY đọc cho khách.
 * Module này (THUẦN, test được):
 *  1. naturalizePackageContent: mô tả gói CRM thô (BAO GỒM:/SẢN PHẨM:/bullet/IN HOA)
 *     → cụm ngắn tự nhiên "2 sare + 2 áo vest, makeup chuyên viên, tặng toàn bộ file gốc".
 *     KHÔNG bịa — chỉ chọn lọc + hạ giọng chữ từ CHÍNH mô tả gói.
 *  2. hasDatabaseVoice: detector giọng catalogue trong câu trả lời cuối
 *     (bullet liên tiếp, header CRM, IN HOA dài, dump quá dài) → naturalize/regenerate.
 */

// Dòng header/section CRM — KHÔNG đọc cho khách.
const HEADER_LINE_RE = /^\s*(BAO GỒM|SẢN PHẨM|TRANG PHỤC\s*&?\s*MAKEUP|KHÁCH TỰ CHUẨN BỊ|PHỤ THU|MÔ TẢ|GÓI [A-ZĐÂĂÊÔƠƯ0-9 ]*)\s*:?\s*$/i;
// Dòng marketing/định vị ("DÀNH CHO CẶP ĐÔI...") — để LLM hiểu, không đọc nguyên văn.
const TAGLINE_RE = /(DÀNH CHO|PHIÊN BẢN CAO CẤP|NƠI MỌI CHI TIẾT)/i;
// Dòng thanh toán/cọc — không thuộc "gói gồm gì" (bạn phụ trách xác nhận riêng).
const PAYMENT_RE = /^\s*[•*\-\s]*(cọc|thanh toán|đặt lịch)/i;

/** Hạ chữ IN HOA về thường (giữ số/ký hiệu); "2 SARE + 2 ÁO VEST" → "2 sare + 2 áo vest". */
function deshout(s: string): string {
  // Chỉ hạ khi dòng gần như toàn hoa (chữ thường < 20%) — giữ nguyên câu viết thường sẵn.
  const letters = s.replace(/[^A-Za-zÀ-ỹĐđ]/g, "");
  if (!letters) return s.trim();
  const lower = (letters.match(/[a-zà-ỹđ]/g) ?? []).length;
  if (lower / letters.length >= 0.4) return s.trim();
  return s.toLocaleLowerCase("vi-VN").trim();
}

/**
 * Mô tả gói CRM thô → danh sách ý chính đã "nói được".
 * Trả [] nếu mô tả rỗng/không tách được (caller tự quyết fallback).
 */
export function extractPackageHighlights(description: string | null | undefined): string[] {
  const raw = (description ?? "").trim();
  if (!raw) return [];
  // Tách theo dòng + theo bullet inline (• hoặc * giữa dòng).
  const lines = raw.replace(/\r\n/g, "\n").split(/\n|(?=•)/g)
    .flatMap((l) => l.split(/(?<=\S)\s*[•▪●]\s*/g))
    .map((l) => l.replace(/^[\s•▪●*\-–—⸻]+/, "").trim())
    .filter(Boolean);
  const items: string[] = [];
  for (const line of lines) {
    if (HEADER_LINE_RE.test(line)) continue;
    if (TAGLINE_RE.test(line)) continue;
    if (PAYMENT_RE.test(line)) continue;
    if (/^Giá\s*:/i.test(line)) continue;           // "Giá: 1.200.000đ" — giá lấy từ cột price
    if (/^[-–—⸻\s]+$/.test(line)) continue;          // divider
    const item = deshout(line).replace(/\s{2,}/g, " ").replace(/[.;]+$/, "");
    if (item.length < 3 || item.length > 90) continue;
    if (!items.includes(item)) items.push(item);
  }
  return items;
}

/**
 * Cụm NGẮN tự nhiên mô tả gói — chèn vào {{PACKAGE_CONTENT}} khi trả lời khách.
 * maxItems mặc định 4 (đủ nêu giá trị chính, không dump cả gói).
 */
export function naturalizePackageContent(description: string | null | undefined, maxItems = 4): string {
  const items = extractPackageHighlights(description);
  if (!items.length) return "";
  const picked = items.slice(0, maxItems);
  if (picked.length === 1) return picked[0];
  return `${picked.slice(0, -1).join(", ")} và ${picked[picked.length - 1]}`;
}

export type VoiceCheck = { ok: boolean; reason: string | null };

/**
 * Detector "DATABASE VOICE" trên câu trả lời CUỐI gửi khách.
 * Bắt: header CRM, ≥2 bullet, chuỗi IN HOA dài, câu dài bất thường.
 */
export function checkDatabaseVoice(reply: string): VoiceCheck {
  const t = (reply ?? "").trim();
  if (!t) return { ok: true, reason: null };
  if (/(BAO GỒM|SẢN PHẨM|MÔ TẢ)\s*:/i.test(t)) return { ok: false, reason: "đọc nguyên header CRM (BAO GỒM/SẢN PHẨM)" };
  const bullets = (t.match(/(^|\n)\s*[•▪●*]\s+/g) ?? []).length;
  if (bullets >= 2) return { ok: false, reason: `dump ${bullets} bullet như catalogue` };
  // Chuỗi ≥25 ký tự liên tục toàn HOA (tiếng Việt) — giọng CRM.
  if (/[A-ZĐÀ-Ỵ][A-ZĐÀ-Ỵ0-9\s+():,%–-]{24,}/.test(t.replace(/\{\{[^}]+\}\}/g, ""))) {
    return { ok: false, reason: "chuỗi IN HOA dài kiểu CRM" };
  }
  if (t.length > 700) return { ok: false, reason: `trả lời quá dài (${t.length} ký tự) so với 1 lượt chat` };
  return { ok: true, reason: null };
}
