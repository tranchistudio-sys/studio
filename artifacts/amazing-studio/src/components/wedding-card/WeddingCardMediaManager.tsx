import { useRef } from "react";
import { ArrowDown, ArrowUp, Check, ImagePlus, RefreshCw, Repeat2, Trash2 } from "lucide-react";
import { getImageSrc } from "@/lib/imageUtils";
import type { WeddingMediaItem, WeddingMediaRole } from "@/lib/wedding-card-media";

const roleLabel: Record<WeddingMediaRole, string> = { cover1: "BÌA 1", cover2: "BÌA 2", album: "ALBUM" };
const statusLabel: Record<WeddingMediaItem["status"], string> = { processing: "Đang xử lý", uploading: "Đang tải lên", complete: "Hoàn tất", failed: "Thất bại" };

export function WeddingCardMediaManager({ items, onPick, onRole, onSwap, onRemove, onRetry, onMove }: {
  items: WeddingMediaItem[];
  onPick: (files: File[]) => void;
  onRole: (id: string, role: WeddingMediaRole) => void;
  onSwap: () => void;
  onRemove: (id: string) => void;
  onRetry: (id: string, file?: File) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}) {
  const replacementInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const complete = items.filter((item) => item.status === "complete").length;
  const totalProgress = items.length ? Math.round(items.reduce((sum, item) => sum + item.progress, 0) / items.length) : 0;
  return <section className="rounded-xl bg-white border border-[var(--wc-bt-border,#e8e0d8)] p-4 space-y-4">
    <div>
      <p className="text-sm font-semibold text-[var(--wc-bt-text)]">Ảnh cưới của bạn</p>
      <p className="text-xs text-[var(--wc-bt-muted)] mt-1">Chọn tối đa 30 ảnh cùng lúc. Sau khi tải lên, bạn có thể chọn ảnh bìa và sắp xếp album.</p>
    </div>
    <label className="wc-media-upload-button wc-bt-btn w-full cursor-pointer focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-[#8f3f55]">
      <ImagePlus className="h-4 w-4" /> Tải nhiều ảnh
      <input className="sr-only" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onChange={(e) => { onPick(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ""; }} />
    </label>
    <div className="flex items-center justify-between text-xs text-[var(--wc-bt-muted)]">
      <span>{items.length}/30 ảnh · {complete} hoàn tất</span><span>{totalProgress}%</span>
    </div>
    {items.length > 0 && <div className="h-2 overflow-hidden rounded-full bg-neutral-200" aria-label={`Tiến trình tải ảnh ${totalProgress}%`}><div className="h-full bg-[#8f3f55] transition-all" style={{ width: `${totalProgress}%` }} /></div>}
    {items.length > 1 && <button type="button" onClick={onSwap} className="wc-bt-btn wc-bt-btn-outline w-full"><Repeat2 className="h-4 w-4" />Đổi vị trí hai ảnh bìa</button>}
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {items.map((item, index) => <article key={item.id} className="relative overflow-hidden rounded-xl border border-[var(--wc-bt-border)] bg-white">
        <div className="relative aspect-[4/5] bg-neutral-100">
          <img
            src={getImageSrc(item.previewUrl) ?? item.previewUrl}
            alt={item.name}
            className="h-full w-full object-cover"
            onError={() => {
              // A display error must never start another upload automatically.
              if (!item.file) onRemove(item.id);
            }}
          />
          {item.status === "failed" && <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 px-3 text-center text-xs font-medium text-red-700">Ảnh đã mất<br />Vui lòng chọn lại</div>}
        </div>
        <span className="absolute left-2 top-2 rounded-full bg-black/75 px-2 py-1 text-[10px] font-bold text-white">{roleLabel[item.role]}</span>
        <div className="p-2 space-y-2">
          <p className="truncate text-[11px]" title={item.name}>{item.name}</p>
          <p className={`flex items-center gap-1 text-[10px] ${item.status === "failed" ? "text-red-700" : "text-neutral-600"}`}>{item.status === "complete" && <Check className="h-3 w-3" />}{statusLabel[item.status]}{item.status === "uploading" ? ` ${item.progress}%` : ""}</p>
          {item.status === "failed" && <>
            <input ref={(node) => { replacementInputs.current[item.id] = node; }} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" className="sr-only" onChange={(e) => { const file = e.currentTarget.files?.[0]; if (file) onRetry(item.id, file); e.currentTarget.value = ""; }} />
            <button type="button" onClick={() => replacementInputs.current[item.id]?.click()} className="wc-bt-btn wc-bt-btn-outline w-full py-1 text-[11px]"><RefreshCw className="h-3 w-3" />Chọn lại ảnh</button>
          </>}
          {item.status === "complete" && <select aria-label={`Vai trò của ${item.name}`} className="wc-bt-input py-1 text-[11px]" value={item.role} onChange={(e) => onRole(item.id, e.target.value as WeddingMediaRole)}><option value="cover1">Đặt làm ảnh bìa 1</option><option value="cover2">Đặt làm ảnh bìa 2</option><option value="album">Đưa vào album</option></select>}
          <div className="flex gap-1">
            {item.role === "album" && <><button type="button" aria-label="Di chuyển lên" disabled={index === 0} onClick={() => onMove(item.id, -1)} className="wc-bt-icon-button"><ArrowUp className="h-3.5 w-3.5" /></button><button type="button" aria-label="Di chuyển xuống" disabled={index === items.length - 1} onClick={() => onMove(item.id, 1)} className="wc-bt-icon-button"><ArrowDown className="h-3.5 w-3.5" /></button></>}
            <button type="button" aria-label={`Xóa ${item.name}`} onClick={() => onRemove(item.id)} className="wc-bt-icon-button ml-auto text-red-700"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      </article>)}
    </div>
  </section>;
}
