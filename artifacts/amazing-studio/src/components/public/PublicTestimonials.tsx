import { TESTIMONIALS } from "@/lib/public-site-config";
import { PublicReveal, PublicRevealItem } from "./PublicReveal";
import { PublicSectionHeader } from "./PublicSectionHeader";

export function PublicTestimonials() {
  return (
    <PublicReveal stagger className="py-20 sm:py-28 lg:py-32 bg-white">
      <div className="max-w-7xl mx-auto px-5 sm:px-8">
        <PublicSectionHeader
          eyebrow="Đánh giá"
          title="Feedback khách hàng"
          description="Niềm tin và sự hài lòng của khách hàng là động lực của Amazing Studio."
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 sm:gap-12 max-w-5xl mx-auto">
          {TESTIMONIALS.map((t, i) => (
            <PublicRevealItem key={i}>
              <blockquote className="border-l-2 border-[var(--public-accent)] pl-6 sm:pl-8">
                <p className="font-serif text-xl sm:text-2xl text-neutral-800 leading-relaxed italic">
                  &ldquo;{t.quote}&rdquo;
                </p>
                <footer className="mt-6">
                  <cite className="not-italic text-sm font-medium text-neutral-900">
                    {t.author}
                  </cite>
                  {t.role && (
                    <p className="text-xs text-neutral-500 mt-1 tracking-wide">{t.role}</p>
                  )}
                </footer>
              </blockquote>
            </PublicRevealItem>
          ))}
        </div>
      </div>
    </PublicReveal>
  );
}
