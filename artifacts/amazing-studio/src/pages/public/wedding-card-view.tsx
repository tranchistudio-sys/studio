import { useRoute } from "wouter";
import { WeddingCardOverlay } from "@/components/wedding-card/WeddingCardOverlay";
import { useWeddingCardBySlug } from "@/hooks/use-wedding-cards";
import { WeddingCardRenderer } from "@/components/wedding-card/WeddingCardRenderer";
import { WeddingCardPhoneFrame } from "@/components/wedding-card/WeddingCardPhoneFrame";
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
      <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-200/60 px-6 text-center wc-fade-in">
        <p className="font-serif text-2xl text-neutral-800">Không tìm thấy thiệp</p>
        <p className="mt-2 text-sm text-neutral-500">Link có thể đã hết hạn hoặc bị ẩn.</p>
        <a
          href={`${import.meta.env.BASE_URL}thiep-cuoi-online`}
          className="mt-8 text-sm underline text-neutral-700"
        >
          Tạo thiệp mới
        </a>
      </div>
    );
  }

  return (
    <div className="wc-mobile-page min-h-screen bg-neutral-200/60 py-4 sm:py-8 relative">
      <WeddingCardPetals />
      <div className="wc-fade-in flex flex-col items-center gap-4 w-full max-w-[430px] mx-auto px-0 relative z-10">
        <WeddingCardReveal className="w-full">
          <WeddingCardPhoneFrame variant="bare">
            <WeddingCardRenderer card={card} embed />
          </WeddingCardPhoneFrame>
        </WeddingCardReveal>
        <WeddingCardViewExtras card={card} />
      </div>
      {shareUrl && <WeddingCardFloatingActions shareUrl={shareUrl} />}
    </div>
  );
}
