import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { Upload, X, Image as ImageIcon, Loader2, GripVertical } from "lucide-react";
import { getImageSrc, getCmsImageSrc } from "@/lib/imageUtils";
import { API_BASE } from "@/lib/api-base";

import { uploadQueueStore } from "@/lib/upload-queue/store";
import { convertToWebP, uploadFileViaPresign, type UploadedImage } from "@/lib/image-upload";
export type { UploadedImage } from "@/lib/image-upload";
export { convertToWebP, uploadFileViaPresign } from "@/lib/image-upload";
import type { UploadAttachTarget } from "@/lib/upload-queue/types";
function authHeaders(): HeadersInit {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

// ═══════════════════════════════════════════════════════════════════════════
// MultiImageUploader: drag-drop vùng, paste clipboard, chọn nhiều file,
// auto WebP + resize, hiển thị progress từng ảnh.
// ═══════════════════════════════════════════════════════════════════════════

export function MultiImageUploader({
  onUploaded, multiple = true, label = "Kéo thả ảnh, dán (Ctrl+V) hoặc bấm để chọn",
  useQueue = true, attach, onJobsQueued,
}: {
  onUploaded: (imgs: UploadedImage[]) => void;
  multiple?: boolean;
  label?: string;
  /** Upload nền qua global queue (mặc định bật). */
  useQueue?: boolean;
  attach?: UploadAttachTarget;
  onJobsQueued?: (jobIds: string[]) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [queue, setQueue] = useState<Array<{ key: string; name: string; progress: number; error?: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const list = multiple ? files : files.slice(0, 1);

    if (useQueue) {
      const ids: string[] = [];
      for (const f of list) {
        const id = await uploadQueueStore.enqueue(f, attach);
        ids.push(id);
        const name = f.name || "ảnh dán";
        setQueue(q => [...q, { key: id, name, progress: 0 }]);
        const unsub = uploadQueueStore.subscribe((jobs) => {
          const j = jobs.find(x => x.id === id);
          if (!j) return;
          if (j.status === "uploading" || j.status === "pending") {
            setQueue(q => q.map(x => x.key === id ? { ...x, progress: Math.max(j.progress || 5, x.progress) } : x));
          } else if (j.status === "uploaded" && j.objectPath) {
            setQueue(q => q.map(x => x.key === id ? { ...x, progress: 100 } : x));
            // Luôn báo về form — kể cả sản phẩm mới chưa có dressId
            // (trước đây chỉ gọi khi có dressId nên ảnh album sản phẩm mới "biến mất")
            onUploaded([{ objectPath: j.objectPath, mimeType: j.mimeType ?? "image/webp", name: j.fileName }]);
            unsub();
            setTimeout(() => setQueue(q => q.filter(x => x.key !== id)), 1500);
          } else if (j.status === "failed") {
            setQueue(q => q.map(x => x.key === id ? { ...x, error: j.error ?? "Lỗi upload" } : x));
            unsub();
            setTimeout(() => setQueue(q => q.filter(x => x.key !== id)), 8000);
          }
        });
      }
      onJobsQueued?.(ids);
      return;
    }

    const baseKey = `direct-${Date.now()}`;
    setQueue(list.map((f, i) => ({ key: `${baseKey}-${i}`, name: f.name || "ảnh dán", progress: 0 })));
    const results: UploadedImage[] = [];
    for (let i = 0; i < list.length; i++) {
      const key = `${baseKey}-${i}`;
      try {
        setQueue(q => q.map(x => x.key === key ? { ...x, progress: 10 } : x));
        const { blob, mimeType } = await convertToWebP(list[i]);
        setQueue(q => q.map(x => x.key === key ? { ...x, progress: 50 } : x));
        const outName = (list[i].name || "image").replace(/\.[^.]+$/, "") + ".webp";
        const path = await uploadFileViaPresign(blob, outName, mimeType);
        setQueue(q => q.map(x => x.key === key ? { ...x, progress: 100 } : x));
        results.push({ objectPath: path, mimeType, name: outName });
      } catch (err) {
        setQueue(q => q.map(x => x.key === key ? { ...x, error: String(err).replace(/^Error:\s*/, "") } : x));
      }
    }
    if (results.length) onUploaded(results);
    // Giữ lại dòng lỗi 8s để người dùng đọc được; dòng thành công tự xoá sau 1.2s
    setTimeout(() => setQueue(q => q.filter(x => !x.key.startsWith(baseKey) || x.error)), 1200);
    setTimeout(() => setQueue(q => q.filter(x => !x.key.startsWith(baseKey))), 8000);
  }, [multiple, onUploaded, useQueue, attach, onJobsQueued]);

  // Paste from clipboard — bind to document level whenever component is mounted
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        handleFiles(files);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [handleFiles]);

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={e => {
          e.preventDefault(); setIsDragging(false);
          const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
          handleFiles(files);
        }}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
          isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"
        }`}
      >
        <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-1">Tự động chuyển WebP & nén ≤ 1600px • Hỗ trợ chọn nhiều ảnh</p>
        <input
          ref={inputRef} type="file" accept="image/*" multiple={multiple} className="hidden"
          onChange={e => {
            const files = Array.from(e.target.files ?? []);
            handleFiles(files);
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
      </div>
      {queue.length > 0 && (
        <div className="mt-2 space-y-1">
          {queue.map((q) => (
            <div key={q.key} className="flex items-center gap-2 text-xs">
              {q.error ? (
                <span className="text-destructive flex-1 truncate">❌ {q.name} — {q.error}</span>
              ) : (
                <>
                  <Loader2 className={`w-3 h-3 ${q.progress < 100 ? "animate-spin" : ""} text-primary`} />
                  <span className="flex-1 truncate text-muted-foreground">{q.name}</span>
                  <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary transition-all" style={{ width: `${q.progress}%` }} />
                  </div>
                  <span className="text-muted-foreground tabular-nums w-9 text-right">{q.progress}%</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LazyImage — IntersectionObserver, hiển thị skeleton khi tải
// ═══════════════════════════════════════════════════════════════════════════
export function LazyImage({
  src, alt = "", className = "", placeholder, cmsCache = false,
}: { src: string | null | undefined; alt?: string; className?: string; placeholder?: ReactNode; cmsCache?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // cmsCache: ảnh public website → route cache dài hạn (xem getCmsImageSrc)
  const finalSrc = cmsCache ? getCmsImageSrc(src) : getImageSrc(src);
  useEffect(() => {
    if (!ref.current || visible) return;
    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) setVisible(true); });
    }, { rootMargin: "200px" });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [visible]);
  return (
    <div ref={ref} className={`relative bg-muted ${className}`}>
      {visible && finalSrc ? (
        <img
          src={finalSrc} alt={alt} loading="lazy" decoding="async"
          onLoad={() => setLoaded(true)}
          className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      ) : null}
      {(!visible || !loaded) && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          {placeholder ?? <ImageIcon className="w-6 h-6 opacity-30" />}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SortableList — HTML5 native drag-drop, gọi onReorder(orderedIds)
// ═══════════════════════════════════════════════════════════════════════════
export function SortableList<T extends { id: number }>({
  items, onReorder, renderItem, className = "",
}: {
  items: T[];
  onReorder: (orderedIds: number[]) => void;
  renderItem: (it: T, dragHandleProps: { className: string; onMouseDown?: () => void }) => ReactNode;
  className?: string;
}) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);

  return (
    <div className={className}>
      {items.map(it => {
        const isOver = overId === it.id && dragId !== it.id;
        return (
          <div
            key={it.id}
            draggable
            onDragStart={e => {
              setDragId(it.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(it.id));
            }}
            onDragOver={e => { e.preventDefault(); setOverId(it.id); e.dataTransfer.dropEffect = "move"; }}
            onDragLeave={() => setOverId(c => c === it.id ? null : c)}
            onDrop={e => {
              e.preventDefault();
              const from = items.findIndex(x => x.id === dragId);
              const to = items.findIndex(x => x.id === it.id);
              if (from < 0 || to < 0 || from === to) { setDragId(null); setOverId(null); return; }
              const next = items.slice();
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              onReorder(next.map(n => n.id));
              setDragId(null); setOverId(null);
            }}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
            className={`transition-all ${dragId === it.id ? "opacity-40" : ""} ${isOver ? "ring-2 ring-primary rounded-lg" : ""}`}
          >
            {renderItem(it, { className: "cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground" })}
          </div>
        );
      })}
    </div>
  );
}

export { authHeaders };
export const CMS_BASE = API_BASE;
export { GripVertical, X };
