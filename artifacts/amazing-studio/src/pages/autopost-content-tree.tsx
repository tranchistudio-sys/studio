/**
 * autopost-content-tree.tsx — Cây nguồn + danh mục cho "Kho nội dung" của AutoPost Facebook.
 *
 * 3 nguồn lớn, mỗi nguồn TÁI SỬ DỤNG cây danh mục CMS sẵn có (KHÔNG đổi DB):
 *   - Ảnh sản phẩm thật (gallery)  → /api/cms/categories?type=gallery, item nguồn = albums
 *   - Cho thuê đồ (dress)          → /api/cms/categories?type=dress,   item nguồn = dresses
 *   - Ý tưởng chụp ảnh (idea)      → /api/cms/categories?type=idea,    item nguồn = photo_ideas
 * Item kho (PoolItem) gắn vào danh mục theo categoryId của BẢN GHI GỐC (map qua sourceItemId),
 * KHÔNG dùng field category text. Item thủ công + Google Drive gom vào nhánh "Tải lên / Google Drive".
 */
import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Image as ImageIcon, Shirt, Lightbulb, UploadCloud } from "lucide-react";
import {
  type PoolItem, type CmsCategory, type CmsCatType,
  useCmsCategories, useSourceCategoryMaps,
} from "@/lib/autopost-api";

export type SourceKey = "gallery" | "dress" | "idea" | "other";
export type TreeSelection = { sourceKey: SourceKey; categoryId: number | null; uncategorized?: boolean };

export const SOURCES: { key: Exclude<SourceKey, "other">; type: CmsCatType; table: string; label: string }[] = [
  { key: "gallery", type: "gallery", table: "gallery_albums", label: "Ảnh sản phẩm thật" },
  { key: "dress", type: "dress", table: "dresses", label: "Cho thuê đồ" },
  { key: "idea", type: "idea", table: "photo_ideas", label: "Ý tưởng chụp ảnh" },
];
const OTHER_LABEL = "Tải lên / Google Drive";

type CatMaps = ReturnType<typeof useSourceCategoryMaps>;
type AllCats = { gallery: CmsCategory[]; dress: CmsCategory[]; idea: CmsCategory[] };

/** Nguồn của 1 item kho theo sourceTable (upload/google_drive → "other"). */
export function poolItemSourceKey(it: PoolItem): SourceKey {
  switch (it.sourceTable) {
    case "gallery_albums": return "gallery";
    case "dresses": return "dress";
    case "photo_ideas": return "idea";
    default: return "other";
  }
}

function catsForSource(sk: SourceKey, all: AllCats): CmsCategory[] {
  return sk === "gallery" ? all.gallery : sk === "dress" ? all.dress : sk === "idea" ? all.idea : [];
}

/** categoryId của item kho = categoryId bản ghi gốc (map qua sourceItemId). null nếu chưa phân loại. */
export function poolItemCategoryId(it: PoolItem, maps: CatMaps): number | null {
  const sk = poolItemSourceKey(it);
  if (sk === "other") return null;
  return maps[sk].get(String(it.sourceItemId ?? "")) ?? null;
}

function descendantIds(cats: CmsCategory[], rootId: number): number[] {
  const out: number[] = [];
  const walk = (pid: number) => { for (const c of cats) if (c.parentId === pid) { out.push(c.id); walk(c.id); } };
  walk(rootId);
  return out;
}

export function buildBreadcrumb(cats: CmsCategory[], id: number | null): string {
  if (id == null) return "";
  const byId = new Map(cats.map((c) => [c.id, c]));
  const names: string[] = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 30) { names.unshift(cur.name); cur = cur.parentId != null ? byId.get(cur.parentId) : undefined; }
  return names.join(" › ");
}

