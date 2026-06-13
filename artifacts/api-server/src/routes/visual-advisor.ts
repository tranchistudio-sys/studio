import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { verifyViewToken, getIdeasPasswordConfig } from "./photo-ideas";
import { isLlmConfigured } from "../lib/studio-copilot";
import { callChat } from "../lib/ai-orchestrator";

/**
 * AI Visual Advisor — tư vấn hình ảnh cho toàn website public.
 *
 * Nguyên tắc chống bịa:
 * - AI chỉ được CHỌN (source, id) từ catalog dữ liệu thật server đưa cho.
 * - Server validate lại từng (source, id); title/ảnh/link luôn tra từ DB.
 * - Ý tưởng chụp ảnh chỉ đưa vào catalog khi khách có ideasToken hợp lệ
 *   (hoặc đã tắt bảo vệ mật khẩu). Chưa có token → chỉ báo "vào mục Ý tưởng
 *   chụp ảnh và nhập mật khẩu", kèm link /y-tuong-chup-anh, không lộ chi tiết.
 * - LLM lỗi / thiếu key → fallback keyword match trên name/tags/danh mục.
 *
 * Phạm vi nguồn (sourceScope):
 * - Client gửi sourceScope = "current" | "all" + currentSource (module đang xem).
 * - "current" → catalog CHỈ gồm nguồn của module đó (dress | album | idea | service).
 * - "all" (hoặc thiếu currentSource) → hợp nhất toàn bộ nguồn của studio.
 */

const router: IRouter = Router();

const IDEAS_LINK = "/y-tuong-chup-anh";
const PRICING_LINK = "/bang-gia";
const MAX_RESULTS = 6;

type SourceType = "dress" | "album" | "idea" | "service";

const ALL_SOURCES: SourceType[] = ["dress", "album", "idea", "service"];

const SOURCE_VI: Record<SourceType, string> = {
  dress: "Cho thuê đồ",
  album: "Bộ ảnh mẫu",
  idea: "Ý tưởng chụp ảnh",
  service: "Gói dịch vụ",
};

interface CatalogItem {
  source: SourceType;
  id: number;
  title: string;
  imageUrl: string | null;
  link: string;
  tags: string[];
  status: string | null; // dress: rental_status | idea: execution_status | album: null
  haystack: string; // normalized text dùng cho keyword match
}

// ─── Chuẩn hoá tiếng Việt ────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitTags(tagsText: unknown): string[] {
  if (typeof tagsText !== "string" || !tagsText.trim()) return [];
  return tagsText.split(",").map(t => t.trim()).filter(Boolean);
}

// ─── Load catalog từ DB (chỉ dữ liệu public/visible) ─────────────────────────

async function loadDresses(): Promise<CatalogItem[]> {
  const r = await pool.query(
    `SELECT id, name, code, slug, tags_text, color_text, color, category, rental_status,
            COALESCE(cover_image_url, public_image_url, image_url) AS img
       FROM dresses
      WHERE deleted_at IS NULL AND is_public = 1 AND cms_status = 'visible'
      ORDER BY is_priority DESC, created_at DESC`
  );
  return (r.rows as Array<Record<string, unknown>>).map(d => {
    const tags = splitTags(d.tags_text);
    const title = String(d.name || d.code || "Sản phẩm");
    return {
      source: "dress" as const,
      id: Number(d.id),
      title,
      imageUrl: (d.img as string | null) ?? null,
      link: d.slug ? `/san-pham/${d.slug}` : "/cho-thue-do",
      tags,
      status: (d.rental_status as string | null) ?? null,
      haystack: normalize(
        [title, d.code, d.tags_text, d.color_text, d.color, d.category, "vay dam trang phuc thue do"].filter(Boolean).join(" ")
      ),
    };
  });
}

