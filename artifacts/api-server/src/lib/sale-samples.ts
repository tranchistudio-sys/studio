import { pool } from "@workspace/db";
import { getPublicBaseUrl } from "./publicUrl";
import type { ClaudeSaleSettings } from "./sale-settings";
import type { ServiceIntent, CustomerImageIntent } from "./sale-vision";

/**
 * sale-samples.ts — Lulu GỬI ẢNH MẪU THẬT trực tiếp trong chat.
 *
 * Khi Lulu tư vấn mẫu cho khách, ta gửi 1–2 ẢNH THẬT (sản phẩm/bộ ảnh/đồ thuê)
 * ĐÚNG nhóm nhu cầu, rồi mới tới text ngắn + link xem thêm. Module này:
 *   1) phân loại nhu cầu khách từ TEXT (khi không có ảnh khách gửi),
 *   2) lấy ĐÚNG ảnh mẫu thật theo nhóm (gallery / cho thuê đồ / ý tưởng chụp),
 *   3) tôn trọng công tắc "Gửi ảnh mẫu" trong Cài đặt Claude Sale.
 *
 * AN TOÀN: CHỈ ĐỌC DB (gallery_albums/gallery_photos, dresses, photo_ideas,
 * cms_categories). KHÔNG sửa/xóa, KHÔNG đụng booking/payment/calendar.
 * Mọi hàm KHÔNG bao giờ throw (lỗi → trả [] → Lulu fallback text/link).
 */

export type SampleSourceType = "service_package" | "rental_item" | "gallery" | "photo_idea";

export type SampleImage = {
  /** Tên ngắn hiển thị dưới ảnh (caption). */
  title: string;
  /** Đường dẫn ảnh THÔ (vd /objects/uploads/.. hoặc /uploads/cms/..). FE dùng getImageSrc; Messenger dùng toPublicImageUrl. */
  imageUrl: string;
  /** Link xem chi tiết (album/cho thuê đồ). undefined nếu nhóm không có trang công khai (vd Ý tưởng). */
  detailUrl?: string;
  sourceType: SampleSourceType;
  serviceIntent?: string;
};

export type SampleLink = { title: string; url: string };

// ─── Chuẩn hóa chuỗi (bỏ dấu, đ→d, thường hóa) để so khớp không phụ thuộc dấu ──
function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Khớp keyword trong haystack đã norm. Keyword có dấu cách → substring; 1 từ → khớp nguyên token. */
function hayHas(hay: string, kw: string): boolean {
  if (!kw) return false;
  if (kw.includes(" ")) return hay.includes(kw);
  return new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(hay);
}

function hayHasAny(hay: string, kws: string[]): boolean {
  return kws.some((k) => hayHas(hay, k));
}

// ─── TEXT → service_intent (khi khách KHÔNG gửi ảnh) ─────────────────────────
// Bảo thủ: chỉ trả intent khi tin khách thật sự nói về NHU CẦU CHỤP / GU / TRANG
// PHỤC / CONCEPT. Câu hỏi giá trần (không kèm gu) → "unknown" → không gửi ảnh.

const RENTAL_TEXT_RE =
  /(thuê|thue)\s*(đồ|do|váy|vay|áo dài|ao dai|vest)|váy cưới|vay cuoi|áo dài|ao dai|\bvest\b|việt phục|viet phuc|cổ phục|co phuc|cho thuê|cho thue|có (váy|vay|đồ|do)|co (vay|do)/i;
const WEDDING_GATE_RE = /(cổng|cong)\s*(cưới|cuoi)?|chụp cổng|chup cong/i;
const WEDDING_PARTY_RE = /(tiệc cưới|tiec cuoi|phóng sự|phong su|đãi tiệc|dai tiec|chụp tiệc|chup tiec)/i;
// LUẬT 4 — "ngoại cảnh" TRẦN (không kèm "cưới") cố tình KHÔNG khớp ở đây: có thể là
// ngoại cảnh CƯỚI hoặc ngoại cảnh BEAUTY → để Lulu hỏi lại thay vì đoán bừa.
const WEDDING_ALBUM_RE =
  /(cưới|cuoi|cô dâu|co dau|chú rể|chu re|album cưới|chụp cưới|chup cuoi|pre[- ]?wedding|wedding)/i;
const MATERNITY_RE = /(bầu|bau|mẹ bầu|me bau|mang thai|maternity)/i;
const FAMILY_RE = /(gia đình|gia dinh|cả nhà|ca nha|family|chụp gia đình)/i;
const BEAUTY_RE =
  /(beauty|beaty|cool boy|cool ?girl|cá tính|ca tinh|ngầu|ngau|nàng thơ|nang tho|chân dung|chan dung|cá nhân|ca nhan|profile|kỷ yếu|ky yeu|sinh nhật|sinh nhat|nghệ thuật|nghe thuat|tạp chí|tap chi|fashion|thời trang|thoi trang|gym|sang chảnh|sang chanh|sống ảo|song ao)/i;
const NEW_CONCEPT_RE =
  /(ý tưởng|y tuong|concept|độc đáo|doc dao|độc lạ|doc la|mới mẻ|moi me|lạ hơn|la hon|cái mới|cai moi|gì mới|gi moi|gì lạ|gi la|khác hơn|khac hon|sáng tạo|sang tao|không thích|khong thich|chán mẫu|chan mau|chưa ưng|chua ung)/i;

/**
 * Suy ra nhu cầu khách từ TIN NHẮN (không ảnh). Trả "unknown" nếu không chắc
 * (Lulu sẽ hỏi lại, KHÔNG gửi ảnh bừa). Thứ tự ưu tiên đặt theo độ đặc trưng.
 */
