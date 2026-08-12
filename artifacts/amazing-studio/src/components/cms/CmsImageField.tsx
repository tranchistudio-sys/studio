import { useRef, useState } from "react";
import { ImageIcon, Loader2, Upload, X } from "lucide-react";
import { getImageSrc } from "@/lib/imageUtils";
import { convertToWebP, uploadFileViaPresign } from "@/components/cms-shared";
import { uploadQueueStore } from "@/lib/upload-queue/store";
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  hint?: string;
  value: string | null;
  onChange: (path: string | null) => void;
  aspect?: "video" | "square" | "portrait";
  placeholderSrc?: string;
  /** Upload nền qua global queue (mặc định bật). */
  useBackgroundUpload?: boolean;
  objectFit?: "cover" | "contain";
  objectPosition?: string;
  zoom?: number;
  positionX?: number;
  positionY?: number;
  onPositionChange?: (x: number, y: number) => void;
};

export function CmsImageField({
  label,
  hint,
  value,
  onChange,
  aspect = "video",
  placeholderSrc,
  useBackgroundUpload = true,
  objectFit = "cover",
  objectPosition = "50% 50%",
  zoom = 100,
  positionX = 50,
  positionY = 50,
  onPositionChange,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const src = getImageSrc(value) ?? placeholderSrc ?? null;

  const aspectClass =
    aspect === "portrait"
      ? "aspect-[3/4]"
      : aspect === "square"
        ? "aspect-square"
        : "aspect-video";

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      if (useBackgroundUpload) {
        const id = await uploadQueueStore.enqueue(file);
        const unsub = uploadQueueStore.subscribe((jobs) => {
          const j = jobs.find(x => x.id === id);
          if (!j) return;
          if (j.status === "uploaded" && j.objectPath) {
            onChange(j.objectPath);
            setUploading(false);
            unsub();
          }
          if (j.status === "failed") {
            setError(j.error ?? "Upload thất bại");
            setUploading(false);
            unsub();
          }
        });
        return;
      }
      const { blob, mimeType } = await convertToWebP(file);
      const name = file.name.replace(/\.[^.]+$/, "") + ".webp";
      const path = await uploadFileViaPresign(blob, name, mimeType);
      onChange(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload thất bại");
    } finally {
      if (!useBackgroundUpload) setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
        </div>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1"
          >
            <X className="w-3.5 h-3.5" />
            Xóa ảnh
          </button>
        )}
      </div>
      <div
        onPointerDown={(e) => {
          if (!onPositionChange || !src) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { clientX: e.clientX, clientY: e.clientY, x: positionX, y: positionY };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const start = dragRef.current;
          if (!start || !onPositionChange) return;
          const rect = e.currentTarget.getBoundingClientRect();
          e.preventDefault();
          const clamp = (value: number) => Math.max(0, Math.min(100, Number(value.toFixed(1))));
          onPositionChange(
            clamp(start.x - ((e.clientX - start.clientX) / rect.width) * 100),
            clamp(start.y - ((e.clientY - start.clientY) / rect.height) * 100),
          );
        }}
        onPointerUp={(e) => {
          if (dragRef.current) e.currentTarget.releasePointerCapture(e.pointerId);
          dragRef.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        className={cn(
          "relative rounded-2xl overflow-hidden border border-border/80 bg-[#faf8f5]",
          onPositionChange && src && "touch-none select-none cursor-grab active:cursor-grabbing",
          aspectClass,
        )}
      >
        {src ? (
          <img
            draggable={false}
            src={src}
            alt=""
            style={{
              objectPosition,
              transform: `translate3d(${(50 - positionX) / 2}%, ${(50 - positionY) / 2}%, 0) scale(${zoom / 100})`,
            }}
            className={cn("pointer-events-none w-full h-full", !dragging && "transition-transform", objectFit === "contain" ? "object-contain bg-neutral-100" : "object-cover")}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-2">
            <ImageIcon className="w-8 h-8 opacity-30" />
            <span className="text-xs">Chưa có ảnh</span>
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-white animate-spin" />
          </div>
        )}
        {onPositionChange && src && !uploading && (
          <>
            <div className={cn("pointer-events-none absolute inset-0 transition-opacity", dragging ? "opacity-100" : "opacity-0")} aria-hidden>
              <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/70 shadow" />
              <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-white/70 shadow" />
              <span className="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" />
            </div>
            <span className={cn("pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/65 px-3 py-1 text-[11px] font-medium text-white transition-opacity", dragging ? "opacity-100" : "opacity-80")}>
              {dragging ? "Đưa khuôn mặt vào vòng tròn giữa" : "Giữ chuột và kéo ảnh"}
            </span>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium hover:bg-muted/60 transition-colors disabled:opacity-50"
      >
        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
        {value ? "Đổi ảnh" : "Upload ảnh"}
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
