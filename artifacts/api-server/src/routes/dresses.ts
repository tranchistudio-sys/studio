import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

const OUTFIT_TAG_KEYS = new Set([
  "HANG_MOI_100", "HANG_MOI", "SIEU_MOI", "HOT_PICK",
  "FORM_DEP", "GIA_TIET_KIEM", "GIA_SIEU_TIET_KIEM",
  "VAY_NUOC_1", "VAY_NUOC_2", "VAY_NUOC_3", "VAY_NUOC_4",
]);
function normalizeOutfitTag(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  return OUTFIT_TAG_KEYS.has(s) ? s : null;
}
// Strict: returns { ok:true, value } for null/valid, { ok:false } for unknown non-empty.
function validateOutfitTag(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const s = String(v);
  if (OUTFIT_TAG_KEYS.has(s)) return { ok: true, value: s };
  return { ok: false };
}

// Vietnamese label (normalized, no diacritics) → outfit tag key.
// Order matters: longer/more-specific labels first to avoid substring false-matches.
const OUTFIT_LABEL_TO_KEY: Array<[string, string]> = [
  ["hang moi 100", "HANG_MOI_100"],
  ["gia sieu tiet kiem", "GIA_SIEU_TIET_KIEM"],
  ["gia tiet kiem", "GIA_TIET_KIEM"],
  ["vay nuoc 1", "VAY_NUOC_1"],
  ["vay nuoc 2", "VAY_NUOC_2"],
  ["vay nuoc 3", "VAY_NUOC_3"],
  ["vay nuoc 4", "VAY_NUOC_4"],
  ["form dep", "FORM_DEP"],
  ["hot pick", "HOT_PICK"],
  ["sieu moi", "SIEU_MOI"],
  ["hang moi", "HANG_MOI"],
];
function stripDiacriticsLower(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase();
}
function matchOutfitTagKeysFromSearch(q: string): string[] {
  const n = stripDiacriticsLower(q);
  const out: string[] = [];
  // ENUM key match (e.g. "SIEU_MOI", "vay_nuoc_1")
  for (const key of OUTFIT_TAG_KEYS) {
    if (n.includes(key.toLowerCase()) && !out.includes(key)) out.push(key);
  }
  // Vietnamese label match
  for (const [label, key] of OUTFIT_LABEL_TO_KEY) {
    if (n.includes(label) && !out.includes(key)) out.push(key);
  }
  return out;
}

function slugify(name: string, id: number): string {
  const s = (name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (s || "sp") + "-" + id;
}

function fmt(d: Record<string, unknown>) {
  let extraImages: string[] = [];
  try { if (d.extra_images) extraImages = JSON.parse(d.extra_images as string); } catch {}
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    category: d.category ?? "",
    categoryId: d.category_id ?? null,
    color: d.color ?? "",
    size: d.size ?? "",
    style: d.style ?? null,
    rentalPrice: parseFloat((d.rental_price ?? "0") as string),
    depositRequired: parseFloat((d.deposit_required ?? "0") as string),
    sellPrice: parseFloat((d.sell_price ?? "0") as string),
    salePrice: d.sale_price != null ? parseFloat(d.sale_price as string) : 0,
    isPriority: !!d.is_priority,
    priorityAt: d.priority_at ?? null,
    isAvailable: d.is_available,
    rentalStatus: d.rental_status ?? "san_sang",
    condition: d.condition ?? "tot",
    outfitTag: (d.outfit_tag ?? null) as string | null,
    notes: d.notes ?? null,
    description: d.description ?? null,
    imageUrl: d.image_url ?? null,
    publicImageUrl: d.public_image_url ?? null,
    coverImageUrl: d.cover_image_url ?? null,
    extraImages,
    isPublic: Number(d.is_public ?? 0),
    cmsStatus: (d.cms_status ?? "draft") as string,
    sizeText: d.size_text ?? null,
    colorText: d.color_text ?? null,
    tagsText: d.tags_text ?? null,
    materialText: d.material_text ?? null,
    slug: d.slug ?? null,
    usageCount: Number(d.usage_count ?? 0),
    createdAt: d.created_at,
  };
}

