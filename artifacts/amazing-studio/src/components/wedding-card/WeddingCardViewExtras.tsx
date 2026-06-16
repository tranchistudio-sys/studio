import { WeddingCardGuestSection } from "./WeddingCardGuestSection";
import { WeddingCardMapsEmbed } from "./WeddingCardMapsEmbed";
import { WeddingCardCountdown } from "./WeddingCardCountdown";
import { WeddingCardAlbumSection } from "./WeddingCardAlbumSection";
import { WeddingCardGiftSection } from "./WeddingCardGiftSection";
import { WeddingCardFamiliesSection } from "./WeddingCardFamiliesSection";
import { WeddingCardStorySection } from "./WeddingCardStorySection";
import { WeddingCardThankYouSection } from "./WeddingCardThankYouSection";
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

export function WeddingCardViewExtras({
  card,
  preview = false,
}: {
  card: PublicWeddingCard;
  preview?: boolean;
}) {
  const dateLabel = formatDate(card.weddingDate);
  const hasVenue = card.venueGroom || card.venueBride || card.venueReception;
  const hasMap =
    card.venueGroom ||
    card.venueBride ||
    card.venueReception ||
    card.mapsUrlGroom ||
    card.mapsUrlBride ||
    card.mapsUrlReception;

  return (
    <div className="wc-bt-view-sections">
      <WeddingCardCountdown weddingDate={card.weddingDate} ceremonyTime={card.ceremonyTime} />

      <WeddingCardFamiliesSection card={card} />
      <WeddingCardStorySection card={card} />

      <WeddingCardAlbumSection
          coverImageUrl={card.coverImageUrl}
          coupleImageUrl={card.coupleImageUrl}
        />

      <WeddingCardReveal className="wc-bt-view-section">
        <p className="wc-bt-section-eyebrow">Cặp đôi</p>
        <h2 className="wc-bt-section-title font-serif">
          {card.groomName} <span className="text-[var(--wc-bt-rose-text)]">&</span> {card.brideName}
        </h2>
        {card.contactPhone && (
          <a
            href={`tel:${card.contactPhone.replace(/\s/g, "")}`}
            className="mt-3 inline-block text-sm text-[var(--wc-bt-taupe)] font-medium"
          >
            {card.contactPhone}
          </a>
        )}
        {card.invitationMessage && (
          <p className="wc-bt-section-desc mt-4 whitespace-pre-line">{card.invitationMessage}</p>
        )}
      </WeddingCardReveal>

      {(dateLabel || card.ceremonyTime || card.receptionTime) && (
        <WeddingCardReveal className="wc-bt-view-section">
          <p className="wc-bt-section-eyebrow flex items-center justify-center gap-2">
            <Calendar className="h-3.5 w-3.5" /> Thời gian
          </p>
          {dateLabel && <p className="wc-bt-section-title text-lg">{dateLabel}</p>}
          <div className="mt-2 text-sm text-[var(--wc-bt-muted)] space-y-1">
            {card.ceremonyTime && <p>Lễ: {card.ceremonyTime}</p>}
            {card.receptionTime && <p>Tiệc: {card.receptionTime}</p>}
          </div>
        </WeddingCardReveal>
      )}

      {hasVenue && (
        <WeddingCardReveal className="wc-bt-view-section" id="wc-section-map">
          <p className="wc-bt-section-eyebrow flex items-center justify-center gap-2">
            <MapPin className="h-3.5 w-3.5" /> Địa điểm
          </p>
          <div className="space-y-6 text-left mt-4">
            <WeddingCardMapsEmbed label="Nhà trai" address={card.venueGroom} mapsUrl={card.mapsUrlGroom} />
            <WeddingCardMapsEmbed label="Nhà gái" address={card.venueBride} mapsUrl={card.mapsUrlBride} />
            <WeddingCardMapsEmbed label="Tiệc cưới" address={card.venueReception} mapsUrl={card.mapsUrlReception} />
          </div>
        </WeddingCardReveal>
      )}

      {!hasMap && (
        <div id="wc-section-map" className="sr-only" aria-hidden />
      )}

      <WeddingCardGiftSection
        groomName={card.groomName}
        brideName={card.brideName}
        contactPhone={card.contactPhone}
      />

      <WeddingCardReveal className="wc-bt-view-section wc-bt-view-wishes" id="wc-section-wishes">
        <p className="wc-bt-section-eyebrow flex items-center justify-center gap-2">
          <Heart className="h-3.5 w-3.5" /> Lời chúc
        </p>
        <h2 className="wc-bt-section-title">Gửi lời chúc & xác nhận</h2>
        <WeddingCardGuestSection slug={card.slug} compact preview={preview} />
      </WeddingCardReveal>

      <WeddingCardThankYouSection card={card} />
    </div>
  );
}
