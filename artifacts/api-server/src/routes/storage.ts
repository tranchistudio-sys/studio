import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { z } from "zod";
import express from "express";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import {
  useLocalObjectStorage,
  createLocalUploadTarget,
  createLocalCmsPublicUploadTarget,
  createLocalWeddingPublicUploadTarget,
  saveLocalUpload,
  saveLocalCmsPublicUpload,
  saveLocalWeddingPublicUpload,
  readLocalObject,
  readLocalWeddingPublicObject,
  localObjectExists,
  verifyLocalWeddingPublicUpload,
} from "../lib/localObjectStorage";
import { readLocalObjectWithPreviewFallback } from "../lib/preview-object-fallback";
import { ObjectPermission } from "../lib/objectAcl";
import {
  canonicalCmsObjectPath,
  ensureCmsPublicMediaRegistryInitialized,
  isCmsPublicNamespacePath,
  verifyCmsPublicObjectSignature,
} from "../lib/cms-public-media";

const RequestUploadUrlBody = z.object({
  name: z.string(),
  size: z.number(),
  contentType: z.string(),
});

const RequestUploadUrlResponse = z.object({
  uploadURL: z.string(),
  objectPath: z.string(),
  metadata: z.object({
    name: z.string(),
    size: z.number(),
    contentType: z.string(),
  }),
});

const CMS_PUBLIC_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const CMS_PUBLIC_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const CMS_PUBLIC_IMAGE_TYPES = new Set(["image/webp", "image/jpeg", "image/png", "image/gif", "image/avif"]);
const CMS_PUBLIC_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const CMS_PUBLIC_CONTENT_TYPE_SCHEMA = z.enum([
  "image/webp", "image/jpeg", "image/png", "image/gif", "image/avif",
  "video/mp4", "video/webm", "video/quicktime",
]);
function cmsPublicMaxBytes(contentType: string): number | null {
  if (CMS_PUBLIC_IMAGE_TYPES.has(contentType)) return CMS_PUBLIC_IMAGE_MAX_BYTES;
  if (CMS_PUBLIC_VIDEO_TYPES.has(contentType)) return CMS_PUBLIC_VIDEO_MAX_BYTES;
  return null;
}
const RequestCmsPublicUploadBody = z.object({
  name: z.string().min(1).max(180),
  size: z.number().int().positive().max(CMS_PUBLIC_VIDEO_MAX_BYTES),
  contentType: CMS_PUBLIC_CONTENT_TYPE_SCHEMA,
}).superRefine((value, context) => {
  const maxBytes = cmsPublicMaxBytes(value.contentType);
  if (maxBytes === null || value.size > maxBytes) {
    context.addIssue({ code: "custom", path: ["size"], message: "Media vượt quá dung lượng cho phép" });
  }
});

const WEDDING_PUBLIC_MAX_BYTES = 8 * 1024 * 1024;
const WEDDING_PUBLIC_CONTENT_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);
const RequestWeddingPublicUploadBody = z.object({
  name: z.string().min(1).max(180),
  size: z.number().int().positive().max(WEDDING_PUBLIC_MAX_BYTES),
  contentType: z.enum(["image/webp", "image/jpeg", "image/png"]),
});
const weddingUploadBuckets = new Map<string, { count: number; resetAt: number }>();

function allowWeddingUploadRequest(ip: string): boolean {
  const now = Date.now();
  const existing = weddingUploadBuckets.get(ip);
  const bucket = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + 60 * 60_000 }
    : existing;
  bucket.count += 1;
  weddingUploadBuckets.set(ip, bucket);
  if (weddingUploadBuckets.size > 5000) {
    for (const [key, value] of weddingUploadBuckets) {
      if (value.resetAt <= now) weddingUploadBuckets.delete(key);
    }
    while (weddingUploadBuckets.size > 5000) {
      const oldest = weddingUploadBuckets.keys().next().value as string | undefined;
      if (!oldest) break;
      weddingUploadBuckets.delete(oldest);
    }
  }
  return bucket.count <= 20;
}

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    if (useLocalObjectStorage()) {
      const { uploadURL, objectPath } = createLocalUploadTarget(req);
      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
      return;
    }

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    console.error("Error generating upload URL:", error);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * CMS website media has its own object namespace. The server chooses the UUID;
 * callers cannot promote an existing private /objects/uploads object.
 */
