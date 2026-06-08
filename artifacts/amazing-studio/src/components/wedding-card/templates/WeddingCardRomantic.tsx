import { WeddingCardPreviewImage } from "../WeddingCardPreviewImage";
import { WeddingCardBrandingFooter } from "../WeddingCardBrandingFooter";
import type { WeddingCardTemplateProps } from "../wedding-card-types";
import { cn } from "@/lib/utils";
import { ImagePlus } from "lucide-react";
import type { FormEvent } from "react";

function formatDate(d: string | null) {
  if (!d) return null;
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("vi-VN", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
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
    <span
      className={cn(className, editable && "cursor-text rounded-md px-1 py-0.5 outline-none focus:ring-2 focus:ring-rose-200/50")}
      contentEditable={editable}
      suppressContentEditableWarning
      spellCheck={false}
      onInput={handleInput}
    >
      {value || placeholder}
    </span>
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
        clickable && "group cursor-pointer focus:outline-none focus:ring-2 focus:ring-rose-200/50",
        !clickable && "cursor-default",
      )}
    >
      {src ? (
        <WeddingCardPreviewImage src={src} className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full bg-gradient-to-br from-[#6b2d3e] to-[#4a1525]" />
      )}
      {clickable && (
        <span className="absolute inset-0 bg-black/0 group-hover:bg-black/20 group-focus:bg-black/20 transition-colors flex items-center justify-center">
          <span className="rounded-full bg-black/55 p-2 text-white opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity">
            <ImagePlus className="h-4 w-4" />
          </span>
        </span>
      )}
    </button>
  );
}

export function WeddingCardRomantic({
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

  return (
    <article
      className={cn(
        "bg-gradient-to-b from-[#4a1525] via-[#5c2030] to-[#3d121f] text-[#fce8ec]",
        embed ? "min-h-0" : "min-h-screen",
      )}
    >
      <ClickablePhoto
        src={coverSrc}
        onClick={onCoverImageClick}
        className={cn("relative overflow-hidden", embed ? "aspect-[4/5]" : "h-[46vh] min-h-[220px]")}
      />
      <div className={cn("px-5 text-center relative", embed ? "pb-6 -mt-14" : "pb-28 max-w-lg mx-auto -mt-14")}>
        <p className="text-rose-200/80 text-lg mb-1">&</p>
        <h1 className="font-serif text-3xl text-[#fff5f7] leading-snug">
          <EditableName value={card.brideName} onChange={onBrideNameChange} placeholder="Tên cô dâu" className="inline" />
          <span className="block text-sm font-sans font-normal text-rose-200/70 my-1.5">và</span>
          <EditableName value={card.groomName} onChange={onGroomNameChange} placeholder="Tên chú rể" className="inline" />
        </h1>
        {dateLabel && <p className="mt-4 text-xs text-rose-100/80 tracking-wide">{dateLabel}</p>}
        {(card.ceremonyTime || card.receptionTime) && (
          <p className="mt-2 text-[10px] text-rose-200/60">
            {[card.ceremonyTime && `Lễ ${card.ceremonyTime}`, card.receptionTime && `Tiệc ${card.receptionTime}`]
              .filter(Boolean)
              .join("  ·  ")}
          </p>
        )}
        {coupleSrc && (
          <ClickablePhoto
            src={coupleSrc}
            onClick={onCoupleImageClick}
            className="mt-7 mx-auto w-44 rounded-xl overflow-hidden shadow-2xl ring-2 ring-rose-200/30"
          />
        )}
        {card.invitationMessage && (
          <p className="mt-7 text-sm leading-relaxed text-rose-50/85 whitespace-pre-line px-1">
            {card.invitationMessage}
          </p>
        )}
        {card.contactPhone && !embed && (
          <a
            href={`tel:${card.contactPhone.replace(/\s/g, "")}`}
            className="mt-8 inline-block rounded-full bg-rose-100/15 border border-rose-200/40 px-8 py-2.5 text-xs font-medium text-rose-50"
          >
            Liên hệ
          </a>
        )}
        <WeddingCardBrandingFooter className="mt-8 text-rose-200/50 border-rose-200/20" />
      </div>
    </article>
  );
}
