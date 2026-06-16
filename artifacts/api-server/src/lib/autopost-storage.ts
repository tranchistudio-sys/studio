/**
 * autopost-storage.ts — Lưu buffer ảnh (tải từ nguồn ngoài như Google Drive) vào
 * object storage của app, trả về objectPath dạng `/objects/uploads/<uuid>` — phục vụ
 * Claude vision + đăng Facebook (đọc qua /api/storage giống mọi ảnh app/web).
 *
 * Tự chọn local-disk (dev) hay GCS (Replit) theo useLocalObjectStorage().
 */
import { randomUUID } from "node:crypto";
import {
  useLocalObjectStorage,
  createLocalUploadTarget,
  saveLocalUpload,
} from "./localObjectStorage";
import { objectStorageClient } from "./objectStorage";

/** Lưu 1 ảnh → trả objectPath `/objects/uploads/<uuid>` (serve qua /api/storage). */
export async function persistImageBuffer(
  buffer: Buffer,
  contentType: string,
  name: string,
): Promise<string> {
  if (useLocalObjectStorage()) {
    const { objectId, objectPath } = createLocalUploadTarget();
    await saveLocalUpload(objectId, buffer, contentType || "image/jpeg", name);
    return objectPath;
  }
  // GCS (Replit): ghi thẳng vào <PRIVATE_OBJECT_DIR>/uploads/<uuid>.
  const dir = (process.env.PRIVATE_OBJECT_DIR || "").replace(/\/+$/, "");
  if (!dir) throw new Error("PRIVATE_OBJECT_DIR chưa cấu hình cho object storage");
  const objectId = randomUUID();
  const full = `${dir}/uploads/${objectId}`.replace(/^\/+/, "");
  const [bucketName, ...rest] = full.split("/");
  const objectName = rest.join("/");
  await objectStorageClient
    .bucket(bucketName)
    .file(objectName)
    .save(buffer, { contentType: contentType || "image/jpeg", resumable: false });
  return `/objects/uploads/${objectId}`;
}