export function detectServiceIntentFromText(message: string): ServiceIntent {
  const m = (message ?? "").toLowerCase();
  if (!m.trim()) return "unknown";
  // Concept lạ/mới đặt TRƯỚC: khách chê mẫu cũ / muốn ý tưởng → Ý tưởng chụp.
  if (NEW_CONCEPT_RE.test(m)) return "new_concept_idea";
  // Hỏi trang phục để THUÊ đặt trước cưới (vì "váy cưới" cũng khớp WEDDING_ALBUM_RE).
  if (RENTAL_TEXT_RE.test(m)) return "rental_outfit";
  if (WEDDING_GATE_RE.test(m)) return "wedding_gate";
  if (WEDDING_PARTY_RE.test(m)) return "wedding_party";
  if (MATERNITY_RE.test(m)) return "maternity";
  if (FAMILY_RE.test(m)) return "family";
  if (WEDDING_ALBUM_RE.test(m)) return "wedding_album";
  if (BEAUTY_RE.test(m)) return "beauty";
  return "unknown";
}

// ─── GIỚI TÍNH — chống gửi ảnh sai giới (vd "cool boy" mà gửi mẫu nữ) ─────────
export type Gender = "male" | "female";

const MALE_TEXT_RE =
  /(cool ?boy|chụp nam|chup nam|ảnh nam|anh nam|đồ nam|do nam|con trai|chàng trai|chang trai|soái ca|soai ca|nam tính|nam tinh|cho nam|kiểu nam|kieu nam|phái mạnh|phai manh|menswear|men style)/i;
const FEMALE_TEXT_RE =
  /(cool ?girl|chụp nữ|chup nu|ảnh nữ|anh nu|đồ nữ|do nu|con gái|con gai|cô gái|co gai|nàng thơ|nang tho|tiểu thư|tieu thu|cho nữ|cho nu|kiểu nữ|kieu nu|phái nữ|phai nu)/i;

/**
 * Suy GIỚI TÍNH khách muốn từ tin nhắn (null nếu không rõ). Dùng để lọc ảnh mẫu
 * beauty/cá nhân & trang phục cho thuê: "cool boy" → male, "nàng thơ" → female.
 */
export function detectGender(message: string): Gender | null {
  const m = (message ?? "").toLowerCase();
  if (!m.trim()) return null;
  const male = MALE_TEXT_RE.test(m);
  const female = FEMALE_TEXT_RE.test(m);
  if (male && !female) return "male";
  if (female && !male) return "female";
  return null;
}

// Dấu hiệu nam/nữ trong tên album/đồ + đường dẫn danh mục (đã norm).
const MALE_MARKERS = ["nam", "gym", "boy", "men", "chang trai", "soai", "nam tinh", "manly", "vest", "chu re"];
const FEMALE_MARKERS = ["nang tho", "sexy", "tieu thu", "co gai", "lady", "girl", "nang", "co dau", "nu tinh"];

/**
 * Giới tính của 1 mẫu (album/đồ) suy từ haystack tên + danh mục.
 * "male"/"female"/null (không rõ). Dùng để LỌC, ưu tiên đúng giới khách hỏi.
 */
export function sampleGender(hay: string): Gender | null {
  const male = hayHasAny(hay, MALE_MARKERS);
  const female = hayHasAny(hay, FEMALE_MARKERS);
  if (male && !female) return "male";
  if (female && !male) return "female";
  return null;
}

/** Chuẩn hóa nhãn intent người/AI gõ (vd "Beauty", "wedding album") về 1 ServiceIntent hợp lệ. */
const INTENT_ALIASES: Record<string, ServiceIntent> = {
  beauty: "beauty",
  beaty: "beauty",
  "cool boy": "beauty",
  coolboy: "beauty",
  "chan dung": "beauty",
  "ca nhan": "beauty",
  "nang tho": "beauty",
  profile: "beauty",
  wedding: "wedding_album",
  wedding_album: "wedding_album",
  "wedding album": "wedding_album",
  cuoi: "wedding_album",
  "album cuoi": "wedding_album",
  "ngoai canh": "wedding_album",
  wedding_gate: "wedding_gate",
  "wedding gate": "wedding_gate",
  cong: "wedding_gate",
  "cong cuoi": "wedding_gate",
  "chup cong": "wedding_gate",
  wedding_party: "wedding_party",
  "wedding party": "wedding_party",
  "tiec cuoi": "wedding_party",
  "phong su": "wedding_party",
  rental_outfit: "rental_outfit",
  "rental outfit": "rental_outfit",
  rental: "rental_outfit",
  "thue do": "rental_outfit",
  "vay cuoi": "rental_outfit",
  "ao dai": "rental_outfit",
  vest: "rental_outfit",
  maternity: "maternity",
  bau: "maternity",
  "me bau": "maternity",
  family: "family",
  "gia dinh": "family",
  new_concept_idea: "new_concept_idea",
  "new concept idea": "new_concept_idea",
  concept: "new_concept_idea",
  "y tuong": "new_concept_idea",
  idea: "new_concept_idea",
};

export function normalizeIntent(raw: string | null | undefined): ServiceIntent | null {
  const k = norm(raw);
  if (!k) return null;
  if (INTENT_ALIASES[k]) return INTENT_ALIASES[k];
  // Khớp 1 phần — ưu tiên alias DÀI NHẤT trước (vd "ao dai cuoi" phải ra
  // rental_outfit qua "ao dai", KHÔNG ra wedding_album qua token "cuoi").
  const aliases = Object.entries(INTENT_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, intent] of aliases) {
    if (hayHas(k, alias)) return intent;
  }
  return null;
}

// ─── Công tắc "Gửi ảnh mẫu" (Cài đặt Claude Sale, mục E) → intent ─────────────
function imageToggleOn(intent: ServiceIntent, s?: ClaudeSaleSettings | null): boolean {
  if (!s) return true; // không có cấu hình → cho phép (mặc định bật)
  switch (intent) {
    case "beauty":
      return s.imgBeauty;
    case "wedding_album":
    case "wedding_gate":
    case "wedding_party":
      return s.imgWedding;
    case "maternity":
      return s.imgPregnancy;
    case "family":
      return s.imgFamily;
    case "rental_outfit":
      return s.imgDress;
    case "new_concept_idea":
      return s.imgConcept;
    default:
      return false;
  }
}