async function loadAlbums(): Promise<CatalogItem[]> {
  const r = await pool.query(
    `SELECT a.id, a.name, a.tags_text,
            COALESCE(NULLIF(a.slug, ''), 'al-' || a.id) AS slug,
            c.name AS category_name,
            pc.name AS parent_category_name,
            COALESCE(
              a.cover_image_url,
              (SELECT p.image_url FROM gallery_photos p
                WHERE p.album_id = a.id AND p.deleted_at IS NULL
                  AND p.status = 'visible'
                  AND (p.mime_type IS NULL OR p.mime_type LIKE 'image/%')
                ORDER BY p.sort_order ASC, p.id ASC LIMIT 1)
            ) AS img
       FROM gallery_albums a
       LEFT JOIN cms_categories c  ON c.id = a.category_id AND c.deleted_at IS NULL
       LEFT JOIN cms_categories pc ON pc.id = c.parent_id  AND pc.deleted_at IS NULL
      WHERE a.deleted_at IS NULL AND a.status = 'visible'
      ORDER BY a.sort_order ASC, a.id DESC`
  );
  return (r.rows as Array<Record<string, unknown>>).map(a => {
    const tags = splitTags(a.tags_text);
    const cat = [a.parent_category_name, a.category_name].filter(Boolean).join(" / ");
    return {
      source: "album" as const,
      id: Number(a.id),
      title: String(a.name || "Album"),
      imageUrl: (a.img as string | null) ?? null,
      link: `/bo-anh/${a.slug}`,
      tags: cat ? [...tags, cat] : tags,
      status: null,
      haystack: normalize(
        [a.name, a.tags_text, a.category_name, a.parent_category_name, "bo anh mau anh album chup anh"].filter(Boolean).join(" ")
      ),
    };
  });
}

async function loadIdeas(): Promise<CatalogItem[]> {
  const r = await pool.query(
    `SELECT i.id, i.name, i.tags_text, i.description, i.execution_status, i.extra_images,
            COALESCE(i.cover_image_url, i.public_image_url, i.image_url) AS img,
            c.name AS category_name
       FROM photo_ideas i
       LEFT JOIN cms_categories c ON c.id = i.category_id AND c.deleted_at IS NULL
      WHERE i.deleted_at IS NULL AND i.visibility_status = 'public'
      ORDER BY i.sort_order ASC, i.created_at DESC`
  );
  return (r.rows as Array<Record<string, unknown>>).map(i => {
    let img = (i.img as string | null) ?? null;
    if (!img && i.extra_images) {
      try {
        const extras = JSON.parse(i.extra_images as string);
        if (Array.isArray(extras) && extras[0]) img = String(extras[0]);
      } catch { /* ignore */ }
    }
    return {
      source: "idea" as const,
      id: Number(i.id),
      title: String(i.name || "Ý tưởng"),
      imageUrl: img,
      link: IDEAS_LINK,
      tags: splitTags(i.tags_text),
      status: (i.execution_status as string | null) ?? "available",
      haystack: normalize(
        [i.name, i.tags_text, i.description, i.category_name, "y tuong concept moi la chup anh"].filter(Boolean).join(" ")
      ),
    };
  });
}