router.post("/storage/cms-public/uploads/request-url", async (req: Request, res: Response) => {
  const parsed = RequestCmsPublicUploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ảnh tối đa 20 MB; video MP4/WebM/MOV tối đa 100 MB" });
    return;
  }
  try {
    if (useLocalObjectStorage()) {
      const target = createLocalCmsPublicUploadTarget(req);
      res.json(RequestUploadUrlResponse.parse({
        ...target,
        metadata: parsed.data,
      }));
      return;
    }

    const uploadURL = await objectStorageService.getCmsPublicUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    const normalizedMatch = /^\/objects\/(.+)$/.exec(objectPath);
    if (!normalizedMatch || !isCmsPublicNamespacePath(normalizedMatch[1]!)) {
      throw new Error("Object storage returned a path outside cms-public");
    }
    res.json(RequestUploadUrlResponse.parse({
      uploadURL,
      objectPath,
      metadata: parsed.data,
    }));
  } catch {
    res.status(500).json({ error: "Không thể chuẩn bị upload media công khai" });
  }
});

router.put(
  "/storage/cms-public/uploads/local/:objectId",
  express.raw({ type: () => true, limit: "100mb" }),
  async (req: Request, res: Response) => {
    const rawId = req.params.objectId;
    const objectId = Array.isArray(rawId) ? rawId[0] : rawId;
    const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const maxBytes = cmsPublicMaxBytes(contentType);
    if (
      !objectId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(objectId) ||
      maxBytes === null ||
      body.length === 0 ||
      body.length > maxBytes
    ) {
      res.status(400).json({ error: "Upload media công khai không hợp lệ" });
      return;
    }
    try {
      await saveLocalCmsPublicUpload(
        objectId,
        body,
        contentType,
        String(req.headers["x-upload-name"] || `cms-${objectId}`),
      );
      res.status(204).send();
    } catch {
      res.status(500).json({ error: "Không thể lưu media công khai" });
    }
  },
);

/** Public wedding-card images live in a physically separate object prefix. */
router.post("/storage/wedding-public/uploads/request-url", async (req: Request, res: Response) => {
  const parsed = RequestWeddingPublicUploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Chỉ nhận ảnh WebP/JPEG/PNG tối đa 8 MB" });
    return;
  }
  if (!allowWeddingUploadRequest(req.ip || req.socket.remoteAddress || "unknown")) {
    res.status(429).json({ error: "Bạn đã tải lên quá nhiều ảnh. Vui lòng thử lại sau." });
    return;
  }
  try {
    // Upload luôn đi xuyên qua endpoint có raw-body limit 8 MB. Không phát
    // signed cloud PUT vì content-length do client khai có thể bị giả mạo.
    const target = createLocalWeddingPublicUploadTarget();
    res.json(RequestUploadUrlResponse.parse({
      ...target,
      metadata: parsed.data,
    }));
  } catch {
    res.status(500).json({ error: "Không thể chuẩn bị upload ảnh thiệp" });
  }
});

router.put(
  "/storage/wedding-public/uploads/local/:objectId",
  express.raw({ type: () => true, limit: "8mb" }),
  async (req: Request, res: Response) => {
    const rawId = req.params.objectId;
    const objectId = Array.isArray(rawId) ? rawId[0] : rawId;
    const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (
      !objectId ||
      !verifyLocalWeddingPublicUpload(objectId, req.query.exp, req.query.sig) ||
      !WEDDING_PUBLIC_CONTENT_TYPES.has(contentType) ||
      body.length === 0 ||
      body.length > WEDDING_PUBLIC_MAX_BYTES
    ) {
      res.status(400).json({ error: "Upload ảnh không hợp lệ" });
      return;
    }
    if (useLocalObjectStorage()) {
      await saveLocalWeddingPublicUpload(objectId, body, contentType, `wedding-${objectId}`);
    } else {
      await objectStorageService.saveWeddingPublicObject(objectId, body, contentType);
    }
    res.status(204).send();
  },
);

router.get("/storage/wedding-public/:objectId", async (req: Request, res: Response) => {
  const rawId = req.params.objectId;
  const objectId = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!objectId || !/^[0-9a-f-]{36}$/i.test(objectId)) {
    res.status(404).json({ error: "Object not found" });
    return;
  }
  try {
    if (useLocalObjectStorage()) {
      const local = await readLocalWeddingPublicObject(objectId);
      if (!local || !WEDDING_PUBLIC_CONTENT_TYPES.has(local.contentType) || local.body.length > WEDDING_PUBLIC_MAX_BYTES) {
        res.status(404).json({ error: "Object not found" });
        return;
      }
      res.setHeader("Content-Type", local.contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(local.body);
      return;
    }
    const file = await objectStorageService.getWeddingPublicFile(objectId);
    const [metadata] = await file.getMetadata();
    const contentType = String(metadata.contentType || "").toLowerCase();
    const size = Number(metadata.size || 0);
    if (!WEDDING_PUBLIC_CONTENT_TYPES.has(contentType) || !Number.isFinite(size) || size <= 0 || size > WEDDING_PUBLIC_MAX_BYTES) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    const response = await objectStorageService.downloadObject(file);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (!response.body) { res.end(); return; }
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    res.status(500).json({ error: "Failed to serve wedding image" });
  }
});