// ─── Resolve URL công khai (cho Messenger gửi attachment) ─────────────────────
/** Đổi đường dẫn ảnh THÔ → URL tuyệt đối công khai (giống FE getImageSrc). "" nếu rỗng. */
export function toPublicImageUrl(path: string | null | undefined): string {
  const p = (path ?? "").trim();
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  const base = getPublicBaseUrl().replace(/\/+$/, "");
  const withSlash = p.startsWith("/") ? p : `/${p}`;
  if (withSlash.startsWith("/uploads/")) return `${base}${withSlash}`;
  if (withSlash.startsWith("/objects/") || withSlash.startsWith("/public-objects/")) {
    return `${base}/api/storage${withSlash}`;
  }
  return `${base}${withSlash}`;
}

// ─── PRIMARY CATEGORY (cửa chính) — KHÓA NHÓM LỚN THEO DANH MỤC GỐC ───────────
// Triết lý: "DANH MỤC LÀ XƯƠNG SỐNG, TAGS LÀ GIA VỊ". Album thuộc nhóm nào do CÂY
// DANH MỤC (đi tới GỐC) quyết định — KHÔNG đoán theo tag/tên album. Tag chỉ lọc gu
// SAU KHI đã khóa đúng danh mục, và TUYỆT ĐỐI không kéo album sang nhóm khác.
type GalleryRule = { pos: string[]; neg: string[] };

export type PrimaryGroup = "thoitrang" | "wedding" | "family";

// Dấu hiệu nhóm THỜI TRANG/Beauty trên đường dẫn danh mục (gồm cả các nhánh con quen thuộc).
const THOITRANG_MARKERS = [
  "thoi trang", "beauty", "beaty", "fashion", "ao dai",
  "sexy", "nang tho", "sang trong", "ngau", "cool", "ca tinh", "ca tanh",
  "ky yeu", "gym", "profile", "chan dung", "tet", "couple", "sinh nhat",
  "co trang", "bau", "me bau", "maternity", "mang thai",
];

/**
 * LUẬT 1 — Suy NHÓM LỚN từ ĐƯỜNG DẪN DANH MỤC (own + cha + … + gốc), ưu tiên
 * wedding > family > thoitrang (đặc trưng xét trước). Quét CẢ đường dẫn nên dù admin
 * LỒNG danh mục ở đâu (vd Gia đình nằm trong Thời trang) vẫn nhận đúng nhóm — KHÔNG
 * phải sửa code mỗi lần dời. null = chưa gắn danh mục / không thuộc nhóm ảnh nào →
 * KHÔNG được chọn cho nhóm cứng (thà thiếu còn hơn gửi sai nhóm).
 */
export function resolvePrimaryGroup(catId: number | null, byId: Map<number, CatRow>): PrimaryGroup | null {
  const path = catPath(catId, byId);
  if (!path) return null;
  if (hayHasAny(path, ["cuoi", "co dau", "chu re", "wedding"])) return "wedding";
  if (hayHasAny(path, ["gia dinh", "family", "ca nha"])) return "family";
  if (hayHasAny(path, THOITRANG_MARKERS)) return "thoitrang";
  return null;
}

// intent → nhóm lớn bắt buộc. rental_outfit (đồ thuê) & new_concept_idea (ý tưởng)
// dùng nguồn khác (dresses / photo_ideas) nên KHÔNG nằm ở bảng gallery này.
const INTENT_PRIMARY: Partial<Record<ServiceIntent, PrimaryGroup>> = {
  beauty: "thoitrang",
  maternity: "thoitrang",
  wedding_album: "wedding",
  wedding_gate: "wedding",
  wedding_party: "wedding",
  family: "family",
};
export function intentPrimaryGroup(intent: ServiceIntent): PrimaryGroup | null {
  return INTENT_PRIMARY[intent] ?? null;
}

// LUẬT 2 — Lọc NHÁNH CON bên trong nhóm lớn, CHẠY TRÊN ĐƯỜNG DẪN DANH MỤC (KHÔNG xét
// tag/tên). pos rỗng = chấp nhận mọi nhánh trong nhóm; pos có → phải khớp ≥1; neg → có 1 là loại.
const INTENT_SUBRULE: Partial<Record<ServiceIntent, GalleryRule>> = {
  beauty: { pos: [], neg: ["bau", "me bau", "maternity", "mang thai"] }, // thời trang nói chung, TRỪ bầu
  maternity: { pos: ["bau", "me bau", "maternity", "mang thai"], neg: [] },
  wedding_album: { pos: [], neg: [] }, // bất kỳ nhánh nào trong Ảnh Cưới
  wedding_gate: { pos: ["cong", "studio", "trong nha", "album"], neg: ["ngoai canh", "tiec", "phong su"] },
  wedding_party: { pos: ["tiec", "phong su", "dai tiec"], neg: [] },
  family: { pos: [], neg: [] },
};
/** catPath đã norm có thỏa nhánh con của intent không (gia vị cấp DANH MỤC). */
export function subcategoryAllows(intent: ServiceIntent, catPathNorm: string): boolean {
  const rule = INTENT_SUBRULE[intent];
  if (!rule) return true;
  if (rule.neg.length && hayHasAny(catPathNorm, rule.neg)) return false;
  if (rule.pos.length && !hayHasAny(catPathNorm, rule.pos)) return false;
  return true;
}

