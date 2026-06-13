import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac } from "crypto";
import { pool } from "@workspace/db";
import { getCallerRole } from "./auth";

const router: IRouter = Router();

const JWT_SECRET = process.env.SESSION_SECRET ?? "amazing-studio-secret-2025";

const EXECUTION_STATUSES = ["available", "need_investment"] as const;
const VISIBILITY_STATUSES = ["public", "hidden"] as const;

function normExecution(v: unknown): string {
  return EXECUTION_STATUSES.includes(v as never) ? String(v) : "available";
}
function normVisibility(v: unknown): string {
  return VISIBILITY_STATUSES.includes(v as never) ? String(v) : "public";
}

async function requireStaff(req: Request, res: Response): Promise<boolean> {
  const role = await getCallerRole(req.headers.authorization);
  if (!role) { res.status(401).json({ error: "Chưa đăng nhập" }); return false; }
  return true;
}

function slugify(name: string, id: number): string {
  const s = (name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (s || "y-tuong") + "-" + id;
}

function fmt(d: Record<string, unknown>) {
  let extraImages: string[] = [];
  try { if (d.extra_images) extraImages = JSON.parse(d.extra_images as string); } catch {}
  return {
    id: d.id,
    name: d.name,
    slug: d.slug ?? null,
    categoryId: d.category_id ?? null,
    description: d.description ?? null,
    imageUrl: d.image_url ?? null,
    publicImageUrl: d.public_image_url ?? null,
    coverImageUrl: d.cover_image_url ?? null,
    extraImages,
    tagsText: d.tags_text ?? null,
    visibilityStatus: (d.visibility_status ?? "public") as string,
    executionStatus: (d.execution_status ?? "available") as string,
    sortOrder: Number(d.sort_order ?? 0),
    createdAt: d.created_at,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CMS (staff)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/photo-ideas", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    const { executionStatus, search } = req.query as Record<string, string>;
    const conds = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    if (executionStatus && EXECUTION_STATUSES.includes(executionStatus as never)) {
      params.push(executionStatus);
      conds.push(`execution_status = $${params.length}`);
    }
    if (search?.trim()) {
      params.push(`%${search.toLowerCase().trim()}%`);
      const n = params.length;
      conds.push(`(LOWER(name) LIKE $${n} OR LOWER(COALESCE(tags_text,'')) LIKE $${n} OR LOWER(COALESCE(description,'')) LIKE $${n})`);
    }
    const r = await pool.query(
      `SELECT * FROM photo_ideas WHERE ${conds.join(" AND ")} ORDER BY sort_order ASC, created_at DESC`,
      params
    );
    res.json(r.rows.map(fmt));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.get("/photo-ideas/:id", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    const r = await pool.query(`SELECT * FROM photo_ideas WHERE id = $1 AND deleted_at IS NULL`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Không tìm thấy" });
    res.json(fmt(r.rows[0]));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/photo-ideas", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    const {
      name, categoryId, description, imageUrl, publicImageUrl, coverImageUrl,
      extraImages, tagsText, visibilityStatus, executionStatus,
    } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: "Vui lòng nhập tên concept" });
    const r = await pool.query(
      `INSERT INTO photo_ideas
         (name, category_id, description, image_url, public_image_url, cover_image_url,
          extra_images, tags_text, visibility_status, execution_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        String(name).trim(), categoryId || null, description || null,
        imageUrl || null, publicImageUrl || null, coverImageUrl || null,
        extraImages ? JSON.stringify(extraImages) : null,
        tagsText || null,
        normVisibility(visibilityStatus),
        normExecution(executionStatus),
      ]
    );
    const row = r.rows[0] as Record<string, unknown>;
    if (!row.slug) {
      const autoSlug = slugify(String(row.name || ""), row.id as number);
      await pool.query(`UPDATE photo_ideas SET slug = $1 WHERE id = $2`, [autoSlug, row.id]);
      row.slug = autoSlug;
    }
    res.status(201).json(fmt(row));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.put("/photo-ideas/:id", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    const textFields: Record<string, string> = {
      name: "name", description: "description",
      imageUrl: "image_url", publicImageUrl: "public_image_url", coverImageUrl: "cover_image_url",
      tagsText: "tags_text", slug: "slug",
    };
    for (const [k, col] of Object.entries(textFields)) {
      if (body[k] !== undefined) add(col, body[k]);
    }
    if (body.categoryId !== undefined) add("category_id", body.categoryId === null ? null : +(body.categoryId as number));
    if (body.extraImages !== undefined) add("extra_images", JSON.stringify(body.extraImages));
    if (body.visibilityStatus !== undefined) add("visibility_status", normVisibility(body.visibilityStatus));
    if (body.executionStatus !== undefined) add("execution_status", normExecution(body.executionStatus));
    if (body.sortOrder !== undefined) add("sort_order", Number(body.sortOrder) || 0);

    if (!sets.length) return res.json({ ok: true });
    params.push(+req.params.id);
    const r = await pool.query(
      `UPDATE photo_ideas SET ${sets.join(", ")} WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Không tìm thấy" });
    res.json(fmt(r.rows[0]));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.delete("/photo-ideas/:id", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    await pool.query(`UPDATE photo_ideas SET deleted_at = now() WHERE id = $1`, [+req.params.id]);
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC — bảo vệ bằng mật khẩu, token xem 24h
// ═══════════════════════════════════════════════════════════════════════════

const IDEAS_TOKEN_SCOPE = "photo_ideas_view";

function signViewToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    scope: IDEAS_TOKEN_SCOPE,
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
  })).toString("base64url");
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export function verifyViewToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, sig] = parts;
  const expected = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  if (sig !== expected) return false;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString());
    return body.scope === IDEAS_TOKEN_SCOPE && typeof body.exp === "number" && body.exp > Date.now() / 1000;
  } catch { return false; }
}