function formatPrice(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${new Intl.NumberFormat("vi-VN").format(n)}đ`;
}

/** products là JSON tự do (mảng string hoặc object) — chỉ rút tên để làm haystack. */
function extractProductNames(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(p => typeof p === "string" ? p : (p && typeof p === "object" ? String((p as Record<string, unknown>).name ?? (p as Record<string, unknown>).title ?? "") : ""))
      .filter(Boolean);
  } catch { return []; }
}

async function loadServices(): Promise<CatalogItem[]> {
  const r = await pool.query(
    `SELECT p.id, p.code, p.name, p.price, p.short_description, p.description, p.products,
            g.name AS group_name
       FROM service_packages p
       LEFT JOIN service_groups g ON g.id = p.group_id
      WHERE p.deleted_at IS NULL AND p.is_public = 1 AND p.cms_status = 'visible'
      ORDER BY g.sort_order ASC NULLS LAST, p.sort_order ASC`
  );
  return (r.rows as Array<Record<string, unknown>>).map(p => {
    const title = String(p.name || p.code || "Gói dịch vụ");
    const price = formatPrice(p.price);
    const products = extractProductNames(p.products);
    const tags = [p.group_name ? String(p.group_name) : null, price].filter((t): t is string => !!t);
    return {
      source: "service" as const,
      id: Number(p.id),
      title,
      imageUrl: null,
      link: PRICING_LINK,
      tags,
      status: null,
      haystack: normalize(
        [title, p.code, p.short_description, p.description, p.group_name, products.join(" "),
         "goi dich vu bang gia chup anh combo"].filter(Boolean).join(" ")
      ),
    };
  });
}

// ─── Fallback: keyword match ─────────────────────────────────────────────────

// Nhóm đồng nghĩa (đã bỏ dấu). Match theo ranh giới từ để tránh nhầm
// ("cong" không được match vào "sang trong").
const SYNONYM_GROUPS: string[][] = [
  ["sexy", "quyen ru", "goi cam"],
  ["kin dao"],
  ["nang tho"],
  ["sang trong"],
  ["tieu thu"],
  ["co dien", "vintage"],
  ["hien dai"],
  ["cong chua"],
  ["cuoi", "wedding"],
  ["beauty"],
  ["ao dai", "viet phuc", "truyen thong"],
  ["bau", "maternity"],
  ["sinh nhat", "birthday"],
  ["han quoc", "korea"],
  ["studio", "phong"],
  ["ngoai canh"],
  ["phong xam"],
  ["duoi ca"],
  ["di ban", "di tiec", "tiec"],
  ["don gian", "toi gian", "minimal"],
  ["cao cap", "luxury"],
  ["cong cuoi"],
  ["fashion", "thoi trang"],
];

const STOPWORDS = new Set([
  "co", "khong", "cho", "em", "anh", "minh", "toi", "thich", "muon", "la",
  "va", "hay", "nao", "gi", "xem", "tim", "can", "kieu", "dang", "mau",
  "hon", "nhat", "dep", "ben", "ban", "khach", "voi", "cua", "mot", "vai",
  "nhung", "the", "thi", "duoc", "nhe", "a", "o", "di",
]);

function hasPhrase(normalizedText: string, phrase: string): boolean {
  return ` ${normalizedText} `.includes(` ${phrase} `);
}

/** Nguồn nào được nhắc tới trong câu hỏi → cộng điểm ưu tiên nguồn đó. */
function detectSourceIntents(q: string): Set<SourceType> {
  const intents = new Set<SourceType>();
  if (["vay", "dam", "thue do", "trang phuc", "outfit"].some(p => hasPhrase(q, p))) intents.add("dress");
  if (["mau anh", "bo anh", "album", "chup", "anh mau"].some(p => hasPhrase(q, p))) intents.add("album");
  if (["y tuong", "concept", "moi", "la", "doc dao"].some(p => hasPhrase(q, p))) intents.add("idea");
  if (["goi chup", "dich vu", "bang gia", "goi dich vu", "combo", "tron goi", "bao nhieu tien", "gia bao nhieu"].some(p => hasPhrase(q, p))) intents.add("service");
  return intents;
}

function keywordMatch(query: string, catalog: CatalogItem[]): CatalogItem[] {
  const q = normalize(query);
  if (!q) return [];
  const groups = SYNONYM_GROUPS.filter(g => g.some(p => hasPhrase(q, p)));
  const tokens = q.split(" ").filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const intents = detectSourceIntents(q);

  const scored = catalog.map(item => {
    let score = 0;
    for (const g of groups) {
      if (g.some(p => hasPhrase(item.haystack, p))) score += 2;
    }
    for (const t of tokens) {
      if (hasPhrase(item.haystack, t)) score += 1;
    }
    if (score > 0 && intents.has(item.source)) score += 1.5;
    return { item, score };
  });

  return scored
    .filter(x => x.score > 0)
    .sort((a, b) =>
      // Ưu tiên kết quả có ảnh, rồi tới điểm cao
      Number(!!b.item.imageUrl) - Number(!!a.item.imageUrl) || b.score - a.score
    )
    .slice(0, MAX_RESULTS)
    .map(x => x.item);
}

// ─── LLM: chỉ chọn (source, id) từ catalog ───────────────────────────────────

interface LlmResult {
  answer: string;
  picks: Array<{ source: SourceType; id: number }>;
}

function catalogLine(it: CatalogItem): string {
  const parts = [`${it.source}#${it.id}`, it.title];
  if (it.tags.length) parts.push(`tags: ${it.tags.join(", ")}`);
  if (it.status) parts.push(`trạng thái: ${it.status}`);
  // Gói dịch vụ vốn không có ảnh — không đánh dấu để LLM khỏi né
  if (!it.imageUrl && it.source !== "service") parts.push("(chưa có ảnh)");
  return parts.join(" | ");
}

