/**
 * search-normalize.ts — helper THUẦN cho Global Search (ô tìm nhanh ở header).
 *
 * Mục tiêu: gõ "thanh truc" (không dấu, thiếu họ) vẫn ra "Phan Thanh Trúc"; gõ 4 số cuối ra đúng
 * SĐT; gõ "184" gợi ý "DH0184". Tách riêng logic chuẩn hoá + chấm điểm để test không cần DB, và
 * để backend (routes/search.ts) tái dùng 1 nguồn chân lý.
 */

/** Bỏ dấu tiếng Việt + đ→d, lowercase, gộp khoảng trắng thừa. "Phan Thanh Trúc" → "phan thanh truc". */
export function normalizeSearchText(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // bỏ dấu tổ hợp (sắc/huyền/hỏi/ngã/nặng, mũ, móc…)
    .replace(/[đ]/g, "d") // đ
    .replace(/[Đ]/g, "D") // Đ
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Chỉ giữ chữ số. "035 314.4916" → "0353144916". */
export function normalizePhone(input: string | null | undefined): string {
  if (!input) return "";
  return input.replace(/\D/g, "");
}

/**
 * Chuẩn hoá mã đơn: viết hoa, bỏ ký tự không phải chữ/số, bỏ số 0 ở đầu phần số.
 * "DH0184"→"DH184", "dh184"→"DH184", "184"→"184", "DH0184 "→"DH184".
 * Nhờ vậy "184"/"DH184"/"DH0184" đều quy về cùng dạng để so khớp.
 */
export function normalizeOrderCode(input: string | null | undefined): string {
  // Giữ dấu '-' để KHÔNG gộp mã con "DH0184-2" thành "DH1842" (đụng mã "DH1842" thật).
  const raw = (input ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!raw) return "";
  const m = raw.match(/^([A-Z]*)0*(\d+)(-\d+)?$/);
  if (m) return m[1] + m[2] + (m[3] ?? ""); // tiền tố chữ + số (bỏ 0 đầu) + hậu tố con
  return raw.replace(/-/g, "");
}

/** Tách query thành các token đã bỏ dấu. "thanh trúc" → ["thanh","truc"]. */
export function tokenize(input: string | null | undefined): string[] {
  const n = normalizeSearchText(input);
  return n ? n.split(" ").filter(Boolean) : [];
}

export type SearchableRow = {
  customerName?: string | null;
  customerPhone?: string | null;
  orderCode?: string | null;
  serviceLabel?: string | null;
  packageType?: string | null;
  location?: string | null;
  notes?: string | null;
};

/**
 * Chấm điểm 1 dòng (booking/khách) so với query. Cao hơn = khớp tốt hơn; 0 = không khớp.
 * Thứ tự ưu tiên: khớp chính xác > prefix > SĐT > mã đơn > đủ token > chứa gần đúng.
 * Điểm chỉ để XẾP HẠNG tương đối, không phải giá trị tuyệt đối.
 */
export function scoreSearchResult(queryRaw: string, row: SearchableRow): number {
  const q = normalizeSearchText(queryRaw);
  if (!q) return 0;
  const qTokens = tokenize(queryRaw);
  const qDigits = normalizePhone(queryRaw);
  const qCode = normalizeOrderCode(queryRaw);

  const name = normalizeSearchText(row.customerName);
  const phoneDigits = normalizePhone(row.customerPhone);
  const code = normalizeOrderCode(row.orderCode);
  // Số chính của mã đơn (bỏ tiền tố chữ + hậu tố con): "DH0184"→"184", "DH184-2"→"184".
  const codeMainDigits = normalizePhone(code.split("-")[0]);
  const blob = normalizeSearchText(
    [row.customerName, row.orderCode, row.serviceLabel, row.packageType, row.location, row.notes]
      .filter(Boolean)
      .join(" "),
  );

  let score = 0;
  const bump = (v: number) => { if (v > score) score = v; };

  // ── Tên khách ──
  if (name) {
    if (name === q) bump(100);
    else if (name.startsWith(q)) bump(82);
  }

  // ── SĐT (query có đủ số mới xét, tránh nhiễu) ──
  if (qDigits.length >= 3 && phoneDigits) {
    if (phoneDigits === qDigits) bump(96);
    else if (phoneDigits.startsWith(qDigits)) bump(80);
    else if (phoneDigits.endsWith(qDigits)) bump(76); // gõ 4 số cuối
    else if (phoneDigits.includes(qDigits)) bump(62);
  }

  // ── Mã đơn ──
  if (qCode && code) {
    if (code === qCode) bump(92);
    else if (code.startsWith(qCode)) bump(72);
    else if (code.includes(qCode)) bump(56);
  }
  // Gõ TOÀN SỐ khớp phần số chính của mã đơn (vd "184" ⇒ DH0184) — ưu tiên hơn SĐT chỉ chứa số đó,
  // vì mã đơn "DH184" không thể prefix/exact với query "184" (vướng tiền tố "DH").
  if (qDigits.length >= 2 && codeMainDigits) {
    if (codeMainDigits === qDigits) bump(90);
    else if (codeMainDigits.endsWith(qDigits)) bump(70);
  }

  // ── Token (đủ tất cả token của query xuất hiện trong dòng) ──
  if (qTokens.length > 0) {
    const allInName = name ? qTokens.every((t) => name.includes(t)) : false;
    const allInBlob = qTokens.every((t) => blob.includes(t));
    if (allInName) {
      bump(name.startsWith(qTokens[0]) ? 78 : 70);
    } else if (allInBlob) {
      bump(52);
    } else if (qTokens.some((t) => blob.includes(t))) {
      bump(22); // khớp một phần → gần đúng, xếp cuối
    }
  }

  // ── Chứa nguyên chuỗi (fallback) ──
  if (blob.includes(q)) bump(44);

  return score;
}
