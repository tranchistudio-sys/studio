import { Link } from "wouter";
import { LazyImage } from "@/components/cms-shared";
import { formatVND } from "@/lib/utils";
import type { PublicDress } from "@/hooks/use-public-cms";
import { PublicReveal, PublicRevealItem } from "./PublicReveal";
import { PublicSectionHeader } from "./PublicSectionHeader";

type Props = {
  dresses: PublicDress[];
  limit?: number;
};

export function PublicRentalTeaser({ dresses, limit = 8 }: Props) {
  const items = dresses
    .filter((d) => d.coverImageUrl && d.slug)
    .slice(0, limit);

  if (items.length === 0) return null;

  return (
    <PublicReveal stagger className="py-20 sm:py-28 lg:py-32 bg-white">
      <div className="max-w-7xl mx-auto px-5 sm:px-8">
        <PublicSectionHeader
          eyebrow="Cho thuê"
          title="Cho thuê váy cưới & trang phục"
          description="Bộ sưu tập váy cưới, vest, áo dài và trang phục beauty — form đẹp, đa dạng size."
        />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
          {items.map((dress) => (
            <PublicRevealItem key={dress.id}>
              <Link
                href={`/san-pham/${dress.slug}`}
                className="concept-card group block focus:outline-none"
              >
                <div className="relative aspect-[3/4] overflow-hidden bg-neutral-100">
                  <LazyImage
                    src={dress.coverImageUrl!}
                    alt={dress.name}
                    className="concept-card-image w-full h-full object-cover"
                  />
                </div>
                <div className="mt-3">
                  <p className="font-serif text-lg text-neutral-900 line-clamp-2">{dress.name}</p>
                  {dress.rentalPrice > 0 && (
                    <p className="text-sm text-neutral-500 mt-1">{formatVND(dress.rentalPrice)}</p>
                  )}
                </div>
              </Link>
            </PublicRevealItem>
          ))}
        </div>
        <div className="text-center mt-12">
          <Link
            href="/cho-thue-do"
            className="text-xs tracking-[0.25em] uppercase text-neutral-900 border-b border-neutral-900 pb-1 hover:opacity-60 transition-opacity"
          >
            Xem toàn bộ kho trang phục
          </Link>
        </div>
      </div>
    </PublicReveal>
  );
}
