import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Camera, Images } from "lucide-react";
import { LazyImage } from "@/components/cms-shared";
import { Style3D, Tilt3D } from "@/components/public-3d";
import { PublicReveal, PublicRevealItem } from "@/components/public/PublicReveal";
import { GALLERY_PAGE } from "@/lib/public-site-config";
import {
  countAlbumsInBranch,
  usePublicGalleryAlbums,
  usePublicGalleryCategories,
  usePublicGalleryDebugEffect,
  getGalleryDescendantIds,
  type PublicAlbum,
  type PublicGalleryCategory,
} from "@/hooks/use-public-cms";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 60;
const ALL_TAB_KEY = "all" as const;

function parseCSV(v: string | null | undefined): string[] {
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export default function PublicGalleryPage() {
  const [location, setLocation] = useLocation();
  const [tier1Id, setTier1Id] = useState<number | null>(null);
  const [tier2Id, setTier2Id] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  const { data: cats = [], isLoading: catsLoading, isError: catsError } =
    usePublicGalleryCategories();
  const { data: albums = [], isLoading: albumsLoading, isError: albumsError } =
    usePublicGalleryAlbums();

  const catById = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const childrenOf = useMemo(() => {
    const m = new Map<number | null, PublicGalleryCategory[]>();
    for (const c of cats) {
      const k = c.parentId ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(c);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return m;
  }, [cats]);

  const tier1 = childrenOf.get(null) ?? [];
  const tier2 = tier1Id != null ? (childrenOf.get(tier1Id) ?? []) : [];

  const uncategorizedCount = useMemo(
    () => albums.filter((a) => a.categoryId == null).length,
    [albums],
  );

  const didDeepLink = useRef(false);
  useEffect(() => {
    if (didDeepLink.current || cats.length === 0) return;
    const sp = new URLSearchParams(window.location.search);
    const cid = sp.get("categoryId");
    if (cid) {
      const id = parseInt(cid, 10);
      if (!Number.isNaN(id)) {
        const node = catById.get(id);
        if (node) {
          const path: PublicGalleryCategory[] = [];
          let cur: PublicGalleryCategory | undefined = node;
          while (cur) {
            path.unshift(cur);
            cur = cur.parentId == null ? undefined : catById.get(cur.parentId);
          }
          if (path[0]) setTier1Id(path[0].id);
          if (path[1]) setTier2Id(path[1].id);
          else setTier2Id(path.length > 1 ? path[path.length - 1].id : null);
        }
      }
    }
    didDeepLink.current = true;
  }, [cats, catById]);

  useEffect(() => {
    const path = location.split("?")[0];
    const sp = new URLSearchParams(window.location.search);
    const selected = tier2Id ?? tier1Id;
    if (selected == null) {
      if (sp.has("categoryId")) {
        sp.delete("categoryId");
        const q = sp.toString();
        setLocation(q ? `${path}?${q}` : path, { replace: true });
      }
      return;
    }
    if (sp.get("categoryId") === String(selected)) return;
    sp.set("categoryId", String(selected));
    setLocation(`${path}?${sp.toString()}`, { replace: true });
  }, [tier1Id, tier2Id, location, setLocation]);

  function pickTier1(id: number | null) {
    setTier1Id(id);
    setTier2Id(null);
    setVisibleCount(PAGE_SIZE);
  }
  function pickTier2(id: number | null) {
    setTier2Id(id);
    setVisibleCount(PAGE_SIZE);
  }

  const filterNodeId = tier2Id ?? tier1Id;
  const descendantIds = useMemo(() => {
    if (filterNodeId == null) return null;
    return getGalleryDescendantIds(cats, filterNodeId);
  }, [filterNodeId, cats]);

  const filteredAlbums = useMemo(() => {
    if (tier1Id == null) {
      return albums;
    }
    if (filterNodeId == null || !descendantIds) {
      return albums;
    }
    return albums.filter(
      (a) => a.categoryId != null && descendantIds.has(a.categoryId),
    );
  }, [albums, tier1Id, filterNodeId, descendantIds]);

  const tier1Tabs = useMemo(() => {
    const allCount = albums.length;
    return [
      { id: null as number | null, name: "Tất cả", count: allCount, cover: null as string | null },
      ...tier1.map((t1) => ({
        id: t1.id,
        name: t1.name,
        count: countAlbumsInBranch(albums, cats, t1.id),
        cover: t1.coverImageUrl ?? t1.fallbackCover ?? null,
      })),
    ];
  }, [tier1, albums, cats]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sentinelRef.current) return;
    if (filteredAlbums.length <= visibleCount) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((c) => Math.min(c + PAGE_SIZE, filteredAlbums.length));
        }
      },
      { rootMargin: "300px" },
    );
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [filteredAlbums.length, visibleCount]);

  const shownAlbums = filteredAlbums.slice(0, visibleCount);
  const loading = catsLoading || albumsLoading;
  const fetchError = catsError || albumsError;

  usePublicGalleryDebugEffect(!loading, {
    categories: cats,
    albums,
    tier1Id,
    tier2Id,
    filteredCount: filteredAlbums.length,
    uncategorizedCount,
  });

  const breadcrumbLabel = useMemo(() => {
    if (tier1Id == null) return "Tất cả concept";
    const parts: string[] = [];
    const nodeId = tier2Id ?? tier1Id;
    let cur = catById.get(nodeId);
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parentId == null ? undefined : catById.get(cur.parentId);
    }
    return parts.join(" · ");
  }, [tier1Id, tier2Id, catById]);

  return (
    <div className="pb-20 sm:pb-28">
      <Style3D />
      <GalleryHero />

      <div className="max-w-7xl mx-auto px-5 sm:px-8 pt-10 sm:pt-14 pb-6">
        {fetchError && (
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Không tải được dữ liệu concept. Kiểm tra API server (port 3000) đang chạy.
          </div>
        )}

        {loading ? (
          <>
            <div className="flex gap-3 overflow-hidden mb-10">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="gallery-skeleton h-24 w-44 rounded-xl flex-shrink-0"
                />
              ))}
            </div>
            <GalleryGridSkeleton />
          </>
        ) : albums.length === 0 && tier1.length === 0 ? (
          <GalleryEmptyState />
        ) : (
          <>
            {tier1.length > 0 && (
              <PublicReveal className="mb-8 sm:mb-10">
                <div
                  className="flex gap-3 sm:gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory"
                  style={{ WebkitOverflowScrolling: "touch" }}
                >
                  {tier1Tabs.map((tab) => {
                    const active =
                      tab.id === null ? tier1Id == null : tier1Id === tab.id;
                    return (
                      <button
                        key={tab.id ?? ALL_TAB_KEY}
                        type="button"
                        onClick={() => pickTier1(tab.id)}
                        className={cn(
                          "gallery-tab snap-start flex items-center gap-3 min-w-[168px] sm:min-w-[200px] max-w-[240px] px-3 py-2.5 sm:px-4 sm:py-3 text-left",
                          active && "is-active",
                        )}
                      >
                        <div
                          className={cn(
                            "w-12 h-12 sm:w-14 sm:h-14 flex-shrink-0 rounded-lg overflow-hidden border",
                            active ? "border-white/30" : "border-neutral-200/80 bg-neutral-100",
                          )}
                        >
                          {tab.cover ? (
                            <LazyImage src={tab.cover} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Camera
                                className={cn(
                                  "w-5 h-5",
                                  active ? "text-white/70" : "text-neutral-400",
                                )}
                              />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div
                            className={cn(
                              "text-sm font-medium leading-snug line-clamp-2",
                              active ? "text-white" : "text-neutral-800",
                            )}
                          >
                            {tab.name}
                          </div>
                          <div
                            className={cn(
                              "text-[11px] mt-0.5",
                              active ? "text-white/80" : "text-neutral-500",
                            )}
                          >
                            {tab.count} album
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </PublicReveal>
            )}

            {tier1Id != null && tier2.length > 0 && (
              <div className="flex flex-wrap justify-center gap-2 mb-8">
                <Tier2Chip
                  active={tier2Id == null}
                  onClick={() => pickTier2(null)}
                  label="Tất cả"
                />
                {tier2.map((t2) => (
                  <Tier2Chip
                    key={t2.id}
                    active={tier2Id === t2.id}
                    onClick={() => pickTier2(t2.id)}
                    label={t2.name}
                  />
                ))}
              </div>
            )}

            {uncategorizedCount > 0 && tier1Id == null && (
              <p className="text-center text-xs text-neutral-500 mb-6">
                {uncategorizedCount} album chưa gán danh mục — vẫn hiển thị tại{" "}
                <span className="font-medium text-neutral-700">Tất cả</span>
              </p>
            )}

            <p className="text-center text-xs tracking-[0.2em] uppercase text-neutral-500 mb-6">
              {breadcrumbLabel}
              <span className="text-neutral-400 mx-2">—</span>
              <span className="text-neutral-700">{filteredAlbums.length} album</span>
            </p>

            {filteredAlbums.length === 0 ? (
              <GalleryCategoryEmpty hasAlbums={albums.length > 0} />
            ) : (
              <PublicReveal stagger>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6 lg:gap-8">
                  {shownAlbums.map((a) => (
                    <PublicRevealItem key={a.id}>
                      <GalleryAlbumCard
                        album={a}
                        href={`${BASE}/bo-anh/${a.slug}`}
                        onNavigate={() => setLocation(`${BASE}/bo-anh/${a.slug}`)}
                      />
                    </PublicRevealItem>
                  ))}
                </div>
                {visibleCount < filteredAlbums.length && (
                  <div
                    ref={sentinelRef}
                    className="text-center py-10 text-xs tracking-widest uppercase text-neutral-400"
                  >
                    Đang tải thêm...
                  </div>
                )}
              </PublicReveal>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GalleryHero() {
  return (
    <section className="gallery-hero relative overflow-hidden px-5 sm:px-8 pt-14 sm:pt-20 pb-16 sm:pb-24">
      {/* Orbs gradient mềm bay lơ lửng tạo chiều sâu */}
      <div aria-hidden className="absolute inset-0 pointer-events-none">
        <div className="pi-float-soft absolute -top-20 -left-16 w-72 h-72 rounded-full bg-[var(--public-nude,#c4a882)]/15 blur-3xl" />
        <div className="pi-float-soft absolute -bottom-24 -right-12 w-80 h-80 rounded-full bg-rose-200/25 blur-3xl" style={{ animationDelay: "1.6s" }} />
        <div className="pi-float-soft absolute top-1/4 right-1/4 w-48 h-48 rounded-full bg-amber-100/40 blur-3xl" style={{ animationDelay: "3s" }} />
      </div>
      <div className="gallery-hero-watermark" aria-hidden>
        {GALLERY_PAGE.watermark}
      </div>
      <div className="relative z-10 max-w-4xl mx-auto text-center hero-content hero-ready">
        <div className="pi-gate-card inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-neutral-800 via-neutral-900 to-black text-white shadow-[0_18px_38px_-12px_rgba(0,0,0,.45)] mb-6"
          style={{ animation: "piFloat 6s ease-in-out infinite", transformStyle: "preserve-3d" }}>
          <Camera className="w-6 h-6" style={{ transform: "translateZ(18px)" }} />
        </div>
        <p className="text-[10px] sm:text-[11px] tracking-[0.35em] text-neutral-500 uppercase mb-5">
          {GALLERY_PAGE.eyebrow}
        </p>
        <h1 className="font-serif text-4xl sm:text-5xl lg:text-[3.25rem] font-light text-neutral-900 leading-tight mb-3">
          {GALLERY_PAGE.title}
        </h1>
        <p className="font-serif text-xl sm:text-2xl text-[var(--public-nude,#c4a882)] font-light italic mb-4">
          {GALLERY_PAGE.subtitle}
        </p>
        <p className="text-neutral-600 text-sm sm:text-base max-w-lg mx-auto leading-relaxed">
          {GALLERY_PAGE.description}
        </p>
      </div>
    </section>
  );
}

function GalleryAlbumCard({
  album,
  href,
  onNavigate,
}: {
  album: PublicAlbum;
  href: string;
  onNavigate: () => void;
}) {
  const tags = parseCSV(album.tagsText);

  return (
    <article className="group">
      <a href={href} className="sr-only" tabIndex={-1}>
        {album.name}
      </a>
      <Tilt3D
        role="link"
        tabIndex={0}
        intensity={8}
        onClick={onNavigate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onNavigate();
          }
        }}
        className="gallery-card concept-card cursor-pointer rounded-[0.625rem] overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-nude,#c4a882)]"
      >
        <div className="relative aspect-[3/4] bg-neutral-100 overflow-hidden">
          <div className="pi-shine absolute inset-0 z-10 pointer-events-none overflow-hidden" aria-hidden />
          {album.coverImageUrl ? (
            <>
              <LazyImage
                src={album.coverImageUrl}
                alt={album.name}
                className="concept-card-image absolute inset-0 w-full h-full object-cover"
              />
              <div
                className="concept-card-overlay absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent pointer-events-none"
                aria-hidden
              />
              <div
                className="concept-card-title-hover absolute bottom-0 left-0 right-0 p-5 sm:p-6 pointer-events-none"
                style={{ transform: "translateZ(34px)" }}
              >
                <p className="font-serif text-xl sm:text-2xl text-white leading-snug drop-shadow-[0_2px_8px_rgba(0,0,0,.45)]">
                  {album.name}
                </p>
                {album.photoCount > 0 && (
                  <p className="text-white/70 text-[10px] tracking-[0.2em] uppercase mt-1.5">
                    {album.photoCount} ảnh
                    {album.videoCount > 0 ? ` · ${album.videoCount} video` : ""}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-4">
              <Images className="w-8 h-8 text-neutral-300" />
              <span className="text-[10px] tracking-widest uppercase text-neutral-400 text-center">
                {album.name}
              </span>
            </div>
          )}
          {album.videoCount > 0 && (
            <span className="absolute top-3 right-3 z-10 text-[10px] bg-black/55 text-white px-2.5 py-1 rounded-full backdrop-blur-sm">
              ▶ Video
            </span>
          )}
        </div>
        <div className="px-4 py-3 sm:hidden border-t border-neutral-100 bg-white">
          <p className="font-serif text-lg text-neutral-900 line-clamp-2">{album.name}</p>
        </div>
        {tags.length > 0 && (
          <div className="hidden sm:flex flex-wrap gap-1.5 px-4 py-3 -mt-1 bg-white">
            {tags.slice(0, 2).map((t) => (
              <span
                key={t}
                className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--public-cream-deep,#f3efe8)] text-neutral-600"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </Tilt3D>
    </article>
  );
}

function GalleryGridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6 lg:gap-8">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-[0.625rem] overflow-hidden">
          <div className="gallery-skeleton aspect-[3/4] w-full" />
          <div className="gallery-skeleton h-4 w-2/3 mt-3 mx-4 rounded" />
        </div>
      ))}
    </div>
  );
}

function GalleryEmptyState() {
  return (
    <div className="text-center py-16 sm:py-24 max-w-md mx-auto">
      <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-[var(--public-cream-deep,#f3efe8)] flex items-center justify-center">
        <Images className="w-8 h-8 text-[var(--public-nude,#c4a882)]" />
      </div>
      <h2 className="font-serif text-2xl sm:text-3xl text-neutral-900 mb-3">
        Bộ sưu tập đang được cập nhật
      </h2>
      <p className="text-neutral-600 text-sm leading-relaxed mb-8">
        Chưa có album concept hiển thị công khai. Trong CMS Ảnh sản phẩm thật, đặt album ở trạng thái{" "}
        <strong>Hiển thị</strong> và gán danh mục Bộ ảnh.
      </p>
      <Link
        href="/lien-he"
        className="btn-public-primary inline-flex items-center justify-center px-8 py-3 text-xs tracking-[0.2em] uppercase bg-neutral-900 text-white hover:bg-neutral-800"
      >
        Tư vấn ngay
      </Link>
    </div>
  );
}

function GalleryCategoryEmpty({ hasAlbums }: { hasAlbums: boolean }) {
  return (
    <div className="text-center py-14 sm:py-20 rounded-2xl bg-white/60 border border-neutral-200/60">
      <Camera className="w-10 h-10 mx-auto text-neutral-300 mb-4" />
      <p className="font-serif text-xl text-neutral-800 mb-2">Chưa có album trong mục này</p>
      <p className="text-sm text-neutral-500 max-w-md mx-auto">
        {hasAlbums
          ? "Album có thể chưa gán danh mục — chọn tab Tất cả hoặc gán danh mục trong CMS Ảnh sản phẩm thật."
          : "Thêm album trong CMS Ảnh sản phẩm thật và đặt trạng thái Hiển thị."}
      </p>
      {hasAlbums && (
        <Link
          href="/bo-anh"
          className="mt-6 inline-block text-xs tracking-widest uppercase text-[var(--public-nude,#c4a882)] hover:underline"
        >
          Xem tất cả album
        </Link>
      )}
    </div>
  );
}

function Tier2Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-4 py-1.5 rounded-full text-xs tracking-widest uppercase border transition-all duration-300",
        active
          ? "bg-[var(--public-nude,#c4a882)] border-transparent text-white shadow-md"
          : "bg-white border-neutral-200 text-neutral-600 hover:border-[var(--public-nude,#c4a882)] hover:text-neutral-900",
      )}
    >
      {label}
    </button>
  );
}
