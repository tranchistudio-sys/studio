import { pool } from "@workspace/db";
import { getPublicBaseUrl } from "./publicUrl";

/**
 * Context cho bộ não sale Claude (Giai đoạn 1).
 *
 * AN TOÀN DỮ LIỆU BÁN HÀNG: Claude CHỈ được đọc giá bán lẻ chính thức.
 * Bộ lọc (chỉ ở tầng code này — KHÔNG sửa/xóa DB):
 *   1) WHITELIST: chỉ giữ gói có MÃ CODE chuẩn dạng "XX-..." (CG-, ST-, NC-, TC-,
 *      BT-, CM-, CN-, QP-, GD-, MK-, IN-, và mọi tiền tố tương lai như ALBUM-/BEAUTY-...).
 *      → loại các entry thêm tay không code: giá đối tác, promo nháp, đồ thuê lẻ,
 *        lỗi chính tả ("Beaty"), giá nhét trong tên.
 *   2) DENYLIST từ khóa: chặn ngay cả khi có code nếu tên/mã chứa "đối tác", "nội bộ",
 *      "ctv", "test", "nháp"... (phòng dữ liệu tương lai bị gắn nhãn sai).
 *   3) DEDUPE theo code: 2 gói cùng code (vd nhóm "COMBO CÓ MAKEUP" trùng
 *      "COMBO Trang Phục cưới - CÓ MAKEUP") → chỉ giữ 1 (id nhỏ nhất).
 *
 * Dùng auditPackages() để xem chi tiết gói nào giữ/loại và lý do.
 */

const FALLBACK_CONTEXT = `THÔNG TIN STUDIO
- Tên: Amazing Studio — chuyên chụp ảnh cưới, beauty/thời trang, chụp tiệc cưới, chụp gia đình và cho thuê trang phục cưới.

BẢNG GIÁ (tham khảo — báo khách giá chi tiết từng gói khi khách rõ nhu cầu):
- Các nhóm dịch vụ: Chụp cổng tại studio, Album tại studio, Album ngoại cảnh, Chụp tiệc cưới, Beauty/Thời trang, các Combo trang phục cưới (có/không makeup), Quay phim, Chụp gia đình, Makeup lẻ, In ảnh.

CHÍNH SÁCH:
- Cọc giữ lịch và lịch trống cần nhân viên xác nhận — không tự hứa lịch khi chưa kiểm tra.
- Mọi ưu đãi/giảm giá ngoài bảng giá phải do quản lý duyệt.`;

// Mã code chuẩn của catalog bán lẻ: 2+ chữ rồi dấu '-'. So khớp sau khi upper-case.
const RETAIL_CODE_RE = /^[A-Z]{2,}[A-Z0-9]*-/;

// Từ khóa CẤM — chặn dù có code (đề phòng dữ liệu tương lai bị gắn nhãn nhầm).
const DENY_KEYWORDS = [
  "đối tác", "doi tac", "nội bộ", "noi bo", "ctv", "cộng tác viên", "cong tac vien",
  "giá vốn", "gia von", "test", "thử nghiệm", "thu nghiem", "nháp", "draft",
  "nhân viên", "nhan vien", "internal", "wholesale", "sỉ",
];

export type PkgRow = { id: number; group_name: string; pkg_name: string; price: string; code: string | null; description?: string | null };
export type AuditRow = PkgRow & { kept: boolean; reason: string };

