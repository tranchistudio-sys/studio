import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Tag, Plus, Trash2, Edit2, Save, Loader2, X, ChevronRight, ChevronDown,
  FolderPlus, Shirt, QrCode, Link as LinkIcon, Download, Printer, Image as ImageIcon,
  Eye, EyeOff, Search, Check, AlertCircle, Upload, Copy, Link2, MoreHorizontal,
  ArrowLeft, Globe, FolderInput, Star, StarOff,
} from "lucide-react";
import QRCode from "qrcode";
import { Button, Input } from "@/components/ui";
import { CurrencyInput } from "@/components/ui/currency-input";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  authHeaders, CMS_BASE, LazyImage, MultiImageUploader, SortableList,
  type UploadedImage,
  convertToWebP, uploadFileViaPresign,
} from "@/components/cms-shared";
import { getImageSrc } from "@/lib/imageUtils";
import { formatVND } from "@/lib/utils";
import { OUTFIT_TAGS, OutfitTagBadge } from "@/lib/outfit-tags";
import { useToast } from "@/hooks/use-toast";
import { uploadQueueStore } from "@/lib/upload-queue/store";
import { getPublicPageUrl } from "@/lib/public-site-url";
import { GoldenHourCategoryButton } from "@/components/golden-hour-admin";

// ─── Types ──────────────────────────────────────────────────────────────────
interface Category {
  id: number; type: string; parentId: number | null;
  name: string; slug: string | null;
  coverImageUrl: string | null; fallbackCover?: string | null;
  sortOrder: number; isActive: number; productCount: number;
}
interface Dress {
  id: number; code: string; name: string;
  category: string; categoryId: number | null;
  color: string; size: string; style: string | null;
  rentalPrice: number; depositRequired: number; sellPrice: number; salePrice: number;
  isPriority: boolean; priorityAt: string | null;
  isAvailable: boolean; rentalStatus: string; condition: string;
  outfitTag: string | null;
  notes: string | null; description: string | null;
  imageUrl: string | null; publicImageUrl: string | null; coverImageUrl: string | null;
  extraImages: string[]; isPublic: number; cmsStatus: string;
  sizeText: string | null; colorText: string | null;
  tagsText: string | null; materialText: string | null;
  slug: string | null; createdAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const RENTAL_STATUS: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  san_sang:       { label: "Có sẵn",     color: "text-emerald-700", bg: "bg-emerald-100", dot: "bg-emerald-500" },
  dang_cho_thue:  { label: "Đang thuê",  color: "text-orange-700",  bg: "bg-orange-100",  dot: "bg-orange-500"  },
  giu_do:         { label: "Giữ đồ",    color: "text-yellow-700",  bg: "bg-yellow-100",  dot: "bg-yellow-500"  },
  ngung_cho_thue: { label: "Ngưng thuê", color: "text-slate-600",   bg: "bg-slate-100",   dot: "bg-slate-400"   },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function coverOf(d: Dress): string | null {
  return d.coverImageUrl || d.publicImageUrl || d.imageUrl || d.extraImages?.[0] || null;
}
function CategoryTreePicker({
  categories, value, onChange,
}: {
  categories: Category[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const tree = useMemo(() => flattenCats(categories), [categories]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(categories.map(c => c.id)));
  const childMap = useMemo(() => {
    const m = new Map<number | null, number>();
    for (const c of categories) { m.set(c.parentId, (m.get(c.parentId) ?? 0) + 1); }
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
      <button type="button" onClick={() => onChange(null)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-sm border-b text-left hover:bg-muted ${value === null ? "bg-primary/10 text-primary font-medium" : ""}`}>
        <span className="w-4" /><Tag className="w-3.5 h-3.5 text-muted-foreground" />Không gắn danh mục
        {value === null && <Check className="w-4 h-4 ml-auto" />}
      </button>
      {tree.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-6">Chưa có danh mục</div>
      ) : tree.map(({ cat, depth }) => {
        if (!isVisible(cat.id, cat.parentId)) return null;
        const hasChildren = (childMap.get(cat.id) ?? 0) > 0;
        const isOpen = expanded.has(cat.id);
        const sel = value === cat.id;
        return (
          <div key={cat.id} style={{ paddingLeft: `${depth * 16 + 4}px` }}
            className={`flex items-center gap-1 text-sm border-b last:border-b-0 hover:bg-muted/70 ${sel ? "bg-primary/10" : ""}`}>
            <button type="button" onClick={() => hasChildren && toggle(cat.id)}
              className="w-6 h-8 flex items-center justify-center flex-shrink-0 text-muted-foreground">
              {hasChildren ? (isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)
                : <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />}
            </button>
            <button type="button" onClick={() => onChange(cat.id)}
              className={`flex-1 text-left py-2 truncate ${sel ? "font-semibold text-primary" : ""}`}>
              {cat.name}
            </button>
            {sel && <Check className="w-4 h-4 text-primary mr-2 flex-shrink-0" />}
          </div>
        );
      })}
    </div>
  );
}
function useBulkMove(qc: ReturnType<typeof useQueryClient>) {
  return useMutation({
    mutationFn: async ({ ids, categoryId }: { ids: number[]; categoryId: number | null }) => {
      const uniqueIds = [...new Set(ids)];
      const r = await fetch(`${CMS_BASE}/api/cms/dresses/bulk-category`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ ids: uniqueIds, categoryId }),
      });
      const json = await r.json().catch(() => ({})) as { error?: string; affected?: number };
      if (!r.ok) throw new Error(json.error ?? "Lỗi chuyển danh mục");
      if (!json.affected || json.affected < 1) {
        throw new Error(`Không chuyển được sản phẩm nào (0/${uniqueIds.length})`);
      }
      return json as { affected: number; ids?: number[]; targetCategoryId?: number | null };
    },
    onSuccess: async () => {
      await qc.refetchQueries({ queryKey: ["cms-products"] });
      await qc.refetchQueries({ queryKey: ["cms-categories"] });
    },
  });
}
function useBulkPriority(qc: ReturnType<typeof useQueryClient>) {
  return useMutation({
    mutationFn: async ({ ids, isPriority }: { ids: number[]; isPriority: boolean }) => {
      const uniqueIds = [...new Set(ids)];
      const r = await fetch(`${CMS_BASE}/api/cms/products/bulk-priority`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ ids: uniqueIds, isPriority }),
      });
      const json = await r.json().catch(() => ({})) as { error?: string; affected?: number };
      if (!r.ok) throw new Error(json.error ?? "Lỗi cập nhật ưu tiên");
      return json as { affected: number; isPriority: boolean };
    },
    onSuccess: async () => {
      await qc.refetchQueries({ queryKey: ["cms-products"] });
    },
  });
}
function useBulkDelete(qc: ReturnType<typeof useQueryClient>) {
  return useMutation({
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
      if (!r.ok) throw new Error(json.error ?? "Lỗi xoá sản phẩm");
      if (!json.affected || json.affected < 1) {
        throw new Error(`Không xóa được sản phẩm nào (0/${uniqueIds.length})`);
      }
      return json as { affected: number; ids?: number[] };
    },
    onSuccess: async (_data, variables) => {
      qc.setQueryData<Dress[]>(["cms-products"], old =>
        (old ?? []).filter(d => !variables.ids.includes(d.id))
      );
      await qc.refetchQueries({ queryKey: ["cms-products"] });
      await qc.refetchQueries({ queryKey: ["cms-categories"] });
    },
  });
}
function flattenCats(cats: Category[], parentId: number | null = null, depth = 0): Array<{ cat: Category; depth: number }> {
  const children = cats.filter(c => c.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);
  const result: Array<{ cat: Category; depth: number }> = [];
  for (const c of children) { result.push({ cat: c, depth }); result.push(...flattenCats(cats, c.id, depth + 1)); }
  return result;
}
function buildBreadcrumb(cats: Category[], id: number): string {
  const path: string[] = [];
  let cur: Category | undefined = cats.find(c => c.id === id);
  while (cur) {
    path.unshift(cur.name);
    cur = cur.parentId == null ? undefined : cats.find(c => c.id === cur!.parentId);
  }
  return path.join(" › ");
}
function getDescendantIds(cats: Category[], rootId: number): Set<number> {
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
function emptyForm(): Omit<Dress, "id" | "createdAt"> {
  return {
    code: "", name: "", category: "", categoryId: null,
    color: "", size: "", style: null,
    rentalPrice: 0, depositRequired: 0, sellPrice: 0, salePrice: 0,
    isPriority: false, priorityAt: null,
    isAvailable: true, rentalStatus: "san_sang", condition: "tot",
    outfitTag: null,
    notes: null, description: null, imageUrl: null, publicImageUrl: null, coverImageUrl: null,
    extraImages: [], isPublic: 1, cmsStatus: "visible",
    sizeText: null, colorText: null, tagsText: null, materialText: null, slug: null,
  };
}

// ─── Code auto-generation ─────────────────────────────────────────────────────
function getCatPrefix(catName: string): string {
  const normalized = catName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toUpperCase();
  return normalized.trim().split(/\s+/)
    .map(w => w.replace(/[^A-Z]/g, "")[0] ?? "")
    .filter(Boolean)
    .join("")
    .slice(0, 4) || "SP";
}
function computeSuggestedCode(catId: number | null, allCats: Category[], allProducts: Dress[]): string {
  if (!catId) return "";
  const cat = allCats.find(c => c.id === catId);
  if (!cat) return "";
  const prefix = getCatPrefix(cat.name);
  const pat = new RegExp(`^${prefix}-?(\\d+)$`, "i");
  const maxNum = allProducts
    .map(d => d.code ? (d.code.match(pat)?.[1] ?? null) : null)
    .filter((n): n is string => n !== null)
    .map(Number)
    .reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}-${String(maxNum + 1).padStart(3, "0")}`;
}

const EXPAND_KEY = "cms-categories-expanded-v2";
function loadExpanded(): Set<number> {
  try {
    const raw = localStorage.getItem(EXPAND_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(Number).filter(n => !isNaN(n)) : []);
  } catch { return new Set(); }
}
function saveExpanded(set: Set<number>) {
  try { localStorage.setItem(EXPAND_KEY, JSON.stringify(Array.from(set))); } catch {}
}

// ─── useCodeCheck hook ────────────────────────────────────────────────────────
type CodeStatus = "idle" | "checking" | "ok" | "taken";
function useCodeCheck(code: string, excludeId?: number, enabled = true): CodeStatus {
  const [status, setStatus] = useState<CodeStatus>("idle");
  useEffect(() => {
    if (!enabled) { setStatus("idle"); return; }
    const trimmed = code.trim();
    if (!trimmed) { setStatus("idle"); return; }
    setStatus("checking");
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ code: trimmed });
        if (excludeId) params.set("excludeId", String(excludeId));
        const r = await fetch(`${CMS_BASE}/api/dresses/check-code?${params}`, { headers: authHeaders() });
        const { available } = await r.json() as { available: boolean };
        setStatus(available ? "ok" : "taken");
      } catch { setStatus("idle"); }
    }, 400);
    return () => clearTimeout(timer);
  }, [code, excludeId, enabled]);
  return status;
}

// ─── DragSortImageGrid ────────────────────────────────────────────────────────
function DragSortImageGrid({ images, onReorder, onRemove, selectMode, selected, onToggleSelect }: {
  images: string[];
  onReorder: (next: string[]) => void;
  onRemove: (src: string) => void;
  selectMode?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (src: string) => void;
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
      {images.map((src, i) => {
        const isSelected = selected?.has(src) ?? false;
        return (
          <div
            key={src}
            draggable={!selectMode}
            onDragStart={() => { if (!selectMode) setDragIdx(i); }}
            onDragOver={e => { if (!selectMode) { e.preventDefault(); setOverIdx(i); } }}
            onDragLeave={() => setOverIdx(c => c === i ? null : c)}
            onDrop={e => {
              if (selectMode) return;
              e.preventDefault();
              if (dragIdx === null || dragIdx === i) { setDragIdx(null); setOverIdx(null); return; }
              const next = [...images];
              const [moved] = next.splice(dragIdx, 1);
              next.splice(i, 0, moved);
              onReorder(next);
              setDragIdx(null); setOverIdx(null);
            }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            onClick={() => { if (selectMode) onToggleSelect?.(src); }}
            className={`relative group aspect-[3/4] rounded-lg overflow-hidden bg-muted transition-all ${
              selectMode ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
            } ${dragIdx === i ? "opacity-40 scale-95" : ""} ${
              overIdx === i && dragIdx !== i && !selectMode ? "ring-2 ring-primary ring-offset-1" : ""
            } ${isSelected ? "ring-2 ring-primary ring-offset-1" : ""}`}
          >
            <img src={getImageSrc(src) ?? src} alt="" className="w-full h-full object-cover" />
            {selectMode && (
              <div className={`absolute top-1.5 left-1.5 w-5 h-5 rounded border-2 flex items-center justify-center ${
                isSelected ? "bg-primary border-primary" : "bg-white/90 border-white/60"
              }`}>
                {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
              </div>
            )}
            {!selectMode && (
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-all">
                <div className="absolute top-1 right-1 hidden group-hover:flex flex-col gap-1">
                  <button
                    onClick={e => { e.stopPropagation(); onRemove(src); }}
                    className="w-6 h-6 bg-destructive/90 text-white rounded-full flex items-center justify-center"
                    title="Xoá ảnh"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── ProductCard ──────────────────────────────────────────────────────────────
function ProductCard({ dress, onSelect, onTogglePublic, toggling, isSelected, onToggleSelect, selectMode }: {
  dress: Dress; onSelect: () => void; onTogglePublic: (d: Dress) => void; toggling: boolean;
  isSelected?: boolean; onToggleSelect?: (e: React.MouseEvent) => void; selectMode?: boolean;
}) {
  const cover = coverOf(dress);
  const status = RENTAL_STATUS[dress.rentalStatus] ?? RENTAL_STATUS.san_sang;
  const isVisible = dress.isPublic === 1 && dress.cmsStatus === "visible";

  return (
    <div
      className={`group relative rounded-xl overflow-hidden bg-muted border cursor-pointer hover:shadow-md transition-all ${
        isSelected ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/40"
      }`}
      onClick={selectMode ? onToggleSelect : onSelect}
    >
      <div className="aspect-[3/4] relative">
        <LazyImage src={cover} className="absolute inset-0 w-full h-full" />
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${status.bg} ${status.color}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </div>
          {dress.isPriority && (
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-400 text-amber-950">
              ★ Ưu tiên
            </div>
          )}
        </div>
        {(selectMode || isSelected) && (
          <div className="absolute top-2 right-2 z-10">
            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${isSelected ? "bg-primary border-primary" : "bg-white/90 border-white/60"}`}>
              {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
            </div>
          </div>
        )}
        {!selectMode && (
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
        )}
        <div className="absolute inset-x-0 bottom-0 p-2.5 text-white">
          <p className="font-semibold text-sm leading-tight line-clamp-2">{dress.name}</p>
          <div className="flex items-center justify-between mt-1">
            <span className="text-xs text-white/70 font-mono">{dress.code}</span>
            {dress.salePrice > 0 && dress.salePrice < dress.rentalPrice ? (
              <span className="text-right leading-tight">
                <span className="block text-[10px] text-white/60 line-through">{formatVND(dress.rentalPrice)}</span>
                <span className="block text-xs font-semibold text-amber-300">{formatVND(dress.salePrice)}</span>
              </span>
            ) : (
              <span className="text-xs font-medium">{dress.rentalPrice > 0 ? formatVND(dress.rentalPrice) : ""}</span>
            )}
          </div>
        </div>
      </div>
      {(dress.colorText || dress.color || dress.sizeText || dress.size) && (
        <div className="px-2 py-1.5 flex items-center gap-1 flex-wrap">
          {(dress.colorText || dress.color) && <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full text-muted-foreground truncate max-w-[80px]">{dress.colorText || dress.color}</span>}
          {(dress.sizeText || dress.size) && <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full text-muted-foreground truncate max-w-[80px]">{dress.sizeText || dress.size}</span>}
        </div>
      )}
    </div>
  );
}

// ─── ChipSelect (multi-select from fixed list) ───────────────────────────────
function ChipSelect({ label, options, value, onChange }: {
  label: string; options: string[]; value: string; onChange: (v: string) => void;
}) {
  const selected = new Set(value ? value.split(",").map(s => s.trim()).filter(Boolean) : []);
  function toggle(opt: string) {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt); else next.add(opt);
    onChange([...next].join(", "));
  }
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-2 block">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {options.map(opt => {
          const active = selected.has(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
      {selected.size > 0 && (
        <p className="text-[11px] text-muted-foreground mt-1.5">
          Đã chọn: <span className="text-foreground">{[...selected].join(", ")}</span>
        </p>
      )}
    </div>
  );
}

// ─── Common tags store (localStorage-backed shared suggestion list) ──────────
const COMMON_TAGS_KEY = "cms-common-tags-v2";
const DEFAULT_COMMON_TAGS = [
  "sang trọng","nàng thơ","tiểu thư","cổ điển","quyến rũ","cá tính","ngầu",
  "đuôi cá","váy to","công chúa","đi bàn","luxury","Hàn Quốc","tối giản",
  "sexy","kín đáo","vintage","truyền thống","hiện đại","bigsize",
];
function loadCommonTags(): string[] {
  try {
    const raw = localStorage.getItem(COMMON_TAGS_KEY);
    if (raw === null) {
      localStorage.setItem(COMMON_TAGS_KEY, JSON.stringify(DEFAULT_COMMON_TAGS));
      return [...DEFAULT_COMMON_TAGS];
    }
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0) : [...DEFAULT_COMMON_TAGS];
  } catch {
    return [...DEFAULT_COMMON_TAGS];
  }
}
function saveCommonTags(list: string[]) {
  try { localStorage.setItem(COMMON_TAGS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
function useCommonTags() {
  const [list, setList] = useState<string[]>(() => loadCommonTags());
  const add = useCallback((raw: string): { added: boolean } => {
    const normalized = normalizeTag(raw);
    if (!normalized) return { added: false };
    const lower = normalized.toLowerCase();
    let added = false;
    setList(prev => {
      if (prev.some(t => t.toLowerCase() === lower)) return prev;
      const next = [...prev, normalized];
      saveCommonTags(next);
      added = true;
      return next;
    });
    return { added };
  }, []);
  const remove = useCallback((tag: string) => {
    const lower = tag.toLowerCase();
    setList(prev => {
      const next = prev.filter(t => t.toLowerCase() !== lower);
      saveCommonTags(next);
      return next;
    });
  }, []);
  return { list, add, remove };
}

// ─── ChipSuggest (free text + suggestion chips, Enter to add) ─────────────────
function normalizeTag(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}
function ChipSuggest({ label, suggestions, value, onChange }: {
  label: string; suggestions: string[]; value: string; onChange: (v: string) => void;
}) {
  const current = useMemo(
    () => (value ? value.split(",").map(s => s.trim()).filter(Boolean) : []),
    [value]
  );
  const currentLower = useMemo(() => new Set(current.map(t => t.toLowerCase())), [current]);
  const [draft, setDraft] = useState("");

  function commit(next: string[]) {
    onChange(next.join(", "));
  }
  function addTag(raw: string) {
    const normalized = normalizeTag(raw);
    if (!normalized) return;
    if (currentLower.has(normalized.toLowerCase())) return;
    commit([...current, normalized]);
  }
  function removeAt(idx: number) {
    const next = current.slice();
    next.splice(idx, 1);
    commit(next);
  }
  function toggleSuggestion(s: string) {
    const lower = s.toLowerCase();
    if (currentLower.has(lower)) {
      commit(current.filter(t => t.toLowerCase() !== lower));
    } else {
      commit([...current, s]);
    }
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (draft.trim()) { addTag(draft); setDraft(""); }
    } else if (e.key === "Backspace" && draft === "" && current.length > 0) {
      e.preventDefault();
      removeAt(current.length - 1);
    }
  }
  function onBlur() {
    if (draft.trim()) { addTag(draft); setDraft(""); }
  }

  return (
    <div>
      <label className="text-xs text-muted-foreground mb-2 block">{label}</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {suggestions.map(s => {
          const active = currentLower.has(s.toLowerCase());
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleSuggestion(s)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
              }`}
            >
              {active ? "✓ " : ""}{s}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 min-h-[2.25rem] px-2 py-1.5 rounded-md border border-border bg-background focus-within:border-primary/60 transition-colors">
        {current.map((tag, idx) => (
          <span
            key={`${tag}-${idx}`}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-primary text-primary-foreground"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeAt(idx)}
              className="inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-white/20"
              aria-label={`Xoá ${tag}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          placeholder={current.length === 0 ? "Nhập tag rồi nhấn Enter…" : ""}
          className="flex-1 min-w-[8rem] bg-transparent outline-none text-sm h-6"
        />
      </div>
    </div>
  );
}

// ─── CommonTagsManager (manage shared suggestion list) ───────────────────────
function CommonTagsManager({ commonTags }: {
  commonTags: ReturnType<typeof useCommonTags>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  function submit() {
    if (!draft.trim()) return;
    const { added } = commonTags.add(draft);
    setDraft("");
    if (!added) {
      setHint("Đã có trong danh sách");
      setTimeout(() => setHint(null), 1500);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
      >
        {open ? "× Đóng quản lý đặc tính chung" : "+ Thêm đặc tính chung"}
      </button>
      {open && (
        <div className="mt-2 p-3 rounded-md border border-border bg-muted/30 space-y-2">
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
              placeholder="Ví dụ: sang trọng"
              className="text-sm h-8 flex-1"
            />
            <Button type="button" size="sm" onClick={submit} disabled={!draft.trim()} className="h-8">
              Thêm
            </Button>
          </div>
          {hint && <p className="text-[11px] text-amber-600">{hint}</p>}
          {commonTags.list.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {commonTags.list.map(t => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs border border-border bg-background text-muted-foreground"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() => commonTags.remove(t)}
                    className="inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Xoá đặc tính chung ${t}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground leading-snug">
            Đặc tính lưu trên trình duyệt này. Tag đã gắn vào sản phẩm không bị ảnh hưởng khi xoá khỏi danh sách chung.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── ProductDrawer ────────────────────────────────────────────────────────────
function ProductDrawer({ dress, categories, allProducts, defaultCategoryId, onClose, onSaved, onDeleted }: {
  dress: Dress | "new";
  categories: Category[];
  allProducts: Dress[];
  defaultCategoryId?: number | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const effectiveIsAdmin = true; // CMS Website mở toàn quyền cho mọi nhân viên
  const { toast } = useToast();
  const qc = useQueryClient();
  const isNew = dress === "new";
  type FormType = Omit<Dress, "id" | "createdAt">;
  const [form, setForm] = useState<FormType>(() => {
    if (isNew) {
      const base = emptyForm();
      if (defaultCategoryId) base.categoryId = defaultCategoryId;
      return base;
    }
    return dress as Dress;
  });
  // codeEditable: false for new (auto-gen), true for existing
  const [codeEditable, setCodeEditable] = useState<boolean>(!isNew);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingJobIds, setPendingJobIds] = useState<string[]>([]);
  const [imageSelectMode, setImageSelectMode] = useState(false);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [imageBulkPending, setImageBulkPending] = useState(false);
  const [moveImagesOpen, setMoveImagesOpen] = useState(false);
  const [moveImagesTargetId, setMoveImagesTargetId] = useState<number | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [publicLink, setPublicLink] = useState("");
  const [copied, setCopied] = useState(false);

  const excludeId = isNew ? undefined : (dress as Dress).id;
  // Check code với server cả ở chế độ auto (sản phẩm mới) để tự né mã trùng
  const codeCheck = useCodeCheck(form.code, excludeId, codeEditable || isNew);
  const commonTags = useCommonTags();

  const set = useCallback(<K extends keyof FormType>(k: K, v: FormType[K]) => {
    setForm(f => ({ ...f, [k]: v }));
  }, []);

  // Keep stable refs so the auto-code effect doesn't re-run on every data refetch
  const allProductsRef = useRef(allProducts);
  useEffect(() => { allProductsRef.current = allProducts; }, [allProducts]);
  const categoriesRef = useRef(categories);
  useEffect(() => { categoriesRef.current = categories; }, [categories]);

  // Auto-generate code: find first non-conflicting sequence number
  function regenerateAutoCode(catId: number | null, force = false): string {
    if (!catId) return "";
    const cat = categoriesRef.current.find(c => c.id === catId);
    if (!cat) return "";
    const prefix = getCatPrefix(cat.name);
    const existing = new Set(allProductsRef.current.map(d => (d.code ?? "").toUpperCase().trim()));
    let n = 1;
    let candidate = `${prefix}-${String(n).padStart(3, "0")}`;
    // Start from prefix+existing max if available
    const pat = new RegExp(`^${prefix}-?(\\d+)$`, "i");
    const maxNum = allProductsRef.current
      .map(d => d.code ? (d.code.match(pat)?.[1] ?? null) : null)
      .filter((v): v is string => v !== null)
      .map(Number)
      .reduce((a, b) => Math.max(a, b), 0);
    n = force ? 1 : maxNum + 1;
    while (existing.has(candidate)) {
      n++;
      candidate = `${prefix}-${String(n).padStart(3, "0")}`;
    }
    return candidate;
  }

  // Auto-generate code when category selection changes (only when readonly mode)
  useEffect(() => {
    if (!isNew || codeEditable) return;
    const suggested = regenerateAutoCode(form.categoryId);
    setForm(f => ({ ...f, code: suggested }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.categoryId, isNew, codeEditable]);

  // Chế độ auto: server báo mã trùng → tự tăng số xin mã kế tiếp (lặp đến khi trống)
  useEffect(() => {
    if (!isNew || codeEditable || codeCheck !== "taken") return;
    setForm(f => {
      const m = (f.code ?? "").match(/^(.*?)(\d+)$/);
      const next = m
        ? `${m[1]}${String(Number(m[2]) + 1).padStart(m[2].length, "0")}`
        : regenerateAutoCode(f.categoryId, true);
      return next && next !== f.code ? { ...f, code: next } : f;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeCheck, isNew, codeEditable]);

  const flatCatsList = useMemo(() => flattenCats(categories), [categories]);

  const images = useMemo(() => {
    const imgs: string[] = [];
    if (form.imageUrl) imgs.push(form.imageUrl);
    for (const x of (form.extraImages || [])) { if (x && !imgs.includes(x)) imgs.push(x); }
    return imgs;
  }, [form.imageUrl, form.extraImages]);

  function reorderImages(next: string[]) {
    setForm(f => ({ ...f, imageUrl: next[0] ?? null, extraImages: next.slice(1) }));
  }
  // Ảnh người dùng đã chủ động xoá trong phiên này — để khi lưu không bị
  // dữ liệu server (upload nền từ phiên khác) khôi phục lại
  const removedImagesRef = useRef<Set<string>>(new Set());
  const coverRemovedRef = useRef(false);

  function removeImage(src: string) {
    if (form.coverImageUrl === src) {
      if (!confirm(`Ảnh này đang là ảnh bìa website. Xoá ảnh này cũng sẽ xoá ảnh bìa. Tiếp tục?`)) return;
    }
    removedImagesRef.current.add(src);
    setForm(f => {
      const next = images.filter(x => x !== src);
      return {
        ...f,
        imageUrl: f.imageUrl === src ? (next[0] ?? null) : f.imageUrl,
        extraImages: (f.extraImages || []).filter(x => x !== src),
        coverImageUrl: f.coverImageUrl === src ? null : f.coverImageUrl,
      };
    });
  }
  function addImages(uploaded: UploadedImage[]) {
    const newPaths = uploaded.map(u => u.objectPath);
    setForm(f => {
      const current = [f.imageUrl, ...(f.extraImages || [])].filter(Boolean) as string[];
      const fresh = newPaths.filter(p => !current.includes(p));
      if (!fresh.length) return f;
      fresh.forEach(p => removedImagesRef.current.delete(p));
      const combined = [...(f.extraImages || []), ...fresh];
      if (!f.imageUrl) {
        return { ...f, imageUrl: combined[0], extraImages: combined.slice(1) };
      }
      return { ...f, extraImages: combined };
    });
  }
  function setCoverFromAlbum(src: string) {
    coverRemovedRef.current = false;
    setForm(f => ({ ...f, coverImageUrl: src }));
  }
  function removeCover() {
    coverRemovedRef.current = true;
    setForm(f => ({ ...f, coverImageUrl: null }));
  }
  function toggleImageSelect(src: string) {
    setSelectedImages(prev => {
      const next = new Set(prev);
      if (next.has(src)) next.delete(src); else next.add(src);
      return next;
    });
  }

  async function refreshFormFromServer(dressId: number) {
    const r = await fetch(`${CMS_BASE}/api/dresses/${dressId}`, { headers: authHeaders() });
    if (!r.ok) throw new Error("Không tải lại được sản phẩm");
    const updated = await r.json() as Dress;
    setForm(updated);
  }

  async function bulkDeleteImages() {
    if (isNew) return;
    const dressId = (dress as Dress).id;
    const toDelete = Array.from(selectedImages);
    if (!toDelete.length) return;
    const hasCover = toDelete.some(src => form.coverImageUrl === src);
    const msg = hasCover
      ? `Xoá ${toDelete.length} ảnh đã chọn? Một ảnh đang là ảnh bìa website — ảnh bìa cũng sẽ bị xoá.`
      : `Xoá ${toDelete.length} ảnh đã chọn khỏi album?`;
    if (!confirm(msg)) return;
    setImageBulkPending(true);
    try {
      const r = await fetch(`${CMS_BASE}/api/cms/product-images/batch`, {
        method: "DELETE", headers: authHeaders(),
        body: JSON.stringify({ dressId, images: toDelete }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error ?? "Lỗi xoá ảnh");
      await refreshFormFromServer(dressId);
      setSelectedImages(new Set());
      setImageSelectMode(false);
      qc.invalidateQueries({ queryKey: ["cms-products"] });
      toast({ title: "Đã xoá ảnh", description: `${json.affected ?? toDelete.length} ảnh đã xoá` });
    } catch (e) {
      toast({ title: "Không xoá được", description: e instanceof Error ? e.message : "Lỗi", variant: "destructive" });
    } finally {
      setImageBulkPending(false);
    }
  }

  async function bulkMoveImages() {
    if (isNew || !moveImagesTargetId) return;
    const dressId = (dress as Dress).id;
    const toMove = Array.from(selectedImages);
    if (!toMove.length) return;
    if (!confirm(`Chuyển ${toMove.length} ảnh sang sản phẩm khác?`)) return;
    setImageBulkPending(true);
    try {
      const r = await fetch(`${CMS_BASE}/api/cms/product-images/move-batch`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ sourceDressId: dressId, targetDressId: moveImagesTargetId, images: toMove }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error ?? "Lỗi chuyển ảnh");
      await refreshFormFromServer(dressId);
      setSelectedImages(new Set());
      setImageSelectMode(false);
      setMoveImagesOpen(false);
      setMoveImagesTargetId(null);
      qc.invalidateQueries({ queryKey: ["cms-products"] });
      toast({ title: "Đã chuyển ảnh", description: `${json.moved ?? toMove.length} ảnh đã chuyển` });
    } catch (e) {
      toast({ title: "Không chuyển được", description: e instanceof Error ? e.message : "Lỗi", variant: "destructive" });
    } finally {
      setImageBulkPending(false);
    }
  }



  useEffect(() => {
    if (isNew) return;
    const slug = form.slug || String((dress as Dress).id);
    const link = getPublicPageUrl(`/san-pham/${slug}`);
    setPublicLink(link);
    QRCode.toDataURL(link, { width: 280, margin: 2 }).then(setQrDataUrl).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (!form.name?.trim()) { setSaveError("Vui lòng nhập tên sản phẩm"); return; }
    if (!form.code?.trim()) { setSaveError("Vui lòng nhập mã sản phẩm"); return; }
    if (form.salePrice > 0 && form.salePrice >= form.rentalPrice) {
      setSaveError("Giá giảm phải nhỏ hơn giá thuê"); return;
    }
    // Only block on duplicate when in manual-edit mode
    if (codeEditable && codeCheck === "taken") { setSaveError("Mã sản phẩm đã được dùng, vui lòng chọn mã khác"); return; }
    if (codeEditable && codeCheck === "checking") { setSaveError("Đang kiểm tra mã, vui lòng đợi giây lát"); return; }
    setSaveError(null); setSaving(true);

    // Auto mode: backend báo trùng mã → tự tăng số và thử lại (tối đa 5 lần)
    const MAX_SAVE_ATTEMPTS = 5;
    let attempt = 0;
    let currentForm = form;
    while (attempt < MAX_SAVE_ATTEMPTS) {
      try {
        let payload = currentForm;
        if (!isNew) {
          // Merge album: giữ thứ tự + ảnh đã xoá ở local, bổ sung ảnh chỉ có
          // trên server (do upload nền từ phiên/tab khác gắn vào)
          const dressIdForMerge = (dress as Dress).id;
          const curR = await fetch(`${CMS_BASE}/api/dresses/${dressIdForMerge}`, { headers: authHeaders() });
          if (curR.ok) {
            const cur = await curR.json() as Dress;
            const localAlbum = [currentForm.imageUrl, ...(currentForm.extraImages || [])].filter(Boolean) as string[];
            const serverAlbum = [cur.imageUrl ?? cur.publicImageUrl, ...(cur.extraImages || [])].filter(Boolean) as string[];
            const removed = removedImagesRef.current;
            const merged = [
              ...localAlbum,
              ...serverAlbum.filter(p => !localAlbum.includes(p) && !removed.has(p)),
            ];
            let cover = currentForm.coverImageUrl ?? null;
            if (!cover && !coverRemovedRef.current && cur.coverImageUrl && !removed.has(cur.coverImageUrl)) {
              cover = cur.coverImageUrl;
            }
            // Quên/xoá ảnh bìa mà album còn ảnh → tự lấy ảnh đầu tiên làm bìa
            if (!cover && merged.length) cover = merged[0];
            payload = {
              ...currentForm,
              imageUrl: merged[0] ?? null,
              publicImageUrl: merged[0] ?? null,
              coverImageUrl: cover,
              extraImages: merged.slice(1),
            };
          }
        } else {
          // Sản phẩm mới: chưa chọn ảnh bìa mà album có ảnh → lấy ảnh đầu tiên
          const album = [currentForm.imageUrl, ...(currentForm.extraImages || [])].filter(Boolean) as string[];
          payload = {
            ...currentForm,
            imageUrl: album[0] ?? null,
            publicImageUrl: album[0] ?? null,
            coverImageUrl: currentForm.coverImageUrl ?? album[0] ?? null,
            extraImages: album.slice(1),
          };
        }
        const url = isNew ? `${CMS_BASE}/api/dresses` : `${CMS_BASE}/api/dresses/${(dress as Dress).id}`;
        const r = await fetch(url, { method: isNew ? "POST" : "PUT", headers: authHeaders(), body: JSON.stringify(payload) });
        const json = await r.json();
        if (r.ok) {
          const saved = json as Dress & { id?: number };
          const dressId = saved.id ?? (dress as Dress).id;
          const hadPending = pendingJobIds.length > 0;
          if (hadPending && dressId) {
            uploadQueueStore.bindDressJobs(pendingJobIds, dressId);
          }
          setPendingJobIds([]);
          const bgUploads = hadPending || uploadQueueStore.getActiveCount() > 0;
          if (bgUploads) {
            toast({ title: "Đã lưu", description: "Ảnh đang được tải lên nền — xem tiến trình ở icon ☁️ trên header." });
          }
          onSaved();
          break;
        }
        const err = json.error ?? "Lỗi lưu";
        const isDup = err.includes("23505") || err.toLowerCase().includes("code") || err.toLowerCase().includes("mã");
        if (isDup && isNew && !codeEditable && attempt < MAX_SAVE_ATTEMPTS - 1) {
          // Tự tăng số từ mã bị từ chối để xin mã kế tiếp
          const m = (currentForm.code ?? "").match(/^(.*?)(\d+)$/);
          const fresh = m
            ? `${m[1]}${String(Number(m[2]) + 1).padStart(m[2].length, "0")}`
            : regenerateAutoCode(currentForm.categoryId, true);
          currentForm = { ...currentForm, code: fresh };
          setForm(currentForm);
          attempt++;
          continue;
        }
        throw new Error(err);
      } catch (e) {
        setSaveError((e as Error).message);
        break;
      }
    }
    setSaving(false);
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

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 sm:bg-transparent" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-background shadow-2xl border-l border-border flex flex-col overflow-hidden">

        <div className="flex items-center gap-3 px-4 py-3 border-b bg-background sticky top-0 z-10">
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-base truncate">{isNew ? "Thêm sản phẩm mới" : form.name || "Sản phẩm"}</h2>
            {!isNew && form.code && <p className="text-xs text-muted-foreground font-mono">{form.code}</p>}
          </div>
          {!isNew && form.slug && (
            <a
              href={getPublicPageUrl(`/san-pham/${form.slug}`)}
              target="_blank"
              rel="noopener noreferrer"
              title="Xem sản phẩm trên website"
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted px-2 py-1.5 rounded-md transition-colors flex-shrink-0"
            >
              <Globe className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Xem sản phẩm</span>
            </a>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving || (codeEditable && codeCheck === "taken")} className="gap-1.5 flex-shrink-0">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {isNew ? "Tạo" : "Lưu"}
          </Button>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg text-muted-foreground flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain pb-24">
          {saveError && (
            <div className="m-4 p-3 rounded-xl bg-destructive/10 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {saveError}
            </div>
          )}

          <div className="p-4 space-y-4">
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Tên sản phẩm</label>
                  <Input value={form.name} onChange={e => set("name", e.target.value)} placeholder="Váy cưới đuôi cá luxury..." autoFocus={isNew} />
                </div>
                {/* Danh mục */}
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Danh mục</label>
                  <select
                    value={form.categoryId ?? ""}
                    onChange={e => set("categoryId", e.target.value ? +e.target.value : null)}
                    className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                  >
                    <option value="">— Không —</option>
                    {flatCatsList.map(({ cat, depth }) => (
                      <option key={cat.id} value={cat.id}>{"\u00a0".repeat(depth * 3)}{cat.name}</option>
                    ))}
                  </select>
                </div>

                {/* Mã sản phẩm */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-muted-foreground flex items-center gap-1">
                      Mã sản phẩm <span className="text-destructive">*</span>
                    </label>
                    {isNew && (
                      <button
                        type="button"
                        onClick={() => {
                          const next = !codeEditable;
                          setCodeEditable(next);
                          if (!next) {
                            // Switching to auto mode: regenerate a fresh code
                            const fresh = regenerateAutoCode(form.categoryId, true);
                            setForm(f => ({ ...f, code: fresh }));
                          }
                        }}
                        className="text-[11px] text-primary hover:underline flex items-center gap-1 leading-none"
                      >
                        <Edit2 className="w-2.5 h-2.5" />
                        {codeEditable ? "Dùng mã tự động" : "Sửa mã"}
                      </button>
                    )}
                  </div>

                  {!codeEditable ? (
                    /* Readonly auto-generated display */
                    <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-input bg-muted/40 font-mono text-sm">
                      <span className="flex-1 select-all">
                        {form.code || <span className="text-muted-foreground italic text-xs">Chọn danh mục để tạo mã…</span>}
                      </span>
                      {form.code && (
                        codeCheck === "checking" || codeCheck === "taken"
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground flex-shrink-0" />
                          : <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                      )}
                    </div>
                  ) : (
                    /* Editable input */
                    <div className="relative">
                      <Input
                        value={form.code ?? ""}
                        onChange={e => set("code", e.target.value.toUpperCase())}
                        placeholder="VD-001"
                        autoFocus
                        className={`font-mono pr-8 ${
                          codeCheck === "taken" ? "border-destructive focus-visible:ring-destructive/30" :
                          codeCheck === "ok" ? "border-emerald-500 focus-visible:ring-emerald-500/30" : ""
                        }`}
                      />
                      <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                        {codeCheck === "checking" && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
                        {codeCheck === "ok" && <Check className="w-3.5 h-3.5 text-emerald-500" />}
                        {codeCheck === "taken" && <X className="w-3.5 h-3.5 text-destructive" />}
                      </div>
                    </div>
                  )}

                  {codeCheck === "taken" && codeEditable && (
                    <p className="text-xs text-destructive mt-1">Mã sản phẩm này đã tồn tại</p>
                  )}
                  {codeCheck === "ok" && codeEditable && form.code && (
                    <p className="text-xs text-emerald-600 mt-1">Mã hợp lệ ✓</p>
                  )}
                </div>
              </div>

              {/* ── B. Ảnh sản phẩm: ảnh bìa + album (gộp từ tab Album ảnh cũ) ── */}
              <div className="space-y-4 border-t pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Ảnh sản phẩm</p>

                {/* Ảnh bìa website */}
                <div className="space-y-3">
                  <p className="text-[11px] font-medium text-muted-foreground">Ảnh bìa website</p>
                  {form.coverImageUrl ? (
                    <div className="relative group aspect-[3/4] w-32 rounded-lg overflow-hidden bg-muted">
                      <img src={getImageSrc(form.coverImageUrl) ?? form.coverImageUrl} alt="" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-all">
                        <div className="absolute top-1 right-1 hidden group-hover:flex flex-col gap-1">
                          <button
                            onClick={() => removeCover()}
                            className="w-6 h-6 bg-destructive/90 text-white rounded-full flex items-center justify-center"
                            title="Xoá ảnh bìa"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <span className="absolute bottom-1 left-1 bg-primary text-white text-[9px] px-1.5 py-0.5 rounded-full font-semibold pointer-events-none">
                        Bìa website
                      </span>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      Chưa có ảnh bìa.{images.length > 0
                        ? " Khi lưu sẽ tự lấy ảnh đầu tiên của album làm bìa — hoặc bấm chọn 1 ảnh bên dưới."
                        : " Upload ảnh album bên dưới, ảnh đầu tiên sẽ tự thành ảnh bìa khi lưu."}
                    </div>
                  )}
                  {images.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[11px] text-muted-foreground">Chọn từ album:</p>
                      <div className="flex gap-2 flex-wrap">
                        {images.map((src) => (
                          <button
                            key={src}
                            onClick={() => setCoverFromAlbum(src)}
                            className={`relative w-16 aspect-[3/4] rounded-lg overflow-hidden bg-muted border-2 transition-all hover:scale-105 ${
                              form.coverImageUrl === src ? "border-primary" : "border-transparent"
                            }`}
                            title="Đặt làm ảnh bìa website"
                          >
                            <img src={getImageSrc(src) ?? src} alt="" className="w-full h-full object-cover" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="mt-2">
                    <MultiImageUploader
                      multiple={false}
                      label="Hoặc upload ảnh bìa riêng"
                      attach={{ entity: "dress", mode: "cover", ...(!isNew ? { dressId: (dress as Dress).id } : {}) }}
                      onJobsQueued={(ids) => setPendingJobIds(prev => [...prev, ...ids])}
                      onUploaded={(imgs) => { if (imgs[0]) setCoverFromAlbum(imgs[0].objectPath); }}
                    />
                  </div>
                </div>

                {/* Album ảnh */}
                <div className="border-t pt-4 space-y-4">
                  <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Album: {images.length} / 20 ảnh{images.length > 0 && !imageSelectMode ? " • Kéo thả để đổi thứ tự" : ""}{imageSelectMode ? " • Bấm ảnh để chọn" : ""}
                    </p>
                    <div className="flex items-center gap-2">
                      {images.length >= 20 && (
                        <span className="text-xs text-orange-600">Đã đạt giới hạn 20 ảnh</span>
                      )}
                      {images.length > 0 && !isNew && (
                        <button
                          type="button"
                          onClick={() => {
                            setImageSelectMode(m => !m);
                            setSelectedImages(new Set());
                          }}
                          className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                            imageSelectMode ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"
                          }`}
                        >
                          {imageSelectMode ? "Huỷ chọn" : "Chọn ảnh"}
                        </button>
                      )}
                    </div>
                  </div>
                  {selectedImages.size > 0 && (
                    <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/60 border flex-wrap">
                      <span className="text-sm font-medium">
                        <span className="text-primary">{selectedImages.size}</span> ảnh đã chọn
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedImages(new Set())}
                        className="text-xs text-primary hover:underline"
                      >
                        Bỏ chọn tất cả
                      </button>
                      <div className="flex-1" />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={imageBulkPending}
                        onClick={bulkDeleteImages}
                        className="gap-1.5 h-8 text-destructive border-destructive/30 hover:bg-destructive/10"
                      >
                        {imageBulkPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        Xoá
                      </Button>
                      <Button
                        size="sm"
                        disabled={imageBulkPending}
                        onClick={() => { setMoveImagesTargetId(null); setMoveImagesOpen(true); }}
                        className="gap-1.5 h-8"
                      >
                        <FolderInput className="w-3.5 h-3.5" />
                        Chuyển sản phẩm
                      </Button>
                    </div>
                  )}
                  <DragSortImageGrid
                    images={images}
                    onReorder={reorderImages}
                    onRemove={removeImage}
                    selectMode={imageSelectMode}
                    selected={selectedImages}
                    onToggleSelect={toggleImageSelect}
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
                </div>
              </div>

              <div className="space-y-4 border-t pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Chi tiết sản phẩm</p>

                {/* Size chips */}
                <ChipSelect
                  label="Size / Số đo"
                  options={["XS","S","M","L","XL","XXL","XXXL","Free size","Big size","40-48kg","49-55kg","56-65kg","66-75kg"]}
                  value={form.sizeText ?? ""}
                  onChange={v => set("sizeText", v || null)}
                />

                {/* Màu sắc chips */}
                <ChipSelect
                  label="Màu sắc"
                  options={["Trắng","Kem","Đen","Đỏ","Đỏ đô","Hồng","Hồng pastel","Xanh","Xanh ngọc","Vàng","Tím","Nâu","Bạc","Vàng đồng"]}
                  value={form.colorText ?? ""}
                  onChange={v => set("colorText", v || null)}
                />

                {/* Tags gợi ý */}
                <div>
                  <ChipSuggest
                    label="Tags / Đặc tính"
                    suggestions={commonTags.list}
                    value={form.tagsText ?? ""}
                    onChange={v => set("tagsText", v || null)}
                  />
                  <CommonTagsManager commonTags={commonTags} />
                </div>
              </div>

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
                  <label className="text-xs text-muted-foreground mb-1 block">Giá giảm (nếu có)</label>
                  <CurrencyInput value={form.salePrice} onChange={v => set("salePrice", Number(v.replace(/\D/g, "")) || 0)} placeholder="Để trống nếu không giảm giá" />
                  {form.salePrice > 0 && form.rentalPrice > 0 && form.salePrice >= form.rentalPrice && (
                    <p className="text-xs text-destructive mt-1">Giá giảm phải nhỏ hơn giá thuê</p>
                  )}
                  {form.salePrice > 0 && form.salePrice < form.rentalPrice && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Website sẽ hiện: <span className="line-through">{formatVND(form.rentalPrice)}</span>{" "}
                      <span className="text-emerald-600 font-semibold">{formatVND(form.salePrice)}</span>
                    </p>
                  )}
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
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="text-xs text-muted-foreground block">Tình trạng outfit (nhãn marketing)</label>
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
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Nhãn sẽ hiện trên ảnh bìa ở trang công khai.
                  </p>
                </div>
              </div>

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

              {/* ── QR & Link (chỉ sản phẩm đã tạo) ── */}
              {!isNew && (
                <div className="space-y-5 border-t pt-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">QR & Link</p>
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
        </div>

        <div className="border-t p-4 bg-background">
          <Button
            className="w-full gap-2"
            onClick={handleSave}
            disabled={saving || (codeEditable && codeCheck === "taken")}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isNew ? "Tạo sản phẩm" : "Lưu thay đổi"}
          </Button>
        </div>
      </div>

      {moveImagesOpen && !isNew && (
        <Modal title={`Chuyển ${selectedImages.size} ảnh sang sản phẩm khác`} onClose={() => setMoveImagesOpen(false)}>
          <p className="text-sm text-muted-foreground mb-3">Chọn sản phẩm đích:</p>
          <select
            className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
            value={moveImagesTargetId ?? ""}
            onChange={e => setMoveImagesTargetId(e.target.value ? +e.target.value : null)}
          >
            <option value="">— Chọn sản phẩm —</option>
            {allProducts
              .filter(d => d.id !== (dress as Dress).id)
              .map(d => (
                <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
              ))}
          </select>
          <ModalFooter
            onClose={() => setMoveImagesOpen(false)}
            onConfirm={bulkMoveImages}
            confirmDisabled={!moveImagesTargetId}
            loading={imageBulkPending}
            confirmLabel="Chuyển"
          />
        </Modal>
      )}
    </>
  );
}

// ─── Modal + ModalFooter ──────────────────────────────────────────────────────
function Modal({ title, children, onClose, wide = false }: {
  title: string; children: React.ReactNode; onClose: () => void; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3 sm:p-4" onClick={onClose}>
      <div
        className={`bg-background rounded-2xl shadow-xl w-full ${wide ? "max-w-md" : "max-w-sm"} max-h-[90vh] overflow-y-auto`}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b flex items-center justify-between sticky top-0 bg-background">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
function ModalFooter({ onClose, onConfirm, confirmDisabled, loading, confirmLabel }: {
  onClose: () => void; onConfirm: () => void;
  confirmDisabled?: boolean; loading?: boolean; confirmLabel: string;
}) {
  return (
    <div className="mt-5 pt-3 border-t flex justify-end gap-2">
      <Button variant="outline" onClick={onClose}>Huỷ</Button>
      <Button onClick={onConfirm} disabled={confirmDisabled || loading}>
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {confirmLabel}
      </Button>
    </div>
  );
}

// ─── Category QR modal ────────────────────────────────────────────────────────
function CatQrModal({ cat, link, breadcrumb, onClose }: {
  cat: Category; link: string; breadcrumb: string; onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dataUrl, setDataUrl] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, link, { width: 260, margin: 2, errorCorrectionLevel: "M" }).catch(console.error);
    QRCode.toDataURL(link, { width: 600, margin: 2 }).then(setDataUrl).catch(() => {});
  }, [link]);

  function download() {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `QR-${cat.id}-${cat.name.replace(/[^\w\u00C0-\u1EF9]+/g, "_")}.png`;
    a.click();
  }
  function print() {
    const w = window.open("", "_blank", "width=600,height=800");
    if (!w) return;
    w.document.write(`<html><head><title>QR ${cat.name}</title>
      <style>@page{size:A6;margin:8mm}body{font-family:system-ui,sans-serif;text-align:center;padding:8mm;color:#111}h2{font-size:16px;margin:4mm 0 2mm}p.bc{font-size:11px;color:#555;margin:0 0 4mm}img{width:80mm;height:80mm}p.link{font-size:10px;color:#888;margin-top:4mm;word-break:break-all}</style></head><body>
      <h2>Amazing Studio · Cho thuê đồ</h2><p class="bc">${breadcrumb}</p>
      <img src="${dataUrl}" alt="QR" /><p class="link">${link}</p></body></html>`);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 250);
  }

  return (
    <Modal title={`QR — ${cat.name}`} onClose={onClose} wide>
      <div className="text-center space-y-3">
        <p className="text-xs text-muted-foreground">{breadcrumb}</p>
        <div className="inline-block p-3 bg-white rounded-xl border border-border">
          <canvas ref={canvasRef} />
        </div>
        <p className="text-[11px] text-muted-foreground break-all px-2">{link}</p>
        <div className="flex justify-center gap-2 pt-2">
          <Button variant="outline" onClick={() => { navigator.clipboard?.writeText(link).then(() => toast({ title: "Đã copy link" }), () => prompt("Copy link:", link)); }}>
            <LinkIcon className="w-4 h-4" /> Copy
          </Button>
          <Button variant="outline" onClick={download} disabled={!dataUrl}>
            <Download className="w-4 h-4" /> PNG
          </Button>
          <Button onClick={print} disabled={!dataUrl}>
            <Printer className="w-4 h-4" /> In A6
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── CategoryNode (recursive sidebar item) ───────────────────────────────────
function CategoryNode({ cat, depth, allCats, expanded, selectedCatId, onSelect, onToggle, onAddChild, onAddProduct, onEdit, onDelete, onCover, onQr, onToggleActive, onReorder, saving }: {
  cat: Category; depth: number; allCats: Category[];
  expanded: Set<number>; selectedCatId: number | null;
  onSelect: (id: number) => void;
  onToggle: (id: number) => void;
  onAddChild: (parentId: number) => void;
  onAddProduct: (catId: number) => void;
  onEdit: (cat: Category) => void;
  onDelete: (cat: Category) => void;
  onCover: (cat: Category) => void;
  onQr: (cat: Category) => void;
  onToggleActive: (cat: Category) => void;
  // onMoveAllToChild removed – product-first flow only via tick selection
  onReorder: (parentId: number | null, orderedIds: number[]) => void;
  saving: boolean;
}) {
  const [showActions, setShowActions] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const children = allCats.filter(c => c.parentId === cat.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const isOpen = expanded.has(cat.id);
  const isSelected = selectedCatId === cat.id;
  const isInactive = cat.isActive === 0;
  const cover = cat.coverImageUrl ?? cat.fallbackCover ?? null;

  const ACTION_ITEMS = [
    { icon: <Shirt className="w-4 h-4 text-emerald-600" />, label: "Thêm sản phẩm", fn: () => { onAddProduct(cat.id); setMobileSheetOpen(false); } },
    { icon: <FolderPlus className="w-4 h-4" />, label: "Thêm mục con", fn: () => { onAddChild(cat.id); setMobileSheetOpen(false); } },
    { icon: <QrCode className="w-4 h-4" />, label: "Mã QR", fn: () => { onQr(cat); setMobileSheetOpen(false); } },
    { icon: <ImageIcon className="w-4 h-4" />, label: "Ảnh bìa", fn: () => { onCover(cat); setMobileSheetOpen(false); } },
    { icon: cat.isActive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />, label: cat.isActive ? "Ẩn danh mục" : "Hiện danh mục", fn: () => { onToggleActive(cat); setMobileSheetOpen(false); } },
    { icon: <Edit2 className="w-4 h-4" />, label: "Sửa", fn: () => { onEdit(cat); setMobileSheetOpen(false); } },
    { icon: <Trash2 className="w-4 h-4 text-destructive" />, label: "Xoá", fn: () => { onDelete(cat); setMobileSheetOpen(false); }, danger: true },
  ];

  return (
    <div>
      <div
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        className={`group flex items-center gap-1 py-1.5 pr-1 rounded-lg cursor-pointer transition-colors ${
          isSelected ? "bg-primary/10" : "hover:bg-muted/60"
        } ${isInactive ? "opacity-50" : ""}`}
      >
        <button
          onClick={e => { e.stopPropagation(); if (children.length > 0) onToggle(cat.id); }}
          className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-muted-foreground"
        >
          {children.length > 0
            ? (isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)
            : <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />}
        </button>

        {cover ? (
          <div className="flex-shrink-0 w-6 h-6 rounded overflow-hidden">
            <LazyImage src={cover} className="w-full h-full" />
          </div>
        ) : (
          <Tag className="flex-shrink-0 w-3.5 h-3.5 text-muted-foreground/50" />
        )}

        <button
          className={`flex-1 text-left text-sm truncate min-w-0 py-1 ${isSelected ? "font-semibold text-primary" : ""}`}
          onClick={() => onSelect(cat.id)}
        >
          {cat.name}
        </button>

        {cat.productCount > 0 && (
          <span className="flex-shrink-0 text-[10px] text-muted-foreground tabular-nums mr-0.5">{cat.productCount}</span>
        )}

        {/* Mobile: always-visible action trigger */}
        <button
          onClick={e => { e.stopPropagation(); setMobileSheetOpen(true); }}
          className="flex-shrink-0 flex md:hidden w-10 h-10 items-center justify-center rounded hover:bg-muted"
          aria-label="Thao tác"
        >
          <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
        </button>

        {/* Desktop: hover-only actions */}
        <div className="flex-shrink-0 hidden md:group-hover:flex items-center gap-0.5">
          <button
            onClick={e => { e.stopPropagation(); onAddProduct(cat.id); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-emerald-100 text-emerald-600"
            title="Thêm sản phẩm"
          >
            <Shirt className="w-3 h-3" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); setShowActions(v => !v); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted"
            title="Thêm tùy chỉnh"
          >
            <MoreHorizontal className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Mobile action sheet */}
      <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
        <SheetContent side="bottom" className="h-auto max-h-[70vh] rounded-t-2xl px-0 pb-6">
          <SheetHeader className="px-4 pb-2 border-b">
            <SheetTitle className="text-base">{cat.name}</SheetTitle>
            <SheetDescription className="text-xs">
              {cat.productCount} sản phẩm · {children.length} mục con
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col py-1">
            {ACTION_ITEMS.map((action, i) => (
              <button
                key={i}
                onClick={action.fn}
                disabled={saving}
                className={`flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted transition-colors text-left ${
                  action.danger ? "text-destructive" : "text-foreground"
                }`}
              >
                {action.icon}
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* Desktop inline action buttons */}
      {showActions && (
        <div
          style={{ paddingLeft: `${depth * 14 + 24}px` }}
          className="hidden md:flex flex-wrap gap-1 pb-1"
        >
          {[
            { icon: <FolderPlus className="w-3 h-3" />, label: "Mục con", fn: () => { onAddChild(cat.id); setShowActions(false); } },
            { icon: <QrCode className="w-3 h-3" />, label: "QR", fn: () => { onQr(cat); setShowActions(false); } },
            { icon: <ImageIcon className="w-3 h-3" />, label: "Bìa", fn: () => { onCover(cat); setShowActions(false); } },
            { icon: cat.isActive ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />, label: cat.isActive ? "Ẩn" : "Hiện", fn: () => { onToggleActive(cat); setShowActions(false); } },
            { icon: <Edit2 className="w-3 h-3" />, label: "Sửa", fn: () => { onEdit(cat); setShowActions(false); } },
            { icon: <Trash2 className="w-3 h-3 text-destructive" />, label: "Xoá", fn: () => { onDelete(cat); setShowActions(false); } },
          ].map((action, i) => (
            <button
              key={i}
              onClick={action.fn}
              disabled={saving}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors"
            >
              {action.icon} {action.label}
            </button>
          ))}
          <GoldenHourCategoryButton categoryId={cat.id} categoryName={cat.name} />
        </div>
      )}

      {isOpen && children.length > 0 && (
        <SortableList
          items={children}
          onReorder={ids => onReorder(cat.id, ids)}
          renderItem={child => (
            <CategoryNode
              cat={child}
              depth={depth + 1}
              allCats={allCats}
              expanded={expanded}
              selectedCatId={selectedCatId}
              onSelect={onSelect}
              onToggle={onToggle}
              onAddChild={onAddChild}
              onAddProduct={onAddProduct}
              onEdit={onEdit}
              onDelete={onDelete}
              onCover={onCover}
              onQr={onQr}
              onToggleActive={onToggleActive}
              onReorder={onReorder}
              saving={saving}
            />
          )}
        />
      )}
    </div>
  );
}

// ─── BulkUploadModal (preserved from products-rental) ────────────────────────
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
      file: f, previewUrl: URL.createObjectURL(f),
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
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const { blob, mimeType } = await convertToWebP(item.file);
        const outName = (item.file.name || "image").replace(/\.[^.]+$/, "") + ".webp";
        const objectPath = await uploadFileViaPresign(blob, outName, mimeType);
        const postResp = await fetch(`${CMS_BASE}/api/dresses`, {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ name: item.name, code: item.name, publicImageUrl: objectPath, isPublic: 0, cmsStatus: "draft", rentalPrice: 0, depositRequired: 0 }),
        });
        if (!postResp.ok) {
          const j = await postResp.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error ?? `HTTP ${postResp.status}`);
        }
      } catch (e) { errs.push(`${item.name}: ${String(e)}`); }
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
          <h2 className="font-semibold text-base flex items-center gap-2"><Upload className="w-4 h-4 text-primary" /> Upload hàng loạt</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {stage === "pick" && (
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); handleFiles(Array.from(e.dataTransfer.files)); }}
              className="border-2 border-dashed border-border rounded-xl p-10 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
            >
              <Upload className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
              <p className="font-medium">Kéo thả hoặc bấm để chọn nhiều ảnh</p>
              <p className="text-sm text-muted-foreground mt-1">Mỗi ảnh = 1 sản phẩm nháp</p>
              <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
                onChange={e => { handleFiles(Array.from(e.target.files ?? [])); if (inputRef.current) inputRef.current.value = ""; }} />
            </div>
          )}
          {stage === "preview" && (
            <div>
              <p className="text-sm text-muted-foreground mb-3">{items.length} ảnh. Bấm tên để đổi.</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-4">
                {items.map((it, i) => (
                  <div key={i} className="relative">
                    <img src={it.previewUrl} alt="" className="w-full aspect-[3/4] object-cover rounded-lg" />
                    <input value={it.name}
                      onChange={e => setItems(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                      className="absolute bottom-0 inset-x-0 text-[10px] bg-black/60 text-white px-1 py-0.5 text-center rounded-b-lg" />
                    <button onClick={() => { URL.revokeObjectURL(it.previewUrl); setItems(prev => prev.filter((_, j) => j !== i)); }}
                      className="absolute top-1 right-1 w-5 h-5 bg-destructive/80 text-white rounded-full flex items-center justify-center">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
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
                <div className="h-full bg-primary transition-all duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
            </div>
          )}
          {stage === "done" && (
            <div className="text-center py-6">
              <Check className="w-12 h-12 mx-auto mb-3 text-emerald-500" />
              <p className="font-semibold">Đã tạo {progress.total - errors.length} / {progress.total} sản phẩm</p>
              {errors.length > 0 && <div className="mt-3 text-left text-xs text-destructive space-y-1">{errors.map((e, i) => <p key={i}>{e}</p>)}</div>}
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t flex gap-3">
          {stage === "done" ? (
            <Button className="flex-1" onClick={() => { onCreated(); onClose(); }}>Xong — về danh sách</Button>
          ) : stage === "preview" ? (
            <>
              <button onClick={onClose} className="flex-1 py-2.5 text-sm border border-border rounded-xl hover:bg-muted">Huỷ</button>
              <Button className="flex-1" onClick={handleCreate} disabled={!items.length}>Tạo {items.length} sản phẩm</Button>
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

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function CmsCategoriesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const effectiveIsAdmin = true; // CMS Website mở toàn quyền cho mọi nhân viên

  // Category tree state
  const [expanded, setExpanded] = useState<Set<number>>(() => loadExpanded());
  const [addUnderParent, setAddUnderParent] = useState<number | "root" | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newCatSlug, setNewCatSlug] = useState("");
  const [editingCat, setEditingCat] = useState<Category | null>(null);
  const [editDraftName, setEditDraftName] = useState("");
  const [editDraftSlug, setEditDraftSlug] = useState("");
  const [coverFor, setCoverFor] = useState<Category | null>(null);
  const [qrFor, setQrFor] = useState<Category | null>(null);
  // moveAllToChild flow removed – product-first via tick selection only

  // Product panel state
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null);
  const [editingDress, setEditingDress] = useState<Dress | "new" | null>(null);
  const [search, setSearch] = useState("");
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  // ── Product-first multi-select (tick & move) ────────────────────
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveTargetCatId, setMoveTargetCatId] = useState<number | null>(null);
  const bulkMove = useBulkMove(qc);
  const bulkDelete = useBulkDelete(qc);
  const bulkPriority = useBulkPriority(qc);

  function handleBulkPriority(isPriority: boolean) {
    bulkPriority.mutate(
      { ids: Array.from(selected), isPriority },
      {
        onSuccess: (r) => {
          setSelected(new Set());
          setSelectMode(false);
          toast({
            title: isPriority ? "Đã bật ưu tiên hiển thị" : "Đã bỏ ưu tiên",
            description: isPriority
              ? `${r.affected} sản phẩm sẽ hiện lên đầu danh sách`
              : `${r.affected} sản phẩm quay về thứ tự theo ngày tạo`,
          });
        },
        onError: (e: Error) => toast({ title: "Không cập nhật được", description: e.message, variant: "destructive" }),
      }
    );
  }

  useEffect(() => {
    if (selected.size === 0) setSelectMode(false);
  }, [selected.size]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && selected.size > 0) setSelected(new Set());
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);

  function toggleSelectId(id: number) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  // Mobile: 2-panel navigation (catList | productList)
  const [mobileView, setMobileView] = useState<"cats" | "products">("cats");

  useEffect(() => { saveExpanded(expanded); }, [expanded]);

  // Sync mobileView with selectedCatId to prevent dead-end states on mobile
  useEffect(() => {
    if (!selectedCatId && mobileView === "products") {
      setMobileView("cats");
    }
  }, [selectedCatId, mobileView]);

  // Queries
  const { data: allCats = [], isLoading: catsLoading } = useQuery<Category[]>({
    queryKey: ["cms-categories"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/categories?type=dress`, { headers: authHeaders() }).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: allProducts = [], isLoading: productsLoading } = useQuery<Dress[]>({
    queryKey: ["cms-products"],
    queryFn: () => fetch(`${CMS_BASE}/api/dresses`, { headers: authHeaders() }).then(r => r.json()),
    staleTime: 0,
  });

  // Derived data
  const dressCats = useMemo(() => allCats.filter(c => c.type === "dress"), [allCats]);
  const rootCats = useMemo(() => dressCats.filter(c => c.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder), [dressCats]);

  const selectedCat = useMemo(() => dressCats.find(c => c.id === selectedCatId) ?? null, [dressCats, selectedCatId]);
  const breadcrumb = useMemo(() => selectedCatId ? buildBreadcrumb(dressCats, selectedCatId) : "", [dressCats, selectedCatId]);

  const descendantIds = useMemo(() => {
    if (!selectedCatId) return null;
    return getDescendantIds(dressCats, selectedCatId);
  }, [selectedCatId, dressCats]);

  const filteredProducts = useMemo(() => {
    // Hiện sản phẩm trong danh mục đang chọn + toàn bộ con cháu.
    if (!descendantIds) return [];
    let list = allProducts.filter(d => d.categoryId !== null && descendantIds.has(d.categoryId));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(d =>
        d.name.toLowerCase().includes(q) ||
        (d.code || "").toLowerCase().includes(q) ||
        (d.colorText || d.color || "").toLowerCase().includes(q) ||
        (d.tagsText || "").toLowerCase().includes(q)
      );
    }
    // Ưu tiên hiển thị lên đầu (mới ghim trước), còn lại theo ngày tạo mới nhất
    return [...list].sort((a, b) =>
      Number(b.isPriority) - Number(a.isPriority) ||
      (b.priorityAt ? Date.parse(b.priorityAt) : 0) - (a.priorityAt ? Date.parse(a.priorityAt) : 0) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt)
    );
  }, [allProducts, descendantIds, search]);

  const visibleCount = filteredProducts.filter(d => d.isPublic === 1 && d.cmsStatus === "visible").length;

  // Mutations
  const reorderCats = useMutation({
    mutationFn: (orderedIds: number[]) =>
      fetch(`${CMS_BASE}/api/cms/categories/reorder`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ order: orderedIds.map((id, idx) => ({ id, sortOrder: idx })) }),
      }).then(async r => { if (!r.ok) throw new Error("Lỗi sắp xếp"); }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cms-categories"] }),
  });

  function handleReorderCats(_parentId: number | null, orderedIds: number[]) {
    reorderCats.mutate(orderedIds);
  }

  const addCat = useMutation({
    mutationFn: (p: { name: string; parentId: number | null }) =>
      fetch(`${CMS_BASE}/api/cms/categories`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ type: "dress", parentId: p.parentId, name: p.name.trim(), slug: newCatSlug.trim() || null }),
      }).then(async r => { if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi"); return r.json() as Promise<Category>; }),
    onSuccess: (created: Category) => {
      qc.invalidateQueries({ queryKey: ["cms-categories"] });
      setAddUnderParent(null); setNewCatName(""); setNewCatSlug("");
      if (created.parentId != null) setExpanded(s => { const n = new Set(s); n.add(created.parentId!); return n; });
    },
    onError: (e: Error) => toast({ title: "Không tạo được danh mục", description: e.message, variant: "destructive" }),
  });

  const saveCat = useMutation({
    mutationFn: (c: { id: number; name?: string; slug?: string; coverImageUrl?: string | null; isActive?: number }) => {
      const { id, ...body } = c;
      return fetch(`${CMS_BASE}/api/cms/categories/${id}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify(body),
      }).then(async r => { if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi lưu"); });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-categories"] }); setEditingCat(null); setCoverFor(null); },
    onError: (e: Error) => toast({ title: "Không lưu được", description: e.message, variant: "destructive" }),
  });

  const deleteCat = useMutation({
    mutationFn: (id: number) =>
      fetch(`${CMS_BASE}/api/cms/categories/${id}`, { method: "DELETE", headers: authHeaders() })
        .then(async r => { if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi xoá"); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-categories"] });
      qc.invalidateQueries({ queryKey: ["cms-products"] });
    },
    onError: (e: Error) => toast({ title: "Không xoá được", description: e.message, variant: "destructive" }),
  });

  // moveAllMut removed – product-first via tick selection only

  const togglePublic = useMutation({
    mutationFn: ({ id, isPublic, cmsStatus }: { id: number; isPublic: number; cmsStatus: string }) =>
      fetch(`${CMS_BASE}/api/dresses/${id}`, {
        method: "PUT", headers: authHeaders(), body: JSON.stringify({ isPublic, cmsStatus }),
      }).then(async r => { if (!r.ok) throw new Error("Lỗi"); }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cms-products"] }),
  });

  function toggleExpand(id: number) {
    setExpanded(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  function handleSelectCat(id: number) {
    setSelectedCatId(prev => {
      if (prev === id) {
        // Deselecting — stay on cats view on mobile
        setMobileView("cats");
        return null;
      }
      // Selecting new — switch to products view on mobile
      setMobileView("products");
      return id;
    });
    setSearch("");
  }

  function handleTogglePublic(d: Dress) {
    const isVis = d.isPublic === 1 && d.cmsStatus === "visible";
    setTogglingId(d.id);
    togglePublic.mutate({ id: d.id, isPublic: isVis ? 0 : 1, cmsStatus: isVis ? "hidden" : "visible" },
      { onSettled: () => setTogglingId(null) });
  }

  function handleDeleteCat(cat: Category) {
    const children = dressCats.filter(c => c.parentId === cat.id);
    const msg = children.length > 0
      ? `Xoá "${cat.name}" và tất cả mục con (${children.length}) vào thùng rác?\nSản phẩm thuộc mục sẽ bị bỏ link.`
      : `Đưa "${cat.name}" vào thùng rác?${cat.productCount > 0 ? `\n${cat.productCount} sản phẩm sẽ bị bỏ link.` : ""}`;
    if (confirm(msg)) {
      deleteCat.mutate(cat.id);
      if (selectedCatId === cat.id) setSelectedCatId(null);
    }
  }

  function buildPublicLink(cat: Category): string {
    return getPublicPageUrl(`/cho-thue-do?categoryId=${cat.id}`);
  }

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden relative">

      {/* ── Left: Category Tree ─────────────────────────────────────────── */}
      <aside className={`w-full md:w-60 xl:w-72 flex-shrink-0 border-r flex flex-col bg-muted/10 overflow-hidden ${mobileView === "cats" ? "flex-1 md:flex-initial" : "hidden md:flex"}`}>
        <div className="flex items-center justify-between px-3 py-3 border-b bg-background">
          <h2 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
            <Tag className="w-3.5 h-3.5 text-primary" /> Danh mục
          </h2>
          <div className="flex items-center gap-0.5">
            <a
              href={getPublicPageUrl("/cho-thue-do")}
              target="_blank"
              rel="noopener noreferrer"
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Xem trang Cho thuê đồ trên website"
            >
              <Globe className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={() => { setAddUnderParent("root"); setNewCatName(""); setNewCatSlug(""); }}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Thêm mục gốc"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-1 px-1">
          {catsLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : rootCats.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground px-4">
              <Tag className="w-8 h-8 mx-auto mb-2 opacity-20" />
              <p className="text-xs">Chưa có danh mục</p>
              <button
                onClick={() => { setAddUnderParent("root"); setNewCatName(""); setNewCatSlug(""); }}
                className="mt-2 text-xs text-primary hover:underline"
              >
                + Thêm mục gốc
              </button>
            </div>
          ) : (
            <SortableList
              items={rootCats}
              onReorder={ids => handleReorderCats(null, ids)}
              renderItem={cat => (
                <CategoryNode
                  cat={cat}
                  depth={0}
                  allCats={dressCats}
                  expanded={expanded}
                  selectedCatId={selectedCatId}
                  onSelect={handleSelectCat}
                  onToggle={toggleExpand}
                  onAddChild={parentId => { setAddUnderParent(parentId); setNewCatName(""); setNewCatSlug(""); }}
                  onAddProduct={catId => { setSelectedCatId(catId); setEditingDress("new"); }}
                  onEdit={cat => { setEditingCat(cat); setEditDraftName(cat.name); setEditDraftSlug(cat.slug ?? ""); }}
                  onDelete={handleDeleteCat}
                  onCover={cat => setCoverFor(cat)}
                  onQr={cat => setQrFor(cat)}
                  onToggleActive={cat => saveCat.mutate({ id: cat.id, isActive: cat.isActive ? 0 : 1 })}
                  onReorder={handleReorderCats}
                  saving={saveCat.isPending || deleteCat.isPending}
                />
              )}
            />
          )}
        </div>
      </aside>

      {/* ── Right: Products Panel ───────────────────────────────────────── */}
      <main className={`flex-1 flex flex-col overflow-hidden ${mobileView === "products" ? "flex" : "hidden md:flex"}`}>
        {selectedCat ? (
          <>
            <div className="flex items-center justify-between px-4 py-3 border-b bg-background gap-3">
              <div className="min-w-0 flex-1">
                {/* Mobile back button */}
                <button
                  onClick={() => { setMobileView("cats"); setSelectedCatId(null); }}
                  className="md:hidden flex items-center gap-1 text-xs text-primary mb-1"
                >
                  <ArrowLeft className="w-3 h-3" /> Danh mục
                </button>
                <h1 className="font-bold text-base truncate flex items-center gap-2">
                  <Shirt className="w-4 h-4 text-primary flex-shrink-0" />
                  {selectedCat.name}
                </h1>
                {breadcrumb && breadcrumb !== selectedCat.name && (
                  <p className="text-xs text-muted-foreground truncate">{breadcrumb}</p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  {filteredProducts.length} sản phẩm · {visibleCount} hiển thị
                </p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <a
                  href={buildPublicLink(selectedCat)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center w-9 h-9 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Xem danh mục trên website"
                >
                  <Globe className="w-4 h-4" />
                </a>
                <button
                  onClick={() => setBulkOpen(true)}
                  className="hidden sm:flex items-center gap-1.5 h-9 px-3 text-sm border border-border rounded-lg hover:bg-muted transition-colors"
                  title="Upload hàng loạt"
                >
                  <Upload className="w-4 h-4" />
                </button>
                <Button
                  size="sm"
                  variant={selectMode ? "default" : "secondary"}
                  onClick={() => { if (selectMode) { setSelected(new Set()); setSelectMode(false); } else setSelectMode(true); }}
                  className="gap-1.5 whitespace-nowrap"
                >
                  <Check className="w-4 h-4" />
                  <span className="hidden sm:inline">{selectMode ? "Xong" : "Tích chọn"}</span>
                  <span className="sm:hidden">{selectMode ? "Xong" : "Chọn"}</span>
                </Button>
                <Button onClick={() => setEditingDress("new")} className="gap-1.5 whitespace-nowrap">
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline">Thêm sản phẩm</span>
                  <span className="sm:hidden">Thêm</span>
                </Button>
              </div>
            </div>

            <div className="px-4 py-2 border-b bg-background">
              <div className="relative max-w-sm">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Tên, mã, màu, tags..."
                  className="pl-8 h-8 text-sm w-full"
                />
                {search && (
                  <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                    <X className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {productsLoading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-center">
                  <Shirt className="w-12 h-12 mb-3 opacity-20" />
                  <p className="font-medium">{search ? "Không tìm thấy sản phẩm" : "Chưa có sản phẩm trong danh mục này"}</p>
                  {!search && (
                    <Button size="sm" className="mt-4 gap-1.5" onClick={() => setEditingDress("new")}>
                      <Plus className="w-4 h-4" /> Thêm sản phẩm đầu tiên
                    </Button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {filteredProducts.map(d => (
                    <ProductCard
                      key={d.id}
                      dress={d}
                      onSelect={() => setEditingDress(d)}
                      onTogglePublic={handleTogglePublic}
                      toggling={togglingId === d.id}
                      selectMode={selectMode}
                      isSelected={selected.has(d.id)}
                      onToggleSelect={e => { e.stopPropagation(); toggleSelectId(d.id); }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* ── Bottom action bar (tick & move) ──────────────────────────────────────────── */}
            {selected.size > 0 && (
              <div className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t shadow-lg px-4 py-3 flex items-center gap-3">
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
                    const allIds = filteredProducts.map(d => d.id);
                    const allSelected = allIds.every(id => selected.has(id));
                    setSelected(allSelected ? new Set() : new Set(allIds));
                  }}
                  className="text-xs text-primary hover:underline flex-shrink-0"
                >
                  {filteredProducts.every(d => selected.has(d.id)) ? "Bỏ chọn tất cả" : "Chọn tất cả"}
                </button>
                <div className="flex-1" />
                {(() => {
                  const selectedDresses = filteredProducts.filter(d => selected.has(d.id));
                  const allPriority = selectedDresses.length > 0 && selectedDresses.every(d => d.isPriority);
                  return allPriority ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleBulkPriority(false)}
                      disabled={bulkPriority.isPending}
                      className="gap-1.5 h-9 px-3"
                    >
                      {bulkPriority.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <StarOff className="w-4 h-4" />}
                      <span className="hidden sm:inline">Bỏ ưu tiên</span>
                      <span className="sm:hidden">Bỏ ƯT</span>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleBulkPriority(true)}
                      disabled={bulkPriority.isPending}
                      className="gap-1.5 h-9 px-3 text-amber-600 border-amber-400/50 hover:bg-amber-50"
                    >
                      {bulkPriority.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Star className="w-4 h-4" />}
                      <span className="hidden sm:inline">Ưu tiên hiển thị</span>
                      <span className="sm:hidden">Ưu tiên</span>
                    </Button>
                  );
                })()}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (!confirm(`Xoá ${selected.size} sản phẩm đã chọn?`)) return;
                    bulkDelete.mutate(
                      { ids: Array.from(selected) },
                      {
                        onSuccess: async (r) => {
                          await qc.refetchQueries({ queryKey: ["cms-products"] });
                          await qc.refetchQueries({ queryKey: ["cms-categories"] });
                          setSelected(new Set());
                          setSelectMode(false);
                          toast({ title: "Đã xoá", description: `${r.affected} sản phẩm đã xoá khỏi hệ thống` });
                        },
                        onError: (e: Error) => toast({ title: "Không xoá được", description: e.message, variant: "destructive" }),
                      }
                    );
                  }}
                  disabled={bulkDelete.isPending}
                  className="gap-1.5 h-9 px-3 text-destructive border-destructive/30 hover:bg-destructive/10"
                >
                  {bulkDelete.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
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
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center text-muted-foreground max-w-xs">
              <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mx-auto mb-4">
                <Tag className="w-8 h-8 opacity-40" />
              </div>
              <h2 className="font-semibold text-base mb-1">Chọn danh mục</h2>
              <p className="text-sm">Bấm vào một danh mục bên trái để xem và quản lý sản phẩm trong đó.</p>
              {rootCats.length === 0 && (
                <Button size="sm" className="mt-4 gap-1.5" onClick={() => { setAddUnderParent("root"); setNewCatName(""); }}>
                  <Plus className="w-4 h-4" /> Tạo danh mục đầu tiên
                </Button>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── ProductDrawer ───────────────────────────────────────────────── */}
      {editingDress && (
        <ProductDrawer
          key={editingDress === "new" ? "new" : editingDress.id}
          dress={editingDress}
          categories={dressCats}
          allProducts={allProducts}
          defaultCategoryId={selectedCatId}
          onClose={() => setEditingDress(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["cms-products"] });
            qc.invalidateQueries({ queryKey: ["cms-categories"] });
            setEditingDress(null);
          }}
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: ["cms-products"] });
            qc.invalidateQueries({ queryKey: ["cms-categories"] });
            setEditingDress(null);
          }}
        />
      )}

      {/* ── Bulk upload ─────────────────────────────────────────────────── */}
      {bulkOpen && (
        <BulkUploadModal
          onClose={() => setBulkOpen(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ["cms-products"] });
            qc.invalidateQueries({ queryKey: ["cms-categories"] });
          }}
        />
      )}

      {/* ── Modal: thêm mục danh mục ────────────────────────────────────── */}
      {addUnderParent !== null && (
        <Modal
          title={addUnderParent === "root"
            ? "Thêm danh mục gốc"
            : `Thêm mục con của: ${dressCats.find(c => c.id === addUnderParent)?.name ?? ""}`}
          onClose={() => setAddUnderParent(null)}
        >
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Tên mục *</label>
              <Input
                value={newCatName}
                onChange={e => setNewCatName(e.target.value)}
                className="mt-1"
                autoFocus
                onKeyDown={e => {
                  if (e.key === "Enter" && newCatName.trim())
                    addCat.mutate({ name: newCatName, parentId: addUnderParent === "root" ? null : addUnderParent });
                }}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Slug (không bắt buộc)</label>
              <Input value={newCatSlug} onChange={e => setNewCatSlug(e.target.value)} className="mt-1" placeholder="danh-muc-con" />
            </div>
          </div>
          <ModalFooter
            onClose={() => setAddUnderParent(null)}
            onConfirm={() => addCat.mutate({ name: newCatName, parentId: addUnderParent === "root" ? null : addUnderParent })}
            confirmDisabled={!newCatName.trim()}
            loading={addCat.isPending}
            confirmLabel="Thêm danh mục"
          />
        </Modal>
      )}

      {/* ── Modal: sửa danh mục ─────────────────────────────────────────── */}
      {editingCat && (
        <Modal title={`Sửa: ${editingCat.name}`} onClose={() => setEditingCat(null)}>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Tên mục *</label>
              <Input value={editDraftName} onChange={e => setEditDraftName(e.target.value)} className="mt-1" autoFocus />
            </div>
            <div>
              <label className="text-sm font-medium">Slug</label>
              <Input value={editDraftSlug} onChange={e => setEditDraftSlug(e.target.value)} className="mt-1" />
            </div>
          </div>
          <ModalFooter
            onClose={() => setEditingCat(null)}
            onConfirm={() => saveCat.mutate({ id: editingCat.id, name: editDraftName, slug: editDraftSlug || undefined })}
            confirmDisabled={!editDraftName.trim()}
            loading={saveCat.isPending}
            confirmLabel="Lưu"
          />
        </Modal>
      )}

      {/* ── Modal: ảnh bìa danh mục ─────────────────────────────────────── */}
      {coverFor && (
        <Modal title={`Ảnh bìa — ${coverFor.name}`} onClose={() => setCoverFor(null)}>
          <div className="space-y-3">
            {coverFor.coverImageUrl && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">Ảnh hiện tại:</p>
                <div className="aspect-video w-full rounded-lg overflow-hidden bg-muted">
                  <LazyImage src={coverFor.coverImageUrl} className="w-full h-full" />
                </div>
                <button
                  onClick={() => saveCat.mutate({ id: coverFor.id, coverImageUrl: null })}
                  className="mt-2 text-xs text-destructive hover:underline"
                >
                  Xoá ảnh bìa (dùng ảnh sản phẩm đầu tiên)
                </button>
              </div>
            )}
            <MultiImageUploader
              multiple={false}
              label="Tải ảnh bìa mới"
              onUploaded={(imgs: UploadedImage[]) => {
                if (imgs[0]) saveCat.mutate({ id: coverFor.id, coverImageUrl: imgs[0].objectPath });
              }}
            />
          </div>
        </Modal>
      )}

      {/* ── Dialog: Chuyển danh mục (product-first) ──────────────────────── */}
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
              <div className="space-y-2">
                <p className="text-sm font-medium">Đã chọn <span className="font-semibold">{selected.size}</span> sản phẩm</p>
                <div className="flex flex-wrap gap-2 max-h-[120px] overflow-y-auto">
                  {Array.from(selected).map(id => {
                    const d = filteredProducts.find(x => x.id === id);
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
              <div>
                <p className="text-sm text-muted-foreground mb-2">Chọn nơi muốn chuyển tới:</p>
                <CategoryTreePicker
                  categories={dressCats}
                  value={moveTargetCatId}
                  onChange={setMoveTargetCatId}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
              <Button variant="outline" onClick={() => setMoveDialogOpen(false)}>Huỷ</Button>
              <Button
                onClick={() => {
                  bulkMove.mutate(
                    { ids: Array.from(selected), categoryId: moveTargetCatId },
                    {
                      onSuccess: async (r) => {
                        await qc.refetchQueries({ queryKey: ["cms-products"], type: "active" });
                        await qc.refetchQueries({ queryKey: ["cms-categories"], type: "active" });
                        setSelected(new Set());
                        setSelectMode(false);
                        setMoveDialogOpen(false);
                        if (moveTargetCatId != null) {
                          setSelectedCatId(moveTargetCatId);
                          const targetCat = dressCats.find(c => c.id === moveTargetCatId);
                          if (targetCat?.parentId != null) {
                            setExpanded(prev => { const n = new Set(prev); n.add(targetCat.parentId!); return n; });
                          }
                        } else {
                          setSelectedCatId(null);
                        }
                        const targetName = moveTargetCatId == null
                          ? "Không gắn danh mục"
                          : (dressCats.find(c => c.id === moveTargetCatId)?.name ?? "");
                        toast({ title: "Đã chuyển", description: `${r.affected} sản phẩm → ${targetName}` });
                      },
                      onError: (e: Error) => toast({ title: "Không chuyển được", description: e.message, variant: "destructive" }),
                    }
                  );
                }}
                disabled={bulkMove.isPending}
                className="gap-1.5"
              >
                {bulkMove.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Chuyển
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: QR danh mục ──────────────────────────────────────────── */}
      {qrFor && (
        <CatQrModal
          cat={qrFor}
          link={buildPublicLink(qrFor)}
          breadcrumb={buildBreadcrumb(dressCats, qrFor.id)}
          onClose={() => setQrFor(null)}
        />
      )}
    </div>
  );
}
