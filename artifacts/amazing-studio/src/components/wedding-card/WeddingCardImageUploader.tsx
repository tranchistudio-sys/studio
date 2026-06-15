import { useRef } from "react";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import { getImageSrc } from "@/lib/imageUtils";
import { cn } from "@/lib/utils";

type Slot = "cover" | "couple" | "extra";

export function WeddingCardImageUploader({
  label,
  hint,
  slot,
  imageUrl,
  uploading,
  onPick,
  onClear,
  tall,
}: {
  label: string;
  hint?: string;
  slot: Slot;
  imageUrl: string | null;
  uploading: boolean;
  onPick: (file: File) => void;
  onClear?: () => void;
  tall?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const src = getImageSrc(imageUrl);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "w-full rounded-xl border-2 border-dashed transition-colors text-left overflow-hidden",
          "border-rose-200/80 bg-rose-50/40 hover:border-rose-300 hover:bg-rose-50/70",
          "active:scale-[0.99] disabled:opacity-60",
          tall ? "aspect-[3/4] max-h-48" : "aspect-[4/3] max-h-36",
          src && "border-solid border-neutral-200 p-0",
        )}
      >
        {uploading ? (
          <span className="flex h-full min-h-[120px] items-center justify-center gap-2 text-sm text-neutral-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            Đang tải ảnh…
          </span>
        ) : src ? (
          <span className="relative block h-full w-full min-h-[120px]">
            <img src={src} alt="" className="h-full w-full object-cover" />
            <span className="absolute inset-0 bg-black/20 flex items-end justify-center pb-2">
              <span className="text-xs text-white font-medium bg-black/50 px-3 py-1 rounded-full">
                Đổi ảnh
              </span>
            </span>
          </span>
        ) : (
          <span className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-4 py-6">
            {slot === "cover" ? (
              <ImagePlus className="h-8 w-8 text-rose-400/80" />
            ) : (
              <Camera className="h-8 w-8 text-rose-400/80" />
            )}
            <span className="text-sm font-semibold text-neutral-800">{label}</span>
            {hint && <span className="text-xs text-neutral-500 text-center">{hint}</span>}
            <span className="text-[10px] uppercase tracking-wider text-rose-500/90 mt-1">
              Chạm để chọn ảnh
            </span>
          </span>
        )}
      </button>
      {src && onClear && !uploading && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="absolute top-2 right-2 rounded-full bg-black/55 p-1.5 text-white hover:bg-black/70"
          aria-label="Xóa ảnh"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
