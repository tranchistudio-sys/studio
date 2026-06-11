import { useEffect, useState } from "react";
import { HERO, HERO_IMAGE_URL } from "@/lib/public-site-config";
import { PLACEHOLDER_HERO } from "@/lib/cms-placeholders";
import { getImageSrc } from "@/lib/imageUtils";
import { PublicCta } from "./PublicCta";
import { cn } from "@/lib/utils";

type HeroCopy = {
  eyebrow: string;
  titleLine1: string;
  titleLine2: string;
  subtitle: string;
};

type CtaPair = { label: string; href: string };

type Props = {
  heroImageUrl: string | null;
  copy?: HeroCopy;
  ctaPrimary?: CtaPair;
  ctaSecondary?: CtaPair;
};

export function PublicHero({ heroImageUrl, copy, ctaPrimary, ctaSecondary }: Props) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [textReady, setTextReady] = useState(false);
  const src = heroImageUrl ? getImageSrc(heroImageUrl) : null;
  const configOverride =
    !heroImageUrl && HERO_IMAGE_URL ? getImageSrc(HERO_IMAGE_URL) : null;
  const displaySrc = src ?? configOverride ?? PLACEHOLDER_HERO;
  const text = copy ?? HERO;
  const primary = ctaPrimary ?? HERO.ctaPrimary;
  const secondary = ctaSecondary ?? HERO.ctaSecondary;

  useEffect(() => {
    setTextReady(true);
  }, []);

  return (
    <section className="relative min-h-[100svh] flex items-center justify-center overflow-hidden bg-neutral-900">
      {displaySrc ? (
        <img
          src={displaySrc}
          alt=""
          className={cn(
            "absolute inset-0 w-full h-full object-cover hero-bg",
            imgLoaded && "is-loaded",
          )}
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgLoaded(true)}
          fetchPriority="high"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-neutral-800 via-neutral-700 to-neutral-900 hero-bg is-loaded" />
      )}
      <div className="absolute inset-0 bg-black/45" aria-hidden />

      <div
        className={cn(
          "relative z-10 max-w-4xl mx-auto px-5 sm:px-8 text-center text-white hero-content",
          textReady && "hero-ready",
        )}
      >
        <p className="text-[11px] tracking-[0.35em] uppercase text-white/80 mb-6">
          {text.eyebrow}
        </p>
        <h1 className="font-serif text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-light leading-[1.1] mb-6">
          {text.titleLine1}
          <br />
          <span className="italic text-[var(--public-accent)]">{text.titleLine2}</span>
        </h1>
        <p className="text-white/85 max-w-xl mx-auto leading-relaxed mb-10 text-base sm:text-lg font-sans">
          {text.subtitle}
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
          <PublicCta href={primary.href} variant="primary" className="w-full sm:w-auto !bg-[var(--public-accent-dark)] hover:!bg-[var(--public-accent)] border-0">
            {primary.label}
          </PublicCta>
          <PublicCta href={secondary.href} variant="ghost-light" className="w-full sm:w-auto">
            {secondary.label}
          </PublicCta>
        </div>
      </div>
    </section>
  );
}
