import { useMemo } from "react";
import { HERO } from "@/lib/public-site-config";
import {
  usePublicGalleryAlbums,
  usePublicGalleryCategories,
  usePublicDressCategories,
  usePublicDresses,
  usePublicHomeContent,
} from "@/hooks/use-public-cms";
import { PLACEHOLDER_FOOTER_BANNER } from "@/lib/cms-placeholders";
import { PublicHero } from "@/components/public/PublicHero";
import { PublicReveal } from "@/components/public/PublicReveal";
import { PublicFeaturedServices } from "@/components/public/PublicFeaturedServices";
import { PublicRentalTeaser } from "@/components/public/PublicRentalTeaser";
import { PublicTestimonials } from "@/components/public/PublicTestimonials";
import { PublicContactStrip } from "@/components/public/PublicContactStrip";
import { PublicCta } from "@/components/public/PublicCta";
import { ResilientImage } from "@/components/public/ResilientImage";

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Trang chủ public — 5 khối:
 * 1. Hero slideshow (ảnh ngẫu nhiên từ module Concept ảnh — hiển thị ra ngoài là "Dịch vụ")
 * 2. Dịch Vụ Nổi Bật (6 danh mục mẹ Concept ảnh)
 * 3. Cho thuê váy cưới & trang phục (6 danh mục mẹ Cho thuê đồ)
 * 4. Feedback khách
 * 5. Liên hệ (banner CTA + dải liên hệ)
 */
export default function PublicHomePage() {
  const { data: homeCms } = usePublicHomeContent();
  const { data: albums = [] } = usePublicGalleryAlbums();
  const { data: galleryCategories = [] } = usePublicGalleryCategories();
  const { data: dressCategories = [] } = usePublicDressCategories();
  const { data: dresses = [] } = usePublicDresses();

  // Hero: lấy ngẫu nhiên tối đa 6 ảnh bìa concept; trộn lại mỗi lần vào trang.
  const heroSlides = useMemo(() => {
    const covers = albums
      .map((a) => a.coverImageUrl)
      .filter((u): u is string => !!u?.trim());
    return shuffle([...new Set(covers)]).slice(0, 6);
  }, [albums]);

  const galleryCovers = albums
    .map((a) => a.coverImageUrl)
    .filter((u): u is string => !!u?.trim());

  const heroCopy = {
    eyebrow: homeCms?.eyebrow?.trim() || HERO.eyebrow,
    titleLine1: homeCms?.titleLine1?.trim() || HERO.titleLine1,
    titleLine2: homeCms?.titleLine2?.trim() || HERO.titleLine2,
    subtitle: homeCms?.subtitle?.trim() || HERO.subtitle,
  };

  const ctaPrimary = {
    label: homeCms?.ctaPrimaryLabel?.trim() || HERO.ctaPrimary.label,
    href: homeCms?.ctaPrimaryHref?.trim() || HERO.ctaPrimary.href,
  };
  const ctaSecondary = {
    label: homeCms?.ctaSecondaryLabel?.trim() || HERO.ctaSecondary.label,
    href: homeCms?.ctaSecondaryHref?.trim() || HERO.ctaSecondary.href,
  };

  const footerTitle = homeCms?.footerCtaTitle?.trim() || "Sẵn sàng lưu giữ khoảnh khắc?";
  const footerSubtitle =
    homeCms?.footerCtaSubtitle?.trim() || "Liên hệ tư vấn miễn phí — Amazing Studio đồng hành cùng bạn.";
  const footerBtnLabel = homeCms?.footerCtaButtonLabel?.trim() || "Liên hệ ngay";
  const footerBtnHref = homeCms?.footerCtaButtonHref?.trim() || "/lien-he";

  return (
    <>
      {/* 1. Hero slideshow */}
      <PublicHero
        heroImageUrl={homeCms?.heroImageUrl?.trim() || null}
        slideImages={heroSlides}
        copy={heroCopy}
        ctaPrimary={ctaPrimary}
        ctaSecondary={ctaSecondary}
      />

      {/* 2. Dịch Vụ Nổi Bật — 6 danh mục mẹ từ Concept ảnh */}
      <PublicFeaturedServices categories={galleryCategories} albums={albums} />

      {/* 3. Cho thuê đồ — 6 danh mục mẹ, module riêng */}
      <PublicRentalTeaser categories={dressCategories} dresses={dresses} />

      {/* 4. Feedback khách */}
      <PublicTestimonials />

      {/* 5. Liên hệ */}
      <PublicReveal className="relative py-20 sm:py-28 overflow-hidden">
        <ResilientImage
          src={homeCms?.footerBannerImageUrl}
          fallbacks={[galleryCovers[1], galleryCovers[0]]}
          placeholder={PLACEHOLDER_FOOTER_BANNER}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-black/50" aria-hidden />
        <div className="relative z-10 max-w-2xl mx-auto px-5 sm:px-8 text-center text-white">
          <h2 className="font-serif text-3xl sm:text-4xl font-light mb-4">{footerTitle}</h2>
          <p className="text-white/85 text-sm sm:text-base leading-relaxed mb-8">{footerSubtitle}</p>
          <PublicCta
            href={footerBtnHref}
            variant="primary"
            className="!bg-white !text-neutral-900 hover:!bg-neutral-100 border-0"
          >
            {footerBtnLabel}
          </PublicCta>
        </div>
      </PublicReveal>

      <PublicContactStrip />
    </>
  );
}