/** Lọc item kho theo lựa chọn cây (nguồn + danh mục + subtree). */
export function filterPoolBySelection(items: PoolItem[], sel: TreeSelection, maps: CatMaps, all: AllCats): PoolItem[] {
  if (sel.sourceKey === "other") return items.filter((it) => poolItemSourceKey(it) === "other");
  const src = items.filter((it) => poolItemSourceKey(it) === sel.sourceKey);
  if (sel.uncategorized) return src.filter((it) => poolItemCategoryId(it, maps) == null);
  if (sel.categoryId == null) return src;
  const ids = new Set<number>([sel.categoryId, ...descendantIds(catsForSource(sel.sourceKey, all), sel.categoryId)]);
  return src.filter((it) => { const c = poolItemCategoryId(it, maps); return c != null && ids.has(c); });
}

/** Nạp 3 cây danh mục + map categoryId của 3 nguồn. */
export function useContentTree() {
  const gallery = useCmsCategories("gallery");
  const dress = useCmsCategories("dress");
  const idea = useCmsCategories("idea");
  const maps = useSourceCategoryMaps();
  const cats: AllCats = { gallery: gallery.data ?? [], dress: dress.data ?? [], idea: idea.data ?? [] };
  return { cats, maps, isLoading: gallery.isLoading || dress.isLoading || idea.isLoading || maps.isLoading };
}

// ── Đếm số item theo danh mục (gồm subtree) cho 1 nguồn ───────────────────────
function useSourceCounts(items: PoolItem[], cats: CmsCategory[], maps: CatMaps, sk: SourceKey) {
  return useMemo(() => {
    const ofSource = items.filter((it) => poolItemSourceKey(it) === sk);
    const direct = new Map<number, number>();
    let uncategorized = 0;
    for (const it of ofSource) {
      const cid = poolItemCategoryId(it, maps);
      if (cid == null) uncategorized++;
      else direct.set(cid, (direct.get(cid) ?? 0) + 1);
    }
    const childrenOf = new Map<number, CmsCategory[]>();
    for (const c of cats) {
      const k = c.parentId ?? -1;
      if (!childrenOf.has(k)) childrenOf.set(k, []);
      childrenOf.get(k)!.push(c);
    }
    const sub = new Map<number, number>();
    const calc = (c: CmsCategory): number => {
      let n = direct.get(c.id) ?? 0;
      for (const ch of childrenOf.get(c.id) ?? []) n += calc(ch);
      sub.set(c.id, n);
      return n;
    };
    for (const c of cats) if (c.parentId == null) calc(c);
    return { sub, uncategorized, total: ofSource.length, roots: (childrenOf.get(-1) ?? []).slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)), childrenOf };
  }, [items, cats, maps, sk]);
}

const SOURCE_ICON: Record<string, typeof ImageIcon> = { gallery: ImageIcon, dress: Shirt, idea: Lightbulb };

