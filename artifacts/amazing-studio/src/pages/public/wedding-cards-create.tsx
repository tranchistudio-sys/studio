import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Loader2, Sparkles } from "lucide-react";
import {
  useCreateWeddingCard,
  useWeddingCardTemplate,
  useWeddingCardTemplates,
  type CreateWeddingCardInput,
  type PublicWeddingCard,
} from "@/hooks/use-wedding-cards";
import { getImageSrc } from "@/lib/imageUtils";
import { uploadWeddingCardImage } from "@/hooks/use-wedding-card-upload";
import { WeddingCardRenderer } from "@/components/wedding-card/WeddingCardRenderer";
import { WeddingCardPhoneFrame } from "@/components/wedding-card/WeddingCardPhoneFrame";
import { WeddingCardEditorPanel } from "@/components/wedding-card/WeddingCardEditorPanel";
import { WeddingCardSuccessModal } from "@/components/wedding-card/WeddingCardSuccessModal";
import { WeddingCardOverlay } from "@/components/wedding-card/WeddingCardOverlay";
import { WeddingCardEditorSteps } from "@/components/wedding-card/WeddingCardEditorSteps";
import { getTemplateDisplay } from "@/components/wedding-card/wedding-card-config";
import { cn } from "@/lib/utils";

const EMPTY_PREVIEW: PublicWeddingCard = {
  id: 0,
  slug: "preview",
  status: "published",
  templateId: 0,
  templateSlug: "classic",
  themeKey: "classic",
  groomName: "Chú rể",
  brideName: "Cô dâu",
  weddingDate: null,
  ceremonyTime: null,
  receptionTime: null,
  venueGroom: null,
  venueBride: null,
  venueReception: null,
  mapsUrlGroom: null,
  mapsUrlBride: null,
  mapsUrlReception: null,
  invitationMessage: null,
  coverImageUrl: null,
  coupleImageUrl: null,
  contactPhone: null,
  viewCount: 0,
  publishedAt: null,
  createdAt: new Date().toISOString(),
};

