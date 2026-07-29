/**
 * Chuẩn hoá & so khớp text tiếng Việt — THUẦN (không AI, không embedding), test được.
 * Tách riêng để Scenario Manager + Unknown-Question queue dùng CHUNG một nguồn sự thật
 * (trước đây normalizeVi/tokens là hàm private trong sale-script-library.ts).
 */

/** lowercase + bỏ dấu (NFD) + đ→d. */
export function normalizeVi(s: string): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

// Từ đệm tiếng Việt — loại khi token hoá để so nghĩa (giữ đồng bộ với sale-script-library).
const STOP = new Set([
  "la", "va", "co", "khong", "ko", "cho", "minh", "ban", "em", "chi", "anh", "a", "the",
  "nao", "gi", "voi", "nhe", "nha", "ma", "duoc", "dc", "o", "cua", "de", "thi", "ru", "dạ", "da",
]);

/** Token nội dung: bỏ ký tự lạ, tách space, giữ từ ≥2 ký tự, loại STOP + token toàn số dài (SĐT). */
export function tokens(s: string): string[] {
  return normalizeVi(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d{5,}$/.test(w));
}

/**
 * KHOÁ GOM trùng-nghĩa deterministic: token-set duy nhất, sắp xếp, nối space.
 * Hai câu cùng bộ từ-nội-dung (khác thứ tự/khác dấu) → CÙNG khoá → gộp đếm.
 * Trả "" nếu không còn token nội dung nào (câu rỗng/toàn từ đệm/emoji) — caller nên loại trước.
 */
export function tokenSetKey(s: string): string {
  return Array.from(new Set(tokens(s))).sort().join(" ");
}

/** Điểm trùng token kiểu Jaccard-ish giữa 2 câu (0..1). Dùng gộp gần-giống cấp 2. */
export function tokenOverlapRatio(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / new Set([...ta, ...tb]).size;
}
