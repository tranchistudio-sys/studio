/**
 * SLOTS V2 + OBJECTION DETECTOR — bộ nhớ sale mở rộng (Sales Brain V1, mục 4 + 7).
 *
 * Module THUẦN (không DB/AI/IO) — mọi detector là regex tiếng Việt đã bỏ dấu,
 * unit-test 100%. Nguyên tắc UNKNOWN_VALID: khách nói "chưa biết" là MỘT CÂU TRẢ LỜI —
 * lưu lại và không bao giờ hỏi lại (nhân rộng từ date_status=not_decided đã chạy).
 *
 * Detector CHỈ ghi khi tín hiệu RÕ (thà bỏ sót còn hơn ghi bậy đè slot đúng).
 */

export const UNKNOWN_VALID = "UNKNOWN_VALID";

function normalizeVi(text: string): string {
  return (text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

// ─── GU / PHONG CÁCH ──────────────────────────────────────────────────────────

const STYLE_PATTERNS: Array<{ re: RegExp; value: string }> = [
  { re: /han quoc|kieu han|style han/, value: "Hàn Quốc" },
  { re: /co dien|vintage|hoai co/, value: "cổ điển/vintage" },
  { re: /sang trong|luxury|cao cap/, value: "sang trọng" },
  { re: /nhe nhang|tu nhien|trong treo|thanh lich/, value: "nhẹ nhàng tự nhiên" },
  { re: /ca tinh|chat|ngau|den trang|doc la/, value: "cá tính" },
  { re: /toi gian|minimal|don gian/, value: "tối giản" },
  { re: /tone (tram|am|lanh|nau|be)/, value: "theo tone màu" },
];
const STYLE_UNKNOWN_RE = /(chua biet (chup )?(kieu|gu|style|concept) (gi|nao)|chua co gu|khong biet kieu nao|gu gi cung duoc)/;

export function detectStyle(text: string): string | null {
  const t = normalizeVi(text);
  if (STYLE_UNKNOWN_RE.test(t)) return UNKNOWN_VALID;
  for (const p of STYLE_PATTERNS) if (p.re.test(t)) return p.value;
  return null;
}

// ─── ĐỊA ĐIỂM ────────────────────────────────────────────────────────────────

export type LocationType = "studio" | "outdoor" | "both" | typeof UNKNOWN_VALID;

export function detectLocationType(text: string): LocationType | null {
  const t = normalizeVi(text);
  const studio = /(tai|o|trong|chup) studio|phim truong/.test(t);
  const outdoor = /ngoai canh|ngoai troi|da lat|vung tau|ho coc|bien|phim truong ngoai/.test(t);
  if (/chua biet (chup )?(o dau|dia diem)|dia diem nao cung duoc/.test(t)) return UNKNOWN_VALID;
  if (studio && outdoor) return "both";
  if (studio) return "studio";
  if (outdoor) return "outdoor";
  return null;
}

// ─── SỐ NGƯỜI ────────────────────────────────────────────────────────────────

export function detectHeadcount(text: string): number | typeof UNKNOWN_VALID | null {
  const t = normalizeVi(text);
  // "nhà mình 5 người", "gia đình 4 người", "chụp 2 người" — số 1-30 hợp lý.
  const m = /(?:nha|gia dinh|nhom|team|tui|chup|ca nha)\D{0,12}?(\d{1,2})\s*(?:nguoi|thanh vien)/.exec(t)
    ?? /(\d{1,2})\s*(?:nguoi|thanh vien)(?:\s|$|,|\.)/.exec(t);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) return n;
  }
  if (/chua biet (may|bao nhieu) nguoi/.test(t)) return UNKNOWN_VALID;
  return null;
}

// ─── NGÂN SÁCH (chỉ ghi text khách nói — KHÔNG dùng làm giá, luật lõi cấm bịa giá) ──

export function detectBudget(text: string): string | typeof UNKNOWN_VALID | null {
  const t = normalizeVi(text);
  if (/(chua biet|khong ro) (ngan sach|tam gia|bao nhieu thi du)|ngan sach thoai mai/.test(t)) return UNKNOWN_VALID;
  // "tầm 3 triệu", "khoảng 3-5tr", "dưới 2 triệu", "ngân sách 5tr"
  const m = /(tam|khoang|duoi|tren|ngan sach|budget)\s*(\d{1,3}(?:[.,]\d{1,3})?\s*(?:-|den|toi)?\s*\d{0,3}\s*(?:trieu|tr\b|k\b))/.exec(t);
  if (m) return m[0].trim();
  return null;
}

// ─── HOÃN / NGƯỜI QUYẾT ĐỊNH / BẬN (postpone) ────────────────────────────────

export type PostponeKind = "partner" | "time" | "busy";

export function detectPostpone(text: string): { kind: PostponeKind; detail: string } | null {
  const t = normalizeVi(text);
  const partner = /(hoi|ban voi|thong nhat voi|xin y kien)\s*(lai\s*)?(chong|vo|ong xa|ba xa|anh nha|gia dinh|ba me|bo me|nguoi yeu)|de (chong|vo|anh|gia dinh).{0,10}(quyet|xem|coi)/.exec(t);
  if (partner) return { kind: "partner", detail: partner[0] };
  const busy = /(dang ban|ti (chi|em|minh) (noi|nhan)|chut (chi|em) (rep|tra loi)|toi (chi|em) nhan lai|ban xiu)/.exec(t);
  if (busy) return { kind: "busy", detail: busy[0] };
  const time = /(de (chi|em|minh|anh) (suy nghi|tinh|xem xet|can nhac)|suy nghi (them|da|cai da)|tinh lai roi bao|xem xet them)/.exec(t);
  if (time) return { kind: "time", detail: time[0] };
  return null;
}

