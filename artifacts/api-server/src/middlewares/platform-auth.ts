import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool, runWithTenantDatabase } from "@workspace/db";
import { getPlatformPool, isPlatformDatabaseConfigured } from "@workspace/platform-db";
import { readLegacyToken, signLegacyToken } from "../lib/legacy-auth-token";
import {
  PLATFORM_SESSION_COOKIE,
  clearPlatformSessionCookie,
  csrfMatches,
  loadSessionFromRequest,
  revokeSession,
} from "../platform/session";
import type { PlatformSessionContext } from "../platform/types";
import { isCollaboratorSession } from "../platform/collaborator-permissions";
import {
  acquireTenantDatabase,
  acquireTenantDatabaseBySlug,
  TenantDatabaseUnavailableError,
  type TenantDatabaseLease,
} from "../platform/tenant-database-router";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const STAFF_BLOCKED_ALL_PREFIXES = [
  "/accounting",
  "/salary-rates",
  "/salary-overrides",
  "/staff-rates",
  "/fixed-costs",
  "/service-splits",
  "/check-ai-key",
] as const;

const STAFF_BLOCKED_WRITE_PREFIXES = [
  "/settings",
  "/services",
  "/pricing",
  "/service-groups",
  "/service-packages",
  "/surcharges",
] as const;

export function tenantRoleCanAccessBusiness(
  tenantRole: PlatformSessionContext["tenantRole"],
  method: string,
  path: string,
): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.toLowerCase();
  if (tenantRole === "OWNER" || tenantRole === "ADMIN") return true;
  if (tenantRole !== "STAFF") return false;
  if (STAFF_BLOCKED_ALL_PREFIXES.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) {
    return false;
  }
  if (
    !SAFE_METHODS.has(normalizedMethod) &&
    STAFF_BLOCKED_WRITE_PREFIXES.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))
  ) return false;
  if (!SAFE_METHODS.has(normalizedMethod) && (normalizedPath === "/staff" || normalizedPath.startsWith("/staff/"))) return false;
  return true;
}

export function collaboratorCanAccessBusiness(method: string, path: string): boolean {
  return method.toUpperCase() === "GET" && path.toLowerCase() === "/bookings/my-calendar";
}

export function platformContextCanAccessBusiness(
  context: PlatformSessionContext,
  method: string,
  path: string,
): boolean {
  if (isCollaboratorSession(context)) {
    return collaboratorCanAccessBusiness(method, path);
  }
  return tenantRoleCanAccessBusiness(context.tenantRole, method, path);
}

export function isPublicBusinessRoute(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.toLowerCase();
  if (normalizedMethod === "GET" && normalizedPath === "/healthz") return true;
  if (normalizedMethod === "GET" && normalizedPath === "/public/pricing") return true;
  if (normalizedMethod === "POST" && normalizedPath === "/public/photo-ideas/verify") return true;
  if (normalizedMethod === "GET" && normalizedPath === "/public/photo-ideas") return true;
  if (normalizedMethod === "POST" && normalizedPath === "/cms/public/visual-advisor") return true;
  if (normalizedMethod === "GET" && normalizedPath === "/cms/public/visual-advisor/meta") return true;
  if (normalizedMethod === "GET" && /^\/public\/contracts\/by-token\/[^/]+$/.test(normalizedPath)) return true;
  if (normalizedMethod === "POST" && /^\/public\/contracts\/by-token\/[^/]+\/sign$/.test(normalizedPath)) return true;
  if (normalizedMethod === "GET" && normalizedPath === "/cms/public/categories/dress/tree") return true;
  if (normalizedMethod === "GET" && normalizedPath === "/cms/public/dresses") return true;
  if (normalizedMethod === "GET" && /^\/cms\/public\/dresses\/slug\/[^/]+$/.test(normalizedPath)) return true;
  if (normalizedMethod === "GET" && normalizedPath === "/cms/public/packages") return true;
  if (normalizedMethod === "GET" && normalizedPath === "/cms/public/gallery/categories") return true;
  if (normalizedMethod === "GET" && normalizedPath === "/cms/public/gallery/albums") return true;
  if (normalizedMethod === "GET" && /^\/cms\/public\/gallery\/albums\/[^/]+$/.test(normalizedPath)) return true;
  if (normalizedMethod === "GET" && normalizedPath === "/cms/public/home") return true;
  if (normalizedMethod === "GET" && normalizedPath.startsWith("/storage/public-objects/")) return true;
  if (normalizedMethod === "GET" && normalizedPath.startsWith("/storage/cms/objects/")) return true;
  if (
    normalizedMethod === "GET" &&
    /^\/storage\/objects\/tenants\/[0-9a-f-]{36}\/fb-inbox-images\/[0-9a-f-]{36}\.(?:jpg|png|gif|webp)$/.test(normalizedPath)
  ) return true;
  if (normalizedMethod === "POST" && normalizedPath === "/storage/wedding-public/uploads/request-url") return true;
  // Standalone legacy mode still serves its existing signed wedding upload
  // URL. In platform mode the storage handler returns 404 before any write.
  if (normalizedMethod === "PUT" && /^\/storage\/wedding-public\/uploads\/local\/[0-9a-f-]{36}$/.test(normalizedPath)) return true;
  if (
    normalizedMethod === "PUT" &&
    /^\/storage\/wedding-public\/uploads\/local\/tenants\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(normalizedPath)
  ) return true;
  if (normalizedMethod === "GET" && /^\/storage\/wedding-public\/[0-9a-f-]{36}$/.test(normalizedPath)) return true;
  if (
    normalizedMethod === "GET" &&
    /^\/storage\/wedding-public\/tenants\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(normalizedPath)
  ) return true;
  if ((normalizedMethod === "GET" || normalizedMethod === "POST") && normalizedPath === "/webhook/facebook") return true;
  if (normalizedMethod === "GET" && normalizedPath === "/push/vapid-key") return true;
  if (normalizedMethod === "GET" && normalizedPath === "/attendance/studio-info") return true;
  if (normalizedMethod === "GET" && normalizedPath === "/wedding-cards/public/templates") return true;
  if (normalizedMethod === "GET" && /^\/wedding-cards\/public\/templates\/[^/]+$/.test(normalizedPath)) return true;
  if (normalizedMethod === "GET" && /^\/wedding-cards\/public\/[^/]+$/.test(normalizedPath)) return true;
  if (normalizedMethod === "GET" && /^\/wedding-cards\/public\/[^/]+\/guest-entries$/.test(normalizedPath)) return true;
  if (normalizedMethod === "POST" && normalizedPath === "/wedding-cards/public") return true;
  if (normalizedMethod === "POST" && /^\/wedding-cards\/public\/[^/]+\/guest-entries$/.test(normalizedPath)) return true;
  return false;
}