async function askLlm(query: string, catalog: CatalogItem[], scopeNote: string): Promise<LlmResult | null> {
  const list = catalog.map(catalogLine).join("\n");
  const system = `Bạn là trợ lý tư vấn hình ảnh của Amazing Studio (studio chụp ảnh cưới & cho thuê trang phục).
Dưới đây là DANH SÁCH DỮ LIỆU CÓ THẬT (mỗi dòng: nguồn#id | tên | tags | trạng thái):
- dress = sản phẩm cho thuê đồ, album = bộ ảnh mẫu theo dịch vụ, idea = ý tưởng/concept chụp ảnh, service = gói dịch vụ chụp ảnh (tags có kèm giá).
${scopeNote}
${list || "(danh sách trống)"}

QUY TẮC BẮT BUỘC:
1. Chỉ được chọn id có trong danh sách trên. TUYỆT ĐỐI không bịa tên, ảnh, link hay sản phẩm không tồn tại.
2. Chọn tối đa ${MAX_RESULTS} kết quả phù hợp nhất với mong muốn của khách; ưu tiên kết quả không ghi "(chưa có ảnh)".
3. Nếu không có gì phù hợp: picks để mảng rỗng và answer nói thật là studio chưa có mẫu này, mời khách liên hệ để được tư vấn thêm.
4. answer: tiếng Việt, giọng nhân viên Hoa thân thiện (xưng "em"), 1–3 câu ngắn, không hứa hẹn gì ngoài danh sách.
5. Trả về DUY NHẤT một JSON object đúng định dạng: {"answer": "...", "picks": [{"source": "dress", "id": 1}]}`;

  // Qua TỔNG ĐÀI: Claude (chính) → OpenAI (dự phòng). jsonMode ép trả JSON hợp lệ.
  // Tone theo `system` ở trên; server vẫn validate lại từng (source,id) để chống bịa.
  const result = await callChat({
    system,
    messages: [{ role: "user", content: query }],
    maxTokens: 1024,
    jsonMode: true,
    label: "website-advisor",
  });
  if (!result.ok) return null; // hết provider → caller tự fallback keyword match

  const raw = result.text;
  const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const parsed = JSON.parse(jsonText.slice(start, end + 1)) as Partial<LlmResult>;
  if (typeof parsed.answer !== "string" || !Array.isArray(parsed.picks)) return null;
  return {
    answer: parsed.answer.trim(),
    picks: parsed.picks
      .filter((p): p is { source: SourceType; id: number } =>
        !!p && ALL_SOURCES.includes((p as { source: SourceType }).source) &&
        Number.isInteger(Number(p.id)))
      .map(p => ({ source: p.source, id: Number(p.id) })),
  };
}

// ─── Rate limit nhẹ theo IP ──────────────────────────────────────────────────

const rateMap = new Map<string, number>();
const RATE_MS = 2000;

function checkRate(ip: string): boolean {
  const now = Date.now();
  const last = rateMap.get(ip) ?? 0;
  if (now - last < RATE_MS) return false;
  rateMap.set(ip, now);
  if (rateMap.size > 5000) rateMap.clear();
  return true;
}

