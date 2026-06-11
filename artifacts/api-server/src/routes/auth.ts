import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import bcrypt from "bcryptjs";

const router: IRouter = Router();

async function ensureAuthColumns() {
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_hash TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS username TEXT`).catch(() => {});

  // Ensure admin user (tranchi) always exists with correct password
  const adminR = await pool.query(`SELECT id, phone, password_hash FROM staff WHERE username = 'tranchi' LIMIT 1`);
  const adminHash = await bcrypt.hash("123456", 10);

  if (adminR.rows.length === 0) {
    // Admin doesn't exist — create it
    await pool.query(
      `INSERT INTO staff (name, role, roles, phone, username, password_hash, is_active)
       VALUES ('Admin', 'admin', '["admin"]', '0392817079', 'tranchi', $1, 1)`,
      [adminHash]
    );
    console.log("[startup] Admin user seeded: username=tranchi password=123456");
  } else {
    const admin = adminR.rows[0] as { id: number; phone: string; password_hash: string | null };
    if (!admin.password_hash) {
      // No hash — set to 123456
      await pool.query(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [adminHash, admin.id]);
      console.log("[startup] Admin password initialized to default 123456");
    } else {
      // Hash exists — đảm bảo mật khẩu admin LUÔN là 123456 (quy ước nội bộ).
      // Nếu hash hiện tại khớp 123456 → giữ nguyên; ngược lại reset về 123456 để
      // chủ shop không bao giờ bị khoá ngoài hệ thống.
      const matches123456 = await bcrypt.compare("123456", admin.password_hash);
      if (!matches123456) {
        await pool.query(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [adminHash, admin.id]);
        console.log("[startup] Admin password reset to default 123456");
      }
    }
  }

  // For all other staff: set phone as default password if no hash set
  const r = await pool.query(`SELECT id, phone, password_hash FROM staff WHERE is_active = 1 AND username != 'tranchi'`);
  const updates: Promise<void>[] = [];
  for (const row of r.rows as { id: number; phone: string; password_hash: string | null }[]) {
    if (!row.password_hash && row.phone) {
      const hash = await bcrypt.hash(row.phone, 10);
      updates.push(pool.query(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [hash, row.id]).then(() => {}));
    }
  }
  if (updates.length > 0) await Promise.all(updates);
}
ensureAuthColumns().catch(console.error);

const JWT_SECRET = process.env.SESSION_SECRET ?? "amazing-studio-secret-2025";

export async function getCallerRole(header: string | undefined): Promise<"admin" | "staff" | null> {
  const id = verifyToken(header);
  if (!id) return null;
  try {
    const r = await pool.query(`SELECT role, roles FROM staff WHERE id = $1 AND is_active = 1`, [id]);
    if (!r.rows.length) return null;
    const u = r.rows[0] as { role: string; roles: unknown };
    const isAdmin = u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin"));
    return isAdmin ? "admin" : "staff";
  } catch { return null; }
}

export function verifyToken(header: string | undefined): number | null {
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const token = header.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [jwtHeader, jwtBody, sig] = parts;
    const { createHmac } = require("crypto") as typeof import("crypto");
    const expectedSig = createHmac("sha256", JWT_SECRET).update(`${jwtHeader}.${jwtBody}`).digest("base64url");
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(jwtBody, "base64url").toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload.id as number;
  } catch { return null; }
}

router.get("/auth/me", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
  const r = await pool.query(
    `SELECT id, name, role, roles, phone, email, avatar, username FROM staff WHERE id = $1 AND is_active = 1`,
    [callerId]
  );
  if (r.rows.length === 0) return res.status(401).json({ error: "Tài khoản không tồn tại" });
  const u = r.rows[0] as Record<string, unknown>;
  res.json({ id: u.id, name: u.name, role: u.role, roles: u.roles ?? [], phone: u.phone, email: u.email, avatar: u.avatar, username: u.username });
});

router.post("/auth/login", async (req, res) => {
  const { phone, password } = req.body as { phone?: string; password?: string };
  if (!phone || !password) return res.status(400).json({ error: "Vui lòng nhập tên đăng nhập và mật khẩu" });

  const normalized = phone.trim().replace(/[\s\-\(\)\+\.]/g, "");
  let r;

  if (normalized.toLowerCase() === "admin") {
    r = await pool.query(
      `SELECT id, name, role, roles, phone, email, avatar, password_hash, username FROM staff
       WHERE (role = 'admin' OR roles::text LIKE '%admin%') AND is_active = 1
       ORDER BY id LIMIT 1`
    );
  } else {
    r = await pool.query(
      `SELECT id, name, role, roles, phone, email, avatar, password_hash, username FROM staff
       WHERE (username = $1 OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '') = $1)
       AND is_active = 1 LIMIT 1`,
      [normalized]
    );
  }

  if (r.rows.length === 0) return res.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu không đúng" });
  const u = r.rows[0] as Record<string, unknown>;

  if (!u.password_hash) {
    const defaultPw = (u.phone as string | null) || "admin123";
    const hash = await bcrypt.hash(defaultPw, 10);
    await pool.query(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [hash, u.id]);
    u.password_hash = hash;
  }

  const ok = await bcrypt.compare(password, u.password_hash as string);
  if (!ok) return res.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu không đúng" });

  const { createHmac } = await import("crypto");
  const jwtHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const jwtBody = Buffer.from(JSON.stringify({ id: u.id, exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 })).toString("base64url");
  const sig = createHmac("sha256", JWT_SECRET).update(`${jwtHeader}.${jwtBody}`).digest("base64url");

  res.json({
    token: `${jwtHeader}.${jwtBody}.${sig}`,
    user: { id: u.id, name: u.name, role: u.role, roles: u.roles ?? [], phone: u.phone, email: u.email, avatar: u.avatar, username: u.username },
  });
});

router.get("/auth/staff-account/:id", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  if (!isAdmin) return res.status(403).json({ error: "Không có quyền" });
  const r = await pool.query(`SELECT id, name, phone, username FROM staff WHERE id = $1`, [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy nhân viên" });
  res.json(r.rows[0]);
});

router.post("/auth/update-account", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const callerR = await pool.query(`SELECT id, role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  if (!caller) return res.status(401).json({ error: "Tài khoản không tồn tại" });

  const isAdmin = caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"));
  const { targetId, username, newPassword } = req.body as { targetId?: number; username?: string; newPassword?: string };
  const changingFor = targetId ?? callerId;

  if (!isAdmin && changingFor !== callerId) return res.status(403).json({ error: "Không có quyền chỉnh tài khoản người khác" });
  if (newPassword && newPassword.length < 4) return res.status(400).json({ error: "Mật khẩu phải có ít nhất 4 ký tự" });

  if (username !== undefined) {
    const trimmed = username.trim();
    if (trimmed) {
      const exists = await pool.query(
        `SELECT id FROM staff WHERE username = $1 AND id != $2`,
        [trimmed, changingFor]
      );
      if ((exists.rows as unknown[]).length > 0) return res.status(400).json({ error: "Tên đăng nhập đã tồn tại, vui lòng chọn tên khác" });
      await pool.query(`UPDATE staff SET username = $1 WHERE id = $2`, [trimmed, changingFor]);
    } else {
      await pool.query(`UPDATE staff SET username = NULL WHERE id = $1`, [changingFor]);
    }
  }

  if (newPassword) {
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [hash, changingFor]);
  }

  res.json({ success: true });
});

router.post("/auth/change-password", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const callerR = await pool.query(`SELECT id, role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  if (!caller) return res.status(401).json({ error: "Tài khoản không tồn tại" });

  const isAdmin = caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"));
  const { targetId, currentPassword, newPassword } = req.body as { targetId?: number; currentPassword?: string; newPassword?: string };
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 4 ký tự" });

  const changingFor = targetId ?? callerId;
  if (!isAdmin && changingFor !== callerId) return res.status(403).json({ error: "Không có quyền đổi mật khẩu người khác" });

  if (changingFor === callerId && currentPassword) {
    const r2 = await pool.query(`SELECT password_hash FROM staff WHERE id = $1`, [callerId]);
    const existing = (r2.rows[0] as Record<string, unknown>)?.password_hash as string | null;
    if (existing) {
      const matches = await bcrypt.compare(currentPassword, existing);
      if (!matches) return res.status(401).json({ error: "Mật khẩu hiện tại không đúng" });
    }
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [hash, changingFor]);
  res.json({ success: true });
});

export default router;