export default function WeddingCardsCreatePage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialTemplate = params.get("template") || "classic";

  const { templates } = useWeddingCardTemplates();
  const create = useCreateWeddingCard();

  const [opening, setOpening] = useState(true);
  const [templateSlug] = useState(initialTemplate);
  const { data: templateDetail } = useWeddingCardTemplate(templateSlug);
  const [groomName, setGroomName] = useState("");
  const [brideName, setBrideName] = useState("");
  const [weddingDate, setWeddingDate] = useState("");
  const [ceremonyTime, setCeremonyTime] = useState("");
  const [receptionTime, setReceptionTime] = useState("");
  const [venueGroom, setVenueGroom] = useState("");
  const [venueBride, setVenueBride] = useState("");
  const [venueReception, setVenueReception] = useState("");
  const [mapsUrlGroom, setMapsUrlGroom] = useState("");
  const [mapsUrlBride, setMapsUrlBride] = useState("");
  const [mapsUrlReception, setMapsUrlReception] = useState("");
  const [invitationMessage, setInvitationMessage] = useState("");
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(null);
  const [coupleImageUrl, setCoupleImageUrl] = useState<string | null>(null);
  const [albumImageUrls, setAlbumImageUrls] = useState<string[]>([]);
  const [contactPhone, setContactPhone] = useState("");
  const [uploading, setUploading] = useState<"cover" | "couple" | "extra" | null>(null);
  const [templateSeeded, setTemplateSeeded] = useState(false);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [previewPulse, setPreviewPulse] = useState(false);
  const previewPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const themeKey = templates.find((t) => t.slug === templateSlug)?.themeKey ?? templateSlug;
  const display = getTemplateDisplay(templateSlug);

  useEffect(() => {
    const t = setTimeout(() => setOpening(false), 520);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!templateDetail || templateSeeded) return;
    const bg = templateDetail.defaultBackgroundUrl;
    const thumb = templateDetail.thumbnailUrl ?? templateDetail.mockupImageUrl;
    if (!coverImageUrl && bg) setCoverImageUrl(bg);
    else if (!coverImageUrl && thumb) setCoverImageUrl(thumb);
    if (!coupleImageUrl && templateDetail.mockupImageUrl) setCoupleImageUrl(templateDetail.mockupImageUrl);
    setTemplateSeeded(true);
  }, [templateDetail, templateSeeded, coverImageUrl, coupleImageUrl]);

  const previewCard: PublicWeddingCard = {
    ...EMPTY_PREVIEW,
    templateSlug,
    themeKey,
    groomName: groomName.trim() || EMPTY_PREVIEW.groomName,
    brideName: brideName.trim() || EMPTY_PREVIEW.brideName,
    weddingDate: weddingDate || null,
    ceremonyTime: ceremonyTime || null,
    receptionTime: receptionTime || null,
    venueGroom: venueGroom || null,
    venueBride: venueBride || null,
    venueReception: venueReception || null,
    mapsUrlGroom: mapsUrlGroom || null,
    mapsUrlBride: mapsUrlBride || null,
    mapsUrlReception: mapsUrlReception || null,
    invitationMessage: invitationMessage || null,
    coverImageUrl,
    coupleImageUrl,
    contactPhone: contactPhone || null,
  };

  const bumpPreview = () => {
    if (previewPulseTimer.current) clearTimeout(previewPulseTimer.current);
    setPreviewPulse(true);
    previewPulseTimer.current = setTimeout(() => setPreviewPulse(false), 450);
  };

  const form = {
    groomName,
    brideName,
    weddingDate,
    ceremonyTime,
    receptionTime,
    venueGroom,
    venueBride,
    venueReception,
    mapsUrlGroom,
    mapsUrlBride,
    mapsUrlReception,
    invitationMessage,
    contactPhone,
    coverImageUrl,
    coupleImageUrl,
  };

  const uploadImage = async (file: File, kind: "cover" | "couple" | "extra") => {
    setUploading(kind);
    try {
      const path = await uploadWeddingCardImage(file, kind);
      if (kind === "cover") setCoverImageUrl(path);
      else if (kind === "couple") setCoupleImageUrl(path);
      else setAlbumImageUrls((prev) => [...prev, path].slice(0, 12));
      bumpPreview();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      setUploading(null);
    }
  };

  const onCreate = async () => {
    if (!groomName.trim() || !brideName.trim()) {
      alert("Vui lòng nhập tên chú rể và cô dâu");
      return;
    }
    const templateBg = templateDetail?.defaultBackgroundUrl ?? null;
    if (!coverImageUrl && !coupleImageUrl && !templateBg) {
      alert("Vui lòng tải ít nhất ảnh bìa hoặc ảnh cặp đôi");
      return;
    }
    const body: CreateWeddingCardInput = {
      templateSlug,
      groomName: groomName.trim(),
      brideName: brideName.trim(),
      weddingDate: weddingDate || null,
      ceremonyTime: ceremonyTime || null,
      receptionTime: receptionTime || null,
      venueGroom: venueGroom || null,
      venueBride: venueBride || null,
      venueReception: venueReception || null,
      mapsUrlGroom: mapsUrlGroom || null,
      mapsUrlBride: mapsUrlBride || null,
      mapsUrlReception: mapsUrlReception || null,
      invitationMessage: invitationMessage || null,
      coverImageUrl: coverImageUrl ?? templateDetail?.defaultBackgroundUrl ?? null,
      coupleImageUrl,
      contactPhone: contactPhone || null,
    };
    try {
      const res = await create.mutateAsync(body);
      setCreatedSlug(res.slug);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không tạo được thiệp");
    }
  };

  if (opening) {
    return <WeddingCardOverlay message="Đang mở mẫu thiệp..." sub="Chuẩn bị không gian thiết kế cho bạn" />;
  }

  const hasPhoto = !!(coverImageUrl || coupleImageUrl);
  const hasNames = !!(groomName.trim() && brideName.trim());

  return (
    <div className="wc-mobile-page min-h-screen bg-neutral-100/80 flex flex-col">
      {create.isPending && (
        <WeddingCardOverlay message="Đang tạo link thiệp..." sub="Chỉ vài giây nữa thôi ✨" />
      )}

      {createdSlug && (
        <WeddingCardSuccessModal
          slug={createdSlug}
          groomName={groomName.trim()}
          brideName={brideName.trim()}
        />
      )}

      <header className="shrink-0 border-b border-neutral-200/80 bg-white px-4 py-3 flex items-center justify-between gap-3 wc-fade-in">
        <Link href="/thiep-cuoi-online" className="text-xs text-neutral-500 hover:text-neutral-800 whitespace-nowrap">
          ← Mẫu thiệp
        </Link>
        <p className="text-sm font-medium text-neutral-800 truncate">
          <span className="font-serif">{display.title}</span>
        </p>
        <div className="w-12" />
      </header>

      <div className="wc-card-shell px-3 border-b border-neutral-200/60 bg-white/80">
        <WeddingCardEditorSteps hasPhoto={hasPhoto} hasNames={hasNames} />
        <p className="text-center text-[10px] text-neutral-400 pb-2 -mt-1">
          Chọn mẫu → Up hình → Sửa chữ → Lấy link
        </p>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row lg:items-start w-full max-w-7xl mx-auto">
        <div className="wc-fade-in order-1 lg:order-2 lg:flex-1 lg:sticky lg:top-0 flex flex-col items-center bg-gradient-to-b from-rose-50/50 via-neutral-100/40 to-neutral-100/60 px-2 py-4 sm:py-6 lg:py-10 lg:min-h-[calc(100vh-120px)]">
          <p className="text-[10px] tracking-[0.25em] uppercase text-rose-400/90 mb-2 flex items-center gap-1">
            <Sparkles className="h-3 w-3" />
            Xem trước thiệp
          </p>
          <div className={cn("rounded-xl transition-shadow", previewPulse && "wc-preview-pulse")}>
            <WeddingCardPhoneFrame variant="bare">
              <WeddingCardRenderer card={previewCard} embed />
            </WeddingCardPhoneFrame>
            {albumImageUrls.length > 0 && (
              <div className="mt-4 w-full max-w-[280px] flex gap-2 overflow-x-auto pb-1 px-1">
                {albumImageUrls.map((url, i) => {
                  const src = getImageSrc(url);
                  if (!src) return null;
                  return (
                    <img
                      key={`${url}-${i}`}
                      src={src}
                      alt=""
                      className="h-14 w-14 shrink-0 rounded-lg object-cover border border-white/80 shadow"
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="wc-fade-in order-2 lg:order-1 w-full lg:w-[min(400px,38vw)] lg:shrink-0 lg:border-r border-neutral-200/80 bg-[var(--public-cream,#faf8f5)] px-3 sm:px-4 py-4 pb-28 lg:pb-8 lg:max-h-[calc(100vh-120px)] lg:overflow-y-auto">
          <WeddingCardEditorPanel
            form={form}
            setters={{
              setGroomName: (v) => {
                setGroomName(v);
                bumpPreview();
              },
              setBrideName: (v) => {
                setBrideName(v);
                bumpPreview();
              },
              setWeddingDate: (v) => {
                setWeddingDate(v);
                bumpPreview();
              },
              setCeremonyTime: (v) => {
                setCeremonyTime(v);
                bumpPreview();
              },
              setReceptionTime: (v) => {
                setReceptionTime(v);
                bumpPreview();
              },
              setVenueGroom,
              setVenueBride,
              setVenueReception,
              setMapsUrlGroom,
              setMapsUrlBride,
              setMapsUrlReception,
              setInvitationMessage: (v) => {
                setInvitationMessage(v);
                bumpPreview();
              },
              setContactPhone,
            }}
            uploading={uploading}
            onUpload={uploadImage}
            onClearCover={() => setCoverImageUrl(null)}
            onClearCouple={() => setCoupleImageUrl(null)}
            albumImageUrls={albumImageUrls}
            onUploadAlbum={(f) => uploadImage(f, "extra")}
            onRemoveAlbum={(idx) => {
              setAlbumImageUrls((prev) => prev.filter((_, i) => i !== idx));
              bumpPreview();
            }}
            uploadingAlbum={uploading === "extra"}
          />
          <button
            type="button"
            onClick={onCreate}
            disabled={create.isPending}
            className="hidden lg:flex mt-6 w-full items-center justify-center gap-2 py-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-700 hover:to-rose-600 text-white text-sm font-bold shadow-lg shadow-rose-200/60 disabled:opacity-60 wc-btn-glow"
          >
            <Sparkles className="h-4 w-4" />
            Tạo thiệp & lấy link
          </button>
        </div>
      </div>

      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-neutral-200 bg-white/95 backdrop-blur-md p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onCreate}
          disabled={create.isPending}
          className="wc-touch-btn wc-btn-glow w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 text-white text-base font-bold disabled:opacity-60 shadow-lg shadow-rose-200/50"
        >
          <Sparkles className="h-4 w-4" />
          Tạo thiệp & lấy link
        </button>
      </div>
    </div>
  );
}
