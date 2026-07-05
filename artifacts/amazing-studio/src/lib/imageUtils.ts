export function getImageSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  if (!u) return null;
  if (u.startsWith("http://") || u.startsWith("https://")) return u;

  const path = u.startsWith("/") ? u : `/${u}`;
  const studioBase = import.meta.env.BASE_URL.replace(/\/$/, "") || "";

  // CMS local uploads — static files in amazing-studio/public/uploads/cms
  if (path.startsWith("/uploads/cms/") || path.startsWith("/uploads/")) {
    return `${studioBase}${path}`;
  }

  const apiExplicit = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  const apiBase = (apiExplicit || studioBase).replace(/\/$/, "") || "";
  if (path.startsWith("/objects/") || path.startsWith("/public-objects/")) {
    return `${apiBase}/api/storage${path}`;
  }

  return u;
}

/**
 * Ảnh CMS hiển thị trên WEBSITE PUBLIC (váy, áo dài, gallery, concept, sản phẩm).
 * Đi route /api/storage/cms/objects/... — server trả Cache-Control public dài hạn
 * để CDN/browser cache. CHỈ dùng cho ảnh public website; ảnh nhạy cảm (bằng chứng
 * cọc, nội bộ) phải dùng getImageSrc như cũ.
 */
export function getCmsImageSrc(url: string | null | undefined): string | null {
  const src = getImageSrc(url);
  if (!src) return null;
  return src.replace("/api/storage/objects/", "/api/storage/cms/objects/");
}
