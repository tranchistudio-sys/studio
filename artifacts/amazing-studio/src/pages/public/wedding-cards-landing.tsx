import { useRef, useState } from "react";
import { Link } from "wouter";
import {
  Gift,
  Leaf,
  MousePointerClick,
  Share2,
  UserCheck,
  Wallet,
} from "lucide-react";
import { useWeddingCardTemplates } from "@/hooks/use-wedding-cards";
import { WeddingCardPreviewDialog } from "@/components/wedding-card/WeddingCardPreviewDialog";
import { WeddingCardBtTemplateRail } from "@/components/wedding-card/WeddingCardBtTemplateRail";
import { WeddingCardRenderer } from "@/components/wedding-card/WeddingCardRenderer";
import { buildDemoCard } from "@/components/wedding-card/wedding-card-config";
import type { WeddingCardTemplate } from "@/hooks/use-wedding-cards";
import { STUDIO_NAME } from "@/lib/public-site-config";

const HERO_IMG_L = "/uploads/cms/0540022e-96a2-4f72-8c1c-71c666a440d3.webp";
const HERO_IMG_R = "/uploads/cms/074d30b7-b3e7-4dcd-b61e-5ead1a8e7fd1.webp";
const COLLAGE_1 = "/uploads/cms/083256ee-9f1b-4473-ad68-d22e8ee2adf6.webp";
const COLLAGE_2 = "/uploads/cms/0e18a432-d5d4-4993-95f8-4f10e72fbe95.webp";
const COLLAGE_3 = "/uploads/cms/116119cd-b5ee-414b-a5c1-f3166d993484.webp";

const FEATURES = [
  "Hiển thị thời gian, địa điểm tổ chức hôn lễ.",
  "Thông tin giới thiệu Cô Dâu Chú Rể.",
  "Đăng album ảnh, câu chuyện tình yêu, dấu mốc thời gian.",
  "Tính năng đếm ngược thời gian đến sự kiện.",
  "Tính năng gửi quà cưới từ xa.",
  "Tính năng gửi lời chúc, mừng cưới online đến Cô Dâu Chú Rể.",
];

const WHY_ITEMS = [
  {
    icon: MousePointerClick,
    title: "Thao tác nhanh chóng",
    desc: "Gửi thiệp cưới điện tử đến khách mời chỉ trong vài giây qua email, tin nhắn hoặc mạng xã hội.",
  },
  {
    icon: UserCheck,
    title: "Quản lý khách mời dễ dàng",
    desc: "Theo dõi số lượng khách mời tham dự và lưu giữ lời chúc từ bạn bè, người thân.",
  },
  {
    icon: Share2,
    title: "Chia sẻ tiện lợi",
    desc: "Gửi thiệp cưới đến khách mời ở khắp mọi nơi chỉ trong vài giây qua email, tin nhắn hoặc mạng xã hội.",
  },
  {
    icon: Gift,
    title: "Linh hoạt cho khách mời",
    desc: "Khách mời có thể gửi tiền mừng bất cứ lúc nào, kể cả khi không thể tham dự trực tiếp.",
  },
  {
    icon: Wallet,
    title: "Tiết kiệm chi phí và thời gian",
    desc: "Không cần in ấn và vận chuyển, giúp giảm thiểu chi phí và thời gian chuẩn bị so với thiệp cưới truyền thống.",
  },
  {
    icon: Leaf,
    title: "Thân thiện với môi trường",
    desc: "Giảm thiểu việc sử dụng giấy và in ấn, góp phần bảo vệ môi trường.",
  },
];

