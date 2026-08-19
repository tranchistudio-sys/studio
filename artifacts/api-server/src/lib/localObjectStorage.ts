import { mkdir, writeFile, readFile, access } from "fs/promises";
import path from "path";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { fileURLToPath } from "url";
import {
  authorizeTenantMediaObjectPath,
  buildTenantLocalUploadUrl,
  buildTenantMediaObjectPath,
  buildTenantMediaStorageKey,
  buildTenantWeddingPublicUrl,
  canonicalTenantMediaObjectName,
  canonicalTenantMediaScope,
  type TenantMediaNamespace,
  type TenantMediaScope,
} from "./tenant-media-path";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** True when GCS/Replit object storage is not configured — use local disk instead. */
export function useLocalObjectStorage(): boolean {
  const dir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (process.env.FORCE_GCS_OBJECT_STORAGE === "1" && dir) return false;
  return !dir;
}

export function getLocalObjectStorageRoot(): string {
  const fromEnv = process.env.LOCAL_OBJECT_STORAGE_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(moduleDir, "../../data/object-storage");
}

async function uploadsDir(): Promise<string> {
  const dir = path.join(getLocalObjectStorageRoot(), "uploads");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function cmsPublicDir(): Promise<string> {
  const dir = path.join(getLocalObjectStorageRoot(), "cms-public");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function weddingPublicDir(): Promise<string> {
  const dir = path.join(getLocalObjectStorageRoot(), "wedding-public");
  await mkdir(dir, { recursive: true });
  return dir;
}

function safeObjectId(objectId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) return null;
  return objectId;
}

function safePathBelowStorageRoot(storageKey: string): string {
  const root = getLocalObjectStorageRoot();
  const resolved = path.resolve(root, ...storageKey.split("/"));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Tenant object path escaped the local storage root");
  }
  return resolved;
}

export function tenantLocalObjectFsPath(
  scope: TenantMediaScope,
  namespace: TenantMediaNamespace,
  objectName: string,
): string {
  return safePathBelowStorageRoot(buildTenantMediaStorageKey(scope, namespace, objectName));
}

export function tenantLocalObjectMetaPath(
  scope: TenantMediaScope,
  namespace: TenantMediaNamespace,
  objectName: string,
): string {
  return `${tenantLocalObjectFsPath(scope, namespace, objectName)}.meta.json`;
}

export function localObjectFsPath(objectId: string): string {
  return path.join(getLocalObjectStorageRoot(), "uploads", objectId);
}

export function localObjectMetaPath(objectId: string): string {
  return `${localObjectFsPath(objectId)}.meta.json`;
}

export function localCmsPublicObjectFsPath(objectId: string): string {
  return path.join(getLocalObjectStorageRoot(), "cms-public", objectId);
}

export function localCmsPublicObjectMetaPath(objectId: string): string {
  return `${localCmsPublicObjectFsPath(objectId)}.meta.json`;
}

export async function localObjectExists(objectPath: string): Promise<boolean> {
  const m = objectPath.match(/^\/objects\/(uploads|cms-public)\/([0-9a-f-]{36})$/i);
  if (!m) return false;
  try {
    await access(m[1]!.toLowerCase() === "cms-public"
      ? localCmsPublicObjectFsPath(m[2]!)
      : localObjectFsPath(m[2]!));
    return true;
  } catch {
    return false;
  }
}

export function createLocalUploadTarget(_req?: unknown) {
  const objectId = randomUUID();
  const objectPath = `/objects/uploads/${objectId}`;
  const uploadURL = `/api/storage/uploads/local/${objectId}`;
  return { uploadURL, objectPath, objectId };
}

export function createLocalCmsPublicUploadTarget(_req?: unknown) {
  const objectId = randomUUID();
  const objectPath = `/objects/cms-public/${objectId}`;
  const uploadURL = `/api/storage/cms-public/uploads/local/${objectId}`;
  return { uploadURL, objectPath, objectId };
}

