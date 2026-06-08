import { Link } from "wouter";
import { HERO, HERO_IMAGE_URL, ABOUT } from "@/lib/public-site-config";
import { usePublicGalleryAlbums, usePublicHomeContent } from "@/hooks/use-public-cms";
import {
  PLACEHOLDER_ABOUT,
  PLACEHOLDER_FEATURED_CONCEPT,
  PLACEHOLDER_FEATURED_SERVICE,
  PLACEHOLDER_FOOTER_BANNER,
} from "@/lib/cms-placeholders";
import { PublicHero } from "@/components/public/PublicHero";
import { PublicReveal } from "@/components/public/PublicReveal";
import { PublicSectionHeader } from "@/components/public/PublicSectionHeader";
import { PublicRentalTeaser } from "@/components/public/PublicRentalTeaser";
import { PublicPricingTeaser } from "@/components/public/PublicPricingTeaser";
import { PublicTestimonials } from "@/components/public/PublicTestimonials";
import { PublicContactStrip } from "@/components/public/PublicContactStrip";
import { PublicCta } from "@/components/public/PublicCta";
import { ResilientImage } from "@/components/public/ResilientImage";
import { usePublicDresses, usePublicPackages } from "@/hooks/use-public-cms";

export default function PublicHomePage() {
  const { data: homeCms } = usePublicHomeContent();
  const { data: albums = [] } = usePublicGalleryAlbums();
  const { data: packages = [] } = usePublicPackages();
  const { data: dresses = [] } = usePublicDresses();

  const galleryCovers = albums
    .map((a) => a.coverImageUrl)
    .filter((u): u is string => !!u?.trim());
  const dressCovers = dresses
    .map((d) => d.coverImageUrl)
    .filter((u): u is string => !!u?.trim());
  const imageFallbacks = [...galleryCovers, ...dressCovers];

  const cmsHero = homeCms?.heroImageUrl?.trim() || null;
  const heroImageUrl =
    (cmsHero && !(cmsHero.startsWith("/objects/") && imageFallbacks.length > 0)
      ? cmsHero
      : null) ||
    imageFallbacks[0] ||
    (HERO_IMAGE_URL ? HERO_IMAGE_URL : null);

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
      <PublicHero
        heroImageUrl={heroImageUrl}
        heroFallbacks={imageFallbacks}
        copy={heroCopy}
        ctaPrimary={ctaPrimary}
        ctaSecondary={ctaSecondary}
      />

      <PublicReveal className="py-20 sm:py-28 lg:py-32 bg-white">
        <div className="max-w-7xl mx-auto px-5 sm:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
            <div>
              <PublicSectionHeader
                eyebrow={ABOUT.eyebrow}
                title={ABOUT.title}
                align="left"
                className="mb-8 sm:mb-10"
              />
              {ABOUT.paragraphs.map((p, i) => (
                <p key={i} className="text-neutral-600 leading-relaxed mb-4 text-base sm:text-lg">
                  {p}
                </p>
              ))}
            </div>
            <div className="aspect-[4/5] overflow-hidden rounded-2xl bg-neutral-100 shadow-sm">
              <ResilientImage
                src={homeCms?.aboutImageUrl}
                fallbacks={[imageFallbacks[2], imageFallbacks[0], imageFallbacks[1]]}
                placeholder={PLACEHOLDER_ABOUT}
                alt="Amazing Studio"
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        </div>
      </PublicReveal>

      <PublicReveal className="py-16 sm:py-24 bg-[var(--public-cream,#faf8f5)]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8">
          <PublicSectionHeader
            eyebrow="Concept ảnh"
            title="Khám phá bộ sưu tập"
            description="Ảnh nổi bật trên trang chủ — quản lý riêng trong Cài đặt Trang chủ, không đồng bộ từ CMS Concept."
            className="mb-10 sm:mb-14"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-10">
            <Link
              href="/bo-anh"
              className="group block rounded-2xl overflow-hidden border border-neutral-200/80 bg-white shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="aspect-[16/10] overflow-hidden">
                <ResilientImage
                  src={homeCms?.featuredConceptImageUrl}
                  fallbacks={[imageFallbacks[0], imageFallbacks[1]]}
                  placeholder={PLACEHOLDER_FEATURED_CONCEPT}
                  alt="Concept ảnh nổi bật"
                  className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                />
              </div>
              <div className="p-5 sm:p-6">
                <p className="font-serif text-xl text-neutral-900">Concept ảnh</p>
                <p className="text-sm text-neutral-500 mt-1">Pre-wedding, cưới, beauty…</p>
              </div>
            </Link>
            <Link
              href="/bang-gia"
              className="group block rounded-2xl overflow-hidden border border-neutral-200/80 bg-white shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="aspect-[16/10] overflow-hidden">
                <ResilientImage
                  src={homeCms?.featuredServiceImageUrl}
                  fallbacks={[imageFallbacks[1], imageFallbacks[0], imageFallbacks[2]]}
                  placeholder={PLACEHOLDER_FEATURED_SERVICE}
                  alt="Dịch vụ nổi bật"
                  className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                />
              </div>
              <div className="p-5 sm:p-6">
                <p className="font-serif text-xl text-neutral-900">Dịch vụ & bảng giá</p>
                <p className="text-sm text-neutral-500 mt-1">Gói chụp và dịch vụ đi kèm</p>
              </div>
            </Link>
          </div>
        </div>
      </PublicReveal>

      <PublicRentalTeaser dresses={dresses} />
      <PublicPricingTeaser packages={packages} />
      <PublicTestimonials />

      <PublicReveal className="relative py-20 sm:py-28 overflow-hidden">
        <ResilientImage
          src={homeCms?.footerBannerImageUrl}
          fallbacks={[imageFallbacks[1], imageFallbacks[0]]}
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
