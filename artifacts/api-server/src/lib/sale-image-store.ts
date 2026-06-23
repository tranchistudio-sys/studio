import { pool } from "@workspace/db";
import { getPublicBaseUrl } from "./publicUrl";
import { type SampleSourceType, detectServiceIntentFromText } from "./sale-samples";
import { detectTones, intentFamily } from "./sale-image-overrides";

/**
 * sale-image-store.ts — KHO ẢNH cho admin chọn ảnh đúng khi "dạy Lulu".
 *
 * Gom ảnh THẬT của studio từ nhiều nguồn (kind):
 *   - "album"  → bộ ảnh / album (gallery_albums + ảnh trong album)
 *   - "rental" → trang phục cho thuê (dresses)
 *   - "idea"   → ý tưởng chụp ảnh (photo_ideas)
 *   - "price"  → ẢNH BẢNG GIÁ trong "Dịch vụ & Bảng giá" (service_groups.ai_image_url)
 *
 * Bộ lọc: dịch vụ/intent, tone/gu (MỀM — không khớp tone vẫn hiện ảnh cùng dịch vụ),
 * tên bộ, tag, từ khóa, albumId (xem ảnh trong 1 album). Trả thêm `debug` để admin biết
 * VÌ SAO rỗng (không có dữ liệu / thiếu URL / lọc quá hẹp / API lỗi).
 *
 * AN TOÀN: CHỈ ĐỌC DB, KHÔNG bao giờ throw (lỗi mỗi nguồn → ghi vào debug, vẫn trả nguồn khác).
 */

export type ImageKind = "album" | "rental" | "idea" | "price";

export type ImageStoreItem = {
  imageUrl: string;          // đường dẫn THÔ (FE dùng getImageSrc; Messenger dùng toPublicImageUrl)
  title: string;
  detailUrl?: string;
  sourceType: SampleSourceType;
  kind: ImageKind;
  serviceIntent: string;     // intent suy ra (để hiển thị nhãn + lọc)
  albumName?: string;
  tags?: string;
  albumId?: number;          // chỉ với ảnh trong album → cho phép drill-down tiếp
  publicForCustomer?: boolean; // chỉ với ảnh bảng giá: false = đang ẩn với khách
};

export type ImageStoreDebugReason =
  | "ok" | "tone_relaxed" | "no_rows_in_db" | "all_missing_url" | "filter_too_narrow" | "api_error";

export type ImageStoreDebug = {
  reason: ImageStoreDebugReason;
  message: string;
  /** Số dòng thô lấy được mỗi nguồn (trước khi lọc). */
  sourceCounts: Record<ImageKind, number>;
  /** Số ảnh có URL dùng được (sau khi bỏ ảnh thiếu URL). */
  withImageCount: number;
  /** Số mục bị bỏ vì THIẾU URL ảnh. */
  missingUrlCount: number;
  /** Còn lại sau khi lọc intent/tên/tag/từ khóa (CHƯA áp tone). */
  afterFilterBeforeTone: number;
  /** Còn lại sau khi áp THÊM tone. */
  afterToneFilter: number;
  /** true nếu đã NỚI tone (tone không có ảnh → hiện ảnh cùng dịch vụ). */
  toneRelaxed: boolean;
  errors: string[];
};

export type BrowseImageStoreOpts = {
  intent?: string | null;
  tone?: string | null;
  album?: string | null;
  tag?: string | null;
  q?: string | null;
  albumId?: number | null;
  /** Lọc theo loại nguồn (mặc định tất cả). */
  kinds?: ImageKind[];
  limit?: number;
};

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "d")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

// intentFamily dùng chung từ sale-image-overrides (gom họ cưới: gate/album/party).

type CatRow = { id: number; name: string; parent_id: number | null };
function catPath(catId: number | null, byId: Map<number, CatRow>): string {
  const names: string[] = [];
  let cur = catId != null ? byId.get(catId) : undefined;
  let guard = 0;
  while (cur && guard++ < 8) { names.push(cur.name); cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined; }
  return names.join(" ");
}

type SourceResult = { items: ImageStoreItem[]; raw: number; missing: number; error: string | null };