// ─── Endpoint ────────────────────────────────────────────────────────────────

const IDEAS_LOCKED_MSG =
  "Studio có một số ý tưởng phù hợp, bạn vào mục Ý tưởng chụp ảnh và nhập mật khẩu để xem chi tiết.";

function toResponseItem(it: CatalogItem) {
  return {
    sourceType: it.source,
    id: it.id,
    title: it.title,
    imageUrl: it.imageUrl,
    link: it.link,
    tags: it.tags,
    status: it.status,
  };
}

router.post("/cms/public/visual-advisor", async (req, res) => {
  try {
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();
    if (!checkRate(ip)) {
      return res.status(429).json({ error: "Bạn hỏi hơi nhanh, chờ vài giây nhé." });
    }

    const { query, ideasToken, sourceScope, currentSource } = (req.body ?? {}) as {
      query?: unknown; ideasToken?: unknown; sourceScope?: unknown; currentSource?: unknown;
    };
    const q = typeof query === "string" ? query.trim() : "";
    if (!q || q.length > 500) {
      return res.status(400).json({ error: "Vui lòng nhập câu hỏi (tối đa 500 ký tự)." });
    }

    // Phạm vi nguồn: "current" chỉ hợp lệ khi biết module đang xem; còn lại → all
    const curSource: SourceType | null =
      ALL_SOURCES.includes(currentSource as SourceType) ? (currentSource as SourceType) : null;
    const scope: "current" | "all" = sourceScope === "current" && curSource ? "current" : "all";
    const activeSources: SourceType[] = scope === "current" && curSource ? [curSource] : ALL_SOURCES;
    const inScope = (s: SourceType) => activeSources.includes(s);

    // Ý tưởng chỉ mở khi đã tắt bảo vệ hoặc token hợp lệ
    const ideasCfg = await getIdeasPasswordConfig();
    const ideasUnlocked = !ideasCfg.enabled ||
      (typeof ideasToken === "string" && verifyViewToken(ideasToken));

    // Chỉ load những nguồn trong phạm vi
    const [dresses, albums, ideas, services] = await Promise.all([
      inScope("dress") ? loadDresses() : Promise.resolve([]),
      inScope("album") ? loadAlbums() : Promise.resolve([]),
      inScope("idea") ? loadIdeas() : Promise.resolve([]),
      inScope("service") ? loadServices() : Promise.resolve([]),
    ]);
    const openCatalog = [
      ...dresses, ...albums, ...(ideasUnlocked ? ideas : []), ...services,
    ];
    const byKey = new Map(openCatalog.map(it => [`${it.source}:${it.id}`, it]));

    // Ý tưởng đang khoá nhưng có match → chỉ báo chung chung, không lộ chi tiết
    const ideasLocked = inScope("idea") && !ideasUnlocked && keywordMatch(q, ideas).length > 0;

    let answer = "";
    let items: CatalogItem[] = [];
    let via: "ai" | "keyword" = "keyword";

    if (isLlmConfigured()) {
      try {
        const scopeNote = scope === "current" && curSource
          ? `Khách đang xem mục "${SOURCE_VI[curSource]}" nên danh sách dưới đây CHỈ gồm dữ liệu của mục này.`
          : "Danh sách dưới đây gồm dữ liệu của toàn bộ studio.";
        const llm = await askLlm(q, openCatalog, scopeNote);
        if (llm) {
          via = "ai";
          answer = llm.answer;
          const seen = new Set<string>();
          for (const p of llm.picks) {
            const key = `${p.source}:${p.id}`;
            const found = byKey.get(key); // validate: id lạ bị loại
            if (found && !seen.has(key)) { seen.add(key); items.push(found); }
            if (items.length >= MAX_RESULTS) break;
          }
        }
      } catch (e) {
        console.error("visual-advisor LLM error, falling back to keyword:", e);
      }
    }

    if (via === "keyword" || (!items.length && !answer)) {
      via = via === "ai" ? via : "keyword";
      items = keywordMatch(q, openCatalog);
      answer = items.length
        ? "Dưới đây là một số gợi ý phù hợp với mong muốn của bạn:"
        : scope === "current" && curSource
          ? `Trong mục ${SOURCE_VI[curSource]} hiện chưa có mẫu đúng như bạn mô tả. Bạn bật “Toàn studio” để tìm khắp các mục, hoặc liên hệ trực tiếp để được tư vấn thêm nhé!`
          : "Hiện studio chưa có mẫu đúng như bạn mô tả. Bạn liên hệ trực tiếp để được tư vấn thêm nhé!";
    }

    // Ưu tiên kết quả có ảnh
    items = [...items].sort((a, b) => Number(!!b.imageUrl) - Number(!!a.imageUrl)).slice(0, MAX_RESULTS);

    if (ideasLocked) {
      // Không có kết quả mở nào khác → chỉ nói câu mời nhập mật khẩu, tránh
      // ghép "chưa có mẫu" + "có ý tưởng phù hợp" mâu thuẫn nhau.
      answer = items.length ? `${answer} ${IDEAS_LOCKED_MSG}` : IDEAS_LOCKED_MSG;
    }

    return res.json({
      answer,
      items: items.map(toResponseItem),
      ideasLocked,
      ideasLink: IDEAS_LINK,
      via,
      sourceScope: scope,
      currentSource: curSource,
    });
  } catch (e) {
    console.error("POST /cms/public/visual-advisor error:", e);
    return res.status(500).json({ error: "Lỗi hệ thống, vui lòng thử lại sau." });
  }
});

