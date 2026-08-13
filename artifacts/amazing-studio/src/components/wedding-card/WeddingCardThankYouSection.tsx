import { Heart } from "lucide-react";
import type { PublicWeddingCard } from "@/hooks/use-wedding-cards";
import { WeddingCardBrandingFooter } from "./WeddingCardBrandingFooter";
import { WeddingCardReveal } from "./WeddingCardReveal";

export function WeddingCardThankYouSection({ card }: { card: PublicWeddingCard }) {
  return (
    <WeddingCardReveal className="wc-bt-thankyou">
      <div className="wc-bt-thankyou-card">
        <p className="wc-bt-thankyou-petals">🌸 🌸 🌸 🌸 🌸</p>
        <h2 className="wc-bt-thankyou-names">
          {card.groomName} & {card.brideName}
        </h2>
        <div className="wc-bt-section-heart">
          <Heart className="w-3 h-3 fill-current" />
        </div>
        <p className="wc-bt-thankyou-msg">
          Cảm ơn bạn đã dành thời gian đọc thiệp mời của chúng tôi. Sự hiện diện của bạn là niềm vui lớn nhất trong ngày hạnh phúc của chúng tôi 💕
        </p>
      </div>
      <WeddingCardBrandingFooter />
    </WeddingCardReveal>
  );
}
