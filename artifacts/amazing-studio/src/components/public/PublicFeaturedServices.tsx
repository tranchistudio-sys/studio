import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Camera } from "lucide-react";
import { LazyImage } from "@/components/cms-shared";
import { Tilt3D } from "@/components/public-3d";
import {
  getGalleryDescendantIds,
  type PublicAlbum,
  type PublicGalleryCategory,
} from "@/hooks/use-public-cms";
import { PublicReveal, PublicRevealItem } from "./PublicReveal";
import { PublicSectionHeader } from "./PublicSectionHeader";

/**
 * "Dịch Vụ Nổi Bật" — 6 danh mục mẹ từ module Concept ảnh (hiển thị ra ngoài là "Dịch vụ").
 * Card: ảnh đại diện danh mục, tên, mô tả ngắn; click → /bo-anh?categoryId=… (toàn bộ concept thuộc dịch vụ đó).
 */

function strip(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

const DESCRIPTION_RULES: Array<{ keywords: string[]; text: string }> = [
  { keywords: ["pre wedding", "pre-wedding", "prewedding"], text: "Bộ ảnh pre-wedding lãng mạn — concept riêng cho từng cặp đôi." },
  { keywords: ["cuoi", "wedding"], text: "Chụp cưới & phóng sự cưới trọn gói, lưu trọn ngày trọng đại." },
  { keywords: ["beauty"], text: "Bộ ảnh beauty & profile cá nhân sang trọng, makeup chuyên nghiệp." },
  { keywords: ["ao dai", "viet phuc", "co phuc"], text: "Áo dài & Việt phục — nét đẹp truyền thống không bao giờ cũ." },
  { keywords: ["bau", "maternity"], text: "Lưu giữ hành trình làm mẹ dịu dàng và đáng nhớ." },
  { keywords: ["sinh nhat", "birthday"], text: "Bộ ảnh sinh nhật & cột mốc đáng nhớ cho bé và gia đình." },
  { keywords: ["gia dinh", "family"], text: "Khoảnh khắc gia đình ấm áp, tự nhiên và chân thật." },
  { keywords: ["ky yeu"], text: "Kỷ yếu trẻ trung — giữ lại thanh xuân rực rỡ nhất." },
];

function descriptionFor(name: string): string {
  const n = strip(name);
  const rule = DESCRIPTION_RULES.find((r) => r.keywords.some((k) => n.includes(k)));
  return rule?.text ?? `Khám phá trọn bộ concept ${name} tại Amazing Studio.`;
}

type Props = {
  categories: PublicGalleryCategory[];
  albums: PublicAlbum[];
  limit?: number;
};

export function PublicFeaturedServices({ categories, albums, limit = 6 }: Props) {
  const [, setLocation] = useLocation();

  const cards = useMemo(() => {
    const parents = categories
      .filter((c) => c.parentId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .slice(0, limit);

    // Danh mục chưa có cover → xoay vòng ảnh bìa album bất kỳ để card không bị trống.
    const pool = [...new Set(albums.map((a) => a.coverImageUrl).filter((u): u is string => !!u))];
    let poolIdx = 0;

    return parents.map((cat) => {
      const branchIds = getGalleryDescendantIds(categories, cat.id);
      const branchAlbums = albums.filter(
        (a) => a.categoryId != null && branchIds.has(a.categoryId),
      );
      const image =
        cat.coverImageUrl ||
        cat.fallbackCover ||
        branchAlbums.find((a) => a.coverImageUrl)?.coverImageUrl ||
        (pool.length > 0 ? pool[poolIdx++ % pool.length] : null);
      return {
        id: cat.id,
        name: cat.name,
        description: descriptionFor(cat.name),
        image,
        albumCount: branchAlbums.length,
        href: `/bo-anh?categoryId=${cat.id}`,
      };
    });
  }, [categories, albums, limit]);

  if (cards.length === 0) return null;

  return (
    <PublicReveal stagger className="py-16 sm:py-24 bg-white">
      <div className="max-w-7xl mx-auto px-5 sm:px-8">
        <PublicSectionHeader
          eyebrow="Amazing Studio"
          title="Dịch Vụ Nổi Bật"
          description="Những dịch vụ được khách hàng Amazing Studio lựa chọn nhiều nhất."
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
                      cmsCache
                      className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.05]"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-neutral-300 to-neutral-400 flex items-center justify-center">
                      <Camera className="w-10 h-10 text-white/60" />
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
                    <p className="text-white/80 text-sm mt-1.5 leading-relaxed line-clamp-2">
                      {card.description}
                    </p>
                    <span className="inline-flex items-center gap-1.5 text-[11px] tracking-[0.2em] uppercase text-white/90 mt-3 border-b border-white/40 pb-0.5 group-hover:border-white transition-colors">
                      Xem dịch vụ
                      <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-1" />
                    </span>
                  </div>
                </div>
              </Tilt3D>
            </PublicRevealItem>
          ))}
        </div>
      </div>
    </PublicReveal>
  );
}
