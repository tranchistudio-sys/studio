import { getAutopostConfigRaw } from "./autopost-config";

/**
 * autopost-brand.ts — CHỮ KÝ CUỐI BÀI (footer) cố định của Amazing Studio.
 *
 * AI chỉ viết nội dung chính; thông tin liên hệ (tên/địa chỉ/hotline/web/MXH) KHÔNG
 * để AI bịa — luôn lấy từ cấu hình này và GẮN vào cuối caption SAU khi đã sanitize.
 * Lưu trong autopost_settings.config.footer. Không throw (lỗi → footer rỗng).
 */

export const DEFAULT_FOOTER_TEMPLATE = [
  "━━━━━━━━━━━━━━",
  "[ten]",
  "📍 Địa chỉ: [dia_chi]",
  "☎️ Hotline/Zalo: [sdt]",
  "🌐 Website: [website]",
  "💬 Inbox page để được tư vấn nhanh nha",
].join("\n");

export type BrandFooter = {
  enabled: boolean;
  template: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  facebook: string;
  tiktok: string;
  note: string;
};

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function normalizeBrandFooter(raw: Record<string, unknown>): BrandFooter {
  const ft = (raw?.footer && typeof raw.footer === "object" ? raw.footer : {}) as Record<string, unknown>;
  return {
    // Mặc định BẬT footer cho mọi bài (chỉ tắt khi đặt enabled=false tường minh).
    enabled: typeof ft.enabled === "boolean" ? ft.enabled : true,
    template: s(ft.template) || DEFAULT_FOOTER_TEMPLATE,
    name: s(ft.name),
    address: s(ft.address),
    phone: s(ft.phone),
    website: s(ft.website),
    facebook: s(ft.facebook),
    tiktok: s(ft.tiktok),
    note: s(ft.note),
  };
}

export async function getBrandFooter(): Promise<BrandFooter> {
  try {
    return normalizeBrandFooter(await getAutopostConfigRaw());
  } catch {
    return normalizeBrandFooter({});
  }
}

/**
 * Dựng text footer từ template + field. Thay [ten]/[dia_chi]/[sdt]/[website]/
 * [facebook]/[tiktok]/[ghi_chu]; dòng nào CHỈ chứa placeholder rỗng thì bỏ.
 * KHÔNG phụ thuộc enabled (caller tự quyết có gắn hay không).
 */
export function buildFooterText(bf: BrandFooter): string {
  const map: Record<string, string> = {
    "[ten]": bf.name,
    "[dia_chi]": bf.address,
    "[sdt]": bf.phone,
    "[website]": bf.website,
    "[facebook]": bf.facebook,
    "[tiktok]": bf.tiktok,
    "[ghi_chu]": bf.note,
  };
  const lines = (bf.template || DEFAULT_FOOTER_TEMPLATE)
    .split("\n")
    .filter((line) => {
      const tokens = line.match(/\[[a-z_]+\]/g) ?? [];
      if (tokens.length === 0) return true; // dòng tĩnh (kẻ ngang, lời mời inbox)
      // chỉ giữ nếu CÓ ít nhất 1 placeholder có giá trị
      return tokens.some((t) => (map[t] ?? "").trim().length > 0);
    })
    .map((line) => {
      let out = line;
      for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
      return out.replace(/[ \t]+$/g, "");
    });
  return lines.join("\n").trim();
}

/** Đã có footer trong caption chưa (tránh gắn trùng): có kẻ ngang ━ hoặc tên studio. */
export function captionHasFooter(caption: string, bf: BrandFooter): boolean {
  if (!caption) return false;
  if (caption.includes("━━")) return true;
  const name = bf.name.trim();
  if (name && caption.toLowerCase().includes(name.toLowerCase())) return true;
  return false;
}

/** Gắn footer vào cuối caption nếu chưa có. Footer rỗng → trả nguyên caption. */
export function appendFooter(caption: string, bf: BrandFooter): string {
  const body = (caption ?? "").trim();
  const footer = buildFooterText(bf);
  if (!footer) return body;
  if (captionHasFooter(body, bf)) return body;
  return body ? `${body}\n\n${footer}` : footer;
}
