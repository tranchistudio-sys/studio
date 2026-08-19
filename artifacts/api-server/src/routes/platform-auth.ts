import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { getPlatformPool, isPlatformDatabaseConfigured, normalizeEmail } from "@workspace/platform-db";
import { createLoginRateLimit } from "../lib/login-rate-limit";
import {
  requestIsSameOrigin,
  requirePlatformCsrf,
  requirePlatformSession,
} from "../middlewares/platform-auth";
import {
  GoogleAuthenticationError,
  authenticateGoogle,
  responseForSession,
  selectTenantForSession,
  verifyGoogleCredential,
} from "../platform/service";
import {
  clearPlatformSessionCookie,
  issueLoginCsrf,
  revokeAllUserSessions,
  revokeSession,
  verifyLoginCsrf,
} from "../platform/session";
import type { PlatformSessionContext } from "../platform/types";
import { TenantDatabaseUnavailableError } from "../platform/tenant-database-router";

const router: IRouter = Router();
const loginRateLimit = createLoginRateLimit();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[0-9+(). -]{8,20}$/;

function contextFrom(res: Parameters<typeof requirePlatformSession>[1]): PlatformSessionContext {
  return res.locals.platformAuth as PlatformSessionContext;
}

function sendTenantDatabaseUnavailable(res: Parameters<typeof requirePlatformSession>[1]): void {
  res.status(503).json({
    error: "Database của studio chưa sẵn sàng",
    code: "TENANT_DATABASE_UNAVAILABLE",
  });
}

router.get("/auth/config", async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const platformEnabled = isPlatformDatabaseConfigured();
  const loginCsrfToken = issueLoginCsrf(res, req.cookies?.amazing_login_csrf);
  res.set("Cache-Control", "no-store");
  let registrationTenant: { id: string; name: string } | null = null;
  if (platformEnabled) {
    const slug = process.env.PUBLIC_TENANT_SLUG?.trim().toLowerCase() || "amazing-studio";
    const tenant = await getPlatformPool().query<{ id: string; name: string }>(
      `SELECT id, name FROM tenants
       WHERE slug = $1 AND status IN ('trial', 'active') LIMIT 1`,
      [slug],
    ).catch(() => ({ rows: [] as { id: string; name: string }[] }));
    registrationTenant = tenant.rows[0] ?? null;
  }
  res.json({
    platformEnabled,
    googleEnabled: platformEnabled && Boolean(clientId),
    ...(platformEnabled && clientId ? { googleClientId: clientId } : {}),
    loginCsrfToken,
    registrationEnabled: Boolean(registrationTenant),
    registrationTenantName: registrationTenant?.name,
  });
});

router.post("/auth/access-requests", (req, res, next) => {
  if (!requestIsSameOrigin(req)) {
    res.status(403).json({ error: "Nguồn yêu cầu không hợp lệ", code: "LOGIN_ORIGIN_INVALID" });
    return;
  }
  if (!verifyLoginCsrf(req, req.body?.loginCsrfToken)) {
    res.status(403).json({ error: "Phiên đăng ký đã hết hạn. Vui lòng tải lại trang.", code: "LOGIN_CSRF_INVALID" });
    return;
  }
  next();
}, loginRateLimit, async (req, res) => {
  if (!isPlatformDatabaseConfigured()) {
    res.status(503).json({ error: "Đăng ký thành viên chưa được bật" });
    return;
  }
  const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim().replace(/\s+/g, " ") : "";
  const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
  const requestedPosition = typeof req.body?.requestedPosition === "string"
    ? req.body.requestedPosition.trim().replace(/\s+/g, " ") : "";
  if (fullName.length < 2 || fullName.length > 100) {
    res.status(400).json({ error: "Vui lòng nhập họ tên hợp lệ" }); return;
  }
  if (!PHONE_PATTERN.test(phone)) {
    res.status(400).json({ error: "Vui lòng nhập số điện thoại hợp lệ" }); return;
  }
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    res.status(400).json({ error: "Vui lòng nhập Gmail hợp lệ" }); return;
  }
  if (requestedPosition.length < 2 || requestedPosition.length > 80) {
    res.status(400).json({ error: "Vui lòng nhập vị trí công việc" }); return;
  }
  try {
    const slug = process.env.PUBLIC_TENANT_SLUG?.trim().toLowerCase() || "amazing-studio";
    const tenant = await getPlatformPool().query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = $1 AND status IN ('trial', 'active') LIMIT 1`, [slug],
    );
    if (!tenant.rows[0]) {
      res.status(503).json({ error: "Studio chưa sẵn sàng nhận đăng ký" }); return;
    }
    const id = randomUUID();
    await getPlatformPool().query(
      `INSERT INTO tenant_access_requests
        (id, tenant_id, full_name, phone, email, requested_position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenant.rows[0].id, fullName, phone, email, requestedPosition],
    );
    res.status(201).json({ success: true, message: "Đã gửi yêu cầu. Chủ studio sẽ xét duyệt trước khi bạn được đăng nhập." });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Gmail hoặc số điện thoại này đã có yêu cầu đang chờ duyệt" }); return;
    }
    res.status(503).json({ error: "Chưa thể gửi yêu cầu lúc này. Vui lòng thử lại sau." });
  }
});

