import { Router, type IRouter, type RequestHandler } from "express";
import { pool } from "@workspace/db";
import bcrypt from "bcryptjs";
import { isPlatformDatabaseConfigured } from "@workspace/platform-db";
import { createLoginRateLimit } from "../lib/login-rate-limit";
import {
  bindTenantDatabaseBySlugForRequest,
  businessAuthGuard,
  requestIsSameOrigin,
} from "../middlewares/platform-auth";
import {
  readLegacyToken,
  signLegacyToken,
  verifyLegacyToken,
} from "../lib/legacy-auth-token";
import { establishLocalPlatformSession } from "../platform/service";
import { verifyLoginCsrf } from "../platform/session";
import {
  findTenantStaffMembership,
  platformContextFromResponse,
  revokeTenantStaffSessions,
} from "../platform/tenant-authorization";

const router: IRouter = Router();
const loginRateLimit = createLoginRateLimit();

const bindLegacyLoginTenant: RequestHandler = async (_req, res, next) => {
  if (!isPlatformDatabaseConfigured()) {
    next();
    return;
  }
  const slug = process.env.LEGACY_LOGIN_TENANT_SLUG?.trim().toLowerCase() || "amazing-studio";
  await bindTenantDatabaseBySlugForRequest(slug, res, next);
};

export async function getCallerRole(header: string | undefined): Promise<"admin" | "staff" | null> {
  const token = readLegacyToken(header);
  if (!token) return null;
  try {
    const r = await pool.query(`SELECT role, roles FROM staff WHERE id = $1 AND is_active = 1`, [token.id]);
    if (!r.rows.length) return null;
    if (token.tenantRole) return token.tenantRole === "STAFF" ? "staff" : "admin";
    const u = r.rows[0] as { role: string; roles: unknown };
    const isAdmin = u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin"));
    return isAdmin ? "admin" : "staff";
  } catch { return null; }
}

export function verifyToken(header: string | undefined): number | null {
  return verifyLegacyToken(header);
}

async function canManageOtherAccount(
  res: Parameters<typeof platformContextFromResponse>[0],
  targetStaffId: number,
): Promise<boolean | null> {
  const context = platformContextFromResponse(res);
  if (!context) return null;
  if (targetStaffId === context.tenantStaffId) return true;
  if (context.tenantRole !== "OWNER") return false;
  const target = await findTenantStaffMembership(context, targetStaffId);
  // A linked OWNER manages their own credential. Another OWNER cannot reset it.
  return target?.role !== "OWNER";
}

router.get("/auth/me", async (req, res) => {
  if (isPlatformDatabaseConfigured()) {
    return res.status(401).json({ error: "Phiên đăng nhập cũ không còn được chấp nhận" });
  }
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

router.post("/auth/login", (req, res, next) => {
  if (isPlatformDatabaseConfigured() && (
    !requestIsSameOrigin(req) || !verifyLoginCsrf(req, req.body?.loginCsrfToken)
  )) {
    return res.status(403).json({ error: "Phiên trang đăng nhập không hợp lệ. Vui lòng tải lại trang.", code: "LOGIN_CSRF_INVALID" });
  }
  next();
}, bindLegacyLoginTenant, loginRateLimit, async (req, res) => {
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
    return res.status(403).json({
      error: "Tài khoản này chưa được đặt mật khẩu. Vui lòng dùng Google hoặc liên hệ OWNER.",
    });
  }

  const ok = await bcrypt.compare(password, u.password_hash as string);
  if (!ok) return res.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu không đúng" });

  let platformResponse: Awaited<ReturnType<typeof establishLocalPlatformSession>>;
  try {
    platformResponse = await establishLocalPlatformSession(req, res, {
      id: Number(u.id),
      name: String(u.name),
      role: String(u.role),
      roles: u.roles,
      phone: String(u.phone),
      email: typeof u.email === "string" ? u.email : null,
      avatar: typeof u.avatar === "string" ? u.avatar : null,
      username: typeof u.username === "string" ? u.username : null,
    });
  } catch {
    return res.status(503).json({
      error: "Dịch vụ xác thực nền tảng tạm thời không khả dụng",
      code: "PLATFORM_AUTH_UNAVAILABLE",
    });
  }
  if (platformResponse) {
    res.set("Cache-Control", "no-store");
    return res.json(platformResponse);
  }

  res.json({
    token: signLegacyToken(Number(u.id), undefined, 12 * 60 * 60),
    user: { id: u.id, name: u.name, role: u.role, roles: u.roles ?? [], phone: u.phone, email: u.email, avatar: u.avatar, username: u.username },
  });
});

// Các route quản lý tài khoản phía dưới không phải public auth endpoints.
// Áp guard trực tiếp từng route để middleware này không vô tình chặn /healthz
// hoặc các router được mount sau authRouter.
router.get("/auth/staff-account/:id", businessAuthGuard, async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const targetId = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: "Tài khoản không hợp lệ" });
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const tenantRole = readLegacyToken(req.headers.authorization)?.tenantRole;
  const isAdmin = tenantRole
    ? tenantRole === "OWNER" || tenantRole === "ADMIN"
    : caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));
  const platformAllowed = await canManageOtherAccount(res, targetId);
  if (platformAllowed === false || (platformAllowed === null && !isAdmin)) {
    return res.status(403).json({ error: "Không có quyền" });
  }
  const r = await pool.query(`SELECT id, name, phone, username FROM staff WHERE id = $1`, [targetId]);
  if (r.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy nhân viên" });
  res.json(r.rows[0]);
});

