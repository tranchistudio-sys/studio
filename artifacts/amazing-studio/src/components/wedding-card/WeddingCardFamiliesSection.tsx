import { Heart } from "lucide-react";
import type { PublicWeddingCard } from "@/hooks/use-wedding-cards";
import { WeddingCardReveal } from "./WeddingCardReveal";

export function WeddingCardFamiliesSection({ card }: { card: PublicWeddingCard }) {
  const groomHome = card.venueGroom || "Nhà trai — địa chỉ sẽ cập nhật trên thiệp";
  const brideHome = card.venueBride || "Nhà gái — địa chỉ sẽ cập nhật trên thiệp";

  return (
    <WeddingCardReveal className="wc-bt-view-section wc-bt-families">
      <p className="wc-bt-section-eyebrow">Our Families</p>
      <h2 className="wc-bt-section-title">Hai Gia Đình</h2>
      <div className="wc-bt-section-heart">
        <Heart className="w-3 h-3 fill-current" />
      </div>
      <div className="wc-bt-family-grid">
        <article className="wc-bt-family-card">
          <div className="wc-bt-family-icon wc-bt-family-icon--groom">♂</div>
          <p className="wc-bt-family-label">Nhà Trai</p>
          <p className="wc-bt-family-parent">Chú rể · {card.groomName}</p>
          <p className="wc-bt-family-addr">{groomHome}</p>
        </article>
        <article className="wc-bt-family-card">
          <div className="wc-bt-family-icon wc-bt-family-icon--bride">♀</div>
          <p className="wc-bt-family-label">Nhà Gái</p>
          <p className="wc-bt-family-parent">Cô dâu · {card.brideName}</p>
          <p className="wc-bt-family-addr">{brideHome}</p>
        </article>
      </div>
    </WeddingCardReveal>
  );
}
