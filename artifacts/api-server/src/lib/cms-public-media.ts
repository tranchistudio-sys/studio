import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { getTenantDatabaseIdentity } from "@workspace/db";
import {
  AMAZING_STUDIO_TENANT_SLUG,
  authorizeTenantMediaObjectPath,
  canonicalTenantMediaScope,
  type TenantMediaScope,
} from "./tenant-media-path";

const PUBLIC_MEDIA_TTL_SECONDS = 60 * 60;
const CMS_PUBLIC_OBJECT_PATTERN = /^cms-public\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Old CMS records used the shared /objects/uploads namespace. They are
 * grandfathered once, from CMS-owned tables, before requests are served.
 * New writes can never add another shared/private object to this set: they
 * must use /objects/cms-public/<uuid> instead.
 */
const legacyCmsPublicObjectRegistry = new Set<string>();
let registryInitialization: Promise<void> | null = null;
const tenantLegacyCmsPublicObjectRegistries = new Map<string, Set<string>>();
const tenantRegistryInitializations = new Map<string, Promise<void>>();

function currentTenantMediaScopeOrLegacy(): TenantMediaScope | null {
  try {
    const { tenantId, tenantSlug } = getTenantDatabaseIdentity();
    return canonicalTenantMediaScope({ tenantId, tenantSlug });
  } catch (error) {
    // Standalone legacy mode intentionally keeps the pre-PR2 behavior. Once
    // platform mode is configured, losing ALS context must fail closed.
    if (process.env.PLATFORM_DATABASE_URL?.trim()) throw error;
    return null;
  }
}

function mediaSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required for signed public media URLs");
  }
  return "development-public-media-secret";
}

export function canonicalCmsObjectPath(raw: string): string | null {
  const segments = raw.split("/");
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) {
    return null;
  }
  try {
    return segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join("/");
  } catch {
    return null;
  }
}

