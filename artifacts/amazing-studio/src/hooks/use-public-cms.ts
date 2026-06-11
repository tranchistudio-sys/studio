import { useEffect } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CMS_BASE } from "@/components/cms-shared";

export interface PublicGalleryCategory {
  id: number;
  parentId: number | null;
  name: string;
  slug: string | null;
  coverImageUrl: string | null;
  fallbackCover?: string | null;
  sortOrder: number;
  productCount: number;
}

export interface PublicAlbum {
  id: number;
  name: string;
  slug: string;
  categoryId: number | null;
  tagsText: string | null;
  coverImageUrl: string | null;
  photoCount: number;
  videoCount: number;
  sortOrder?: number;
}

export interface PublicAlbumMedia {
  id: number;
  imageUrl: string;
  caption: string | null;
  mimeType: string | null;
  sortOrder: number;
}

export interface PublicPackage {
  id: number;
  code: string | null;
  name: string;
  price: number;
  shortDescription: string | null;
  description: string | null;
  products: string[];
  groupName: string | null;
}

export interface PublicDress {
  id: number;
  code: string;
  name: string;
  categoryId: number | null;
  rentalPrice: number;
  coverImageUrl: string | null;
  slug: string | null;
  rentalStatus: string;
}

/** CMS Trang chủ — optional settings; null fields → frontend fallback. */
export interface PublicHomeContent {
  heroImageUrl: string | null;
  aboutImageUrl: string | null;
  eyebrow: string | null;
  titleLine1: string | null;
  titleLine2: string | null;
  subtitle: string | null;
  ctaPrimaryLabel: string | null;
  ctaPrimaryHref: string | null;
  ctaSecondaryLabel: string | null;
  ctaSecondaryHref: string | null;
  featuredConceptImageUrl: string | null;
  featuredServiceImageUrl: string | null;
  footerBannerImageUrl: string | null;
  footerCtaTitle: string | null;
  footerCtaSubtitle: string | null;
  footerCtaButtonLabel: string | null;
  footerCtaButtonHref: string | null;
}

async function fetchPublicJson<T>(path: string, label: string): Promise<T> {
  const url = `${CMS_BASE}${path}`;
  const r = await fetch(url);
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (body as { error?: string } | null)?.error ?? r.statusText;
    throw new Error(`${label}: ${msg}`);
  }
  return body as T;
}

function parseAlbumList(body: unknown): PublicAlbum[] {
  if (!Array.isArray(body)) {
    if (import.meta.env.DEV) {
      console.warn("[public-gallery-albums] response is not an array", body);
    }
    return [];
  }
  return body as PublicAlbum[];
}

function parseCategoryList(body: unknown): PublicGalleryCategory[] {
  if (!Array.isArray(body)) {
    if (import.meta.env.DEV) {
      console.warn("[public-gallery-categories] response is not an array", body);
    }
    return [];
  }
  return body as PublicGalleryCategory[];
}

/** Concept ảnh — danh mục gallery (CMS Concept ảnh / Danh mục ảnh). */
export function usePublicGalleryCategories() {
  return useQuery<PublicGalleryCategory[]>({
    queryKey: ["public-gallery-categories"],
    queryFn: async () =>
      parseCategoryList(
        await fetchPublicJson<unknown>("/api/cms/public/gallery/categories", "Danh mục concept"),
      ),
    staleTime: 5 * 60 * 1000,
  });
}

/** Concept ảnh — album visible từ CMS gallery. */
export function usePublicGalleryAlbums() {
  return useQuery<PublicAlbum[]>({
    queryKey: ["public-gallery-albums"],
    queryFn: async () =>
      parseAlbumList(
        await fetchPublicJson<unknown>("/api/cms/public/gallery/albums", "Album concept"),
      ),
    staleTime: 5 * 60 * 1000,
  });
}

/** @deprecated Use usePublicGalleryAlbums — kept for gallery-detail */
export function usePublicAlbums() {
  return usePublicGalleryAlbums();
}

