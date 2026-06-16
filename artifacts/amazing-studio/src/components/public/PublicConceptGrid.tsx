import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { Camera } from "lucide-react";
import { LazyImage } from "@/components/cms-shared";
import { Tilt3D } from "@/components/public-3d";
import type { PublicAlbum } from "@/hooks/use-public-cms";
import { PublicReveal, PublicRevealItem } from "./PublicReveal";
import { PublicSectionHeader } from "./PublicSectionHeader";

type Props = {
  albums: PublicAlbum[];
  limit?: number;
};

/** "Dịch vụ chụp ảnh" — concept nổi bật lấy từ module Concept ảnh (/bo-anh). */
export function PublicConceptGrid({ albums, limit = 8 }: Props) {
  const [, setLocation] = useLocation();

  // Ưu tiên thứ tự curated (sortOrder), rồi mới nhất (id giảm dần).
  const items = useMemo(
    () =>
      albums
        .filter((a) => a.coverImageUrl && a.slug)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.id - a.id)
        .slice(0, limit),
    [albums, limit],
  );

  if (items.length === 0) return null;

  return (
    <PublicReveal stagger className="py-20 sm:py-28 bg-white">
      <div className="max-w-7xl mx-auto px-5 sm:px-8">
        <PublicSectionHeader
          eyebrow="Dịch vụ"
          title="Dịch vụ chụp ảnh"
          description="Các concept và phong cách Amazing Studio thực hiện — bấm vào để xem trọn bộ ảnh."
          className="mb-10 sm:mb-14"
        />
        <div
          className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-5 lg:gap-6"
          style={{ perspective: "1400px" }}
        >
          {items.map((album) => (
            <PublicRevealItem key={album.id}>
              <Tilt3D
                intensity={7}
                role="link"
                tabIndex={0}
                onClick={() => setLocation(`/bo-anh/${album.slug}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setLocation(`/bo-anh/${album.slug}`);
                  }
                }}
                className="group rounded-xl overflow-hidden bg-white border border-neutral-200/70 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-nude,#c4a882)]"
              >
                <div className="relative aspect-[3/4] bg-neutral-100 overflow-hidden">
                  <LazyImage
                    src={album.coverImageUrl!}
                    alt={album.name}
                    className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.05]"
                  />
                  <div
                    className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/45 to-transparent pointer-events-none"
                    aria-hidden
                  />
                  {album.photoCount > 0 && (
                    <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 text-[10px] bg-black/55 text-white px-2 py-0.5 rounded-full backdrop-blur-sm">
                      <Camera className="w-2.5 h-2.5" />
                      {album.photoCount} ảnh
                    </span>
                  )}
                </div>
                <div className="p-2.5 sm:p-3.5" style={{ transform: "translateZ(24px)" }}>
                  <p className="font-serif text-sm sm:text-lg text-neutral-900 leading-snug line-clamp-2">
                    {album.name}
                  </p>
                </div>
              </Tilt3D>
            </PublicRevealItem>
          ))}
        </div>
        <div className="text-center mt-10 sm:mt-12">
          <Link
            href="/bo-anh"
            className="text-xs tracking-[0.25em] uppercase text-neutral-900 border-b border-neutral-900 pb-1 hover:opacity-60 transition-opacity"
          >
            Xem tất cả dịch vụ chụp ảnh
          </Link>
        </div>
      </div>
    </PublicReveal>
  );
}