function objectPathFromValue(value: string): string | null {
  const match = /^(?:\/api\/storage)?\/objects\/([^?#]+)$/.exec(value.trim());
  return match ? canonicalCmsObjectPath(match[1]) : null;
}

export function isCmsPublicNamespacePath(rawPath: string): boolean {
  const path = canonicalCmsObjectPath(rawPath);
  return path !== null && CMS_PUBLIC_OBJECT_PATTERN.test(path);
}

export function isCmsPublicObjectPathAllowed(rawPath: string): boolean {
  const path = canonicalCmsObjectPath(rawPath);
  return path !== null && (
    CMS_PUBLIC_OBJECT_PATTERN.test(path) ||
    legacyCmsPublicObjectRegistry.has(path)
  );
}

function registerLegacyValue(
  value: unknown,
  depth = 0,
  registry: Set<string> = legacyCmsPublicObjectRegistry,
): void {
  if (depth > 12 || value == null) return;
  if (typeof value === "string") {
    const path = objectPathFromValue(value);
    if (path && !CMS_PUBLIC_OBJECT_PATTERN.test(path)) {
      registry.add(path);
      return;
    }
    const trimmed = value.trim();
    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try {
        registerLegacyValue(JSON.parse(trimmed), depth + 1, registry);
      } catch {
        // Legacy text columns are not guaranteed to contain valid JSON.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) registerLegacyValue(entry, depth + 1, registry);
    return;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      registerLegacyValue(entry, depth + 1, registry);
    }
  }
}

/**
 * Startup-only compatibility hook. Do not call this with an HTTP request
 * payload: doing so would turn private objects into public ones.
 */
export function registerLegacyCmsPublicObjectValues(value: unknown): void {
  registerLegacyValue(value);
}

function isMissingLegacyTable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42703";
}

async function loadLegacyCmsPublicObjectRegistry(
  registry: Set<string> = legacyCmsPublicObjectRegistry,
): Promise<void> {
  const { pool } = await import("@workspace/db");
  // Keep both table and field allowlists explicit. In particular, never scan
  // descriptions/notes: a private path pasted into ordinary text must not be
  // grandfathered as public merely because it existed before this release.
  const publicMediaSources = [
    { table: "gallery_albums", columns: ["cover_image_url"] },
    { table: "gallery_photos", columns: ["image_url"] },
    { table: "cms_categories", columns: ["cover_image_url"] },
    { table: "dresses", columns: ["image_url", "public_image_url", "cover_image_url", "extra_images"] },
    {
      table: "cms_home_settings",
      columns: [
        "hero_image_url",
        "about_image_url",
        "featured_concept_image_url",
        "featured_service_image_url",
        "footer_banner_image_url",
        "wedding_intro_image_1_url",
        "wedding_intro_image_2_url",
        "wedding_intro_image_3_url",
      ],
    },
    { table: "photo_ideas", columns: ["image_url", "public_image_url", "cover_image_url", "extra_images"] },
    {
      table: "wedding_templates",
      columns: ["thumbnail_url", "preview_image_url", "mockup_image_url", "default_background_url"],
    },
  ] as const;

  for (const source of publicMediaSources) {
    try {
      const selectedFields = source.columns
        .map((column) => `to_jsonb(source_row) -> '${column}'`)
        .join(", ");
      const result = await pool.query(
        `SELECT jsonb_build_array(${selectedFields}) AS data FROM ${source.table} AS source_row`,
      );
      for (const row of result.rows as Array<{ data?: unknown }>) {
        registerLegacyValue(row.data, 0, registry);
      }
    } catch (error) {
      // Fresh/test databases may not have every optional CMS module yet.
      if (!isMissingLegacyTable(error)) throw error;
    }
  }
}

export async function ensureCmsPublicMediaRegistryInitialized(): Promise<void> {
  if (!registryInitialization) {
    registryInitialization = loadLegacyCmsPublicObjectRegistry().catch((error) => {
      registryInitialization = null;
      throw error;
    });
  }
  await registryInitialization;
}

export async function ensureTenantCmsPublicMediaRegistryInitialized(
  scope: TenantMediaScope,
): Promise<void> {
  const canonicalScope = canonicalTenantMediaScope(scope);
  // Only Amazing owns the pre-tenant-prefix object tree. New tenants must not
  // scan their database and accidentally bless an arbitrary legacy path.
  if (canonicalScope.tenantSlug !== AMAZING_STUDIO_TENANT_SLUG) return;
  let initialization = tenantRegistryInitializations.get(canonicalScope.tenantId);
  if (!initialization) {
    const registry = tenantLegacyCmsPublicObjectRegistries.get(canonicalScope.tenantId) ?? new Set<string>();
    tenantLegacyCmsPublicObjectRegistries.set(canonicalScope.tenantId, registry);
    initialization = loadLegacyCmsPublicObjectRegistry(registry).catch((error) => {
      tenantRegistryInitializations.delete(canonicalScope.tenantId);
      throw error;
    });
    tenantRegistryInitializations.set(canonicalScope.tenantId, initialization);
  }
  await initialization;
}

/** Test isolation only. The production registry is immutable after startup. */
export function resetCmsPublicMediaRegistryForTests(): void {
  legacyCmsPublicObjectRegistry.clear();
  registryInitialization = null;
  tenantLegacyCmsPublicObjectRegistries.clear();
  tenantRegistryInitializations.clear();
}

function signatureFor(path: string, expires: number): string {
  return createHmac("sha256", mediaSecret())
    .update(`cms-public:${path}:${expires}`)
    .digest("base64url");
}

function tenantSignatureFor(
  scope: TenantMediaScope,
  path: string,
  expires: number,
): string {
  const canonicalScope = canonicalTenantMediaScope(scope);
  return createHmac("sha256", mediaSecret())
    .update(`cms-public:${canonicalScope.tenantId}:${path}:${expires}`)
    .digest("base64url");
}

export function isTenantCmsPublicObjectPathAllowed(
  scope: TenantMediaScope,
  rawPath: string,
): boolean {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const path = canonicalCmsObjectPath(rawPath);
  if (!path) return false;
  try {
    const authorized = authorizeTenantMediaObjectPath(
      canonicalScope,
      `/objects/${path}`,
      ["cms-public", "uploads"],
    );
    if (!authorized.legacy) return authorized.namespace === "cms-public";
    if (authorized.namespace === "cms-public") return true;
    return tenantLegacyCmsPublicObjectRegistries
      .get(canonicalScope.tenantId)
      ?.has(path) === true;
  } catch {
    return false;
  }
}

/** Test/provisioning hook; runtime request payloads must never call this. */
export function registerTenantLegacyCmsPublicObjectValues(
  scope: TenantMediaScope,
  value: unknown,
): void {
  const canonicalScope = canonicalTenantMediaScope(scope);
  if (canonicalScope.tenantSlug !== AMAZING_STUDIO_TENANT_SLUG) return;
  const registry = tenantLegacyCmsPublicObjectRegistries.get(canonicalScope.tenantId) ?? new Set<string>();
  tenantLegacyCmsPublicObjectRegistries.set(canonicalScope.tenantId, registry);
  registerLegacyValue(value, 0, registry);
}

export function signTenantCmsPublicObjectValue(
  scope: TenantMediaScope,
  value: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const path = objectPathFromValue(value);
  if (!path || !isTenantCmsPublicObjectPathAllowed(canonicalScope, path)) return value;
  const expires = nowSeconds + PUBLIC_MEDIA_TTL_SECONDS;
  const signature = tenantSignatureFor(canonicalScope, path, expires);
  return `/api/storage/cms/objects/${path}?exp=${expires}&sig=${signature}`;
}

export function verifyTenantCmsPublicObjectSignature(
  scope: TenantMediaScope,
  rawPath: string,
  rawExpires: unknown,
  rawSignature: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const path = canonicalCmsObjectPath(rawPath);
  const expires = typeof rawExpires === "string" && /^\d{10}$/.test(rawExpires)
    ? Number(rawExpires)
    : NaN;
  if (
    !path ||
    !isTenantCmsPublicObjectPathAllowed(canonicalScope, path) ||
    !Number.isSafeInteger(expires) ||
    expires < nowSeconds ||
    expires > nowSeconds + PUBLIC_MEDIA_TTL_SECONDS + 60 ||
    typeof rawSignature !== "string"
  ) {
    return false;
  }
  const actual = Buffer.from(rawSignature);
  const scopedExpected = Buffer.from(tenantSignatureFor(canonicalScope, path, expires));
  if (actual.length === scopedExpected.length && timingSafeEqual(actual, scopedExpected)) return true;

  // Keep already-rendered legacy Amazing URLs alive for their short TTL. The
  // old signature is never accepted for a prefixed/new-tenant object.
  try {
    const authorized = authorizeTenantMediaObjectPath(canonicalScope, `/objects/${path}`);
    if (!authorized.legacy) return false;
    const oldExpected = Buffer.from(signatureFor(path, expires));
    return actual.length === oldExpected.length && timingSafeEqual(actual, oldExpected);
  } catch {
    return false;
  }
}

export function normalizeTenantCmsPublicMediaReference(
  scope: TenantMediaScope,
  value: string,
): string | null {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const trimmed = value.trim();
  const objectPath = objectPathFromValue(trimmed);
  if (objectPath) {
    return isTenantCmsPublicObjectPathAllowed(canonicalScope, objectPath)
      ? `/objects/${objectPath}`
      : null;
  }
  try {
    const parsed = new URL(trimmed, "https://cms-media.invalid");
    const prefix = "/api/storage/cms/objects/";
    if (!parsed.pathname.startsWith(prefix)) return trimmed;
    const rawPath = parsed.pathname.slice(prefix.length);
    const canonicalPath = canonicalCmsObjectPath(rawPath);
    if (!canonicalPath || !verifyTenantCmsPublicObjectSignature(
      canonicalScope,
      canonicalPath,
      parsed.searchParams.get("exp"),
      parsed.searchParams.get("sig"),
    )) return null;
    return `/objects/${canonicalPath}`;
  } catch {
    return trimmed;
  }
}

export function findDisallowedTenantCmsObjectReference(
  scope: TenantMediaScope,
  value: unknown,
  depth = 0,
): string | null {
  if (depth > 12 || value == null) return null;
  if (typeof value === "string") {
    const path = objectPathFromValue(value);
    return path && !isTenantCmsPublicObjectPathAllowed(scope, path) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDisallowedTenantCmsObjectReference(scope, entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const found = findDisallowedTenantCmsObjectReference(scope, entry, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function rewriteTenantCmsPublicMediaForResponse(
  scope: TenantMediaScope,
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 12) return value;
  if (typeof value === "string") return signTenantCmsPublicObjectValue(scope, value);
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteTenantCmsPublicMediaForResponse(scope, entry, depth + 1));
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, rewriteTenantCmsPublicMediaForResponse(scope, entry, depth + 1)]),
    );
  }
  return value;
}