// ─── LUẬT 3 — TAGS = "gia vị": chỉ XẾP HẠNG trong nhóm ĐÃ KHÓA, KHÔNG bao giờ đổi nhóm ──
const TAG_STOPWORDS = new Set([
  "anh", "chi", "minh", "muon", "chup", "cho", "xem", "coi", "mau", "hinh", "duoc",
  "khong", "nha", "cai", "kieu", "mot", "vai", "gui", "the", "nay", "shop", "studio",
]);
function preferenceTokens(messageText: string): string[] {
  return norm(messageText).split(" ").filter((w) => w.length >= 3 && !TAG_STOPWORDS.has(w));
}
function tagScore(nameTagsNorm: string, tokens: string[]): number {
  let s = 0;
  for (const t of tokens) if (hayHas(nameTagsNorm, t)) s++;
  return s;
}

type GalleryRow = {
  id: number;
  name: string;
  slug: string | null;
  tags_text: string | null;
  category_id: number | null;
  cover_image_url: string | null;
  first_photo: string | null;
  sort_order: number | null; // ưu tiên: số NHỎ = được ghim lên đầu (bulk-priority)
};

type CatRow = { id: number; name: string; parent_id: number | null };

/** Đường dẫn tên danh mục (own + cha + gốc) cho 1 category_id, đã norm + nối space. */
function catPath(catId: number | null, byId: Map<number, CatRow>): string {
  const names: string[] = [];
  let cur = catId != null ? byId.get(catId) : undefined;
  let guard = 0;
  while (cur && guard++ < 8) {
    names.push(cur.name);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }
  return norm(names.join(" "));
}

async function resolveGallerySamples(
  intent: ServiceIntent,
  limit: number,
  excludeUrls: Set<string>,
  gender?: Gender | null,
  messageText = "",
): Promise<SampleImage[]> {
  const primary = intentPrimaryGroup(intent);
  if (!primary) return [];
  try {
    const [albumsRes, catsRes] = await Promise.all([
      pool.query(
        `SELECT a.id, a.name, a.slug, a.tags_text, a.category_id, a.cover_image_url, a.sort_order,
                gp.image_url AS first_photo
         FROM gallery_albums a
         LEFT JOIN LATERAL (
           SELECT image_url FROM gallery_photos
           WHERE album_id = a.id AND status = 'visible' AND deleted_at IS NULL
           ORDER BY sort_order, id LIMIT 1
         ) gp ON TRUE
         WHERE a.status = 'visible' AND a.deleted_at IS NULL
         ORDER BY a.sort_order, a.id`,
      ),
      pool.query(`SELECT id, name, parent_id FROM cms_categories WHERE type = 'gallery'`),
    ]);
    const byId = new Map<number, CatRow>(
      (catsRes.rows as CatRow[]).map((c) => [c.id, c]),
    );
    const base = getPublicBaseUrl().replace(/\/+$/, "");
    const tokens = preferenceTokens(messageText);

    type Scored = SampleImage & { score: number; sortOrder: number };
    const strict: Scored[] = [];  // đúng nhóm lớn + đúng nhánh con
    const relaxed: Scored[] = []; // đúng nhóm lớn nhưng nhánh con chưa khớp (dự phòng TRONG cùng nhóm)

    for (const a of albumsRes.rows as GalleryRow[]) {
      const imageUrl = (a.cover_image_url ?? a.first_photo ?? "").trim();
      if (!imageUrl) continue; // không có ảnh thật → bỏ (KHÔNG bịa)

      // LUẬT 1+5 — KHÓA NHÓM LỚN theo DANH MỤC GỐC. Sai nhóm (hoặc chưa gắn danh
      // mục) → LOẠI NGAY; tag/tên KHÔNG cứu được (chống nhảy nhóm).
      if (resolvePrimaryGroup(a.category_id, byId) !== primary) continue;

      const catP = catPath(a.category_id, byId);
      const nameTags = `${norm(a.name)} ${norm(a.tags_text)}`;

      // LỌC GIỚI TÍNH (chỉ beauty/cá nhân — cưới/bầu/gia đình là cặp đôi/gia đình).
      // Khách hỏi NAM → CHỈ mẫu nam (thà thiếu còn hơn sai giới); NỮ → loại mẫu nam.
      if (intent === "beauty" && gender) {
        const g = sampleGender(`${nameTags} ${catP}`);
        if (gender === "male" && g !== "male") continue;
        if (gender === "female" && g === "male") continue;
      }
      if (excludeUrls.has(imageUrl)) continue;

      const img: Scored = {
        title: (a.name ?? "").trim() || "Bộ ảnh mẫu",
        imageUrl,
        detailUrl: a.slug ? `${base}/bo-anh/${a.slug}` : undefined,
        sourceType: "gallery",
        serviceIntent: intent,
        score: tagScore(nameTags, tokens), // LUẬT 3 — tag chỉ XẾP HẠNG gu trong nhóm
        sortOrder: a.sort_order ?? 0,      // LUẬT 8 — ưu tiên: số NHỎ (được ghim) lên trước
      };

      // LUẬT 2 — nhánh con xét trên ĐƯỜNG DẪN DANH MỤC (KHÔNG xét tag/tên).
      // neg = nhánh SAI rõ ràng (vd hỏi cổng cưới mà gặp album ngoại cảnh) → LOẠI HẲN,
      // không dùng kể cả khi phải fallback. Chỉ album "thiếu pos" mới vào diện dự phòng.
      const sub = INTENT_SUBRULE[intent];
      if (sub?.neg.length && hayHasAny(catP, sub.neg)) continue;
      if (subcategoryAllows(intent, catP)) strict.push(img);
      else relaxed.push(img);
    }

    // Ưu tiên đúng nhánh con; nếu trống thì CHỈ nhóm cưới mới nới về cùng nhóm lớn
    // (vd "cổng cưới" chưa tách nhánh Studio → vẫn lấy album Ảnh Cưới, KHÔNG sang beauty).
    const picked = strict.length ? strict : primary === "wedding" ? relaxed : [];
    // Thứ tự gửi (LUẬT 1 + 8): khớp gu (tag) nhiều hơn TRƯỚC; cùng mức gu thì album
    // ƯU TIÊN/được ghim (sort_order nhỏ) lên trước; rồi tới album thường.
    picked.sort((x, y) => (y.score - x.score) || (x.sortOrder - y.sortOrder));
    return picked.slice(0, limit).map(({ score, sortOrder, ...s }) => s);
  } catch (err) {
    console.error("[Samples] gallery lỗi:", String(err).slice(0, 160));
    return [];
  }
}

