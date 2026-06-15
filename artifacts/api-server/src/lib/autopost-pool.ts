import { pool } from "@workspace/db";
import { hashImageUrl } from "./autopost-images";

// Một item đã chuẩn hóa, sẵn sàng upsert vào autopost_content_pool.
export type PoolItemInput = {
  sourceType: string;
  sourceTable: string;
  sourceItemId: string | null;
  contentType: string;
  title: string;
  images: string[];
  price: number | null;
  salePrice: number | null;
  goldenHourPercent: number | null;
  goldenHourName: string | null;
  category: string | null;
  badge: string | null;
  publicLink: string | null;
  meta: Record<string, unknown>;
  imageHash: string | null;
  isEligible: boolean;
};

// ───────────────────────── PURE helpers (no DB) ─────────────────────────

/** Parse extra_images: chuỗi JSON hoặc mảng → mảng string không rỗng. Lỗi → []. */
export function parseExtraImages(raw: unknown): string[] {
  try {
    let arr: unknown = raw;
    if (typeof raw === "string") arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** URL hợp lệ: là string và sau khi trim còn ký tự. */
export function isValidImageUrl(u: unknown): boolean {
  return typeof u === "string" && u.trim().length > 0;
}

/**
 * Gộp ảnh chính + extra, lọc URL hợp lệ, khử trùng lặp giữ nguyên thứ tự.
 * extraRaw có thể là chuỗi JSON hoặc mảng (parseExtraImages xử lý cả hai).
 */
export function collectImages(primary: unknown, extraRaw: unknown): string[] {
  const candidates: unknown[] = [primary, ...parseExtraImages(extraRaw)];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!isValidImageUrl(c)) continue;
    const v = (c as string).trim();
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Suy ra content_type của váy từ tên danh mục + tên danh mục cha. */
export function inferDressContentType(
  categoryName: string | null | undefined,
  parentName: string | null | undefined,
): string {
  const haystack = `${categoryName ?? ""} ${parentName ?? ""}`.toLowerCase();
  if (haystack.includes("việt phục")) return "viet_phuc";
  if (haystack.includes("áo dài cưới")) return "ao_dai_cuoi";
  if (haystack.includes("beauty")) return "beauty";
  return "vay_cuoi";
}

/** Suy ra content_type của album từ tên danh mục. */
export function inferGalleryContentType(categoryName: string | null | undefined): string {
  const lower = (categoryName ?? "").toLowerCase();
  if (lower.includes("beauty")) return "beauty";
  if (lower.includes("áo dài")) return "ao_dai_cuoi";
  if (lower.includes("cưới")) return "album_cuoi";
  return "album_cuoi";
}

/** Dựng link công khai. photo_idea trả null (trang bị khóa mật khẩu). */
export function buildPublicLink(
  kind: "dress" | "album" | "photo_idea",
  slug: string | null | undefined,
  baseUrl: string | null | undefined,
): string | null {
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return null;
  if (kind === "dress") return `${base}/san-pham/${slug}`;
  if (kind === "album") return `${base}/bo-anh/${slug}`;
  return null; // photo_idea
}

/** Map 1 dòng dress → PoolItemInput. */
export function mapDressRow(row: any, baseUrl: string): PoolItemInput {
  const images = collectImages(row.coverImageUrl, row.extraImages);
  const rental = Number(row.rentalPrice) || 0;
  const sale = Number(row.salePrice) || 0;
  const price = rental || null;
  const salePrice = sale > 0 && sale < rental ? sale : null;
  return {
    sourceType: "app_web",
    sourceTable: "dresses",
    sourceItemId: String(row.id),
    contentType: inferDressContentType(row.categoryName, row.parentName),
    title: row.name,
    images,
    price,
    salePrice,
    goldenHourPercent: null,
    goldenHourName: null,
    category: row.categoryName ?? null,
    badge: row.outfitTag ?? null,
    publicLink: buildPublicLink("dress", row.slug, baseUrl),
    meta: {
      code: row.code,
      color: row.color,
      size: row.size,
      sellPrice: row.sellPrice,
      rentalStatus: row.rentalStatus,
    },
    imageHash: images[0] ? hashImageUrl(images[0]) : null,
    isEligible: images.length > 0,
  };
}

/** Map 1 album + danh sách ảnh → PoolItemInput. */
export function mapAlbumRow(row: any, photoUrls: string[], baseUrl: string): PoolItemInput {
  const images = collectImages(row.coverImageUrl, photoUrls);
  return {
    sourceType: "app_web",
    sourceTable: "gallery_albums",
    sourceItemId: String(row.id),
    contentType: inferGalleryContentType(row.categoryName),
    title: row.name,
    images,
    price: null,
    salePrice: null,
    goldenHourPercent: null,
    goldenHourName: null,
    category: row.categoryName ?? null,
    badge: null,
    publicLink: buildPublicLink("album", row.slug, baseUrl),
    meta: { categoryId: row.categoryId },
    imageHash: images[0] ? hashImageUrl(images[0]) : null,
    isEligible: images.length > 0,
  };
}

/** Map 1 dòng photo_idea → PoolItemInput. */
export function mapPhotoIdeaRow(row: any): PoolItemInput {
  const images = collectImages(row.coverImageUrl, row.extraImages);
  return {
    sourceType: "app_web",
    sourceTable: "photo_ideas",
    sourceItemId: String(row.id),
    contentType: "photo_idea",
    title: row.name,
    images,
    price: null,
    salePrice: null,
    goldenHourPercent: null,
    goldenHourName: null,
    category: null,
    badge: row.executionStatus ?? null,
    publicLink: null,
    meta: { tagsText: row.tagsText, description: row.description },
    imageHash: images[0] ? hashImageUrl(images[0]) : null,
    isEligible: images.length > 0,
  };
}

// ───────────────────────── DB functions ─────────────────────────
// READ-ONLY trên các bảng nguồn. Chỉ GHI vào autopost_content_pool.

async function upsertPoolItem(item: PoolItemInput): Promise<void> {
  await pool.query(
    `INSERT INTO autopost_content_pool
       (source_type, source_table, source_item_id, content_type, title, images,
        price, sale_price, golden_hour_percent, golden_hour_name, category, badge,
        public_link, image_hash, meta, is_eligible, ineligible_reason)
     VALUES
       ($1, $2, $3, $4, $5, $6::jsonb,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15::jsonb, $16, NULL)
     ON CONFLICT (source_table, source_item_id) DO UPDATE SET
        content_type        = EXCLUDED.content_type,
        title               = EXCLUDED.title,
        images              = EXCLUDED.images,
        price               = EXCLUDED.price,
        sale_price          = EXCLUDED.sale_price,
        golden_hour_percent = EXCLUDED.golden_hour_percent,
        golden_hour_name    = EXCLUDED.golden_hour_name,
        category            = EXCLUDED.category,
        badge               = EXCLUDED.badge,
        public_link         = EXCLUDED.public_link,
        image_hash          = EXCLUDED.image_hash,
        meta                = EXCLUDED.meta,
        is_eligible         = true,
        ineligible_reason   = NULL,
        updated_at          = now()`,
    [
      item.sourceType,
      item.sourceTable,
      item.sourceItemId,
      item.contentType,
      item.title,
      JSON.stringify(item.images),
      item.price,
      item.salePrice,
      item.goldenHourPercent,
      item.goldenHourName,
      item.category,
      item.badge,
      item.publicLink,
      item.imageHash,
      JSON.stringify(item.meta),
      item.isEligible,
    ],
  );
}

export async function markMissing(sourceTable: string, keepIds: string[]): Promise<void> {
  // An toàn: nguồn rỗng (query lỗi tạm thời / 0 item public) KHÔNG được phép
  // vô hiệu hoá TOÀN BỘ pool của bảng đó — bỏ qua khi không có id nào để giữ.
  if (keepIds.length === 0) return;
  await pool.query(
    `UPDATE autopost_content_pool
        SET is_eligible = false,
            ineligible_reason = 'unpublished_or_no_image',
            updated_at = now()
      WHERE source_type = 'app_web'
        AND source_table = $1
        AND source_item_id <> ALL($2)`,
    [sourceTable, keepIds],
  );
}

/**
 * Đồng bộ toàn bộ nội dung app/web vào pool. READ-ONLY trên dresses /
 * gallery_albums / gallery_photos / photo_ideas / cms_categories /
 * golden_hour_campaigns. Chỉ ghi vào autopost_content_pool.
 */
export async function syncAppWebPool(): Promise<{ dresses: number; albums: number; ideas: number }> {
  const baseUrl = (process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "");

  // 1) DRESSES — mirror /cms/public/dresses.
  const dressRes = await pool.query(
    `SELECT d.id, d.name, d.code, d.color, d.size, d.category_id AS "categoryId",
            d.rental_price AS "rentalPrice", d.sale_price AS "salePrice", d.sell_price AS "sellPrice",
            d.outfit_tag AS "outfitTag", d.rental_status AS "rentalStatus",
            COALESCE(d.cover_image_url, d.public_image_url, d.image_url) AS "coverImageUrl",
            d.extra_images AS "extraImages", d.slug,
            c.name AS "categoryName", pc.name AS "parentName"
       FROM dresses d
       LEFT JOIN cms_categories c ON c.id = d.category_id
       LEFT JOIN cms_categories pc ON pc.id = c.parent_id
      WHERE d.deleted_at IS NULL AND d.is_public = 1 AND d.cms_status = 'visible'
        AND COALESCE(d.cover_image_url, d.public_image_url, d.image_url) IS NOT NULL`,
  );

  const dressItems = (dressRes.rows as any[]).map((row) => ({
    row,
    item: mapDressRow(row, baseUrl),
  }));

  // Gắn giờ vàng (READ-ONLY) — sao chép logic attachGoldenHour của cms.ts.
  const camps = await pool.query(
    `SELECT scope, ref_id AS "refId", name, percent
       FROM golden_hour_campaigns
      WHERE is_active = true
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at   IS NULL OR ends_at   >= now())`,
  );
  const dressCamp = new Map<number, { pct: number; name: string }>();
  const catCamp = new Map<number, { pct: number; name: string }>();
  for (const c of camps.rows as any[]) {
    const pct = parseFloat(c.percent);
    if (!(pct > 0)) continue;
    if (c.scope === "dress") dressCamp.set(Number(c.refId), { pct, name: c.name });
    else if (c.scope === "category") catCamp.set(Number(c.refId), { pct, name: c.name });
  }
  const parentOf = new Map<number, number | null>();
  if (catCamp.size > 0) {
    const cats = await pool.query(
      `SELECT id, parent_id AS "parentId" FROM cms_categories WHERE type = 'dress'`,
    );
    for (const r of cats.rows as any[]) {
      parentOf.set(Number(r.id), r.parentId == null ? null : Number(r.parentId));
    }
  }
  for (const { row, item } of dressItems) {
    let found: { pct: number; name: string } | null = null;
    // SP có sale riêng → bỏ qua giờ vàng.
    if (item.salePrice == null && (dressCamp.size > 0 || catCamp.size > 0)) {
      if (dressCamp.has(Number(row.id))) {
        found = dressCamp.get(Number(row.id))!;
      } else {
        let cid: number | null = row.categoryId == null ? null : Number(row.categoryId);
        const guard = new Set<number>();
        while (cid != null && !guard.has(cid)) {
          guard.add(cid);
          if (catCamp.has(cid)) {
            found = catCamp.get(cid)!;
            break;
          }
          cid = parentOf.has(cid) ? parentOf.get(cid)! : null;
        }
      }
    }
    item.goldenHourPercent = found ? found.pct : null;
    item.goldenHourName = found ? found.name : null;
  }

  const dressKeptIds: string[] = [];
  for (const { item } of dressItems) {
    await upsertPoolItem(item);
    if (item.sourceItemId) dressKeptIds.push(item.sourceItemId);
  }

  // 2) ALBUMS — mirror /cms/public/gallery/albums.
  const albumRes = await pool.query(
    `SELECT a.id, a.name, COALESCE(NULLIF(a.slug, ''), 'al-' || a.id) AS slug, a.category_id AS "categoryId", c.name AS "categoryName",
            COALESCE(a.cover_image_url, (SELECT p.image_url FROM gallery_photos p WHERE p.album_id = a.id AND p.deleted_at IS NULL AND p.status = 'visible' AND (p.mime_type IS NULL OR p.mime_type LIKE 'image/%') ORDER BY p.sort_order ASC, p.id ASC LIMIT 1)) AS "coverImageUrl"
       FROM gallery_albums a LEFT JOIN cms_categories c ON c.id = a.category_id
      WHERE a.deleted_at IS NULL AND a.status = 'visible'`,
  );

  const albumKeptIds: string[] = [];
  let albumCount = 0;
  for (const row of albumRes.rows as any[]) {
    const photoRes = await pool.query(
      `SELECT image_url FROM gallery_photos
        WHERE album_id = $1 AND deleted_at IS NULL AND status = 'visible'
          AND (mime_type IS NULL OR mime_type LIKE 'image/%')
        ORDER BY sort_order ASC, id ASC LIMIT 5`,
      [row.id],
    );
    const photoUrls = (photoRes.rows as any[]).map((p) => p.image_url);
    const item = mapAlbumRow(row, photoUrls, baseUrl);
    if (item.images.length === 0) continue;
    await upsertPoolItem(item);
    if (item.sourceItemId) albumKeptIds.push(item.sourceItemId);
    albumCount++;
  }

  // 3) PHOTO IDEAS — mirror /public/photo-ideas.
  const ideaRes = await pool.query(
    `SELECT id, name, slug, category_id AS "categoryId", description, tags_text AS "tagsText",
            execution_status AS "executionStatus",
            COALESCE(cover_image_url, public_image_url, image_url) AS "coverImageUrl",
            extra_images AS "extraImages"
       FROM photo_ideas
      WHERE deleted_at IS NULL AND visibility_status = 'public'`,
  );

  const ideaKeptIds: string[] = [];
  let ideaCount = 0;
  for (const row of ideaRes.rows as any[]) {
    const item = mapPhotoIdeaRow(row);
    if (item.images.length === 0) continue;
    await upsertPoolItem(item);
    if (item.sourceItemId) ideaKeptIds.push(item.sourceItemId);
    ideaCount++;
  }

  // 5) MARK MISSING — chỉ ghi vào autopost_content_pool, không bao giờ xóa dòng.
  await markMissing("dresses", dressKeptIds);
  await markMissing("gallery_albums", albumKeptIds);
  await markMissing("photo_ideas", ideaKeptIds);

  return { dresses: dressKeptIds.length, albums: albumCount, ideas: ideaCount };
}

/** Thêm thủ công 1 item upload vào pool. Trả về id mới. */
export async function addManualPoolItem(input: {
  contentType: string;
  title: string;
  images: string[];
  price?: number | null;
  salePrice?: number | null;
  category?: string | null;
  badge?: string | null;
  publicLink?: string | null;
  meta?: Record<string, unknown>;
}): Promise<number> {
  const images = input.images ?? [];
  const res = await pool.query(
    `INSERT INTO autopost_content_pool
       (source_type, source_table, source_item_id, content_type, title, images,
        price, sale_price, category, badge, public_link, meta, image_hash, is_eligible)
     VALUES
       ('upload', 'manual', NULL, $1, $2, $3::jsonb,
        $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
     RETURNING id`,
    [
      input.contentType,
      input.title,
      JSON.stringify(images),
      input.price ?? null,
      input.salePrice ?? null,
      input.category ?? null,
      input.badge ?? null,
      input.publicLink ?? null,
      JSON.stringify(input.meta ?? {}),
      images[0] ? hashImageUrl(images[0]) : null,
      images.length > 0,
    ],
  );
  return Number((res.rows as any[])[0].id);
}
