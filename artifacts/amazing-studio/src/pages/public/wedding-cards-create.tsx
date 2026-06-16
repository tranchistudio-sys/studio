import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Sparkles } from "lucide-react";
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
import { WeddingCardEnvelope } from "@/components/wedding-card/WeddingCardEnvelope";
import { WeddingCardEditorSteps } from "@/components/wedding-card/WeddingCardEditorSteps";
import { WeddingCardViewExtras } from "@/components/wedding-card/WeddingCardViewExtras";
import { WeddingCardPetals } from "@/components/wedding-card/WeddingCardPetals";
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
  const [envelopeDone, setEnvelopeDone] = useState(false);
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

  const handleInlineGroomName = (value: string) => {
    setGroomName(value);
    bumpPreview();
  };

  const handleInlineBrideName = (value: string) => {
    setBrideName(value);
    bumpPreview();
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

  if (opening && !envelopeDone) {
    return (
      <div className="wc-bt-envelope-create-page min-h-screen">
        <WeddingCardEnvelope
          card={previewCard}
          autoOpen={false}
          onOpened={() => {
            setEnvelopeDone(true);
            setOpening(false);
          }}
        >
          <div />
        </WeddingCardEnvelope>
      </div>
    );
  }

  const hasPhoto = !!(coverImageUrl || coupleImageUrl);
  const hasNames = !!(groomName.trim() && brideName.trim());

  return (
    <div className="wc-bt-editor-page wc-mobile-page min-h-screen flex flex-col">
      {create.isPending && (
        <WeddingCardOverlay message="Đang tạo link thiệp..." sub="Chỉ vài giây nữa thôi" />
      )}

      {createdSlug && (
        <WeddingCardSuccessModal
          slug={createdSlug}
          groomName={groomName.trim()}
          brideName={brideName.trim()}
        />
      )}

      <header className="shrink-0 border-b border-[var(--wc-bt-border,#e8e0d8)] bg-white px-4 py-3 flex items-center justify-between gap-3 wc-fade-in">
        <Link href="/thiep-cuoi-online" className="text-xs text-[var(--wc-bt-muted)] hover:text-[var(--wc-bt-text)] whitespace-nowrap">
          ← Mẫu thiệp
        </Link>
        <p className="text-sm font-medium text-[var(--wc-bt-text)] truncate">
          <span className="font-serif">{display.title}</span>
        </p>
        <div className="w-12" />
      </header>

      <div className="wc-bt-container px-3 border-b border-[var(--wc-bt-border,#e8e0d8)] bg-white/90 max-w-none">
        <WeddingCardEditorSteps hasPhoto={hasPhoto} hasNames={hasNames} />
        <p className="text-center text-[10px] text-neutral-400 pb-2 -mt-1">
          Chọn mẫu → Up hình → Sửa chữ → Lấy link
        </p>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row lg:items-start w-full max-w-7xl mx-auto">
        <div className="wc-bt-editor-preview wc-fade-in order-1 lg:order-2 lg:flex-1 flex flex-col items-center px-2 py-4 sm:py-6 lg:py-6 lg:sticky lg:top-0 lg:self-start lg:max-h-screen lg:overflow-y-auto">
          <p className="text-[10px] tracking-[0.25em] uppercase text-[var(--wc-bt-taupe)] mb-2 flex items-center gap-1 shrink-0">
            <Sparkles className="h-3 w-3" />
            Xem trước thiệp
          </p>
          <p className="text-[10px] text-[var(--wc-bt-muted)] mb-3 shrink-0">Cuộn để xem toàn bộ thiệp ↓</p>
          <div className={cn("rounded-xl transition-shadow w-full", previewPulse && "wc-preview-pulse")}>
            <WeddingCardPhoneFrame variant="bare" fullLength>
              <div className="wc-bt-full-preview relative">
                <WeddingCardPetals />
                <div className="relative z-10">
                  <WeddingCardRenderer
                    card={previewCard}
                    embed={false}
                    onGroomNameChange={handleInlineGroomName}
                    onBrideNameChange={handleInlineBrideName}
                    onCoverImageClick={() => document.getElementById("wc-cover-upload-input")?.click()}
                    onCoupleImageClick={() => document.getElementById("wc-couple-upload-input")?.click()}
                  />
                  <WeddingCardViewExtras card={previewCard} preview />
                </div>
              </div>
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

        <div className="wc-fade-in order-2 lg:order-1 w-full lg:w-[min(420px,40vw)] lg:shrink-0 lg:border-r border-[var(--wc-bt-border,#e8e0d8)] bg-[var(--wc-bt-cream,#fdfbf9)] px-3 sm:px-4 py-4 pb-28 lg:pb-8 lg:max-h-[calc(100vh-120px)] lg:overflow-y-auto">
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
            className="hidden lg:flex mt-6 w-full items-center justify-center gap-2 wc-bt-btn wc-bt-btn-primary rounded-xl disabled:opacity-60"
          >
            <Sparkles className="h-4 w-4" />
            Tạo thiệp & lấy link
          </button>
        </div>
      </div>

      <input
        id="wc-cover-upload-input"
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) uploadImage(file, "cover");
          e.currentTarget.value = "";
        }}
      />
      <input
        id="wc-couple-upload-input"
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) uploadImage(file, "couple");
          e.currentTarget.value = "";
        }}
      />

      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-[var(--wc-bt-border,#e8e0d8)] bg-white/95 backdrop-blur-md p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onCreate}
          disabled={create.isPending}
          className="wc-bt-btn wc-bt-btn-primary w-full flex items-center justify-center gap-2 rounded-xl disabled:opacity-60"
        >
          <Sparkles className="h-4 w-4" />
          Tạo thiệp & lấy link
        </button>
      </div>
    </div>
  );
}
