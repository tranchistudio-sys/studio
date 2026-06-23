import { useEffect, useState } from "react";
import { Home, Loader2, RefreshCw, Save } from "lucide-react";
import { CmsImageField } from "@/components/cms/CmsImageField";
import {
  EMPTY_HOME_SETTINGS,
  useAdminHomeSettings,
  useSaveAdminHomeSettings,
  type HomeSettingsForm,
} from "@/hooks/use-cms-home-admin";
import { HERO } from "@/lib/public-site-config";
import {
  PLACEHOLDER_ABOUT,
  PLACEHOLDER_FEATURED_CONCEPT,
  PLACEHOLDER_FEATURED_SERVICE,
  PLACEHOLDER_FOOTER_BANNER,
  PLACEHOLDER_HERO,
} from "@/lib/cms-placeholders";
import { useToast } from "@/hooks/use-toast";
import { getPublicSiteHomeUrl } from "@/lib/public-site-url";

const inputClass =
  "w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-300";

export default function CmsHomeSettingsPage() {
  const { data, isLoading, isError, error, refetch, isFetched } = useAdminHomeSettings();
  const save = useSaveAdminHomeSettings();
  const { toast } = useToast();
  const [form, setForm] = useState<HomeSettingsForm>(EMPTY_HOME_SETTINGS);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const set = <K extends keyof HomeSettingsForm>(key: K, value: HomeSettingsForm[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  const onSave = async () => {
    if (!form) return;
    try {
      await save.mutateAsync(form);
      toast({ title: "Đã lưu cài đặt trang chủ" });
    } catch (e) {
      toast({
        title: "Lưu thất bại",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  if (!isFetched && isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin mr-2" />
        Đang tải…
      </div>
    );
  }

  if (isFetched && isError && !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] px-6 text-center gap-4">
        <p className="text-sm text-destructive font-medium">Không tải được dữ liệu</p>
        <p className="text-xs text-muted-foreground max-w-md">
          {error instanceof Error ? error.message : "Kiểm tra đăng nhập admin và API server (port 3000)."}
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-medium hover:bg-muted/60"
        >
          <RefreshCw className="w-4 h-4" />
          Tải lại
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#faf8f5]">
      <header className="shrink-0 border-b bg-white/90 backdrop-blur px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-neutral-900 flex items-center justify-center">
            <Home className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">Cài đặt Trang chủ</h1>
            <p className="text-xs text-muted-foreground">
              Nội dung hero, giới thiệu, ảnh nổi bật — không lấy từ Ảnh sản phẩm thật
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={getPublicSiteHomeUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Xem trang chủ
          </a>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={save.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-neutral-900 text-white px-5 py-2.5 text-sm font-medium hover:bg-neutral-800 disabled:opacity-60"
          >
            {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Lưu
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-4xl mx-auto w-full space-y-8 pb-16">
        <section className="rounded-2xl border border-border/80 bg-white p-5 sm:p-6 shadow-sm space-y-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Hero</h2>
          <CmsImageField
            label="Ảnh hero trang chủ"
            value={form.heroImageUrl}
            onChange={(v) => set("heroImageUrl", v)}
            aspect="video"
            placeholderSrc={PLACEHOLDER_HERO}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs text-muted-foreground">Dòng phụ (eyebrow)</label>
              <input
                className={inputClass + " mt-1"}
                value={form.eyebrow ?? ""}
                onChange={(e) => set("eyebrow", e.target.value || null)}
                placeholder={HERO.eyebrow}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Tiêu đề dòng 1</label>
              <input
                className={inputClass + " mt-1"}
                value={form.titleLine1 ?? ""}
                onChange={(e) => set("titleLine1", e.target.value || null)}
                placeholder={HERO.titleLine1}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Tiêu đề dòng 2 (nhấn mạnh)</label>
              <input
                className={inputClass + " mt-1"}
                value={form.titleLine2 ?? ""}
                onChange={(e) => set("titleLine2", e.target.value || null)}
                placeholder={HERO.titleLine2}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs text-muted-foreground">Mô tả ngắn</label>
              <textarea
                className={inputClass + " mt-1 resize-none min-h-[80px]"}
                value={form.subtitle ?? ""}
                onChange={(e) => set("subtitle", e.target.value || null)}
                placeholder={HERO.subtitle}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 border-t pt-4">
            <div>
              <label className="text-xs text-muted-foreground">Nút CTA chính — nhãn</label>
              <input
                className={inputClass + " mt-1"}
                value={form.ctaPrimaryLabel ?? ""}
                onChange={(e) => set("ctaPrimaryLabel", e.target.value || null)}
                placeholder={HERO.ctaPrimary.label}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Nút CTA chính — link</label>
              <input
                className={inputClass + " mt-1"}
                value={form.ctaPrimaryHref ?? ""}
                onChange={(e) => set("ctaPrimaryHref", e.target.value || null)}
                placeholder={HERO.ctaPrimary.href}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Nút CTA phụ — nhãn</label>
              <input
                className={inputClass + " mt-1"}
                value={form.ctaSecondaryLabel ?? ""}
                onChange={(e) => set("ctaSecondaryLabel", e.target.value || null)}
                placeholder={HERO.ctaSecondary.label}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Nút CTA phụ — link</label>
              <input
                className={inputClass + " mt-1"}
                value={form.ctaSecondaryHref ?? ""}
                onChange={(e) => set("ctaSecondaryHref", e.target.value || null)}
                placeholder={HERO.ctaSecondary.href}
              />
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-border/80 bg-white p-5 sm:p-6 shadow-sm space-y-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Giới thiệu</h2>
          <CmsImageField
            label="Ảnh Amazing Studio"
            value={form.aboutImageUrl}
            onChange={(v) => set("aboutImageUrl", v)}
            aspect="portrait"
            placeholderSrc={PLACEHOLDER_ABOUT}
          />
        </section>

        <section className="rounded-2xl border border-border/80 bg-white p-5 sm:p-6 shadow-sm space-y-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Ảnh nổi bật</h2>
          <CmsImageField
            label="Ảnh concept nổi bật (trang chủ)"
            hint="Không đồng bộ từ CMS Ảnh sản phẩm thật"
            value={form.featuredConceptImageUrl}
            onChange={(v) => set("featuredConceptImageUrl", v)}
            aspect="video"
            placeholderSrc={PLACEHOLDER_FEATURED_CONCEPT}
          />
          <CmsImageField
            label="Ảnh dịch vụ nổi bật"
            value={form.featuredServiceImageUrl}
            onChange={(v) => set("featuredServiceImageUrl", v)}
            aspect="video"
            placeholderSrc={PLACEHOLDER_FEATURED_SERVICE}
          />
        </section>

        <section className="rounded-2xl border border-border/80 bg-white p-5 sm:p-6 shadow-sm space-y-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Banner CTA cuối trang</h2>
          <CmsImageField
            label="Ảnh banner"
            value={form.footerBannerImageUrl}
            onChange={(v) => set("footerBannerImageUrl", v)}
            aspect="video"
            placeholderSrc={PLACEHOLDER_FOOTER_BANNER}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs text-muted-foreground">Tiêu đề</label>
              <input
                className={inputClass + " mt-1"}
                value={form.footerCtaTitle ?? ""}
                onChange={(e) => set("footerCtaTitle", e.target.value || null)}
                placeholder="Sẵn sàng lưu giữ khoảnh khắc?"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Mô tả ngắn</label>
              <input
                className={inputClass + " mt-1"}
                value={form.footerCtaSubtitle ?? ""}
                onChange={(e) => set("footerCtaSubtitle", e.target.value || null)}
                placeholder="Liên hệ tư vấn miễn phí"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Nút — nhãn</label>
              <input
                className={inputClass + " mt-1"}
                value={form.footerCtaButtonLabel ?? ""}
                onChange={(e) => set("footerCtaButtonLabel", e.target.value || null)}
                placeholder="Liên hệ ngay"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Nút — link</label>
              <input
                className={inputClass + " mt-1"}
                value={form.footerCtaButtonHref ?? ""}
                onChange={(e) => set("footerCtaButtonHref", e.target.value || null)}
                placeholder="/lien-he"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
