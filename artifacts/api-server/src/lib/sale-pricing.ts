import { pool } from "@workspace/db";
import { auditPackages, pkgDiscountCfg, groupDiscountCfg, type AuditRow } from "./sale-context";
import { resolveDiscount } from "./pricing-discount";

/**
 * GIÁ CANONICAL cho Scenario Manager (nhánh BÁO GIÁ) — Sales Brain V1 mục 6.
 *
 * NGUYÊN TẮC (chủ studio chốt): scenario CHỈ tham chiếu NGUỒN GIÁ, KHÔNG copy con số.
 * Mọi con số giá Lulu dùng đều đi qua ĐÚNG 1 hàm getEffectivePrice() — hàm này KHÔNG
 * tự tính giảm, chỉ gọi lại nguồn sự thật DUY NHẤT đã có:
 *   auditPackages() (đọc service_packages/service_groups active) + resolveDiscount()
 *   (áp giảm giá 2 cấp + cửa sổ thời gian promo — pricing-discount.ts).
 * → Đổi giá/bật-tắt promo trong "Dịch vụ & Bảng giá" ⇒ lần đọc kế tiếp tự có giá mới,
 *   scenario KHÔNG cần sửa. Hết hạn promo ⇒ resolveDiscount tự trả về giá thường.
 *
 * KHÔNG tạo nguồn giá thứ hai. THUẦN đọc (không ghi), fail-soft (lỗi → rỗng).
 */

export type EffectivePackage = {
  code: string;
  name: string;
  groupName: string;
  /** Giá niêm yết (gốc). */
  basePrice: number;
  /** Giá KHÁCH THẬT SỰ trả tại `now` (sau giảm nếu promo active). */
  effectivePrice: number;
  /** true nếu đang có promo active tại `now`. */
  promoActive: boolean;
  promoName: string | null;
  promoType: "percent" | "fixed" | null;
  savedAmount: number;
  promoEnd: string | null; // ISO — để Lulu nói "ưu đãi đến dd/mm"
  // Chi tiết gói (cho bảng Báo giá chi tiết) — realtime từ service_packages.
  description: string | null; // thành phần "Gồm: …"
  photoCount: number | null;
  includesMakeup: boolean;
};

export type ServicePricePreview = {
  groupName: string;
  packages: EffectivePackage[];
  imageUrl: string | null; // ai_image_url của nhóm — ĐỒNG BỘ ảnh bảng giá với module Dịch vụ & Bảng giá
};

/** name → ai_image_url của các nhóm giá (fail-soft → Map rỗng). */
async function getGroupImages(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    const r = await pool.query(`SELECT name, ai_image_url FROM service_groups WHERE ai_image_url IS NOT NULL AND ai_image_url <> ''`);
    for (const row of r.rows as Array<{ name: string; ai_image_url: string }>) m.set((row.name ?? "").trim(), row.ai_image_url);
  } catch { /* không có ảnh cũng không sao */ }
  return m;
}

// service_key (intent) → keyword khớp tên NHÓM trong "Dịch vụ & Bảng giá" (admin đặt tự do).
// Chỉ để GỢI Ý nguồn giá; admin có thể ghim nguồn chính xác qua price_source của node cây.
const SERVICE_GROUP_KEYWORDS: Record<string, RegExp> = {
  wedding_album: /album|ảnh c[uư][oơ]i|ch[uụ]p c[uư][oơ]i|pre[\s-]?wedding/i,
  wedding_gate: /c[oổ]ng/i,
  wedding_party: /ti[eệ]c|ph[oó]ng s[uự]/i,
  rental_outfit: /v[áa]y|thu[eê]|[áa]o d[àa]i|vest/i,
  maternity: /b[aầ]u|maternity|thai/i,
  family: /gia [đd][iì]nh|family/i,
  beauty: /beauty|k[yỷ] y[eế]u|ngh[eệ] thu[aậ]t|ch[aâ]n dung|profile/i,
};

/** Chuẩn hoá 1 AuditRow (kept) → EffectivePackage tại `now` qua resolveDiscount. */
function toEffective(r: AuditRow, now: Date): EffectivePackage {
  const d = resolveDiscount({ basePrice: r.price, pkg: pkgDiscountCfg(r), group: groupDiscountCfg(r), now });
  return {
    code: (r.code ?? "").trim().toUpperCase(),
    name: (r.pkg_name ?? "").trim(),
    groupName: (r.group_name ?? "").trim(),
    basePrice: d.basePrice,
    effectivePrice: d.finalPrice,
    promoActive: d.discountApplied,
    promoName: d.discountName,
    promoType: d.discountType,
    savedAmount: d.savedAmount,
    promoEnd: d.discountEndDate,
    description: (r.description ?? "").toString().trim() || null,
    photoCount: r.photo_count != null ? Number(r.photo_count) : null,
    includesMakeup: !!r.includes_makeup,
  };
}

