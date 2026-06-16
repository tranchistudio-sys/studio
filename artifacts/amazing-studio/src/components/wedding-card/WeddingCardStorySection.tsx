import { Heart } from "lucide-react";
import type { PublicWeddingCard } from "@/hooks/use-wedding-cards";
import { WeddingCardReveal } from "./WeddingCardReveal";

const DEFAULT_STORY =
  "Chúng tôi gặp nhau trong một buổi chiều bình thường, nhưng từ khoảnh khắc ấy mọi thứ trở nên thật đặc biệt. Qua những chuyến đi, những câu chuyện và sự đồng hành, chúng tôi chọn cùng nhau viết tiếp hành trình hạnh phúc.";

export function WeddingCardStorySection({ card }: { card: PublicWeddingCard }) {
  const story = card.invitationMessage?.trim() || DEFAULT_STORY;

  return (
    <WeddingCardReveal className="wc-bt-view-section wc-bt-story">
      <p className="wc-bt-section-eyebrow">Our Story</p>
      <h2 className="wc-bt-section-title">Chuyện Tình Của Chúng Tôi</h2>
      <div className="wc-bt-section-heart">
        <Heart className="w-3 h-3 fill-current" />
      </div>
      <div className="wc-bt-story-card">
        <p className="wc-bt-story-text">{story}</p>
      </div>
    </WeddingCardReveal>
  );
}
