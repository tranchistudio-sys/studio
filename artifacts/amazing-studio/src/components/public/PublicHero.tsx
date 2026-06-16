import { useEffect, useMemo, useState } from "react";
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
  /** Ảnh slideshow (ưu tiên từ Concept ảnh). Rỗng → fallback heroImageUrl tĩnh. */
  slideImages?: string[];
  copy?: HeroCopy;
  ctaPrimary?: CtaPair;
  ctaSecondary?: CtaPair;
};

const SLIDE_INTERVAL_MS = 5000;
const MAX_SLIDES = 6;

export function PublicHero({ heroImageUrl, slideImages, copy, ctaPrimary, ctaSecondary }: Props) {
  const [textReady, setTextReady] = useState(false);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const [active, setActive] = useState(0);
  // Mount dần từng slide để mobile không phải tải cả loạt ảnh ngay khi vào trang.
  const [mountedCount, setMountedCount] = useState(2);

  const fallbackSrc =
    (heroImageUrl ? getImageSrc(heroImageUrl) : null) ??
    (HERO_IMAGE_URL ? getImageSrc(HERO_IMAGE_URL) : null) ??
    PLACEHOLDER_HERO;

  const slides = useMemo(() => {
    const list = (slideImages ?? [])
      .map((u) => getImageSrc(u) ?? u)
      .filter((u): u is string => !!u);
    const uniq = [...new Set(list)].slice(0, MAX_SLIDES);
    return uniq.length > 0 ? uniq : fallbackSrc ? [fallbackSrc] : [];
  }, [slideImages, fallbackSrc]);

  const slidesKey = slides.join("|");

  useEffect(() => {
    setActive(0);
    setMountedCount(2);
    setFirstLoaded(false);
  }, [slidesKey]);

  useEffect(() => {
    setTextReady(true);
  }, []);

  useEffect(() => {
    if (slides.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => {
      setActive((i) => (i + 1) % slides.length);
    }, SLIDE_INTERVAL_MS);
    return () => clearInterval(t);
  }, [slides.length, slidesKey]);

  // Luôn mount trước slide kế tiếp để ảnh kịp tải trước khi fade tới.
  useEffect(() => {
    setMountedCount((m) => Math.min(Math.max(m, active + 2), Math.max(slides.length, 1)));
  }, [active, slides.length]);

  const text = copy ?? HERO;
  const primary = ctaPrimary ?? HERO.ctaPrimary;
  const secondary = ctaSecondary ?? HERO.ctaSecondary;

  return (
    <section className="relative min-h-[100svh] flex items-center justify-center overflow-hidden bg-neutral-900">
      {slides.length > 0 ? (
        slides.slice(0, mountedCount).map((src, i) => (
          <img
            key={src}
            src={src}
            alt=""
            aria-hidden={i !== active}
            fetchPriority={i === 0 ? "high" : undefined}
            decoding="async"
            onLoad={i === 0 ? () => setFirstLoaded(true) : undefined}
            onError={i === 0 ? () => setFirstLoaded(true) : undefined}
            className={cn(
              "hero-slide absolute inset-0 w-full h-full object-cover",
              i % 2 === 0 ? "kb-zoom-in" : "kb-zoom-out",
              i === active && (i !== 0 || firstLoaded) && "is-active",
            )}
            draggable={false}
          />
        ))
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

      {slides.length > 1 && (
        <div className="absolute bottom-6 inset-x-0 z-10 flex items-center justify-center gap-2" aria-hidden>
          {slides.map((s, i) => (
            <span
              key={s}
              className={cn(
                "rounded-full transition-all duration-500",
                i === active ? "w-6 h-1.5 bg-white/90" : "w-1.5 h-1.5 bg-white/40",
              )}
            />
          ))}
        </div>
      )}
    </section>
  );
}