/**
 * Xem giá THẬT theo service_key (hoặc theo tên nhóm ghim sẵn `pinnedGroup`).
 * Trả các nhóm khớp; không khớp keyword nào → trả TẤT CẢ nhóm (để admin tự chọn nguồn).
 * fail-soft: lỗi DB → []. now mặc định = thời điểm gọi.
 */
export async function getServicePricePreview(
  serviceKey?: string | null,
  opts?: { pinnedGroup?: string | null; now?: Date },
): Promise<ServicePricePreview[]> {
  const now = opts?.now ?? new Date();
  let kept: AuditRow[];
  try {
    ({ kept } = await auditPackages());
  } catch (err) {
    console.error("[SalePricing] getServicePricePreview lỗi (fail-soft):", String(err).slice(0, 150));
    return [];
  }
  // Gom theo nhóm.
  const byGroup = new Map<string, EffectivePackage[]>();
  for (const r of kept) {
    const eff = toEffective(r, now);
    if (!byGroup.has(eff.groupName)) byGroup.set(eff.groupName, []);
    byGroup.get(eff.groupName)!.push(eff);
  }
  const images = await getGroupImages();
  let groups = [...byGroup.entries()].map(([groupName, packages]) => ({
    groupName, packages, imageUrl: images.get(groupName.trim()) ?? null,
  }));

  const pinned = (opts?.pinnedGroup ?? "").trim();
  if (pinned) {
    const exact = groups.filter((g) => g.groupName.toLowerCase() === pinned.toLowerCase());
    if (exact.length) return exact;
  }
  const kw = serviceKey ? SERVICE_GROUP_KEYWORDS[serviceKey] : undefined;
  if (kw) {
    const matched = groups.filter((g) => kw.test(g.groupName));
    if (matched.length) return matched; // khớp keyword → chỉ trả nhóm liên quan
  }
  return groups; // không khớp → trả tất cả để admin chọn "Đổi nguồn"
}

/**
 * Tên nhóm giá THẬT SỰ khớp keyword của service — [] khi service không có nhóm tương ứng
 * (vd maternity/rental chưa có nhóm giá riêng). Khác getServicePricePreview: KHÔNG fallback
 * trả tất cả — dùng cho service-map để tránh gán bừa nhóm đầu tiên (bug "chụp bầu" → CHỤP CỔNG).
 */
export async function matchedGroupNamesForService(serviceKey: string, now = new Date()): Promise<string[]> {
  const kw = SERVICE_GROUP_KEYWORDS[serviceKey];
  if (!kw) return [];
  const all = await getServicePricePreview(null, { now });
  return all.map((g) => g.groupName).filter((n) => kw.test(n));
}

/**
 * HÀM CANONICAL: giá hiệu lực của MỘT gói tại `now`. Dùng cho trace test + nơi cần 1 con số.
 * packageCode rỗng → trả gói ĐẦU của nhóm khớp (gói tiêu biểu). null nếu không tìm thấy.
 */
export async function getEffectivePrice(
  serviceKey: string,
  packageCode?: string | null,
  now: Date = new Date(),
  pinnedGroup?: string | null,
): Promise<EffectivePackage | null> {
  const groups = await getServicePricePreview(serviceKey, { pinnedGroup, now });
  const all = groups.flatMap((g) => g.packages);
  if (all.length === 0) return null;
  const code = (packageCode ?? "").trim().toUpperCase();
  if (code) return all.find((p) => p.code === code) ?? null;
  return all[0];
}

/** Tập giá HỢP LỆ (base + effective + savedAmount) của 1 service_key — cho Validator đối chiếu. */
export async function validPricesFor(serviceKey: string, now: Date = new Date()): Promise<Set<number>> {
  const groups = await getServicePricePreview(serviceKey, { now });
  const s = new Set<number>();
  for (const g of groups) for (const p of g.packages) {
    if (Number.isFinite(p.basePrice) && p.basePrice > 0) s.add(p.basePrice);
    if (Number.isFinite(p.effectivePrice) && p.effectivePrice > 0) s.add(p.effectivePrice);
    if (p.savedAmount > 0) s.add(p.savedAmount);
  }
  return s;
}
