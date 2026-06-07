import { useState } from "react";
import { useWeddingCardTemplates } from "@/hooks/use-wedding-cards";
import { WeddingCardTemplateCard } from "@/components/wedding-card/WeddingCardTemplateCard";
import { WeddingCardPreviewDialog } from "@/components/wedding-card/WeddingCardPreviewDialog";
import type { WeddingCardTemplate } from "@/hooks/use-wedding-cards";

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

  const showList = !isLoading && templates.length > 0;

  return (
    <div className="wc-mobile-page pb-20 min-h-screen bg-[var(--public-cream,#faf8f5)]">
      <header className="wc-fade-in border-b border-[#e8e0d4]">
        <div className="wc-card-shell px-4 py-8 sm:py-10 text-center lg:max-w-2xl">
          <p className="text-[10px] tracking-[0.4em] uppercase text-neutral-500 mb-3">
            Amazing Studio
          </p>
          <h1 className="font-serif text-2xl sm:text-3xl font-light text-neutral-900">
            Chọn Mẫu Thiệp Cưới
          </h1>
          <p className="mt-3 text-sm text-neutral-600 leading-relaxed">
            Chọn mẫu → tải ảnh → chỉnh chữ → nhận link. Chạm card để xem nút trên điện thoại.
          </p>
          {import.meta.env.DEV && !isLoading && (
            <p className="mt-2 text-[10px] text-neutral-400 font-mono">
              {fromApi ? "API" : "fallback"} · {templates.length} mẫu
            </p>
          )}
        </div>
      </header>

      <section className="wc-card-shell px-3 sm:px-4 py-6 lg:max-w-none lg:mx-auto lg:max-w-5xl">
        {isLoading || isFetching ? (
          <div className="space-y-5 lg:grid lg:grid-cols-2 lg:gap-8 xl:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="aspect-[9/16] max-h-[min(70vh,520px)] w-full rounded-2xl bg-neutral-100 animate-pulse"
              />
            ))}
          </div>
        ) : showList ? (
          <div className="space-y-5 lg:grid lg:grid-cols-2 lg:gap-8 lg:space-y-0 xl:grid-cols-3">
            {templates.map((t, i) => (
              <WeddingCardTemplateCard
                key={t.slug}
                template={t}
                index={i}
                onPreview={() => setPreviewTemplate(t)}
              />
            ))}
          </div>
        ) : (
          <div className="wc-fade-in rounded-2xl border border-neutral-200 bg-white px-6 py-12 text-center">
            <p className="font-serif text-xl text-neutral-800">Chưa có mẫu thiệp</p>
            <p className="mt-2 text-sm text-neutral-500 max-w-sm mx-auto">
              {isError || apiError
                ? `Không tải được danh sách mẫu${apiError ? `: ${apiError}` : ""}.`
                : "Hệ thống chưa có mẫu thiệp khả dụng."}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-6 wc-touch-btn inline-flex items-center justify-center px-6 rounded-xl bg-neutral-900 text-white text-sm font-semibold"
            >
              Thử tải lại
            </button>
          </div>
        )}

        {!fromApi && showList && import.meta.env.DEV && (
          <p className="mt-4 text-center text-[10px] text-amber-700">
            Đang dùng mẫu dự phòng — kiểm tra API /api/wedding-cards/public/templates
          </p>
        )}
      </section>

      <WeddingCardPreviewDialog
        template={previewTemplate}
        open={!!previewTemplate}
        onClose={() => setPreviewTemplate(null)}
      />
    </div>
  );
}
