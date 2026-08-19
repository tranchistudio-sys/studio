/**
 * autopost-storage.ts — Lưu buffer ảnh (tải từ nguồn ngoài như Google Drive) vào
 * object storage của app, trả về tenant-scoped objectPath — phục vụ
 * Claude vision + đăng Facebook (đọc qua /api/storage giống mọi ảnh app/web).
 *
 * Tự chọn local-disk (dev) hay GCS (Replit) theo useLocalObjectStorage().
 */
import { randomUUID } from "node:crypto";
import { getTenantDatabaseIdentity } from "@workspace/db";
import { isPlatformDatabaseConfigured } from "@workspace/platform-db";
import {
  useLocalObjectStorage,
  createLocalUploadTarget,
  createTenantLocalUploadTarget,
  saveLocalUpload,
  saveTenantLocalObject,
} from "./localObjectStorage";
import { objectStorageClient, ObjectStorageService } from "./objectStorage";

const objectStorageService = new ObjectStorageService();

/** Lưu 1 ảnh vào đúng prefix tenant hiện tại; thiếu ALS context thì fail closed. */
export async function persistImageBuffer(
  buffer: Buffer,
  contentType: string,
  name: string,
): Promise<string> {
  if (!isPlatformDatabaseConfigured()) {
    if (useLocalObjectStorage()) {
      const { objectId, objectPath } = createLocalUploadTarget();
      await saveLocalUpload(objectId, buffer, contentType || "image/jpeg", name);
      return objectPath;
    }
    const dir = (process.env.PRIVATE_OBJECT_DIR || "").replace(/\/+$/, "");
    if (!dir) throw new Error("PRIVATE_OBJECT_DIR chưa cấu hình cho object storage");
    const objectId = randomUUID();
    const full = `${dir}/uploads/${objectId}`.replace(/^\/+/, "");
    const [bucketName, ...rest] = full.split("/");
    await objectStorageClient.bucket(bucketName!).file(rest.join("/")).save(buffer, {
      contentType: contentType || "image/jpeg",
      resumable: false,
    });
    return `/objects/uploads/${objectId}`;
  }

  const { tenantId, tenantSlug } = getTenantDatabaseIdentity();
  const scope = { tenantId, tenantSlug };
  if (useLocalObjectStorage()) {
    const { objectId, objectPath } = createTenantLocalUploadTarget(scope, "uploads");
    await saveTenantLocalObject(
      scope,
      "uploads",
      objectId,
      buffer,
      contentType || "image/jpeg",
      name,
    );
    return objectPath;
  }
  const objectId = randomUUID();
  return objectStorageService.saveTenantObject(
    scope,
    "uploads",
    objectId,
    buffer,
    contentType || "image/jpeg",
  );
}