/** Local dev / fallback: receive PUT body and persist to disk. */
router.put(
  "/storage/uploads/local/:objectId",
  express.raw({ type: () => true, limit: "50mb" }),
  async (req: Request, res: Response) => {
    try {
      const rawId = req.params.objectId;
      const objectId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!objectId) {
        res.status(400).json({ error: "Invalid object id" });
        return;
      }
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
      if (!buf.length) {
        res.status(400).json({ error: "Empty body" });
        return;
      }
      const contentType = (req.headers["content-type"] as string) || "application/octet-stream";
      const name = (req.headers["x-upload-name"] as string) || `${objectId}`;
      await saveLocalUpload(objectId, buf, contentType, name);
      res.status(200).end();
    } catch (error) {
      console.error("Local upload save error:", error);
      res.status(500).json({ error: "Failed to save upload" });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error("Error serving public object:", error);
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/cms/objects/*
 *
 * Ảnh CMS hiển thị trên WEBSITE PUBLIC (váy cưới, áo dài, gallery/album,
 * concept, sản phẩm). File upload có tên UUID và không bao giờ ghi đè nội dung
 * → cache public dài hạn để CDN + browser giữ ảnh, giảm hẳn tải server khi
 * khách mở trang Cho thuê đồ. Ảnh nhạy cảm (bằng chứng cọc, nội bộ) KHÔNG đi
 * route này — vẫn dùng /storage/objects với cache private ngắn như cũ.
 */
const CMS_PUBLIC_IMAGE_CACHE = "public, max-age=3600, immutable";
router.get("/storage/cms/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    // The allow decision is registry-backed as well as signature-backed. A
    // valid-looking HMAC must never be sufficient to declassify a private file.
    await ensureCmsPublicMediaRegistryInitialized();
    if (
      !wildcardPath ||
      !canonicalCmsObjectPath(wildcardPath) ||
      !verifyCmsPublicObjectSignature(wildcardPath, req.query.exp, req.query.sig)
    ) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    const objectPath = `/objects/${wildcardPath}`;

    if (useLocalObjectStorage()) {
      // Preview theo PR: file thiếu trên đĩa → tự lấy đúng ảnh đó từ website
      // công khai của studio (GET read-only, xem preview-object-fallback.ts).
      const local = await readLocalObjectWithPreviewFallback(objectPath);
      const localMaxBytes = local ? cmsPublicMaxBytes(local.contentType.toLowerCase()) : null;
      if (
        local &&
        localMaxBytes !== null &&
        local.body.length > 0 &&
        local.body.length <= localMaxBytes
      ) {
        res.setHeader("Content-Type", local.contentType);
        res.setHeader("Cache-Control", CMS_PUBLIC_IMAGE_CACHE);
        res.send(local.body);
        return;
      }
      res.status(404).json({ error: "Object not found" });
      return;
    }

    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
    const [metadata] = await objectFile.getMetadata();
    const contentType = String(metadata.contentType || "").toLowerCase();
    const size = Number(metadata.size || 0);
    const maxBytes = cmsPublicMaxBytes(contentType);
    if (
      maxBytes === null ||
      !Number.isFinite(size) ||
      size <= 0 ||
      size > maxBytes
    ) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    // Đè Cache-Control private mặc định của downloadObject — route này chỉ cho ảnh public website.
    res.setHeader("Cache-Control", CMS_PUBLIC_IMAGE_CACHE);

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    console.error("Error serving cms public object:", error);
    res.status(500).json({ error: "Failed to serve object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;

    if (useLocalObjectStorage()) {
      // Preview theo PR: file thiếu → fallback website studio (read-only).
      const local = await readLocalObjectWithPreviewFallback(objectPath);
      if (local) {
        res.setHeader("Content-Type", local.contentType);
        res.setHeader("Cache-Control", "private, no-store");
        res.send(local.body);
        return;
      }
      res.status(404).json({ error: "Object not found" });
      return;
    }

    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    // --- Protected route example (uncomment when using replit-auth) ---
    // if (!req.isAuthenticated()) {
    //   res.status(401).json({ error: "Unauthorized" });
    //   return;
    // }
    // const canAccess = await objectStorageService.canAccessObjectEntity({
    //   userId: req.user.id,
    //   objectFile,
    //   requestedPermission: ObjectPermission.READ,
    // });
    // if (!canAccess) {
    //   res.status(403).json({ error: "Forbidden" });
    //   return;
    // }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Cache-Control", "private, no-store");

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    console.error("Error serving object:", error);
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
