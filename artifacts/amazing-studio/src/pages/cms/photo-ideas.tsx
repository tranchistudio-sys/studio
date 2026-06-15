import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Tag, Plus, Trash2, Edit2, Save, Loader2, X, ChevronRight, ChevronDown,
  FolderPlus, Lightbulb, Image as ImageIcon, Eye, EyeOff, Search, Check,
  AlertCircle, MoreHorizontal, ArrowLeft, Sparkles, Wrench, SlidersHorizontal,
} from "lucide-react";
import { Button, Input } from "@/components/ui";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  authHeaders, CMS_BASE, LazyImage, MultiImageUploader, SortableList,
  type UploadedImage,
} from "@/components/cms-shared";
import { getImageSrc } from "@/lib/imageUtils";
import { useToast } from "@/hooks/use-toast";
import {
  ChipSuggest, useCommonTags, IDEA_TAG_KEY, IDEA_TAG_DEFAULTS,
  FilterChipRow, FilterRadioRow, mergeTagOptions,
} from "@/components/cms-tag-input";

// ─── Types ──────────────────────────────────────────────────────────────────
interface Category {
  id: number; type: string; parentId: number | null;
  name: string; slug: string | null;
  coverImageUrl: string | null; fallbackCover?: string | null;
  sortOrder: number; isActive: number; productCount: number;
}
interface Idea {
  id: number; name: string; slug: string | null;
  categoryId: number | null; description: string | null;
  imageUrl: string | null; publicImageUrl: string | null; coverImageUrl: string | null;
  extraImages: string[]; tagsText: string | null;
  visibilityStatus: "public" | "hidden";
  executionStatus: "available" | "need_investment";
  sortOrder: number; createdAt: string;
}

const EXECUTION_META: Record<Idea["executionStatus"], { label: string; color: string; bg: string }> = {
  available:       { label: "Có sẵn tại Amazing Studio", color: "text-emerald-700", bg: "bg-emerald-100" },
  need_investment: { label: "Cần đầu tư thêm",           color: "text-amber-700",   bg: "bg-amber-100" },
};

