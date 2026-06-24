import { Router, type IRouter, type Request, type Response } from "express";
import { pool, db } from "@workspace/db";
import {
  galleryAlbumsTable, galleryPhotosTable, cmsCategoriesTable,
  dressesTable, servicePackagesTable,
} from "@workspace/db/schema";
import { eq, and, isNull, isNotNull, asc, desc, sql } from "drizzle-orm";
import { verifyToken, getCallerRole } from "./auth";
import { resolveDiscount } from "../lib/pricing-discount";
import { clearSaleContextCache } from "../lib/sale-context";

const router: IRouter = Router();

// ─── Auto-migration: add columns + create tables on startup ──────────────────
async function ensureCmsSchema() {
  // Gallery + categories tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gallery_albums (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      description TEXT,
      cover_image_url TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gallery_photos (
      id SERIAL PRIMARY KEY,
      album_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      caption TEXT,
      mime_type TEXT,
      status TEXT NOT NULL DEFAULT 'visible',
      sort_order INTEGER NOT NULL DEFAULT 0,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cms_categories (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gallery_photos_album ON gallery_photos(album_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cms_categories_type ON cms_categories(type)`);

  // ─── Task #436: backfill album slug (al-{id}) cho các album cũ chưa có ──
  await pool.query(
    `UPDATE gallery_albums SET slug = 'al-' || id WHERE (slug IS NULL OR slug = '') AND deleted_at IS NULL`
  ).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gallery_albums_slug ON gallery_albums(slug)`).catch(() => {});

  // ─── Task #434: link gallery_albums vào cây danh mục + lưu tags ──────────
  await pool.query(`ALTER TABLE gallery_albums ADD COLUMN IF NOT EXISTS category_id INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE gallery_albums ADD COLUMN IF NOT EXISTS tags_text TEXT`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_gallery_albums_category ON gallery_albums(category_id)`).catch(() => {});

  // Add is_public + cms_status + deleted_at to dresses & service_packages
  for (const t of ["dresses", "service_packages"]) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS is_public INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cms_status TEXT NOT NULL DEFAULT 'draft'`).catch(() => {});
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`).catch(() => {});
  }
  await pool.query(`ALTER TABLE service_packages ADD COLUMN IF NOT EXISTS short_description TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS public_image_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS extra_images TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS cover_image_url TEXT`).catch((e) => { console.error("[cms] Failed to add cover_image_url:", e); throw e; });
  // Backfill: set cover_image_url from existing public_image_url/image_url so legacy data keeps the same cover
  await pool.query(`UPDATE dresses SET cover_image_url = COALESCE(public_image_url, image_url) WHERE cover_image_url IS NULL AND COALESCE(public_image_url, image_url) IS NOT NULL`).catch(() => {});

  // ─── New fields for #410 ──────────────────────────────────────────────────
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS size_text TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS color_text TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS tags_text TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS material_text TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS sell_price NUMERIC DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS slug TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS outfit_tag TEXT`).catch(() => {});
  // Auto-generate simple slug for existing products without one
  await pool.query(
    `UPDATE dresses SET slug = 'sp-' || id WHERE (slug IS NULL OR slug = '') AND deleted_at IS NULL`
  ).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dresses_slug ON dresses(slug)`).catch(() => {});
  // ─── UNIQUE partial index on code (skip deleted + null/empty) ─────────────
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dresses_code_unique
    ON dresses(LOWER(code))
    WHERE deleted_at IS NULL AND code IS NOT NULL AND code != ''
  `).catch(() => {});

  // ─── TREE columns for cms_categories + dresses.category_id ───────────────
  await pool.query(`ALTER TABLE cms_categories ADD COLUMN IF NOT EXISTS parent_id INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE cms_categories ADD COLUMN IF NOT EXISTS cover_image_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE dresses ADD COLUMN IF NOT EXISTS category_id INTEGER`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cms_categories_tree
                    ON cms_categories(type, parent_id, sort_order)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dresses_category_id
                    ON dresses(category_id)`).catch(() => {});

  // ─── CMS Home Settings (single-row, id = 1) ──────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cms_home_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      hero_image_url TEXT,
      about_image_url TEXT,
      eyebrow TEXT,
      title_line1 TEXT,
      title_line2 TEXT,
      subtitle TEXT,
      cta_primary_label TEXT,
      cta_primary_href TEXT,
      cta_secondary_label TEXT,
      cta_secondary_href TEXT,
      featured_concept_image_url TEXT,
      featured_service_image_url TEXT,
      footer_banner_image_url TEXT,
      footer_cta_title TEXT,
      footer_cta_subtitle TEXT,
      footer_cta_button_label TEXT,
      footer_cta_button_href TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT cms_home_settings_singleton CHECK (id = 1)
    )`);

  // ─── Seed default dress tree — bọc trong transaction + advisory lock ──
  // Đảm bảo nhiều instance khởi động song song không seed trùng.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(8412401)"); // arbitrary unique key
    const existing = await client.query(
      `SELECT COUNT(*)::int AS c FROM cms_categories WHERE type='dress' AND deleted_at IS NULL`
    );
    if ((existing.rows[0] as { c: number }).c === 0) {
      const TREE: Array<[string, string[] | Array<[string, string[]]>]> = [
        ["Đồ cưới", [
          ["Đồ chụp hình cưới", ["Váy to", "Váy đi bàn", "Váy đuôi cá", "Váy ngắn"]],
          ["Đồ ngày cưới", ["Váy VIP", "Váy lễ", "Vest", "Áo dài cưới"]],
        ]],
        ["Đồ beauty", ["Áo dài", "Việt phục", "Cổ phục", "Áo tấc", "Áo tứ thân"]],
        ["Đạo cụ / Concept", ["Sinh nhật", "Đi tiệc", "Fashion"]],
      ];
      let tier1 = 0;
      for (const [name, children] of TREE) {
        tier1++;
        const r1 = await client.query(
          `INSERT INTO cms_categories (type, parent_id, name, sort_order) VALUES ('dress', NULL, $1, $2) RETURNING id`,
          [name, tier1]
        );
        const parent1Id = (r1.rows[0] as { id: number }).id;
        if (!Array.isArray(children)) continue;
        let tier2 = 0;
        for (const child of children) {
          tier2++;
          if (typeof child === "string") {
            await client.query(
              `INSERT INTO cms_categories (type, parent_id, name, sort_order) VALUES ('dress', $1, $2, $3)`,
              [parent1Id, child, tier2]
            );
          } else {
            const [subName, grandChildren] = child;
            const r2 = await client.query(
              `INSERT INTO cms_categories (type, parent_id, name, sort_order) VALUES ('dress', $1, $2, $3) RETURNING id`,
              [parent1Id, subName, tier2]
            );
            const parent2Id = (r2.rows[0] as { id: number }).id;
            let tier3 = 0;
            for (const g of grandChildren) {
              tier3++;
              await client.query(
                `INSERT INTO cms_categories (type, parent_id, name, sort_order) VALUES ('dress', $1, $2, $3)`,
                [parent2Id, g, tier3]
              );
            }
          }
        }
      }
      console.log("[cms] Seeded default dress category tree");
    }

    // ─── Task #434: seed gallery category tree nếu chưa có ────────────────
    const existingGallery = await client.query(
      `SELECT COUNT(*)::int AS c FROM cms_categories WHERE type='gallery' AND deleted_at IS NULL`
    );
    if ((existingGallery.rows[0] as { c: number }).c === 0) {
      const GAL_TREE: Array<[string, string[]]> = [
        ["Beauty", ["Sexy", "Nàng thơ", "Sang trọng", "Ngầu"]],
        ["Cưới", ["Studio", "Ngoại cảnh", "Phông xám"]],
        ["Áo dài", ["Truyền thống", "Hiện đại", "Việt phục"]],
        ["Sinh nhật", []],
        ["Concept khác", []],
      ];
      let g1 = 0;
      for (const [name, children] of GAL_TREE) {
        g1++;
        const r1 = await client.query(
          `INSERT INTO cms_categories (type, parent_id, name, sort_order) VALUES ('gallery', NULL, $1, $2) RETURNING id`,
          [name, g1]
        );
        const pid = (r1.rows[0] as { id: number }).id;
        let g2 = 0;
        for (const child of children) {
          g2++;
          await client.query(
            `INSERT INTO cms_categories (type, parent_id, name, sort_order) VALUES ('gallery', $1, $2, $3)`,
            [pid, child, g2]
          );
        }
      }
      console.log("[cms] Seeded default gallery category tree");
    }

    // ─── Task #434: seed vài album mẫu nếu chưa có album nào ──────────────
    const existingAlbums = await client.query(
      `SELECT COUNT(*)::int AS c FROM gallery_albums WHERE deleted_at IS NULL`
    );
    if ((existingAlbums.rows[0] as { c: number }).c === 0) {
      // Lấy lại id của các leaf category vừa seed để gắn album mẫu
      const leafRows = await client.query(
        `SELECT id, name FROM cms_categories
          WHERE type='gallery' AND deleted_at IS NULL
            AND name IN ('Sexy','Nàng thơ','Studio','Truyền thống','Sinh nhật')
          ORDER BY id`
      );
      const byName = new Map<string, number>();
      for (const r of leafRows.rows as Array<{ id: number; name: string }>) byName.set(r.name, r.id);
      const samples: Array<{ name: string; cat: string; status: string }> = [
        { name: "Album mẫu — Beauty Sexy",      cat: "Sexy",         status: "draft" },
        { name: "Album mẫu — Nàng thơ",         cat: "Nàng thơ",     status: "draft" },
        { name: "Album mẫu — Cưới Studio",      cat: "Studio",       status: "draft" },
        { name: "Album mẫu — Áo dài truyền thống", cat: "Truyền thống", status: "draft" },
        { name: "Album mẫu — Sinh nhật bé",     cat: "Sinh nhật",    status: "draft" },
      ];
      let order = 0;
      for (const s of samples) {
        const cid = byName.get(s.cat) ?? null;
        order++;
        await client.query(
          `INSERT INTO gallery_albums (name, status, sort_order, category_id)
           VALUES ($1, $2, $3, $4)`,
          [s.name, s.status, order, cid]
        );
      }
      console.log("[cms] Seeded sample gallery albums");
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
ensureCmsSchema().catch(err => console.error("[cms] ensureSchema failed:", err));

// ─── Permission helpers ─────────────────────────────────────────────────────
async function requireAuth(req: Request, res: Response): Promise<"admin" | "staff" | null> {
  const role = await getCallerRole(req.headers.authorization);
  if (!role) { res.status(401).json({ error: "Chưa đăng nhập" }); return null; }
  return role;
}
async function requireCmsStaff(req: Request, res: Response): Promise<boolean> {
  const role = await requireAuth(req, res);
  return !!role;
}
// Mở toàn quyền các module CMS Website (Trang chủ, Cài đặt, Concept ảnh, Bảng giá,
// Cho thuê đồ, Ý tưởng) cho mọi nhân viên đã đăng nhập: được thêm/sửa/xoá/ẩn-hiện
// như Admin. Vẫn yêu cầu đăng nhập để chống truy cập ẩn danh.
async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const role = await requireAuth(req, res);
  return !!role;
}

const STATUSES = ["draft", "visible", "hidden"] as const;
function normStatus(s: unknown): "draft" | "visible" | "hidden" {
  return STATUSES.includes(s as never) ? (s as "draft" | "visible" | "hidden") : "draft";
}

// ═══════════════════════════════════════════════════════════════════════════
// GALLERY ALBUMS
// ═══════════════════════════════════════════════════════════════════════════
router.get("/cms/albums", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  const trash = req.query.trash === "1";
  try {
    const categoryId = req.query.categoryId ? +req.query.categoryId : null;
    const includeDescendants = req.query.includeDescendants !== "0";
    const conds: string[] = [trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
    const params: unknown[] = [];
    if (categoryId !== null && !Number.isNaN(categoryId)) {
      if (includeDescendants) {
        const ids = await pool.query(
          `WITH RECURSIVE descendants AS (
             SELECT id FROM cms_categories WHERE id = $1
             UNION ALL
             SELECT c.id FROM cms_categories c JOIN descendants d ON c.parent_id = d.id
              WHERE c.deleted_at IS NULL
           )
           SELECT id FROM descendants`,
          [categoryId]
        );
        const allIds = (ids.rows as Array<{ id: number }>).map(r => r.id);
        params.push(allIds);
        conds.push(`category_id = ANY($${params.length}::int[])`);
      } else {
        params.push(categoryId);
        conds.push(`category_id = $${params.length}`);
      }
    }
    const r = await pool.query(
      `SELECT id, name, slug, description, cover_image_url AS "coverImageUrl",
              status, sort_order AS "sortOrder", category_id AS "categoryId",
              tags_text AS "tagsText", deleted_at AS "deletedAt", created_at AS "createdAt"
       FROM gallery_albums WHERE ${conds.join(" AND ")}
       ORDER BY sort_order ASC, id DESC`,
      params
    );
    const rows = r.rows as Array<{ id: number }>;
    // Photo counts
    const counts = await pool.query(
      `SELECT album_id, COUNT(*)::int AS c FROM gallery_photos WHERE deleted_at IS NULL GROUP BY album_id`
    );
    const cmap = new Map<number, number>();
    for (const x of counts.rows as Array<{ album_id: number; c: number }>) cmap.set(x.album_id, x.c);
    res.json(rows.map(a => ({ ...a, photoCount: cmap.get(a.id) ?? 0 })));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/cms/albums", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const { name, slug, description, coverImageUrl, status, sortOrder, categoryId, tagsText } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: "Thiếu tên album" });
    // Validate categoryId nếu có: phải là integer dương, tồn tại, type='gallery', chưa xoá
    if (categoryId != null) {
      const cid = Number(categoryId);
      if (!Number.isInteger(cid) || cid <= 0) {
        return res.status(400).json({ error: "categoryId không hợp lệ" });
      }
      const c = await pool.query(
        `SELECT type, deleted_at FROM cms_categories WHERE id = $1`, [cid]
      );
      if (!c.rows.length) return res.status(400).json({ error: "Danh mục không tồn tại" });
      const crow = c.rows[0] as { type: string; deleted_at: Date | null };
      if (crow.deleted_at) return res.status(400).json({ error: "Danh mục đã bị xoá" });
      if (crow.type !== "gallery") return res.status(400).json({ error: "Danh mục phải là loại Bộ ảnh" });
    }
    const [row] = await db.insert(galleryAlbumsTable).values({
      name: name.trim(),
      slug: slug ?? null,
      description: description ?? null,
      coverImageUrl: coverImageUrl ?? null,
      status: normStatus(status ?? "draft"),
      sortOrder: Number(sortOrder ?? 0),
      categoryId: categoryId == null ? null : +categoryId,
      tagsText: tagsText ?? null,
    }).returning();
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.patch("/cms/albums/:id", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const id = +req.params.id;
    const { name, slug, description, coverImageUrl, status, sortOrder, categoryId, tagsText } = req.body ?? {};
    const upd: Record<string, unknown> = {};
    if (name !== undefined) upd.name = String(name).trim();
    if (slug !== undefined) upd.slug = slug;
    if (description !== undefined) upd.description = description;
    if (coverImageUrl !== undefined) upd.coverImageUrl = coverImageUrl;
    if (status !== undefined) upd.status = normStatus(status);
    if (sortOrder !== undefined) upd.sortOrder = Number(sortOrder);
    if (tagsText !== undefined) upd.tagsText = tagsText;
    if (categoryId !== undefined) {
      if (categoryId != null) {
        const cid = Number(categoryId);
        if (!Number.isInteger(cid) || cid <= 0) {
          return res.status(400).json({ error: "categoryId không hợp lệ" });
        }
        const c = await pool.query(
          `SELECT type, deleted_at FROM cms_categories WHERE id = $1`, [cid]
        );
        if (!c.rows.length) return res.status(400).json({ error: "Danh mục không tồn tại" });
        const crow = c.rows[0] as { type: string; deleted_at: Date | null };
        if (crow.deleted_at) return res.status(400).json({ error: "Danh mục đã bị xoá" });
        if (crow.type !== "gallery") return res.status(400).json({ error: "Danh mục phải là loại Bộ ảnh" });
        upd.categoryId = cid;
      } else {
        upd.categoryId = null;
      }
    }
    if (!Object.keys(upd).length) return res.json({ ok: true });
    const [row] = await db.update(galleryAlbumsTable).set(upd as never).where(eq(galleryAlbumsTable.id, id)).returning();
    res.json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete("/cms/albums/:id", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    await db.update(galleryAlbumsTable).set({ deletedAt: new Date() })
      .where(eq(galleryAlbumsTable.id, +req.params.id));
    // Soft-delete all photos inside
    await pool.query(`UPDATE gallery_photos SET deleted_at = NOW() WHERE album_id = $1 AND deleted_at IS NULL`,
      [+req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/cms/albums/:id/restore", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    await db.update(galleryAlbumsTable).set({ deletedAt: null })
      .where(eq(galleryAlbumsTable.id, +req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete("/cms/albums/:id/purge", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await pool.query(`DELETE FROM gallery_photos WHERE album_id = $1`, [+req.params.id]);
    await pool.query(`DELETE FROM gallery_albums WHERE id = $1`, [+req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.patch("/cms/albums/reorder", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    const order = req.body?.order as Array<{ id: number; sortOrder: number }>;
    if (!Array.isArray(order)) return res.status(400).json({ error: "order phải là mảng" });
    for (const o of order) {
      await pool.query(`UPDATE gallery_albums SET sort_order = $1 WHERE id = $2`, [o.sortOrder, o.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// GALLERY PHOTOS — cursor pagination
// ═══════════════════════════════════════════════════════════════════════════
router.get("/cms/albums/:id/photos", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const albumId = +req.params.id;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "30"), 10) || 30));
    const cursor = req.query.cursor ? parseInt(String(req.query.cursor), 10) : null;
    const trash = req.query.trash === "1";
    const trashFilter = trash ? "AND deleted_at IS NOT NULL" : "AND deleted_at IS NULL";
    const cursorFilter = cursor !== null ? "AND id > $3" : "";
    const params: unknown[] = [albumId, limit + 1];
    if (cursor !== null) params.push(cursor);
    const q = `SELECT id, album_id AS "albumId", image_url AS "imageUrl", caption, mime_type AS "mimeType",
      status, sort_order AS "sortOrder", deleted_at AS "deletedAt", created_at AS "createdAt"
      FROM gallery_photos WHERE album_id = $1 ${trashFilter} ${cursorFilter}
      ORDER BY sort_order ASC, id ASC LIMIT $2`;
    const r = await pool.query(q, params);
    const rows = r.rows as Array<{ id: number }>;
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    res.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/cms/albums/:id/photos", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const albumId = +req.params.id;
    const photos = (req.body?.photos ?? [req.body]) as Array<{
      imageUrl: string; caption?: string; mimeType?: string;
    }>;
    if (!Array.isArray(photos) || !photos.length) {
      return res.status(400).json({ error: "Thiếu danh sách ảnh" });
    }
    // Determine next sort_order
    const maxR = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0)::int AS m FROM gallery_photos WHERE album_id = $1`,
      [albumId]
    );
    let next = (maxR.rows[0] as { m: number }).m + 1;
    const inserted = await db.insert(galleryPhotosTable).values(
      photos.filter(p => p.imageUrl).map(p => ({
        albumId,
        imageUrl: p.imageUrl,
        caption: p.caption ?? null,
        mimeType: p.mimeType ?? null,
        status: "visible" as const,
        sortOrder: next++,
      }))
    ).returning();
    res.status(201).json(inserted);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.patch("/cms/photos/:id", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const { caption, status, sortOrder } = req.body ?? {};
    const upd: Record<string, unknown> = {};
    if (caption !== undefined) upd.caption = caption;
    if (status !== undefined) upd.status = normStatus(status);
    if (sortOrder !== undefined) upd.sortOrder = Number(sortOrder);
    if (!Object.keys(upd).length) return res.json({ ok: true });
    const [row] = await db.update(galleryPhotosTable).set(upd as never)
      .where(eq(galleryPhotosTable.id, +req.params.id)).returning();
    res.json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete("/cms/photos/:id", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    await db.update(galleryPhotosTable).set({ deletedAt: new Date(), status: "hidden" })
      .where(eq(galleryPhotosTable.id, +req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/cms/photos/:id/restore", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    await db.update(galleryPhotosTable).set({ deletedAt: null }).where(eq(galleryPhotosTable.id, +req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete("/cms/photos/:id/purge", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await pool.query(`DELETE FROM gallery_photos WHERE id = $1`, [+req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Đặt ảnh/video làm bìa album
router.post("/cms/albums/:id/cover", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const albumId = +req.params.id;
    const { imageUrl, photoId } = (req.body ?? {}) as { imageUrl?: string; photoId?: number };
    let url = imageUrl;
    if (!url && photoId) {
      const p = await pool.query(
        `SELECT image_url FROM gallery_photos
          WHERE id = $1 AND album_id = $2 AND deleted_at IS NULL`,
        [+photoId, albumId]
      );
      if (!p.rows.length) return res.status(404).json({ error: "Ảnh không tồn tại trong album" });
      url = (p.rows[0] as { image_url: string }).image_url;
    }
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Thiếu imageUrl hoặc photoId" });
    }
    const [row] = await db.update(galleryAlbumsTable)
      .set({ coverImageUrl: url })
      .where(eq(galleryAlbumsTable.id, albumId))
      .returning();
    if (!row) return res.status(404).json({ error: "Album không tồn tại" });
    res.json({ ok: true, coverImageUrl: url });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Capability probe: video upload có hoạt động với App Storage không?
router.get("/cms/capabilities", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  const hasStorage = Boolean(
    process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID &&
    process.env.PRIVATE_OBJECT_DIR
  );
  res.json({
    videoUpload: hasStorage,
    videoMaxSizeMb: 100,
    videoAllowedMimes: ["video/mp4", "video/webm", "video/quicktime"],
  });
});

router.patch("/cms/photos/reorder", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const order = req.body?.order as Array<{ id: number; sortOrder: number }>;
    if (!Array.isArray(order)) return res.status(400).json({ error: "order phải là mảng" });
    for (const o of order) {
      await pool.query(`UPDATE gallery_photos SET sort_order = $1 WHERE id = $2`, [o.sortOrder, o.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORIES (taxonomy: dress/service/gallery)
// ═══════════════════════════════════════════════════════════════════════════
// Trả về flat list cây với productCount + coverImageUrl fallback.
// productCount tính đệ quy qua tất cả descendants.
router.get("/cms/categories", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const type = req.query.type ? String(req.query.type) : null;
    const trash = req.query.trash === "1";
    const params: unknown[] = [];
    const conds: string[] = [trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
    if (type) { params.push(type); conds.push(`type = $${params.length}`); }
    const r = await pool.query(
      `SELECT id, type, parent_id AS "parentId", name, slug,
              cover_image_url AS "coverImageUrl",
              sort_order AS "sortOrder", is_active AS "isActive",
              deleted_at AS "deletedAt", created_at AS "createdAt"
       FROM cms_categories
       WHERE ${conds.join(" AND ")}
       ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC`,
      params
    );
    type Row = {
      id: number; type: string; parentId: number | null; name: string; slug: string | null;
      coverImageUrl: string | null; sortOrder: number; isActive: number;
      deletedAt: Date | null; createdAt: Date;
      productCount: number; fallbackCover?: string | null;
    };
    const rows = r.rows as Row[];
    // ── product/album counts theo descendants (recursive CTE) ─────────────
    if (rows.length) {
      const ids = rows.map(x => x.id);
      // Bảng item theo loại danh mục: gallery → albums, idea → photo_ideas, còn lại → dresses
      const entity = type === "gallery"
        ? { table: "gallery_albums", img: "x.cover_image_url" }
        : type === "idea"
          ? { table: "photo_ideas", img: "COALESCE(x.cover_image_url, x.public_image_url, x.image_url)" }
          : { table: "dresses", img: "COALESCE(x.cover_image_url, x.public_image_url, x.image_url)" };
      const cnt = await pool.query(
        `WITH RECURSIVE descendants AS (
           SELECT id AS root_id, id FROM cms_categories WHERE id = ANY($1::int[])
           UNION ALL
           SELECT d.root_id, c.id
             FROM cms_categories c JOIN descendants d ON c.parent_id = d.id
            WHERE c.deleted_at IS NULL
         )
         SELECT d.root_id, COUNT(x.id)::int AS c
           FROM descendants d
           LEFT JOIN ${entity.table} x
             ON x.category_id = d.id
            AND x.deleted_at IS NULL
          GROUP BY d.root_id`,
        [ids]
      );
      const cmap = new Map<number, number>();
      for (const x of cnt.rows as Array<{ root_id: number; c: number }>) cmap.set(x.root_id, x.c);
      // Fallback cover ảnh
      const cov = await pool.query(
        `WITH RECURSIVE descendants AS (
           SELECT id AS root_id, id FROM cms_categories WHERE id = ANY($1::int[])
           UNION ALL
           SELECT d.root_id, c.id
             FROM cms_categories c JOIN descendants d ON c.parent_id = d.id
            WHERE c.deleted_at IS NULL
         )
         SELECT DISTINCT ON (d.root_id) d.root_id, ${entity.img} AS img
           FROM descendants d
           JOIN ${entity.table} x ON x.category_id = d.id
                                  AND x.deleted_at IS NULL
                                  AND ${entity.img} IS NOT NULL
          ORDER BY d.root_id, x.id ASC`,
        [ids]
      );
      const imap = new Map<number, string>();
      for (const x of cov.rows as Array<{ root_id: number; img: string }>) imap.set(x.root_id, x.img);
      for (const row of rows) {
        row.productCount = cmap.get(row.id) ?? 0;
        if (!row.coverImageUrl) row.fallbackCover = imap.get(row.id) ?? null;
      }
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/cms/categories", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const { type, parentId, name, slug, coverImageUrl, sortOrder } = req.body ?? {};
    if (!type || !name?.trim()) return res.status(400).json({ error: "Thiếu type hoặc tên" });
    if (!["dress", "service", "gallery", "idea"].includes(type)) {
      return res.status(400).json({ error: "type không hợp lệ" });
    }
    // Nếu có parentId thì kiểm tra cùng type
    if (parentId != null) {
      const p = await pool.query(`SELECT type FROM cms_categories WHERE id = $1`, [+parentId]);
      if (!p.rows.length) return res.status(400).json({ error: "Mục cha không tồn tại" });
      if ((p.rows[0] as { type: string }).type !== type) {
        return res.status(400).json({ error: "Mục cha khác loại" });
      }
    }
    // Tính sortOrder nếu chưa truyền: max+1 trong cùng nhóm cha
    let order = Number(sortOrder ?? 0);
    if (!order) {
      const mx = await pool.query(
        `SELECT COALESCE(MAX(sort_order), 0)::int AS m FROM cms_categories
         WHERE type = $1 AND ${parentId == null ? "parent_id IS NULL" : "parent_id = $2"}`,
        parentId == null ? [type] : [type, +parentId]
      );
      order = (mx.rows[0] as { m: number }).m + 1;
    }
    const [row] = await db.insert(cmsCategoriesTable).values({
      type,
      parentId: parentId == null ? null : +parentId,
      name: name.trim(),
      slug: slug ?? null,
      coverImageUrl: coverImageUrl ?? null,
      sortOrder: order,
    }).returning();
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.patch("/cms/categories/:id", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const { name, slug, sortOrder, isActive, parentId, coverImageUrl } = req.body ?? {};
    const upd: Record<string, unknown> = {};
    if (name !== undefined) upd.name = String(name).trim();
    if (slug !== undefined) upd.slug = slug;
    if (sortOrder !== undefined) upd.sortOrder = Number(sortOrder);
    if (isActive !== undefined) upd.isActive = isActive ? 1 : 0;
    if (parentId !== undefined) {
      const id = +req.params.id;
      if (parentId === id) return res.status(400).json({ error: "Không thể tự làm cha chính nó" });
      if (parentId != null) {
        // Validate: parentId phải tồn tại, chưa xoá, cùng type với chính mình
        const cur = await pool.query(
          `SELECT type FROM cms_categories WHERE id = $1 AND deleted_at IS NULL`, [id]
        );
        if (!cur.rows.length) return res.status(404).json({ error: "Mục không tồn tại" });
        const p = await pool.query(
          `SELECT type, deleted_at FROM cms_categories WHERE id = $1`, [+parentId]
        );
        if (!p.rows.length) return res.status(400).json({ error: "Mục cha không tồn tại" });
        const prow = p.rows[0] as { type: string; deleted_at: Date | null };
        if (prow.deleted_at) return res.status(400).json({ error: "Mục cha đã bị xoá" });
        if (prow.type !== (cur.rows[0] as { type: string }).type) {
          return res.status(400).json({ error: "Mục cha khác loại" });
        }
        // Cấm chuyển vào chính descendants
        const cyc = await pool.query(
          `WITH RECURSIVE descendants AS (
             SELECT id FROM cms_categories WHERE id = $1
             UNION ALL
             SELECT c.id FROM cms_categories c JOIN descendants d ON c.parent_id = d.id
           )
           SELECT 1 FROM descendants WHERE id = $2`,
          [id, +parentId]
        );
        if (cyc.rows.length) return res.status(400).json({ error: "Không thể chuyển vào mục con của chính mình" });
      }
      upd.parentId = parentId == null ? null : +parentId;
    }
    if (coverImageUrl !== undefined) upd.coverImageUrl = coverImageUrl;
    if (!Object.keys(upd).length) return res.json({ ok: true });
    const [row] = await db.update(cmsCategoriesTable).set(upd as never)
      .where(eq(cmsCategoriesTable.id, +req.params.id)).returning();
    res.json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Soft-delete đệ quy: con cháu cũng vào thùng rác.
// Sản phẩm bị bỏ link (category_id = NULL) — KHÔNG xoá sản phẩm.
router.delete("/cms/categories/:id", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const id = +req.params.id;
    const ids = await pool.query(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM cms_categories WHERE id = $1
         UNION ALL
         SELECT c.id FROM cms_categories c JOIN descendants d ON c.parent_id = d.id
       )
       SELECT id FROM descendants`,
      [id]
    );
    const allIds = (ids.rows as Array<{ id: number }>).map(r => r.id);
    if (allIds.length) {
      await pool.query(
        `UPDATE cms_categories SET deleted_at = NOW()
          WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
        [allIds]
      );
      await pool.query(
        `UPDATE dresses SET category_id = NULL WHERE category_id = ANY($1::int[])`,
        [allIds]
      );
      await pool.query(
        `UPDATE gallery_albums SET category_id = NULL WHERE category_id = ANY($1::int[])`,
        [allIds]
      );
    }
    res.json({ ok: true, affected: allIds.length });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Quick-add sản phẩm vào 1 mục danh mục.
router.post("/cms/categories/:id/products", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const catId = +req.params.id;
    const cat = await pool.query(
      `SELECT id, type, name FROM cms_categories WHERE id = $1 AND deleted_at IS NULL`,
      [catId]
    );
    if (!cat.rows.length) return res.status(404).json({ error: "Mục không tồn tại" });
    const catRow = cat.rows[0] as { id: number; type: string; name: string };
    if (catRow.type !== "dress") {
      return res.status(400).json({ error: "Chỉ mục loại 'dress' mới có sản phẩm" });
    }
    const { name, color = "", size = "Free size", rentalPrice = 0, depositRequired = 0,
            imageUrl = null, publicImageUrl = null, isPublic = true,
            extraImages = [] } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: "Thiếu tên sản phẩm" });

    // Auto-gen code dạng D-<catId>-<count+1>
    const cnt = await pool.query(
      `SELECT COUNT(*)::int AS c FROM dresses WHERE category_id = $1`, [catId]
    );
    const code = `D-${catId}-${(cnt.rows[0] as { c: number }).c + 1}`;
    const extraImagesJson = Array.isArray(extraImages) && extraImages.length > 0
      ? JSON.stringify(extraImages) : null;
    const r = await pool.query(
      `INSERT INTO dresses
         (code, name, category, category_id, color, size, rental_price, deposit_required,
          image_url, public_image_url, is_public, cms_status, extra_images)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'visible',$12)
       RETURNING id, code, name, category_id AS "categoryId", image_url AS "imageUrl"`,
      [code, name.trim(), catRow.name, catId, color, size,
       String(rentalPrice), String(depositRequired),
       imageUrl, publicImageUrl, isPublic ? 1 : 0,
       extraImagesJson]
    );
    const newId = (r.rows[0] as { id: number }).id;
    await pool.query(`UPDATE dresses SET slug = 'sp-' || id WHERE id = $1 AND slug IS NULL`, [newId]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/cms/categories/:id/restore", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    await db.update(cmsCategoriesTable).set({ deletedAt: null })
      .where(eq(cmsCategoriesTable.id, +req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete("/cms/categories/:id/purge", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    await pool.query(`DELETE FROM cms_categories WHERE id = $1`, [+req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});


// GET /api/cms/dresses/duplicate-codes — kiểm tra mã sản phẩm trùng (admin, read-only)
router.get("/cms/dresses/duplicate-codes", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(`
      SELECT LOWER(code) AS code, COUNT(*)::int AS count,
             array_agg(id ORDER BY id) AS ids,
             array_agg(name ORDER BY id) AS names
        FROM dresses
       WHERE deleted_at IS NULL AND code IS NOT NULL AND code != ''
       GROUP BY LOWER(code)
      HAVING COUNT(*) > 1
       ORDER BY count DESC, code ASC
    `);
    res.json({ duplicates: r.rows, total: r.rows.length });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Task #510: Bulk move/update/delete dresses ──────────────────────────────
// PATCH /api/cms/dresses/bulk-category — chỉ đổi categoryId (+ trường text category đồng bộ)
router.patch("/cms/dresses/bulk-category", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    const { ids, categoryId } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Thiếu danh sách sản phẩm" });
    }
    const intIds = [...new Set(ids.map(Number).filter(n => Number.isFinite(n) && n > 0))];
    if (intIds.length === 0) return res.status(400).json({ error: "ids không hợp lệ" });

    let catName: string | null = null;
    let targetCatId: number | null = null;
    if (categoryId != null) {
      targetCatId = +categoryId;
      const cat = await pool.query(
        `SELECT id, type, name FROM cms_categories WHERE id = $1 AND deleted_at IS NULL`,
        [targetCatId]
      );
      if (!cat.rows.length) return res.status(404).json({ error: "Mục đích không tồn tại" });
      const row = cat.rows[0] as { id: number; type: string; name: string };
      if (row.type !== "dress") return res.status(400).json({ error: "Mục đích không phải loại sản phẩm" });
      catName = row.name;
    }

    // categoryId=null -> clear category text too (avoid stale label)
    const r = await pool.query(
      `UPDATE dresses
          SET category_id = $1,
              category    = $2
        WHERE id = ANY($3::int[])
          AND deleted_at IS NULL
      RETURNING id, category_id AS "categoryId"`,
      [targetCatId, catName ?? "", intIds]
    );
    const movedIds = (r.rows as Array<{ id: number }>).map(x => x.id);
    if (movedIds.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy sản phẩm để chuyển", affected: 0 });
    }
    res.json({ ok: true, affected: movedIds.length, ids: movedIds, targetCategoryId: targetCatId });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PATCH /api/cms/dresses/bulk-status — đổi rental_status hàng loạt
router.patch("/cms/dresses/bulk-status", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    const { ids, rentalStatus } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Thiếu danh sách sản phẩm" });
    }
    const intIds = ids.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (intIds.length === 0) return res.status(400).json({ error: "ids không hợp lệ" });
    const allowed = ["san_sang", "dang_cho_thue", "giu_do", "ngung_cho_thue"];
    if (!allowed.includes(String(rentalStatus))) {
      return res.status(400).json({ error: "Trạng thái không hợp lệ" });
    }
    const isAvail = rentalStatus === "san_sang";
    const r = await pool.query(
      `UPDATE dresses
          SET rental_status = $1,
              is_available = $2
        WHERE id = ANY($3::int[])
          AND deleted_at IS NULL
      RETURNING id`,
      [rentalStatus, isAvail, intIds]
    );
    res.json({ ok: true, affected: r.rowCount ?? 0 });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PATCH /api/cms/products/bulk-priority — bật/tắt "Ưu tiên hiển thị" hàng loạt (admin)
// Bật: is_priority=true, priority_at=now(). Tắt: is_priority=false, priority_at=null.
// Không đụng category / ảnh / giá / trạng thái.
async function handleBulkPriority(req: Request, res: Response) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { ids, isPriority } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Thiếu danh sách sản phẩm" });
    }
    if (typeof isPriority !== "boolean") {
      return res.status(400).json({ error: "isPriority phải là boolean" });
    }
    const intIds = [...new Set(ids.map(Number).filter(n => Number.isFinite(n) && n > 0))];
    if (intIds.length === 0) return res.status(400).json({ error: "ids không hợp lệ" });
    const r = await pool.query(
      `UPDATE dresses
          SET is_priority = $1,
              priority_at = CASE WHEN $1 THEN now() ELSE NULL END
        WHERE id = ANY($2::int[])
          AND deleted_at IS NULL
      RETURNING id`,
      [isPriority, intIds]
    );
    res.json({ ok: true, affected: r.rowCount ?? 0, isPriority });
  } catch (e) { res.status(500).json({ error: String(e) }); }
}
router.patch("/cms/products/bulk-priority", handleBulkPriority);
router.patch("/cms/dresses/bulk-priority", handleBulkPriority);


function albumImagesFromRow(d: Record<string, unknown>): string[] {
  const imgs: string[] = [];
  const primary = d.image_url as string | null;
  if (primary) imgs.push(primary);
  let extra: string[] = [];
  try { if (d.extra_images) extra = JSON.parse(d.extra_images as string); } catch {}
  for (const x of extra) { if (x && !imgs.includes(x)) imgs.push(x); }
  return imgs;
}

function buildImageUpdateAfterRemove(row: Record<string, unknown>, toRemove: Set<string>) {
  const remaining = albumImagesFromRow(row).filter(x => !toRemove.has(x));
  const cover = row.cover_image_url as string | null;
  const pub = row.public_image_url as string | null;
  return {
    image_url: remaining[0] ?? null,
    extra_images: remaining.length > 1 ? JSON.stringify(remaining.slice(1)) : null,
    cover_image_url: cover && toRemove.has(cover) ? null : cover,
    public_image_url: pub && toRemove.has(pub) ? null : pub,
  };
}

function fmtDressImages(row: Record<string, unknown>) {
  let extraImages: string[] = [];
  try { if (row.extra_images) extraImages = JSON.parse(row.extra_images as string); } catch {}
  return {
    imageUrl: row.image_url ?? null,
    publicImageUrl: row.public_image_url ?? null,
    coverImageUrl: row.cover_image_url ?? null,
    extraImages,
  };
}

async function bulkDeleteDresses(req: import("express").Request, res: import("express").Response) {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Thiếu danh sách sản phẩm" });
    }
    const intIds = [...new Set(ids.map(Number).filter(n => Number.isFinite(n) && n > 0))];
    if (intIds.length === 0) return res.status(400).json({ error: "ids không hợp lệ" });
    const r = await pool.query(
      `DELETE FROM dresses WHERE id = ANY($1::int[]) RETURNING id`,
      [intIds]
    );
    const deletedIds = (r.rows as Array<{ id: number }>).map(x => x.id);
    if (deletedIds.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy sản phẩm để xoá", affected: 0 });
    }
    res.json({ ok: true, affected: deletedIds.length, ids: deletedIds });
  } catch (e) { res.status(500).json({ error: String(e) }); }
}

// DELETE /api/cms/dresses/bulk — xoá vĩnh viễn hàng loạt (UPDATE, không soft-delete)
router.delete("/cms/dresses/bulk", bulkDeleteDresses);
// POST alias — tránh một số client/proxy làm mất body DELETE
router.post("/cms/dresses/bulk-delete", bulkDeleteDresses);

// DELETE /api/cms/product-images/batch — xoá nhiều ảnh album của 1 sản phẩm
router.delete("/cms/product-images/batch", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    const { dressId, images } = req.body ?? {};
    if (!dressId || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "Thiếu dressId hoặc danh sách ảnh" });
    }
    const removeSet = new Set(
      images.filter((x: unknown): x is string => typeof x === "string" && !!x)
    );
    if (removeSet.size === 0) return res.status(400).json({ error: "Danh sách ảnh không hợp lệ" });

    const existing = await pool.query(
      `SELECT * FROM dresses WHERE id = $1 AND deleted_at IS NULL`, [+dressId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: "Không tìm thấy sản phẩm" });
    const row = existing.rows[0] as Record<string, unknown>;
    const matched = albumImagesFromRow(row).filter(x => removeSet.has(x));
    if (matched.length === 0) {
      return res.status(400).json({ error: "Không có ảnh nào khớp để xoá" });
    }

    const upd = buildImageUpdateAfterRemove(row, new Set(matched));
    await pool.query(
      `UPDATE dresses SET image_url = $1, extra_images = $2, cover_image_url = $3, public_image_url = $4
       WHERE id = $5`,
      [upd.image_url, upd.extra_images, upd.cover_image_url, upd.public_image_url, +dressId]
    );
    res.json({ ok: true, affected: matched.length, dressId: +dressId, ...fmtDressImages({ ...row, ...upd }) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/cms/product-images/move-batch — chuyển ảnh sang sản phẩm khác
router.post("/cms/product-images/move-batch", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  const client = await pool.connect();
  try {
    const { sourceDressId, targetDressId, images } = req.body ?? {};
    if (!sourceDressId || !targetDressId || +sourceDressId === +targetDressId
        || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "Thiếu thông tin hoặc sản phẩm nguồn/đích không hợp lệ" });
    }
    const moveSet = new Set(
      images.filter((x: unknown): x is string => typeof x === "string" && !!x)
    );
    const MAX = 20;

    await client.query("BEGIN");
    const srcR = await client.query(
      `SELECT * FROM dresses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [+sourceDressId]
    );
    const tgtR = await client.query(
      `SELECT * FROM dresses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [+targetDressId]
    );
    if (!srcR.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Không tìm thấy sản phẩm nguồn" });
    }
    if (!tgtR.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Không tìm thấy sản phẩm đích" });
    }

    const src = srcR.rows[0] as Record<string, unknown>;
    const tgt = tgtR.rows[0] as Record<string, unknown>;
    const toMove = albumImagesFromRow(src).filter(x => moveSet.has(x));
    if (toMove.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Không có ảnh nào khớp để chuyển" });
    }

    const tgtAlbum = albumImagesFromRow(tgt);
    const newForTarget = toMove.filter(x => !tgtAlbum.includes(x));
    if (tgtAlbum.length + newForTarget.length > MAX) {
      await client.query("ROLLBACK");
      const free = MAX - tgtAlbum.length;
      return res.status(400).json({
        error: free <= 0
          ? "Sản phẩm đích đã đủ 20 ảnh"
          : `Sản phẩm đích chỉ còn chỗ cho ${free} ảnh`,
      });
    }

    const srcUpd = buildImageUpdateAfterRemove(src, new Set(toMove));
    const merged = [...tgtAlbum, ...newForTarget];

    await client.query(
      `UPDATE dresses SET image_url = $1, extra_images = $2, cover_image_url = $3, public_image_url = $4 WHERE id = $5`,
      [srcUpd.image_url, srcUpd.extra_images, srcUpd.cover_image_url, srcUpd.public_image_url, +sourceDressId]
    );
    await client.query(
      `UPDATE dresses SET image_url = $1, extra_images = $2 WHERE id = $3`,
      [merged[0] ?? null, merged.length > 1 ? JSON.stringify(merged.slice(1)) : null, +targetDressId]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      moved: toMove.length,
      sourceDressId: +sourceDressId,
      targetDressId: +targetDressId,
      source: fmtDressImages({ ...src, ...srcUpd }),
    });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: String(e) });
  } finally {
    client.release();
  }
});


// POST /api/cms/categories/:id/move-children
// Move toàn bộ sản phẩm đang gắn TRỰC TIẾP vào :id sang targetCategoryId
// (target PHẢI là descendant của source — enforce bằng recursive CTE).
router.post("/cms/categories/:id/move-children", async (req, res) => {
  if (!(await requireCmsStaff(req, res))) return;
  try {
    const sourceId = +req.params.id;
    const { targetCategoryId } = req.body ?? {};
    if (!targetCategoryId || +targetCategoryId === sourceId) {
      return res.status(400).json({ error: "Mục đích không hợp lệ" });
    }
    const targetId = +targetCategoryId;
    const both = await pool.query(
      `SELECT id, type, name FROM cms_categories
        WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
      [[sourceId, targetId]]
    );
    const rows = both.rows as Array<{ id: number; type: string; name: string }>;
    const src = rows.find(r => r.id === sourceId);
    const dst = rows.find(r => r.id === targetId);
    if (!src) return res.status(404).json({ error: "Danh mục nguồn không tồn tại" });
    if (!dst) return res.status(404).json({ error: "Danh mục đích không tồn tại" });
    if (src.type !== "dress" || dst.type !== "dress") {
      return res.status(400).json({ error: "Chỉ áp dụng cho danh mục sản phẩm" });
    }
    // Đảm bảo target nằm trong descendants của source
    const desc = await pool.query(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM cms_categories WHERE parent_id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT c.id FROM cms_categories c
           JOIN descendants d ON c.parent_id = d.id
          WHERE c.deleted_at IS NULL
       )
       SELECT 1 FROM descendants WHERE id = $2 LIMIT 1`,
      [sourceId, targetId]
    );
    if (!desc.rows.length) {
      return res.status(400).json({ error: "Mục đích phải là mục con (hoặc cháu) của mục nguồn" });
    }
    const r = await pool.query(
      `UPDATE dresses
          SET category_id = $1,
              category    = $2
        WHERE category_id = $3
          AND deleted_at IS NULL
      RETURNING id`,
      [targetId, dst.name, sourceId]
    );
    res.json({ ok: true, affected: r.rowCount ?? 0, targetCategoryId: targetId });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.patch("/cms/categories/reorder", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const order = req.body?.order as Array<{ id: number; sortOrder: number }>;
    if (!Array.isArray(order)) return res.status(400).json({ error: "order phải là mảng" });
    for (const o of order) {
      await pool.query(`UPDATE cms_categories SET sort_order = $1 WHERE id = $2`, [o.sortOrder, o.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TOGGLES — wrap existing dresses + service_packages
// (chỉ admin được toggle is_public; nhân viên có thể đổi cms_status sang draft)
// ═══════════════════════════════════════════════════════════════════════════

// GET list with CMS fields included
router.get("/cms/rentals", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const r = await pool.query(`
      SELECT id, code, name, category, color, size, rental_price AS "rentalPrice",
             image_url AS "imageUrl", public_image_url AS "publicImageUrl",
             is_public AS "isPublic", cms_status AS "cmsStatus",
             deleted_at AS "deletedAt"
      FROM dresses WHERE deleted_at IS NULL ORDER BY name ASC`);
    res.json(r.rows.map(row => ({
      ...row,
      rentalPrice: parseFloat(row.rentalPrice),
      isPublic: row.isPublic === 1,
    })));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.patch("/cms/rentals/:id", async (req, res) => {
  const role = await requireAuth(req, res);
  if (!role) return;
  try {
    void role; // mọi nhân viên đã đăng nhập đều được bật/tắt public + đặt trạng thái
    const { isPublic, cmsStatus, publicImageUrl } = req.body ?? {};
    const upd: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (isPublic !== undefined) {
      upd.push(`is_public = $${i++}`); vals.push(isPublic ? 1 : 0);
    }
    if (cmsStatus !== undefined) {
      const s = normStatus(cmsStatus);
      upd.push(`cms_status = $${i++}`); vals.push(s);
    }
    if (publicImageUrl !== undefined) { upd.push(`public_image_url = $${i++}`); vals.push(publicImageUrl); }
    if (!upd.length) return res.json({ ok: true });
    vals.push(+req.params.id);
    await pool.query(`UPDATE dresses SET ${upd.join(", ")} WHERE id = $${i}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get("/cms/packages", async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  try {
    const r = await pool.query(`
      SELECT p.id, p.code, p.name, p.price, p.group_id AS "groupId",
             g.name AS "groupName",
             p.short_description AS "shortDescription",
             p.is_public AS "isPublic", p.cms_status AS "cmsStatus"
      FROM service_packages p
      LEFT JOIN service_groups g ON g.id = p.group_id
      WHERE p.deleted_at IS NULL
      ORDER BY g.sort_order ASC NULLS LAST, p.sort_order ASC`);
    res.json(r.rows.map(row => ({
      ...row,
      price: parseFloat(row.price),
      isPublic: row.isPublic === 1,
    })));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.patch("/cms/packages/:id", async (req, res) => {
  const role = await requireAuth(req, res);
  if (!role) return;
  try {
    void role; // mọi nhân viên đã đăng nhập đều được bật/tắt public, đặt trạng thái và sửa giá
    const { isPublic, cmsStatus, shortDescription, price } = req.body ?? {};
    const upd: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (isPublic !== undefined) {
      upd.push(`is_public = $${i++}`); vals.push(isPublic ? 1 : 0);
    }
    if (cmsStatus !== undefined) {
      const s = normStatus(cmsStatus);
      upd.push(`cms_status = $${i++}`); vals.push(s);
    }
    if (shortDescription !== undefined) {
      upd.push(`short_description = $${i++}`); vals.push(shortDescription);
    }
    if (price !== undefined) {
      upd.push(`price = $${i++}`); vals.push(String(price));
    }
    if (!upd.length) return res.json({ ok: true });
    vals.push(+req.params.id);
    await pool.query(`UPDATE service_packages SET ${upd.join(", ")} WHERE id = $${i}`, vals);
    clearSaleContextCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS — không cần auth, dùng cho /cho-thue-do
// ═══════════════════════════════════════════════════════════════════════════
router.get("/cms/public/categories/dress/tree", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, parent_id AS "parentId", name, slug,
              cover_image_url AS "coverImageUrl",
              sort_order AS "sortOrder"
         FROM cms_categories
        WHERE type = 'dress' AND deleted_at IS NULL AND is_active = 1
        ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC`
    );
    const rows = r.rows as Array<{ id: number; parentId: number | null; name: string;
      slug: string | null; coverImageUrl: string | null; sortOrder: number;
      productCount?: number; fallbackCover?: string | null }>;
    if (rows.length) {
      const ids = rows.map(x => x.id);
      const cnt = await pool.query(
        `WITH RECURSIVE descendants AS (
           SELECT id AS root_id, id FROM cms_categories WHERE id = ANY($1::int[])
           UNION ALL
           SELECT d.root_id, c.id FROM cms_categories c
             JOIN descendants d ON c.parent_id = d.id
            WHERE c.deleted_at IS NULL
         )
         SELECT d.root_id, COUNT(dr.id)::int AS c
           FROM descendants d
           LEFT JOIN dresses dr
             ON dr.category_id = d.id
            AND dr.deleted_at IS NULL
            AND dr.is_public = 1
            AND dr.cms_status = 'visible'
          GROUP BY d.root_id`,
        [ids]
      );
      const cmap = new Map<number, number>();
      for (const x of cnt.rows as Array<{ root_id: number; c: number }>) cmap.set(x.root_id, x.c);
      const cov = await pool.query(
        `WITH RECURSIVE descendants AS (
           SELECT id AS root_id, id FROM cms_categories WHERE id = ANY($1::int[])
           UNION ALL
           SELECT d.root_id, c.id FROM cms_categories c
             JOIN descendants d ON c.parent_id = d.id
            WHERE c.deleted_at IS NULL
         )
         SELECT DISTINCT ON (d.root_id) d.root_id,
                COALESCE(dr.cover_image_url, dr.public_image_url, dr.image_url) AS img
           FROM descendants d
           JOIN dresses dr ON dr.category_id = d.id
                          AND dr.deleted_at IS NULL
                          AND dr.is_public = 1
                          AND dr.cms_status = 'visible'
                          AND COALESCE(dr.cover_image_url, dr.public_image_url, dr.image_url) IS NOT NULL
          ORDER BY d.root_id, dr.id ASC`,
        [ids]
      );
      const imap = new Map<number, string>();
      for (const x of cov.rows as Array<{ root_id: number; img: string }>) imap.set(x.root_id, x.img);
      for (const row of rows) {
        row.productCount = cmap.get(row.id) ?? 0;
        if (!row.coverImageUrl) row.fallbackCover = imap.get(row.id) ?? null;
      }
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Giờ vàng: gắn goldenHourPercent + goldenHourName cho danh sách váy ────────
// Ưu tiên (gần SP nhất): SP có sale_price riêng → KHÔNG giờ vàng; else campaign
// scope='dress' của SP; else campaign scope='category' gần nhất đi từ danh mục lên cha.
// Chỉ tính lúc hiển thị — KHÔNG ghi đè giá gốc. Lỗi/bảng chưa có → bỏ qua an toàn.
async function attachGoldenHour(items: any[]): Promise<any[]> {
  if (!items || items.length === 0) return items;
  try {
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
      const cats = await pool.query(`SELECT id, parent_id AS "parentId" FROM cms_categories WHERE type = 'dress'`);
      for (const r of cats.rows as any[]) {
        parentOf.set(Number(r.id), r.parentId == null ? null : Number(r.parentId));
      }
    }
    for (const it of items) {
      const rental = Number(it.rentalPrice) || 0;
      const sale = Number(it.salePrice) || 0;
      const hasOwnSale = sale > 0 && sale < rental;
      let found: { pct: number; name: string } | null = null;
      if (!hasOwnSale && (dressCamp.size > 0 || catCamp.size > 0)) {
        if (dressCamp.has(Number(it.id))) {
          found = dressCamp.get(Number(it.id))!;
        } else {
          let cid: number | null = it.categoryId == null ? null : Number(it.categoryId);
          const guard = new Set<number>();
          while (cid != null && !guard.has(cid)) {
            guard.add(cid);
            if (catCamp.has(cid)) { found = catCamp.get(cid)!; break; }
            cid = parentOf.has(cid) ? parentOf.get(cid)! : null;
          }
        }
      }
      it.goldenHourPercent = found ? found.pct : 0;
      it.goldenHourName = found ? found.name : null;
    }
  } catch {
    for (const it of items) { it.goldenHourPercent = 0; it.goldenHourName = null; }
  }
  return items;
}

// Public dresses (toàn bộ - client tự filter theo category)
router.get("/cms/public/dresses", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, code, name, category_id AS "categoryId", color, size,
              rental_price AS "rentalPrice",
              sell_price AS "sellPrice",
              sale_price AS "salePrice",
              is_priority AS "isPriority",
              rental_status AS "rentalStatus",
              outfit_tag AS "outfitTag",
              COALESCE(cover_image_url, public_image_url, image_url) AS "coverImageUrl",
              slug,
              size_text AS "sizeText",
              color_text AS "colorText",
              tags_text AS "tagsText"
         FROM dresses
        WHERE deleted_at IS NULL
          AND is_public = 1
          AND cms_status = 'visible'
        ORDER BY is_priority DESC, priority_at DESC NULLS LAST, created_at DESC`
    );
    const items = r.rows.map(row => ({
      ...row,
      rentalPrice: parseFloat(row.rentalPrice ?? "0"),
      sellPrice: parseFloat(row.sellPrice ?? "0"),
      salePrice: row.salePrice != null ? parseFloat(row.salePrice) : 0,
      isPriority: !!row.isPriority,
    }));
    await attachGoldenHour(items);
    res.json(items);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── Public packages for /bang-gia ───────────────────────────────────────────
router.get("/cms/public/packages", async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id, p.code, p.name, p.price,
             p.short_description AS "shortDescription",
             p.description,
             p.products,
             g.name AS "groupName",
             p.discount_enabled AS "pDEnabled", p.discount_type AS "pDType", p.discount_value AS "pDValue",
             p.discount_start_date AS "pDStart", p.discount_end_date AS "pDEnd",
             p.discount_name AS "pDName", p.discount_description AS "pDDesc",
             g.discount_enabled AS "gDEnabled", g.discount_type AS "gDType", g.discount_value AS "gDValue",
             g.discount_start_date AS "gDStart", g.discount_end_date AS "gDEnd",
             g.discount_name AS "gDName", g.discount_description AS "gDDesc"
      FROM service_packages p
      LEFT JOIN service_groups g ON g.id = p.group_id
      WHERE p.deleted_at IS NULL
        AND p.is_public = 1
        AND p.cms_status = 'visible'
        AND (p.group_id IS NULL OR g.is_active = 1)
      ORDER BY g.sort_order ASC NULLS LAST, p.sort_order ASC`);
    res.json(r.rows.map(row => {
      // Giá sau giảm tính SẴN ở backend (ưu tiên gói > nhóm, không cộng dồn, chỉ ưu
      // đãi đang hiệu lực — scheduled/expired tự bị loại). Website chỉ hiển thị.
      const discount = resolveDiscount({
        basePrice: row.price,
        pkg: { enabled: row.pDEnabled, type: row.pDType, value: row.pDValue, startDate: row.pDStart, endDate: row.pDEnd, name: row.pDName, description: row.pDDesc },
        group: { enabled: row.gDEnabled, type: row.gDType, value: row.gDValue, startDate: row.gDStart, endDate: row.gDEnd, name: row.gDName, description: row.gDDesc },
      });
      return {
        id: row.id, code: row.code, name: row.name,
        price: parseFloat(row.price),
        shortDescription: row.shortDescription,
        description: row.description,
        products: (() => { try { return JSON.parse(row.products ?? "[]"); } catch { return []; } })(),
        groupName: row.groupName,
        discount,
      };
    }));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Public dress detail by slug
router.get("/cms/public/dresses/slug/:slug", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, code, name, category_id AS "categoryId",
              rental_price AS "rentalPrice",
              deposit_required AS "depositRequired",
              sell_price AS "sellPrice",
              COALESCE(cover_image_url, public_image_url, image_url) AS "coverImageUrl",
              cover_image_url AS "coverImageUrlRaw",
              public_image_url AS "publicImageUrl",
              image_url AS "imageUrl",
              extra_images AS "extraImagesRaw",
              color, size,
              size_text AS "sizeText",
              color_text AS "colorText",
              tags_text AS "tagsText",
              material_text AS "materialText",
              description,
              rental_status AS "rentalStatus",
              outfit_tag AS "outfitTag",
              sale_price AS "salePrice",
              slug
         FROM dresses
        WHERE slug = $1
          AND deleted_at IS NULL
          AND is_public = 1
          AND cms_status = 'visible'`,
      [req.params.slug]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Không tìm thấy sản phẩm" });
    const row = r.rows[0] as Record<string, unknown>;
    let extraImages: string[] = [];
    try { if (row.extraImagesRaw) extraImages = JSON.parse(row.extraImagesRaw as string); } catch {}
    // Category name lookup
    let categoryName: string | null = null;
    if (row.categoryId) {
      const cat = await pool.query(`SELECT name FROM cms_categories WHERE id = $1`, [row.categoryId]);
      if (cat.rows[0]) categoryName = (cat.rows[0] as { name: string }).name;
    }
    const out: any = {
      ...row,
      rentalPrice: parseFloat((row.rentalPrice ?? "0") as string),
      depositRequired: parseFloat((row.depositRequired ?? "0") as string),
      sellPrice: parseFloat((row.sellPrice ?? "0") as string),
      salePrice: row.salePrice != null ? parseFloat(row.salePrice as string) : 0,
      extraImages,
      extraImagesRaw: undefined,
      coverImageUrlRaw: undefined,
      categoryName,
    };
    await attachGoldenHour([out]);
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC GALLERY (Task #436) — /bo-anh
// ═══════════════════════════════════════════════════════════════════════════

// Cây danh mục type='gallery' kèm số album visible + ảnh fallback
router.get("/cms/public/gallery/categories", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, parent_id AS "parentId", name, slug,
              cover_image_url AS "coverImageUrl",
              sort_order AS "sortOrder"
         FROM cms_categories
        WHERE type = 'gallery' AND deleted_at IS NULL AND is_active = 1
        ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC`
    );
    const rows = r.rows as Array<{
      id: number; parentId: number | null; name: string;
      slug: string | null; coverImageUrl: string | null; sortOrder: number;
      productCount?: number; fallbackCover?: string | null;
    }>;
    if (rows.length) {
      const ids = rows.map(x => x.id);
      const cnt = await pool.query(
        `WITH RECURSIVE descendants AS (
           SELECT id AS root_id, id FROM cms_categories WHERE id = ANY($1::int[])
           UNION ALL
           SELECT d.root_id, c.id FROM cms_categories c
             JOIN descendants d ON c.parent_id = d.id
            WHERE c.deleted_at IS NULL
         )
         SELECT d.root_id, COUNT(a.id)::int AS c
           FROM descendants d
           LEFT JOIN gallery_albums a
             ON a.category_id = d.id
            AND a.deleted_at IS NULL
            AND a.status = 'visible'
          GROUP BY d.root_id`,
        [ids]
      );
      const cmap = new Map<number, number>();
      for (const x of cnt.rows as Array<{ root_id: number; c: number }>) cmap.set(x.root_id, x.c);
      const cov = await pool.query(
        `WITH RECURSIVE descendants AS (
           SELECT id AS root_id, id FROM cms_categories WHERE id = ANY($1::int[])
           UNION ALL
           SELECT d.root_id, c.id FROM cms_categories c
             JOIN descendants d ON c.parent_id = d.id
            WHERE c.deleted_at IS NULL
         )
         SELECT DISTINCT ON (d.root_id) d.root_id,
                COALESCE(
                  a.cover_image_url,
                  (SELECT p.image_url FROM gallery_photos p
                    WHERE p.album_id = a.id AND p.deleted_at IS NULL
                      AND p.status = 'visible'
                      AND (p.mime_type IS NULL OR p.mime_type LIKE 'image/%')
                    ORDER BY p.sort_order ASC, p.id ASC LIMIT 1)
                ) AS img
           FROM descendants d
           JOIN gallery_albums a ON a.category_id = d.id
                                AND a.deleted_at IS NULL
                                AND a.status = 'visible'
          ORDER BY d.root_id, a.sort_order ASC, a.id ASC`,
        [ids]
      );
      const imap = new Map<number, string>();
      for (const x of cov.rows as Array<{ root_id: number; img: string | null }>) {
        if (x.img) imap.set(x.root_id, x.img);
      }
      for (const row of rows) {
        row.productCount = cmap.get(row.id) ?? 0;
        if (!row.coverImageUrl) row.fallbackCover = imap.get(row.id) ?? null;
      }
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Public albums (visible only) — optional ?categoryId= (mặc định bao gồm descendants)
router.get("/cms/public/gallery/albums", async (req, res) => {
  try {
    const conds: string[] = ["a.deleted_at IS NULL", "a.status = 'visible'"];
    const params: unknown[] = [];
    const categoryId = req.query.categoryId ? +req.query.categoryId : null;
    if (categoryId !== null && !Number.isNaN(categoryId)) {
      const includeDescendants = req.query.includeDescendants !== "0";
      if (includeDescendants) {
        const ids = await pool.query(
          `WITH RECURSIVE descendants AS (
             SELECT id FROM cms_categories WHERE id = $1
             UNION ALL
             SELECT c.id FROM cms_categories c JOIN descendants d ON c.parent_id = d.id
              WHERE c.deleted_at IS NULL
           )
           SELECT id FROM descendants`,
          [categoryId]
        );
        const allIds = (ids.rows as Array<{ id: number }>).map(r => r.id);
        params.push(allIds);
        conds.push(`a.category_id = ANY($${params.length}::int[])`);
      } else {
        params.push(categoryId);
        conds.push(`a.category_id = $${params.length}`);
      }
    }
    const r = await pool.query(
      `SELECT a.id, a.name,
              COALESCE(NULLIF(a.slug, ''), 'al-' || a.id) AS slug,
              a.category_id AS "categoryId",
              a.tags_text   AS "tagsText",
              COALESCE(
                a.cover_image_url,
                (SELECT p.image_url FROM gallery_photos p
                  WHERE p.album_id = a.id AND p.deleted_at IS NULL
                    AND p.status = 'visible'
                    AND (p.mime_type IS NULL OR p.mime_type LIKE 'image/%')
                  ORDER BY p.sort_order ASC, p.id ASC LIMIT 1)
              ) AS "coverImageUrl",
              COALESCE((
                SELECT COUNT(*)::int FROM gallery_photos p
                 WHERE p.album_id = a.id AND p.deleted_at IS NULL
                   AND p.status = 'visible'
                   AND (p.mime_type IS NULL OR p.mime_type LIKE 'image/%')
              ), 0) AS "photoCount",
              COALESCE((
                SELECT COUNT(*)::int FROM gallery_photos p
                 WHERE p.album_id = a.id AND p.deleted_at IS NULL
                   AND p.status = 'visible'
                   AND p.mime_type LIKE 'video/%'
              ), 0) AS "videoCount",
              a.sort_order AS "sortOrder",
              a.created_at AS "createdAt"
         FROM gallery_albums a
        WHERE ${conds.join(" AND ")}
        ORDER BY a.sort_order ASC, a.id DESC`,
      params
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Public album detail — accept numeric id hoặc slug
router.get("/cms/public/gallery/albums/:slugOrId", async (req, res) => {
  try {
    const key = req.params.slugOrId;
    const asInt = /^\d+$/.test(key) ? parseInt(key, 10) : null;
    const r = await pool.query(
      `SELECT a.id, a.name,
              COALESCE(NULLIF(a.slug, ''), 'al-' || a.id) AS slug,
              a.description, a.category_id AS "categoryId",
              a.tags_text AS "tagsText",
              COALESCE(
                a.cover_image_url,
                (SELECT p.image_url FROM gallery_photos p
                  WHERE p.album_id = a.id AND p.deleted_at IS NULL
                    AND (p.mime_type IS NULL OR p.mime_type LIKE 'image/%')
                  ORDER BY p.sort_order ASC, p.id ASC LIMIT 1)
              ) AS "coverImageUrl",
              a.created_at AS "createdAt"
         FROM gallery_albums a
        WHERE a.deleted_at IS NULL AND a.status = 'visible'
          AND (
            a.slug = $1
            OR ($2::int IS NOT NULL AND a.id = $2::int)
            OR ($3::int IS NOT NULL AND a.id = $3::int AND (a.slug IS NULL OR a.slug = ''))
          )
        LIMIT 1`,
      [key, asInt, /^al-(\d+)$/.test(key) ? parseInt(key.slice(3), 10) : null]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Không tìm thấy bộ ảnh" });
    const album = r.rows[0] as { id: number; categoryId: number | null };
    let categoryName: string | null = null;
    if (album.categoryId) {
      const cat = await pool.query(`SELECT name FROM cms_categories WHERE id = $1`, [album.categoryId]);
      if (cat.rows[0]) categoryName = (cat.rows[0] as { name: string }).name;
    }
    const media = await pool.query(
      `SELECT id, image_url AS "imageUrl", caption, mime_type AS "mimeType",
              sort_order AS "sortOrder"
         FROM gallery_photos
        WHERE album_id = $1 AND deleted_at IS NULL AND status = 'visible'
        ORDER BY sort_order ASC, id ASC`,
      [album.id]
    );
    res.json({ ...album, categoryName, media: media.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// HOME SETTINGS — CMS Trang chủ (single-row id = 1)
// ═══════════════════════════════════════════════════════════════════════════
const HOME_FIELDS: Array<{ col: string; key: keyof HomeContent }> = [
  { col: "hero_image_url", key: "heroImageUrl" },
  { col: "about_image_url", key: "aboutImageUrl" },
  { col: "eyebrow", key: "eyebrow" },
  { col: "title_line1", key: "titleLine1" },
  { col: "title_line2", key: "titleLine2" },
  { col: "subtitle", key: "subtitle" },
  { col: "cta_primary_label", key: "ctaPrimaryLabel" },
  { col: "cta_primary_href", key: "ctaPrimaryHref" },
  { col: "cta_secondary_label", key: "ctaSecondaryLabel" },
  { col: "cta_secondary_href", key: "ctaSecondaryHref" },
  { col: "featured_concept_image_url", key: "featuredConceptImageUrl" },
  { col: "featured_service_image_url", key: "featuredServiceImageUrl" },
  { col: "footer_banner_image_url", key: "footerBannerImageUrl" },
  { col: "footer_cta_title", key: "footerCtaTitle" },
  { col: "footer_cta_subtitle", key: "footerCtaSubtitle" },
  { col: "footer_cta_button_label", key: "footerCtaButtonLabel" },
  { col: "footer_cta_button_href", key: "footerCtaButtonHref" },
];

type HomeContent = {
  heroImageUrl: string | null;
  aboutImageUrl: string | null;
  eyebrow: string | null;
  titleLine1: string | null;
  titleLine2: string | null;
  subtitle: string | null;
  ctaPrimaryLabel: string | null;
  ctaPrimaryHref: string | null;
  ctaSecondaryLabel: string | null;
  ctaSecondaryHref: string | null;
  featuredConceptImageUrl: string | null;
  featuredServiceImageUrl: string | null;
  footerBannerImageUrl: string | null;
  footerCtaTitle: string | null;
  footerCtaSubtitle: string | null;
  footerCtaButtonLabel: string | null;
  footerCtaButtonHref: string | null;
};

const EMPTY_HOME: HomeContent = HOME_FIELDS.reduce((acc, f) => {
  acc[f.key] = null;
  return acc;
}, {} as HomeContent);

async function readHomeSettings(): Promise<HomeContent> {
  const cols = HOME_FIELDS.map(f => `${f.col} AS "${f.key}"`).join(", ");
  const r = await pool.query(`SELECT ${cols} FROM cms_home_settings WHERE id = 1`);
  if (!r.rows[0]) return { ...EMPTY_HOME };
  const row = r.rows[0] as Record<string, unknown>;
  const out = { ...EMPTY_HOME };
  for (const f of HOME_FIELDS) {
    const v = row[f.key];
    out[f.key] = v == null || v === "" ? null : String(v);
  }
  return out;
}

// Public — Trang chủ (không cần đăng nhập)
router.get("/cms/public/home", async (_req, res) => {
  try {
    res.json(await readHomeSettings());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Admin — đọc cài đặt trang chủ
router.get("/cms/home-settings", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json(await readHomeSettings());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Admin — lưu cài đặt trang chủ (upsert single row)
router.put("/cms/home-settings", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const norm = (v: unknown): string | null => {
      if (v == null) return null;
      const s = String(v).trim();
      return s === "" ? null : s;
    };
    const cols = HOME_FIELDS.map(f => f.col);
    const values = HOME_FIELDS.map(f => norm(body[f.key]));
    const insertCols = ["id", ...cols, "updated_at"].join(", ");
    const placeholders = ["1", ...values.map((_, i) => `$${i + 1}`), "NOW()"].join(", ");
    const updateSet = [...cols.map(c => `${c} = EXCLUDED.${c}`), "updated_at = NOW()"].join(", ");
    await pool.query(
      `INSERT INTO cms_home_settings (${insertCols}) VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
      values
    );
    res.json(await readHomeSettings());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRASH — unified listing for admin
// ═══════════════════════════════════════════════════════════════════════════
router.get("/cms/trash", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const albums = await pool.query(
      `SELECT id, name AS title, deleted_at AS "deletedAt" FROM gallery_albums
       WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`);
    const photos = await pool.query(
      `SELECT id, image_url AS "imageUrl", album_id AS "albumId", deleted_at AS "deletedAt"
       FROM gallery_photos WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`);
    const cats = await pool.query(
      `SELECT id, name AS title, type, deleted_at AS "deletedAt" FROM cms_categories
       WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`);
    res.json({
      albums: albums.rows,
      photos: photos.rows,
      categories: cats.rows,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
