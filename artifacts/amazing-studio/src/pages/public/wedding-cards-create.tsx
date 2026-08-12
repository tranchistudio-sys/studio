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
import { fileFingerprint, removeMedia, setMediaRole, swapCovers, type WeddingMediaItem, type WeddingMediaRole } from "@/lib/wedding-card-media";

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
  const [notificationEmail, setNotificationEmail] = useState("");
  const [createAttempted, setCreateAttempted] = useState(false);
  const [mediaItems, setMediaItems] = useState<WeddingMediaItem[]>([]);
  const [uploading, setUploading] = useState<"cover" | "couple" | "extra" | null>(null);
  const [templateSeeded, setTemplateSeeded] = useState(false);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [previewPulse, setPreviewPulse] = useState(false);
  const previewPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      localStorage.removeItem("amazing-studio:wedding-card-draft:v2");
    } catch { /* local storage may be unavailable */ }
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!mediaItems.some((item) => item.status === "processing" || item.status === "uploading")) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [mediaItems]);

  useEffect(() => {
    if (!mediaItems.length) return;
    setCoverImageUrl(mediaItems.find((item) => item.role === "cover1")?.remoteUrl ?? null);
    setCoupleImageUrl(mediaItems.find((item) => item.role === "cover2")?.remoteUrl ?? null);
    setAlbumImageUrls(mediaItems.filter((item) => item.role === "album" && item.remoteUrl).map((item) => item.remoteUrl!));
  }, [mediaItems]);

  const themeKey = templates.find((t) => t.slug === templateSlug)?.themeKey ?? templateSlug;
  const display = getTemplateDisplay(templateSlug);

  // The live preview should react as soon as files are selected. During upload,
  // use the local object URL; once complete, React automatically switches to
  // the permanent remote URL stored on the same media item.
  const previewCoverItem = mediaItems.find((item) => item.role === "cover1");
  const previewCoupleItem = mediaItems.find((item) => item.role === "cover2");
  const previewCoverImageUrl = previewCoverItem?.remoteUrl ?? previewCoverItem?.previewUrl ?? coverImageUrl;
  const previewCoupleImageUrl = previewCoupleItem?.remoteUrl ?? previewCoupleItem?.previewUrl ?? coupleImageUrl;
  const previewAlbumImageUrls = mediaItems
    .filter((item) => item.role === "album")
    .map((item) => item.remoteUrl ?? item.previewUrl)
    .filter(Boolean);

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
    coverImageUrl: previewCoverImageUrl,
    coupleImageUrl: previewCoupleImageUrl,
    albumImageUrls: previewAlbumImageUrls,
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
    notificationEmail,
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

  const syncRoles = (items: WeddingMediaItem[]) => {
    setMediaItems(items);
    setCoverImageUrl(items.find((item) => item.role === "cover1")?.remoteUrl ?? null);
    setCoupleImageUrl(items.find((item) => item.role === "cover2")?.remoteUrl ?? null);
    setAlbumImageUrls(items.filter((item) => item.role === "album" && item.remoteUrl).map((item) => item.remoteUrl!));
    bumpPreview();
  };

  const uploadMediaItem = async (item: WeddingMediaItem) => {
    setMediaItems((prev) => prev.map((x) => x.id === item.id ? { ...x, status: "uploading", progress: 35 } : x));
    try {
      const remoteUrl = await uploadWeddingCardImage(item.file!, item.role);
      setMediaItems((prev) => {
        return prev.map((x) => x.id === item.id ? { ...x, remoteUrl, status: "complete" as const, progress: 100 } : x);
      });
    } catch (error) {
      setMediaItems((prev) => prev.map((x) => {
        if (x.id !== item.id) return x;
        if (import.meta.env.DEV && x.previewUrl.startsWith("blob:")) {
          return { ...x, status: "complete" as const, progress: 100, error: "Chỉ xem trước trên máy local" };
        }
        return { ...x, status: "failed" as const, progress: 0, error: error instanceof Error ? error.message : "Upload thất bại" };
      }));
    }
  };

  const pickMedia = (files: File[]) => {
    const accepted = files.slice(0, Math.max(0, 30 - mediaItems.length));
    const fingerprints = new Set(mediaItems.map((item) => item.fingerprint));
    const fresh = accepted.filter((file) => !fingerprints.has(fileFingerprint(file)) && /image\/(jpeg|png|webp|heic|heif)/i.test(file.type || "image/jpeg"));
    const additions = fresh.map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}`,
      name: file.name,
      fingerprint: fileFingerprint(file),
      previewUrl: URL.createObjectURL(file),
      remoteUrl: null,
      file,
      status: "processing" as const,
      progress: 5,
      role: "album" as const,
    }));
    const occupied = new Set(mediaItems.map((item) => item.role));
    const withRoles = additions.map((item) => {
      const role: WeddingMediaRole = !occupied.has("cover1") ? "cover1" : !occupied.has("cover2") ? "cover2" : "album";
      occupied.add(role);
      return { ...item, role };
    });
    setMediaItems((prev) => [...prev, ...withRoles]);
    void (async () => {
      for (let index = 0; index < withRoles.length; index += 3) {
        await Promise.all(withRoles.slice(index, index + 3).map(uploadMediaItem));
      }
    })();
  };

  const onCreate = async () => {
    if (create.isPending) return;
    setCreateAttempted(true);
    if (!groomName.trim() || !brideName.trim()) {
      alert("Vui lòng nhập tên chú rể và cô dâu");
      return;
    }
    const templateBg = templateDetail?.defaultBackgroundUrl ?? null;
    if (!previewCoverImageUrl && !previewCoupleImageUrl && !templateBg) {
      alert("Vui lòng tải ít nhất ảnh bìa hoặc ảnh cặp đôi");
      return;
    }
    if (mediaItems.filter((item) => item.status === "complete").length < 2) {
      alert("Vui lòng chọn ít nhất 2 ảnh.");
      return;
    }
    if (!weddingDate) {
      alert("Vui lòng nhập ngày cưới.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notificationEmail.trim())) {
      const emailInput = document.getElementById("wc-notification-email") as HTMLInputElement | null;
      emailInput?.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => emailInput?.focus(), 350);
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
      notificationEmail: notificationEmail || null,
      albumImageUrls,
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
  const createDisabledReason = !hasNames
    ? "Vui lòng nhập tên chú rể và cô dâu."
    : mediaItems.filter((item) => item.status === "complete").length < 2
      ? "Vui lòng chọn ít nhất 2 ảnh."
      : !weddingDate
        ? "Vui lòng nhập ngày cưới."
        : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notificationEmail.trim())
          ? "Vui lòng nhập email nhận lời chúc hợp lệ."
        : mediaItems.some((item) => item.status === "processing" || item.status === "uploading")
          ? "Vui lòng chờ tải ảnh hoàn tất."
          : null;

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
            {previewAlbumImageUrls.length > 0 && (
              <div className="mt-4 w-full max-w-[280px] flex gap-2 overflow-x-auto pb-1 px-1">
                {previewAlbumImageUrls.map((url, i) => {
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
            showEmailError={createAttempted && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notificationEmail.trim())}
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
              setNotificationEmail,
            }}
            mediaItems={mediaItems}
            onPickMedia={pickMedia}
            onMediaRole={(id, role) => syncRoles(setMediaRole(mediaItems, id, role))}
            onSwapCovers={() => syncRoles(swapCovers(mediaItems))}
            onRemoveMedia={(id) => syncRoles(removeMedia(mediaItems, id))}
            onRetryMedia={(id, replacementFile) => {
              const item = mediaItems.find((x) => x.id === id);
              if (!item) return;
              if (replacementFile) {
                const replacement = { ...item, name: replacementFile.name, fingerprint: fileFingerprint(replacementFile), previewUrl: URL.createObjectURL(replacementFile), remoteUrl: null, file: replacementFile, status: "processing" as const, progress: 5, error: undefined };
                setMediaItems((prev) => prev.map((x) => x.id === id ? replacement : x));
                void uploadMediaItem(replacement);
              } else if (item.status === "complete") {
                setMediaItems((prev) => prev.map((x) => x.id === id ? { ...x, status: "failed" as const, progress: 0, error: "Ảnh cũ không còn tồn tại" } : x));
              } else if (item.file) {
                void uploadMediaItem(item);
              }
            }}
            onMoveMedia={(id, direction) => {
              const index = mediaItems.findIndex((item) => item.id === id);
              const target = index + direction;
              if (index < 0 || target < 0 || target >= mediaItems.length) return;
              const next = [...mediaItems];
              [next[index], next[target]] = [next[target], next[index]];
              syncRoles(next);
            }}
          />
          {createDisabledReason && <p className="mt-3 text-center text-sm font-medium text-[#713848]" role="status">{createDisabledReason}</p>}
          <button
            type="button"
            onClick={onCreate}
            disabled={create.isPending}
            className="wc-create-card-button hidden lg:flex mt-3 w-full items-center justify-center gap-2 wc-bt-btn wc-bt-btn-primary rounded-xl"
          >
            <Sparkles className="h-4 w-4" />
            {create.isPending ? "Đang tạo thiệp…" : "Tạo thiệp & lấy link"}
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
          className="wc-create-card-button wc-bt-btn wc-bt-btn-primary w-full flex items-center justify-center gap-2 rounded-xl"
        >
          <Sparkles className="h-4 w-4" />
          {create.isPending ? "Đang tạo thiệp…" : "Tạo thiệp & lấy link"}
        </button>
      </div>
    </div>
  );
}
