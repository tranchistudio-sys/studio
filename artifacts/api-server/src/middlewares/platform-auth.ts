import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "@workspace/db";
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
import {
  registryMatchesAmazingRuntime,
  type TenantDatabaseRegistryRow,
} from "../platform/tenant-database-reference";

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
  if (normalizedMethod === "POST" && normalizedPath === "/storage/wedding-public/uploads/request-url") return true;
  if (normalizedMethod === "PUT" && /^\/storage\/wedding-public\/uploads\/local\/[0-9a-f-]{36}$/.test(normalizedPath)) return true;
  if (normalizedMethod === "GET" && /^\/storage\/wedding-public\/[0-9a-f-]{36}$/.test(normalizedPath)) return true;
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

async function tenantUsesCurrentDatabase(tenantId: string): Promise<boolean> {
  const result = await getPlatformPool().query<TenantDatabaseRegistryRow>(
    `SELECT database_ref, host_ref, database_name, role_name, secret_ref
     FROM tenant_database_registry WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  return registryMatchesAmazingRuntime(result.rows[0]);
}

async function tenantStaffIsActive(staffId: number): Promise<boolean> {
  const result = await pool.query<{ id: number }>(
    "SELECT id FROM staff WHERE id = $1 AND is_active = 1 LIMIT 1",
    [staffId],
  );
  return Boolean(result.rows[0]);
}

export const businessAuthGuard: RequestHandler = async (req, res, next) => {
  if (isPublicBusinessRoute(req.method, req.path)) {
    next();
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
        if (!tenantRoleCanAccessBusiness(context.tenantRole, req.method, req.path)) {
          res.status(403).json({ error: "Role trong studio không có quyền sử dụng chức năng này" });
          return;
        }
        if (!(await tenantUsesCurrentDatabase(context.activeTenantId))) {
          res.status(503).json({
            error: "Database của studio chưa sẵn sàng",
            code: "TENANT_DATABASE_UNAVAILABLE",
          });
          return;
        }
        if (!(await tenantStaffIsActive(context.tenantStaffId))) {
          await revokeSession(context.sessionId, "tenant_staff_inactive");
          clearPlatformSessionCookie(res);
          res.status(401).json({ error: "Tài khoản nhân viên đã bị khóa" });
          return;
        }
        if (!SAFE_METHODS.has(req.method) && !requestIsSameOrigin(req)) {
          res.status(403).json({ error: "Yêu cầu bị từ chối do kiểm tra CSRF" });
          return;
        }

        // Bridge nội bộ 60 giây cho các route legacy đang gọi verifyToken().
        // Token này chỉ tồn tại trong request server, không trả về client hay log.
        req.headers.authorization = `Bearer ${signLegacyToken(
          context.tenantStaffId,
          context.sessionId,
          60,
          context.tenantRole ?? "STAFF",
        )}`;
        res.locals.platformAuth = context;
        next();
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
  if (context.tenantRole !== "OWNER" && context.tenantRole !== "ADMIN") {
    res.status(403).json({ error: "Bạn không có quyền quản lý thành viên" });
    return;
  }
  next();
}
