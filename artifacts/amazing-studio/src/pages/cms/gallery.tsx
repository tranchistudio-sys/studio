import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient, useInfiniteQuery, type QueryClient } from "@tanstack/react-query";
import {
  Images, Plus, Edit2, Trash2, Eye, EyeOff, FileText, Tag, FolderTree, Globe,
  ChevronRight, ChevronDown, ArrowLeft, Search,
  X, ChevronLeft, Save, Loader2, Star, Video, Play, SlidersHorizontal, FolderInput, MoreHorizontal,
} from "lucide-react";
import { Button, Input } from "@/components/ui";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  MultiImageUploader, LazyImage, SortableList, authHeaders, CMS_BASE,
  GripVertical, uploadFileViaPresign, MoveCategoryDialog, type UploadedImage,
} from "@/components/cms-shared";
import { getImageSrc } from "@/lib/imageUtils";
import { useToast } from "@/hooks/use-toast";
import { getPublicPageUrl } from "@/lib/public-site-url";
import {
  useBulkSelect, BulkActionBar, BulkMoveDialog, TriCheckbox,
  itemIdsInCategorySubtree, subtreeSelectState, type TriState,
} from "@/components/cms-bulk-select";
import { CheckSquare } from "lucide-react";

interface Album {
  id: number; name: string; slug: string | null; description: string | null;
  coverImageUrl: string | null; status: "draft" | "visible" | "hidden";
  sortOrder: number; photoCount: number;
  categoryId: number | null; tagsText: string | null;
}
interface Photo {
  id: number; albumId: number; imageUrl: string; caption: string | null;
  mimeType: string | null;
  status: "visible" | "hidden"; sortOrder: number;
}
// Ảnh đã upload-presign sẵn nhưng CHƯA gắn vào album (dùng khi tạo album mới kèm nhiều ảnh 1 lần).
type PendingPhoto = { id: number; objectPath: string; mimeType?: string };
interface Capabilities {
  videoUpload: boolean;
  videoMaxSizeMb: number;
  videoAllowedMimes: string[];
}
function isVideoMime(m: string | null | undefined): boolean {
  return !!m && m.startsWith("video/");
}
interface GalleryCat {
  id: number; type: string; parentId: number | null; name: string;
  slug: string | null; coverImageUrl: string | null;
  sortOrder: number; isActive: number;
  productCount?: number; fallbackCover?: string | null;
}

// Chip tag input + danh sách gợi ý: dùng chung từ components/cms-tag-input
import {
  ChipSuggest, useCommonTags, normalizeTag,
  FilterChipRow, FilterRadioRow, mergeTagOptions,
  GALLERY_TAG_KEY, GALLERY_TAG_DEFAULTS, ALBUM_CATEGORY_SUGGESTIONS,
} from "@/components/cms-tag-input";

// ─── Helpers ────────────────────────────────────────────────────────────────
function getDescendantIds(cats: GalleryCat[], rootId: number): Set<number> {
  const ids = new Set<number>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const c of cats) {
      if (c.parentId != null && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id); added = true;
      }
    }
  }
  return ids;
}
function buildBreadcrumb(cats: GalleryCat[], id: number): string {
  const map = new Map(cats.map(c => [c.id, c]));
  const parts: string[] = [];
  let cur = map.get(id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId != null ? map.get(cur.parentId) : undefined;
  }
  return parts.join(" › ");
}

