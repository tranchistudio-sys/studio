import { WeddingCardPreviewImage } from "../WeddingCardPreviewImage";
import { WeddingCardBrandingFooter } from "../WeddingCardBrandingFooter";
import type { WeddingCardTemplateProps } from "../wedding-card-types";
import { cn } from "@/lib/utils";

function formatDate(d: string | null) {
  if (!d) return null;
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("vi-VN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

/** Hàn Quốc — pastel, tối giản (BT style full-page) */
export function WeddingCardClassic({ card, coverSrc, coupleSrc, embed }: WeddingCardTemplateProps) {
  const dateLabel = formatDate(card.weddingDate);
  const dualHeader = !embed && coverSrc && coupleSrc;

  return (
    <article className={cn("bg-[#faf8f6] text-[#3d3835] font-serif", embed ? "min-h-0" : "min-h-0")}>
      {dualHeader ? (
        <div className="wc-bt-card-duo-header">
          <div className="wc-bt-card-duo-photo">
            <WeddingCardPreviewImage src={coverSrc} className="w-full h-full object-cover" />
          </div>
          <div className="wc-bt-card-duo-photo">
            <WeddingCardPreviewImage src={coupleSrc} className="w-full h-full object-cover" />
          </div>
        </div>
      ) : (
        <div className={cn("relative w-full overflow-hidden", embed ? "aspect-[4/5]" : "h-[48vh] min-h-[240px]")}>
          {coverSrc ? (
            <WeddingCardPreviewImage src={coverSrc} className="h-full w-full object-cover" />
          ) : coupleSrc ? (
            <WeddingCardPreviewImage src={coupleSrc} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-b from-[#f0ebe4] to-[#e8e0d6]" />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-[#faf8f6]/80" />
          <div className="absolute bottom-0 left-0 right-0 p-6 text-center text-white drop-shadow-md">
            <p className="text-[9px] tracking-[0.45em] uppercase opacity-90">Save the date</p>
          </div>
        </div>
      )}

      <div className={cn("px-5 relative", embed ? "pb-6 -mt-6" : "pb-10 -mt-4")}>
        <p className="text-center text-[9px] tracking-[0.45em] uppercase text-[#9a8b7a] mb-3">
          Trân trọng kính mời
        </p>
        <h1 className="text-center text-3xl sm:text-4xl font-light leading-tight">
          {card.groomName}
          <span className="block text-xl my-2 text-[#c4a882] font-normal">&</span>
          {card.brideName}
        </h1>
        {dateLabel && (
          <p className="mt-5 text-center text-xs tracking-widest text-[#6b6358]">{dateLabel}</p>
        )}
        {(card.ceremonyTime || card.receptionTime) && (
          <div className="mt-3 text-center text-xs text-[#6b6358] space-y-0.5">
            {card.ceremonyTime && <p>Lễ · {card.ceremonyTime}</p>}
            {card.receptionTime && <p>Tiệc · {card.receptionTime}</p>}
          </div>
        )}
        {!dualHeader && coupleSrc && (
          <div className="mt-8 mx-auto w-40 h-40 rounded-2xl overflow-hidden border-2 border-white shadow-lg ring-1 ring-[#e8dfd4]">
            <WeddingCardPreviewImage src={coupleSrc} className="w-full h-full object-cover" />
          </div>
        )}
        {card.invitationMessage && embed && (
          <p className="mt-6 text-center text-sm leading-relaxed text-[#5c554c] whitespace-pre-line px-1">
            {card.invitationMessage}
          </p>
        )}
        {embed && <WeddingCardBrandingFooter className="mt-6 text-[#9a8b7a]" />}
        {!embed && (
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <a href="#wc-section-wishes" className="wc-bt-btn wc-bt-btn-primary text-xs">
              Xác nhận tham dự
            </a>
            <a href="#wc-section-wishes" className="wc-bt-btn wc-bt-btn-outline text-xs">
              Gửi lời chúc
            </a>
          </div>
        )}
        {!embed && <WeddingCardBrandingFooter className="mt-10 text-[#9a8b7a]" />}
      </div>
    </article>
  );
}
