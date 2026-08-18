/**
 * Canonical tenant boundary for objects stored below PRIVATE_OBJECT_DIR.
 *
 * New objects always use:
 *   /objects/tenants/<tenant UUID>/<namespace>/<server-generated object name>
 *
 * Paths without the `tenants/<tenant UUID>` prefix are legacy. They may only
 * be resolved while the authoritative server-side tenant context is Amazing
 * Studio. Tenant identity must never come from a request header/body/query.
 */

export const AMAZING_STUDIO_TENANT_SLUG = "amazing-studio";

export const TENANT_MEDIA_NAMESPACES = [
  "uploads",
  "cms-public",
  "wedding-public",
  "fb-inbox-images",
] as const;

export type TenantMediaNamespace = (typeof TENANT_MEDIA_NAMESPACES)[number];

export interface TenantMediaScope {
  tenantId: string;
  tenantSlug: string;
}

export type TenantMediaPathErrorCode =
  | "TENANT_MEDIA_SCOPE_INVALID"
  | "TENANT_MEDIA_PATH_INVALID"
  | "TENANT_MEDIA_NAMESPACE_FORBIDDEN"
  | "TENANT_MEDIA_TENANT_MISMATCH"
  | "TENANT_MEDIA_LEGACY_FORBIDDEN";

export class TenantMediaPathError extends Error {
  constructor(
    readonly code: TenantMediaPathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TenantMediaPathError";
  }
}

export interface AuthorizedTenantMediaObject {
  tenantId: string;
  namespace: TenantMediaNamespace;
  objectName: string;
  /** True for the pre-multitenant `<namespace>/<object>` layout. */
  legacy: boolean;
  /** Canonical application path. Legacy paths deliberately remain legacy. */
  objectPath: string;
  /** Key relative to PRIVATE_OBJECT_DIR / LOCAL_OBJECT_STORAGE_DIR. */
  storageKey: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FB_IMAGE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|gif|webp)$/i;
const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const namespaceSet = new Set<string>(TENANT_MEDIA_NAMESPACES);

function invalidScope(message: string): never {
  throw new TenantMediaPathError("TENANT_MEDIA_SCOPE_INVALID", message);
}

function invalidPath(message: string): never {
  throw new TenantMediaPathError("TENANT_MEDIA_PATH_INVALID", message);
}

function canonicalUuid(raw: string, source: "scope" | "path"): string {
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
    if (source === "scope") invalidScope("Tenant media scope has an invalid tenant id");
    invalidPath("Tenant media path has an invalid object id");
  }
  return raw.toLowerCase();
}

export function canonicalTenantMediaScope(scope: TenantMediaScope): TenantMediaScope {
  if (!scope || typeof scope !== "object") invalidScope("Tenant media scope is required");
  const tenantId = canonicalUuid(scope.tenantId, "scope");
  if (
    typeof scope.tenantSlug !== "string" ||
    !TENANT_SLUG_PATTERN.test(scope.tenantSlug)
  ) {
    invalidScope("Tenant media scope has an invalid tenant slug");
  }
  return { tenantId, tenantSlug: scope.tenantSlug };
}

function canonicalNamespace(raw: string): TenantMediaNamespace {
  if (!namespaceSet.has(raw)) invalidPath("Tenant media path has an unknown namespace");
  return raw as TenantMediaNamespace;
}

export function canonicalTenantMediaObjectName(
  namespace: TenantMediaNamespace,
  raw: string,
): string {
  if (namespace === "fb-inbox-images") {
    const match = FB_IMAGE_PATTERN.exec(raw);
    if (!match) invalidPath("Tenant media path has an invalid Facebook image name");
    return `${match[1]!.toLowerCase()}.${match[2]!.toLowerCase()}`;
  }
  return canonicalUuid(raw, "path");
}

function rejectAmbiguousPath(rawPath: string): void {
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.length > 320 ||
    rawPath !== rawPath.trim() ||
    rawPath.includes("%") ||
    rawPath.includes("\\") ||
    rawPath.includes("\0") ||
    rawPath.includes("?") ||
    rawPath.includes("#")
  ) {
    invalidPath("Tenant media path is malformed or ambiguously encoded");
  }
}

interface ParsedTenantMediaObject {
  tenantId: string | null;
  namespace: TenantMediaNamespace;
  objectName: string;
  legacy: boolean;
}