export function requestIsSameOrigin(req: Request): boolean {
  const origin = req.get("origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      const forwardedHost = req.get("x-forwarded-host") || req.get("host");
      const forwardedProto = req.get("x-forwarded-proto") || req.protocol;
      return parsed.host === forwardedHost && parsed.protocol === `${forwardedProto}:`;
    } catch {
      return false;
    }
  }
  const fetchSite = req.get("sec-fetch-site");
  return fetchSite === "same-origin" || (!fetchSite && process.env.NODE_ENV !== "production");
}

async function tenantStaffIsActive(staffId: number): Promise<boolean> {
  const result = await pool.query<{ id: number }>(
    "SELECT id FROM staff WHERE id = $1 AND is_active = 1 LIMIT 1",
    [staffId],
  );
  return Boolean(result.rows[0]);
}

function tenantUnavailable(res: Response): void {
  res.status(503).json({
    error: "Database của studio chưa sẵn sàng",
    code: "TENANT_DATABASE_UNAVAILABLE",
  });
}

async function handOffTenantLease(
  lease: TenantDatabaseLease,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const release = () => { void lease.release(); };
  res.once("finish", release);
  res.once("close", release);
  try {
    runWithTenantDatabase(lease.context, () => next());
  } catch (error) {
    res.off("finish", release);
    res.off("close", release);
    await lease.release();
    throw error;
  }
}

