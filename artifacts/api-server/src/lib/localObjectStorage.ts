import { mkdir, writeFile, readFile, access } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

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

function safeObjectId(objectId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) return null;
  return objectId;
}

export function localObjectFsPath(objectId: string): string {
  return path.join(getLocalObjectStorageRoot(), "uploads", objectId);
}

export function localObjectMetaPath(objectId: string): string {
  return `${localObjectFsPath(objectId)}.meta.json`;
}

export async function localObjectExists(objectPath: string): Promise<boolean> {
  const m = objectPath.match(/^\/objects\/uploads\/([0-9a-f-]{36})$/i);
  if (!m) return false;
  try {
    await access(localObjectFsPath(m[1]!));
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

export async function readLocalObject(objectPath: string): Promise<{ body: Buffer; contentType: string } | null> {
  const m = objectPath.match(/^\/objects\/uploads\/([0-9a-f-]{36})$/i);
  if (!m) return null;
  const objectId = m[1]!;
  try {
    const body = await readFile(localObjectFsPath(objectId));
    let contentType = "application/octet-stream";
    try {
      const meta = JSON.parse(await readFile(localObjectMetaPath(objectId), "utf8")) as { contentType?: string };
      if (meta.contentType) contentType = meta.contentType;
    } catch { /* no meta */ }
    return { body, contentType };
  } catch {
    return null;
  }
}