// ─── Tree node ──────────────────────────────────────────────────────────────
interface CatNodeHandlers {
  expanded: Set<number>; selectedId: number | null;
  onSelect: (id: number) => void; onToggle: (id: number) => void;
  counts: Map<number, number>;
  onAddChild: (parentId: number) => void;
  onEdit: (cat: GalleryCat) => void;
  onMove: (cat: GalleryCat) => void;
  onDelete: (cat: GalleryCat) => void;
  onReorder: (parentId: number | null, orderedIds: number[]) => void;
  effectiveIsAdmin: boolean;
  selectMode?: boolean;
  catSelectState?: (id: number) => TriState;
  onToggleCatSelect?: (id: number) => void;
}
function CatNode({ cat, depth, allCats, handlers }: {
  cat: GalleryCat; depth: number; allCats: GalleryCat[]; handlers: CatNodeHandlers;
}) {
  const { expanded, selectedId, onSelect, onToggle, counts, onAddChild, onEdit, onMove, onDelete, onReorder, effectiveIsAdmin,
    selectMode, catSelectState, onToggleCatSelect } = handlers;
  const children = useMemo(
    () => allCats.filter(c => c.parentId === cat.id).sort((a, b) => a.sortOrder - b.sortOrder),
    [allCats, cat.id]
  );
  const hasChildren = children.length > 0;
  const isOpen = expanded.has(cat.id);
  const isSelected = selectedId === cat.id;
  // Menu thao tác cho MOBILE (không có hover) — mở bottom sheet. Trên desktop dùng
  // các nút hiện khi hover. Nhờ vậy "Chuyển vào mục khác" (di dời cả mục mẹ) dùng được trên điện thoại.
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const ACTION_ITEMS = [
    { icon: <Plus className="w-4 h-4 text-emerald-600" />, label: "Thêm mục con", fn: () => { onAddChild(cat.id); setMobileSheetOpen(false); }, danger: false },
    { icon: <Edit2 className="w-4 h-4" />, label: "Đổi tên", fn: () => { onEdit(cat); setMobileSheetOpen(false); }, danger: false },
    { icon: <FolderInput className="w-4 h-4 text-sky-600" />, label: "Chuyển vào mục khác", fn: () => { onMove(cat); setMobileSheetOpen(false); }, danger: false },
    ...(effectiveIsAdmin ? [{ icon: <Trash2 className="w-4 h-4 text-destructive" />, label: "Xoá danh mục", fn: () => { onDelete(cat); setMobileSheetOpen(false); }, danger: true }] : []),
  ];
  return (
    <div>
      <div
        className={`group flex items-center gap-1 px-1 py-1 rounded-md cursor-pointer hover:bg-muted ${isSelected ? "bg-primary/10 text-primary font-semibold" : ""}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => onSelect(cat.id)}
      >
        {selectMode && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCatSelect?.(cat.id); }}
            className="flex-shrink-0"
            title="Chọn toàn bộ ảnh trong danh mục này (gồm mục con)"
          >
            <TriCheckbox state={catSelectState ? catSelectState(cat.id) : "none"} className="w-4 h-4" />
          </button>
        )}
        {hasChildren ? (
          <button onClick={e => { e.stopPropagation(); onToggle(cat.id); }} className="w-4 h-4 flex items-center justify-center text-muted-foreground">
            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : <span className="w-4" />}
        <span className="text-sm truncate flex-1">{cat.name}</span>
        <span className="text-[10px] text-muted-foreground tabular-nums opacity-100 md:group-hover:opacity-0 transition-opacity">{counts.get(cat.id) ?? 0}</span>
        {/* MOBILE: nút "..." mở menu thao tác (desktop ẩn, dùng hover bên dưới) */}
        <button
          onClick={e => { e.stopPropagation(); setMobileSheetOpen(true); }}
          className="flex-shrink-0 flex md:hidden w-9 h-9 items-center justify-center rounded hover:bg-muted"
          aria-label="Thao tác danh mục"
        >
          <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="hidden md:group-hover:flex items-center gap-0.5">
          <button
            onClick={e => { e.stopPropagation(); onAddChild(cat.id); }}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-emerald-100 text-emerald-600"
            title="Thêm mục con"
          >
            <Plus className="w-3 h-3" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onEdit(cat); }}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted"
            title="Sửa tên"
          >
            <Edit2 className="w-3 h-3" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onMove(cat); }}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-sky-100 text-sky-600"
            title="Chuyển vào mục khác (kèm album & mục con)"
          >
            <FolderInput className="w-3 h-3" />
          </button>
          {effectiveIsAdmin && (
            <button
              onClick={e => { e.stopPropagation(); onDelete(cat); }}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-destructive/10 text-destructive"
              title="Xoá danh mục"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* MOBILE: bottom sheet thao tác danh mục (gồm "Chuyển vào mục khác" cho cả mục mẹ) */}
      <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
        <SheetContent side="bottom" className="h-auto max-h-[70vh] rounded-t-2xl px-0 pb-6">
          <SheetHeader className="px-4 pb-2 border-b">
            <SheetTitle className="text-base">{cat.name}</SheetTitle>
            <SheetDescription className="text-xs">
              {counts.get(cat.id) ?? 0} album · {children.length} mục con
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

      {hasChildren && isOpen && (
        <SortableList
          items={children}
          onReorder={ids => onReorder(cat.id, ids)}
          renderItem={c => (
            <CatNode key={c.id} cat={c} depth={depth + 1} allCats={allCats} handlers={handlers} />
          )}
        />
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────
export default function CmsGalleryPage() {
  const qc = useQueryClient();
  const effectiveIsAdmin = true; // CMS Website mở toàn quyền cho mọi nhân viên
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editAlbum, setEditAlbum] = useState<Partial<Album> | null>(null);
  const [editTab, setEditTab] = useState<"info" | "photos">("info");
  const [search, setSearch] = useState("");
  const [mobileView, setMobileView] = useState<"cats" | "albums">("cats");
  // Bộ lọc thông minh
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "visible" | "hidden" | "draft">("all");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  const { data: catsAll = [], isLoading: catsLoading } = useQuery<GalleryCat[]>({
    queryKey: ["cms-categories", "gallery"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/categories?type=gallery`, { headers: authHeaders() }).then(r => r.json()),
  });
  const cats = useMemo(() => catsAll.filter(c => c.type === "gallery"), [catsAll]);
  const rootCats = useMemo(
    () => cats.filter(c => c.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder),
    [cats]
  );
  const countMap = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of cats) m.set(c.id, c.productCount ?? 0);
    return m;
  }, [cats]);
  const selectedCat = useMemo(() => cats.find(c => c.id === selectedCatId) ?? null, [cats, selectedCatId]);
  const breadcrumb = useMemo(
    () => (selectedCatId ? buildBreadcrumb(cats, selectedCatId) : ""),
    [cats, selectedCatId]
  );

  // Albums: lọc theo nhánh hoặc tất cả nếu chưa chọn
  const albumsQueryKey = useMemo(() => ["cms-albums", selectedCatId ?? "all"], [selectedCatId]);
  const { data: albums = [], isLoading: albumsLoading } = useQuery<Album[]>({
    queryKey: albumsQueryKey,
    queryFn: () => {
      const url = new URL(`${CMS_BASE}/api/cms/albums`, window.location.origin);
      if (selectedCatId != null) url.searchParams.set("categoryId", String(selectedCatId));
      return fetch(url.toString().replace(window.location.origin, ""), { headers: authHeaders() }).then(r => r.json());
    },
  });

  // Tag lọc: gộp tag thật từ album đang xem + tag gợi ý mặc định
  const tagOptions = useMemo(() => {
    const fromData = new Set<string>();
    albums.forEach(a => (a.tagsText || "").split(/[,;]/).forEach(x => { const t = x.trim(); if (t) fromData.add(t); }));
    return mergeTagOptions([...fromData].sort(), GALLERY_TAG_DEFAULTS);
  }, [albums]);

  const filteredAlbums = useMemo(() => {
    let list = albums;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(a =>
        a.name.toLowerCase().includes(q) ||
        (a.slug ?? "").toLowerCase().includes(q) ||
        (a.tagsText ?? "").toLowerCase().includes(q)
      );
    }
    if (statusFilter !== "all") list = list.filter(a => a.status === statusFilter);
    if (selectedTags.size > 0) {
      list = list.filter(a => {
        const v = (a.tagsText || "").toLowerCase();
        return [...selectedTags].some(t => v.includes(t.toLowerCase()));
      });
    }
    return list;
  }, [albums, search, statusFilter, selectedTags]);

  const hasExtraFilter = statusFilter !== "all" || selectedTags.size > 0;
  const activeFilterCount = (statusFilter !== "all" ? 1 : 0) + selectedTags.size;
  function clearFilters() {
    setSearch(""); setStatusFilter("all"); setSelectedTags(new Set());
  }

  // ── Tích chọn hàng loạt ─────────────────────────────────────────────────────
  const { toast } = useToast();
  const bulk = useBulkSelect();
  const [moveOpen, setMoveOpen] = useState(false);
  // Cần TOÀN BỘ album (không lọc theo danh mục đang xem) để chọn theo mục mẹ/con.
  const { data: allAlbums = [] } = useQuery<Album[]>({
    queryKey: ["cms-albums", "all"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/albums`, { headers: authHeaders() }).then(r => r.json()),
  });
  const bulkInvalidate = () => {
    qc.invalidateQueries({ queryKey: ["cms-albums"] });
    qc.invalidateQueries({ queryKey: ["cms-categories", "gallery"] });
  };
  const bulkMove = useMutation({
    mutationFn: async (categoryId: number) => {
      const r = await fetch(`${CMS_BASE}/api/cms/albums/bulk-category`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ ids: [...bulk.selected], categoryId }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi chuyển danh mục");
      return r.json() as Promise<{ affected: number }>;
    },
    onSuccess: (d) => { bulkInvalidate(); setMoveOpen(false); bulk.exit(); toast({ title: `Đã chuyển ${d.affected} album` }); },
    onError: (e: Error) => toast({ title: "Lỗi chuyển danh mục", description: e.message, variant: "destructive" }),
  });
  const bulkDelete = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${CMS_BASE}/api/cms/albums/bulk-delete`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ ids: [...bulk.selected] }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi xoá");
      return r.json() as Promise<{ affected: number }>;
    },
    onSuccess: (d) => { bulkInvalidate(); bulk.exit(); toast({ title: `Đã đưa ${d.affected} album vào thùng rác` }); },
    onError: (e: Error) => toast({ title: "Lỗi xoá", description: e.message, variant: "destructive" }),
  });
  const bulkPriority = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${CMS_BASE}/api/cms/albums/bulk-priority`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify({ ids: [...bulk.selected] }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi ưu tiên");
      return r.json() as Promise<{ affected: number }>;
    },
    onSuccess: (d) => { bulkInvalidate(); bulk.exit(); toast({ title: `Đã ưu tiên ${d.affected} album lên đầu` }); },
    onError: (e: Error) => toast({ title: "Lỗi ưu tiên", description: e.message, variant: "destructive" }),
  });
  const bulkBusy = bulkMove.isPending || bulkDelete.isPending || bulkPriority.isPending;

  const catSelectState = useCallback((catId: number): TriState =>
    subtreeSelectState(itemIdsInCategorySubtree(allAlbums, cats, catId), bulk.selected),
    [allAlbums, cats, bulk.selected]);
  const toggleCatSelect = useCallback((catId: number) => {
    const ids = itemIdsInCategorySubtree(allAlbums, cats, catId);
    if (ids.length === 0) { toast({ title: "Danh mục này chưa có album" }); return; }
    const st = subtreeSelectState(ids, bulk.selected);
    bulk.toggleMany(ids, st !== "all");
    toast({ title: st === "all" ? `Đã bỏ chọn ${ids.length} album` : `Đã chọn ${ids.length} album trong danh mục này` });
  }, [allAlbums, cats, bulk, toast]);
  function handleBulkDelete() {
    const n = bulk.selected.size;
    if (n === 0) return;
    setConfirmCfg({
      message: `Đưa ${n} album đã chọn vào thùng rác? (Danh mục KHÔNG bị xoá)`,
      confirmText: "Xoá", danger: true, onConfirm: () => bulkDelete.mutate(),
    });
  }

  const saveAlbum = useMutation({
    // newPhotos: chỉ dùng khi TẠO album mới — thêm cả mảng ảnh ngay sau khi tạo (1 lần Lưu).
    mutationFn: async ({ album: a, newPhotos }: { album: Partial<Album>; newPhotos?: PendingPhoto[] }) => {
      const url = a.id ? `${CMS_BASE}/api/cms/albums/${a.id}` : `${CMS_BASE}/api/cms/albums`;
      const method = a.id ? "PATCH" : "POST";
      const r = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(a) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Lỗi lưu album");
      const saved = await r.json();
      // Album mới + có ảnh chọn sẵn → POST cả mảng (backend tự gán sort_order theo thứ tự mảng → giữ đúng thứ tự).
      if (newPhotos && newPhotos.length && saved?.id) {
        const pr = await fetch(`${CMS_BASE}/api/cms/albums/${saved.id}/photos`, {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ photos: newPhotos.map(p => ({ imageUrl: p.objectPath, mimeType: p.mimeType ?? null })) }),
        });
        if (!pr.ok) {
          const err = (await pr.json().catch(() => ({}))).error ?? `lỗi ${pr.status}`;
          throw new Error(`Đã tạo album "${saved.name ?? ""}" nhưng THÊM ẢNH lỗi: ${err}. Mở album rồi thêm lại ở tab "Ảnh album".`);
        }
      }
      return saved;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-albums"] });
      qc.invalidateQueries({ queryKey: ["cms-categories", "gallery"] });
      qc.invalidateQueries({ queryKey: ["cms-photos"] });
      setEditAlbum(null);
    },
    onError: (e) => toast({ title: "Lỗi lưu album", description: String((e as Error).message) }),
  });

  const deleteAlbum = useMutation({
    mutationFn: (id: number) => fetch(`${CMS_BASE}/api/cms/albums/${id}`, { method: "DELETE", headers: authHeaders() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-albums"] });
      qc.invalidateQueries({ queryKey: ["cms-categories", "gallery"] });
    },
  });

  const reorderAlbums = useMutation({
    mutationFn: (orderedIds: number[]) => {
      const order = orderedIds.map((id, idx) => ({ id, sortOrder: idx + 1 }));
      return fetch(`${CMS_BASE}/api/cms/albums/reorder`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify({ order }),
      });
    },
    onMutate: (ids: number[]) => {
      qc.setQueryData<Album[]>(albumsQueryKey, (old = []) => {
        const map = new Map(old.map(a => [a.id, a]));
        return ids.map((id, idx) => ({ ...(map.get(id) as Album), sortOrder: idx + 1 }));
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cms-albums"] }),
  });

  // ── Category CRUD + reorder ──────────────────────────────────────────────
  const createCat = useMutation({
    mutationFn: (p: { name: string; parentId: number | null }) =>
      fetch(`${CMS_BASE}/api/cms/categories`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ type: "gallery", parentId: p.parentId, name: p.name.trim() }),
      }).then(async r => { if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi tạo"); return r.json() as Promise<GalleryCat>; }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["cms-categories", "gallery"] });
      if (created.parentId != null) {
        const pid = created.parentId;
        setExpanded(prev => { const n = new Set(prev); n.add(pid); return n; });
      }
    },
    onError: (e: Error) => alert(e.message),
  });
  const updateCat = useMutation({
    mutationFn: (p: { id: number; name?: string; parentId?: number | null }) => {
      const { id, ...body } = p;
      return fetch(`${CMS_BASE}/api/cms/categories/${id}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify(body),
      }).then(async r => { if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi lưu"); });
    },
    onSuccess: () => {
      // Đổi parentId → cây + số đếm album đổi theo → refetch cả hai.
      qc.invalidateQueries({ queryKey: ["cms-categories", "gallery"] });
      qc.invalidateQueries({ queryKey: ["cms-albums"] });
    },
    onError: (e: Error) => alert(e.message),
  });
  const deleteCat = useMutation({
    mutationFn: (id: number) =>
      fetch(`${CMS_BASE}/api/cms/categories/${id}`, { method: "DELETE", headers: authHeaders() })
        .then(async r => { if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi xoá"); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-categories", "gallery"] });
      qc.invalidateQueries({ queryKey: ["cms-albums"] });
      setSelectedCatId(null);
    },
    onError: (e: Error) => alert(e.message),
  });
  const reorderCats = useMutation({
    mutationFn: (orderedIds: number[]) =>
      fetch(`${CMS_BASE}/api/cms/categories/reorder`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ order: orderedIds.map((id, idx) => ({ id, sortOrder: idx })) }),
      }).then(async r => { if (!r.ok) throw new Error("Lỗi sắp xếp"); }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cms-categories", "gallery"] }),
  });

  // Modal thay cho window.prompt/confirm (preview webview KHÔNG hỗ trợ prompt/confirm).
  const [promptCfg, setPromptCfg] = useState<PromptCfg | null>(null);
  const [confirmCfg, setConfirmCfg] = useState<ConfirmCfg | null>(null);
  // Danh mục đang được "Chuyển vào mục khác" (đổi cha — album & mục con đi theo).
  const [movingCat, setMovingCat] = useState<GalleryCat | null>(null);
  function handleMoveCat(cat: GalleryCat) { setMovingCat(cat); }
  function handleAddRoot() {
    setPromptCfg({
      title: "Thêm danh mục gốc", label: "Tên danh mục gốc:", confirmText: "Tạo",
      onConfirm: (name) => createCat.mutate({ name, parentId: null }),
    });
  }
  function handleAddChild(parentId: number) {
    setPromptCfg({
      title: "Thêm mục con", label: "Tên mục con:", confirmText: "Tạo",
      onConfirm: (name) => createCat.mutate({ name, parentId }),
    });
  }
  function handleEditCat(cat: GalleryCat) {
    setPromptCfg({
      title: "Đổi tên danh mục", label: "Tên danh mục:", defaultValue: cat.name, confirmText: "Lưu",
      onConfirm: (name) => { if (name !== cat.name) updateCat.mutate({ id: cat.id, name }); },
    });
  }
  function handleDeleteCat(cat: GalleryCat) {
    const n = countMap.get(cat.id) ?? 0;
    const msg = n > 0
      ? `Xoá "${cat.name}"? ${n} album thuộc nhánh này sẽ chuyển sang "Chưa phân loại".`
      : `Xoá danh mục "${cat.name}"?`;
    setConfirmCfg({ message: msg, confirmText: "Xoá", danger: true, onConfirm: () => deleteCat.mutate(cat.id) });
  }
  function handleReorderCats(_parentId: number | null, orderedIds: number[]) {
    reorderCats.mutate(orderedIds);
  }

  // Tự expand cha của mục đang chọn để dễ thấy
  useEffect(() => {
    if (selectedCatId == null) return;
    const map = new Map(cats.map(c => [c.id, c]));
    const toOpen = new Set(expanded);
    let cur = map.get(selectedCatId);
    while (cur?.parentId != null) {
      toOpen.add(cur.parentId);
      cur = map.get(cur.parentId);
    }
    if (toOpen.size !== expanded.size) setExpanded(toOpen);
  }, [selectedCatId, cats, expanded]);

  function toggleExpand(id: number) {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function handleSelectCat(id: number) {
    setSelectedCatId(id);
    setMobileView("albums");
  }

  // Descendant set (dùng khi cần check assignment-mismatch nếu cần sau này)
  const descIds = selectedCatId != null ? getDescendantIds(cats, selectedCatId) : null;
  void descIds;

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden">
      {/* Left: tree */}
      <aside className={`w-full md:w-60 xl:w-72 flex-shrink-0 border-r flex flex-col bg-muted/10 overflow-hidden ${mobileView === "cats" ? "flex-1 md:flex-initial" : "hidden md:flex"}`}>
        <div className="flex items-center justify-between px-3 py-3 border-b bg-background">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <FolderTree className="w-3.5 h-3.5 text-primary" /> Danh mục ảnh
          </h2>
          <div className="flex items-center gap-0.5">
            <a
              href={getPublicPageUrl("/bo-anh")}
              target="_blank"
              rel="noopener noreferrer"
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Xem trang Ảnh sản phẩm thật trên website"
            >
              <Globe className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={handleAddRoot}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Thêm mục gốc"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1 px-1">
          <div
            className={`flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer hover:bg-muted text-sm ${selectedCatId === null ? "bg-primary/10 text-primary font-semibold" : ""}`}
            onClick={() => { setSelectedCatId(null); setMobileView("albums"); }}
          >
            <Images className="w-3.5 h-3.5" /> Tất cả album
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{albums.length}</span>
          </div>
          {catsLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : rootCats.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground px-4">
              <Tag className="w-8 h-8 mx-auto mb-2 opacity-20" />
              <p className="text-xs">Chưa có danh mục ảnh.</p>
              <p className="text-[11px] mt-1">Tạo trong trang Danh mục (loại "Bộ ảnh").</p>
            </div>
          ) : (
            <div className="mt-1">
              <SortableList
                items={rootCats}
                onReorder={ids => handleReorderCats(null, ids)}
                renderItem={c => (
                  <CatNode
                    key={c.id} cat={c} depth={0} allCats={cats}
                    handlers={{
                      expanded, selectedId: selectedCatId,
                      onSelect: handleSelectCat, onToggle: toggleExpand,
                      counts: countMap,
                      onAddChild: handleAddChild,
                      onEdit: handleEditCat,
                      onMove: handleMoveCat,
                      onDelete: handleDeleteCat,
                      onReorder: handleReorderCats,
                      effectiveIsAdmin,
                      selectMode: bulk.selectMode,
                      catSelectState,
                      onToggleCatSelect: toggleCatSelect,
                    }}
                  />
                )}
              />
            </div>
          )}
        </div>
      </aside>

      {/* Right: albums grid */}
      <main className={`flex-1 flex flex-col overflow-hidden ${mobileView === "albums" ? "flex" : "hidden md:flex"}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b bg-background gap-3">
          <div className="min-w-0 flex-1">
            <button
              onClick={() => setMobileView("cats")}
              className="md:hidden flex items-center gap-1 text-xs text-primary mb-1"
            >
              <ArrowLeft className="w-3 h-3" /> Danh mục
            </button>
            <h1 className="font-bold text-base truncate flex items-center gap-2">
              <Images className="w-4 h-4 text-primary flex-shrink-0" />
              {selectedCat ? selectedCat.name : "Tất cả album"}
            </h1>
            {selectedCat && breadcrumb && breadcrumb !== selectedCat.name && (
              <p className="text-xs text-muted-foreground truncate">{breadcrumb}</p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              {filteredAlbums.length} album{albumsLoading ? " · đang tải..." : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant={bulk.selectMode ? "default" : "outline"}
              onClick={() => (bulk.selectMode ? bulk.exit() : bulk.enter())}
              className="gap-1.5 whitespace-nowrap"
              title="Chọn nhiều album để thao tác hàng loạt"
            >
              <CheckSquare className="w-4 h-4" />
              <span className="hidden sm:inline">{bulk.selectMode ? "Xong" : "Tích chọn"}</span>
            </Button>
            {!bulk.selectMode && (
              <Button
                onClick={() => setEditAlbum({ status: "visible", categoryId: selectedCatId ?? null })}
                className="gap-1.5 whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">Tạo album</span>
                <span className="sm:hidden">Tạo</span>
              </Button>
            )}
          </div>
        </div>

        <div className="px-4 py-2 border-b bg-background space-y-1.5">
          {/* Hàng 1: tìm kiếm + nút bộ lọc nâng cao */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Tên, slug, tags..." className="pl-8 h-8 text-sm w-full"
              />
              {search && (
                <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                  <X className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setFilterOpen(v => !v)}
              className={`flex items-center gap-1.5 h-8 px-2.5 text-xs rounded-md border transition-colors flex-shrink-0 ${
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
              <button onClick={clearFilters} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 flex-shrink-0">
                <X className="w-3 h-3" /> Xoá lọc
              </button>
            )}
          </div>

          {/* Hàng 2: chip danh mục cha/con — bấm là lọc ngay (gồm cả album mục con) */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            <span className="text-[10px] text-muted-foreground flex-shrink-0 w-12">Mục:</span>
            <button type="button" onClick={() => setSelectedCatId(null)}
              className={`flex-shrink-0 px-2 py-0.5 text-xs rounded-full border transition-all ${
                selectedCatId === null
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-muted-foreground border-border hover:border-foreground"
              }`}>
              Tất cả
            </button>
            {rootCats.map(c => (
              <button key={c.id} type="button" onClick={() => setSelectedCatId(c.id)}
                className={`flex-shrink-0 px-2 py-0.5 text-xs rounded-full border transition-all ${
                  selectedCatId === c.id
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background text-muted-foreground border-border hover:border-foreground"
                }`}>
                {c.name}{c.productCount ? ` (${c.productCount})` : ""}
              </button>
            ))}
          </div>
          {/* Mục con của danh mục đang chọn (nếu có) */}
          {selectedCatId !== null && cats.some(c => c.parentId === selectedCatId) && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              <span className="text-[10px] text-muted-foreground flex-shrink-0 w-12">Con:</span>
              {cats.filter(c => c.parentId === selectedCatId).sort((a, b) => a.sortOrder - b.sortOrder).map(c => (
                <button key={c.id} type="button" onClick={() => setSelectedCatId(c.id)}
                  className="flex-shrink-0 px-2 py-0.5 text-xs rounded-full border bg-background text-muted-foreground border-border hover:border-foreground transition-all">
                  {c.name}{c.productCount ? ` (${c.productCount})` : ""}
                </button>
              ))}
            </div>
          )}

          {/* Bộ lọc nâng cao: tag + trạng thái hiển thị */}
          {filterOpen && (
            <div className="space-y-1.5 pt-1 border-t border-dashed">
              <FilterChipRow
                label="Tags:" options={tagOptions} selected={selectedTags}
                onToggle={t => setSelectedTags(prev => { const n = new Set(prev); if (n.has(t)) n.delete(t); else n.add(t); return n; })}
              />
              <FilterRadioRow
                label="Hiện:" value={statusFilter} onChange={setStatusFilter}
                options={[
                  { key: "all", label: "Tất cả" },
                  { key: "visible", label: "Hiển thị" },
                  { key: "hidden", label: "Ẩn" },
                  { key: "draft", label: "Nháp" },
                ]}
              />
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {albumsLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : filteredAlbums.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-center">
              <Images className="w-12 h-12 mb-3 opacity-20" />
              <p className="font-medium">
                {search || hasExtraFilter ? "Không tìm thấy album khớp bộ lọc" : selectedCat ? "Chưa có album trong mục này" : "Chưa có album nào"}
              </p>
              {!search && !hasExtraFilter && (
                <Button size="sm" className="mt-4 gap-1.5" onClick={() => { setEditTab("info"); setEditAlbum({ status: "visible", categoryId: selectedCatId ?? null }); }}>
                  <Plus className="w-4 h-4" /> Tạo album đầu tiên
                </Button>
              )}
            </div>
          ) : (
            <SortableList
              items={filteredAlbums}
              onReorder={ids => {
                // Chỉ cho phép kéo thả khi đang xem "Tất cả album" + không lọc gì
                // (sort_order là global, kéo trong tập đã lọc sẽ gây trùng số thứ tự).
                if (selectedCatId !== null || search.trim() !== "" || hasExtraFilter) return;
                reorderAlbums.mutate(ids);
              }}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
              renderItem={(a, dh) => {
                const canReorder = selectedCatId === null && search.trim() === "" && !hasExtraFilter && !bulk.selectMode;
                const isSel = bulk.selected.has(a.id);
                return (
                <div
                  className={`group rounded-2xl border bg-card overflow-hidden transition-shadow ${
                    bulk.selectMode
                      ? `cursor-pointer ${isSel ? "border-primary ring-2 ring-primary/40" : "border-border hover:border-primary/40"}`
                      : "border-border hover:shadow-md"
                  }`}
                  onClick={bulk.selectMode ? () => bulk.toggle(a.id) : undefined}
                >
                  <div className="relative aspect-[4/3] bg-muted">
                    <LazyImage src={a.coverImageUrl} alt={a.name} className="w-full h-full" />
                    {bulk.selectMode ? (
                      <div className="absolute top-2 left-2"><TriCheckbox state={isSel} /></div>
                    ) : canReorder && (
                    <div className="absolute top-2 left-2">
                      <span {...dh} className={`${dh.className} bg-white/90 dark:bg-black/60 rounded-md p-1 shadow-sm`}>
                        <GripVertical className="w-4 h-4" />
                      </span>
                    </div>
                    )}
                    <div className="absolute top-2 right-2">
                      <StatusBadge status={a.status} />
                    </div>
                  </div>
                  <div className="p-3 space-y-2">
                    <div>
                      <p className="font-semibold text-sm truncate">{a.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {a.categoryId
                          ? (buildBreadcrumb(cats, a.categoryId) || "—")
                          : <span className="text-amber-600">Chưa phân loại</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{a.photoCount} ảnh</p>
                    </div>
                    {!bulk.selectMode && (
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="flex-1 gap-1" onClick={() => { setEditTab("photos"); setEditAlbum(a); }}>
                        <Images className="w-3.5 h-3.5" /> Ảnh ({a.photoCount})
                      </Button>
                      <Button size="sm" variant="ghost" className="px-2" onClick={() => { setEditTab("info"); setEditAlbum(a); }}>
                        <Edit2 className="w-3.5 h-3.5" />
                      </Button>
                      {effectiveIsAdmin && (
                        <Button size="sm" variant="ghost" className="px-2 text-destructive" onClick={() => {
                          setConfirmCfg({
                            message: `Đưa album "${a.name}" vào thùng rác?`,
                            confirmText: "Xoá", danger: true, onConfirm: () => deleteAlbum.mutate(a.id),
                          });
                        }}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                    )}
                  </div>
                </div>
                );
              }}
            />
          )}
        </div>
      </main>

      {editAlbum && (
        <AlbumEditorModal
          album={editAlbum} cats={cats} onClose={() => setEditAlbum(null)}
          onSave={(a, newPhotos) => saveAlbum.mutate({ album: a, newPhotos })} saving={saveAlbum.isPending}
          defaultTab={editTab} effectiveIsAdmin={effectiveIsAdmin}
          onCategoryCreated={() => qc.invalidateQueries({ queryKey: ["cms-categories", "gallery"] })}
        />
      )}

      {bulk.selectMode && (
        <BulkActionBar
          count={bulk.selected.size}
          busy={bulkBusy}
          onPriority={() => bulk.selected.size > 0 && bulkPriority.mutate()}
          onMove={() => bulk.selected.size > 0 && setMoveOpen(true)}
          onDelete={handleBulkDelete}
          onClear={bulk.clear}
        />
      )}
      {moveOpen && (
        <BulkMoveDialog
          cats={cats}
          count={bulk.selected.size}
          busy={bulkMove.isPending}
          onConfirm={(cid) => bulkMove.mutate(cid)}
          onClose={() => setMoveOpen(false)}
        />
      )}
      <PromptDialog cfg={promptCfg} onClose={() => setPromptCfg(null)} />
      <ConfirmDialog cfg={confirmCfg} onClose={() => setConfirmCfg(null)} />
      {movingCat && (
        <MoveCategoryDialog
          cat={movingCat}
          cats={cats}
          busy={updateCat.isPending}
          onConfirm={(parentId) => {
            if (parentId !== (movingCat.parentId ?? null)) updateCat.mutate({ id: movingCat.id, parentId });
            setMovingCat(null);
          }}
          onClose={() => setMovingCat(null)}
        />
      )}
    </div>
  );
}

// ─── Dialog thay cho window.prompt / confirm ─────────────────────────────────
// Preview webview (Vite runtime) KHÔNG hỗ trợ prompt()/confirm() → gọi là nổ
// runtime-error. Hai modal nhỏ dưới đây thay thế, dùng đúng style modal sẵn có.
type PromptCfg = {
  title: string; label?: string; defaultValue?: string; confirmText?: string;
  onConfirm: (value: string) => void;
};
function PromptDialog({ cfg, onClose }: { cfg: PromptCfg | null; onClose: () => void }) {
  const [value, setValue] = useState("");
  useEffect(() => { setValue(cfg?.defaultValue ?? ""); }, [cfg]);
  if (!cfg) return null;
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    cfg.onConfirm(v);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-2xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h3 className="font-semibold">{cfg.title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-2">
          {cfg.label && <label className="text-sm font-medium">{cfg.label}</label>}
          <Input
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); }}
          />
        </div>
        <div className="px-5 py-4 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Huỷ</Button>
          <Button onClick={submit} disabled={!value.trim()}>{cfg.confirmText ?? "Lưu"}</Button>
        </div>
      </div>
    </div>
  );
}