// ─── Lấy ảnh BÊN TRONG 1 album (drill-down) ───────────────────────────────────
async function browseAlbumPhotos(albumId: number, limit: number): Promise<SourceResult> {
  try {
    const [aRes, pRes] = await Promise.all([
      pool.query(`SELECT id, name, slug, tags_text FROM gallery_albums WHERE id = $1`, [albumId]),
      pool.query(
        `SELECT id, image_url FROM gallery_photos
          WHERE album_id = $1 AND status = 'visible' AND deleted_at IS NULL
          ORDER BY sort_order, id LIMIT $2`,
        [albumId, Math.min(120, limit)],
      ),
    ]);
    const album = aRes.rows[0] as { name?: string; slug?: string; tags_text?: string } | undefined;
    if (!album) return { items: [], raw: 0, missing: 0, error: null };
    const base = getPublicBaseUrl().replace(/\/+$/, "");
    const tags = (album.tags_text ?? "").trim();
    const intent = detectServiceIntentFromText(`${album.name ?? ""} ${tags}`);
    const rows = pRes.rows as Array<{ id: number; image_url: string }>;
    let missing = 0;
    const items: ImageStoreItem[] = [];
    rows.forEach((p, i) => {
      const imageUrl = (p.image_url ?? "").trim();
      if (!imageUrl) { missing++; return; }
      items.push({
        imageUrl, title: `${(album.name ?? "Bộ ảnh").trim()} #${i + 1}`,
        detailUrl: album.slug ? `${base}/bo-anh/${album.slug}` : undefined,
        sourceType: "gallery", kind: "album",
        serviceIntent: intent === "unknown" ? "" : intent,
        albumName: (album.name ?? "").trim() || undefined, tags: tags || undefined, albumId,
      });
    });
    return { items, raw: rows.length, missing, error: null };
  } catch (err) {
    return { items: [], raw: 0, missing: 0, error: `album_photos: ${String(err).slice(0, 120)}` };
  }
}