router.get("/dresses", async (req, res) => {
  try {
    const { rentalStatus, search, categoryId, isPublic, limit, outfitTag } = req.query as Record<string, string>;
    const conds: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];

    if (rentalStatus && rentalStatus !== "all") {
      params.push(rentalStatus);
      conds.push(`rental_status = $${params.length}`);
    }

    if (typeof outfitTag === "string" && outfitTag.length > 0) {
      const keys = Array.from(new Set(
        outfitTag.split(",").map(s => s.trim()).filter(s => OUTFIT_TAG_KEYS.has(s))
      ));
      if (keys.length > 0) {
        params.push(keys);
        conds.push(`outfit_tag = ANY($${params.length}::text[])`);
      }
    }

    // Ưu tiên hiển thị lên đầu, trong nhóm ưu tiên mới ghim trước; còn lại mới nhất trước
    let orderBy = "is_priority DESC, priority_at DESC NULLS LAST, created_at DESC";
    if (search) {
      const q = search.toLowerCase().trim();
      params.push(`%${q}%`);
      const n = params.length;
      const matchedTagKeys = matchOutfitTagKeysFromSearch(q);
      let tagOr = "";
      if (matchedTagKeys.length > 0) {
        params.push(matchedTagKeys);
        tagOr = ` OR outfit_tag = ANY($${params.length}::text[])`;
      }
      conds.push(`(LOWER(name) LIKE $${n} OR LOWER(code) LIKE $${n} OR LOWER(COALESCE(category,'')) LIKE $${n} OR LOWER(COALESCE(size,'')) LIKE $${n} OR LOWER(COALESCE(size_text,'')) LIKE $${n} OR LOWER(COALESCE(color,'')) LIKE $${n} OR LOWER(COALESCE(color_text,'')) LIKE $${n} OR LOWER(COALESCE(tags_text,'')) LIKE $${n}${tagOr})`);
      // Priority: exact code match → prefix code match → prefix name match → rest (newest first)
      params.push(q);
      const exactIdx = params.length;
      params.push(`${q}%`);
      const prefixIdx = params.length;
      orderBy = `
        (CASE WHEN LOWER(code) = $${exactIdx} THEN 0
              WHEN LOWER(code) LIKE $${prefixIdx} THEN 1
              WHEN LOWER(name) LIKE $${prefixIdx} THEN 2
              ELSE 3 END),
        created_at DESC
      `;
    }
    if (categoryId && categoryId !== "all") {
      params.push(+categoryId);
      conds.push(`category_id = $${params.length}`);
    }
    if (isPublic === "1") conds.push(`is_public = 1`);
    else if (isPublic === "0") conds.push(`(is_public IS NULL OR is_public = 0)`);

    const whereClause = conds.length ? "WHERE " + conds.join(" AND ") : "";

    let limitClause = "";
    // Default to 20 when search is provided (autocomplete UX); otherwise unbounded for back-compat.
    const defaultLimit = search ? 20 : 0;
    const limitNum = limit
      ? Math.max(1, Math.min(500, parseInt(limit, 10) || 0))
      : defaultLimit;
    if (limitNum > 0) {
      params.push(limitNum);
      limitClause = `LIMIT $${params.length}`;
    }

    const result = await pool.query(
      `SELECT * FROM dresses ${whereClause} ORDER BY ${orderBy} ${limitClause}`,
      params
    );
    res.json(result.rows.map(fmt));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/dresses", async (req, res) => {
  try {
    const {
      code, name, category, categoryId, color, size, style,
      rentalPrice, depositRequired, sellPrice, salePrice, rentalStatus, condition, notes,
      imageUrl, publicImageUrl, coverImageUrl, description, isPublic, cmsStatus, extraImages,
      sizeText, colorText, tagsText, materialText, outfitTag,
    } = req.body;
    const trimmedCode = (code as string | undefined)?.trim();
    if (!trimmedCode) {
      return res.status(400).json({ error: "Mã sản phẩm là bắt buộc" });
    }
    const tagCheck = validateOutfitTag(outfitTag);
    if (!tagCheck.ok) {
      return res.status(400).json({ error: "outfitTag không hợp lệ" });
    }
    const saleNum = Number(salePrice || 0);
    if (saleNum > 0 && saleNum >= Number(rentalPrice || 0)) {
      return res.status(400).json({ error: "Giá giảm phải nhỏ hơn giá thuê" });
    }
    const status = rentalStatus || "san_sang";
    const result = await pool.query(
      `INSERT INTO dresses
         (code, name, category, category_id, color, size, style,
          rental_price, deposit_required, rental_status, is_available,
          condition, notes, image_url, public_image_url, cover_image_url, description,
          is_public, cms_status, extra_images,
          size_text, color_text, tags_text, material_text, sell_price, outfit_tag, sale_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [
        trimmedCode, name || null, category || "", categoryId || null,
        color || colorText || "", size || sizeText || "", style || null,
        String(rentalPrice || 0), String(depositRequired || 0),
        status, status === "san_sang",
        condition || "tot", notes || null,
        imageUrl || null, publicImageUrl || null, coverImageUrl || null,
        description || null,
        isPublic ? 1 : 0, cmsStatus || "draft",
        extraImages ? JSON.stringify(extraImages) : null,
        sizeText || null, colorText || null, tagsText || null, materialText || null,
        String(sellPrice || 0),
        tagCheck.value,
        saleNum > 0 ? String(saleNum) : null,
      ]
    );
    const row = result.rows[0] as Record<string, unknown>;
    if (!row.slug) {
      const autoSlug = slugify(String(row.name || ""), row.id as number);
      await pool.query(`UPDATE dresses SET slug = $1 WHERE id = $2`, [autoSlug, row.id]);
      row.slug = autoSlug;
    }
    res.status(201).json(fmt(row));
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "Mã sản phẩm đã tồn tại" });
    }
    res.status(500).json({ error: String(e) });
  }
});

router.get("/dresses/categories", async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT DISTINCT category FROM dresses WHERE category IS NOT NULL AND category != '' ORDER BY category`
    );
    res.json(rows.rows.map((r: { category: string }) => r.category).filter(Boolean));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get("/dresses/slug/:slug", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM dresses WHERE slug = $1 AND deleted_at IS NULL`,
      [req.params.slug]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Không tìm thấy" });
    res.json(fmt(result.rows[0]));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get("/dresses/check-code", async (req, res) => {
  try {
    const code = String(req.query.code ?? "").trim();
    const excludeId = req.query.excludeId ? +req.query.excludeId : null;
    if (!code) return res.json({ available: false });
    const params: unknown[] = [code];
    let query = `SELECT id FROM dresses WHERE LOWER(code) = LOWER($1) AND deleted_at IS NULL`;
    if (excludeId) { params.push(excludeId); query += ` AND id != $${params.length}`; }
    const r = await pool.query(query, params);
    res.json({ available: r.rows.length === 0 });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get("/dresses/:id", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM dresses WHERE id = $1`, [+req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Không tìm thấy" });
    res.json(fmt(result.rows[0]));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.put("/dresses/:id", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];

    const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    const textFields: Record<string, string> = {
      code: "code", name: "name", category: "category",
      color: "color", size: "size", style: "style",
      condition: "condition", notes: "notes",
      imageUrl: "image_url", publicImageUrl: "public_image_url", coverImageUrl: "cover_image_url",
      description: "description", cmsStatus: "cms_status",
      sizeText: "size_text", colorText: "color_text",
      tagsText: "tags_text", materialText: "material_text",
      slug: "slug",
    };
    for (const [k, col] of Object.entries(textFields)) {
      if (body[k] !== undefined) add(col, body[k]);
    }
    if (body.categoryId !== undefined) add("category_id", body.categoryId === null ? null : +body.categoryId);
    if (body.rentalPrice !== undefined) add("rental_price", String(body.rentalPrice));
    if (body.depositRequired !== undefined) add("deposit_required", String(body.depositRequired));
    if (body.sellPrice !== undefined) add("sell_price", String(body.sellPrice));
    if (body.salePrice !== undefined) {
      const saleNum = Number(body.salePrice || 0);
      if (saleNum > 0) {
        let rental = body.rentalPrice !== undefined ? Number(body.rentalPrice || 0) : null;
        if (rental === null) {
          const cur = await pool.query(`SELECT rental_price FROM dresses WHERE id = $1`, [+req.params.id]);
          rental = parseFloat((cur.rows[0]?.rental_price ?? "0") as string);
        }
        if (saleNum >= rental) {
          return res.status(400).json({ error: "Giá giảm phải nhỏ hơn giá thuê" });
        }
      }
      add("sale_price", saleNum > 0 ? String(saleNum) : null);
    }
    if (body.isPublic !== undefined) add("is_public", body.isPublic ? 1 : 0);
    if (body.extraImages !== undefined) add("extra_images", JSON.stringify(body.extraImages));
    if (body.outfitTag !== undefined) {
      const c = validateOutfitTag(body.outfitTag);
      if (!c.ok) return res.status(400).json({ error: "outfitTag không hợp lệ" });
      add("outfit_tag", c.value);
    }
    if (body.rentalStatus !== undefined) {
      add("rental_status", body.rentalStatus);
      add("is_available", body.rentalStatus === "san_sang");
    } else if (body.isAvailable !== undefined) {
      add("is_available", body.isAvailable);
      add("rental_status", body.isAvailable ? "san_sang" : "dang_cho_thue");
    }

    if (!sets.length) return res.json({ ok: true });
    params.push(+req.params.id);
    const result = await pool.query(
      `UPDATE dresses SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Không tìm thấy" });
    const row = result.rows[0] as Record<string, unknown>;
    if (!row.slug) {
      const autoSlug = slugify(String(row.name || ""), row.id as number);
      await pool.query(`UPDATE dresses SET slug = $1 WHERE id = $2`, [autoSlug, row.id]);
      row.slug = autoSlug;
    }
    res.json(fmt(row));
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "Mã sản phẩm đã tồn tại" });
    }
    res.status(500).json({ error: String(e) });
  }
});

router.delete("/dresses/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM dresses WHERE id = $1`, [+req.params.id]);
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