export function signCmsPublicObjectValue(value: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const path = objectPathFromValue(value);
  // Critical boundary: never sign an arbitrary /objects path. It must be in
  // the dedicated namespace or in the immutable legacy startup snapshot.
  if (!path || !isCmsPublicObjectPathAllowed(path)) return value;
  const expires = nowSeconds + PUBLIC_MEDIA_TTL_SECONDS;
  const signature = signatureFor(path, expires);
  return `/api/storage/cms/objects/${path}?exp=${expires}&sig=${signature}`;
}

export function isPrivateObjectReference(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const path = objectPathFromValue(value);
  return path !== null && !isCmsPublicObjectPathAllowed(path);
}

/**
 * Convert an approved raw or signed CMS media URL back to its stable object
 * reference before persisting it. Other public URL schemes are left intact.
 */
export function normalizeCmsPublicMediaReference(value: string): string | null {
  const scope = currentTenantMediaScopeOrLegacy();
  if (scope) return normalizeTenantCmsPublicMediaReference(scope, value);
  const trimmed = value.trim();
  const objectPath = objectPathFromValue(trimmed);
  if (objectPath) {
    return isCmsPublicObjectPathAllowed(objectPath) ? `/objects/${objectPath}` : null;
  }

  try {
    const parsed = new URL(trimmed, "https://cms-media.invalid");
    const prefix = "/api/storage/cms/objects/";
    if (!parsed.pathname.startsWith(prefix)) return trimmed;
    const rawPath = parsed.pathname.slice(prefix.length);
    const canonicalPath = canonicalCmsObjectPath(rawPath);
    if (!canonicalPath || !verifyCmsPublicObjectSignature(
      canonicalPath,
      parsed.searchParams.get("exp"),
      parsed.searchParams.get("sig"),
    )) {
      return null;
    }
    return `/objects/${canonicalPath}`;
  } catch {
    return trimmed;
  }
}