let cache: { text: string; at: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

function formatVnd(price: string | number): string {
  const n = Math.round(Number(price));
  if (!Number.isFinite(n) || n <= 0) return "liên hệ";
  return n.toLocaleString("vi-VN") + "đ";
}

/** Dọn mô tả gói (thành phần/quà tặng) để đưa vào context — bỏ bullet markdown, gọn khoảng trắng. */
function cleanDesc(d?: string | null): string {
  return (d ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*[•*►▪➤]\s*/g, "; ")
    .replace(/^[;\s.]+/, "")
    .trim()
    .slice(0, 240);
}

/** Lý do một gói KHÔNG an toàn cho Claude (null nếu an toàn). */
function unsafeReason(r: PkgRow): string | null {
  const code = (r.code ?? "").trim();
  const name = (r.pkg_name ?? "").trim();
  const hay = `${name} ${code}`.toLowerCase();
  for (const kw of DENY_KEYWORDS) if (hay.includes(kw)) return `denylist:"${kw}"`;
  if (!RETAIL_CODE_RE.test(code.toUpperCase())) return "no_standard_code";
  return null;
}

async function fetchActivePackages(): Promise<PkgRow[]> {
  const res = await pool.query(
    `SELECT p.id, g.name AS group_name, p.name AS pkg_name, p.price, p.code, p.description
     FROM service_groups g JOIN service_packages p ON p.group_id = g.id
     WHERE g.is_active = 1 AND p.is_active = 1
     ORDER BY g.sort_order, g.id, p.sort_order, p.id`,
  );
  return res.rows as PkgRow[];
}

/** Phân loại toàn bộ gói active thành kept (an toàn) / excluded (bị loại + lý do). */
export async function auditPackages(): Promise<{ total: number; kept: AuditRow[]; excluded: AuditRow[] }> {
  const rows = await fetchActivePackages();
  const seenCode = new Set<string>();
  const kept: AuditRow[] = [];
  const excluded: AuditRow[] = [];
  for (const r of rows) {
    const reason = unsafeReason(r);
    if (reason) {
      excluded.push({ ...r, kept: false, reason });
      continue;
    }
    const code = (r.code ?? "").trim().toUpperCase();
    if (seenCode.has(code)) {
      excluded.push({ ...r, kept: false, reason: `duplicate_code:${code}` });
      continue;
    }
    seenCode.add(code);
    kept.push({ ...r, kept: true, reason: "retail_ok" });
  }
  return { total: rows.length, kept, excluded };
}

/** Context + số gói bán lẻ đang cho Claude đọc (để hiển thị trong màn hình test). */
export async function getSaleContextInfo(): Promise<{ context: string; packageCount: number; totalActive: number }> {
  const context = await getSaleContext();
  const { total, kept } = await auditPackages();
  return { context, packageCount: kept.length, totalActive: total };
}

export async function getSaleContext(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.text;
  try {
    const settingsRes = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('fb_active_page_name', 'email')`,
    );
    const sMap = new Map<string, string>(
      (settingsRes.rows as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
    );
    const studioName = sMap.get("fb_active_page_name") || "Amazing Studio";

    const { total, kept, excluded } = await auditPackages();
    console.log(`[Claude] sale-context: giữ ${kept.length}/${total} gói bán lẻ, loại ${excluded.length} (đối tác/nội bộ/test/trùng/đồ thuê lẻ)`);

    if (kept.length === 0) throw new Error("Không có gói bán lẻ hợp lệ sau khi lọc");

    const groups = new Map<string, string[]>();
    for (const r of kept) {
      if (!groups.has(r.group_name)) groups.set(r.group_name, []);
      const desc = cleanDesc(r.description);
      const code = (r.code ?? "").trim().toUpperCase();
      // Mã [CODE] đứng đầu để Claude trích đúng mã gói khi báo giá (dùng cho <<PRICE_IMAGE: MÃ>>).
      const head = code ? `[${code}] ` : "";
      const line = desc
        ? `${head}${r.pkg_name.trim()} — ${formatVnd(r.price)}. Gồm: ${desc}`
        : `${head}${r.pkg_name.trim()} — ${formatVnd(r.price)}`;
      groups.get(r.group_name)!.push(line);
    }
    let priceText = "";
    for (const [groupName, lines] of groups) {
      priceText += `\n[${groupName}]\n${lines.join("\n")}\n`;
    }

    // LINK & CONCEPT thật (Bước 4 & 7). base lấy từ PUBLIC_APP_URL (production); local là placeholder.
    const base = getPublicBaseUrl().replace(/\/+$/, "");
    let albumLines = "";
    try {
      const albumRes = await pool.query(
        `SELECT name, slug, tags_text FROM gallery_albums WHERE status = 'visible' AND deleted_at IS NULL AND slug IS NOT NULL ORDER BY sort_order, id`,
      );
      albumLines = (albumRes.rows as Array<{ name: string; slug: string; tags_text: string | null }>)
        .map((a) => {
          const tags = (a.tags_text ?? "").trim();
          // [nhóm/tag] giúp AI chọn ĐÚNG album theo nhu cầu khách (beauty/cưới/gia đình…), không lẫn nhóm.
          return `${a.name.trim()}${tags ? ` [nhóm/tag: ${tags}]` : ""}: ${base}/bo-anh/${a.slug}`;
        })
        .join("\n");
    } catch { /* bỏ qua nếu lỗi */ }

    const linkBlock = `LINK (CHỈ gửi khi khách CHỦ ĐỘNG hỏi/đòi — TUYỆT ĐỐI KHÔNG tự dán link khi khách chưa yêu cầu):
- Khách hỏi web/trang chủ → ${base}/
- Khách hỏi bảng giá chi tiết → ${base}/bang-gia
- Khách hỏi xem trang phục cho thuê → ${base}/cho-thue-do
⚠️ QUY TẮC LINK ẢNH (RẤT QUAN TRỌNG): ảnh mẫu đã do HỆ THỐNG tự gửi trong chat. Em TUYỆT ĐỐI KHÔNG tự dán link /bo-anh/... để "khoe thêm mẫu" hay thay cho ảnh. CHỈ gửi link MỘT bộ khi khách NÓI RÕ muốn xem CHI TIẾT / CẢ BỘ / NGUYÊN ALBUM của bộ đó. Nếu hết ảnh mới để gửi, em chỉ hỏi gu/phong cách — KHÔNG dán link thay thế.
${albumLines ? `\n[NỘI BỘ — danh sách bộ đang có để em BIẾT, KHÔNG dán link cho khách trừ khi khách đòi xem cả bộ đó]:\n${albumLines}` : ""}`;

    const text = `THÔNG TIN STUDIO
- Tên: ${studioName} — chuyên chụp ảnh cưới, beauty/thời trang, chụp tiệc cưới, chụp gia đình và cho thuê trang phục cưới.

BẢNG GIÁ BÁN LẺ CHÍNH THỨC (đã lọc — CHỈ báo khách trong khoảng giá này, KHÔNG báo giá nào khác):
${priceText}
${linkBlock}

CHÍNH SÁCH:
- Cọc giữ lịch và lịch trống cần nhân viên xác nhận — không tự hứa lịch khi chưa kiểm tra.
- Mọi ưu đãi/giảm giá ngoài bảng giá phải do quản lý duyệt.`;

    cache = { text, at: Date.now() };
    return text;
  } catch (err) {
    console.error("[Claude] getSaleContext — dùng fallback:", String(err).slice(0, 200));
    return FALLBACK_CONTEXT;
  }
}

// Khách CÓ ĐANG muốn concept mới/lạ không? CHỈ khi đúng → mới nạp "Ý tưởng chụp ảnh".
// Khớp đúng các cụm khách hay nói (có/không dấu): "ý tưởng mới", "concept lạ", "độc đáo
// hơn", "không thích mấy mẫu này", "muốn cái mới mẻ hơn"… Mặc định KHÔNG dùng Ý tưởng.
const NEW_CONCEPT_RE =
  /(ý tưởng|y tuong|concept|độc đáo|doc dao|độc lạ|doc la|mới mẻ|moi me|lạ hơn|la hon|cái mới|cai moi|gì mới|gi moi|gì lạ|gi la|khác hơn|khac hon|sáng tạo|sang tao|không thích|khong thich|chán mẫu|chan mau|chưa ưng|chua ung|có gì hay hơn|co gi hay hon)/i;

/** true nếu khách đang muốn concept mới/lạ (mở khóa nguồn "Ý tưởng chụp ảnh"). */
export function wantsNewConcept(message: string): boolean {
  return NEW_CONCEPT_RE.test((message ?? "").toLowerCase());
}

let ideasCache: { text: string; at: number } | null = null;

/**
 * Khối "Ý TƯỞNG CHỤP" (photo_ideas) — NGUỒN PHỤ, chỉ append vào context khi
 * wantsNewConcept() = true. Không có link công khai (trang khóa mật khẩu) nên chỉ
 * mô tả bằng lời. "" nếu không có ý tưởng nào / lỗi. KHÔNG bao giờ throw.
 */
export async function getPhotoIdeasBlock(): Promise<string> {
  if (ideasCache && Date.now() - ideasCache.at < TTL_MS) return ideasCache.text;
  try {
    const res = await pool.query(
      `SELECT name, description, tags_text FROM photo_ideas
        WHERE deleted_at IS NULL AND (visibility_status = 'public' OR visibility_status IS NULL)
        ORDER BY sort_order, id LIMIT 18`,
    );
    const rows = res.rows as Array<{ name: string; description: string | null; tags_text: string | null }>;
    if (rows.length === 0) { ideasCache = { text: "", at: Date.now() }; return ""; }
    const lines = rows.map((r) => {
      const desc = cleanDesc(r.description).slice(0, 120);
      const tags = (r.tags_text ?? "").trim();
      const tail = [desc, tags ? `tag: ${tags}` : ""].filter(Boolean).join(", ");
      return `- ${(r.name ?? "").trim()}${tail ? `: ${tail}` : ""}`;
    });
    const text = `Ý TƯỞNG CHỤP (CONCEPT GỢI Ý — KHÔNG phải sản phẩm/dịch vụ có sẵn của studio):
Chỉ dùng khi khách muốn concept mới/lạ hoặc chưa ưng mẫu có sẵn. Khi gợi ý PHẢI nói rõ đây là Ý TƯỞNG tham khảo; nếu khách thích thì studio sẽ kiểm tra trang phục/đạo cụ có sẵn hay cần đầu tư thêm. KHÔNG có link công khai nên mô tả bằng lời, TUYỆT ĐỐI không bịa link.
${lines.join("\n")}`;
    ideasCache = { text, at: Date.now() };
    return text;
  } catch (err) {
    console.error("[Claude] getPhotoIdeasBlock lỗi:", String(err).slice(0, 160));
    return "";
  }
}

/** Ảnh bảng giá của nhóm để Sale AI gửi cho khách (đã qua gate publicForCustomer). */
export type PriceImageHit = { code: string; groupId: number; groupName: string; objectPath: string };

/**
 * Tra ảnh bảng giá nhóm từ danh sách MÃ GÓI mà Claude xác định (vd ST-LUXURY).
 * Quy tắc (spec): packageCode → gói → nhóm → group.aiImageUrl.
 * CHỈ trả ảnh khi nhóm CÓ ai_image_url VÀ public_for_customer = TRUE.
 * Dedupe theo nhóm (mỗi nhóm chỉ 1 ảnh dù nhiều mã trỏ về). KHÔNG bao giờ throw.
 */
export async function resolvePriceImagesByCodes(codes: string[]): Promise<PriceImageHit[]> {
  const norm = Array.from(
    new Set((codes ?? []).map((c) => (c ?? "").trim().toUpperCase()).filter(Boolean)),
  );
  if (norm.length === 0) return [];
  try {
    const res = await pool.query(
      `SELECT DISTINCT ON (g.id)
              g.id AS group_id, g.name AS group_name, g.ai_image_url, p.code
       FROM service_packages p
       JOIN service_groups g ON g.id = p.group_id
       WHERE UPPER(p.code) = ANY($1)
         AND g.ai_image_url IS NOT NULL
         AND length(trim(g.ai_image_url)) > 0
         AND g.public_for_customer = TRUE
       ORDER BY g.id`,
      [norm],
    );
    return (res.rows as Array<{ group_id: number; group_name: string; ai_image_url: string; code: string | null }>).map(
      (r) => ({
        code: (r.code ?? "").trim().toUpperCase(),
        groupId: r.group_id,
        groupName: r.group_name,
        objectPath: r.ai_image_url.trim(),
      }),
    );
  } catch (err) {
    console.error("[Claude] resolvePriceImagesByCodes lỗi:", String(err).slice(0, 160));
    return [];
  }
}
