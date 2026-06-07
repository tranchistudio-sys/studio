import { API_BASE } from "@/lib/api-base";
import type { UploadAttachTarget, UploadJob } from "./types";

function authHeaders(): HeadersInit {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function albumPaths(dress: {
  imageUrl?: string | null;
  publicImageUrl?: string | null;
  extraImages?: string[] | null;
}): string[] {
  const imgs: string[] = [];
  const primary = dress.imageUrl ?? dress.publicImageUrl ?? null;
  if (primary) imgs.push(primary);
  for (const x of dress.extraImages ?? []) {
    if (x && !imgs.includes(x)) imgs.push(x);
  }
  return imgs;
}

/** Apply uploaded objectPath to dress in DB. Idempotent — skips paths already present. */
export async function applyDressUpload(job: UploadJob): Promise<boolean> {
  const dressId = job.attach?.dressId;
  const p = job.objectPath;
  if (!dressId || !p || job.attach?.entity !== "dress") return false;

  const r = await fetch(`${API_BASE}/api/dresses/${dressId}`, { headers: authHeaders() });
  if (!r.ok) throw new Error("Không tải được sản phẩm để gắn ảnh");
  const dress = await r.json() as {
    imageUrl?: string | null;
    publicImageUrl?: string | null;
    coverImageUrl?: string | null;
    extraImages?: string[] | null;
  };

  const extra = [...(dress.extraImages ?? [])];
  let imageUrl = dress.imageUrl ?? dress.publicImageUrl ?? null;
  let coverImageUrl = dress.coverImageUrl ?? null;
  const existing = new Set(albumPaths(dress));
  if (existing.has(p) && (job.attach.mode !== "cover" || coverImageUrl === p)) {
    return true;
  }

  if (job.attach.mode === "cover") {
    coverImageUrl = p;
    if (!imageUrl) imageUrl = p;
    else if (!existing.has(p)) extra.push(p);
  } else {
    if (!imageUrl) imageUrl = p;
    else if (!existing.has(p)) extra.push(p);
  }

  const MAX = 20;
  const all = albumPaths({ imageUrl, extraImages: extra });
  if (all.length > MAX) {
    throw new Error(`Album đã đủ ${MAX} ảnh`);
  }

  const put = await fetch(`${API_BASE}/api/dresses/${dressId}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({
      imageUrl,
      publicImageUrl: imageUrl,
      extraImages: extra,
      coverImageUrl,
    }),
  });
  if (!put.ok) {
    const err = await put.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Không gắn được ảnh vào sản phẩm");
  }
  return true;
}

export async function applyUploadJob(job: UploadJob): Promise<boolean> {
  if (!job.attach || !job.objectPath) return false;
  if (job.attach.entity === "dress") return applyDressUpload(job);
  return false;
}

export function attachQueryKeys(attach?: UploadAttachTarget): string[][] {
  if (attach?.entity === "dress") {
    return [["cms-products"], ["cms-categories"]];
  }
  return [];
}