// ─── Helpers (clone từ module Cho thuê đồ) ───────────────────────────────────
function coverOf(d: Idea): string | null {
  return d.coverImageUrl || d.publicImageUrl || d.imageUrl || d.extraImages?.[0] || null;
}
function flattenCats(cats: Category[], parentId: number | null = null, depth = 0): Array<{ cat: Category; depth: number }> {
  const children = cats.filter(c => c.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);
  const result: Array<{ cat: Category; depth: number }> = [];
  for (const c of children) { result.push({ cat: c, depth }); result.push(...flattenCats(cats, c.id, depth + 1)); }
  return result;
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
function emptyIdea(): Omit<Idea, "id" | "createdAt"> {
  return {
    name: "", slug: null, categoryId: null, description: null,
    imageUrl: null, publicImageUrl: null, coverImageUrl: null,
    extraImages: [], tagsText: null,
    visibilityStatus: "public", executionStatus: "available", sortOrder: 0,
  };
}

// ─── DragSortImageGrid (clone từ Cho thuê đồ, không select-mode) ─────────────
function DragSortImageGrid({ images, onReorder, onRemove }: {
  images: string[];
  onReorder: (next: string[]) => void;
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
          className={`relative group aspect-[3/4] rounded-lg overflow-hidden bg-muted cursor-grab active:cursor-grabbing transition-all ${
            dragIdx === i ? "opacity-40 scale-95" : ""
          } ${overIdx === i && dragIdx !== i ? "ring-2 ring-primary ring-offset-1" : ""}`}
        >
          <img src={getImageSrc(src) ?? src} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-all">
            <button
              onClick={e => { e.stopPropagation(); onRemove(src); }}
              className="absolute top-1 right-1 hidden group-hover:flex w-6 h-6 bg-destructive/90 text-white rounded-full items-center justify-center"
              title="Xoá ảnh"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── IdeaCard ────────────────────────────────────────────────────────────────
function IdeaCard({ idea, onSelect, onToggleVisibility, toggling }: {
  idea: Idea; onSelect: () => void;
  onToggleVisibility: (i: Idea) => void; toggling: boolean;
}) {
  const cover = coverOf(idea);
  const exec = EXECUTION_META[idea.executionStatus] ?? EXECUTION_META.available;
  const isVisible = idea.visibilityStatus === "public";
  return (
    <div
      className="group relative rounded-xl overflow-hidden bg-muted border cursor-pointer hover:shadow-md hover:border-primary/40 transition-all"
      onClick={onSelect}
    >
      <div className="aspect-[3/4] relative">
        <LazyImage src={cover} className="absolute inset-0 w-full h-full" />
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        <div className={`absolute top-2 left-2 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${exec.bg} ${exec.color}`}>
          {idea.executionStatus === "available" ? "Có sẵn" : "Cần đầu tư"}
        </div>
        <button
          onClick={e => { e.stopPropagation(); onToggleVisibility(idea); }}
          disabled={toggling}
          className={`absolute top-2 right-2 p-1.5 rounded-full transition-all ${
            isVisible ? "bg-white/90 text-emerald-600" : "bg-black/40 text-white/60 hover:bg-black/60"
          }`}
          title={isVisible ? "Đang hiển thị" : "Đang ẩn"}
        >
          {toggling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </button>
        <div className="absolute inset-x-0 bottom-0 p-2.5 text-white">
          <p className="font-semibold text-sm leading-tight line-clamp-2">{idea.name}</p>
          <p className="text-[10px] text-white/70 mt-0.5">{(idea.extraImages?.length ?? 0) + (idea.imageUrl ? 1 : 0)} ảnh</p>
        </div>
      </div>
    </div>
  );
}

// ─── IdeaDrawer (form dọc — clone bố cục từ Cho thuê đồ) ─────────────────────
function IdeaDrawer({ idea, categories, defaultCategoryId, onClose, onSaved, onDeleted }: {
  idea: Idea | "new";
  categories: Category[];
  defaultCategoryId?: number | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const isNew = idea === "new";
  type FormType = Omit<Idea, "id" | "createdAt">;
  const [form, setForm] = useState<FormType>(() => {
    if (isNew) {
      const base = emptyIdea();
      if (defaultCategoryId) base.categoryId = defaultCategoryId;
      return base;
    }
    return idea as Idea;
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const set = useCallback(<K extends keyof FormType>(k: K, v: FormType[K]) => {
    setForm(f => ({ ...f, [k]: v }));
  }, []);
  const ideaTags = useCommonTags(IDEA_TAG_KEY, IDEA_TAG_DEFAULTS);

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
  function removeImage(src: string) {
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
      const combined = [...(f.extraImages || []), ...fresh];
      if (!f.imageUrl) return { ...f, imageUrl: combined[0], extraImages: combined.slice(1) };
      return { ...f, extraImages: combined };
    });
  }

  async function handleSave() {
    if (!form.name?.trim()) { setSaveError("Vui lòng nhập tên concept"); return; }
    setSaveError(null); setSaving(true);
    try {
      const album = [form.imageUrl, ...(form.extraImages || [])].filter(Boolean) as string[];
      const payload = {
        ...form,
        imageUrl: album[0] ?? null,
        publicImageUrl: album[0] ?? null,
        coverImageUrl: form.coverImageUrl ?? album[0] ?? null,
        extraImages: album.slice(1),
      };
      const url = isNew ? `${CMS_BASE}/api/photo-ideas` : `${CMS_BASE}/api/photo-ideas/${(idea as Idea).id}`;
      const r = await fetch(url, { method: isNew ? "POST" : "PUT", headers: authHeaders(), body: JSON.stringify(payload) });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((json as { error?: string }).error ?? "Lỗi lưu");
      onSaved();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Xoá concept "${form.name}"?`)) return;
    setDeleting(true);
    try {
      await fetch(`${CMS_BASE}/api/photo-ideas/${(idea as Idea).id}`, { method: "DELETE", headers: authHeaders() });
      onDeleted();
    } finally { setDeleting(false); }
  }

  const isVisible = form.visibilityStatus === "public";

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 sm:bg-transparent" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-background shadow-2xl border-l border-border flex flex-col overflow-hidden">

        <div className="flex items-center gap-3 px-4 py-3 border-b bg-background sticky top-0 z-10">
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-base truncate">{isNew ? "Thêm ý tưởng mới" : form.name || "Ý tưởng"}</h2>
          </div>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5 flex-shrink-0">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {isNew ? "Tạo" : "Lưu"}
          </Button>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg text-muted-foreground flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain pb-24">
          <div className="p-4 space-y-4">
            {saveError && (
              <div className="p-3 rounded-xl bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {saveError}
              </div>
            )}

            {/* A. Tên + danh mục */}
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Tên concept</label>
                <Input value={form.name} onChange={e => set("name", e.target.value)} placeholder="Áo dài Tết Xuân Thư..." autoFocus={isNew} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Danh mục</label>
                <select
                  value={form.categoryId ?? ""}
                  onChange={e => set("categoryId", e.target.value ? +e.target.value : null)}
                  className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                >
                  <option value="">— Không —</option>
                  {flatCatsList.map(({ cat, depth }) => (
                    <option key={cat.id} value={cat.id}>{" ".repeat(depth * 3)}{cat.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* B. Ảnh concept */}
            <div className="space-y-4 border-t pt-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Album ảnh</p>
              <div className="space-y-3">
                <p className="text-[11px] font-medium text-muted-foreground">Ảnh bìa</p>
                {form.coverImageUrl ? (
                  <div className="relative group aspect-[3/4] w-32 rounded-lg overflow-hidden bg-muted">
                    <img src={getImageSrc(form.coverImageUrl) ?? form.coverImageUrl} alt="" className="w-full h-full object-cover" />
                    <button
                      onClick={() => set("coverImageUrl", null)}
                      className="absolute top-1 right-1 hidden group-hover:flex w-6 h-6 bg-destructive/90 text-white rounded-full items-center justify-center"
                      title="Xoá ảnh bìa"
                    >
                      <X className="w-3 h-3" />
                    </button>
                    <span className="absolute bottom-1 left-1 bg-primary text-white text-[9px] px-1.5 py-0.5 rounded-full font-semibold pointer-events-none">
                      Ảnh bìa
                    </span>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Chưa chọn ảnh bìa — khi lưu sẽ tự lấy ảnh đầu tiên của album.
                  </p>
                )}
                {images.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {images.map(src => (
                      <button
                        key={src}
                        onClick={() => set("coverImageUrl", src)}
                        className={`relative w-16 aspect-[3/4] rounded-lg overflow-hidden bg-muted border-2 transition-all hover:scale-105 ${
                          form.coverImageUrl === src ? "border-primary" : "border-transparent"
                        }`}
                        title="Đặt làm ảnh bìa"
                      >
                        <img src={getImageSrc(src) ?? src} alt="" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t pt-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Album: {images.length} / 30 ảnh {images.length > 0 ? "• Kéo thả để đổi thứ tự" : ""}
                </p>
                <DragSortImageGrid images={images} onReorder={reorderImages} onRemove={removeImage} />
                {images.length < 30 && (
                  <MultiImageUploader
                    multiple
                    useQueue={false}
                    label="Kéo thả / dán Ctrl+V / bấm để thêm ảnh"
                    onUploaded={addImages}
                  />
                )}
              </div>
            </div>

            {/* C. Chi tiết */}
            <div className="space-y-4 border-t pt-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Chi tiết</p>

              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Khả năng thực hiện</label>
                <div className="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={() => set("executionStatus", "available")}
                    className={`flex items-center gap-2 py-2.5 px-3 rounded-lg text-sm font-medium border text-left transition-all ${
                      form.executionStatus === "available"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                        : "border-border text-muted-foreground hover:border-primary/30"
                    }`}
                  >
                    <Sparkles className="w-4 h-4 flex-shrink-0" />
                    Có sẵn tại Amazing Studio
                    {form.executionStatus === "available" && <Check className="w-4 h-4 ml-auto" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => set("executionStatus", "need_investment")}
                    className={`flex items-center gap-2 py-2.5 px-3 rounded-lg text-sm font-medium border text-left transition-all ${
                      form.executionStatus === "need_investment"
                        ? "bg-amber-50 text-amber-700 border-amber-300"
                        : "border-border text-muted-foreground hover:border-primary/30"
                    }`}
                  >
                    <Wrench className="w-4 h-4 flex-shrink-0" />
                    Cần khách đầu tư thêm
                    {form.executionStatus === "need_investment" && <Check className="w-4 h-4 ml-auto" />}
                  </button>
                </div>
              </div>

              <ChipSuggest
                label="Tags — AI tư vấn dựa vào tags này, bấm chip để gắn nhanh"
                suggestions={ideaTags.list}
                value={form.tagsText ?? ""}
                onChange={v => set("tagsText", v || null)}
                onAddSuggestion={ideaTags.add}
              />

              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Mô tả</label>
                <textarea
                  value={form.description ?? ""}
                  onChange={e => set("description", e.target.value || null)}
                  rows={3}
                  placeholder="Mô tả concept cho khách tham khảo..."
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <button
                onClick={() => set("visibilityStatus", isVisible ? "hidden" : "public")}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${
                  isVisible ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-border bg-muted/30 text-muted-foreground"
                }`}
              >
                <div className={`w-9 h-5 rounded-full relative flex-shrink-0 transition-all ${isVisible ? "bg-emerald-500" : "bg-border"}`}>
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${isVisible ? "left-4" : "left-0.5"}`} />
                </div>
                <div className="text-left flex-1">
                  <p className="font-medium text-sm">{isVisible ? "Đang hiển thị trên website" : "Đang ẩn — khách không thấy"}</p>
                  <p className="text-xs opacity-70">{isVisible ? "Bấm để ẩn" : "Bấm để hiện trên trang Ý tưởng chụp ảnh"}</p>
                </div>
                {isVisible && <Check className="w-4 h-4 flex-shrink-0" />}
              </button>
            </div>

            {!isNew && (
              <div className="border-t pt-4">
                <button
                  onClick={handleDelete} disabled={deleting}
                  className="w-full flex items-center justify-center gap-2 p-3 rounded-xl border border-destructive/40 text-destructive hover:bg-destructive/5 text-sm font-medium transition-all"
                >
                  {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Xoá ý tưởng
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="border-t p-4 bg-background">
          <Button className="w-full gap-2" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isNew ? "Tạo ý tưởng" : "Lưu thay đổi"}
          </Button>
        </div>
      </div>
    </>
  );
}

// ─── CategoryNode (cây danh mục đệ quy — vô hạn cấp) ─────────────────────────
function CategoryNode({ cat, depth, allCats, expanded, selectedCatId, onSelect, onToggle, onAddChild, onAddIdea, onRename, onDelete, onToggleActive, onReorder }: {
  cat: Category; depth: number; allCats: Category[];
  expanded: Set<number>; selectedCatId: number | null;
  onSelect: (id: number) => void;
  onToggle: (id: number) => void;
  onAddChild: (parentId: number) => void;
  onAddIdea: (catId: number) => void;
  onRename: (cat: Category) => void;
  onDelete: (cat: Category) => void;
  onToggleActive: (cat: Category) => void;
  onReorder: (parentId: number | null, orderedIds: number[]) => void;
}) {
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const children = allCats.filter(c => c.parentId === cat.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const isOpen = expanded.has(cat.id);
  const isSelected = selectedCatId === cat.id;
  const isInactive = cat.isActive === 0;
  const cover = cat.coverImageUrl ?? cat.fallbackCover ?? null;

  const ACTION_ITEMS = [
    { icon: <Lightbulb className="w-4 h-4 text-emerald-600" />, label: "Thêm ý tưởng", fn: () => { onAddIdea(cat.id); setMobileSheetOpen(false); } },
    { icon: <FolderPlus className="w-4 h-4" />, label: "Thêm mục con", fn: () => { onAddChild(cat.id); setMobileSheetOpen(false); } },
    { icon: cat.isActive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />, label: cat.isActive ? "Ẩn danh mục" : "Hiện danh mục", fn: () => { onToggleActive(cat); setMobileSheetOpen(false); } },
    { icon: <Edit2 className="w-4 h-4" />, label: "Đổi tên", fn: () => { onRename(cat); setMobileSheetOpen(false); } },
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

        <button
          onClick={e => { e.stopPropagation(); setMobileSheetOpen(true); }}
          className="flex-shrink-0 flex md:hidden w-10 h-10 items-center justify-center rounded hover:bg-muted"
          aria-label="Thao tác"
        >
          <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
        </button>

        <div className="flex-shrink-0 hidden md:group-hover:flex items-center gap-0.5">
          <button
            onClick={e => { e.stopPropagation(); onAddIdea(cat.id); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-emerald-100 text-emerald-600"
            title="Thêm ý tưởng"
          >
            <Lightbulb className="w-3 h-3" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onAddChild(cat.id); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted"
            title="Thêm mục con"
          >
            <FolderPlus className="w-3 h-3" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onRename(cat); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted"
            title="Đổi tên"
          >
            <Edit2 className="w-3 h-3" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onToggleActive(cat); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted"
            title={cat.isActive ? "Ẩn" : "Hiện"}
          >
            {cat.isActive ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(cat); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-destructive/10 text-destructive"
            title="Xoá"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
        <SheetContent side="bottom" className="h-auto max-h-[70vh] rounded-t-2xl px-0 pb-6">
          <SheetHeader className="px-4 pb-2 border-b">
            <SheetTitle className="text-base">{cat.name}</SheetTitle>
            <SheetDescription className="text-xs">
              {cat.productCount} ý tưởng · {children.length} mục con
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col py-1">
            {ACTION_ITEMS.map((action, i) => (
              <button
                key={i}
                onClick={action.fn}
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

      {isOpen && children.length > 0 && (
        <SortableList
          items={children}
          onReorder={ids => onReorder(cat.id, ids)}
          renderItem={child => (
            <CategoryNode
              cat={child} depth={depth + 1} allCats={allCats}
              expanded={expanded} selectedCatId={selectedCatId}
              onSelect={onSelect} onToggle={onToggle}
              onAddChild={onAddChild} onAddIdea={onAddIdea}
              onRename={onRename} onDelete={onDelete}
              onToggleActive={onToggleActive} onReorder={onReorder}
            />
          )}
        />
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────
type ExecFilter = "all" | "available" | "need_investment";

export default function CmsPhotoIdeasPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [execFilter, setExecFilter] = useState<ExecFilter>("all");
  // Bộ lọc thông minh
  const [filterOpen, setFilterOpen] = useState(false);
  const [visFilter, setVisFilter] = useState<"all" | "public" | "hidden">("all");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [editingIdea, setEditingIdea] = useState<Idea | "new" | null>(null);
  const [drawerDefaultCatId, setDrawerDefaultCatId] = useState<number | null>(null);
  const [addUnderParent, setAddUnderParent] = useState<number | "root" | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [renamingCat, setRenamingCat] = useState<Category | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [mobileView, setMobileView] = useState<"cats" | "ideas">("cats");

  const { data: cats = [], isLoading: catsLoading } = useQuery<Category[]>({
    queryKey: ["idea-categories"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/categories?type=idea`, { headers: authHeaders() }).then(r => r.json()),
  });
  const { data: ideas = [], isLoading: ideasLoading } = useQuery<Idea[]>({
    queryKey: ["photo-ideas"],
    queryFn: () => fetch(`${CMS_BASE}/api/photo-ideas`, { headers: authHeaders() }).then(r => r.json()),
  });

  useEffect(() => {
    // Mở sẵn toàn bộ cây lần đầu
    if (cats.length && expanded.size === 0) setExpanded(new Set(cats.map(c => c.id)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cats.length]);

  const rootCats = useMemo(() => cats.filter(c => c.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder), [cats]);

  const descendantIds = useMemo(() => {
    if (!selectedCatId) return null;
    return getDescendantIds(cats, selectedCatId);
  }, [selectedCatId, cats]);

  // Tag lọc: gộp tag thật từ ý tưởng + tag gợi ý mặc định
  const tagOptions = useMemo(() => {
    const fromData = new Set<string>();
    ideas.forEach(d => (d.tagsText || "").split(/[,;]/).forEach(x => { const t = x.trim(); if (t) fromData.add(t); }));
    return mergeTagOptions([...fromData].sort(), IDEA_TAG_DEFAULTS);
  }, [ideas]);

  const filteredIdeas = useMemo(() => {
    if (!descendantIds) return [];
    let list = ideas.filter(d => d.categoryId !== null && descendantIds.has(d.categoryId));
    if (execFilter !== "all") list = list.filter(d => d.executionStatus === execFilter);
    if (visFilter !== "all") list = list.filter(d => d.visibilityStatus === visFilter);
    if (selectedTags.size > 0) {
      list = list.filter(d => {
        const v = (d.tagsText || "").toLowerCase();
        return [...selectedTags].some(t => v.includes(t.toLowerCase()));
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(d =>
        d.name.toLowerCase().includes(q) ||
        (d.tagsText || "").toLowerCase().includes(q) ||
        (d.description || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [ideas, descendantIds, search, execFilter, visFilter, selectedTags]);

  const hasExtraFilter = execFilter !== "all" || visFilter !== "all" || selectedTags.size > 0;
  const activeFilterCount = (execFilter !== "all" ? 1 : 0) + (visFilter !== "all" ? 1 : 0) + selectedTags.size;
  function clearFilters() {
    setSearch(""); setExecFilter("all"); setVisFilter("all"); setSelectedTags(new Set());
  }

  // ── Category mutations (dùng chung API /cms/categories với type='idea') ──
  const addCat = useMutation({
    mutationFn: (p: { name: string; parentId: number | null }) =>
      fetch(`${CMS_BASE}/api/cms/categories`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ type: "idea", parentId: p.parentId, name: p.name.trim() }),
      }).then(async r => { if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi"); return r.json() as Promise<Category>; }),
    onSuccess: (created: Category) => {
      qc.invalidateQueries({ queryKey: ["idea-categories"] });
      setAddUnderParent(null); setNewCatName("");
      if (created.parentId != null) setExpanded(s => { const n = new Set(s); n.add(created.parentId!); return n; });
    },
    onError: (e: Error) => toast({ title: "Không tạo được danh mục", description: e.message, variant: "destructive" }),
  });

  const patchCat = useMutation({
    mutationFn: (c: { id: number; name?: string; isActive?: number }) => {
      const { id, ...body } = c;
      return fetch(`${CMS_BASE}/api/cms/categories/${id}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify(body),
      }).then(async r => { if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi lưu"); });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["idea-categories"] }); setRenamingCat(null); },
    onError: (e: Error) => toast({ title: "Không lưu được", description: e.message, variant: "destructive" }),
  });

  const deleteCat = useMutation({
    mutationFn: (id: number) =>
      fetch(`${CMS_BASE}/api/cms/categories/${id}`, { method: "DELETE", headers: authHeaders() })
        .then(async r => { if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi xoá"); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["idea-categories"] });
      qc.invalidateQueries({ queryKey: ["photo-ideas"] });
    },
    onError: (e: Error) => toast({ title: "Không xoá được", description: e.message, variant: "destructive" }),
  });

  const reorderCats = useMutation({
    mutationFn: (orderedIds: number[]) =>
      fetch(`${CMS_BASE}/api/cms/categories/reorder`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ order: orderedIds.map((id, idx) => ({ id, sortOrder: idx })) }),
      }).then(async r => { if (!r.ok) throw new Error("Lỗi sắp xếp"); }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["idea-categories"] }),
  });

  const toggleVisibility = useMutation({
    mutationFn: (i: Idea) =>
      fetch(`${CMS_BASE}/api/photo-ideas/${i.id}`, {
        method: "PUT", headers: authHeaders(),
        body: JSON.stringify({ visibilityStatus: i.visibilityStatus === "public" ? "hidden" : "public" }),
      }).then(async r => { if (!r.ok) throw new Error("Lỗi"); }),
    onMutate: (i) => setTogglingId(i.id),
    onSettled: () => setTogglingId(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["photo-ideas"] }),
  });

  function toggleExpand(id: number) {
    setExpanded(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function handleSelectCat(id: number) {
    setSelectedCatId(prev => {
      if (prev === id) { setMobileView("cats"); return null; }
      setMobileView("ideas");
      return id;
    });
  }
  function openNewIdea(catId: number | null) {
    setDrawerDefaultCatId(catId);
    setEditingIdea("new");
  }
  function handleDeleteCat(cat: Category) {
    if (!confirm(`Xoá danh mục "${cat.name}"? Ý tưởng trong danh mục sẽ không bị xoá nhưng mất gắn danh mục.`)) return;
    deleteCat.mutate(cat.id);
  }

  const selectedCat = cats.find(c => c.id === selectedCatId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sidebar cây danh mục ── */}
      <aside className={`${mobileView === "ideas" ? "hidden" : "flex"} md:flex flex-col w-full md:w-72 lg:w-80 border-r bg-background flex-shrink-0 min-h-0`}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-amber-500" /> Ý tưởng chụp ảnh
          </h2>
          <button
            onClick={() => { setAddUnderParent("root"); setNewCatName(""); }}
            className="p-1.5 hover:bg-muted rounded-lg" title="Thêm danh mục gốc"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {catsLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : rootCats.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8 px-4">
              Chưa có danh mục.
              <Button size="sm" className="mt-3 gap-1.5 w-full" onClick={() => { setAddUnderParent("root"); setNewCatName(""); }}>
                <Plus className="w-4 h-4" /> Tạo danh mục đầu tiên
              </Button>
            </div>
          ) : (
            <SortableList
              items={rootCats}
              onReorder={ids => reorderCats.mutate(ids)}
              renderItem={cat => (
                <CategoryNode
                  cat={cat} depth={0} allCats={cats}
                  expanded={expanded} selectedCatId={selectedCatId}
                  onSelect={handleSelectCat} onToggle={toggleExpand}
                  onAddChild={id => { setAddUnderParent(id); setNewCatName(""); }}
                  onAddIdea={openNewIdea}
                  onRename={c => { setRenamingCat(c); setRenameValue(c.name); }}
                  onDelete={handleDeleteCat}
                  onToggleActive={c => patchCat.mutate({ id: c.id, isActive: c.isActive ? 0 : 1 })}
                  onReorder={(_pid, ids) => reorderCats.mutate(ids)}
                />
              )}
            />
          )}
        </div>
      </aside>

      {/* ── Panel ý tưởng ── */}
      <main className={`${mobileView === "cats" ? "hidden" : "flex"} md:flex flex-col flex-1 min-w-0 min-h-0`}>
        {selectedCat ? (
          <>
            <div className="px-4 py-3 border-b space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => { setSelectedCatId(null); setMobileView("cats"); }} className="md:hidden p-1.5 hover:bg-muted rounded-lg">
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <h1 className="font-semibold truncate">{selectedCat.name}</h1>
                <span className="text-xs text-muted-foreground">{filteredIdeas.length} ý tưởng</span>
                <div className="flex-1" />
                <Button size="sm" className="gap-1.5" onClick={() => openNewIdea(selectedCatId)}>
                  <Plus className="w-4 h-4" /> Thêm ý tưởng
                </Button>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[180px] max-w-sm">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tên, tags, mô tả..." className="pl-8 h-9" />
                  {search && (
                    <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                      <X className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  )}
                </div>
                {([
                  { key: "all", label: "Tất cả" },
                  { key: "available", label: "Có sẵn tại Studio" },
                  { key: "need_investment", label: "Cần đầu tư thêm" },
                ] as Array<{ key: ExecFilter; label: string }>).map(f => (
                  <button
                    key={f.key}
                    onClick={() => setExecFilter(f.key)}
                    className={`px-2.5 py-1.5 rounded-full text-xs font-medium border transition-all ${
                      execFilter === f.key
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-primary/50"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setFilterOpen(v => !v)}
                  className={`flex items-center gap-1.5 h-8 px-2.5 text-xs rounded-md border transition-colors ${
                    filterOpen || hasExtraFilter
                      ? "bg-foreground text-background border-foreground"
                      : "bg-background text-muted-foreground border-border hover:border-foreground"
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Bộ lọc</span>
                  {activeFilterCount > 0 && (
                    <span className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-background text-foreground text-[10px] font-semibold">
                      {activeFilterCount}
                    </span>
                  )}
                  {filterOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
                {(hasExtraFilter || search) && (
                  <button onClick={clearFilters} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <X className="w-3 h-3" /> Xoá lọc
                  </button>
                )}
              </div>
              {filterOpen && (
                <div className="space-y-1.5 pt-1.5 border-t border-dashed">
                  <FilterChipRow
                    label="Tags:" options={tagOptions} selected={selectedTags}
                    onToggle={t => setSelectedTags(prev => { const n = new Set(prev); if (n.has(t)) n.delete(t); else n.add(t); return n; })}
                  />
                  <FilterRadioRow
                    label="Hiện:" value={visFilter} onChange={setVisFilter}
                    options={[
                      { key: "all", label: "Tất cả" },
                      { key: "public", label: "Đang hiển thị" },
                      { key: "hidden", label: "Đang ẩn" },
                    ]}
                  />
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {ideasLoading ? (
                <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
              ) : filteredIdeas.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-center">
                  <Lightbulb className="w-12 h-12 mb-3 opacity-20" />
                  <p className="font-medium">{search || hasExtraFilter ? "Không tìm thấy ý tưởng khớp bộ lọc" : "Chưa có ý tưởng trong danh mục này"}</p>
                  {!search && !hasExtraFilter && (
                    <Button size="sm" className="mt-4 gap-1.5" onClick={() => openNewIdea(selectedCatId)}>
                      <Plus className="w-4 h-4" /> Thêm ý tưởng đầu tiên
                    </Button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {filteredIdeas.map(d => (
                    <IdeaCard
                      key={d.id}
                      idea={d}
                      onSelect={() => setEditingIdea(d)}
                      onToggleVisibility={i => toggleVisibility.mutate(i)}
                      toggling={togglingId === d.id}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center text-muted-foreground max-w-xs">
              <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mx-auto mb-4">
                <Lightbulb className="w-8 h-8 opacity-40" />
              </div>
              <h2 className="font-semibold text-base mb-1">Chọn danh mục</h2>
              <p className="text-sm">Bấm vào một danh mục bên trái để xem và quản lý ý tưởng chụp ảnh.</p>
            </div>
          </div>
        )}
      </main>

      {/* ── Drawer thêm/sửa ý tưởng ── */}
      {editingIdea && (
        <IdeaDrawer
          key={editingIdea === "new" ? "new" : editingIdea.id}
          idea={editingIdea}
          categories={cats}
          defaultCategoryId={drawerDefaultCatId}
          onClose={() => setEditingIdea(null)}
          onSaved={() => {
            setEditingIdea(null);
            qc.refetchQueries({ queryKey: ["photo-ideas"] });
            qc.refetchQueries({ queryKey: ["idea-categories"] });
            toast({ title: "Đã lưu ý tưởng" });
          }}
          onDeleted={() => {
            setEditingIdea(null);
            qc.refetchQueries({ queryKey: ["photo-ideas"] });
            qc.refetchQueries({ queryKey: ["idea-categories"] });
            toast({ title: "Đã xoá ý tưởng" });
          }}
        />
      )}

      {/* ── Modal thêm danh mục ── */}
      {addUnderParent !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setAddUnderParent(null)}>
          <div className="bg-background rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-3">
              {addUnderParent === "root" ? "Thêm danh mục gốc" : `Thêm mục con cho "${cats.find(c => c.id === addUnderParent)?.name}"`}
            </h3>
            <Input
              value={newCatName}
              onChange={e => setNewCatName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && newCatName.trim()) addCat.mutate({ name: newCatName, parentId: addUnderParent === "root" ? null : addUnderParent }); }}
              placeholder="Ví dụ: Áo dài, Tết, Xuân Thư..."
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAddUnderParent(null)}>Huỷ</Button>
              <Button
                disabled={!newCatName.trim() || addCat.isPending}
                onClick={() => addCat.mutate({ name: newCatName, parentId: addUnderParent === "root" ? null : addUnderParent })}
              >
                {addCat.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Tạo
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal đổi tên danh mục ── */}
      {renamingCat && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setRenamingCat(null)}>
          <div className="bg-background rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-3">Đổi tên danh mục</h3>
            <Input
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && renameValue.trim()) patchCat.mutate({ id: renamingCat.id, name: renameValue.trim() }); }}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRenamingCat(null)}>Huỷ</Button>
              <Button
                disabled={!renameValue.trim() || patchCat.isPending}
                onClick={() => patchCat.mutate({ id: renamingCat.id, name: renameValue.trim() })}
              >
                {patchCat.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Lưu
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
