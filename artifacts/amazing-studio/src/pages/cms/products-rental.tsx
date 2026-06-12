import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Search, X, Eye, EyeOff, QrCode, Shirt, Loader2,
  Image as ImageIcon, Save, Trash2, ChevronDown, ChevronRight, Download, Printer,
  Check, AlertCircle, Upload, Copy, Link2, FolderInput, CheckSquare, Square, Tag,
} from "lucide-react";
import QRCode from "qrcode";
import { Button, Input } from "@/components/ui";
import { CurrencyInput } from "@/components/ui/currency-input";
import {
  authHeaders, CMS_BASE, LazyImage, MultiImageUploader,
  convertToWebP, uploadFileViaPresign, type UploadedImage,
} from "@/components/cms-shared";
import { getImageSrc } from "@/lib/imageUtils";
import { formatVND } from "@/lib/utils";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { OUTFIT_TAGS, OutfitTagBadge, type OutfitTagKey } from "@/lib/outfit-tags";
import { ChipSuggest, useCommonTags, DRESS_TAG_KEY, DRESS_TAG_DEFAULTS } from "@/components/cms-tag-input";
import { uploadQueueStore } from "@/lib/upload-queue/store";
import { useToast } from "@/hooks/use-toast";

function stripDiacriticsLower(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}
const OUTFIT_LABEL_TO_KEY_CMS: Array<[string, OutfitTagKey]> = [
  ["hang moi 100", "HANG_MOI_100"],
  ["gia sieu tiet kiem", "GIA_SIEU_TIET_KIEM"],
  ["gia tiet kiem", "GIA_TIET_KIEM"],
  ["vay nuoc 1", "VAY_NUOC_1"], ["vay nuoc 2", "VAY_NUOC_2"],
  ["vay nuoc 3", "VAY_NUOC_3"], ["vay nuoc 4", "VAY_NUOC_4"],
  ["form dep", "FORM_DEP"], ["hot pick", "HOT_PICK"],
  ["sieu moi", "SIEU_MOI"], ["hang moi", "HANG_MOI"],
];
function matchOutfitKeysFromQuery(q: string): Set<OutfitTagKey> {
  const n = stripDiacriticsLower(q);
  const out = new Set<OutfitTagKey>();
  for (const t of OUTFIT_TAGS) if (n.includes(t.key.toLowerCase())) out.add(t.key);
  for (const [label, key] of OUTFIT_LABEL_TO_KEY_CMS) if (n.includes(label)) out.add(key);
  return out;
}

// ─── Types ─────────────────────────────────────────────────────────────────
interface Dress {
  id: number; code: string; name: string;
  category: string; categoryId: number | null;
  color: string; size: string; style: string | null;
  rentalPrice: number; depositRequired: number; sellPrice: number;
  isAvailable: boolean; rentalStatus: string; condition: string;
  outfitTag: string | null;
  notes: string | null; description: string | null;
  imageUrl: string | null; publicImageUrl: string | null;
  extraImages: string[]; isPublic: number; cmsStatus: string;
  sizeText: string | null; colorText: string | null;
  tagsText: string | null; materialText: string | null;
  slug: string | null;
  createdAt: string;
}
interface Category { id: number; parentId: number | null; name: string; type: string; isActive: number; }

// ─── Constants ─────────────────────────────────────────────────────────────
const RENTAL_STATUS: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  san_sang:       { label: "Có sẵn",    color: "text-emerald-700", bg: "bg-emerald-100", dot: "bg-emerald-500" },
  dang_cho_thue:  { label: "Đang thuê", color: "text-orange-700",  bg: "bg-orange-100",  dot: "bg-orange-500"  },
  giu_do:         { label: "Giữ đồ",   color: "text-yellow-700",  bg: "bg-yellow-100",  dot: "bg-yellow-500"  },
  ngung_cho_thue: { label: "Ngưng thuê",color: "text-slate-600",   bg: "bg-slate-100",   dot: "bg-slate-400"   },
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function coverOf(d: Dress): string | null {
  return d.publicImageUrl || d.imageUrl || d.extraImages?.[0] || null;
}
function allImagesOf(d: Dress): string[] {
  const imgs: string[] = [];
  if (d.publicImageUrl) imgs.push(d.publicImageUrl);
  if (d.imageUrl && d.imageUrl !== d.publicImageUrl) imgs.push(d.imageUrl);
  for (const x of (d.extraImages || [])) { if (x && !imgs.includes(x)) imgs.push(x); }
  return imgs;
}
function flattenCategories(cats: Category[], parentId: number | null = null, depth = 0): Array<{ cat: Category; depth: number }> {
  const children = cats.filter(c => c.parentId === parentId && c.type === "dress");
  const result: Array<{ cat: Category; depth: number }> = [];
  for (const c of children) { result.push({ cat: c, depth }); result.push(...flattenCategories(cats, c.id, depth + 1)); }
  return result;
}
function emptyForm(): Omit<Dress, "id" | "createdAt"> {
  return {
    code: "", name: "", category: "", categoryId: null,
    color: "", size: "", style: null,
    rentalPrice: 0, depositRequired: 0, sellPrice: 0,
    isAvailable: true, rentalStatus: "san_sang", condition: "tot",
    outfitTag: null,
    notes: null, description: null, imageUrl: null, publicImageUrl: null,
    extraImages: [], isPublic: 0, cmsStatus: "draft",
    sizeText: null, colorText: null, tagsText: null, materialText: null, slug: null,
  };
}

