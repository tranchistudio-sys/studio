import { useRoute, Link } from "wouter";
import { WeddingCardOverlay } from "@/components/wedding-card/WeddingCardOverlay";
import { useWeddingCardBySlug } from "@/hooks/use-wedding-cards";
import { WeddingCardRenderer } from "@/components/wedding-card/WeddingCardRenderer";
import { WeddingCardViewExtras } from "@/components/wedding-card/WeddingCardViewExtras";
import { WeddingCardFloatingActions } from "@/components/wedding-card/WeddingCardFloatingActions";
import { WeddingCardPetals } from "@/components/wedding-card/WeddingCardPetals";
import { WeddingCardReveal } from "@/components/wedding-card/WeddingCardReveal";
import { buildShareUrl } from "@/components/wedding-card/wedding-card-config";

export default function WeddingCardViewPage() {
  const [, params] = useRoute("/thiep-cuoi/:slug");
  const slug = params?.slug;
  const { data: card, isLoading, isError } = useWeddingCardBySlug(slug);
  const shareUrl = slug ? buildShareUrl(slug) : "";

  if (isLoading) {
    return <WeddingCardOverlay message="Đang mở thiệp cưới..." sub="Mời bạn chờ một chút" />;
  }

  if (isError || !card) {
    return (
      <div className="wc-bt-page min-h-screen flex flex-col items-center justify-center px-6 text-center wc-fade-in">
        <p className="font-serif text-2xl text-[var(--wc-bt-text)]">Không tìm thấy thiệp</p>
        <p className="mt-2 text-sm text-[var(--wc-bt-muted)]">Link có thể đã hết hạn hoặc bị ẩn.</p>
        <Link href="/thiep-cuoi-online" className="wc-bt-btn wc-bt-btn-primary mt-8">
          Tạo thiệp mới
        </Link>
      </div>
    );
  }

  return (
    <div className="wc-bt-view-page wc-mobile-page min-h-screen relative">
      <WeddingCardPetals />
      <div className="wc-bt-view-shell relative z-10">
        <WeddingCardReveal className="wc-bt-view-cover">
          <WeddingCardRenderer card={card} embed={false} />
        </WeddingCardReveal>
        <WeddingCardViewExtras card={card} />
      </div>
      {shareUrl && <WeddingCardFloatingActions shareUrl={shareUrl} />}
    </div>
  );
}