// ─── THAM KHẢO / CHƯA TIN / XIN GIẢM THÊM (tín hiệu scenario V2) ─────────────

/** "để tham khảo thêm / xem thêm vài chỗ" — JUST_BROWSING (khác 'tham khảo GIÁ' = hỏi giá). */
export function detectBrowsing(text: string): boolean {
  const t = normalizeVi(text);
  if (/tham khao gia/.test(t)) return false; // hỏi giá — nhường PRICE_QUESTION
  return /(de.{0,8}tham khao( them| da| truoc)?( da| nha| a)?$|tham khao (them|vai cho|may cho)|xem them (vai|may) (cho|ben|studio)|dang tim hieu (them|thoi))/.test(t);
}

/** "ảnh thật hay ảnh mẫu / có đúng như hình không" — NOT_TRUST_YET. */
export function detectTrustConcern(text: string): boolean {
  const t = normalizeVi(text);
  return /(anh that (hay|khong|ko)|dung nhu (hinh|anh) (khong|ko)|co (giong|dung) (mau|hinh) (khong|ko)|so (chup )?(xau|khong dep|k dep)|(hinh|anh) (tren mang|quang cao) thoi)/.test(t);
}

/** "bớt được không / giảm được không" — DISCOUNT_REQUEST (mức nhẹ hơn escalation giá). */
export function detectDiscountRequest(text: string): boolean {
  const t = normalizeVi(text);
  return /((bot|giam)( them)? (duoc|dc) (khong|ko|k\b|hong)|bot (xiu|chut|ti)|co (giam|khuyen mai|uu dai) (gi )?(khong|ko)|fix (gia |them )?(duoc|dc)? ?(khong|ko)?)/.test(t);
}

/** "tầm bao nhiêu thì đủ / gói nào rẻ nhất" — BUDGET_CONCERN. */
export function detectBudgetConcern(text: string): boolean {
  const t = normalizeVi(text);
  return /(tam bao nhieu (thi|la) (du|dc|duoc)|goi (nao )?(re|thap|mem) (nhat|nhat a|hon)|it tien (nhat|hon)|kinh te (nhat|hon)|sinh vien co goi)/.test(t);
}

// ─── TỪ CHỐI RÕ → LOST ───────────────────────────────────────────────────────

export function detectRefusal(text: string): string | null {
  const t = normalizeVi(text);
  const m = /(khong can nua|thoi khoi|dung nhan (tin )?nua|khong quan tam|chot ben khac( roi)?|dat cho khac roi|lam ben khac roi|da chup roi|huy nhe|khong chup nua)/.exec(t);
  return m ? m[0] : null;
}

// ─── 12 LOẠI OBJECTION (Sales Brain V1 mục 7) ────────────────────────────────

export type ObjectionType =
  | "PRICE_OBJECTION" | "DISCOUNT_REQUEST" | "COMPARE_COMPETITOR" | "ASK_PARTNER"
  | "NEED_TIME" | "NO_DATE_YET" | "JUST_BROWSING" | "NO_RESPONSE" | "NOT_TRUST_YET"
  | "STYLE_UNCERTAIN" | "BUDGET_CONCERN" | "BUSY" | "OTHER";

export const OBJECTION_LABELS: Record<ObjectionType, string> = {
  PRICE_OBJECTION: "chê giá cao",
  DISCOUNT_REQUEST: "xin giảm giá",
  COMPARE_COMPETITOR: "so sánh bên khác",
  ASK_PARTNER: "chờ hỏi chồng/gia đình",
  NEED_TIME: "xin thời gian suy nghĩ",
  NO_DATE_YET: "chưa chốt ngày",
  JUST_BROWSING: "chỉ tham khảo",
  NO_RESPONSE: "im lặng không phản hồi",
  NOT_TRUST_YET: "chưa tin ảnh thật",
  STYLE_UNCERTAIN: "chưa biết gu",
  BUDGET_CONCERN: "lo ngân sách",
  BUSY: "đang bận",
  OTHER: "khác",
};

const PRICE_OBJECTION_RE = /(mac (qua|vay|the|nhi)|dat (qua|vay|the)|gia (cao|chat) (qua|vay)|cao qua|hoi chat|chat vay)/;
const COMPARE_RE = /(ben (kia|khac|x)\s*(re|tot|dep) hon|cho khac (re|tot) hon|studio khac bao (re|thap) hon|thay cho kia)/;

/**
 * Phân loại objection từ 1 tin khách. null = tin này không phải phản đối.
 * Thứ tự ưu tiên: cụ thể trước, chung sau (DISCOUNT trước PRICE; PARTNER trước TIME).
 */
export function detectObjection(text: string): { type: ObjectionType; quote: string } | null {
  const t = normalizeVi(text);
  const quote = (text ?? "").trim().slice(0, 200);
  if (detectDiscountRequest(text)) return { type: "DISCOUNT_REQUEST", quote };
  if (PRICE_OBJECTION_RE.test(t)) return { type: "PRICE_OBJECTION", quote };
  if (COMPARE_RE.test(t)) return { type: "COMPARE_COMPETITOR", quote };
  const pp = detectPostpone(text);
  if (pp?.kind === "partner") return { type: "ASK_PARTNER", quote };
  if (pp?.kind === "busy") return { type: "BUSY", quote };
  if (pp?.kind === "time") return { type: "NEED_TIME", quote };
  if (detectTrustConcern(text)) return { type: "NOT_TRUST_YET", quote };
  if (detectBudgetConcern(text)) return { type: "BUDGET_CONCERN", quote };
  if (detectBrowsing(text)) return { type: "JUST_BROWSING", quote };
  return null;
}
