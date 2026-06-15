import { convertToWebP } from "@/components/cms-shared";
import { API_BASE } from "@/lib/api-base";

/** Upload ảnh thiệp cưới — không cần đăng nhập, lưu qua storage hiện có. */
export async function uploadWeddingCardImage(file: File, kind: string): Promise<string> {
  const { blob, mimeType } = await convertToWebP(file, { maxDim: 1200, quality: 0.8 });
  const name = `wedding-${kind}-${Date.now()}.webp`;
  const r1 = await fetch(`${API_BASE}/api/storage/uploads/request-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, size: blob.size, contentType: mimeType }),
  });
  if (!r1.ok) {
    const err = (await r1.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Lỗi xin URL (${r1.status})`);
  }
  const { uploadURL, objectPath } = (await r1.json()) as { uploadURL: string; objectPath: string };
  const r2 = await fetch(uploadURL, { method: "PUT", body: blob, headers: { "Content-Type": mimeType } });
  if (!r2.ok) throw new Error(`Upload thất bại (${r2.status})`);
  return objectPath;
}
