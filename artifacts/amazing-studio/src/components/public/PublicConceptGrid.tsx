import { Link } from "wouter";
import { LazyImage } from "@/components/cms-shared";
import type { PublicAlbum } from "@/hooks/use-public-cms";
import { PublicReveal, PublicRevealItem } from "./PublicReveal";
import { PublicSectionHeader } from "./PublicSectionHeader";

type Props = {
  albums: PublicAlbum[];
  limit?: number;
};

export function PublicConceptGrid({ albums, limit = 6 }: Props) {
  const items = albums
    .filter((a) => a.coverImageUrl)
    .slice(0, limit);

  if (items.length === 0) return null;

  return (
    <PublicReveal stagger className="py-20 sm:py-28 lg:py-32 bg-white">
      <div className="max-w-7xl mx-auto px-5 sm:px-8">
        <PublicSectionHeader
          eyebrow="Concept ảnh"
          title="Concept nổi bật"
          description="Khám phá các phong cách chụp ảnh cưới và beauty được Amazing Studio thực hiện."
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
          {items.map((album) => (
            <PublicRevealItem key={album.id}>
              <Link
                href={`/bo-anh/${album.slug}`}
                className="concept-card group block focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
              >
                <div className="relative aspect-[3/4] overflow-hidden bg-neutral-100">
                  <LazyImage
                    src={album.coverImageUrl!}
                    alt={album.name}
                    className="concept-card-image absolute inset-0 w-full h-full object-cover"
                  />
                  <div
                    className="concept-card-overlay absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent pointer-events-none"
                    aria-hidden
                  />
                  <div className="concept-card-title-hover absolute bottom-0 left-0 right-0 p-5 sm:p-6 pointer-events-none hidden md:block">
                    <p className="font-serif text-xl text-white">{album.name}</p>
                    {album.photoCount > 0 && (
                      <p className="text-white/70 text-xs mt-1 tracking-widest uppercase">
                        {album.photoCount} ảnh
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-4 md:hidden">
                  <p className="font-serif text-xl text-neutral-900">{album.name}</p>
                </div>
                <p className="hidden md:block mt-3 text-sm text-neutral-500 group-hover:text-neutral-900 transition-colors">
                  Xem album →
                </p>
              </Link>
            </PublicRevealItem>
          ))}
        </div>
        <div className="text-center mt-12">
          <Link
            href="/bo-anh"
            className="text-xs tracking-[0.25em] uppercase text-neutral-900 border-b border-neutral-900 pb-1 hover:opacity-60 transition-opacity"
          >
            Xem tất cả concept
          </Link>
        </div>
      </div>
    </PublicReveal>
  );
}