function weddingUploadSignature(objectId: string, expires: number): string {
  const secret = process.env.SESSION_SECRET || "development-wedding-upload-secret";
  return createHmac("sha256", secret)
    .update(`wedding-public-upload:${objectId}:${expires}`)
    .digest("base64url");
}

export function createLocalWeddingPublicUploadTarget() {
  const objectId = randomUUID();
  const expires = Math.floor(Date.now() / 1000) + 15 * 60;
  const signature = weddingUploadSignature(objectId, expires);
  return {
    uploadURL: `/api/storage/wedding-public/uploads/local/${objectId}?exp=${expires}&sig=${signature}`,
    objectPath: `/api/storage/wedding-public/${objectId}`,
    objectId,
  };
}

export function createTenantLocalUploadTarget(
  scope: TenantMediaScope,
  namespace: "uploads" | "cms-public",
) {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const objectId = randomUUID();
  return {
    uploadURL: buildTenantLocalUploadUrl(canonicalScope, namespace, objectId),
    objectPath: buildTenantMediaObjectPath(canonicalScope, namespace, objectId),
    objectId,
  };
}

function tenantWeddingUploadSignature(
  scope: TenantMediaScope,
  objectId: string,
  expires: number,
): string {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const canonicalId = canonicalTenantMediaObjectName("wedding-public", objectId);
  const secret = process.env.SESSION_SECRET || "development-wedding-upload-secret";
  return createHmac("sha256", secret)
    .update(`wedding-public-upload:${canonicalScope.tenantId}:${canonicalId}:${expires}`)
    .digest("base64url");
}

export function createTenantLocalWeddingPublicUploadTarget(scope: TenantMediaScope) {
  const canonicalScope = canonicalTenantMediaScope(scope);
  const objectId = randomUUID();
  const expires = Math.floor(Date.now() / 1000) + 15 * 60;
  const signature = tenantWeddingUploadSignature(canonicalScope, objectId, expires);
  return {
    uploadURL: `${buildTenantLocalUploadUrl(canonicalScope, "wedding-public", objectId)}?exp=${expires}&sig=${signature}`,
    objectPath: buildTenantWeddingPublicUrl(canonicalScope, objectId),
    objectId,
  };
}

export function verifyTenantLocalWeddingPublicUpload(
  scope: TenantMediaScope,
  objectId: string,
  rawExpires: unknown,
  rawSignature: unknown,
): boolean {
  try {
    canonicalTenantMediaObjectName("wedding-public", objectId);
    canonicalTenantMediaScope(scope);
  } catch {
    return false;
  }
  if (typeof rawExpires !== "string" || !/^\d{10}$/.test(rawExpires)) return false;
  const expires = Number(rawExpires);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expires) || expires < now || expires > now + 16 * 60) return false;
  if (typeof rawSignature !== "string") return false;
  const actual = Buffer.from(rawSignature);
  const expected = Buffer.from(tenantWeddingUploadSignature(scope, objectId, expires));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyLocalWeddingPublicUpload(
  objectId: string,
  rawExpires: unknown,
  rawSignature: unknown,
): boolean {
  if (!safeObjectId(objectId) || typeof rawExpires !== "string" || !/^\d{10}$/.test(rawExpires)) return false;
  const expires = Number(rawExpires);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expires) || expires < now || expires > now + 16 * 60) return false;
  if (typeof rawSignature !== "string") return false;
  const actual = Buffer.from(rawSignature);
  const expected = Buffer.from(weddingUploadSignature(objectId, expires));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function saveLocalUpload(
  objectId: string,
  body: Buffer,
  contentType: string,
  name: string,
): Promise<void> {
  const id = safeObjectId(objectId);
  if (!id) throw new Error("Invalid object id");
  await uploadsDir();
  await writeFile(localObjectFsPath(id), body);
  await writeFile(
    localObjectMetaPath(id),
    JSON.stringify({ contentType, name, savedAt: new Date().toISOString() }),
    "utf8",
  );
}