function normalizedPublicHost(req: Request): string | null {
  const raw = req.get("x-forwarded-host") || req.get("host");
  if (!raw || raw.includes(",")) return null;
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function configuredPublicTenantSlug(req: Request): string | null {
  const hostMap = process.env.PUBLIC_TENANT_HOST_MAP?.trim();
  if (hostMap) {
    const host = normalizedPublicHost(req);
    if (!host) return null;
    for (const pair of hostMap.split(",")) {
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const configuredHost = pair.slice(0, separator).trim().toLowerCase();
      const configuredSlug = pair.slice(separator + 1).trim().toLowerCase();
      if (host === configuredHost && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(configuredSlug)) {
        return configuredSlug;
      }
    }
    return null;
  }
  const slug = process.env.PUBLIC_TENANT_SLUG?.trim().toLowerCase();
  return slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

export async function bindTenantDatabaseBySlugForRequest(
  slug: string,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await handOffTenantLease(await acquireTenantDatabaseBySlug(slug), res, next);
  } catch {
    tenantUnavailable(res);
  }
}

export const businessAuthGuard: RequestHandler = async (req, res, next) => {
  if (isPublicBusinessRoute(req.method, req.path)) {
    // Health liveness is process-scoped and intentionally does not touch a DB.
    if (req.method.toUpperCase() === "GET" && req.path.toLowerCase() === "/healthz") {
      next();
      return;
    }
    if (!isPlatformDatabaseConfigured()) {
      next();
      return;
    }
    const slug = configuredPublicTenantSlug(req);
    if (!slug) {
      tenantUnavailable(res);
      return;
    }
    await bindTenantDatabaseBySlugForRequest(slug, res, next);
    return;
  }

  if (isPlatformDatabaseConfigured()) {
    try {
      const context = await loadSessionFromRequest(req);
      if (context) {
        if (!context.activeTenantId || !context.membershipId || !context.tenantStaffId) {
          res.status(409).json({
            error: "Vui lòng chọn studio trước khi sử dụng nghiệp vụ",
            code: "TENANT_SELECTION_REQUIRED",
          });
          return;
        }
        // Browser work that can outlive a render (notably the offline upload
        // queue) declares which already-authenticated tenant it was created
        // for. This header is only an assertion: the server session remains the
        // sole authority that selects the database.
        const expectedTenantId = req.get("x-tenant-id")?.trim();
        if (
          expectedTenantId &&
          expectedTenantId.toLowerCase() !== context.activeTenantId.toLowerCase()
        ) {
          res.status(409).json({
            error: "Studio của yêu cầu không còn khớp với phiên đăng nhập",
            code: "TENANT_CONTEXT_MISMATCH",
          });
          return;
        }
        if (!platformContextCanAccessBusiness(context, req.method, req.path)) {
          res.status(403).json({ error: "Role trong studio không có quyền sử dụng chức năng này" });
          return;
        }
        if (!SAFE_METHODS.has(req.method) && !requestIsSameOrigin(req)) {
          res.status(403).json({ error: "Yêu cầu bị từ chối do kiểm tra CSRF" });
          return;
        }

        // Bridge nội bộ 60 giây cho các route legacy đang gọi verifyToken().
        // Token này chỉ tồn tại trong request server, không trả về client hay log.
        let lease: TenantDatabaseLease;
        try {
          lease = await acquireTenantDatabase(context.activeTenantId);
        } catch (error) {
          if (error instanceof TenantDatabaseUnavailableError) {
            tenantUnavailable(res);
            return;
          }
          throw error;
        }
        let handedOff = false;
        try {
          let active: boolean;
          try {
            active = await runWithTenantDatabase(
              lease.context,
              () => tenantStaffIsActive(context.tenantStaffId!),
            );
          } catch {
            tenantUnavailable(res);
            return;
          }
          if (!active) {
            await revokeSession(context.sessionId, "tenant_staff_inactive");
            clearPlatformSessionCookie(res);
            res.status(401).json({ error: "Tài khoản nhân viên đã bị khóa" });
            return;
          }
          req.headers.authorization = `Bearer ${signLegacyToken(
            context.tenantStaffId,
            context.sessionId,
            60,
            context.tenantRole ?? "STAFF",
          )}`;
          res.locals.platformAuth = context;
          handedOff = true;
          await handOffTenantLease(lease, res, next);
        } finally {
          if (!handedOff) await lease.release();
        }
        return;
      }
      if (req.cookies?.[PLATFORM_SESSION_COOKIE]) {
        clearPlatformSessionCookie(res);
        res.status(401).json({ error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn" });
        return;
      }
    } catch {
      res.status(503).json({
        error: "Dịch vụ xác thực nền tảng tạm thời không khả dụng",
        code: "PLATFORM_AUTH_UNAVAILABLE",
      });
      return;
    }
  }

  const legacy = readLegacyToken(req.headers.authorization);
  // No compatibility flag in platform mode: an old bearer token must never
  // bypass user/tenant/membership/session revocation.
  const allowLegacy = !isPlatformDatabaseConfigured();
  if (!legacy || !allowLegacy || !(await tenantStaffIsActive(legacy.id))) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    return;
  }
  next();
};

export async function requirePlatformSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isPlatformDatabaseConfigured()) {
    res.status(503).json({ error: "Platform database chưa được cấu hình" });
    return;
  }
  try {
    const context = await loadSessionFromRequest(req);
    if (!context) {
      clearPlatformSessionCookie(res);
      res.status(401).json({ error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn" });
      return;
    }
    res.locals.platformAuth = context;
    next();
  } catch {
    res.status(503).json({
      error: "Dịch vụ xác thực nền tảng tạm thời không khả dụng",
      code: "PLATFORM_AUTH_UNAVAILABLE",
    });
  }
}

export function requirePlatformCsrf(req: Request, res: Response, next: NextFunction): void {
  const context = res.locals.platformAuth as PlatformSessionContext | undefined;
  if (!context || !csrfMatches(context, req.get("x-csrf-token"))) {
    res.status(403).json({ error: "CSRF token không hợp lệ" });
    return;
  }
  next();
}

export function requireActiveTenantManager(req: Request, res: Response, next: NextFunction): void {
  void req;
  const context = res.locals.platformAuth as PlatformSessionContext | undefined;
  if (!context?.activeTenantId || !context.membershipId) {
    res.status(409).json({ error: "Vui lòng chọn studio" });
    return;
  }
  if (
    isCollaboratorSession(context) ||
    (context.tenantRole !== "OWNER" && context.tenantRole !== "ADMIN")
  ) {
    res.status(403).json({ error: "Bạn không có quyền quản lý thành viên" });
    return;
  }
  next();
}