async function browseGallery(): Promise<SourceResult> {
  try {
    const [albumsRes, catsRes] = await Promise.all([
      pool.query(
        `SELECT a.id, a.name, a.slug, a.tags_text, a.category_id, a.cover_image_url,
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
    const byId = new Map<number, CatRow>((catsRes.rows as CatRow[]).map((c) => [c.id, c]));
    const base = getPublicBaseUrl().replace(/\/+$/, "");
    const rows = albumsRes.rows as Array<{ id: number; name: string; slug: string | null; tags_text: string | null; category_id: number | null; cover_image_url: string | null; first_photo: string | null }>;
    let missing = 0;
    const items: ImageStoreItem[] = [];
    for (const a of rows) {
      const imageUrl = (a.cover_image_url ?? a.first_photo ?? "").trim();
      if (!imageUrl) { missing++; continue; }
      const tags = (a.tags_text ?? "").trim();
      const path = catPath(a.category_id, byId);
      const intent = detectServiceIntentFromText(`${a.name} ${tags} ${path}`);
      items.push({
        imageUrl, title: (a.name ?? "").trim() || "Bộ ảnh",
        detailUrl: a.slug ? `${base}/bo-anh/${a.slug}` : undefined,
        sourceType: "gallery", kind: "album",
        serviceIntent: intent === "unknown" ? "" : intent,
        albumName: (a.name ?? "").trim() || undefined,
        tags: [tags, path].filter(Boolean).join(" · ") || undefined, albumId: a.id,
      });
    }
    return { items, raw: rows.length, missing, error: null };
  } catch (err) {
    return { items: [], raw: 0, missing: 0, error: `gallery: ${String(err).slice(0, 120)}` };
  }
}

async function browseRental(): Promise<SourceResult> {
  try {
    const res = await pool.query(
      `SELECT id, code, name, category, style, outfit_tag, image_url
       FROM dresses
       WHERE is_available = TRUE
       ORDER BY usage_count DESC, id`,
    );
    const base = getPublicBaseUrl().replace(/\/+$/, "");
    const rows = res.rows as Array<{ name: string; category: string | null; style: string | null; outfit_tag: string | null; image_url: string | null }>;
    let missing = 0;
    const items: ImageStoreItem[] = [];
    for (const d of rows) {
      const imageUrl = (d.image_url ?? "").trim();
      if (!imageUrl) { missing++; continue; }
      const tags = [d.category, d.style, d.outfit_tag].filter(Boolean).join(" · ");
      items.push({
        imageUrl, title: (d.name ?? "").trim() || "Trang phục",
        detailUrl: `${base}/cho-thue-do`, sourceType: "rental_item", kind: "rental",
        serviceIntent: "rental_outfit", tags: tags || undefined,
      });
    }
    return { items, raw: rows.length, missing, error: null };
  } catch (err) {
    return { items: [], raw: 0, missing: 0, error: `rental: ${String(err).slice(0, 120)}` };
  }
}

async function browseIdeas(): Promise<SourceResult> {
  try {
    const res = await pool.query(
      `SELECT name, tags_text,
              COALESCE(NULLIF(trim(public_image_url), ''), NULLIF(trim(image_url), ''), NULLIF(trim(cover_image_url), '')) AS img
       FROM photo_ideas
       WHERE deleted_at IS NULL AND (visibility_status = 'public' OR visibility_status IS NULL)
       ORDER BY sort_order, id`,
    );
    const rows = res.rows as Array<{ name: string; tags_text: string | null; img: string | null }>;
    let missing = 0;
    const items: ImageStoreItem[] = [];
    for (const r of rows) {
      const imageUrl = (r.img ?? "").trim();
      if (!imageUrl) { missing++; continue; }
      const tags = (r.tags_text ?? "").trim();
      items.push({
        imageUrl, title: (r.name ?? "").trim() || "Ý tưởng concept",
        sourceType: "photo_idea", kind: "idea",
        serviceIntent: "new_concept_idea", tags: tags || undefined,
      });
    }
    return { items, raw: rows.length, missing, error: null };
  } catch (err) {
    return { items: [], raw: 0, missing: 0, error: `ideas: ${String(err).slice(0, 120)}` };
  }
}

// ─── ẢNH BẢNG GIÁ (Dịch vụ & Bảng giá) — service_groups.ai_image_url ──────────
async function browsePriceBoard(): Promise<SourceResult> {
  try {
    const res = await pool.query(
      `SELECT id, name, ai_image_url, public_for_customer
       FROM service_groups
       WHERE is_active = 1
       ORDER BY sort_order, id`,
    );
    const base = getPublicBaseUrl().replace(/\/+$/, "");
    const rows = res.rows as Array<{ id: number; name: string; ai_image_url: string | null; public_for_customer: boolean }>;
    let missing = 0;
    const items: ImageStoreItem[] = [];
    for (const g of rows) {
      const imageUrl = (g.ai_image_url ?? "").trim();
      if (!imageUrl) { missing++; continue; }
      const name = (g.name ?? "").trim();
      const intent = detectServiceIntentFromText(name);
      items.push({
        imageUrl, title: `Bảng giá: ${name || "nhóm dịch vụ"}`,
        detailUrl: `${base}/bang-gia`,
        // sourceType hợp lệ để khớp SampleImage; kind "price" để FE lọc theo tab Bảng giá.
        sourceType: "service_package", kind: "price",
        serviceIntent: intent === "unknown" ? "" : intent,
        tags: name || undefined, publicForCustomer: !!g.public_for_customer,
      });
    }
    return { items, raw: rows.length, missing, error: null };
  } catch (err) {
    return { items: [], raw: 0, missing: 0, error: `price_board: ${String(err).slice(0, 120)}` };
  }
}

const ALL_KINDS: ImageKind[] = ["album", "rental", "idea", "price"];

/**
 * Duyệt kho ảnh + lọc (tone MỀM) + debug. albumId → ảnh trong album đó.
 */
export async function browseImageStore(opts: BrowseImageStoreOpts): Promise<{ items: ImageStoreItem[]; total: number; debug: ImageStoreDebug }> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 120));
  const kinds = opts.kinds && opts.kinds.length ? opts.kinds : ALL_KINDS;
  const sourceCounts: Record<ImageKind, number> = { album: 0, rental: 0, idea: 0, price: 0 };
  const errors: string[] = [];

  // Drill-down 1 album cụ thể.
  if (opts.albumId && opts.albumId > 0) {
    const r = await browseAlbumPhotos(opts.albumId, limit);
    sourceCounts.album = r.raw;
    if (r.error) errors.push(r.error);
    const debug: ImageStoreDebug = {
      reason: r.error ? "api_error" : r.items.length === 0 ? (r.raw === 0 ? "no_rows_in_db" : "all_missing_url") : "ok",
      message: r.error ? "Lỗi đọc ảnh trong album." : r.items.length === 0 ? "Album này chưa có ảnh hiển thị." : "OK",
      sourceCounts, withImageCount: r.items.length, missingUrlCount: r.missing,
      afterFilterBeforeTone: r.items.length, afterToneFilter: r.items.length, toneRelaxed: false, errors,
    };
    return { items: r.items.slice(0, limit), total: r.items.length, debug };
  }

  // Gom các nguồn theo kinds.
  const jobs: Array<Promise<SourceResult> & { _kind?: ImageKind }> = [];
  const kindOrder: ImageKind[] = [];
  if (kinds.includes("album")) { jobs.push(browseGallery()); kindOrder.push("album"); }
  if (kinds.includes("rental")) { jobs.push(browseRental()); kindOrder.push("rental"); }
  if (kinds.includes("idea")) { jobs.push(browseIdeas()); kindOrder.push("idea"); }
  if (kinds.includes("price")) { jobs.push(browsePriceBoard()); kindOrder.push("price"); }

  const results = await Promise.all(jobs);
  const all: ImageStoreItem[] = [];
  let missingUrlCount = 0;
  results.forEach((r, i) => {
    sourceCounts[kindOrder[i]] = r.raw;
    missingUrlCount += r.missing;
    if (r.error) errors.push(r.error);
    all.push(...r.items);
  });
  const totalRaw = Object.values(sourceCounts).reduce((a, b) => a + b, 0);
  const withImageCount = all.length;

  // ── Lọc KHÔNG tone (intent / tên bộ / tag / từ khóa) ──
  const wantIntent = norm(opts.intent);
  const wantAlbum = norm(opts.album);
  const wantTag = norm(opts.tag);
  const wantQ = norm(opts.q);
  const wantFamily = wantIntent ? intentFamily(wantIntent) : "";
  const base = all.filter((it) => {
    const hayName = norm(it.title);
    const hayAlbum = norm(it.albumName);
    const hayTags = norm(it.tags);
    const hayAll = `${hayName} ${hayAlbum} ${hayTags} ${norm(it.serviceIntent)}`;
    // Lọc intent theo HỌ (wedding_gate ~ wedding_album ~ wedding_party). Mục chưa rõ intent
    // ("") chỉ bị loại khi đang lọc intent.
    if (wantIntent) {
      if (!it.serviceIntent) return false;
      if (intentFamily(it.serviceIntent) !== wantFamily) return false;
    }
    if (wantAlbum && !hayAlbum.includes(wantAlbum)) return false;
    if (wantTag && !hayTags.includes(wantTag)) return false;
    if (wantQ && !hayAll.includes(wantQ)) return false;
    return true;
  });

  // ── Tone MỀM: lọc thêm tone; nếu rỗng nhưng base còn → NỚI tone (hiện ảnh cùng dịch vụ) ──
  const toneKeys = (opts.tone ?? "").trim() ? detectTones(opts.tone) : [];
  let items = base;
  let toneRelaxed = false;
  let afterToneFilter = base.length;
  if (toneKeys.length) {
    const toned = base.filter((it) => {
      const itTones = detectTones(`${it.title} ${it.albumName ?? ""} ${it.tags ?? ""}`);
      return toneKeys.some((k) => itTones.includes(k));
    });
    afterToneFilter = toned.length;
    if (toned.length > 0) { items = toned; }
    else if (base.length > 0) { items = base; toneRelaxed = true; } // không có ảnh đúng tone → hiện cùng dịch vụ
    else { items = []; }
  }

  // ── Xác định lý do debug ──
  let reason: ImageStoreDebugReason;
  let message: string;
  if (errors.length && withImageCount === 0) { reason = "api_error"; message = "API lỗi khi đọc kho ảnh."; }
  else if (totalRaw === 0) { reason = "no_rows_in_db"; message = "Không tìm thấy dữ liệu ảnh trong DB (album/đồ thuê/ý tưởng/bảng giá đều trống)."; }
  else if (withImageCount === 0) { reason = "all_missing_url"; message = `Có ${totalRaw} mục nhưng tất cả THIẾU URL ảnh — cần thêm ảnh đại diện.`; }
  else if (items.length === 0) { reason = "filter_too_narrow"; message = "Bộ lọc quá hẹp — không có ảnh khớp. Thử bỏ bớt điều kiện (dịch vụ/tag/từ khóa)."; }
  else if (toneRelaxed) { reason = "tone_relaxed"; message = "Chưa có ảnh đúng tone — đang hiển thị ảnh CÙNG DỊCH VỤ."; }
  else { reason = "ok"; message = "OK"; }

  const debug: ImageStoreDebug = {
    reason, message, sourceCounts, withImageCount, missingUrlCount,
    afterFilterBeforeTone: base.length, afterToneFilter, toneRelaxed, errors,
  };

  return { items: items.slice(0, limit), total: items.length, debug };
}