router.post("/auth/update-account", businessAuthGuard, async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const callerR = await pool.query(`SELECT id, role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  if (!caller) return res.status(401).json({ error: "Tài khoản không tồn tại" });

  const tenantRole = readLegacyToken(req.headers.authorization)?.tenantRole;
  const isAdmin = tenantRole
    ? tenantRole === "OWNER" || tenantRole === "ADMIN"
    : caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"));
  const input = req.body as { targetId?: number; username?: string; newPassword?: string };
  const changingFor = input.targetId === undefined ? callerId : Number(input.targetId);
  const { username, newPassword } = input;
  if (!Number.isInteger(changingFor) || changingFor <= 0) return res.status(400).json({ error: "Tài khoản không hợp lệ" });

  const platformAllowed = await canManageOtherAccount(res, changingFor);
  if (platformAllowed === false || (platformAllowed === null && !isAdmin && changingFor !== callerId)) {
    return res.status(403).json({ error: "Không có quyền chỉnh tài khoản người khác" });
  }
  if (newPassword && newPassword.length < 8) return res.status(400).json({ error: "Mật khẩu phải có ít nhất 8 ký tự" });
  if (newPassword && changingFor === callerId) {
    return res.status(400).json({ error: "Hãy dùng chức năng đổi mật khẩu và nhập mật khẩu hiện tại" });
  }

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
    const context = platformContextFromResponse(res);
    if (context && changingFor !== callerId) {
      await revokeTenantStaffSessions(context, changingFor, "password_reset_by_owner");
    }
  }

  res.json({ success: true });
});

router.post("/auth/change-password", businessAuthGuard, async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const callerR = await pool.query(`SELECT id, role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  if (!caller) return res.status(401).json({ error: "Tài khoản không tồn tại" });

  const tenantRole = readLegacyToken(req.headers.authorization)?.tenantRole;
  const isAdmin = tenantRole
    ? tenantRole === "OWNER" || tenantRole === "ADMIN"
    : caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"));
  const input = req.body as { targetId?: number; currentPassword?: string; newPassword?: string };
  const { currentPassword, newPassword } = input;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 8 ký tự" });

  const changingFor = input.targetId === undefined ? callerId : Number(input.targetId);
  if (!Number.isInteger(changingFor) || changingFor <= 0) return res.status(400).json({ error: "Tài khoản không hợp lệ" });
  const platformAllowed = await canManageOtherAccount(res, changingFor);
  if (platformAllowed === false || (platformAllowed === null && !isAdmin && changingFor !== callerId)) {
    return res.status(403).json({ error: "Không có quyền đổi mật khẩu người khác" });
  }

  if (changingFor === callerId) {
    const r2 = await pool.query(`SELECT password_hash FROM staff WHERE id = $1`, [callerId]);
    const existing = (r2.rows[0] as Record<string, unknown>)?.password_hash as string | null;
    if (existing) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Vui lòng nhập mật khẩu hiện tại" });
      }
      const matches = await bcrypt.compare(currentPassword, existing);
      if (!matches) return res.status(401).json({ error: "Mật khẩu hiện tại không đúng" });
    }
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [hash, changingFor]);
  const context = platformContextFromResponse(res);
  if (context && changingFor !== callerId) {
    await revokeTenantStaffSessions(context, changingFor, "password_reset_by_owner");
  }
  res.json({ success: true });
});

export default router;
