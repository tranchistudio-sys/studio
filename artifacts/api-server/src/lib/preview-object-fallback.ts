/**
 * preview-object-fallback.ts — ảnh cho BẢN XEM THỬ theo PR.
 *
 * Vấn đề (31/07): repo chỉ commit ~256 file ảnh, còn database preview (bản sao
 * đầy đủ) trỏ tới hàng nghìn ảnh nằm trong object storage của production →
 * container preview không có file → trang web toàn khung ảnh trắng.
 *
 * Cách xử lý: khi PREVIEW_MODE=1 và file không có trên đĩa, tải ĐÚNG tấm ảnh đó
 * từ WEBSITE CÔNG KHAI của studio (mặc định https://tranchistudio.com) — đúng
 * một request GET như bất kỳ khách nào đang xem web, KHÔNG đăng nhập, KHÔNG ghi,
 * KHÔNG đụng database production. Tải xong lưu xuống đĩa container (đường
 * saveLocalUpload chuẩn) để các lần sau đọc local, không gọi lại nữa.
 *
 * Chốt an toàn:
 *  - Chỉ chạy khi PREVIEW_MODE=1 (production/dev không bao giờ vào nhánh này).
 *  - Chỉ chấp nhận path dạng /objects/uploads/<uuid> — không proxy tuỳ tiện.
 *  - Host đích phải được khai trong PREVIEW_NET_ALLOW, nếu không preview-net-guard
 *    chặn ngay ở tầng mạng (mặc định CẤM).
 *  - Giới hạn 25MB + timeout 15s; lỗi gì cũng trả null → route trả 404 như cũ.
 */
import { isPreviewMode, type EnvLike } from "./preview-guard";
import { readLocalObject, saveLocalUpload } from "./localObjectStorage";
import { tenantScopedKey } from "./tenant-scope";

/** Giới hạn dung lượng một ảnh tải về (ảnh studio thường 1-3MB). */
const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const UPLOAD_PATH_RE = /^\/objects\/uploads\/([0-9a-f-]{36})$/i;

/** Path có đủ điều kiện dùng fallback không (chỉ uploads/<uuid>). */
export function eligibleObjectId(objectPath: string): string | null {
  const m = UPLOAD_PATH_RE.exec(objectPath);
  return m ? m[1]! : null;
}

/** Gốc website lấy ảnh — bỏ dấu / cuối. Trả null nếu bị tắt (env rỗng tường minh). */
export function fallbackBase(env: EnvLike = process.env): string | null {
  const raw = env.PREVIEW_OBJECT_FALLBACK_BASE;
  if (raw !== undefined && raw.trim() === "") return null; // đặt rỗng = tắt tính năng
  const base = (raw ?? "https://tranchistudio.com").trim().replace(/\/+$/, "");
  return /^https:\/\//.test(base) ? base : null; // chỉ chấp nhận https
}

export function buildFallbackUrl(objectPath: string, env: EnvLike = process.env): string | null {
  const id = eligibleObjectId(objectPath);
  const base = fallbackBase(env);
  if (!id || !base) return null;
  return `${base}/api/storage/objects/uploads/${id}`;
}

/** Các lượt tải đang chạy — tránh 30 thẻ <img> cùng lúc tải trùng 1 file. */
const inflight = new Map<string, Promise<{ body: Buffer; contentType: string } | null>>();

/**
 * Lấy ảnh thiếu từ website công khai của studio (chỉ trong preview).
 * Trả về nội dung + content-type, hoặc null nếu không lấy được (route sẽ 404).
 */
export async function previewFetchMissingObject(
  objectPath: string,
  env: EnvLike = process.env,
): Promise<{ body: Buffer; contentType: string } | null> {
  if (!isPreviewMode(env)) return null;
  const url = buildFallbackUrl(objectPath, env);
  if (!url) return null;
  const inflightKey = tenantScopedKey("preview-object", url);

  const existing = inflight.get(inflightKey);
  if (existing) return existing;

  const job = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;

      const declared = Number(res.headers.get("content-length") || "0");
      if (declared > MAX_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) return null;

      const contentType = res.headers.get("content-type") || "application/octet-stream";
      // Không cache nhầm trang HTML (SPA fallback của prod) thành "ảnh".
      if (contentType.includes("text/html")) return null;

      const id = eligibleObjectId(objectPath)!;
      try {
        await saveLocalUpload(id, buf, contentType, `preview-fallback-${id}`);
      } catch (err) {
        // Ghi đĩa lỗi thì vẫn phục vụ được lần này.
        console.warn(`[preview-object] Không lưu được cache ảnh ${id}: ${(err as Error).message}`);
      }
      console.log(`[preview-object] Đã lấy ảnh thiếu từ website studio: ${id} (${buf.length} bytes)`);
      return { body: buf, contentType };
    } catch (err) {
      console.warn(`[preview-object] Lỗi tải ảnh fallback: ${(err as Error).message}`);
      return null;
    } finally {
      inflight.delete(inflightKey);
    }
  })();

  inflight.set(inflightKey, job);
  return job;
}

/**
 * Đọc object local, nếu thiếu thì thử fallback (chỉ preview). Dùng chung cho các
 * route /storage/objects và /storage/cms/objects trong chế độ local storage.
 */
export async function readLocalObjectWithPreviewFallback(
  objectPath: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const local = await readLocalObject(objectPath);
  if (local) return local;
  return previewFetchMissingObject(objectPath);
}