export async function getIdeasPasswordConfig(): Promise<{ password: string; enabled: boolean }> {
  const r = await pool.query(
    `SELECT key, value FROM app_settings WHERE key IN ('photo_ideas_password', 'photo_ideas_password_enabled')`
  );
  const map = new Map<string, string | null>();
  for (const row of r.rows as Array<{ key: string; value: string | null }>) map.set(row.key, row.value);
  return {
    password: map.get("photo_ideas_password") ?? "999999",
    enabled: (map.get("photo_ideas_password_enabled") ?? "1") === "1",
  };
}

/** Khách nhập mật khẩu → trả token xem trong 24 giờ. */
router.post("/public/photo-ideas/verify", async (req, res) => {
  try {
    const { password } = req.body ?? {};
    const cfg = await getIdeasPasswordConfig();
    if (!cfg.enabled) return res.json({ token: signViewToken(), expiresInHours: 24 });
    if (typeof password !== "string" || password !== cfg.password) {
      return res.status(403).json({ error: "Bạn không có quyền truy cập" });
    }
    res.json({ token: signViewToken(), expiresInHours: 24 });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

/** Token hợp lệ (hoặc đã tắt bảo vệ) thì mới được xem nội dung. */
async function requireViewAccess(req: Request, res: Response): Promise<boolean> {
  const cfg = await getIdeasPasswordConfig();
  if (!cfg.enabled) return true;
  const raw = req.headers["x-ideas-token"];
  const token = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (verifyViewToken(token)) return true;
  // Nhân viên đã đăng nhập cũng được xem (không cần mật khẩu)
  const role = await getCallerRole(req.headers.authorization);
  if (role) return true;
  res.status(401).json({ error: "Vui lòng nhập mật khẩu để xem nội dung" });
  return false;
}

/** Danh mục (type='idea') + toàn bộ concept đang hiển thị. */
router.get("/public/photo-ideas", async (req, res) => {
  try {
    if (!(await requireViewAccess(req, res))) return;
    const cats = await pool.query(
      `SELECT id, parent_id AS "parentId", name, slug,
              cover_image_url AS "coverImageUrl",
              sort_order AS "sortOrder"
         FROM cms_categories
        WHERE type = 'idea' AND deleted_at IS NULL AND is_active = 1
        ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC`
    );
    const ideas = await pool.query(
      `SELECT * FROM photo_ideas
        WHERE deleted_at IS NULL AND visibility_status = 'public'
        ORDER BY sort_order ASC, created_at DESC`
    );
    res.json({
      categories: cats.rows,
      ideas: ideas.rows.map(r => {
        const f = fmt(r as Record<string, unknown>);
        // Public: không trả gì liên quan giá/thuê — chỉ nội dung tham khảo
        return {
          id: f.id, name: f.name, slug: f.slug, categoryId: f.categoryId,
          description: f.description, tagsText: f.tagsText,
          executionStatus: f.executionStatus,
          coverImageUrl: f.coverImageUrl ?? f.publicImageUrl ?? f.imageUrl ?? f.extraImages[0] ?? null,
          extraImages: f.extraImages,
          imageUrl: f.imageUrl,
        };
      }),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
