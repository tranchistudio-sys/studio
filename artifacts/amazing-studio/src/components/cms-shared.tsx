import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { Upload, X, Image as ImageIcon, Loader2, GripVertical } from "lucide-react";
import { Button } from "@/components/ui";
import { getImageSrc } from "@/lib/imageUtils";
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
// MoveCategoryDialog — LỒNG / chuyển 1 DANH MỤC vào mục khác (đổi parentId thật).
// Dùng chung cho mọi cây danh mục CMS (Ảnh sản phẩm, Cho thuê đồ, Ý tưởng chụp ảnh).
// Album/sản phẩm/ý tưởng + mục con đi theo (vì nối qua category_id/parent_id),
// KHÔNG bị lạc như nút "Chuyển danh mục" (vốn chỉ dời ITEM). Tự loại chính nó +
// mọi mục con khỏi danh sách đích → chống vòng lặp.
// ═══════════════════════════════════════════════════════════════════════════
export type MovableCat = { id: number; parentId: number | null; name: string; sortOrder?: number };

function descendantIdsOf(cats: MovableCat[], rootId: number): Set<number> {
  const ids = new Set<number>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of cats) {
      if (c.parentId !== null && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); changed = true; }
    }
  }
  return ids;
}

export function MoveCategoryDialog({ cat, cats, busy, onConfirm, onClose }: {
  cat: MovableCat; cats: MovableCat[]; busy?: boolean;
  onConfirm: (parentId: number | null) => void; onClose: () => void;
}) {
  const [target, setTarget] = useState<string>(cat.parentId == null ? "" : String(cat.parentId));
  // Loại CHÍNH NÓ + mọi mục con → không cho làm con của chính mình (chống vòng lặp).
  const excluded = useMemo(() => descendantIdsOf(cats, cat.id), [cats, cat.id]);
  const options = useMemo(() => {
    const out: { id: number; label: string }[] = [];
    const walk = (parentId: number | null, depth: number) => {
      cats.filter(c => c.parentId === parentId)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .forEach(c => {
          if (excluded.has(c.id)) return;
          out.push({ id: c.id, label: `${"— ".repeat(depth)}${c.name}` });
          walk(c.id, depth + 1);
        });
    };
    walk(null, 0);
    return out;
  }, [cats, excluded]);

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-2xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h3 className="font-semibold truncate">Chuyển "{cat.name}" vào mục…</h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-muted-foreground">
            Mọi thứ bên trong "{cat.name}" (mục con + album/sản phẩm/ý tưởng) sẽ đi theo — KHÔNG làm lạc.
          </p>
          <div>
            <label className="text-sm font-medium">Chuyển vào</label>
            <select
              value={target}
              onChange={e => setTarget(e.target.value)}
              className="w-full mt-1 px-3 py-2 text-sm border border-input rounded-md bg-background"
            >
              <option value="">— Đưa ra ngoài cùng (mục gốc) —</option>
              {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div className="px-5 py-4 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Huỷ</Button>
          <Button onClick={() => onConfirm(target === "" ? null : Number(target))} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Chuyển"}
          </Button>
        </div>
      </div>
    </div>
  );
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
  src, alt = "", className = "", placeholder,
}: { src: string | null | undefined; alt?: string; className?: string; placeholder?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const finalSrc = getImageSrc(src);
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