// ─── Cho thuê đồ (dresses) ────────────────────────────────────────────────────
type DressSub = "ao_dai" | "vest" | "viet_phuc" | "vay";
function detectDressSub(messageText: string): DressSub {
  const m = norm(messageText);
  if (hayHasAny(m, ["ao dai"])) return "ao_dai";
  if (hayHasAny(m, ["vest", "chu re"])) return "vest";
  if (hayHasAny(m, ["viet phuc", "co phuc", "co trang", "yem", "ao tac", "co dien"])) return "viet_phuc";
  return "vay"; // mặc định: váy cưới / váy chụp
}
const DRESS_RULES: Record<DressSub, GalleryRule> = {
  vay: { pos: ["vay", "luxury", "xoe", "cong chua", "han", "duoi ca", "ngan", "vip"], neg: ["ao dai", "vest", "viet phuc", "yem", "co trang", "bikini", "test"] },
  ao_dai: { pos: ["ao dai"], neg: ["test"] },
  vest: { pos: ["vest", "chu re", "nam"], neg: ["test"] },
  viet_phuc: { pos: ["viet phuc", "co phuc", "co trang", "yem", "ao tac"], neg: ["test"] },
};

type DressRow = {
  id: number;
  code: string | null;
  name: string;
  category: string | null;
  category_id: number | null;
  style: string | null;
  outfit_tag: string | null;
  image_url: string | null;
  usage_count: number | null;
};

async function resolveRentalSamples(
  messageText: string,
  limit: number,
  excludeUrls: Set<string>,
  gender?: Gender | null,
): Promise<SampleImage[]> {
  try {
    const [dressRes, catsRes] = await Promise.all([
      pool.query(
        // LUẬT 8 — đồ được "Ưu tiên hiển thị" (is_priority) lên TRƯỚC, rồi mới tới đồ hay dùng.
        `SELECT id, code, name, category, category_id, style, outfit_tag, image_url, usage_count
         FROM dresses
         WHERE is_available = TRUE
           AND image_url IS NOT NULL AND length(trim(image_url)) > 0
         ORDER BY is_priority DESC NULLS LAST, priority_at DESC NULLS LAST, usage_count DESC, id`,
      ),
      pool.query(`SELECT id, name, parent_id FROM cms_categories WHERE type = 'dress'`),
    ]);
    const byId = new Map<number, CatRow>((catsRes.rows as CatRow[]).map((c) => [c.id, c]));
    const sub = detectDressSub(messageText);
    const rule = DRESS_RULES[sub];
    const base = getPublicBaseUrl().replace(/\/+$/, "");
    const detailUrl = `${base}/cho-thue-do`;
    const out: SampleImage[] = [];
    for (const d of dressRes.rows as DressRow[]) {
      if (out.length >= limit) break;
      const imageUrl = (d.image_url ?? "").trim();
      if (!imageUrl || excludeUrls.has(imageUrl)) continue;
      const hay = `${norm(d.name)} ${norm(d.category)} ${norm(d.style)} ${norm(d.outfit_tag)} ${norm(d.code)} ${catPath(d.category_id, byId)}`;
      // GIỚI TÍNH: khách hỏi đồ NAM → CHỈ đồ nam (bỏ qua luật sub váy nữ). Khách
      // hỏi NỮ → loại đồ nam rồi mới xét sub. Không rõ giới → theo sub như cũ.
      if (gender === "male") {
        if (sampleGender(hay) !== "male") continue;
      } else {
        if (gender === "female" && sampleGender(hay) === "male") continue;
        if (hayHasAny(hay, rule.neg)) continue;
        if (!hayHasAny(hay, rule.pos)) continue;
      }
      out.push({
        title: (d.name ?? "").trim() || "Trang phục",
        imageUrl,
        detailUrl,
        sourceType: "rental_item",
        serviceIntent: "rental_outfit",
      });
    }
    return out;
  } catch (err) {
    console.error("[Samples] rental lỗi:", String(err).slice(0, 160));
    return [];
  }
}

// ─── Ý tưởng chụp (photo_ideas) — concept tham khảo, KHÔNG có link công khai ───
type IdeaRow = {
  id: number;
  name: string;
  tags_text: string | null;
  category_id: number | null;
  img: string | null;
};

