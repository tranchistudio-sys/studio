import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { ArrowRight, Shirt } from "lucide-react";
import { LazyImage } from "@/components/cms-shared";
import { Tilt3D } from "@/components/public-3d";
import {
  getGalleryDescendantIds,
  type PublicDress,
  type PublicDressCategory,
} from "@/hooks/use-public-cms";
import { PublicReveal, PublicRevealItem } from "./PublicReveal";
import { PublicSectionHeader } from "./PublicSectionHeader";

/**
 * "Cho thuê váy cưới & trang phục" — 6 danh mục mẹ từ module Cho thuê đồ.
 * Click → /cho-thue-do?categoryId=… (đúng nhánh danh mục trên trang cho thuê).
 */

type Props = {
  categories: PublicDressCategory[];
  dresses: PublicDress[];
  limit?: number;
};

export function PublicRentalTeaser({ categories, dresses, limit = 6 }: Props) {
  const [, setLocation] = useLocation();

  const cards = useMemo(() => {
    const parents = categories
      .filter((c) => c.parentId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .slice(0, limit);

    // Danh mục chưa có cover → xoay vòng ảnh sản phẩm bất kỳ để card không bị trống.
    const pool = [...new Set(dresses.map((d) => d.coverImageUrl).filter((u): u is string => !!u))];
    let poolIdx = 0;

    return parents.map((cat) => {
      const branchIds = getGalleryDescendantIds(categories, cat.id);
      const branchDresses = dresses.filter(
        (d) => d.categoryId != null && branchIds.has(d.categoryId),
      );
      const image =
        cat.coverImageUrl ||
        cat.fallbackCover ||
        branchDresses.find((d) => d.coverImageUrl)?.coverImageUrl ||
        (pool.length > 0 ? pool[poolIdx++ % pool.length] : null);
      return {
        id: cat.id,
        name: cat.name,
        image,
        count: branchDresses.length,
        href: `/cho-thue-do?categoryId=${cat.id}`,
      };
    });
  }, [categories, dresses, limit]);

  if (cards.length === 0) return null;

  return (
    <PublicReveal stagger className="py-16 sm:py-24 bg-[var(--public-cream,#faf8f5)]">
      <div className="max-w-7xl mx-auto px-5 sm:px-8">
        <PublicSectionHeader
          eyebrow="Cho thuê"
          title="Cho thuê váy cưới & trang phục"
          description="Kho trang phục đa dạng cho chụp ảnh, ngày cưới và mọi dịp đặc biệt — form đẹp, đa dạng size."
          className="mb-10 sm:mb-14"
        />
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6 lg:gap-8"
          style={{ perspective: "1400px" }}
        >
          {cards.map((card) => (
            <PublicRevealItem key={card.id}>
              <Tilt3D
                intensity={6}
                role="link"
                tabIndex={0}
                onClick={() => setLocation(card.href)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setLocation(card.href);
                  }
                }}
                className="group relative rounded-2xl overflow-hidden bg-neutral-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-nude,#c4a882)]"
              >
                <div className="relative aspect-[4/5] sm:aspect-[3/4] overflow-hidden">
                  {card.image ? (
                    <LazyImage
                      src={card.image}
                      alt={card.name}
                      className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.05]"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-neutral-300 to-neutral-400 flex items-center justify-center">
                      <Shirt className="w-10 h-10 text-white/60" />
                    </div>
                  )}
                  <div
                    className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent pointer-events-none"
                    aria-hidden
                  />
                  <div
                    className="absolute bottom-0 left-0 right-0 p-5 sm:p-6 text-white"
                    style={{ transform: "translateZ(30px)" }}
                  >
                    <h3 className="font-serif text-2xl font-light leading-snug">{card.name}</h3>
                    {card.count > 0 && (
                      <p className="text-white/80 text-sm mt-1.5">{card.count} mẫu trang phục</p>
                    )}
                    <span className="inline-flex items-center gap-1.5 text-[11px] tracking-[0.2em] uppercase text-white/90 mt-3 border-b border-white/40 pb-0.5 group-hover:border-white transition-colors">
                      Xem trang phục
                      <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-1" />
                    </span>
                  </div>
                </div>
              </Tilt3D>
            </PublicRevealItem>
          ))}
        </div>
        <div className="text-center mt-10 sm:mt-12">
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