type ConfirmCfg = {
  message: string; confirmText?: string; danger?: boolean;
  onConfirm: () => void;
};
function ConfirmDialog({ cfg, onClose }: { cfg: ConfirmCfg | null; onClose: () => void }) {
  if (!cfg) return null;
  const accept = () => { cfg.onConfirm(); onClose(); };
  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-2xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="p-5 space-y-1">
          <h3 className="font-semibold">Xác nhận</h3>
          <p className="text-sm text-muted-foreground whitespace-pre-line">{cfg.message}</p>
        </div>
        <div className="px-5 py-4 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Huỷ</Button>
          <Button variant={cfg.danger ? "destructive" : "default"} onClick={accept}>{cfg.confirmText ?? "Đồng ý"}</Button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; Icon: typeof Eye }> = {
    visible: { label: "Hiển thị", cls: "bg-emerald-100 text-emerald-700", Icon: Eye },
    hidden: { label: "Ẩn", cls: "bg-slate-200 text-slate-700", Icon: EyeOff },
    draft: { label: "Nháp", cls: "bg-amber-100 text-amber-700", Icon: FileText },
  };
  const m = map[status] ?? map.draft;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${m.cls}`}>
      <m.Icon className="w-3 h-3" /> {m.label}
    </span>
  );
}

function AlbumEditorModal({
  album, cats, onClose, onSave, saving, defaultTab = "info", effectiveIsAdmin, onCategoryCreated,
}: {
  album: Partial<Album>; cats: GalleryCat[]; onClose: () => void;
  onSave: (a: Partial<Album>, newPhotos?: PendingPhoto[]) => void; saving: boolean;
  defaultTab?: "info" | "photos";
  effectiveIsAdmin: boolean;
  onCategoryCreated?: () => void;
}) {
  const [draft, setDraft] = useState<Partial<Album>>(album);
  const [tab, setTab] = useState<"info" | "photos">(album.id ? defaultTab : "info");
  const commonTags = useCommonTags(GALLERY_TAG_KEY, GALLERY_TAG_DEFAULTS);
  const [creatingCat, setCreatingCat] = useState<string | null>(null);

  // ── Album MỚI: upload nhiều ảnh + chọn bìa NGAY trong modal (lưu 1 lần) ──
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [coverId, setCoverId] = useState<number | null>(null);
  const pendIdRef = useRef(1);
  const addPending = (imgs: UploadedImage[]) => {
    const added = imgs.map(im => ({ id: pendIdRef.current++, objectPath: im.objectPath, mimeType: im.mimeType }));
    if (!added.length) return;
    setPending(prev => [...prev, ...added]);
    setCoverId(c => c ?? added[0].id);   // chưa chọn bìa → mặc định lấy ảnh đầu tiên
  };
  const removePending = (id: number) => setPending(prev => {
    const next = prev.filter(p => p.id !== id);
    setCoverId(c => (c === id ? (next[0]?.id ?? null) : c));
    return next;
  });

  // Bấm chip danh mục gợi ý: chọn danh mục trùng tên nếu có, chưa có thì tạo mới
  const normCat = (s: string) =>
    normalizeTag(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
  async function pickSuggestedCategory(name: string) {
    const existing = cats.find(c => normCat(c.name) === normCat(name));
    if (existing) { setDraft(d => ({ ...d, categoryId: existing.id })); return; }
    if (creatingCat) return;
    setCreatingCat(name);
    try {
      const r = await fetch(`${CMS_BASE}/api/cms/categories`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ type: "gallery", name }),
      });
      const row = await r.json().catch(() => ({}));
      if (r.ok && row?.id) {
        setDraft(d => ({ ...d, categoryId: row.id }));
        onCategoryCreated?.();
      }
    } finally { setCreatingCat(null); }
  }
  // Tạo option list dưới dạng cây phẳng có indent
  const sortedOptions = useMemo(() => {
    const out: Array<{ id: number; label: string; depth: number }> = [];
    const childrenOf = new Map<number | null, GalleryCat[]>();
    for (const c of cats) {
      const list = childrenOf.get(c.parentId) ?? [];
      list.push(c); childrenOf.set(c.parentId, list);
    }
    for (const arr of childrenOf.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);
    function walk(parent: number | null, depth: number) {
      for (const c of childrenOf.get(parent) ?? []) {
        out.push({ id: c.id, label: `${"— ".repeat(depth)}${c.name}`, depth });
        walk(c.id, depth + 1);
      }
    }
    walk(null, 0);
    return out;
  }, [cats]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div
        className={`bg-background rounded-2xl shadow-xl w-full max-h-[95vh] flex flex-col ${tab === "photos" ? "max-w-5xl" : "max-w-lg"}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b flex items-center justify-between flex-shrink-0">
          <h3 className="font-semibold truncate">{draft.id ? (draft.name ?? "Sửa album") : "Tạo album mới"}</h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="w-4 h-4" /></button>
        </div>
        {draft.id && (
          <div className="px-5 border-b flex gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => setTab("info")}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === "info" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              Thông tin
            </button>
            <button
              type="button"
              onClick={() => setTab("photos")}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${tab === "photos" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              <Images className="w-3.5 h-3.5" /> Ảnh album
            </button>
          </div>
        )}
        {tab === "photos" && draft.id ? (
          <div className="flex-1 overflow-y-auto">
            <AlbumPhotosTab
              album={draft as Album}
              effectiveIsAdmin={effectiveIsAdmin}
              onCoverChanged={url => setDraft(d => ({ ...d, coverImageUrl: url }))}
            />
          </div>
        ) : (
        <div className="p-5 space-y-3 overflow-y-auto flex-1">
          <div>
            <label className="text-sm font-medium">Tên album *</label>
            <Input value={draft.name ?? ""} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="VD: Album cưới Trang & Minh" />
          </div>
          <div>
            <label className="text-sm font-medium">Danh mục</label>
            <select
              value={draft.categoryId ?? ""}
              onChange={e => setDraft(d => ({ ...d, categoryId: e.target.value ? +e.target.value : null }))}
              className="w-full mt-1 px-3 py-2 text-sm border border-input rounded-md bg-background"
            >
              <option value="">— Chưa phân loại —</option>
              {sortedOptions.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {ALBUM_CATEGORY_SUGGESTIONS.map(name => {
                const existing = cats.find(c => normCat(c.name) === normCat(name));
                const active = existing != null && draft.categoryId === existing.id;
                return (
                  <button
                    key={name} type="button"
                    onClick={() => void pickSuggestedCategory(name)}
                    disabled={creatingCat !== null}
                    title={existing ? "Chọn danh mục này" : "Chưa có — bấm để tạo và chọn"}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all disabled:opacity-50 ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : existing
                          ? "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                          : "bg-background text-muted-foreground border-dashed border-border hover:border-primary/50 hover:text-foreground"
                    }`}
                  >
                    {creatingCat === name ? "Đang tạo…" : `${active ? "✓ " : existing ? "" : "+ "}${name}`}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Slug (URL)</label>
            <Input value={draft.slug ?? ""} onChange={e => setDraft(d => ({ ...d, slug: e.target.value }))} placeholder="vd: trang-minh-cuoi" />
          </div>
          <div>
            <label className="text-sm font-medium">Mô tả</label>
            <textarea
              value={draft.description ?? ""} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
              className="w-full mt-1 px-3 py-2 text-sm border border-input rounded-md bg-background" rows={3}
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Tags</label>
            <ChipSuggest
              label="Bấm để thêm/bỏ. Tự gợi ý dựa trên tags đã dùng."
              suggestions={commonTags.list}
              value={draft.tagsText ?? ""}
              onChange={v => setDraft(d => ({ ...d, tagsText: v }))}
              onAddSuggestion={commonTags.add}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Trạng thái</label>
            <select
              value={draft.status ?? "draft"} onChange={e => setDraft(d => ({ ...d, status: e.target.value as Album["status"] }))}
              className="w-full mt-1 px-3 py-2 text-sm border border-input rounded-md bg-background"
            >
              <option value="draft">Nháp</option>
              <option value="visible">Hiển thị public</option>
              <option value="hidden">Ẩn</option>
            </select>
          </div>
          {/* SỬA album: ảnh bìa upload riêng (quản lý ảnh ở tab "Ảnh album"). */}
          {draft.id && (
            <div>
              <label className="text-sm font-medium">Ảnh bìa</label>
              {draft.coverImageUrl && (
                <div className="mt-1.5 mb-2">
                  <LazyImage src={draft.coverImageUrl} className="w-32 h-24 rounded-md" />
                </div>
              )}
              <MultiImageUploader
                multiple={false}
                label="Bấm hoặc kéo thả ảnh bìa"
                onUploaded={imgs => setDraft(d => ({ ...d, coverImageUrl: imgs[0]?.objectPath }))}
              />
            </div>
          )}

          {/* TẠO album mới: upload nhiều ảnh + chọn bìa NGAY tại đây, lưu 1 lần. */}
          {!draft.id && (
            <div>
              <label className="text-sm font-medium block mb-1">Ảnh album</label>
              <MultiImageUploader
                multiple
                useQueue={false}
                label="Kéo thả / dán Ctrl+V / bấm để thêm nhiều ảnh"
                onUploaded={addPending}
              />
              {pending.length > 0 && (
                <div className="mt-2">
                  <p className="text-[11px] text-muted-foreground mb-1">{pending.length} ảnh · kéo để đổi thứ tự · bấm ⭐ để chọn ảnh bìa (mặc định: ảnh đầu)</p>
                  <SortableList
                    items={pending}
                    onReorder={ids => setPending(prev => ids.map(id => prev.find(p => p.id === id)).filter(Boolean) as PendingPhoto[])}
                    className="grid grid-cols-3 sm:grid-cols-4 gap-2"
                    renderItem={(p, dh) => {
                      const isCover = coverId === p.id;
                      return (
                        <div className={`relative group rounded-lg overflow-hidden border bg-card ${isCover ? "border-amber-400 ring-2 ring-amber-300" : "border-border"}`}>
                          <LazyImage src={p.objectPath} className="aspect-square w-full" />
                          {isCover && (
                            <div className="absolute top-1 left-1 bg-amber-400 text-amber-950 text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 shadow">
                              <Star className="w-3 h-3 fill-current" /> Bìa
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-between p-1.5 gap-1">
                            <span {...dh} className={`${dh.className} bg-white/90 rounded p-1`}><GripVertical className="w-4 h-4" /></span>
                            <div className="flex items-center gap-1">
                              <button type="button" onClick={() => setCoverId(p.id)} disabled={isCover}
                                className={`rounded p-1 transition ${isCover ? "bg-amber-400 text-amber-950" : "bg-white/90 text-amber-600 hover:bg-amber-100"}`}
                                title={isCover ? "Đang là ảnh bìa" : "Đặt làm ảnh bìa"}>
                                <Star className={`w-4 h-4 ${isCover ? "fill-current" : ""}`} />
                              </button>
                              <button type="button" onClick={() => removePending(p.id)}
                                className="bg-destructive text-destructive-foreground rounded p-1 hover:scale-110 transition-transform" title="Xoá ảnh này">
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
        )}
        <div className="px-5 py-3 border-t flex justify-end gap-2 flex-shrink-0">
          <Button variant="outline" onClick={onClose}>{tab === "photos" ? "Đóng" : "Huỷ"}</Button>
          {tab === "info" && (
            <Button
              onClick={() => {
                if (draft.id) { onSave(draft); return; }
                // Album mới: bìa = ảnh đã chọn (⭐) hoặc ảnh đầu; gửi kèm toàn bộ ảnh theo thứ tự.
                const cover = pending.find(p => p.id === coverId) ?? pending[0];
                onSave({ ...draft, coverImageUrl: cover?.objectPath ?? draft.coverImageUrl ?? null }, pending);
              }}
              disabled={saving || !draft.name?.trim()}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Lưu
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function AlbumPhotosTab({
  album, effectiveIsAdmin, onCoverChanged,
}: { album: Album; effectiveIsAdmin: boolean; onCoverChanged?: (url: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, fetchNextPage, hasNextPage, isFetching } = usePhotosPagination(album.id);
  const photos = useMemo(() => data?.pages.flatMap(p => p.items) ?? [], [data]);
  const [currentCover, setCurrentCover] = useState<string | null>(album.coverImageUrl);
  const [confirmCfg, setConfirmCfg] = useState<ConfirmCfg | null>(null); // thay window.confirm

  const { data: caps } = useQuery<Capabilities>({
    queryKey: ["cms-capabilities"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/capabilities`, { headers: authHeaders() }).then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const addPhotos = useMutation({
    mutationFn: async (imgs: UploadedImage[]) => {
      const r = await fetch(`${CMS_BASE}/api/cms/albums/${album.id}/photos`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ photos: imgs.map(i => ({ imageUrl: i.objectPath, mimeType: i.mimeType, caption: null })) }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Lỗi lưu ảnh");
      return imgs.length;
    },
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ["cms-photos", album.id] });
      qc.invalidateQueries({ queryKey: ["cms-albums"] });
      qc.invalidateQueries({ queryKey: ["public-gallery-albums"] });
      qc.invalidateQueries({ queryKey: ["public-gallery-album", album.slug] });
      qc.invalidateQueries({ queryKey: ["public-gallery-categories"] });
      toast({ title: "Đã thêm ảnh", description: `${count} ảnh vào "${album.name}"` });
    },
    onError: (e: Error) => toast({ title: "Lỗi upload", description: e.message, variant: "destructive" }),
  });

  const deletePhoto = useMutation({
    mutationFn: (id: number) => fetch(`${CMS_BASE}/api/cms/photos/${id}`, { method: "DELETE", headers: authHeaders() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-photos", album.id] });
      qc.invalidateQueries({ queryKey: ["cms-albums"] });
      qc.invalidateQueries({ queryKey: ["public-gallery-albums"] });
      qc.invalidateQueries({ queryKey: ["public-gallery-album", album.slug] });
      qc.invalidateQueries({ queryKey: ["public-gallery-categories"] });
      toast({ title: "Đã xoá ảnh" });
    },
  });

  const reorderPhotos = useMutation({
    mutationFn: (orderedIds: number[]) => {
      const order = orderedIds.map((id, idx) => ({ id, sortOrder: idx + 1 }));
      return fetch(`${CMS_BASE}/api/cms/photos/reorder`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify({ order }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-photos", album.id] });
      qc.invalidateQueries({ queryKey: ["public-gallery-album", album.slug] });
      qc.invalidateQueries({ queryKey: ["public-gallery-albums"] });
    },
  });

  const setCover = useMutation({
    mutationFn: async (photo: Photo) => {
      const r = await fetch(`${CMS_BASE}/api/cms/albums/${album.id}/cover`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ photoId: photo.id }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi đặt bìa");
      return r.json() as Promise<{ coverImageUrl: string }>;
    },
    onSuccess: (data) => {
      setCurrentCover(data.coverImageUrl);
      onCoverChanged?.(data.coverImageUrl);
      qc.invalidateQueries({ queryKey: ["cms-albums"] });
      qc.invalidateQueries({ queryKey: ["cms-categories", "gallery"] });
      qc.invalidateQueries({ queryKey: ["public-gallery-albums"] });
      qc.invalidateQueries({ queryKey: ["public-gallery-album", album.slug] });
      qc.invalidateQueries({ queryKey: ["public-gallery-categories"] });
      toast({ title: "Đã đặt ảnh bìa" });
    },
    onError: (e: Error) => toast({ title: "Lỗi đặt bìa", description: e.message, variant: "destructive" }),
  });

  const photoCount = photos.filter(p => !isVideoMime(p.mimeType)).length;
  const videoCount = photos.filter(p => isVideoMime(p.mimeType)).length;

  return (
    <div className="p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground">
          {photoCount} ảnh{videoCount > 0 ? ` · ${videoCount} video` : ""} trong album
        </p>
        <StatusBadge status={album.status} />
      </div>

      <MultiImageUploader
        label="Kéo thả / bấm để upload nhiều ảnh"
        onUploaded={imgs => addPhotos.mutate(imgs)}
      />

      <VideoUploaderButton
        caps={caps}
        onUploaded={vids => addPhotos.mutate(vids)}
      />

      {photos.length === 0 ? (
        <div className="text-center py-10 text-sm text-muted-foreground border-2 border-dashed border-border rounded-2xl">
          Album chưa có ảnh nào. Upload ảnh ở khung phía trên.
        </div>
      ) : (
        <SortableList
          items={photos as Photo[]}
          onReorder={ids => reorderPhotos.mutate(ids)}
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3"
          renderItem={(p, dh) => {
            const isVid = isVideoMime(p.mimeType);
            const isCover = currentCover === p.imageUrl;
            return (
              <div className={`relative group rounded-lg overflow-hidden border bg-card ${isCover ? "border-amber-400 ring-2 ring-amber-300" : "border-border"}`}>
                {isVid ? (
                  <div className="relative aspect-square w-full bg-black">
                    <video
                      src={getImageSrc(p.imageUrl) ?? undefined}
                      preload="metadata"
                      className="w-full h-full object-cover"
                      muted
                    />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="bg-black/60 rounded-full p-3">
                        <Play className="w-6 h-6 text-white fill-white" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <LazyImage src={p.imageUrl} className="aspect-square w-full" />
                )}
                {isCover && (
                  <div className="absolute top-1.5 left-1.5 bg-amber-400 text-amber-950 text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 shadow">
                    <Star className="w-3 h-3 fill-current" /> Bìa
                  </div>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-between p-2 gap-1">
                  <span {...dh} className={`${dh.className} bg-white/90 rounded p-1`}>
                    <GripVertical className="w-4 h-4" />
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setCover.mutate(p)}
                      disabled={isCover || setCover.isPending}
                      className={`rounded p-1 transition ${isCover ? "bg-amber-400 text-amber-950" : "bg-white/90 text-amber-600 hover:bg-amber-100"}`}
                      title={isCover ? "Đang là bìa album" : "Đặt làm bìa album"}
                    >
                      <Star className={`w-4 h-4 ${isCover ? "fill-current" : ""}`} />
                    </button>
                    {effectiveIsAdmin && (
                      <button
                        onClick={() => setConfirmCfg({ message: "Đưa ảnh vào thùng rác?", confirmText: "Xoá", danger: true, onConfirm: () => deletePhoto.mutate(p.id) })}
                        className="bg-destructive text-destructive-foreground rounded p-1 hover:scale-110 transition-transform"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          }}
        />
      )}

      {hasNextPage && (
        <div className="text-center pt-2">
          <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetching}>
            {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : "Tải thêm"}
          </Button>
        </div>
      )}
      <ConfirmDialog cfg={confirmCfg} onClose={() => setConfirmCfg(null)} />
    </div>
  );
}

function VideoUploaderButton({
  caps, onUploaded,
}: { caps: Capabilities | undefined; onUploaded: (vids: UploadedImage[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const supported = caps?.videoUpload === true;
  const maxMb = caps?.videoMaxSizeMb ?? 100;
  const allowed = caps?.videoAllowedMimes ?? ["video/mp4", "video/webm"];

  async function handleFiles(files: File[]) {
    if (!files.length) return;
    setErr(null); setUploading(true);
    const results: UploadedImage[] = [];
    try {
      for (const f of files) {
        if (!f.type.startsWith("video/")) {
          setErr(`${f.name}: không phải file video`); continue;
        }
        if (allowed.length && !allowed.includes(f.type)) {
          setErr(`${f.name}: định dạng ${f.type} chưa hỗ trợ`); continue;
        }
        if (f.size > maxMb * 1024 * 1024) {
          setErr(`${f.name}: vượt quá ${maxMb}MB`); continue;
        }
        const path = await uploadFileViaPresign(f, f.name, f.type);
        results.push({ objectPath: path, mimeType: f.type, name: f.name });
      }
      if (results.length) onUploaded(results);
    } catch (e) { setErr(String(e)); }
    finally { setUploading(false); }
  }

  if (caps === undefined) {
    return <div className="text-xs text-muted-foreground">Đang kiểm tra hỗ trợ video…</div>;
  }
  if (!supported) {
    return (
      <div>
        <Button variant="outline" disabled className="gap-1.5" title="Video sẽ hỗ trợ ở bản sau">
          <Video className="w-4 h-4" /> Upload video (chưa hỗ trợ)
        </Button>
        <p className="text-[11px] text-muted-foreground mt-1">App Storage chưa cấu hình cho video — sẽ hỗ trợ ở bản sau.</p>
      </div>
    );
  }
  return (
    <div>
      <Button
        variant="outline" className="gap-1.5"
        onClick={() => inputRef.current?.click()} disabled={uploading}
      >
        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
        {uploading ? "Đang upload…" : "Upload video"}
      </Button>
      <p className="text-[11px] text-muted-foreground mt-1">
        Hỗ trợ {allowed.join(", ")} · tối đa {maxMb}MB · không nén client.
      </p>
      <input
        ref={inputRef} type="file" accept={allowed.join(",")} multiple className="hidden"
        onChange={e => {
          handleFiles(Array.from(e.target.files ?? []));
          if (e.target) (e.target as HTMLInputElement).value = "";
        }}
      />
      {err && <p className="text-xs text-destructive mt-1">{err}</p>}
    </div>
  );
}

function usePhotosPagination(albumId: number) {
  const qc = useQueryClient();
  return useInfinitePhotos(albumId, qc);
}

function useInfinitePhotos(albumId: number, _qc: QueryClient) {
  return useInfiniteQuery({
    queryKey: ["cms-photos", albumId],
    queryFn: async ({ pageParam }) => {
      const url = new URL(`${CMS_BASE}/api/cms/albums/${albumId}/photos`, window.location.origin);
      url.searchParams.set("limit", "30");
      if (pageParam) url.searchParams.set("cursor", String(pageParam));
      const r = await fetch(url.toString().replace(window.location.origin, ""), { headers: authHeaders() });
      if (!r.ok) throw new Error("Lỗi tải ảnh");
      return r.json() as Promise<{ items: Photo[]; nextCursor: number | null }>;
    },
    initialPageParam: null as number | null,
    getNextPageParam: last => last.nextCursor,
  });
}