export default function WeddingCardsLandingPage() {
  const {
    templates,
    isLoading,
    isError,
    apiError,
    fromApi,
    refetch,
    isFetching,
  } = useWeddingCardTemplates();
  const [previewTemplate, setPreviewTemplate] = useState<WeddingCardTemplate | null>(null);
  const galleryRef = useRef<HTMLElement>(null);

  const showList = !isLoading && templates.length > 0;
  const firstSlug = templates[0]?.slug ?? "classic";
  const createHref = `/thiep-cuoi-online/tao?template=${firstSlug}`;

  const scrollToGallery = () => {
    galleryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const demoCard = buildDemoCard(templates[0] ?? null);

  return (
    <div className="wc-bt-page wc-mobile-page pb-8">
      {/* Hero */}
      <section className="wc-bt-hero">
        <div className="wc-bt-hero-glow" aria-hidden />
        <div className="wc-bt-hero-photos wc-bt-hero-photos--left hidden sm:block" aria-hidden>
          <img src={HERO_IMG_L} alt="" />
        </div>
        <div className="wc-bt-hero-photos wc-bt-hero-photos--right hidden sm:block" aria-hidden>
          <img src={HERO_IMG_R} alt="" />
        </div>
        <div className="wc-bt-container relative z-10 text-center">
          <p className="wc-bt-eyebrow wc-fade-in">Thiệp cưới online</p>
          <h1 className="wc-bt-title text-4xl sm:text-5xl mt-3 wc-fade-in">{STUDIO_NAME}</h1>
          <p className="mt-5 text-sm sm:text-base text-[var(--wc-bt-muted)] max-w-xl mx-auto leading-relaxed wc-fade-in">
            Xu hướng đang được rất nhiều cặp đôi lựa chọn. Mỗi thiết kế tại Thiệp cưới online — {STUDIO_NAME} là lời chào đầu tiên cho hành trình hạnh phúc, nơi bạn gửi gắm cảm xúc và dấu ấn riêng của mình.
          </p>

          <div className="wc-bt-mockup-row wc-fade-in">
            <div className="wc-bt-mockup-phone">
              <div className="max-h-[280px] overflow-hidden">
                <WeddingCardRenderer card={demoCard} embed />
              </div>
            </div>
            <div className="wc-bt-mockup-laptop">
              <div className="max-h-[200px] overflow-hidden scale-90 origin-bottom">
                <WeddingCardRenderer card={demoCard} embed />
              </div>
            </div>
          </div>

          <div className="mt-8 wc-fade-in">
            <button type="button" onClick={scrollToGallery} className="wc-bt-btn wc-bt-btn-primary">
              Tạo Thiệp Ngay
            </button>
          </div>
        </div>
      </section>

      {/* Giới thiệu */}
      <section className="wc-bt-intro">
        <div className="wc-bt-container">
          <div className="wc-bt-intro-grid">
            <div className="wc-fade-in">
              <h2 className="wc-bt-title text-2xl sm:text-3xl mb-4">Giới thiệu</h2>
              <p className="text-sm text-[var(--wc-bt-muted)] leading-relaxed mb-4">
                Tình yêu bắt đầu từ những khoảnh khắc giản đơn và được lưu giữ trong từng chi tiết nhỏ. Thiệp cưới chính là lời mở đầu cho câu chuyện hạnh phúc ấy — nơi hai bạn gửi gắm cảm xúc, dấu ấn và phong cách riêng.
              </p>
              <p className="text-sm text-[var(--wc-bt-muted)] leading-relaxed mb-6">
                Với bộ sưu tập đa dạng cùng công cụ thiết kế dễ sử dụng, {STUDIO_NAME} giúp bạn tự tay tạo nên thiệp cưới mang đậm dấu ấn cá nhân. Từ phong cách cổ điển, thanh lịch đến hiện đại, tối giản — tất cả đều được tối ưu cho điện thoại.
              </p>
              <Link href={createHref} className="wc-bt-btn wc-bt-btn-primary">
                Tạo thiệp ngay
              </Link>
            </div>
            <div className="wc-bt-collage wc-fade-in">
              <img src={COLLAGE_1} alt="" className="wc-bt-collage-tall" loading="lazy" />
              <div className="wc-bt-collage-stack">
                <img src={COLLAGE_2} alt="" loading="lazy" />
                <img src={COLLAGE_3} alt="" loading="lazy" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Demo mẫu */}
      {showList && (
        <section className="wc-bt-container py-8">
          <WeddingCardBtTemplateRail
            templates={templates.slice(0, 5)}
            onPreview={setPreviewTemplate}
            variant="demo"
          />
        </section>
      )}

      {/* Tính năng */}
      <section className="wc-bt-features">
        <div className="wc-bt-container">
          <h2>Trải nghiệm tính năng nổi bật chỉ có trên Thiệp Cưới Online</h2>
          <ul className="wc-bt-feature-list">
            {FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* Vì sao chọn */}
      <section className="wc-bt-why">
        <div className="wc-bt-container">
          <h2>
            Vì sao nên chọn Thiệp Cưới Online — <span>{STUDIO_NAME}</span>
          </h2>
          <div className="wc-bt-why-grid">
            {WHY_ITEMS.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="wc-bt-why-item wc-fade-in">
                <div className="wc-bt-why-icon">
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Kho mẫu */}
      <section id="wc-templates" ref={galleryRef} className="wc-bt-gallery">
        <div className="wc-bt-container">
          <h2>Kho giao diện các mẫu thiệp cưới</h2>
          {isLoading || isFetching ? (
            <div className="wc-bt-rail">
              {[1, 2, 3].map((i) => (
                <div key={i} className="wc-bt-rail-item">
                  <div className="wc-bt-rail-preview animate-pulse bg-neutral-200" />
                </div>
              ))}
            </div>
          ) : showList ? (
            <WeddingCardBtTemplateRail templates={templates} onPreview={setPreviewTemplate} />
          ) : (
            <div className="text-center py-12">
              <p className="font-serif text-xl">Chưa có mẫu thiệp</p>
              <p className="mt-2 text-sm text-[var(--wc-bt-muted)]">
                {isError || apiError
                  ? `Không tải được danh sách mẫu${apiError ? `: ${apiError}` : ""}.`
                  : "Hệ thống chưa có mẫu thiệp khả dụng."}
              </p>
              <button type="button" onClick={() => refetch()} className="wc-bt-btn wc-bt-btn-primary mt-6">
                Thử tải lại
              </button>
            </div>
          )}
          {!fromApi && showList && import.meta.env.DEV && (
            <p className="mt-4 text-center text-[10px] text-amber-700">
              Đang dùng mẫu dự phòng — kiểm tra API /api/wedding-cards/public/templates
            </p>
          )}
        </div>
      </section>

      {/* CTA cuối */}
      <section className="wc-bt-cta-final">
        <div className="wc-bt-container">
          <h2>Mỗi câu chuyện tình yêu xứng đáng một tấm thiệp riêng biệt</h2>
          <p>
            Chỉ vài phút để tạo nên tấm thiệp cưới online sang trọng, mang đậm dấu ấn của hai bạn — và gửi đến mọi khách mời chỉ với một đường link.
          </p>
          <p className="wc-bt-cta-tag">Miễn phí · Dễ dàng · Sang trọng</p>
          <Link href={createHref} className="wc-bt-btn wc-bt-btn-primary">
            Tạo Thiệp Cưới Ngay →
          </Link>
        </div>
      </section>

      <WeddingCardPreviewDialog
        template={previewTemplate}
        open={!!previewTemplate}
        onClose={() => setPreviewTemplate(null)}
      />
    </div>
  );
}
