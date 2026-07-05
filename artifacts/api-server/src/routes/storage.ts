import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { z } from "zod";
import express from "express";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import {
  useLocalObjectStorage,
  createLocalUploadTarget,
  saveLocalUpload,
  readLocalObject,
  localObjectExists,
} from "../lib/localObjectStorage";
import { ObjectPermission } from "../lib/objectAcl";

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

/** Local dev / fallback: receive PUT body and persist to disk. */
router.put(
  "/storage/uploads/local/:objectId",
  express.raw({ type: () => true, limit: "50mb" }),
  async (req: Request, res: Response) => {
    try {
      const objectId = req.params.objectId;
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
const CMS_PUBLIC_IMAGE_CACHE = "public, max-age=31536000, immutable";
router.get("/storage/cms/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;

    if (useLocalObjectStorage()) {
      if (await localObjectExists(objectPath)) {
        const local = await readLocalObject(objectPath);
        if (local) {
          res.setHeader("Content-Type", local.contentType);
          res.setHeader("Cache-Control", CMS_PUBLIC_IMAGE_CACHE);
          res.send(local.body);
          return;
        }
      }
      res.status(404).json({ error: "Object not found" });
      return;
    }

    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
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
      if (await localObjectExists(objectPath)) {
        const local = await readLocalObject(objectPath);
        if (local) {
          res.setHeader("Content-Type", local.contentType);
          res.setHeader("Cache-Control", "public, max-age=3600");
          res.send(local.body);
          return;
        }
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
