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
};

export function CmsImageField({
  label,
  hint,
  value,
  onChange,
  aspect = "video",
  placeholderSrc,
  useBackgroundUpload = true,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        className={cn(
          "relative rounded-2xl overflow-hidden border border-border/80 bg-[#faf8f5]",
          aspectClass,
        )}
      >
        {src ? (
          <img src={src} alt="" className="w-full h-full object-cover" />
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
