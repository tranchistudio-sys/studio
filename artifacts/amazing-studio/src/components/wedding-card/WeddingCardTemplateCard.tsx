import { useState } from "react";
import { Link } from "wouter";
import { Eye } from "lucide-react";
import { getTemplateDisplay } from "./wedding-card-config";
import type { WeddingCardTemplate } from "@/hooks/use-wedding-cards";
import { getImageSrc } from "@/lib/imageUtils";
import { weddingTemplatePlaceholder } from "@/lib/cms-placeholders";
import { cn } from "@/lib/utils";

function templateCardImage(template: WeddingCardTemplate): string {
  return (
    getImageSrc(template.mockupImageUrl) ??
    getImageSrc(template.previewImageUrl) ??
    getImageSrc(template.thumbnailUrl) ??
    weddingTemplatePlaceholder(template.category)
  );
}

export function WeddingCardTemplateCard({
  template,
  onPreview,
  index = 0,
}: {
  template: WeddingCardTemplate;
  onPreview: () => void;
  index?: number;
}) {
  const display = getTemplateDisplay(template.slug, template.name);
  const [tapped, setTapped] = useState(false);
  const href = `/thiep-cuoi-online/tao?template=${template.slug}`;
  const imgSrc = templateCardImage(template);
  const accent = template.themeColor ?? undefined;

  return (
    <article
      className={cn(
        "wc-template-card wc-stagger-up group flex flex-col w-full rounded-2xl overflow-hidden bg-white border border-neutral-200/90 shadow-sm",
        tapped && "is-tapped",
      )}
      style={{ animationDelay: `${index * 90}ms` }}
      onClick={() => {
        if (window.matchMedia("(hover: hover)").matches) return;
        setTapped((v) => !v);
      }}
    >
      <div className="wc-template-visual relative aspect-[9/16] w-full max-h-[min(70vh,520px)] overflow-hidden">
        <img
          src={imgSrc}
          alt={template.name}
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div
          className={cn(
            "absolute inset-0 flex flex-col justify-end p-5 sm:p-6",
            "bg-gradient-to-t from-black/65 via-black/20 to-transparent",
          )}
        >
          {accent && (
            <span
              className="absolute top-4 right-4 w-8 h-8 rounded-full border-2 border-white/60 shadow-inner"
              style={{ backgroundColor: accent }}
              aria-hidden
            />
          )}
          {display.badge === "popular" && (
            <span className="absolute top-4 left-4 z-10 rounded-full bg-amber-500/95 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white shadow">
              Phổ biến
            </span>
          )}
          {display.badge === "new" && (
            <span className="absolute top-4 left-4 z-10 rounded-full bg-emerald-600/95 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white shadow">
              Mới nhất
            </span>
          )}
          <div className={cn("relative z-10 pb-2 text-white")}>
            {template.category && (
              <p className="text-[10px] tracking-[0.35em] uppercase opacity-80 mb-2">
                {template.category}
              </p>
            )}
            <h3 className="font-serif text-2xl sm:text-3xl leading-tight">
              {template.name || display.title}
            </h3>
            <p className="mt-2 text-sm opacity-90 line-clamp-2">
              {template.description || display.subtitle}
            </p>
          </div>
        </div>

        <div className="wc-template-actions absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 p-4 bg-gradient-to-t from-black/70 to-transparent pt-16 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <Link
            href={href}
            onClick={(e) => e.stopPropagation()}
            className="wc-btn-primary wc-btn-glow wc-touch-btn flex w-full items-center justify-center rounded-xl bg-white text-neutral-900 text-base font-bold shadow-lg"
          >
            Dùng mẫu này
          </Link>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPreview();
            }}
            className="wc-touch-btn flex w-full items-center justify-center gap-2 rounded-xl border border-white/40 bg-white/15 text-white text-sm font-medium backdrop-blur-sm"
          >
            <Eye className="h-5 w-5" />
            Xem mẫu
          </button>
        </div>
      </div>

      <div className="hidden md:flex p-4 sm:p-5 flex-col gap-3">
        <Link
          href={href}
          className="wc-btn-primary wc-btn-glow wc-touch-btn flex w-full items-center justify-center rounded-xl bg-neutral-900 text-white text-base font-semibold"
        >
          Dùng mẫu này
        </Link>
        <button
          type="button"
          onClick={onPreview}
          className="wc-touch-btn flex w-full items-center justify-center gap-2 rounded-xl border-2 border-neutral-200 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          <Eye className="h-5 w-5" />
          Xem mẫu
        </button>
      </div>
    </article>
  );
}