// ─── Toggle mutation ─────────────────────────────────────────────────────────
function useTogglePublic(qc: ReturnType<typeof useQueryClient>) {
  return useMutation({
    mutationFn: async ({ id, isPublic, cmsStatus }: { id: number; isPublic: number; cmsStatus: string }) => {
      const r = await fetch(`${CMS_BASE}/api/dresses/${id}`, {
        method: "PUT", headers: authHeaders(), body: JSON.stringify({ isPublic, cmsStatus }),
      });
      if (!r.ok) throw new Error("Lỗi");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cms-products"] }),
  });
}

// ─── Product Card ───────────────────────────────────────────────────────────
function ProductCard({
  dress, onSelect, onTogglePublic, toggling,
  selectMode, isSelected, onToggleSelect, onLongPressStart,
}: {
  dress: Dress; onSelect: () => void; onTogglePublic: (d: Dress) => void; toggling: boolean;
  selectMode: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onLongPressStart: () => void;
}) {
  const cover = coverOf(dress);
  const status = RENTAL_STATUS[dress.rentalStatus] ?? RENTAL_STATUS.san_sang;
  const isVisible = dress.isPublic === 1 && dress.cmsStatus === "visible";
  const displaySize = dress.sizeText || dress.size;
  const displayColor = dress.colorText || dress.color;

  // Long-press: 400ms to enter select-mode (mobile)
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpFired = useRef(false);
  function startLP() {
    lpFired.current = false;
    lpTimer.current = setTimeout(() => {
      lpFired.current = true;
      onLongPressStart();
    }, 400);
  }
  function cancelLP() {
    if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; }
  }

  function handleClick() {
    if (lpFired.current) { lpFired.current = false; return; }
    if (selectMode) onToggleSelect();
    else onSelect();
  }

  return (
    <div
      className={`group relative rounded-xl overflow-hidden bg-muted border cursor-pointer transition-all select-none ${
        isSelected
          ? "border-primary ring-2 ring-primary shadow-md"
          : "border-border hover:shadow-md hover:border-primary/40"
      }`}
      onClick={handleClick}
      onPointerDown={startLP}
      onPointerUp={cancelLP}
      onPointerLeave={cancelLP}
      onPointerCancel={cancelLP}
      onContextMenu={e => { e.preventDefault(); onLongPressStart(); }}
    >
      <div className="aspect-[3/4] relative">
        <LazyImage src={cover} className="absolute inset-0 w-full h-full" />
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

        {/* Selection checkbox — visible always when selectMode hoặc khi card được tick */}
        <button
          onClick={e => { e.stopPropagation(); onToggleSelect(); }}
          className={`absolute top-2 left-2 z-10 w-7 h-7 rounded-md flex items-center justify-center transition-all ${
            isSelected
              ? "bg-primary text-primary-foreground shadow"
              : selectMode
                ? "bg-white/90 text-foreground border border-foreground/30"
                : "bg-white/85 text-foreground/70 opacity-0 group-hover:opacity-100 md:opacity-100 border border-white"
          }`}
          aria-label={isSelected ? "Bỏ chọn" : "Chọn sản phẩm"}
        >
          {isSelected ? <Check className="w-4 h-4" /> : <Square className="w-4 h-4" strokeWidth={2} />}
        </button>

        <div className={`absolute top-2 ${isSelected || selectMode ? "left-11" : "left-11"} flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${status.bg} ${status.color}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </div>
        <button
          onClick={e => { e.stopPropagation(); onTogglePublic(dress); }}
          disabled={toggling}
          className={`absolute top-2 right-2 p-1.5 rounded-full transition-all ${
            isVisible ? "bg-white/90 text-emerald-600" : "bg-black/40 text-white/60 hover:bg-black/60"
          }`}
          title={isVisible ? "Đang hiển thị" : "Đang ẩn"}
        >
          {toggling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </button>
        <div className="absolute inset-x-0 bottom-0 p-2.5 text-white">
          <p className="font-semibold text-sm leading-tight line-clamp-2">{dress.name}</p>
          <div className="flex items-center justify-between mt-1">
            <span className="text-xs text-white/70 font-mono">{dress.code}</span>
            <span className="text-xs font-medium">{dress.rentalPrice > 0 ? formatVND(dress.rentalPrice) : ""}</span>
          </div>
        </div>
      </div>
      {(displayColor || displaySize) && (
        <div className="px-2 py-1.5 flex items-center gap-1 flex-wrap">
          {displayColor && <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full text-muted-foreground truncate max-w-[80px]">{displayColor}</span>}
          {displaySize && <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full text-muted-foreground truncate max-w-[80px]">{displaySize}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Category Tree Picker (popup) ────────────────────────────────────────────
function CategoryTreePicker({
  categories, value, onChange,
}: {
  categories: Category[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const tree = useMemo(() => flattenCategories(categories), [categories]);
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    // Expand all by default for small trees
    return new Set(categories.map(c => c.id));
  });
  const childMap = useMemo(() => {
    const m = new Map<number | null, number>();
    for (const c of categories) {
      const k = c.parentId;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [categories]);

  function isVisible(catId: number, parentId: number | null): boolean {
    if (parentId === null) return true;
    if (!expanded.has(parentId)) return false;
    const parent = categories.find(c => c.id === parentId);
    if (!parent) return true;
    return isVisible(parent.id, parent.parentId);
  }

  function toggle(id: number) {
    setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div className="border rounded-lg max-h-[50vh] overflow-y-auto bg-background">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-sm border-b text-left hover:bg-muted ${
          value === null ? "bg-primary/10 text-primary font-medium" : ""
        }`}
      >
        <span className="w-4" />
        <Tag className="w-3.5 h-3.5 text-muted-foreground" />
        Không gắn danh mục
        {value === null && <Check className="w-4 h-4 ml-auto" />}
      </button>
      {tree.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-6">Chưa có danh mục</div>
      ) : tree.map(({ cat, depth }) => {
        if (!isVisible(cat.id, cat.parentId)) return null;
        const hasChildren = (childMap.get(cat.id) ?? 0) > 0;
        const isOpen = expanded.has(cat.id);
        const selected = value === cat.id;
        return (
          <div
            key={cat.id}
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
            className={`flex items-center gap-1 text-sm border-b last:border-b-0 hover:bg-muted/70 ${
              selected ? "bg-primary/10" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => hasChildren && toggle(cat.id)}
              className="w-6 h-8 flex items-center justify-center flex-shrink-0 text-muted-foreground"
            >
              {hasChildren
                ? (isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)
                : <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />}
            </button>
            <button
              type="button"
              onClick={() => onChange(cat.id)}
              className={`flex-1 text-left py-2 truncate ${selected ? "font-semibold text-primary" : ""}`}
            >
              {cat.name}
            </button>
            {selected && <Check className="w-4 h-4 text-primary mr-2 flex-shrink-0" />}
          </div>
        );
      })}
    </div>
  );
}

// ─── Bulk mutations ─────────────────────────────────────────────────────────
function useBulkMutations(qc: ReturnType<typeof useQueryClient>) {
  const move = useMutation({
    mutationFn: async ({ ids, categoryId }: { ids: number[]; categoryId: number | null }) => {
      const uniqueIds = [...new Set(ids)];
      const r = await fetch(`${CMS_BASE}/api/cms/dresses/bulk-category`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ ids: uniqueIds, categoryId }),
      });
      const json = await r.json().catch(() => ({})) as { error?: string; affected?: number };
      if (!r.ok) throw new Error(json.error ?? "Lỗi chuyển danh mục");
      if (!json.affected || json.affected < 1) throw new Error(`Không chuyển được sản phẩm nào (0/${uniqueIds.length})`);
      return json as { affected: number };
    },
    onSuccess: async () => {
      await qc.refetchQueries({ queryKey: ["cms-products"] });
      await qc.refetchQueries({ queryKey: ["cms-categories"] });
    },
  });
  const status = useMutation({
    mutationFn: async ({ ids, rentalStatus }: { ids: number[]; rentalStatus: string }) => {
      const r = await fetch(`${CMS_BASE}/api/cms/dresses/bulk-status`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ ids: [...new Set(ids)], rentalStatus }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Lỗi đổi trạng thái");
      return r.json() as Promise<{ affected: number }>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cms-products"] }),
  });
  const remove = useMutation({
    mutationFn: async ({ ids }: { ids: number[] }) => {
      const uniqueIds = [...new Set(ids)];
      let r = await fetch(`${CMS_BASE}/api/cms/dresses/bulk-delete`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ ids: uniqueIds }),
      });
      if (r.status === 404) {
        r = await fetch(`${CMS_BASE}/api/cms/dresses/bulk`, {
          method: "DELETE", headers: authHeaders(),
          body: JSON.stringify({ ids: uniqueIds }),
        });
      }
      const json = await r.json().catch(() => ({})) as { error?: string; affected?: number };
      if (!r.ok) throw new Error(json.error ?? "Lỗi xoá");
      if (!json.affected || json.affected < 1) throw new Error(`Không xóa được sản phẩm nào (0/${uniqueIds.length})`);
      return json as { affected: number };
    },
    onSuccess: async (_d, variables) => {
      qc.setQueryData<Dress[]>(["cms-products"], old => (old ?? []).filter(d => !variables.ids.includes(d.id)));
      await qc.refetchQueries({ queryKey: ["cms-products"] });
      await qc.refetchQueries({ queryKey: ["cms-categories"] });
    },
  });
  return { move, status, remove };
}

// ─── Drag-sort image grid (Tab 2) ────────────────────────────────────────────
function DragSortImageGrid({ images, onReorder, onSetCover, onRemove }: {
  images: string[];
  onReorder: (next: string[]) => void;
  onSetCover: (src: string) => void;
  onRemove: (src: string) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  if (images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-muted-foreground border-2 border-dashed rounded-xl">
        <ImageIcon className="w-10 h-10 mb-2 opacity-30" />
        <p className="text-sm">Chưa có ảnh — upload bên dưới</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {images.map((src, i) => (
        <div
          key={src}
          draggable
          onDragStart={() => setDragIdx(i)}
          onDragOver={e => { e.preventDefault(); setOverIdx(i); }}
          onDragLeave={() => setOverIdx(c => c === i ? null : c)}
          onDrop={e => {
            e.preventDefault();
            if (dragIdx === null || dragIdx === i) { setDragIdx(null); setOverIdx(null); return; }
            const next = [...images];
            const [moved] = next.splice(dragIdx, 1);
            next.splice(i, 0, moved);
            onReorder(next);
            setDragIdx(null); setOverIdx(null);
          }}
          onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
          className={`relative group cursor-grab active:cursor-grabbing aspect-[3/4] rounded-lg overflow-hidden bg-muted transition-all ${
            dragIdx === i ? "opacity-40 scale-95" : ""
          } ${overIdx === i && dragIdx !== i ? "ring-2 ring-primary ring-offset-1" : ""}`}
        >
          <img src={getImageSrc(src) ?? src} alt="" className="w-full h-full object-cover" />
          {i === 0 && (
            <span className="absolute top-1 left-1 bg-primary text-white text-[9px] px-1.5 py-0.5 rounded-full font-semibold pointer-events-none">
              ✦ Bìa
            </span>
          )}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-all">
            <div className="absolute top-1 right-1 hidden group-hover:flex flex-col gap-1">
              {i !== 0 && (
                <button
                  onClick={e => { e.stopPropagation(); onSetCover(src); }}
                  className="w-6 h-6 bg-primary/90 text-white rounded-full flex items-center justify-center text-[8px] font-bold"
                  title="Đặt làm ảnh bìa"
                >✦</button>
              )}
              <button
                onClick={e => { e.stopPropagation(); onRemove(src); }}
                className="w-6 h-6 bg-destructive/90 text-white rounded-full flex items-center justify-center"
                title="Xoá ảnh"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Bulk Upload Modal ────────────────────────────────────────────────────────
function BulkUploadModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  type Stage = "pick" | "preview" | "creating" | "done";
  const [stage, setStage] = useState<Stage>("pick");
  const [items, setItems] = useState<Array<{ file: File; previewUrl: string; name: string }>>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: File[]) {
    const imgs = files.filter(f => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const newItems = imgs.map((f, i) => ({
      file: f,
      previewUrl: URL.createObjectURL(f),
      name: `SP-${String(items.length + i + 1).padStart(3, "0")}`,
    }));
    setItems(prev => [...prev, ...newItems]);
    setStage("preview");
  }

  async function handleCreate() {
    if (!items.length) return;
    setStage("creating");
    setProgress({ done: 0, total: items.length });
    const errs: string[] = [];
    let created = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const { blob, mimeType } = await convertToWebP(item.file);
        const outName = (item.file.name || "image").replace(/\.[^.]+$/, "") + ".webp";
        const objectPath = await uploadFileViaPresign(blob, outName, mimeType);
        const postResp = await fetch(`${CMS_BASE}/api/dresses`, {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            name: item.name, code: item.name,
            publicImageUrl: objectPath, isPublic: 0, cmsStatus: "draft",
            rentalPrice: 0, depositRequired: 0,
          }),
        });
        if (!postResp.ok) {
          const j = await postResp.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error ?? `HTTP ${postResp.status}`);
        }
        created++;
      } catch (e) {
        errs.push(`${item.name}: ${String(e)}`);
      }
      setProgress({ done: i + 1, total: items.length });
    }
    setErrors(errs);
    setStage("done");
    items.forEach(it => URL.revokeObjectURL(it.previewUrl));
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-2xl shadow-xl w-full max-w-xl flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-base flex items-center gap-2">
            <Upload className="w-4 h-4 text-primary" /> Upload hàng loạt
          </h2>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {stage === "pick" && (
            <div>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); handleFiles(Array.from(e.dataTransfer.files)); }}
                className="border-2 border-dashed border-border rounded-xl p-10 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
              >
                <Upload className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
                <p className="font-medium">Kéo thả hoặc bấm để chọn nhiều ảnh</p>
                <p className="text-sm text-muted-foreground mt-1">Mỗi ảnh = 1 sản phẩm nháp. Tên tự động: SP-001, SP-002...</p>
              </div>
              <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
                onChange={e => { handleFiles(Array.from(e.target.files ?? [])); if (inputRef.current) inputRef.current.value = ""; }} />
            </div>
          )}

          {(stage === "preview") && (
            <div>
              <p className="text-sm text-muted-foreground mb-3">
                {items.length} ảnh được chọn. Bấm tên để đổi. Bấm "Tạo tất cả" để tiến hành.
              </p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-4">
                {items.map((it, i) => (
                  <div key={i} className="relative">
                    <img src={it.previewUrl} alt="" className="w-full aspect-[3/4] object-cover rounded-lg" />
                    <input
                      value={it.name}
                      onChange={e => setItems(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                      className="absolute bottom-0 inset-x-0 text-[10px] bg-black/60 text-white px-1 py-0.5 text-center rounded-b-lg"
                    />
                    <button
                      onClick={() => { URL.revokeObjectURL(it.previewUrl); setItems(prev => prev.filter((_, j) => j !== i)); }}
                      className="absolute top-1 right-1 w-5 h-5 bg-destructive/80 text-white rounded-full flex items-center justify-center"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => inputRef.current?.click()}
                className="text-sm text-primary hover:underline"
              >
                + Thêm ảnh khác
              </button>
              <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
                onChange={e => { handleFiles(Array.from(e.target.files ?? [])); if (inputRef.current) inputRef.current.value = ""; }} />
            </div>
          )}

          {stage === "creating" && (
            <div className="py-6">
              <div className="flex items-center justify-between text-sm mb-2">
                <span>Đang tạo sản phẩm...</span>
                <span className="font-medium">{progress.done} / {progress.total}</span>
              </div>
              <div className="w-full h-3 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {stage === "done" && (
            <div className="text-center py-6">
              <Check className="w-12 h-12 mx-auto mb-3 text-emerald-500" />
              <p className="font-semibold">Đã tạo {progress.total - errors.length} / {progress.total} sản phẩm</p>
              {errors.length > 0 && (
                <div className="mt-3 text-left text-xs text-destructive space-y-1">
                  {errors.map((e, i) => <p key={i}>{e}</p>)}
                </div>
              )}
              <p className="text-sm text-muted-foreground mt-2">Bấm vào từng sản phẩm để nhập tên, giá, size, màu...</p>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t flex gap-3">
          {stage === "done" ? (
            <Button className="flex-1" onClick={() => { onCreated(); onClose(); }}>Xong — về danh sách</Button>
          ) : stage === "preview" ? (
            <>
              <button onClick={onClose} className="flex-1 py-2.5 text-sm border border-border rounded-xl hover:bg-muted">Huỷ</button>
              <Button className="flex-1" onClick={handleCreate} disabled={!items.length}>
                Tạo {items.length} sản phẩm
              </Button>
            </>
          ) : stage === "creating" ? (
            <div className="flex-1 text-center text-sm text-muted-foreground">Đang xử lý...</div>
          ) : (
            <button onClick={onClose} className="flex-1 py-2.5 text-sm border border-border rounded-xl hover:bg-muted">Đóng</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Product Drawer ───────────────────────────────────────────────────────────
function ProductDrawer({ dress, categories, onClose, onSaved, onDeleted }: {
  dress: Dress | "new";
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { effectiveIsAdmin } = useStaffAuth();
  const { toast } = useToast();
  const isNew = dress === "new";
  type FormType = Omit<Dress, "id" | "createdAt">;
  const [form, setForm] = useState<FormType>(isNew ? emptyForm() : dress as Dress);
  const [activeTab, setActiveTab] = useState<0 | 1 | 2>(0);
  const [saving, setSaving] = useState(false);
  const [pendingJobIds, setPendingJobIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [publicLink, setPublicLink] = useState("");
  const [copied, setCopied] = useState(false);

  const set = useCallback(<K extends keyof FormType>(k: K, v: FormType[K]) => {
    setForm(f => ({ ...f, [k]: v }));
  }, []);
  const dressTags = useCommonTags(DRESS_TAG_KEY, DRESS_TAG_DEFAULTS);

  const flatCats = useMemo(() => flattenCategories(categories), [categories]);

  const images = useMemo(() => {
    const imgs: string[] = [];
    if (form.publicImageUrl) imgs.push(form.publicImageUrl);
    if (form.imageUrl && form.imageUrl !== form.publicImageUrl) imgs.push(form.imageUrl);
    for (const x of (form.extraImages || [])) { if (x && !imgs.includes(x)) imgs.push(x); }
    return imgs;
  }, [form.publicImageUrl, form.imageUrl, form.extraImages]);

  function reorderImages(next: string[]) {
    setForm(f => ({
      ...f,
      publicImageUrl: next[0] ?? null,
      imageUrl: next[0] ?? null,
      extraImages: next.slice(1),
    }));
  }
  function setCoverImage(src: string) {
    const rest = images.filter(x => x !== src);
    setForm(f => ({ ...f, publicImageUrl: src, imageUrl: src, extraImages: rest }));
  }
  function removeImage(src: string) {
    setForm(f => {
      const next = images.filter(x => x !== src);
      return {
        ...f,
        publicImageUrl: f.publicImageUrl === src ? (next[0] ?? null) : f.publicImageUrl,
        imageUrl: f.imageUrl === src ? (next[0] ?? null) : f.imageUrl,
        extraImages: (f.extraImages || []).filter(x => x !== src),
      };
    });
  }
  function addImages(uploaded: UploadedImage[]) {
    const newPaths = uploaded.map(u => u.objectPath);
    setForm(f => {
      const combined = [...(f.extraImages || []), ...newPaths];
      if (!f.publicImageUrl) {
        return { ...f, publicImageUrl: combined[0], imageUrl: combined[0], extraImages: combined.slice(1) };
      }
      return { ...f, extraImages: combined };
    });
  }

  // Auto-gen QR when Tab 2 opens
  useEffect(() => {
    if (activeTab !== 2 || isNew) return;
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const slug = form.slug || String((dress as Dress).id);
    const link = `${window.location.origin}${base}/san-pham/${slug}`;
    setPublicLink(link);
    QRCode.toDataURL(link, { width: 280, margin: 2 }).then(setQrDataUrl).catch(console.error);
  }, [activeTab]);

  async function handleSave() {
    if (!form.name?.trim()) { setSaveError("Vui lòng nhập tên sản phẩm"); return; }
    setSaveError(null); setSaving(true);
    try {
      let payload = form;
      if (!isNew) {
        const curR = await fetch(`${CMS_BASE}/api/dresses/${(dress as Dress).id}`, { headers: authHeaders() });
        if (curR.ok) {
          const cur = await curR.json() as Dress;
          payload = { ...form, imageUrl: cur.imageUrl, publicImageUrl: cur.publicImageUrl, coverImageUrl: cur.coverImageUrl, extraImages: cur.extraImages };
        }
      }
      const url = isNew ? `${CMS_BASE}/api/dresses` : `${CMS_BASE}/api/dresses/${(dress as Dress).id}`;
      const r = await fetch(url, { method: isNew ? "POST" : "PUT", headers: authHeaders(), body: JSON.stringify(payload) });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? "Lỗi lưu");
      const saved = json as Dress & { id?: number };
      const dressId = saved.id ?? (dress as Dress).id;
      const hadPending = pendingJobIds.length > 0;
      if (hadPending && dressId) uploadQueueStore.bindDressJobs(pendingJobIds, dressId);
      setPendingJobIds([]);
      if (hadPending || uploadQueueStore.getActiveCount() > 0) {
        toast({ title: "Đã lưu", description: "Ảnh đang được tải lên nền — xem icon ☁️ trên header." });
      }
      onSaved();
    } catch (e) { setSaveError((e as Error).message); } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!confirm(`Xoá "${form.name}"? Thao tác không thể hoàn tác.`)) return;
    setDeleting(true);
    try {
      await fetch(`${CMS_BASE}/api/dresses/${(dress as Dress).id}`, { method: "DELETE", headers: authHeaders() });
      onDeleted();
    } finally { setDeleting(false); }
  }

  function downloadQr() {
    if (!qrDataUrl) return;
    const a = document.createElement("a");
    a.href = qrDataUrl; a.download = `qr-${form.slug || "product"}.png`; a.click();
  }

  async function copyLink() {
    if (!publicLink) return;
    await navigator.clipboard.writeText(publicLink).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  const isVisible = form.isPublic === 1 && form.cmsStatus === "visible";
  const TAB_LABELS = ["Thông tin", "Album ảnh", "QR & Link"];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 sm:bg-transparent" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-background shadow-2xl border-l border-border flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b bg-background sticky top-0 z-10">
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-base truncate">{isNew ? "Thêm sản phẩm mới" : form.name || "Sản phẩm"}</h2>
            {!isNew && <p className="text-xs text-muted-foreground font-mono">{form.code}</p>}
          </div>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5 flex-shrink-0">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {isNew ? "Tạo" : "Lưu"}
          </Button>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg text-muted-foreground flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b bg-muted/20">
          {TAB_LABELS.map((label, idx) => (
            <button
              key={idx}
              onClick={() => setActiveTab(idx as 0 | 1 | 2)}
              className={`flex-1 py-2.5 text-sm font-medium transition-all ${
                activeTab === idx
                  ? "border-b-2 border-primary text-primary bg-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              {idx === 1 && images.length > 0 && (
                <span className="ml-1 text-[10px] bg-primary/20 text-primary px-1.5 rounded-full">{images.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto overscroll-contain pb-24">
          {saveError && (
            <div className="m-4 p-3 rounded-xl bg-destructive/10 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {saveError}
            </div>
          )}

          {/* ═══ TAB 0: THÔNG TIN ═══ */}
          {activeTab === 0 && (
            <div className="p-4 space-y-4">
              {/* Tên + Mã */}
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Tên sản phẩm</label>
                  <Input value={form.name} onChange={e => set("name", e.target.value)} placeholder="Váy cưới đuôi cá luxury..." />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Mã đồ</label>
                    <Input value={form.code} onChange={e => set("code", e.target.value)} placeholder="VD-001" className="font-mono" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Danh mục</label>
                    <select
                      value={form.categoryId ?? ""}
                      onChange={e => set("categoryId", e.target.value ? +e.target.value : null)}
                      className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    >
                      <option value="">— Không —</option>
                      {flatCats.map(({ cat, depth }) => (
                        <option key={cat.id} value={cat.id}>{"\u00a0".repeat(depth * 3)}{cat.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Size + Màu + Chất liệu + Tags */}
              <div className="space-y-3 border-t pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Chi tiết sản phẩm</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Size / Số đo</label>
                    <Input value={form.sizeText ?? ""} onChange={e => set("sizeText", e.target.value || null)} placeholder="S,M,L hoặc 40-48kg" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Màu sắc</label>
                    <Input value={form.colorText ?? ""} onChange={e => set("colorText", e.target.value || null)} placeholder="Trắng,Kem,Hồng" />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground mb-1 block">Chất liệu</label>
                    <Input value={form.materialText ?? ""} onChange={e => set("materialText", e.target.value || null)} placeholder="Lụa,ren,mikado" />
                  </div>
                </div>
                <ChipSuggest
                  label="Tags / Phong cách — AI tư vấn dựa vào tags này, bấm chip để gắn nhanh"
                  suggestions={dressTags.list}
                  value={form.tagsText ?? ""}
                  onChange={v => set("tagsText", v || null)}
                  onAddSuggestion={dressTags.add}
                />
              </div>

              {/* Giá */}
              <div className="space-y-3 border-t pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Giá & Trạng thái</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Giá thuê (VNĐ)</label>
                    <CurrencyInput value={form.rentalPrice} onChange={v => set("rentalPrice", Number(v.replace(/\D/g, "")) || 0)} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Đặt cọc (VNĐ)</label>
                    <CurrencyInput value={form.depositRequired} onChange={v => set("depositRequired", Number(v.replace(/\D/g, "")) || 0)} />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Giá bán (nếu có)</label>
                  <CurrencyInput value={form.sellPrice} onChange={v => set("sellPrice", Number(v.replace(/\D/g, "")) || 0)} placeholder="Để trống nếu chỉ cho thuê" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Trạng thái</label>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(RENTAL_STATUS).map(([k, v]) => (
                      <button
                        key={k}
                        onClick={() => set("rentalStatus", k)}
                        className={`flex items-center gap-1.5 py-2 px-3 rounded-lg text-xs font-medium border transition-all ${
                          form.rentalStatus === k
                            ? `${v.bg} ${v.color} border-transparent`
                            : "border-border text-muted-foreground hover:border-primary/30"
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${v.dot}`} />
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Tình trạng outfit (nhãn marketing)</label>
                  <select
                    value={form.outfitTag ?? ""}
                    onChange={e => set("outfitTag", e.target.value ? e.target.value : null)}
                    className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                  >
                    <option value="">— Không gắn nhãn —</option>
                    {OUTFIT_TAGS.map(t => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </select>
                  {form.outfitTag && (
                    <div className="mt-2">
                      <OutfitTagBadge tag={form.outfitTag} />
                    </div>
                  )}
                </div>
              </div>

              {/* Hiển thị */}
              <div className="border-t pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Hiển thị website</p>
                <button
                  onClick={() => setForm(f => ({ ...f, isPublic: isVisible ? 0 : 1, cmsStatus: isVisible ? "hidden" : "visible" }))}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${
                    isVisible ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-border bg-muted/30 text-muted-foreground"
                  }`}
                >
                  <div className={`w-9 h-5 rounded-full relative flex-shrink-0 transition-all ${isVisible ? "bg-emerald-500" : "bg-border"}`}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${isVisible ? "left-4" : "left-0.5"}`} />
                  </div>
                  <div className="text-left flex-1">
                    <p className="font-medium text-sm">{isVisible ? "Đang hiển thị trên website" : "Đang ẩn — khách không thấy"}</p>
                    <p className="text-xs opacity-70">{isVisible ? "Bấm để ẩn" : "Bấm để hiện trên trang Cho thuê đồ"}</p>
                  </div>
                  {isVisible && <Check className="w-4 h-4 flex-shrink-0" />}
                </button>
              </div>

              {/* Mô tả + Ghi chú */}
              <div className="space-y-3 border-t pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Mô tả & Ghi chú</p>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Mô tả công khai</label>
                  <textarea
                    value={form.description ?? ""}
                    onChange={e => set("description", e.target.value || null)}
                    rows={3}
                    placeholder="Mô tả hiển thị cho khách..."
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Ghi chú nội bộ</label>
                  <textarea
                    value={form.notes ?? ""}
                    onChange={e => set("notes", e.target.value || null)}
                    rows={2}
                    placeholder="Ghi chú cho nhân viên..."
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>

              {/* Xoá */}
              {!isNew && effectiveIsAdmin && (
                <div className="border-t pt-4">
                  <button
                    onClick={handleDelete} disabled={deleting}
                    className="w-full flex items-center justify-center gap-2 p-3 rounded-xl border border-destructive/40 text-destructive hover:bg-destructive/5 text-sm font-medium transition-all"
                  >
                    {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    Xoá sản phẩm
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ═══ TAB 1: ALBUM ẢNH ═══ */}
          {activeTab === 1 && (
            <div className="p-4 space-y-4">
              {/* Nhãn marketing — set chung với ảnh để nhân viên làm 1 chỗ */}
              <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Tình trạng outfit (nhãn marketing)
                  </label>
                  {form.outfitTag && <OutfitTagBadge tag={form.outfitTag} />}
                </div>
                <select
                  value={form.outfitTag ?? ""}
                  onChange={e => set("outfitTag", e.target.value ? e.target.value : null)}
                  className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                >
                  <option value="">— Không gắn nhãn —</option>
                  {OUTFIT_TAGS.map(t => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Nhãn sẽ hiện trên ảnh bìa ở trang công khai. Nhớ bấm <strong>Lưu</strong> sau khi đổi.
                </p>
              </div>

              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {images.length} / 20 ảnh • Kéo thả để đổi thứ tự
                </p>
                {images.length >= 20 && (
                  <span className="text-xs text-orange-600">Đã đạt giới hạn 20 ảnh</span>
                )}
              </div>
              <DragSortImageGrid
                images={images}
                onReorder={reorderImages}
                onSetCover={setCoverImage}
                onRemove={removeImage}
              />
              {images.length < 20 && (
                <div className="mt-4">
                  <MultiImageUploader
                    multiple
                    label="Kéo thả / dán Ctrl+V / bấm để thêm ảnh"
                    attach={{ entity: "dress", mode: "album", ...(!isNew ? { dressId: (dress as Dress).id } : {}) }}
                    onJobsQueued={(ids) => setPendingJobIds(prev => [...prev, ...ids])}
                    onUploaded={addImages}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Ảnh đầu tiên là ảnh bìa. Kéo thả để sắp xếp. Hover ảnh để xoá hoặc đặt làm bìa.
              </p>
            </div>
          )}

          {/* ═══ TAB 2: QR & LINK ═══ */}
          {activeTab === 2 && (
            <div className="p-4">
              {isNew ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                  <QrCode className="w-12 h-12 mb-3 opacity-30" />
                  <p className="font-medium">Tạo sản phẩm trước</p>
                  <p className="text-sm mt-1">Sau khi lưu, mỗi sản phẩm có link và QR riêng</p>
                  <Button size="sm" className="mt-4" onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Tạo ngay
                  </Button>
                </div>
              ) : (
                <div className="space-y-5">
                  {/* Link */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Link công khai</p>
                    <div className="flex gap-2">
                      <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-muted rounded-lg border text-sm font-mono overflow-hidden">
                        <Link2 className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate text-xs">{publicLink || "Đang tạo..."}</span>
                      </div>
                      <button
                        onClick={copyLink}
                        className={`px-3 py-2 rounded-lg border text-sm font-medium flex items-center gap-1.5 transition-all ${
                          copied ? "bg-emerald-500 text-white border-transparent" : "hover:bg-muted"
                        }`}
                      >
                        <Copy className="w-3.5 h-3.5" />
                        {copied ? "Đã sao chép" : "Sao chép"}
                      </button>
                    </div>
                  </div>

                  {/* QR */}
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Mã QR</p>
                    {qrDataUrl ? (
                      <div className="flex flex-col items-center bg-white rounded-2xl p-6 border">
                        <img src={qrDataUrl} alt="QR Code" className="w-52 h-52 rounded-lg" />
                        <p className="text-sm font-medium mt-3">{form.name}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{form.code}</p>
                        <div className="flex gap-3 mt-4">
                          <button
                            onClick={downloadQr}
                            className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90"
                          >
                            <Download className="w-4 h-4" /> Tải PNG
                          </button>
                          <button
                            onClick={() => window.print()}
                            className="flex items-center gap-1.5 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted"
                          >
                            <Printer className="w-4 h-4" /> In
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center py-8 text-muted-foreground">
                        <Loader2 className="w-6 h-6 animate-spin" />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t p-4 bg-background space-y-2">
          <Button className="w-full gap-2" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isNew ? "Tạo sản phẩm" : "Lưu thay đổi"}
          </Button>
        </div>
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function CmsProductsRentalPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterCatId, setFilterCatId] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterVisibility, setFilterVisibility] = useState("");
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set());
  const [selectedColors, setSelectedColors] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selectedOutfitTags, setSelectedOutfitTags] = useState<Set<OutfitTagKey>>(new Set());
  const [drawerDress, setDrawerDress] = useState<Dress | "new" | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const togglePublic = useTogglePublic(qc);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  // Task #510: multi-select bulk actions
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [moveTargetCatId, setMoveTargetCatId] = useState<number | null>(null);
  const [newRentalStatus, setNewRentalStatus] = useState<string>("san_sang");
  const bulk = useBulkMutations(qc);
  const { toast } = useToast();

  useEffect(() => {
    if (selected.size === 0) setSelectMode(false);
  }, [selected.size]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && selected.size > 0) {
        setSelected(new Set());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);

  function toggleSelectId(id: number) {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const { data: dresses = [], isLoading } = useQuery<Dress[]>({
    queryKey: ["cms-products"],
    queryFn: () => fetch(`${CMS_BASE}/api/dresses`, { headers: authHeaders() }).then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ["cms-categories"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/categories`, { headers: authHeaders() }).then(r => r.json()),
    staleTime: 60_000,
  });

  const dressCats = useMemo(() => categories.filter(c => c.type === "dress"), [categories]);
  const flatCats = useMemo(() => flattenCategories(dressCats), [dressCats]);

  const categoryDescendants = useMemo(() => {
    if (!filterCatId) return null;
    const ids = new Set<number>([+filterCatId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of dressCats) {
        if (c.parentId !== null && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); changed = true; }
      }
    }
    return ids;
  }, [filterCatId, dressCats]);

  // Auto-populated filter options
  const sizeOptions = useMemo(() => {
    const s = new Set<string>();
    dresses.forEach(d => { (d.sizeText || d.size || "").split(/[,;/]/).forEach(x => { const t = x.trim(); if (t) s.add(t); }); });
    return [...s].sort();
  }, [dresses]);
  const colorOptions = useMemo(() => {
    const s = new Set<string>();
    dresses.forEach(d => { (d.colorText || d.color || "").split(/[,;/]/).forEach(x => { const t = x.trim(); if (t) s.add(t); }); });
    return [...s].sort();
  }, [dresses]);
  const tagOptions = useMemo(() => {
    const s = new Set<string>();
    dresses.forEach(d => { (d.tagsText || "").split(/[,;]/).forEach(x => { const t = x.trim(); if (t) s.add(t); }); });
    return [...s].sort();
  }, [dresses]);

  const filtered = useMemo(() => {
    let list = dresses;
    if (search) {
      const q = search.toLowerCase();
      const tagKeysFromSearch = matchOutfitKeysFromQuery(search);
      list = list.filter(d =>
        d.name.toLowerCase().includes(q) || d.code.toLowerCase().includes(q) ||
        (d.colorText || d.color).toLowerCase().includes(q) ||
        (d.tagsText || "").toLowerCase().includes(q) ||
        (d.outfitTag !== null && tagKeysFromSearch.has(d.outfitTag as OutfitTagKey))
      );
    }
    if (categoryDescendants) list = list.filter(d => d.categoryId !== null && categoryDescendants.has(d.categoryId));
    if (filterStatus) list = list.filter(d => d.rentalStatus === filterStatus);
    if (filterVisibility === "visible") list = list.filter(d => d.isPublic === 1 && d.cmsStatus === "visible");
    if (filterVisibility === "hidden") list = list.filter(d => !(d.isPublic === 1 && d.cmsStatus === "visible"));
    if (selectedSizes.size > 0) list = list.filter(d => {
      const v = (d.sizeText || d.size || "").toLowerCase();
      return [...selectedSizes].some(s => v.includes(s.toLowerCase()));
    });
    if (selectedColors.size > 0) list = list.filter(d => {
      const v = (d.colorText || d.color || "").toLowerCase();
      return [...selectedColors].some(s => v.includes(s.toLowerCase()));
    });
    if (selectedTags.size > 0) list = list.filter(d => {
      const v = (d.tagsText || "").toLowerCase();
      return [...selectedTags].some(s => v.includes(s.toLowerCase()));
    });
    if (selectedOutfitTags.size > 0) list = list.filter(d =>
      d.outfitTag !== null && selectedOutfitTags.has(d.outfitTag as OutfitTagKey)
    );
    return list;
  }, [dresses, search, categoryDescendants, filterStatus, filterVisibility, selectedSizes, selectedColors, selectedTags, selectedOutfitTags]);

  function handleTogglePublic(d: Dress) {
    const isVis = d.isPublic === 1 && d.cmsStatus === "visible";
    setTogglingId(d.id);
    togglePublic.mutate({ id: d.id, isPublic: isVis ? 0 : 1, cmsStatus: isVis ? "hidden" : "visible" },
      { onSettled: () => setTogglingId(null) });
  }

  const hasFilter = search || filterCatId || filterStatus || filterVisibility || selectedSizes.size > 0 || selectedColors.size > 0 || selectedTags.size > 0 || selectedOutfitTags.size > 0;
  const counts = useMemo(() => ({
    total: dresses.length,
    visible: dresses.filter(d => d.isPublic === 1 && d.cmsStatus === "visible").length,
    sanSang: dresses.filter(d => d.rentalStatus === "san_sang").length,
  }), [dresses]);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b px-4 sm:px-6 py-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
              <Shirt className="w-5 h-5 text-primary" /> Kho sản phẩm thuê
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {counts.total} sản phẩm · {counts.visible} hiển thị · {counts.sanSang} có sẵn
            </p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => setBulkOpen(true)}
              className="hidden sm:flex items-center gap-1.5 h-9 px-3 text-sm border border-border rounded-lg hover:bg-muted transition-colors"
            >
              <Upload className="w-4 h-4" /> Hàng loạt
            </button>
            <Button onClick={() => setDrawerDress("new")} className="gap-1.5">
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Thêm sản phẩm</span>
              <span className="sm:hidden">Thêm</span>
            </Button>
          </div>
        </div>

        {/* Filter row 1 */}
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
          <div className="relative flex-1 min-w-[140px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tên, mã, tags..." className="pl-8 h-8 text-sm" />
            {search && <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2"><X className="w-3.5 h-3.5 text-muted-foreground" /></button>}
          </div>
          <div className="relative flex-shrink-0">
            <select value={filterCatId} onChange={e => setFilterCatId(e.target.value)}
              className="h-8 pl-2 pr-7 text-sm border border-input rounded-md bg-background appearance-none min-w-[120px]">
              <option value="">Tất cả danh mục</option>
              {flatCats.map(({ cat, depth }) => (
                <option key={cat.id} value={cat.id}>{"\u00a0".repeat(depth * 2)}{cat.name}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          </div>
          <div className="relative flex-shrink-0">
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              className="h-8 pl-2 pr-7 text-sm border border-input rounded-md bg-background appearance-none min-w-[100px]">
              <option value="">Mọi trạng thái</option>
              {Object.entries(RENTAL_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          </div>
          <div className="relative flex-shrink-0">
            <select value={filterVisibility} onChange={e => setFilterVisibility(e.target.value)}
              className="h-8 pl-2 pr-7 text-sm border border-input rounded-md bg-background appearance-none min-w-[90px]">
              <option value="">Hiện + ẩn</option>
              <option value="visible">Đang hiển thị</option>
              <option value="hidden">Đang ẩn</option>
            </select>
            <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          </div>
        </div>

        {/* Filter row 2: chip multi-select for size/màu/tags/nhãn */}
        {(sizeOptions.length > 0 || colorOptions.length > 0 || tagOptions.length > 0 || dresses.length > 0) && (
          <div className="space-y-1.5">
            {sizeOptions.length > 0 && (
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                <span className="text-[10px] text-muted-foreground flex-shrink-0 w-9">Size:</span>
                {sizeOptions.map(s => (
                  <button key={s}
                    onClick={() => setSelectedSizes(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; })}
                    className={`flex-shrink-0 px-2 py-0.5 text-xs rounded-full border transition-all ${selectedSizes.has(s) ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border hover:border-foreground"}`}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {colorOptions.length > 0 && (
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                <span className="text-[10px] text-muted-foreground flex-shrink-0 w-9">Màu:</span>
                {colorOptions.map(s => (
                  <button key={s}
                    onClick={() => setSelectedColors(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; })}
                    className={`flex-shrink-0 px-2 py-0.5 text-xs rounded-full border transition-all ${selectedColors.has(s) ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border hover:border-foreground"}`}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {tagOptions.length > 0 && (
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                <span className="text-[10px] text-muted-foreground flex-shrink-0 w-9">Tags:</span>
                {tagOptions.map(s => (
                  <button key={s}
                    onClick={() => setSelectedTags(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; })}
                    className={`flex-shrink-0 px-2 py-0.5 text-xs rounded-full border transition-all ${selectedTags.has(s) ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border hover:border-foreground"}`}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              <span className="text-[10px] text-muted-foreground flex-shrink-0 w-9">Nhãn:</span>
              {OUTFIT_TAGS.map(t => {
                const active = selectedOutfitTags.has(t.key);
                return (
                  <button key={t.key} type="button"
                    onClick={() => setSelectedOutfitTags(prev => { const n = new Set(prev); n.has(t.key) ? n.delete(t.key) : n.add(t.key); return n; })}
                    className={`flex-shrink-0 rounded-full transition-all ${active ? "ring-2 ring-foreground ring-offset-1" : "opacity-70 hover:opacity-100"}`}
                    title={t.label}>
                    <OutfitTagBadge tag={t.key} size="xs" />
                  </button>
                );
              })}
            </div>
            {hasFilter && (
              <button
                onClick={() => { setSearch(""); setFilterCatId(""); setFilterStatus(""); setFilterVisibility(""); setSelectedSizes(new Set()); setSelectedColors(new Set()); setSelectedTags(new Set()); setSelectedOutfitTags(new Set()); }}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                <X className="w-3 h-3" /> Xoá tất cả bộ lọc
              </button>
            )}
          </div>
        )}
      </div>

      {/* Grid */}
      <div className="p-4 sm:p-6">
        {isLoading ? (
          <div className="text-center py-20 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 opacity-50" />
            Đang tải...
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 border-2 border-dashed border-border rounded-2xl text-muted-foreground">
            <Shirt className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p className="font-medium">{dresses.length === 0 ? "Chưa có sản phẩm nào" : "Không tìm thấy sản phẩm phù hợp"}</p>
            {dresses.length === 0 && (
              <div className="flex gap-3 justify-center mt-4">
                <Button size="sm" onClick={() => setDrawerDress("new")}><Plus className="w-4 h-4 mr-1" />Thêm sản phẩm</Button>
                <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}><Upload className="w-4 h-4 mr-1" />Upload hàng loạt</Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-3">
              {filtered.length} / {dresses.length} sản phẩm{hasFilter ? " (đang lọc)" : ""}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {filtered.map(d => (
                <ProductCard
                  key={d.id}
                  dress={d}
                  onSelect={() => setDrawerDress(d)}
                  onTogglePublic={handleTogglePublic}
                  toggling={togglingId === d.id}
                  selectMode={selectMode}
                  isSelected={selected.has(d.id)}
                  onToggleSelect={() => toggleSelectId(d.id)}
                  onLongPressStart={() => { setSelectMode(true); setSelected(prev => { const n = new Set(prev); n.add(d.id); return n; }); }}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Drawer */}
      {drawerDress !== null && (
        <ProductDrawer
          dress={drawerDress}
          categories={categories}
          onClose={() => setDrawerDress(null)}
          onSaved={() => { setDrawerDress(null); qc.invalidateQueries({ queryKey: ["cms-products"] }); }}
          onDeleted={() => { setDrawerDress(null); qc.invalidateQueries({ queryKey: ["cms-products"] }); }}
        />
      )}

      {/* Bulk upload modal */}
      {bulkOpen && (
        <BulkUploadModal
          onClose={() => setBulkOpen(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: ["cms-products"] }); }}
        />
      )}

      {/* ── Task #510: Bulk action bottom bar ───────────────────────────── */}
      {selected.size > 0 && (
        <div
          className="fixed left-0 right-0 bottom-0 z-40 bg-background/95 backdrop-blur border-t shadow-[0_-4px_16px_rgba(0,0,0,0.08)]"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <div className="max-w-screen-xl mx-auto px-3 py-2 flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="p-2 hover:bg-muted rounded-lg flex-shrink-0"
              aria-label="Bỏ chọn tất cả"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex-shrink-0 text-sm font-medium">
              <span className="text-primary">{selected.size}</span>
              <span className="text-muted-foreground"> đã chọn</span>
            </div>
            <button
              onClick={() => {
                const allIds = filtered.map(d => d.id);
                const allSelected = allIds.every(id => selected.has(id));
                setSelected(allSelected ? new Set() : new Set(allIds));
              }}
              className="text-xs text-primary hover:underline flex-shrink-0"
            >
              {filtered.every(d => selected.has(d.id)) ? "Bỏ chọn tất cả" : "Chọn tất cả"}
            </button>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setNewRentalStatus("san_sang"); setStatusDialogOpen(true); }}
                className="w-9 h-9 p-0"
                title="Đổi trạng thái"
                aria-label="Đổi trạng thái"
              >
                <Tag className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDeleteDialogOpen(true)}
                className="gap-1.5 h-9 px-3 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                title="Xoá"
                aria-label="Xoá"
              >
                <Trash2 className="w-4 h-4" />
                <span className="hidden sm:inline">Xoá</span>
              </Button>
              <Button
                size="sm"
                onClick={() => { setMoveTargetCatId(null); setMoveDialogOpen(true); }}
                className="gap-1.5 h-9 px-3 font-semibold"
              >
                <FolderInput className="w-4 h-4" />
                Chuyển danh mục
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dialog: Chuyển danh mục ─────────────────────────────────────── */}
      {moveDialogOpen && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4" onClick={() => setMoveDialogOpen(false)}>
          <div className="bg-background rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="font-semibold flex items-center gap-2">
                <FolderInput className="w-4 h-4 text-primary" />
                Chuyển danh mục
              </h2>
              <button onClick={() => setMoveDialogOpen(false)} className="p-1.5 hover:bg-muted rounded-lg">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto flex-1 space-y-4">
              {/* Selected products preview */}
              <div className="space-y-2">
                <p className="text-sm font-medium">Đã chọn <span className="font-semibold">{selected.size}</span> sản phẩm</p>
                <div className="flex flex-wrap gap-2 max-h-[120px] overflow-y-auto">
                  {Array.from(selected).map(id => {
                    const d = filtered.find(x => x.id === id);
                    if (!d) return null;
                    const img = coverOf(d);
                    return (
                      <div key={id} className="flex items-center gap-2 bg-muted rounded-lg px-2 py-1.5 pr-3 border text-xs">
                        {img ? (
                          <img src={img} alt={d.name} className="w-7 h-7 rounded object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-7 h-7 rounded bg-muted-foreground/20 flex items-center justify-center flex-shrink-0">
                            <ImageIcon className="w-3 h-3 text-muted-foreground" />
                          </div>
                        )}
                        <span className="truncate max-w-[140px] font-medium">{d.name}</span>
                        <span className="text-muted-foreground">{d.code}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Category tree */}
              <div>
                <p className="text-sm text-muted-foreground mb-2">Chọn nơi muốn chuyển tới:</p>
                <CategoryTreePicker
                  categories={categories}
                  value={moveTargetCatId}
                  onChange={setMoveTargetCatId}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
              <Button variant="outline" onClick={() => setMoveDialogOpen(false)}>Huỷ</Button>
              <Button
                onClick={() => {
                  bulk.move.mutate(
                    { ids: Array.from(selected), categoryId: moveTargetCatId },
                    {
                      onSuccess: (r) => {
                        setMoveDialogOpen(false);
                        setSelected(new Set());
                        const targetName = moveTargetCatId == null
                          ? "Không gắn danh mục"
                          : (categories.find(c => c.id === moveTargetCatId)?.name ?? "");
                        toast({ title: "Đã chuyển", description: `${r.affected} sản phẩm → ${targetName}` });
                      },
                      onError: (e: Error) => toast({ title: "Không chuyển được", description: e.message, variant: "destructive" }),
                    }
                  );
                }}
                disabled={bulk.move.isPending}
                className="gap-1.5"
              >
                {bulk.move.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Chuyển
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dialog: Đổi trạng thái ─────────────────────────────────────── */}
      {statusDialogOpen && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4" onClick={() => setStatusDialogOpen(false)}>
          <div className="bg-background rounded-2xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="font-semibold flex items-center gap-2">
                <Tag className="w-4 h-4 text-primary" />
                Đổi trạng thái {selected.size} sản phẩm
              </h2>
              <button onClick={() => setStatusDialogOpen(false)} className="p-1.5 hover:bg-muted rounded-lg">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-2">
              {Object.entries(RENTAL_STATUS).map(([key, s]) => (
                <button
                  key={key}
                  onClick={() => setNewRentalStatus(key)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border text-left transition-all ${
                    newRentalStatus === key ? "border-primary bg-primary/5" : "border-border hover:bg-muted"
                  }`}
                >
                  <span className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs ${s.bg} ${s.color}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                    {s.label}
                  </span>
                  {newRentalStatus === key && <Check className="w-4 h-4 ml-auto text-primary" />}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
              <Button variant="outline" onClick={() => setStatusDialogOpen(false)}>Huỷ</Button>
              <Button
                onClick={() => {
                  bulk.status.mutate(
                    { ids: Array.from(selected), rentalStatus: newRentalStatus },
                    {
                      onSuccess: (r) => {
                        setStatusDialogOpen(false);
                        setSelected(new Set());
                        toast({ title: "Đã đổi trạng thái", description: `${r.affected} sản phẩm → ${RENTAL_STATUS[newRentalStatus]?.label ?? newRentalStatus}` });
                      },
                      onError: (e: Error) => toast({ title: "Không đổi được", description: e.message, variant: "destructive" }),
                    }
                  );
                }}
                disabled={bulk.status.isPending}
                className="gap-1.5"
              >
                {bulk.status.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Áp dụng
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dialog: Xoá nhiều ─────────────────────────────────────────── */}
      {deleteDialogOpen && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4" onClick={() => setDeleteDialogOpen(false)}>
          <div className="bg-background rounded-2xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="font-semibold flex items-center gap-2 text-destructive">
                <AlertCircle className="w-4 h-4" />
                Xoá {selected.size} sản phẩm?
              </h2>
              <button onClick={() => setDeleteDialogOpen(false)} className="p-1.5 hover:bg-muted rounded-lg">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5">
              <p className="text-sm text-muted-foreground">
                Sản phẩm sẽ được đưa vào thùng rác, có thể khôi phục lại sau.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
              <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Huỷ</Button>
              <Button
                variant="destructive"
                onClick={() => {
                  bulk.remove.mutate(
                    { ids: Array.from(selected) },
                    {
                      onSuccess: (r) => {
                        setDeleteDialogOpen(false);
                        setSelected(new Set());
                        toast({ title: "Đã chuyển vào thùng rác", description: `${r.affected} sản phẩm` });
                      },
                      onError: (e: Error) => toast({ title: "Không xoá được", description: e.message, variant: "destructive" }),
                    }
                  );
                }}
                disabled={bulk.remove.isPending}
                className="gap-1.5"
              >
                {bulk.remove.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Xoá
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
