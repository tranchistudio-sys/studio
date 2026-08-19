import { API_BASE } from "@/lib/api-base";

export interface UploadedImage { objectPath: string; mimeType: string; name: string }
export type UploadStorageScope = "private" | "cms-public";
export type UploadRequestContext = {
  signal?: AbortSignal;
  /** Expected tenant for race-safe server validation during a studio switch. */
  tenantId?: string;
};

function authHeaders(tenantId?: string): HeadersInit {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(tenantId ? { "X-Tenant-Id": tenantId } : {}),
  };
}

// ─── Convert + resize ảnh sang WebP ngay trên client ────────────────────────
// Mặc định: max 1600px chiều dài cạnh lớn, quality 0.82 — đủ đẹp cho web,
// dung lượng nhỏ < 300KB cho hầu hết ảnh.
export async function convertToWebP(
  file: File | Blob,
  opts: { maxDim?: number; quality?: number } = {}
): Promise<{ blob: Blob; mimeType: string; width: number; height: number }> {
  const { maxDim = 1600, quality = 0.82 } = opts;
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * ratio);
  const h = Math.round(bitmap.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas không khả dụng");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob: Blob | null = await new Promise(resolve =>
    canvas.toBlob(b => resolve(b), "image/webp", quality)
  );
  if (!blob) {
    // Fallback: nếu trình duyệt không hỗ trợ WebP encode (Safari cũ) → giữ jpeg
    const jpeg: Blob | null = await new Promise(resolve =>
      canvas.toBlob(b => resolve(b), "image/jpeg", quality)
    );
    if (!jpeg) throw new Error("Không thể chuyển ảnh");
    return { blob: jpeg, mimeType: "image/jpeg", width: w, height: h };
  }
  return { blob, mimeType: "image/webp", width: w, height: h };
}

// ─── Upload qua presigned URL ───────────────────────────────────────────────
export async function uploadFileViaPresign(
  blob: Blob,
  name: string,
  mimeType: string,
  scope: UploadStorageScope = "private",
  context: UploadRequestContext = {},
): Promise<string> {
  const requestPath = scope === "cms-public"
    ? "/api/storage/cms-public/uploads/request-url"
    : "/api/storage/uploads/request-url";
  const r1 = await fetch(`${API_BASE}${requestPath}`, {
    method: "POST",
    headers: authHeaders(context.tenantId),
    credentials: "include",
    signal: context.signal,
    body: JSON.stringify({ name, size: blob.size, contentType: mimeType }),
  });
  if (!r1.ok) {
    const errBody = await r1.json().catch(() => ({})) as { error?: string };
    throw new Error(errBody.error ?? `Không tạo được link upload (${r1.status})`);
  }
  const { uploadURL, objectPath } = await r1.json() as { uploadURL: string; objectPath: string };
  const token = localStorage.getItem("amazingStudioToken_v2");
  const sameOriginUpload = uploadURL.startsWith("/");
  const r2 = await fetch(uploadURL, {
    method: "PUT",
    body: blob,
    signal: context.signal,
    credentials: sameOriginUpload ? "same-origin" : "omit",
    headers: {
      "Content-Type": mimeType,
      ...(sameOriginUpload ? { "X-Upload-Name": name } : {}),
      ...(sameOriginUpload && token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!r2.ok) throw new Error(`Upload thất bại (${r2.status})`);
  return objectPath;
}
