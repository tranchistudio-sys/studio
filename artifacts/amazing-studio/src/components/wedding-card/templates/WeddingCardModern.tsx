import { WeddingCardPreviewImage } from "../WeddingCardPreviewImage";
import { WeddingCardBrandingFooter } from "../WeddingCardBrandingFooter";
import type { WeddingCardTemplateProps } from "../wedding-card-types";
import { cn } from "@/lib/utils";
import { ImagePlus } from "lucide-react";
import { useEffect, useRef, type FormEvent } from "react";

function formatDate(d: string | null) {
  if (!d) return null;
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
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
  const ref = useRef<HTMLSpanElement>(null);

  // contentEditable KHÔNG kiểm soát: tránh React ghi đè text node mỗi keystroke
  // (caret nhảy về đầu → nhập ngược "LONG" → "GNOL").
  useEffect(() => {
    if (!editable) return;
    const el = ref.current;
    if (el && document.activeElement !== el && (el.textContent || "") !== (value || "")) {
      el.textContent = value || "";
    }
  }, [editable, value]);

  if (!editable) {
    return <span className={className}>{value || placeholder}</span>;
  }

  return (
    <span
      ref={ref}
      className={cn(className, "cursor-text rounded-md px-1 py-0.5 outline-none focus:ring-2 focus:ring-neutral-300")}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      dir="ltr"
      onInput={(event: FormEvent<HTMLSpanElement>) => onChange(event.currentTarget.textContent || "")}
    >
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
        clickable && "group cursor-pointer focus:outline-none focus:ring-2 focus:ring-neutral-400",
        !clickable && "cursor-default",
      )}
    >
      {src ? (
        <WeddingCardPreviewImage src={src} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-neutral-200" />
      )}
      {clickable && (
        <span className="absolute inset-0 bg-black/0 group-hover:bg-black/15 group-focus:bg-black/15 transition-colors flex items-center justify-center">
          <span className="rounded-full bg-black/55 p-2 text-white opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity">
            <ImagePlus className="h-4 w-4" />
          </span>
        </span>
      )}
    </button>
  );
}

export function WeddingCardModern({
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
    <article className={cn("bg-white text-neutral-900 font-sans", embed ? "min-h-0" : "min-h-screen")}>
      <header className="px-5 pt-8 pb-5 border-b border-neutral-100">
        <p className="text-[9px] font-bold tracking-[0.4em] uppercase text-neutral-400">Wedding</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight leading-tight">
          <EditableName value={card.groomName} onChange={onGroomNameChange} placeholder="Tên chú rể" className="inline" />
          <span className="text-neutral-300 font-light mx-1.5">/</span>
          <EditableName value={card.brideName} onChange={onBrideNameChange} placeholder="Tên cô dâu" className="inline" />
        </h1>
        {dateLabel && <p className="mt-2 text-base font-semibold tabular-nums">{dateLabel}</p>}
      </header>
      <ClickablePhoto
        src={coverSrc}
        onClick={onCoverImageClick}
        className={cn("w-full bg-neutral-100", embed ? "aspect-[4/5]" : "aspect-[3/4] max-h-[50vh]")}
      />
      <div className={cn("px-5 py-6", embed ? "pb-4" : "pb-28 max-w-lg mx-auto")}>
        {coupleSrc && (
          <ClickablePhoto
            src={coupleSrc}
            onClick={onCoupleImageClick}
            className="w-full max-w-[200px] mx-auto aspect-square bg-neutral-100 mb-6"
          />
        )}
        {(card.ceremonyTime || card.receptionTime) && (
          <div className="grid grid-cols-2 gap-2 text-xs mb-6">
            {card.ceremonyTime && (
              <div className="border border-neutral-200 p-3">
                <p className="text-[9px] uppercase text-neutral-400">Lễ</p>
                <p className="font-bold mt-0.5">{card.ceremonyTime}</p>
              </div>
            )}
            {card.receptionTime && (
              <div className="border border-neutral-200 p-3">
                <p className="text-[9px] uppercase text-neutral-400">Tiệc</p>
                <p className="font-bold mt-0.5">{card.receptionTime}</p>
              </div>
            )}
          </div>
        )}
        {card.invitationMessage && (
          <p className="text-sm leading-relaxed text-neutral-600 whitespace-pre-line border-l-2 border-neutral-900 pl-3 mb-6">
            {card.invitationMessage}
          </p>
        )}
        {card.contactPhone && !embed && (
          <a
            href={`tel:${card.contactPhone.replace(/\s/g, "")}`}
            className="block w-full text-center bg-neutral-900 text-white py-3 text-xs font-bold tracking-wide mb-6"
          >
            Gọi điện
          </a>
        )}
        <WeddingCardBrandingFooter className="text-neutral-400 border-neutral-100" />
      </div>
    </article>
  );
}