async function resolveIdeaSamples(
  messageText: string,
  limit: number,
  excludeUrls: Set<string>,
): Promise<SampleImage[]> {
  try {
    const [ideaRes, catsRes] = await Promise.all([
      pool.query(
        `SELECT id, name, tags_text, category_id,
                COALESCE(NULLIF(trim(public_image_url), ''), NULLIF(trim(image_url), ''), NULLIF(trim(cover_image_url), '')) AS img
         FROM photo_ideas
         WHERE deleted_at IS NULL
           AND (visibility_status = 'public' OR visibility_status IS NULL)
         ORDER BY sort_order, id`,
      ),
      pool.query(`SELECT id, name, parent_id FROM cms_categories WHERE type = 'idea'`),
    ]);
    const byId = new Map<number, CatRow>((catsRes.rows as CatRow[]).map((c) => [c.id, c]));
    // Nếu khách hé lộ gu (vd "cưới", "beauty", "sinh nhật") → ưu tiên concept khớp.
    const want = norm(messageText);
    const prefer: string[] = [];
    if (hayHasAny(want, ["cuoi", "co dau"])) prefer.push("cuoi");
    if (hayHasAny(want, ["beauty", "nang tho", "ca tinh", "ca nhan"])) prefer.push("beaty", "beauty", "nang tho");
    if (hayHasAny(want, ["sinh nhat"])) prefer.push("sinh nhat");
    if (hayHasAny(want, ["tiec"])) prefer.push("tiec");

    const all: Array<SampleImage & { score: number }> = [];
    for (const r of ideaRes.rows as IdeaRow[]) {
      const imageUrl = (r.img ?? "").trim();
      if (!imageUrl || excludeUrls.has(imageUrl)) continue;
      const hay = `${norm(r.name)} ${norm(r.tags_text)} ${catPath(r.category_id, byId)}`;
      const score = prefer.length ? (hayHasAny(hay, prefer) ? 1 : 0) : 0;
      all.push({
        title: (r.name ?? "").trim() || "Ý tưởng concept",
        imageUrl,
        sourceType: "photo_idea",
        serviceIntent: "new_concept_idea",
        score,
      });
    }
    all.sort((a, b) => b.score - a.score);
    return all.slice(0, limit).map(({ score, ...s }) => s);
  } catch (err) {
    console.error("[Samples] photo_ideas lỗi:", String(err).slice(0, 160));
    return [];
  }
}

// ─── Hàm chính ────────────────────────────────────────────────────────────────
export type ResolveSampleImagesOpts = {
  /** Danh sách intent muốn lấy mẫu (đã ưu tiên). */
  intents: ServiceIntent[];
  /** Tin khách (để dò sub-type đồ thuê / gu concept). */
  messageText?: string | null;
  /** Giới tính khách muốn (lọc beauty/đồ thuê — "cool boy" → male). null = không lọc. */
  gender?: Gender | null;
  /** Cấu hình Claude Sale — để tôn trọng công tắc Gửi ảnh mẫu. */
  settings?: ClaudeSaleSettings | null;
  /** Ảnh đã gửi gần đây (đường dẫn — thô hoặc public) → tránh gửi trùng. */
  excludeUrls?: string[];
  /** Tối đa tổng số ảnh trả về (mặc định 2 — KHÔNG spam). */
  maxTotal?: number;
};

/**
 * Lấy 1–2 ảnh mẫu THẬT đúng nhóm. Duyệt intent theo thứ tự, tôn trọng công tắc,
 * gom tối đa maxTotal ảnh, dedupe theo URL CÔNG KHAI (chuẩn hóa để khớp được cả
 * đường dẫn thô lẫn public đã lưu trong lịch sử). [] nếu không có ảnh phù hợp
 * (caller sẽ fallback sang text/link — KHÔNG bịa ảnh).
 */
export async function resolveSampleImages(opts: ResolveSampleImagesOpts): Promise<SampleImage[]> {
  const maxTotal = Math.max(1, Math.min(2, opts.maxTotal ?? 2));
  const messageText = opts.messageText ?? "";
  const gender = opts.gender ?? null;
  // Chuẩn hóa exclude về URL CÔNG KHAI (lịch sử lưu public url, còn ứng viên là
  // đường dẫn thô) → dedupe xuyên lượt mới hoạt động.
  const exclude = new Set<string>(
    (opts.excludeUrls ?? []).map((u) => toPublicImageUrl(u)).filter(Boolean),
  );
  // Dedupe intent giữ thứ tự + bỏ "unknown".
  const seenIntent = new Set<string>();
  const intents = opts.intents.filter((i) => i && i !== "unknown" && !seenIntent.has(i) && seenIntent.add(i));

  const out: SampleImage[] = [];
  const pushUnique = (imgs: SampleImage[]) => {
    for (const img of imgs) {
      if (out.length >= maxTotal) break;
      const key = toPublicImageUrl(img.imageUrl);
      if (!key || exclude.has(key)) continue;
      out.push(img);
      exclude.add(key);
    }
  };

  // resolveGallery/Rental/Idea tự dedupe nội bộ (truyền Set rỗng); việc loại ảnh ĐÃ GỬI
  // làm ở pushUnique theo public-url. QUAN TRỌNG: phải LẤY DƯ ứng viên (remaining + số đã gửi
  // + buffer) — nếu chỉ lấy `remaining` thì luôn nhận đúng mấy ảnh ĐẦU (= mấy ảnh đã gửi) →
  // pushUnique loại sạch → "gửi thêm" ra RỖNG dù nhóm còn nhiều album khác.
  for (const intent of intents) {
    if (out.length >= maxTotal) break;
    if (!imageToggleOn(intent, opts.settings)) continue;
    const remaining = maxTotal - out.length;
    const pool = remaining + exclude.size + 8; // lấy dư để bù phần bị loại trùng
    if (intent === "rental_outfit") {
      pushUnique(await resolveRentalSamples(messageText, pool, new Set(), gender));
    } else if (intent === "new_concept_idea") {
      pushUnique(await resolveIdeaSamples(messageText, pool, new Set()));
    } else {
      // gallery (beauty/wedding_*/maternity/family). gate/party rỗng → fallback wedding_album.
      let imgs = await resolveGallerySamples(intent, pool, new Set(), gender, messageText);
      if (imgs.length === 0 && (intent === "wedding_gate" || intent === "wedding_party")) {
        imgs = await resolveGallerySamples("wedding_album", pool, new Set(), gender, messageText);
        imgs = imgs.map((i) => ({ ...i, serviceIntent: intent }));
      }
      pushUnique(imgs);
    }
  }
  return out;
}