export function parseTenantMediaObjectPath(rawPath: string): ParsedTenantMediaObject {
  rejectAmbiguousPath(rawPath);
  const segments = rawPath.split("/");

  if (
    segments.length === 6 &&
    segments[0] === "" &&
    segments[1] === "objects" &&
    segments[2] === "tenants"
  ) {
    const tenantId = canonicalUuid(segments[3]!, "path");
    const namespace = canonicalNamespace(segments[4]!);
    const objectName = canonicalTenantMediaObjectName(namespace, segments[5]!);
    return { tenantId, namespace, objectName, legacy: false };
  }

  if (segments.length === 4 && segments[0] === "" && segments[1] === "objects") {
    const namespace = canonicalNamespace(segments[2]!);
    const objectName = canonicalTenantMediaObjectName(namespace, segments[3]!);
    return { tenantId: null, namespace, objectName, legacy: true };
  }

  invalidPath("Tenant media path does not match a supported canonical shape");
}

export function buildTenantMediaObjectPath(
  scope: TenantMediaScope,
  namespace: TenantMediaNamespace,
  objectName: string,
): string {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const canonicalName = canonicalTenantMediaObjectName(namespace, objectName);
  return `/objects/tenants/${canonicalScope.tenantId}/${namespace}/${canonicalName}`;
}

export function buildTenantMediaStorageKey(
  scope: TenantMediaScope,
  namespace: TenantMediaNamespace,
  objectName: string,
): string {
  return buildTenantMediaObjectPath(scope, namespace, objectName).slice("/objects/".length);
}

export function buildTenantLocalUploadUrl(
  scope: TenantMediaScope,
  namespace: Exclude<TenantMediaNamespace, "fb-inbox-images">,
  objectName: string,
): string {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const canonicalName = canonicalTenantMediaObjectName(namespace, objectName);
  const route = namespace === "uploads"
    ? "/api/storage/uploads/local"
    : `/api/storage/${namespace}/uploads/local`;
  return `${route}/tenants/${canonicalScope.tenantId}/${canonicalName}`;
}

export function buildTenantWeddingPublicUrl(
  scope: TenantMediaScope,
  objectName: string,
): string {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const canonicalName = canonicalTenantMediaObjectName("wedding-public", objectName);
  return `/api/storage/wedding-public/tenants/${canonicalScope.tenantId}/${canonicalName}`;
}

/**
 * Authorize a read against a trusted server-side tenant scope. This function
 * intentionally throws instead of returning a fallback path.
 */
export function authorizeTenantMediaObjectPath(
  scope: TenantMediaScope,
  rawPath: string,
  allowedNamespaces: readonly TenantMediaNamespace[] = TENANT_MEDIA_NAMESPACES,
): AuthorizedTenantMediaObject {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const parsed = parseTenantMediaObjectPath(rawPath);
  if (!allowedNamespaces.includes(parsed.namespace)) {
    throw new TenantMediaPathError(
      "TENANT_MEDIA_NAMESPACE_FORBIDDEN",
      "The requested media namespace is not permitted by this route",
    );
  }

  if (parsed.legacy) {
    if (canonicalScope.tenantSlug !== AMAZING_STUDIO_TENANT_SLUG) {
      throw new TenantMediaPathError(
        "TENANT_MEDIA_LEGACY_FORBIDDEN",
        "Legacy media paths are restricted to Amazing Studio",
      );
    }
    return {
      tenantId: canonicalScope.tenantId,
      namespace: parsed.namespace,
      objectName: parsed.objectName,
      legacy: true,
      objectPath: `/objects/${parsed.namespace}/${parsed.objectName}`,
      storageKey: `${parsed.namespace}/${parsed.objectName}`,
    };
  }

  if (parsed.tenantId !== canonicalScope.tenantId) {
    throw new TenantMediaPathError(
      "TENANT_MEDIA_TENANT_MISMATCH",
      "The requested object belongs to a different tenant",
    );
  }

  const objectPath = buildTenantMediaObjectPath(
    canonicalScope,
    parsed.namespace,
    parsed.objectName,
  );
  return {
    tenantId: canonicalScope.tenantId,
    namespace: parsed.namespace,
    objectName: parsed.objectName,
    legacy: false,
    objectPath,
    storageKey: objectPath.slice("/objects/".length),
  };
}

export function requireAmazingLegacyTenant(scope: TenantMediaScope): TenantMediaScope {
  const canonicalScope = canonicalTenantMediaScope(scope);
  if (canonicalScope.tenantSlug !== AMAZING_STUDIO_TENANT_SLUG) {
    throw new TenantMediaPathError(
      "TENANT_MEDIA_LEGACY_FORBIDDEN",
      "Legacy media paths are restricted to Amazing Studio",
    );
  }
  return canonicalScope;
}