export async function saveLocalCmsPublicUpload(
  objectId: string,
  body: Buffer,
  contentType: string,
  name: string,
): Promise<void> {
  const id = safeObjectId(objectId);
  if (!id) throw new Error("Invalid object id");
  await cmsPublicDir();
  await writeFile(localCmsPublicObjectFsPath(id), body);
  await writeFile(
    localCmsPublicObjectMetaPath(id),
    JSON.stringify({ contentType, name, savedAt: new Date().toISOString() }),
    "utf8",
  );
}

export async function saveLocalWeddingPublicUpload(
  objectId: string,
  body: Buffer,
  contentType: string,
  name: string,
): Promise<void> {
  const id = safeObjectId(objectId);
  if (!id) throw new Error("Invalid object id");
  const dir = await weddingPublicDir();
  await writeFile(path.join(dir, id), body);
  await writeFile(
    path.join(dir, `${id}.meta.json`),
    JSON.stringify({ contentType, name, savedAt: new Date().toISOString() }),
    "utf8",
  );
}

export async function saveTenantLocalObject(
  scope: TenantMediaScope,
  namespace: TenantMediaNamespace,
  objectName: string,
  body: Buffer,
  contentType: string,
  name: string,
): Promise<void> {
  const filePath = tenantLocalObjectFsPath(scope, namespace, objectName);
  const metaPath = tenantLocalObjectMetaPath(scope, namespace, objectName);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  await writeFile(
    metaPath,
    JSON.stringify({ contentType, name, savedAt: new Date().toISOString() }),
    "utf8",
  );
}

export async function readLocalWeddingPublicObject(
  objectId: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const id = safeObjectId(objectId);
  if (!id) return null;
  const dir = path.join(getLocalObjectStorageRoot(), "wedding-public");
  try {
    const body = await readFile(path.join(dir, id));
    const meta = JSON.parse(await readFile(path.join(dir, `${id}.meta.json`), "utf8")) as { contentType?: string };
    return { body, contentType: meta.contentType || "application/octet-stream" };
  } catch {
    return null;
  }
}

export async function readLocalObject(objectPath: string): Promise<{ body: Buffer; contentType: string } | null> {
  const m = objectPath.match(/^\/objects\/(uploads|cms-public)\/([0-9a-f-]{36})$/i);
  if (!m) return null;
  const namespace = m[1]!.toLowerCase();
  const objectId = m[2]!;
  const filePath = namespace === "cms-public"
    ? localCmsPublicObjectFsPath(objectId)
    : localObjectFsPath(objectId);
  const metaPath = namespace === "cms-public"
    ? localCmsPublicObjectMetaPath(objectId)
    : localObjectMetaPath(objectId);
  try {
    const body = await readFile(filePath);
    let contentType = "application/octet-stream";
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as { contentType?: string };
      if (meta.contentType) contentType = meta.contentType;
    } catch { /* no meta */ }
    return { body, contentType };
  } catch {
    return null;
  }
}

export async function readTenantLocalObject(
  scope: TenantMediaScope,
  objectPath: string,
  allowedNamespaces?: readonly TenantMediaNamespace[],
): Promise<{ body: Buffer; contentType: string } | null> {
  const authorized = authorizeTenantMediaObjectPath(scope, objectPath, allowedNamespaces);
  const filePath = safePathBelowStorageRoot(authorized.storageKey);
  const metaPath = `${filePath}.meta.json`;
  try {
    const body = await readFile(filePath);
    let contentType = "application/octet-stream";
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as { contentType?: string };
      if (meta.contentType) contentType = meta.contentType;
    } catch { /* no meta */ }
    return { body, contentType };
  } catch {
    return null;
  }
}

export async function tenantLocalObjectExists(
  scope: TenantMediaScope,
  objectPath: string,
  allowedNamespaces?: readonly TenantMediaNamespace[],
): Promise<boolean> {
  const authorized = authorizeTenantMediaObjectPath(scope, objectPath, allowedNamespaces);
  try {
    await access(safePathBelowStorageRoot(authorized.storageKey));
    return true;
  } catch {
    return false;
  }
}