// ─── Meta: bộ tiêu chí gợi ý (Size / Số đo / Màu / Kiểu) từ dữ liệu váy thật ──

interface AdvisorFilters {
  sizes: string[];
  weights: string[];
  colors: string[];
  styles: string[];
}

function splitCsvCell(v: unknown): string[] {
  if (typeof v !== "string" || !v.trim()) return [];
  return v.split(",").map(s => s.trim()).filter(Boolean);
}

const isWeightToken = (s: string) => /kg\s*$/i.test(s);
const weightSortKey = (s: string) => { const m = s.match(/(\d+)/); return m ? parseInt(m[1], 10) : 0; };

let filtersCache: { data: AdvisorFilters; at: number } | null = null;
const FILTERS_TTL_MS = 60_000;

async function loadAdvisorFilters(): Promise<AdvisorFilters> {
  if (filtersCache && Date.now() - filtersCache.at < FILTERS_TTL_MS) return filtersCache.data;
  const r = await pool.query(
    `SELECT size_text, size, color_text, color, tags_text
       FROM dresses
      WHERE deleted_at IS NULL AND is_public = 1 AND cms_status = 'visible'`
  );
  const sizes = new Set<string>();
  const weights = new Set<string>();
  const colors = new Set<string>();
  const styles = new Set<string>();
  for (const row of r.rows as Array<Record<string, unknown>>) {
    for (const t of splitCsvCell(row.size_text || row.size)) (isWeightToken(t) ? weights : sizes).add(t);
    for (const c of splitCsvCell(row.color_text || row.color)) colors.add(c);
    for (const s of splitCsvCell(row.tags_text)) styles.add(s);
  }
  const data: AdvisorFilters = {
    sizes: [...sizes].sort(),
    weights: [...weights].sort((a, b) => weightSortKey(a) - weightSortKey(b)),
    colors: [...colors].sort(),
    styles: [...styles].sort(),
  };
  filtersCache = { data, at: Date.now() };
  return data;
}

router.get("/cms/public/visual-advisor/meta", async (_req, res) => {
  try {
    res.json({ filters: await loadAdvisorFilters() });
  } catch (e) {
    console.error("GET /cms/public/visual-advisor/meta error:", e);
    res.status(500).json({ error: "Lỗi hệ thống, vui lòng thử lại sau." });
  }
});

export default router;
