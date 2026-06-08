import { WeddingCardPreviewImage } from "../WeddingCardPreviewImage";
import { WeddingCardBrandingFooter } from "../WeddingCardBrandingFooter";
import type { WeddingCardTemplateProps } from "../wedding-card-types";
import { cn } from "@/lib/utils";
import { Heart, ImagePlus } from "lucide-react";
import type { FormEvent } from "react";

function formatDate(d: string | null) {
  if (!d) return null;
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("vi-VN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function formatDots(d: string | null) {
  if (!d) return null;
  try {
    const dt = new Date(d + "T12:00:00");
    const day = String(dt.getDate()).padStart(2, "0");
    const month = String(dt.getMonth() + 1).padStart(2, "0");
    const year = dt.getFullYear();
    return `${day} . ${month} . ${year}`;
  } catch {
    return d;
  }
}

function EditableName({
  value,
  onChange,
  className,
  placeholder,
}: {
  value: string;
  onChange?: (value: string) => void;
  className: string;
  placeholder: string;
}) {
  const editable = !!onChange;

  const handleInput = (event: FormEvent<HTMLHeadingElement>) => {
    if (!onChange) return;
    onChange(event.currentTarget.textContent?.replace(/\s+/g, " ").trim() || "");
  };

  return (
    <h1
      className={cn(className, editable && "cursor-text rounded-md px-2 py-1 outline-none focus:ring-2 focus:ring-[#e91e63]/35")}
      contentEditable={editable}
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder={placeholder}
      onInput={handleInput}
    >
      {value || placeholder}
    </h1>
  );
}

function ClickablePhoto({
  src,
  onClick,
  className,
}: {
  src?: string | null;
  onClick?: () => void;
  className: string;
}) {
  const clickable = !!onClick;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={cn(
        className,
        "relative overflow-hidden",
        clickable && "group cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#e91e63]/35",
        !clickable && "cursor-default",
      )}
    >
      {src ? (
        <WeddingCardPreviewImage src={src} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-white/80" />
      )}
      {clickable && (
        <span className="absolute inset-0 bg-black/0 group-hover:bg-black/15 group-focus:bg-black/15 transition-colors flex items-end justify-center pb-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-white opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity">
            <ImagePlus className="h-3 w-3" />
            Dổi ảnh
          </span>
        </span>
      )}
    </button>
  );
}

export function WeddingCardClassic({
  card,
  coverSrc,
  coupleSrc,
  embed,
  onGroomNameChange,
  onBrideNameChange,
  onCoverImageClick,
  onCoupleImageClick,
}: WeddingCardTemplateProps) {
  const dateLabel = formatDate(card.weddingDate);
  const dotsDate = formatDots(card.weddingDate);
  const msg =
    card.invitationMessage ||
    "Trân trọng kính mời Quý khách quang lâm dự buổi tiệc mừng hân lễ của chúng tôi. Sự hiện diện của Quý khách là niềm vinh hạnh và là món quà vô giá đối với đại uyên.";

  if (embed) {
    return (
      <article className="wc-bt-classic-embed bg-[#fce4ec] text-[#5c2d4a] font-serif min-h-0">
        <div className="wc-bt-classic-embed-top px-4 pt-5 pb-3 text-center">
          <p className="text-[8px] tracking-[0.35em] uppercase text-[#9a6b82]">Wedding Invitation</p>
          <p className="text-lg mt-1">{card.groomName}</p>
          <p className="text-[10px] text-[#c2185b] my-0.5">&</p>
          <p className="text-lg">{card.brideName}</p>
          {dotsDate && <p className="text-[9px] mt-2 text-[#7d5a6d]">{dotsDate}</p>}
        </div>
        <div className="aspect-[4/5] mx-3 mb-3 rounded-xl overflow-hidden shadow-md">
          {coverSrc || coupleSrc ? (
            <WeddingCardPreviewImage src={coverSrc || coupleSrc!} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-gradient-to-b from-[#f8bbd0] to-[#f48fb1]" />
          )}
        </div>
        <WeddingCardBrandingFooter className="text-[#9a6b82] pb-4" />
      </article>
    );
  }

  return (
    <article className="wc-bt-classic-full bg-[#fff0f3] text-[#4a2c40] font-serif relative overflow-hidden">
      <div className="wc-bt-classic-bokeh" aria-hidden />
      <header className="relative z-10 px-5 pt-8 pb-4 text-center">
        <p className="text-[10px] tracking-[0.4em] uppercase text-[#9a6b82]">✦ Wedding Invitation ✦</p>
        <div className="wc-bt-classic-photos mt-6">
          <ClickablePhoto
            src={coverSrc}
            onClick={onCoverImageClick}
            className="wc-bt-classic-photo wc-bt-classic-photo--l"
          />
          <span className="wc-bt-classic-photo-heart">
            <Heart className="w-3 h-3 fill-current text-[#e91e63]" />
          </span>
          <ClickablePhoto
            src={coupleSrc}
            onClick={onCoupleImageClick}
            className="wc-bt-classic-photo wc-bt-classic-photo--r"
          />
        </div>
        <EditableName
          value={card.groomName}
          onChange={onGroomNameChange}
          placeholder="Tên chú rể"
          className="mt-8 text-3xl sm:text-4xl font-medium leading-tight text-[#4a2c40]"
        />
        <Heart className="w-4 h-4 mx-auto my-2 text-[#e91e63] fill-[#f8bbd0]" />
        <EditableName
          value={card.brideName}
          onChange={onBrideNameChange}
          placeholder="Tên cô dâu"
          className="text-3xl sm:text-4xl font-medium leading-tight text-[#4a2c40]"
        />
      </header>

      <section className="relative z-10 px-6 pb-8 text-center">
        <p className="text-[10px] tracking-[0.35em] uppercase text-[#9a6b82] mb-3">Trân trọng kính mời</p>
        <p className="text-sm leading-relaxed text-[#5c3d52] whitespace-pre-line max-w-md mx-auto">{msg}</p>
        {dateLabel && <p className="mt-6 text-xs tracking-wide text-[#7d5a6d]">{dateLabel}</p>}
        {(card.ceremonyTime || card.receptionTime) && (
          <div className="mt-2 text-xs text-[#7d5a6d] space-y-0.5">
            {card.ceremonyTime && <p>Lễ · {card.ceremonyTime}</p>}
            {card.receptionTime && <p>Tiệc · {card.receptionTime}</p>}
          </div>
        )}
        <div className="mt-8 flex flex-col gap-3 justify-center max-w-xs mx-auto">
          <a href="#wc-section-wishes" className="wc-bt-btn wc-bt-btn-primary text-xs">
            Xác nhận tham dự
          </a>
          <a href="#wc-section-wishes" className="wc-bt-btn wc-bt-btn-outline-pink text-xs">
            Gửi lời chúc
          </a>
        </div>
      </section>
    </article>
  );
}
