import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
import { getCallerRole } from "./auth";
import { withStartupDdlLock } from "../lib/startup-ddl";

const router: IRouter = Router();

// ─── Auto-migration: create tables + seed default templates on startup ───────
async function ensureWeddingSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wedding_templates (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      thumbnail_url TEXT,
      preview_image_url TEXT,
      mockup_image_url TEXT,
      default_background_url TEXT,
      theme_color TEXT,
      theme_key TEXT NOT NULL DEFAULT 'classic',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wedding_templates_slug
    ON wedding_templates(LOWER(slug)) WHERE deleted_at IS NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wedding_cards (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'published',
      template_id INTEGER,
      template_slug TEXT,
      theme_key TEXT,
      groom_name TEXT NOT NULL,
      bride_name TEXT NOT NULL,
      wedding_date TEXT,
      ceremony_time TEXT,
      reception_time TEXT,
      venue_groom TEXT,
      venue_bride TEXT,
      venue_reception TEXT,
      maps_url_groom TEXT,
      maps_url_bride TEXT,
      maps_url_reception TEXT,
      invitation_message TEXT,
      cover_image_url TEXT,
      couple_image_url TEXT,
      contact_phone TEXT,
      view_count INTEGER NOT NULL DEFAULT 0,
      published_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wedding_cards_slug ON wedding_cards(slug)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wedding_guest_entries (
      id SERIAL PRIMARY KEY,
      card_id INTEGER NOT NULL,
      guest_name TEXT,
      message TEXT,
      attendance TEXT NOT NULL DEFAULT 'unknown',
      guest_count INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_wedding_guest_entries_card ON wedding_guest_entries(card_id)`
  );

  // ─── ADD-ONLY: giữ lại schema cũ để dev là superset của prod ──────────────
  // Để publish không sinh destructive diff (DROP COLUMN / DROP TABLE / DROP CONSTRAINT).
  // Chỉ ADD, không drop/rename/đổi gì.
  await pool.query(`ALTER TABLE wedding_cards ADD COLUMN IF NOT EXISTS customer_id INTEGER`);
  await pool.query(`ALTER TABLE wedding_cards ADD COLUMN IF NOT EXISTS booking_id INTEGER`);
  await pool.query(`ALTER TABLE wedding_cards ADD COLUMN IF NOT EXISTS created_by_staff_id INTEGER`);
  await pool.query(`ALTER TABLE wedding_cards ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
  await pool.query(`ALTER TABLE wedding_cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wedding_card_templates (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      preview_image_url TEXT,
      theme_key TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      category TEXT,
      thumbnail_url TEXT,
      mockup_image_url TEXT,
      default_background_url TEXT,
      theme_color TEXT,
      deleted_at TIMESTAMP
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wedding_card_guest_entries (
      id SERIAL PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES wedding_cards(id) ON DELETE CASCADE,
      guest_name TEXT,
      message TEXT,
      attendance TEXT NOT NULL DEFAULT 'unknown',
      guest_count INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'wedding_cards_template_id_fkey'
      ) THEN
        ALTER TABLE wedding_cards
          ADD CONSTRAINT wedding_cards_template_id_fkey
          FOREIGN KEY (template_id) REFERENCES wedding_card_templates(id);
      END IF;
    END $$;`);

  // ─── Seed 3 default templates nếu chưa có (slug khớp FALLBACK frontend) ──
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(8412402)");
    const existing = await client.query(
      `SELECT COUNT(*)::int AS c FROM wedding_templates WHERE deleted_at IS NULL`
    );
    if ((existing.rows[0] as { c: number }).c === 0) {
      const SEED: Array<{
        slug: string; name: string; description: string;
        category: string; themeColor: string; themeKey: string; sortOrder: number;
      }> = [
        { slug: "classic", name: "Hàn Quốc", description: "Tối giản pastel, chữ thanh lịch — phong cách thiệp Hàn", category: "Hàn Quốc", themeColor: "#e8dfd4", themeKey: "classic", sortOrder: 1 },
        { slug: "modern", name: "Hiện Đại", description: "Trắng đen, layout gọn — nét đương đại", category: "Hiện Đại", themeColor: "#171717", themeKey: "modern", sortOrder: 2 },
        { slug: "romantic", name: "Burgundy", description: "Đỏ rượu vang, ấm áp và sang trọng", category: "Burgundy", themeColor: "#8B2942", themeKey: "romantic", sortOrder: 3 },
      ];
      for (const t of SEED) {
        await client.query(
          `INSERT INTO wedding_templates
             (slug, name, description, category, theme_color, theme_key, sort_order, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
          [t.slug, t.name, t.description, t.category, t.themeColor, t.themeKey, t.sortOrder]
        );
      }
      console.log("[wedding-cards] Seeded default templates");
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
withStartupDdlLock(ensureWeddingSchema).catch(err => console.error("[wedding-cards] ensureSchema failed:", err));

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Mở quản lý mẫu Thiệp cưới cho MỌI nhân viên đã đăng nhập (quyết định của chủ studio).
// Vẫn yêu cầu đăng nhập (chống truy cập ẩn danh); KHÔNG còn bắt buộc vai trò admin.
async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const role = await getCallerRole(req.headers.authorization);
  if (!role) { res.status(401).json({ error: "Chưa đăng nhập" }); return false; }
  return true;
}

const TEMPLATE_SELECT = `
  id, slug, name, description, category,
  thumbnail_url AS "thumbnailUrl",
  preview_image_url AS "previewImageUrl",
  mockup_image_url AS "mockupImageUrl",
  default_background_url AS "defaultBackgroundUrl",
  theme_color AS "themeColor",
  theme_key AS "themeKey",
  sort_order AS "sortOrder",
  (is_active = 1) AS "isActive"
`;

const CARD_SELECT = `
  id, slug, status,
  template_id AS "templateId",
  template_slug AS "templateSlug",
  theme_key AS "themeKey",
  groom_name AS "groomName",
  bride_name AS "brideName",
  wedding_date AS "weddingDate",
  ceremony_time AS "ceremonyTime",
  reception_time AS "receptionTime",
  venue_groom AS "venueGroom",
  venue_bride AS "venueBride",
  venue_reception AS "venueReception",
  maps_url_groom AS "mapsUrlGroom",
  maps_url_bride AS "mapsUrlBride",
  maps_url_reception AS "mapsUrlReception",
  invitation_message AS "invitationMessage",
  cover_image_url AS "coverImageUrl",
  couple_image_url AS "coupleImageUrl",
  contact_phone AS "contactPhone",
  view_count AS "viewCount",
  published_at AS "publishedAt",
  created_at AS "createdAt"
`;

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normAttendance(v: unknown): "yes" | "no" | "unknown" {
  return v === "yes" || v === "no" ? v : "unknown";
}

async function uniqueCardSlug(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const slug = randomBytes(5).toString("hex"); // 10 hex chars
    const r = await pool.query(`SELECT 1 FROM wedding_cards WHERE slug = $1`, [slug]);
    if (!r.rows.length) return slug;
  }
  return `${randomBytes(8).toString("hex")}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC — Templates
// ═══════════════════════════════════════════════════════════════════════════
router.get("/wedding-cards/public/templates", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${TEMPLATE_SELECT} FROM wedding_templates
       WHERE deleted_at IS NULL AND is_active = 1
       ORDER BY sort_order ASC, id ASC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get("/wedding-cards/public/templates/:slug", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${TEMPLATE_SELECT} FROM wedding_templates
       WHERE slug = $1 AND deleted_at IS NULL AND is_active = 1 LIMIT 1`,
      [req.params.slug]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Không tìm thấy mẫu thiệp" });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC — Cards
// ═══════════════════════════════════════════════════════════════════════════
router.post("/wedding-cards/public", async (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const groomName = str(b.groomName);
    const brideName = str(b.brideName);
    const templateSlug = str(b.templateSlug);
    if (!groomName || !brideName) {
      return res.status(400).json({ error: "Thiếu tên cô dâu / chú rể" });
    }
    if (!templateSlug) {
      return res.status(400).json({ error: "Thiếu mẫu thiệp" });
    }
    const t = await pool.query(
      `SELECT id, slug, theme_key AS "themeKey" FROM wedding_templates
       WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
      [templateSlug]
    );
    const tpl = t.rows[0] as { id: number; slug: string; themeKey: string } | undefined;
    const templateId = tpl?.id ?? null;
    const themeKey = tpl?.themeKey ?? templateSlug;
    const slug = await uniqueCardSlug();

    const r = await pool.query(
      `INSERT INTO wedding_cards (
         slug, status, template_id, template_slug, theme_key,
         groom_name, bride_name, wedding_date, ceremony_time, reception_time,
         venue_groom, venue_bride, venue_reception,
         maps_url_groom, maps_url_bride, maps_url_reception,
         invitation_message, cover_image_url, couple_image_url, contact_phone,
         published_at
       ) VALUES (
         $1, 'published', $2, $3, $4,
         $5, $6, $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15,
         $16, $17, $18, $19,
         NOW()
       ) RETURNING id, slug, status, theme_key AS "themeKey"`,
      [
        slug, templateId, templateSlug, themeKey,
        groomName, brideName, str(b.weddingDate), str(b.ceremonyTime), str(b.receptionTime),
        str(b.venueGroom), str(b.venueBride), str(b.venueReception),
        str(b.mapsUrlGroom), str(b.mapsUrlBride), str(b.mapsUrlReception),
        str(b.invitationMessage), str(b.coverImageUrl), str(b.coupleImageUrl), str(b.contactPhone),
      ]
    );
    const row = r.rows[0] as { id: number; slug: string; status: string; themeKey: string };
    res.status(201).json({ ...row, url: `/thiep-cuoi/${row.slug}` });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get("/wedding-cards/public/:slug", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${CARD_SELECT} FROM wedding_cards WHERE slug = $1 LIMIT 1`,
      [req.params.slug]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Không tìm thấy thiệp" });
    // best-effort view count increment
    pool.query(`UPDATE wedding_cards SET view_count = view_count + 1 WHERE slug = $1`, [req.params.slug]).catch(() => {});
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC — Guest entries (sổ lưu bút / xác nhận tham dự)
// ═══════════════════════════════════════════════════════════════════════════
async function cardIdBySlug(slug: string): Promise<number | null> {
  const r = await pool.query(`SELECT id FROM wedding_cards WHERE slug = $1 LIMIT 1`, [slug]);
  return r.rows[0] ? (r.rows[0] as { id: number }).id : null;
}

router.get("/wedding-cards/public/:slug/guest-entries", async (req, res) => {
  try {
    const cardId = await cardIdBySlug(req.params.slug);
    if (cardId == null) return res.status(404).json({ error: "Không tìm thấy thiệp" });
    const r = await pool.query(
      `SELECT id, guest_name AS "guestName", message, attendance,
              guest_count AS "guestCount", created_at AS "createdAt"
       FROM wedding_guest_entries WHERE card_id = $1
       ORDER BY created_at DESC, id DESC`,
      [cardId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/wedding-cards/public/:slug/guest-entries", async (req, res) => {
  try {
    const cardId = await cardIdBySlug(req.params.slug);
    if (cardId == null) return res.status(404).json({ error: "Không tìm thấy thiệp" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const guestCountRaw = Number(b.guestCount);
    const guestCount = Number.isFinite(guestCountRaw) && guestCountRaw > 0
      ? Math.min(50, Math.floor(guestCountRaw))
      : 1;
    const r = await pool.query(
      `INSERT INTO wedding_guest_entries (card_id, guest_name, message, attendance, guest_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, guest_name AS "guestName", message, attendance,
                 guest_count AS "guestCount", created_at AS "createdAt"`,
      [cardId, str(b.guestName), str(b.message), normAttendance(b.attendance), guestCount]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN — Templates CRUD
// ═══════════════════════════════════════════════════════════════════════════
router.get("/wedding-cards/admin/templates", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const trash = req.query.trash === "1";
    const r = await pool.query(
      `SELECT ${TEMPLATE_SELECT} FROM wedding_templates
       WHERE deleted_at IS ${trash ? "NOT NULL" : "NULL"}
       ORDER BY sort_order ASC, id ASC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/wedding-cards/admin/templates", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.name);
    const slug = str(b.slug);
    if (!name) return res.status(400).json({ error: "Thiếu tên mẫu" });
    if (!slug) return res.status(400).json({ error: "Thiếu slug" });
    const dup = await pool.query(
      `SELECT 1 FROM wedding_templates WHERE LOWER(slug) = LOWER($1) AND deleted_at IS NULL`,
      [slug]
    );
    if (dup.rows.length) return res.status(400).json({ error: "Slug đã tồn tại" });
    const isActive = b.isActive === false ? 0 : 1;
    const r = await pool.query(
      `INSERT INTO wedding_templates
         (slug, name, description, category, thumbnail_url, preview_image_url,
          mockup_image_url, default_background_url, theme_color, theme_key, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${TEMPLATE_SELECT}`,
      [
        slug, name, str(b.description), str(b.category), str(b.thumbnailUrl), str(b.previewImageUrl),
        str(b.mockupImageUrl), str(b.defaultBackgroundUrl), str(b.themeColor),
        str(b.themeKey) ?? "classic", Number(b.sortOrder ?? 0) || 0, isActive,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.put("/wedding-cards/admin/templates/:id", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID không hợp lệ" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const map: Array<[string, string]> = [
      ["name", "name"], ["slug", "slug"], ["description", "description"], ["category", "category"],
      ["thumbnailUrl", "thumbnail_url"], ["previewImageUrl", "preview_image_url"],
      ["mockupImageUrl", "mockup_image_url"], ["defaultBackgroundUrl", "default_background_url"],
      ["themeColor", "theme_color"], ["themeKey", "theme_key"],
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, col] of map) {
      if (b[key] !== undefined) {
        params.push(str(b[key]));
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (b.sortOrder !== undefined) {
      params.push(Number(b.sortOrder) || 0);
      sets.push(`sort_order = $${params.length}`);
    }
    if (b.isActive !== undefined) {
      params.push(b.isActive === false ? 0 : 1);
      sets.push(`is_active = $${params.length}`);
    }
    if (!sets.length) {
      const cur = await pool.query(`SELECT ${TEMPLATE_SELECT} FROM wedding_templates WHERE id = $1`, [id]);
      if (!cur.rows[0]) return res.status(404).json({ error: "Không tìm thấy mẫu" });
      return res.json(cur.rows[0]);
    }
    params.push(id);
    const r = await pool.query(
      `UPDATE wedding_templates SET ${sets.join(", ")}
       WHERE id = $${params.length} AND deleted_at IS NULL
       RETURNING ${TEMPLATE_SELECT}`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Không tìm thấy mẫu" });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete("/wedding-cards/admin/templates/:id", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID không hợp lệ" });
    await pool.query(
      `UPDATE wedding_templates SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/wedding-cards/admin/templates/:id/restore", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID không hợp lệ" });
    const r = await pool.query(
      `UPDATE wedding_templates SET deleted_at = NULL WHERE id = $1
       RETURNING ${TEMPLATE_SELECT}`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Không tìm thấy mẫu" });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