router.post("/auth/google", (req, res, next) => {
  if (!requestIsSameOrigin(req)) {
    res.status(403).json({ error: "Nguồn yêu cầu đăng nhập không hợp lệ", code: "LOGIN_ORIGIN_INVALID" });
    return;
  }
  if (!verifyLoginCsrf(req, req.body?.loginCsrfToken)) {
    res.status(403).json({ error: "Phiên trang đăng nhập không hợp lệ. Vui lòng tải lại trang.", code: "LOGIN_CSRF_INVALID" });
    return;
  }
  next();
}, loginRateLimit, async (req, res) => {
  const credential = req.body?.credential;
  if (typeof credential !== "string" || credential.length < 100 || credential.length > 20_000) {
    res.status(400).json({ error: "Google credential không hợp lệ" });
    return;
  }
  try {
    const profile = await verifyGoogleCredential(credential);
    const response = await authenticateGoogle(req, res, profile);
    res.set("Cache-Control", "no-store");
    res.json(response);
  } catch (error) {
    if (error instanceof TenantDatabaseUnavailableError) {
      sendTenantDatabaseUnavailable(res);
      return;
    }
    if (error instanceof GoogleAuthenticationError) {
      const status = error.code === "GOOGLE_NOT_INVITED" ? 403
        : error.code === "ACCOUNT_SUSPENDED" ? 403
        : error.code === "GOOGLE_NOT_CONFIGURED" ? 503
        : 401;
      res.status(status).json({ error: error.message, code: error.code });
      return;
    }
    res.status(503).json({ error: "Không thể hoàn tất đăng nhập Google lúc này" });
  }
});

// Session-first. Nếu không có cookie platform, chuyển tiếp cho auth legacy phía sau.
router.get("/auth/me", async (req, res, next) => {
  if (!isPlatformDatabaseConfigured() || !req.cookies?.amazing_session) {
    next();
    return;
  }
  try {
    const { loadSessionFromRequest } = await import("../platform/session");
    const context = await loadSessionFromRequest(req);
    if (!context) {
      clearPlatformSessionCookie(res);
      res.status(401).json({ error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn" });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json(await responseForSession(context));
  } catch (error) {
    if (error instanceof TenantDatabaseUnavailableError) {
      sendTenantDatabaseUnavailable(res);
      return;
    }
    res.status(503).json({ error: "Dịch vụ xác thực nền tảng tạm thời không khả dụng" });
  }
});

router.get("/auth/tenants", requirePlatformSession, async (_req, res) => {
  try {
    const context = contextFrom(res);
    const payload = await responseForSession(context);
    res.set("Cache-Control", "no-store");
    res.json({ memberships: payload.memberships, activeTenant: payload.activeTenant, csrfToken: payload.csrfToken });
  } catch (error) {
    if (error instanceof TenantDatabaseUnavailableError) {
      sendTenantDatabaseUnavailable(res);
      return;
    }
    res.status(503).json({ error: "Dịch vụ xác thực nền tảng tạm thời không khả dụng" });
  }
});

router.post(
  "/auth/select-tenant",
  requirePlatformSession,
  requirePlatformCsrf,
  async (req, res) => {
    const tenantId = req.body?.tenantId;
    if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
      res.status(400).json({ error: "Studio không hợp lệ" });
      return;
    }
    try {
      res.set("Cache-Control", "no-store");
      res.json(await selectTenantForSession(req, res, contextFrom(res), tenantId));
    } catch (error) {
      if (error instanceof TenantDatabaseUnavailableError) {
        sendTenantDatabaseUnavailable(res);
        return;
      }
      res.status(403).json({ error: error instanceof Error ? error.message : "Không thể chọn studio" });
    }
  },
);

router.post("/auth/logout", requirePlatformSession, requirePlatformCsrf, async (_req, res) => {
  const context = contextFrom(res);
  await revokeSession(context.sessionId, "logout");
  clearPlatformSessionCookie(res);
  await getPlatformPool().query(
    `INSERT INTO platform_audit_logs (id, actor_user_id, tenant_id, action, target_type, target_id)
     VALUES ($1, $2, $3, 'logout', 'session', $4)`,
    [randomUUID(), context.userId, context.activeTenantId, context.sessionId],
  );
  res.status(204).send();
});

router.post("/auth/logout-all", requirePlatformSession, requirePlatformCsrf, async (_req, res) => {
  const context = contextFrom(res);
  await revokeAllUserSessions(context.userId, "logout_all");
  clearPlatformSessionCookie(res);
  await getPlatformPool().query(
    `INSERT INTO platform_audit_logs (id, actor_user_id, tenant_id, action, target_type, target_id)
     VALUES ($1, $2, $3, 'logout.all', 'platform_user', $2)`,
    [randomUUID(), context.userId, context.activeTenantId],
  );
  res.status(204).send();
});

router.get("/auth/sessions", requirePlatformSession, async (_req, res) => {
  const context = contextFrom(res);
  const result = await getPlatformPool().query(
    `SELECT id, user_agent, created_at, last_seen_at, expires_at,
            (id = $2) AS current
     FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY last_seen_at DESC`,
    [context.userId, context.sessionId],
  );
  res.set("Cache-Control", "no-store");
  res.json(result.rows);
});

router.delete(
  "/auth/sessions/:sessionId",
  requirePlatformSession,
  requirePlatformCsrf,
  async (req, res) => {
    const context = contextFrom(res);
    const rawSessionId = req.params.sessionId;
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    if (!sessionId || !UUID_PATTERN.test(sessionId)) {
      res.status(400).json({ error: "Session không hợp lệ" });
      return;
    }
    const result = await getPlatformPool().query<{ id: string }>(
      `UPDATE sessions
       SET revoked_at = now(), revoked_reason = 'revoked_by_user'
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [sessionId, context.userId],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Không tìm thấy session" });
      return;
    }
    await getPlatformPool().query(
      `INSERT INTO platform_audit_logs
        (id, actor_user_id, tenant_id, action, target_type, target_id)
       VALUES ($1, $2, $3, 'session.revoked', 'session', $4)`,
      [randomUUID(), context.userId, context.activeTenantId, sessionId],
    );
    if (sessionId === context.sessionId) clearPlatformSessionCookie(res);
    res.status(204).send();
  },
);

export default router;