function Count({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-auto shrink-0 text-[10px] tabular-nums text-neutral-400">{n}</span>;
}

// ── Component cây ─────────────────────────────────────────────────────────────
export function ContentTree({
  items, cats, maps, selection, onSelect,
}: {
  items: PoolItem[]; cats: AllCats; maps: CatMaps;
  selection: TreeSelection; onSelect: (s: TreeSelection) => void;
}) {
  // Mặc định mở nguồn đang chọn.
  const [openSources, setOpenSources] = useState<Set<string>>(() => new Set([selection.sourceKey]));
  const [openCats, setOpenCats] = useState<Set<number>>(() => new Set());
  const otherCount = items.filter((it) => poolItemSourceKey(it) === "other").length;

  return (
    <div className="text-sm select-none">
      {SOURCES.map((src) => (
        <SourceNode
          key={src.key}
          src={src}
          items={items}
          cats={catsForSource(src.key, cats)}
          maps={maps}
          selection={selection}
          onSelect={onSelect}
          open={openSources.has(src.key)}
          toggleOpen={() => setOpenSources((p) => { const n = new Set(p); n.has(src.key) ? n.delete(src.key) : n.add(src.key); return n; })}
          openCats={openCats}
          setOpenCats={setOpenCats}
        />
      ))}
      {/* Nhánh Tải lên / Google Drive (item không có danh mục CMS) */}
      <button
        type="button"
        onClick={() => onSelect({ sourceKey: "other", categoryId: null })}
        className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left ${selection.sourceKey === "other" ? "bg-primary/10 text-primary font-medium" : "hover:bg-neutral-100"}`}
      >
        <UploadCloud className="w-4 h-4 shrink-0" />
        <span className="truncate">{OTHER_LABEL}</span>
        <Count n={otherCount} />
      </button>
    </div>
  );
}

function SourceNode({
  src, items, cats, maps, selection, onSelect, open, toggleOpen, openCats, setOpenCats,
}: {
  src: { key: Exclude<SourceKey, "other">; type: CmsCatType; table: string; label: string };
  items: PoolItem[]; cats: CmsCategory[]; maps: CatMaps;
  selection: TreeSelection; onSelect: (s: TreeSelection) => void;
  open: boolean; toggleOpen: () => void;
  openCats: Set<number>; setOpenCats: (fn: (p: Set<number>) => Set<number>) => void;
}) {
  const counts = useSourceCounts(items, cats, maps, src.key);
  const Icon = SOURCE_ICON[src.key] ?? ImageIcon;
  const activeSource = selection.sourceKey === src.key;

  const toggleCat = (id: number) => setOpenCats((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const renderCat = (c: CmsCategory, depth: number) => {
    const children = (counts.childrenOf.get(c.id) ?? []).slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const hasChildren = children.length > 0;
    const expanded = openCats.has(c.id);
    const selected = activeSource && !selection.uncategorized && selection.categoryId === c.id;
    return (
      <div key={c.id}>
        <div
          className={`flex items-center gap-1 rounded-lg ${selected ? "bg-primary/10 text-primary font-medium" : "hover:bg-neutral-100"}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {hasChildren ? (
            <button type="button" onClick={() => toggleCat(c.id)} className="p-1 shrink-0 text-neutral-400 hover:text-neutral-700" aria-label="Mở/đóng">
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          ) : <span className="w-[22px] shrink-0" />}
          <button type="button" onClick={() => onSelect({ sourceKey: src.key, categoryId: c.id })} className="flex items-center gap-2 flex-1 py-1.5 pr-2 text-left min-w-0">
            <span className="truncate">{c.name}</span>
            <Count n={counts.sub.get(c.id) ?? 0} />
          </button>
        </div>
        {hasChildren && expanded && children.map((ch) => renderCat(ch, depth + 1))}
      </div>
    );
  };

  return (
    <div className="mb-0.5">
      <div className={`flex items-center gap-1 rounded-lg ${activeSource && selection.categoryId == null && !selection.uncategorized ? "bg-primary/10 text-primary font-semibold" : "hover:bg-neutral-100 font-medium"}`}>
        <button type="button" onClick={toggleOpen} className="p-1.5 shrink-0 text-neutral-500 hover:text-neutral-800" aria-label="Mở/đóng nguồn">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <button type="button" onClick={() => { if (!open) toggleOpen(); onSelect({ sourceKey: src.key, categoryId: null }); }} className="flex items-center gap-2 flex-1 py-2 pr-2 text-left min-w-0">
          <Icon className="w-4 h-4 shrink-0" />
          <span className="truncate">{src.label}</span>
          <Count n={counts.total} />
        </button>
      </div>
      {open && (
        <div className="mt-0.5">
          {counts.roots.length === 0 && <p className="pl-9 py-1.5 text-xs text-neutral-400">Chưa có danh mục</p>}
          {counts.roots.map((c) => renderCat(c, 1))}
          {counts.uncategorized > 0 && (
            <button
              type="button"
              onClick={() => onSelect({ sourceKey: src.key, categoryId: null, uncategorized: true })}
              className={`w-full flex items-center gap-2 py-1.5 pr-2 rounded-lg text-left ${activeSource && selection.uncategorized ? "bg-primary/10 text-primary font-medium" : "hover:bg-neutral-100 text-neutral-500"}`}
              style={{ paddingLeft: 8 + 1 * 14 + 22 }}
            >
              <span className="truncate italic">Chưa phân loại</span>
              <Count n={counts.uncategorized} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