/** Trang chủ — nội dung CMS (settings), không dùng gallery albums. */
export function usePublicHomeContent() {
  return useQuery<PublicHomeContent>({
    queryKey: ["public-home"],
    queryFn: async () => {
      try {
        return await fetchPublicJson<PublicHomeContent>(
          "/api/cms/public/home",
          "Trang chủ",
        );
      } catch {
        return {
          heroImageUrl: null,
          aboutImageUrl: null,
          eyebrow: null,
          titleLine1: null,
          titleLine2: null,
          subtitle: null,
          ctaPrimaryLabel: null,
          ctaPrimaryHref: null,
          ctaSecondaryLabel: null,
          ctaSecondaryHref: null,
          featuredConceptImageUrl: null,
          featuredServiceImageUrl: null,
          footerBannerImageUrl: null,
          footerCtaTitle: null,
          footerCtaSubtitle: null,
          footerCtaButtonLabel: null,
          footerCtaButtonHref: null,
        };
      }
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function usePublicPackages() {
  return useQuery<PublicPackage[]>({
    queryKey: ["public-packages"],
    queryFn: async () => {
      const r = await fetch(`${CMS_BASE}/api/cms/public/packages`);
      if (!r.ok) throw new Error("Lỗi tải bảng giá");
      return r.json();
    },
  });
}

export function usePublicDresses() {
  return useQuery<PublicDress[]>({
    queryKey: ["public-dresses"],
    queryFn: async () => {
      const r = await fetch(`${CMS_BASE}/api/cms/public/dresses`);
      if (!r.ok) throw new Error("Lỗi tải sản phẩm");
      return r.json();
    },
  });
}

export function usePublicAlbumDetail(slug: string | null) {
  return useQuery({
    queryKey: ["public-gallery-album", slug],
    enabled: !!slug,
    queryFn: async () => {
      const r = await fetch(`${CMS_BASE}/api/cms/public/gallery/albums/${slug}`);
      if (!r.ok) throw new Error("Lỗi tải album");
      return r.json() as Promise<{
        id: number;
        name: string;
        slug: string;
        media: PublicAlbumMedia[];
      }>;
    },
  });
}

/** Dev-only trace: CMS → API → /bo-anh */
export function logPublicGalleryDebug(payload: {
  categories: PublicGalleryCategory[];
  albums: PublicAlbum[];
  tier1Id: number | null;
  tier2Id: number | null;
  filteredCount: number;
  uncategorizedCount: number;
}) {
  if (!import.meta.env.DEV) return;
  console.info("[bo-anh] public gallery", {
    categoriesCount: payload.categories.length,
    albumsCount: payload.albums.length,
    tier1Id: payload.tier1Id,
    tier2Id: payload.tier2Id,
    filteredAlbums: payload.filteredCount,
    uncategorizedAlbums: payload.uncategorizedCount,
    albumSample: payload.albums.slice(0, 5).map((a) => ({
      id: a.id,
      name: a.name,
      categoryId: a.categoryId,
      status: "visible",
    })),
  });
}

export function usePublicGalleryDebugEffect(
  enabled: boolean,
  payload: Parameters<typeof logPublicGalleryDebug>[0],
) {
  useEffect(() => {
    if (!enabled) return;
    logPublicGalleryDebug(payload);
  }, [
    enabled,
    payload.categories.length,
    payload.albums.length,
    payload.tier1Id,
    payload.tier2Id,
    payload.filteredCount,
    payload.uncategorizedCount,
  ]);
}

/** Build descendant id set for a category node (includes the node itself). */
export function getGalleryDescendantIds(
  categories: PublicGalleryCategory[],
  rootId: number,
): Set<number> {
  const childrenOf = new Map<number | null, PublicGalleryCategory[]>();
  for (const c of categories) {
    const k = c.parentId ?? null;
    if (!childrenOf.has(k)) childrenOf.set(k, []);
    childrenOf.get(k)!.push(c);
  }
  const result = new Set<number>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const k of childrenOf.get(cur) ?? []) {
      if (!result.has(k.id)) {
        result.add(k.id);
        stack.push(k.id);
      }
    }
  }
  return result;
}

/** Count visible albums under a category branch (client-side, matches grid filter). */
export function countAlbumsInBranch(
  albums: PublicAlbum[],
  categories: PublicGalleryCategory[],
  rootId: number,
): number {
  const ids = getGalleryDescendantIds(categories, rootId);
  return albums.filter((a) => a.categoryId != null && ids.has(a.categoryId)).length;
}
