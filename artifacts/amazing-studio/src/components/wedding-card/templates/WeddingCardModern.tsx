import { WeddingCardPreviewImage } from "../WeddingCardPreviewImage";
import { WeddingCardBrandingFooter } from "../WeddingCardBrandingFooter";
import type { WeddingCardTemplateProps } from "../wedding-card-types";
import { cn } from "@/lib/utils";

function formatDate(d: string | null) {
  if (!d) return null;
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

/** Hiện Đại */
export function WeddingCardModern({ card, coverSrc, coupleSrc, embed }: WeddingCardTemplateProps) {
  const dateLabel = formatDate(card.weddingDate);

  return (
    <article className={cn("bg-white text-neutral-900 font-sans", embed ? "min-h-0" : "min-h-screen")}>
      <header className="px-5 pt-8 pb-5 border-b border-neutral-100">
        <p className="text-[9px] font-bold tracking-[0.4em] uppercase text-neutral-400">Wedding</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight leading-tight">
          {card.groomName}
          <span className="text-neutral-300 font-light mx-1.5">/</span>
          {card.brideName}
        </h1>
        {dateLabel && <p className="mt-2 text-base font-semibold tabular-nums">{dateLabel}</p>}
      </header>
      <div className={cn("w-full bg-neutral-100", embed ? "aspect-[4/5]" : "aspect-[3/4] max-h-[50vh]")}>
        {coverSrc ? (
          <WeddingCardPreviewImage src={coverSrc} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-neutral-200" />
        )}
      </div>
      <div className={cn("px-5 py-6", embed ? "pb-4" : "pb-28 max-w-lg mx-auto")}>
        {coupleSrc && (
          <div className="w-full max-w-[200px] mx-auto aspect-square bg-neutral-100 mb-6">
            <WeddingCardPreviewImage src={coupleSrc} className="w-full h-full object-cover" />
          </div>
        )}
        {(card.ceremonyTime || card.receptionTime) && (
          <div className="grid grid-cols-2 gap-2 text-xs mb-6">
            {card.ceremonyTime && (
              <div className="border border-neutral-200 p-3">
                <p className="text-[9px] uppercase text-neutral-400">Lễ</p>
                <p className="font-bold mt-0.5">{card.ceremonyTime}</p>
              </div>
            )}
            {card.receptionTime && (
              <div className="border border-neutral-200 p-3">
                <p className="text-[9px] uppercase text-neutral-400">Tiệc</p>
                <p className="font-bold mt-0.5">{card.receptionTime}</p>
              </div>
            )}
          </div>
        )}
        {card.invitationMessage && (
          <p className="text-sm leading-relaxed text-neutral-600 whitespace-pre-line border-l-2 border-neutral-900 pl-3 mb-6">
            {card.invitationMessage}
          </p>
        )}
        {card.contactPhone && !embed && (
          <a
            href={`tel:${card.contactPhone.replace(/\s/g, "")}`}
            className="block w-full text-center bg-neutral-900 text-white py-3 text-xs font-bold tracking-wide mb-6"
          >
            Gọi điện
          </a>
        )}
        <WeddingCardBrandingFooter className="text-neutral-400 border-neutral-100" />
      </div>
    </article>
  );
}
