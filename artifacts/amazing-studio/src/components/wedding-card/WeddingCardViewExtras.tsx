import { WeddingCardGuestSection } from "./WeddingCardGuestSection";
import { WeddingCardReveal } from "./WeddingCardReveal";
import type { PublicWeddingCard } from "@/hooks/use-wedding-cards";
import { Calendar, Heart, MapPin } from "lucide-react";

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

export function WeddingCardViewExtras({ card }: { card: PublicWeddingCard }) {
  const dateLabel = formatDate(card.weddingDate);
  const hasVenue = card.venueGroom || card.venueBride || card.venueReception;

  return (
    <div className="w-full px-3 pb-28 space-y-3">
      <WeddingCardReveal className="rounded-xl bg-white/95 border border-neutral-200/80 p-4 shadow-sm w-full">
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-neutral-500 mb-3">
          <Heart className="h-3.5 w-3.5 text-rose-400" />
          Cặp đôi
        </h2>
        <p className="font-serif text-xl text-neutral-900">
          {card.groomName} <span className="text-rose-400">&</span> {card.brideName}
        </p>
        {card.contactPhone && (
          <a
            href={`tel:${card.contactPhone.replace(/\s/g, "")}`}
            className="mt-2 inline-block text-sm text-rose-600 font-medium"
          >
            {card.contactPhone}
          </a>
        )}
      </WeddingCardReveal>

      {(dateLabel || card.ceremonyTime || card.receptionTime) && (
        <WeddingCardReveal className="rounded-xl bg-white/95 border border-neutral-200/80 p-4 shadow-sm w-full">
          <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-neutral-500 mb-2">
            <Calendar className="h-3.5 w-3.5" />
            Thời gian
          </h2>
          {dateLabel && <p className="text-sm text-neutral-800">{dateLabel}</p>}
          <div className="mt-1 text-xs text-neutral-600 space-y-0.5">
            {card.ceremonyTime && <p>Lễ: {card.ceremonyTime}</p>}
            {card.receptionTime && <p>Tiệc: {card.receptionTime}</p>}
          </div>
        </WeddingCardReveal>
      )}

      {hasVenue && (
        <WeddingCardReveal className="rounded-xl bg-white/95 border border-neutral-200/80 p-4 shadow-sm w-full">
          <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-neutral-500 mb-2">
            <MapPin className="h-3.5 w-3.5" />
            Địa điểm
          </h2>
          <ul className="text-sm text-neutral-700 space-y-2">
            {card.venueGroom && (
              <li>
                <span className="text-neutral-400 text-xs block">Nhà trai</span>
                {card.venueGroom}
              </li>
            )}
            {card.venueBride && (
              <li>
                <span className="text-neutral-400 text-xs block">Nhà gái</span>
                {card.venueBride}
              </li>
            )}
            {card.venueReception && (
              <li>
                <span className="text-neutral-400 text-xs block">Tiệc</span>
                {card.venueReception}
              </li>
            )}
          </ul>
        </WeddingCardReveal>
      )}

      <WeddingCardReveal className="rounded-xl bg-white/95 border border-neutral-200/80 overflow-hidden shadow-sm w-full">
        <WeddingCardGuestSection slug={card.slug} compact />
      </WeddingCardReveal>
    </div>
  );
}
