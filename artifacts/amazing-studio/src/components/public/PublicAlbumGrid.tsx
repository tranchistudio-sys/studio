import { Link } from "wouter";
import { LazyImage } from "@/components/cms-shared";
import { PublicReveal, PublicRevealItem } from "./PublicReveal";
import { PublicSectionHeader } from "./PublicSectionHeader";

type PortfolioImage = {
  url: string;
  albumSlug: string;
  albumName: string;
};

type Props = {
  images: PortfolioImage[];
  isLoading?: boolean;
};

export function PublicAlbumGrid({ images, isLoading }: Props) {
  return (
    <PublicReveal stagger className="py-20 sm:py-28 lg:py-32 bg-stone-50">
      <div className="max-w-7xl mx-auto px-5 sm:px-8">
        <PublicSectionHeader
          eyebrow="Portfolio"
          title="Album cưới"
          description="Những khoảnh khắc được lưu giữ qua ống kính Amazing Studio."
        />
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="aspect-[3/4] bg-neutral-200 animate-pulse" />
            ))}
          </div>
        ) : images.length === 0 ? (
          <p className="text-center text-neutral-500 py-12">
            Album đang được cập nhật. Xem thêm tại{" "}
            <Link href="/bo-anh" className="underline text-neutral-900">
              Concept ảnh
            </Link>
            .
          </p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
            {images.map((img, i) => (
              <PublicRevealItem key={`${img.url}-${i}`}>
                <Link
                  href={`/bo-anh/${img.albumSlug}`}
                  className="concept-card block overflow-hidden bg-neutral-100 aspect-[3/4] focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
                >
                  <LazyImage
                    src={img.url}
                    alt={img.albumName}
                    className="concept-card-image w-full h-full object-cover"
                  />
                </Link>
              </PublicRevealItem>
            ))}
          </div>
        )}
        <div className="text-center mt-12">
          <Link
            href="/bo-anh"
            className="text-xs tracking-[0.25em] uppercase text-neutral-900 border-b border-neutral-900 pb-1 hover:opacity-60 transition-opacity"
          >
            Xem toàn bộ album
          </Link>
        </div>
      </div>
    </PublicReveal>
  );
}