/** Gom detailUrl của các ảnh mẫu thành danh sách link "xem thêm" (dedupe theo url). */
export function buildSampleLinks(images: SampleImage[]): SampleLink[] {
  const seen = new Set<string>();
  const links: SampleLink[] = [];
  for (const img of images) {
    const url = (img.detailUrl ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = img.sourceType === "rental_item" ? "Xem thêm trang phục cho thuê" : "Xem thêm bộ đầy đủ";
    links.push({ title, url });
  }
  return links;
}

// ─── Entry-point dùng chung cho Test & Messenger ──────────────────────────────
export type SelectSampleImagesOpts = {
  /** Claude có chèn marker <<SAMPLE...>> lượt này không. */
  sampleRequested: boolean;
  /** Nhóm Claude ghi trong marker (chuỗi thô, có thể rỗng). */
  sampleIntents: string[];
  /** Tin nhắn khách lượt này. */
  messageText?: string | null;
  /** Ngữ cảnh hội thoại gần đây (vài tin gần nhất) — dùng để suy NHÓM ảnh khi tin lượt này không nêu nhóm. */
  contextText?: string | null;
  /** Tin nhắn GẦN NHẤT của bot (lượt trước) — để biết bot đã MỜI gửi mẫu chưa (xét "khách đồng ý"). */
  lastBotText?: string | null;
  /** Kết quả AI Vision (nếu khách gửi ảnh) — dùng để suy nhóm khi marker để trống. */
  visionIntent?: CustomerImageIntent | null;
  settings?: ClaudeSaleSettings | null;
  excludeUrls?: string[];
  maxTotal?: number;
};

// ── CHÍNH SÁCH GỬI ẢNH MẪU (deterministic — KHÔNG tự bung ảnh khi khách chỉ phân loại nhu cầu) ──
// (A) Khách CHỦ ĐỘNG đòi xem ảnh/mẫu. Cố tình KHÔNG khớp câu PHÂN LOẠI nhu cầu
//     ("chụp cổng", "album studio", "ngoại cảnh") hay hỏi dịch vụ ("có chụp ảnh cưới ko").
const EXPLICIT_IMAGE_REQUEST_RE =
  /(có|co|còn|con)\s*(ảnh|anh|hình|hinh|mẫu|mau|album|abum|bộ ảnh|bo anh)|(cho|gửi|gui|gởi|coi|xem)\b[^.!?\n]{0,14}(ảnh|anh|hình|hinh|mẫu|mau|album|abum|bộ ảnh|bo anh)|(mẫu|mau)\s*(nào|nao|đẹp|dep|xinh|ok)|(ảnh|anh|hình|hinh)\s*(bên|ben)\s*(mình|minh|em|studio)|(gửi|gui|cho|xem|coi)\s*(thêm|them)\b|(thêm|còn|con)\s*(mẫu|mau|ảnh|anh|hình|hinh|bộ|bo|album|abum)/i;

// Bot đã MỜI gửi mẫu ở lượt TRƯỚC chưa? (vd "anh muốn em gửi vài mẫu xem thử không ạ?")
const BOT_OFFERED_SAMPLES_RE =
  /(muốn|cần|có muốn)\s+em\s+(gửi|gui)|em\s+(gửi|gui)\b[^.!?\n]{0,30}(xem thử|xem qua|tham khảo|xem cho|xem nha)|(gửi|gui)\b[^.!?\n]{0,24}(mẫu|hình|ảnh|album)\b[^.!?\n]{0,16}(không|ko|hông|hong|nha|nhé|nhe)/i;

// (B) Khách ĐỒNG Ý sau khi bot mời — CHỈ tính consent khi BOT_OFFERED ở lượt trước.
// LƯU Ý: KHÔNG dùng \b ngay sau từ có dấu (dạ/có/ừ…) vì \b dựa trên \w ASCII, không
// nhận ký tự tiếng Việt → "dạ có" sẽ trượt. Dùng (\s|$|[,.!?…]) cho an toàn.
const AFFIRMATIVE_RE =
  /^\s*(ok|oke|okie|okê|oki|okla|dạ|da|vâng|vang|um|uh|uhm|uki|có|co|ừ|u|ờ|o)(\s|$|[,.!?…])|^\s*(gửi|gui)\b|gửi\s*(đi|nha|luôn|thử|cho|xem|hình|ảnh|mẫu|nhé|nhen)|cho\s*(xem|coi|gửi|em xem)|xem\s*(đi|thử|luôn|nha|qua)|coi\s*(thử|đi)|đồng ý|dong y|muốn xem|gửi thêm/i;

/** Câu nhắn khi khách đòi xem thêm nhưng đã xem hết mẫu CHÍNH của nhóm (req: không lặp ảnh cũ). */
export const SAMPLES_EXHAUSTED_NOTE =
  "Mấy mẫu chính em vừa gửi ở trên rồi á anh. Anh muốn em tư vấn theo phong cách nhẹ nhàng, hiện đại hay sang hơn không ạ?";

// Khách CHỦ ĐỘNG đòi xem NGUYÊN ALBUM / cả bộ → MỚI gửi link "xem thêm bộ đầy đủ".
// Đã gửi ảnh mẫu rồi thì KHÔNG kèm link nữa — gửi cả ảnh lẫn link trông quá "chỉn chu",
// dễ lộ là bot. Chỉ khi khách hỏi xem trọn bộ/album mới đưa link chi tiết.
const WANTS_FULL_ALBUM_RE =
  /(cả|ca|nguyên|nguyen|trọn|tron|toàn|toan|full)\s*(bộ|bo|album|abum)\b|(bộ|bo|album|abum)\s*(đầy đủ|day du|full|nguyên|nguyen|trọn|tron)|xem\s*(hết|het|trọn|tron|cả|ca|nguyên|nguyen|toàn|toan|nhiều|nhieu)|(xem|coi|gửi|gui|cho|có|co)\s*(link|album|abum)|link\s*(album|abum|bộ|bo)|còn\s*(ảnh|anh|hình|hinh)\s*(nào|nao|khác|khac|nữa|nua)|(nhiều|nhieu)\s*(ảnh|anh|hình|hinh)\s*(hơn|hon)/i;

/**
 * CHÍNH SÁCH GỬI ẢNH MẪU:
 *   • CỔNG GỬI: gửi ảnh khi (1) Claude ĐẶT marker <<SAMPLE>> (honor — text & ảnh khớp nhau),
 *     HOẶC (2) khách HỎI RÕ (EXPLICIT_IMAGE_REQUEST_RE), HOẶC (3) khách ĐỒNG Ý sau khi bot MỜI
 *     (BOT_OFFERED + AFFIRMATIVE). KHÔNG gửi chỉ vì serviceIntent đổi: đã bỏ auto-detect-from-text,
 *     và prompt cấm Claude đặt marker lúc phân loại nhu cầu → caller chỉ nhắn text.
 *   • NHÓM ảnh: marker <<SAMPLE: nhóm>> → Vision (≥45%) → text lượt này → ngữ cảnh gần đây.
 *   • Loại ảnh ĐÃ GỬI trong hội thoại (excludeUrls). Hết ảnh mới → exhausted=true để caller nhắn khéo.
 * Trả {images, links, resolvedIntents, exhausted}. images rỗng & !exhausted → khách chưa đòi xem ảnh.
 */
export async function selectSampleImages(opts: SelectSampleImagesOpts): Promise<{
  images: SampleImage[];
  links: SampleLink[];
  resolvedIntents: ServiceIntent[];
  exhausted: boolean;
}> {
  const empty = { images: [], links: [], resolvedIntents: [] as ServiceIntent[], exhausted: false };

  // ── CỔNG GỬI ───────────────────────────────────────────────────────────────
  // 1) HONOR marker <<SAMPLE>> của Claude: marker phản ánh ĐÚNG điều Claude vừa nói
  //    ("em gửi mẫu nha") → có marker thì PHẢI gửi để TEXT & ẢNH KHỚP nhau (tránh
  //    cảnh "em gửi mẫu" mà không có ảnh → lộ bot). Claude bắt "đồng ý" của khách
  //    ("à mún chứ", "uki"…) tốt hơn regex. Chống spam lúc phân loại: prompt CẤM Claude
  //    đặt marker khi khách mới nói loại dịch vụ + backend đã BỎ auto-detect-from-text.
  // 2) explicitRequest / consent: lưới an toàn khi Claude QUÊN đặt marker.
  const msg = (opts.messageText ?? "").trim();
  const explicitRequest = EXPLICIT_IMAGE_REQUEST_RE.test(msg);
  const consent =
    !!opts.lastBotText &&
    BOT_OFFERED_SAMPLES_RE.test(opts.lastBotText) &&
    AFFIRMATIVE_RE.test(msg);
  if (!opts.sampleRequested && !explicitRequest && !consent) return empty; // chỉ phân loại nhu cầu → CHỈ text

  // 1) Nhóm ghi rõ trong marker.
  const explicit: ServiceIntent[] = [];
  for (const raw of opts.sampleIntents ?? []) {
    const it = normalizeIntent(raw);
    if (it && !explicit.includes(it)) explicit.push(it);
  }

  // Giới tính: ưu tiên tin lượt này, sau đó ngữ cảnh, cuối cùng ảnh Vision (mô tả).
  const gender =
    detectGender(msg) ??
    detectGender(opts.contextText ?? "") ??
    detectGender(`${opts.visionIntent?.image_type ?? ""} ${opts.visionIntent?.visual_description ?? ""} ${opts.visionIntent?.outfit ?? ""}`);

  let intents: ServiceIntent[] = explicit;
  if (intents.length === 0) {
    // 2) Suy nhóm: ảnh khách gửi (Vision ≥45%) → tin lượt này → ngữ cảnh gần đây.
    const v = opts.visionIntent;
    let detected: ServiceIntent = "unknown";
    if (v && v.service_intent !== "unknown" && (v.confidence ?? 0) >= 0.45) {
      detected = v.service_intent;
    } else {
      detected = detectServiceIntentFromText(msg);
      if (detected === "unknown" && opts.contextText) {
        detected = detectServiceIntentFromText(opts.contextText);
      }
    }
    if (detected !== "unknown") intents = [detected];
  }

  if (intents.length === 0) return empty; // đã muốn xem nhưng chưa rõ nhóm → để text hỏi tiếp

  const images = await resolveSampleImages({
    intents,
    messageText: msg,
    gender,
    settings: opts.settings,
    excludeUrls: opts.excludeUrls,
    maxTotal: opts.maxTotal ?? 2,
  });

  // Đã loại trùng mà KHÔNG còn ảnh MỚI nào (nhóm này từng gửi rồi) → báo caller nhắn khéo.
  const exhausted = images.length === 0 && (opts.excludeUrls?.length ?? 0) > 0;

  // Đã có ảnh → mặc định KHÔNG kèm link; chỉ gửi link khi khách đòi nguyên album/cả bộ.
  const wantsFullAlbum = WANTS_FULL_ALBUM_RE.test(msg);
  return {
    images,
    links: wantsFullAlbum ? buildSampleLinks(images) : [],
    resolvedIntents: intents,
    exhausted,
  };
}

/**
 * Lấy các URL ảnh mẫu đã gửi trong lịch sử (để KHÔNG gửi trùng trong CÙNG cuộc chat).
 * limit lớn (quét gần như cả lịch sử caller đưa vào) — limit nhỏ (vd 8) sẽ làm ảnh gửi
 * sớm rớt khỏi cửa sổ → dedupe HỎNG ở hội thoại dài. Lịch sử đã được caller giới hạn sẵn.
 */
export function extractRecentSampleUrls(
  history: Array<{ direction: "incoming" | "outgoing"; message: string }>,
  limit = 200,
): string[] {
  const urls: string[] = [];
  for (const h of history.slice(-limit)) {
    if (h.direction !== "outgoing") continue;
    const m = (h.message ?? "").match(/^\s*\[image:(.+?)\]\s*$/);
    if (m && m[1]) urls.push(m[1].trim());
  }
  return urls;
}