export function verifyCmsPublicObjectSignature(
  rawPath: string,
  rawExpires: unknown,
  rawSignature: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const path = canonicalCmsObjectPath(rawPath);
  const expires = typeof rawExpires === "string" && /^\d{10}$/.test(rawExpires)
    ? Number(rawExpires)
    : NaN;
  if (
    !path ||
    !isCmsPublicObjectPathAllowed(path) ||
    !Number.isSafeInteger(expires) ||
    expires < nowSeconds ||
    expires > nowSeconds + PUBLIC_MEDIA_TTL_SECONDS + 60
  ) {
    return false;
  }
  if (typeof rawSignature !== "string") return false;
  const actual = Buffer.from(rawSignature);
  const expected = Buffer.from(signatureFor(path, expires));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function findDisallowedCmsObjectReference(value: unknown, depth = 0): string | null {
  if (depth > 12 || value == null) return null;
  if (typeof value === "string") {
    const path = objectPathFromValue(value);
    return path && !isCmsPublicObjectPathAllowed(path) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDisallowedCmsObjectReference(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const found = findDisallowedCmsObjectReference(entry, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Apply this to every route that persists data later returned as public CMS content. */
export const validateCmsPublicMediaWrite: RequestHandler = async (req, res, next) => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  let scope: TenantMediaScope | null;
  try {
    scope = currentTenantMediaScopeOrLegacy();
    if (scope) await ensureTenantCmsPublicMediaRegistryInitialized(scope);
    else await ensureCmsPublicMediaRegistryInitialized();
  } catch {
    res.status(503).json({ error: "Kho media công khai tạm thời chưa sẵn sàng" });
    return;
  }
  const disallowed = scope
    ? findDisallowedTenantCmsObjectReference(scope, req.body)
    : findDisallowedCmsObjectReference(req.body);
  if (disallowed) {
    res.status(400).json({
      code: "CMS_PRIVATE_OBJECT_REFERENCE",
      error: "Nội dung công khai không được tham chiếu object nội bộ",
    });
    return;
  }
  next();
};

export function rewriteCmsPublicMediaForResponse(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === "string") return signCmsPublicObjectValue(value);
  if (Array.isArray(value)) return value.map((entry) => rewriteCmsPublicMediaForResponse(entry, depth + 1));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, rewriteCmsPublicMediaForResponse(entry, depth + 1)]),
    );
  }
  return value;
}

function isPublicContentResponse(path: string): boolean {
  return path === "/cms/public/categories/dress/tree" ||
    path === "/cms/public/dresses" ||
    /^\/cms\/public\/dresses\/slug\/[^/]+$/.test(path) ||
    path === "/cms/public/packages" ||
    path === "/cms/public/gallery/categories" ||
    path === "/cms/public/gallery/albums" ||
    /^\/cms\/public\/gallery\/albums\/[^/]+$/.test(path) ||
    path === "/cms/public/home" ||
    path === "/public/pricing" ||
    path === "/public/photo-ideas" ||
    path === "/wedding-cards/public/templates" ||
    /^\/wedding-cards\/public\/templates\/[^/]+$/.test(path) ||
    /^\/wedding-cards\/public\/(?!templates(?:\/|$))[^/]+$/.test(path);
}

export const signCmsPublicMediaResponses: RequestHandler = async (req, res, next) => {
  if (!isPublicContentResponse(req.path)) {
    next();
    return;
  }
  let scope: TenantMediaScope | null;
  try {
    scope = currentTenantMediaScopeOrLegacy();
    if (scope) await ensureTenantCmsPublicMediaRegistryInitialized(scope);
    else await ensureCmsPublicMediaRegistryInitialized();
  } catch {
    res.status(503).json({ error: "Kho media công khai tạm thời chưa sẵn sàng" });
    return;
  }
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(
    scope
      ? rewriteTenantCmsPublicMediaForResponse(scope, body)
      : rewriteCmsPublicMediaForResponse(body),
  )) as Response["json"];
  next();
};
