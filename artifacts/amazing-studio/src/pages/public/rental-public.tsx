import { useEffect, useMemo, useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { LazyImage, CMS_BASE } from "@/components/cms-shared";
import { formatVND, cn } from "@/lib/utils";
import { Sparkles, Shirt, X, Check } from "lucide-react";
import { OUTFIT_TAGS, OutfitTagBadge, type OutfitTagKey } from "@/lib/outfit-tags";
import { RENTAL_PAGE } from "@/lib/public-site-config";
import { PublicReveal, PublicRevealItem } from "@/components/public/PublicReveal";
import { playPublicSound } from "@/lib/feedback";
import { getGalleryDescendantIds } from "@/hooks/use-public-cms";
import { GoldenHourBadge, ghDiscounted } from "@/lib/golden-hour";

const OUTFIT_LABEL_TO_KEY_PUB: Array<[string, OutfitTagKey]> = [
  ["hang moi 100", "HANG_MOI_100"],
  ["gia sieu tiet kiem", "GIA_SIEU_TIET_KIEM"],
  ["gia tiet kiem", "GIA_TIET_KIEM"],
  ["vay nuoc 1", "VAY_NUOC_1"], ["vay nuoc 2", "VAY_NUOC_2"],
  ["vay nuoc 3", "VAY_NUOC_3"], ["vay nuoc 4", "VAY_NUOC_4"],
  ["form dep", "FORM_DEP"], ["hot pick", "HOT_PICK"],
  ["sieu moi", "SIEU_MOI"], ["hang moi", "HANG_MOI"],
];
function matchOutfitKeysFromQuery(q: string): Set<OutfitTagKey> {
  const n = q.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
  const out = new Set<OutfitTagKey>();
  for (const t of OUTFIT_TAGS) if (n.includes(t.key.toLowerCase())) out.add(t.key);
  for (const [label, key] of OUTFIT_LABEL_TO_KEY_PUB) if (n.includes(label)) out.add(key);
  return out;
}

interface PublicCategory {
  id: number;
  parentId: number | null;
  name: string;
  slug: string | null;
  coverImageUrl: string | null;
  fallbackCover?: string | null;
  sortOrder: number;
  productCount: number;
}
interface PublicDress {
  id: number;
  code: string;
  name: string;
  categoryId: number | null;
  color: string;
  size: string;
  rentalPrice: number;
  sellPrice?: number;
  salePrice?: number;
  isPriority?: boolean;
  coverImageUrl: string | null;
  slug: string | null;
  rentalStatus: string;
  outfitTag: string | null;
  sizeText: string | null;
  colorText: string | null;
  tagsText: string | null;
  goldenHourPercent?: number;
  goldenHourName?: string | null;
}

const PAGE_SIZE = 60;

type SortMode = "newest" | "oldest" | "price_asc" | "price_desc" | "name_asc";
const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "newest", label: "Mới nhất" },
  { value: "oldest", label: "Cũ nhất" },
  { value: "price_asc", label: "Giá thấp nhất" },
  { value: "price_desc", label: "Giá cao nhất" },
  { value: "name_asc", label: "Tên A-Z" },
];

function parseCSV(v: string | null | undefined): string[] {
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
function isWeightToken(s: string): boolean {
  return /kg\s*$/i.test(s);
}
function weightSortKey(s: string): number {
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function countDressesInBranch(
  dresses: PublicDress[],
  cats: PublicCategory[],
  rootId: number,
): number {
  const ids = getGalleryDescendantIds(
    cats.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      slug: c.slug,
      coverImageUrl: c.coverImageUrl,
      sortOrder: c.sortOrder,
      productCount: c.productCount,
    })),
    rootId,
  );
  return dresses.filter((d) => d.categoryId != null && ids.has(d.categoryId)).length;
}

// Thứ tự ưu tiên danh mục gốc (chỉ sort ở frontend, KHÔNG đổi DB):
// 1) Cưới  2) Áo dài / Việt phục  3) Beauty  4) Khác. Số nhỏ = lên trước.
function tier1Priority(name: string): number {
  const n = (name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
  if (n.includes("cuoi") || n.includes("wedding")) return 0;
  if (n.includes("ao dai") || n.includes("viet phuc")) return 1;
  if (n.includes("beauty")) return 2;
  return 3;
}

export default function PublicRentalPage() {
  const [location, setLocation] = useLocation();
  const [tier1Id, setTier1Id] = useState<number | null>(null);
  const [tier2Id, setTier2Id] = useState<number | null>(null);
  const [tier3Id, setTier3Id] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set());
  const [selectedWeights, setSelectedWeights] = useState<Set<string>>(new Set());
  const [selectedColors, setSelectedColors] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selectedOutfitTags, setSelectedOutfitTags] = useState<Set<OutfitTagKey>>(new Set());
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [smartFilterOpen, setSmartFilterOpen] = useState(false);
  const smartFilterRef = useRef<HTMLDivElement>(null);

  const { data: cats = [], isLoading: catsLoading } = useQuery<PublicCategory[]>({
    queryKey: ["public-categories-dress-tree"],
    queryFn: () =>
      fetch(`${CMS_BASE}/api/cms/public/categories/dress/tree`).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const { data: dresses = [], isLoading: dressesLoading } = useQuery<PublicDress[]>({
    queryKey: ["public-dresses"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/public/dresses`).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const catById = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const childrenOf = useMemo(() => {
    const m = new Map<number | null, PublicCategory[]>();
    for (const c of cats) {
      const k = c.parentId ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(c);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return m;
  }, [cats]);

  const tier1Raw = childrenOf.get(null) ?? [];
  // Ưu tiên hiển thị: Cưới → Áo dài/Việt phục → Beauty → khác. Trong cùng nhóm giữ thứ tự DB.
  const tier1 = useMemo(
    () =>
      [...tier1Raw].sort((a, b) => {
        const pa = tier1Priority(a.name);
        const pb = tier1Priority(b.name);
        return pa !== pb ? pa - pb : a.sortOrder - b.sortOrder;
      }),
    [tier1Raw],
  );
  const tier2 = tier1Id != null ? (childrenOf.get(tier1Id) ?? []) : [];
  const tier3 = tier2Id != null ? (childrenOf.get(tier2Id) ?? []) : [];

  const didDeepLink = useRef(false);
  useEffect(() => {
    if (didDeepLink.current || cats.length === 0) return;
    const sp = new URLSearchParams(window.location.search);
    const cid = sp.get("categoryId");
    if (cid) {
      const id = parseInt(cid, 10);
      const node = catById.get(id);
      if (node) {
        const path: PublicCategory[] = [];
        let cur: PublicCategory | undefined = node;
        while (cur) {
          path.unshift(cur);
          cur = cur.parentId == null ? undefined : catById.get(cur.parentId);
        }
        if (path[0]) setTier1Id(path[0].id);
        if (path[1]) setTier2Id(path[1].id);
        if (path[2]) setTier3Id(path[2].id);
      }
    }
    const sortParam = sp.get("sort");
    if (sortParam && SORT_OPTIONS.some((o) => o.value === sortParam)) {
      setSortMode(sortParam as SortMode);
    }
    const q = sp.get("q");
    if (q) setQuery(q);
    didDeepLink.current = true;
  }, [cats, catById]);

  useEffect(() => {
    if (tier1Id == null && tier1.length > 0 && didDeepLink.current) {
      setTier1Id(tier1[0].id);
    }
  }, [tier1, tier1Id]);

  useEffect(() => {
    const selected = tier3Id ?? tier2Id ?? tier1Id;
    if (selected == null) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("categoryId") === String(selected)) return;
    sp.set("categoryId", String(selected));
    setLocation(`${location.split("?")[0]}?${sp.toString()}`, { replace: true });
  }, [tier1Id, tier2Id, tier3Id, location, setLocation]);

  function resetFilters() {
    setSelectedSizes(new Set());
    setSelectedWeights(new Set());
    setSelectedColors(new Set());
    setSelectedTags(new Set());
    setSelectedOutfitTags(new Set());
    setQuery("");
  }
  function pickTier1(id: number) {
    setTier1Id(id);
    setTier2Id(null);
    setTier3Id(null);
    setVisibleCount(PAGE_SIZE);
    resetFilters();
    playPublicSound("public_category_selected");
  }
  function pickTier2(id: number | null) {
    setTier2Id(id);
    setTier3Id(null);
    setVisibleCount(PAGE_SIZE);
    resetFilters();
    if (id != null) playPublicSound("public_category_selected");
  }
  function pickTier3(id: number | null) {
    setTier3Id(id);
    setVisibleCount(PAGE_SIZE);
    resetFilters();
    if (id != null) playPublicSound("public_category_selected");
  }

  const selectedNodeId = tier3Id ?? tier2Id ?? tier1Id;

  const descendantIds = useMemo(() => {
    if (selectedNodeId == null) return new Set<number>();
    return getGalleryDescendantIds(
      cats.map((c) => ({
        id: c.id,
        parentId: c.parentId,
        name: c.name,
        slug: c.slug,
        coverImageUrl: c.coverImageUrl,
        sortOrder: c.sortOrder,
        productCount: c.productCount,
      })),
      selectedNodeId,
    );
  }, [selectedNodeId, cats]);

  const categoryFilteredDresses = useMemo(() => {
    if (selectedNodeId == null) return dresses;
    return dresses.filter(
      (d) => d.categoryId != null && descendantIds.has(d.categoryId),
    );
  }, [dresses, descendantIds, selectedNodeId]);

  const { sizeOptions, weightOptions } = useMemo(() => {
    const allTokens = new Set<string>();
    for (const d of categoryFilteredDresses) {
      parseCSV(d.sizeText || d.size).forEach((v) => allTokens.add(v));
    }
    const sizes: string[] = [];
    const weights: string[] = [];
    for (const t of allTokens) (isWeightToken(t) ? weights : sizes).push(t);
    sizes.sort();
    weights.sort((a, b) => weightSortKey(a) - weightSortKey(b));
    return { sizeOptions: sizes, weightOptions: weights };
  }, [categoryFilteredDresses]);

  const colorOptions = useMemo(() => {
    const s = new Set<string>();
    for (const d of categoryFilteredDresses) {
      parseCSV(d.colorText || d.color).forEach((v) => s.add(v));
    }
    return [...s].sort();
  }, [categoryFilteredDresses]);

  const tagOptions = useMemo(() => {
    const s = new Set<string>();
    for (const d of categoryFilteredDresses) {
      parseCSV(d.tagsText).forEach((v) => s.add(v));
    }
    return [...s].sort();
  }, [categoryFilteredDresses]);

  const filteredDresses = useMemo(() => {
    let list = categoryFilteredDresses;

    const q = query.trim();
    if (q) {
      const tokens = stripDiacritics(q).split(/\s+/).filter(Boolean);
      const tagKeysFromSearch = matchOutfitKeysFromQuery(q);
      list = list.filter((d) => {
        const hay = stripDiacritics(
          [
            d.name,
            d.code,
            d.tagsText ?? "",
            d.colorText || d.color || "",
            d.sizeText || d.size || "",
          ].join(" "),
        );
        if (tokens.every((t) => hay.includes(t))) return true;
        return d.outfitTag !== null && tagKeysFromSearch.has(d.outfitTag as OutfitTagKey);
      });
    }

    if (selectedSizes.size > 0) {
      list = list.filter((d) => {
        const v = (d.sizeText || d.size || "").toLowerCase();
        return [...selectedSizes].some((s) => v.includes(s.toLowerCase()));
      });
    }
    if (selectedWeights.size > 0) {
      list = list.filter((d) => {
        const v = (d.sizeText || d.size || "").toLowerCase();
        return [...selectedWeights].some((s) => v.includes(s.toLowerCase()));
      });
    }
    if (selectedColors.size > 0) {
      list = list.filter((d) => {
        const v = (d.colorText || d.color || "").toLowerCase();
        return [...selectedColors].some((s) => v.includes(s.toLowerCase()));
      });
    }
    if (selectedTags.size > 0) {
      list = list.filter((d) => {
        const v = (d.tagsText || "").toLowerCase();
        return [...selectedTags].some((s) => v.includes(s.toLowerCase()));
      });
    }
    if (selectedOutfitTags.size > 0) {
      list = list.filter(
        (d) => d.outfitTag !== null && selectedOutfitTags.has(d.outfitTag as OutfitTagKey),
      );
    }
    return list;
  }, [
    categoryFilteredDresses,
    query,
    selectedSizes,
    selectedWeights,
    selectedColors,
    selectedTags,
    selectedOutfitTags,
  ]);

  const sortedDresses = useMemo(() => {
    const arr = filteredDresses.slice();
    switch (sortMode) {
      case "oldest":
        arr.sort((a, b) => a.id - b.id);
        break;
      case "price_asc":
        arr.sort((a, b) => {
          const ap = a.rentalPrice > 0 ? a.rentalPrice : Number.POSITIVE_INFINITY;
          const bp = b.rentalPrice > 0 ? b.rentalPrice : Number.POSITIVE_INFINITY;
          return ap - bp;
        });
        break;
      case "price_desc":
        arr.sort((a, b) => {
          const ap = a.rentalPrice > 0 ? a.rentalPrice : Number.NEGATIVE_INFINITY;
          const bp = b.rentalPrice > 0 ? b.rentalPrice : Number.NEGATIVE_INFINITY;
          return bp - ap;
        });
        break;
      case "name_asc":
        arr.sort((a, b) => a.name.localeCompare(b.name, "vi"));
        break;
      case "newest":
      default:
        // API đã sắp đúng công thức: ưu tiên trước (priority_at mới nhất), rồi mới nhất.
        // Chỉ cần đảm bảo nhóm ưu tiên nổi lên đầu, giữ nguyên thứ tự API trong từng nhóm.
        arr.sort((a, b) => Number(b.isPriority ?? false) - Number(a.isPriority ?? false));
        break;
    }
    return arr;
  }, [filteredDresses, sortMode]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sentinelRef.current) return;
    if (sortedDresses.length <= visibleCount) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((c) => Math.min(c + PAGE_SIZE, sortedDresses.length));
        }
      },
      { rootMargin: "300px" },
    );
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [sortedDresses.length, visibleCount]);

  const shownDresses = sortedDresses.slice(0, visibleCount);
  const loading = catsLoading || dressesLoading;
  const hasChipFilter =
    selectedSizes.size > 0 ||
    selectedWeights.size > 0 ||
    selectedColors.size > 0 ||
    selectedTags.size > 0 ||
    selectedOutfitTags.size > 0 ||
    query.trim().length > 0 ||
    sortMode !== "newest";

  const advancedFilterCount =
    selectedSizes.size +
    selectedWeights.size +
    selectedColors.size +
    selectedTags.size +
    selectedOutfitTags.size;

  function clearAll() {
    setSelectedSizes(new Set());
    setSelectedWeights(new Set());
    setSelectedColors(new Set());
    setSelectedTags(new Set());
    setSelectedOutfitTags(new Set());
    setQuery("");
    setSortMode("newest");
  }

  function toggleSmartFilter() {
    setSmartFilterOpen((open) => {
      if (!open) playPublicSound("public_smart_search_opened");
      return !open;
    });
  }

  const breadcrumbLabel = useMemo(() => {
    if (selectedNodeId == null) return "Catalog";
    const parts: string[] = [];
    let cur = catById.get(selectedNodeId);
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parentId == null ? undefined : catById.get(cur.parentId);
    }
    return parts.join(" · ");
  }, [selectedNodeId, catById]);

  const tier1Tabs = useMemo(
    () =>
      tier1.map((t1) => ({
        id: t1.id,
        name: t1.name,
        count: countDressesInBranch(dresses, cats, t1.id),
        cover: t1.coverImageUrl ?? t1.fallbackCover ?? null,
      })),
    [tier1, dresses, cats],
  );

  // Lọc tức thì: bấm tag là áp dụng ngay, bấm lại để bỏ chọn; reset phân trang mỗi lần đổi.
  function instantToggle<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) {
    setter((prev) => toggleSet(prev, value));
    setVisibleCount(PAGE_SIZE);
  }

  const advancedFilterPanel = (
    <AdvancedFiltersBody
      sizeOptions={sizeOptions}
      weightOptions={weightOptions}
      colorOptions={colorOptions}
      tagOptions={tagOptions}
      selectedSizes={selectedSizes}
      selectedWeights={selectedWeights}
      selectedColors={selectedColors}
      selectedTags={selectedTags}
      selectedOutfitTags={selectedOutfitTags}
      onToggleSize={(s) => instantToggle(setSelectedSizes, s)}
      onToggleWeight={(s) => instantToggle(setSelectedWeights, s)}
      onToggleColor={(s) => instantToggle(setSelectedColors, s)}
      onToggleTag={(s) => instantToggle(setSelectedTags, s)}
      onToggleOutfitTag={(k) => instantToggle(setSelectedOutfitTags, k)}
    />
  );

  return (
    <div className="pb-16 sm:pb-28">
      <RentalHero />

      <div className="max-w-7xl mx-auto px-3 sm:px-8 pt-5 sm:pt-14 pb-4 sm:pb-6">
        {loading ? (
          <>
            <div className="flex gap-2 sm:gap-3 overflow-hidden mb-6 sm:mb-10">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="gallery-skeleton h-24 w-52 rounded-xl flex-shrink-0" />
              ))}
            </div>
            <RentalGridSkeleton />
          </>
        ) : tier1.length === 0 ? (
          <div className="text-center py-20 text-neutral-500">
            <Shirt className="w-10 h-10 mx-auto mb-4 text-neutral-300" />
            <p>Catalog đang được cập nhật...</p>
          </div>
        ) : (
          <>
            <PublicReveal className="mb-4 sm:mb-10">
              <div
                className="flex gap-3 sm:gap-4 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                {tier1Tabs.map((tab) => {
                  const active = tier1Id === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => pickTier1(tab.id)}
                      className={cn(
                        "gallery-tab snap-start flex items-center gap-2 sm:gap-3 min-w-[132px] sm:min-w-[220px] max-w-[200px] sm:max-w-[260px] px-2.5 py-2 sm:px-4 sm:py-3 text-left",
                        active && "is-active",
                      )}
                    >
                      <div
                        className={cn(
                          "w-9 h-9 sm:w-14 sm:h-14 flex-shrink-0 rounded-lg overflow-hidden border",
                          active ? "border-white/30" : "border-neutral-200/80 bg-neutral-100",
                        )}
                      >
                        {tab.cover ? (
                          <LazyImage src={tab.cover} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Shirt
                              className={cn(
                                "w-5 h-5",
                                active ? "text-white/70" : "text-neutral-400",
                              )}
                            />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn(
                            "text-xs sm:text-sm font-medium leading-snug line-clamp-2",
                            active ? "text-white" : "text-neutral-800",
                          )}
                        >
                          {tab.name}
                        </div>
                        <div
                          className={cn(
                            "text-[11px] mt-0.5",
                            active ? "text-white/80" : "text-neutral-500",
                          )}
                        >
                          {tab.count} mẫu
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </PublicReveal>

            <div ref={smartFilterRef} className="mb-4 sm:mb-8">
              <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 items-stretch sm:items-center">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Tìm theo tên, mã, tag, màu, size…"
                  className="rental-search-input flex-1 h-9 sm:h-10 px-3 sm:px-4 text-sm text-neutral-900 placeholder:text-neutral-400"
                />
                <div className="flex gap-2 flex-shrink-0">
                  <label className="flex items-center gap-2 text-xs text-neutral-500 flex-1 sm:flex-initial">
                    <span className="tracking-[0.2em] uppercase text-[10px] hidden sm:inline">
                      Sắp xếp
                    </span>
                    <select
                      value={sortMode}
                      onChange={(e) => setSortMode(e.target.value as SortMode)}
                      className="rental-search-input h-9 sm:h-10 px-2.5 sm:px-3 text-sm text-neutral-900 flex-1 sm:min-w-[140px]"
                    >
                      {SORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={toggleSmartFilter}
                    className={cn(
                      "rental-smart-filter-btn inline-flex items-center justify-center gap-1.5 sm:gap-2 h-9 sm:h-10 px-3 sm:px-4 text-[11px] sm:text-sm whitespace-nowrap",
                      (smartFilterOpen || advancedFilterCount > 0) && "is-active",
                    )}
                  >
                    <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="sm:hidden">Lọc</span>
                    <span className="hidden sm:inline">Tìm kiếm thông minh</span>
                    {advancedFilterCount > 0 && (
                      <span className="min-w-[1.25rem] h-5 px-1.5 rounded-full bg-white/25 text-[10px] font-semibold flex items-center justify-center">
                        {advancedFilterCount}
                      </span>
                    )}
                  </button>
                </div>
              </div>

              {tier2.length > 0 && (
                <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2 mt-3 sm:mt-4">
                  <SubCategoryChip
                    active={tier2Id == null}
                    onClick={() => pickTier2(null)}
                    label="Tất cả"
                  />
                  {tier2.map((t2) => (
                    <SubCategoryChip
                      key={t2.id}
                      active={tier2Id === t2.id}
                      onClick={() => pickTier2(t2.id)}
                      label={t2.name}
                    />
                  ))}
                </div>
              )}

              {tier3.length > 0 && (
                <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2 mt-2 sm:mt-3">
                  <SubCategoryChip
                    active={tier3Id == null}
                    onClick={() => pickTier3(null)}
                    label="Tất cả"
                  />
                  {tier3.map((t3) => (
                    <SubCategoryChip
                      key={t3.id}
                      active={tier3Id === t3.id}
                      onClick={() => pickTier3(t3.id)}
                      label={t3.name}
                    />
                  ))}
                </div>
              )}

              {smartFilterOpen && (
                <div
                  className="rental-smart-filter-panel mt-3 sm:mt-4 rounded-xl border border-neutral-200/80 bg-white shadow-sm overflow-hidden"
                  role="region"
                  aria-label="Tìm kiếm thông minh"
                >
                  <div className="rental-smart-filter-head flex items-center justify-between px-2 py-1.5 sm:px-2.5 sm:py-2 border-b border-neutral-100 bg-[var(--public-cream,#faf8f5)]">
                    <p className="rental-smart-filter-title font-serif font-light text-neutral-900">
                      Tìm kiếm thông minh
                    </p>
                    <button
                      type="button"
                      onClick={() => setSmartFilterOpen(false)}
                      className="p-1 rounded-full hover:bg-neutral-200/60 text-neutral-500"
                      aria-label="Thu gọn bộ lọc"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  {advancedFilterPanel}
                </div>
              )}
            </div>

            <p className="text-center text-[10px] sm:text-xs tracking-[0.15em] sm:tracking-[0.2em] uppercase text-neutral-500 mb-3 sm:mb-6">
              {breadcrumbLabel}
              <span className="text-neutral-400 mx-2">—</span>
              <span className="text-neutral-700">{sortedDresses.length} mẫu</span>
            </p>

            {sortedDresses.length === 0 ? (
              <div className="text-center py-14 sm:py-20 rounded-2xl bg-white/60 border border-neutral-200/60">
                <Shirt className="w-10 h-10 mx-auto text-neutral-300 mb-4" />
                <p className="font-serif text-xl text-neutral-800 mb-2">
                  {hasChipFilter ? "Không có mẫu phù hợp" : "Chưa có sản phẩm trong mục này"}
                </p>
                <p className="text-sm text-neutral-500">
                  {hasChipFilter
                    ? "Thử xoá bộ lọc hoặc chọn danh mục khác."
                    : "Catalog mục này đang được cập nhật."}
                </p>
                {hasChipFilter && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="mt-4 text-xs tracking-widest uppercase text-[var(--public-nude,#c4a882)] hover:underline"
                  >
                    Xoá bộ lọc
                  </button>
                )}
              </div>
            ) : (
              <PublicReveal stagger>
                <div className="rental-product-grid grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-6 lg:gap-8">
                  {shownDresses.map((d) => (
                    <PublicRevealItem key={d.id}>
                      <RentalDressCard
                        dress={d}
                        onNavigate={() => {
                          if (d.slug) { playPublicSound("public_product_card_opened"); setLocation(`/san-pham/${d.slug}`); }
                        }}
                      />
                    </PublicRevealItem>
                  ))}
                </div>
                {visibleCount < sortedDresses.length && (
                  <div
                    ref={sentinelRef}
                    className="text-center py-10 text-xs tracking-widest uppercase text-neutral-400"
                  >
                    Đang tải thêm...
                  </div>
                )}
              </PublicReveal>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function toggleSet<T>(prev: Set<T>, value: T): Set<T> {
  const n = new Set(prev);
  if (n.has(value)) n.delete(value);
  else n.add(value);
  return n;
}

function RentalHero() {
  return (
    <section className="gallery-hero px-3 sm:px-8 pt-8 sm:pt-20 pb-8 sm:pb-24">
      <div className="gallery-hero-watermark" aria-hidden>
        {RENTAL_PAGE.watermark}
      </div>
      <div className="relative z-10 max-w-4xl mx-auto text-center hero-content hero-ready">
        <p className="text-[10px] sm:text-[11px] tracking-[0.35em] text-neutral-500 uppercase mb-3 sm:mb-5">
          {RENTAL_PAGE.eyebrow}
        </p>
        <h1 className="font-serif text-3xl sm:text-5xl lg:text-[3.25rem] font-light text-neutral-900 leading-tight mb-2 sm:mb-4">
          {RENTAL_PAGE.title}
        </h1>
        <p className="text-neutral-600 text-sm sm:text-base max-w-lg mx-auto leading-relaxed">
          {RENTAL_PAGE.description}
        </p>
      </div>
    </section>
  );
}

function AdvancedFiltersBody({
  sizeOptions,
  weightOptions,
  colorOptions,
  tagOptions,
  selectedSizes,
  selectedWeights,
  selectedColors,
  selectedTags,
  selectedOutfitTags,
  onToggleSize,
  onToggleWeight,
  onToggleColor,
  onToggleTag,
  onToggleOutfitTag,
}: {
  sizeOptions: string[];
  weightOptions: string[];
  colorOptions: string[];
  tagOptions: string[];
  selectedSizes: Set<string>;
  selectedWeights: Set<string>;
  selectedColors: Set<string>;
  selectedTags: Set<string>;
  selectedOutfitTags: Set<OutfitTagKey>;
  onToggleSize: (s: string) => void;
  onToggleWeight: (s: string) => void;
  onToggleColor: (s: string) => void;
  onToggleTag: (s: string) => void;
  onToggleOutfitTag: (k: OutfitTagKey) => void;
}) {
  const hasAnyOption =
    sizeOptions.length > 0 ||
    weightOptions.length > 0 ||
    colorOptions.length > 0 ||
    tagOptions.length > 0;

  return (
    <div className="flex flex-col rental-smart-filter-body">
      <div className="rental-smart-filter-scroll overflow-y-auto px-2 py-1.5 sm:px-2.5 sm:py-2 space-y-1">
        {!hasAnyOption ? (
          <p className="text-xs text-neutral-500 text-center py-3">
            Chưa có tuỳ chọn lọc cho danh mục này.
          </p>
        ) : (
          <>
            <FilterGroup
              label="Size"
              options={sizeOptions}
              selected={selectedSizes}
              onToggle={onToggleSize}
            />
            <FilterGroup
              label="Số đo"
              options={weightOptions}
              selected={selectedWeights}
              onToggle={onToggleWeight}
            />
            <FilterGroup
              label="Màu"
              options={colorOptions}
              selected={selectedColors}
              onToggle={onToggleColor}
            />
            <FilterGroup
              label="Kiểu"
              options={tagOptions}
              selected={selectedTags}
              onToggle={onToggleTag}
            />
          </>
        )}
        <div className="rental-smart-filter-group">
          <p className="rental-smart-filter-label">Nhãn</p>
          <div className="rental-smart-filter-row rental-smart-filter-tags rental-smart-filter-tags--scroll">
            {OUTFIT_TAGS.map((t) => {
              const active = selectedOutfitTags.has(t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => onToggleOutfitTag(t.key)}
                  className={cn(
                    "rounded-full transition-all shrink-0",
                    active
                      ? "ring-1 ring-[var(--public-nude,#c4a882)] ring-offset-1"
                      : "opacity-75 hover:opacity-100",
                  )}
                  title={t.label}
                >
                  <OutfitTagBadge tag={t.key} size="xxs" />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="rental-smart-filter-group">
      <p className="rental-smart-filter-label">{label}</p>
      <div className="rental-smart-filter-row">
        {options.map((s) => (
          <FilterPill key={s} label={s} active={selected.has(s)} onClick={() => onToggle(s)} />
        ))}
      </div>
    </div>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rental-filter-pill rental-filter-pill--compact inline-flex items-center gap-0.5",
        active && "is-active",
      )}
    >
      {active && <Check className="w-2.5 h-2.5 hidden sm:inline-block" aria-hidden />}
      {label}
    </button>
  );
}

function SubCategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-1 sm:px-4 sm:py-1.5 rounded-full text-[10px] sm:text-xs tracking-wide sm:tracking-widest uppercase border transition-all duration-300",
        active
          ? "bg-[var(--public-nude,#c4a882)] border-transparent text-white shadow-md"
          : "bg-white border-neutral-200 text-neutral-600 hover:border-[var(--public-nude,#c4a882)] hover:text-neutral-900",
      )}
    >
      {label}
    </button>
  );
}

function RentalDressCard({
  dress: d,
  onNavigate,
}: {
  dress: PublicDress;
  onNavigate: () => void;
}) {
  const isAvailable = d.rentalStatus === "san_sang";
  const sizeTags = parseCSV(d.sizeText || d.size).slice(0, 2);
  const colorTags = parseCSV(d.colorText || d.color).slice(0, 1);

  return (
    <article
      role={d.slug ? "link" : undefined}
      tabIndex={d.slug ? 0 : undefined}
      onClick={d.slug ? onNavigate : undefined}
      onMouseEnter={() => playPublicSound("public_image_hover_soft", { cooldownMs: 1500 })}
      onKeyDown={(e) => {
        if (!d.slug) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onNavigate();
        }
      }}
      className={cn(
        "gallery-card concept-card rental-dress-card group",
        d.slug && "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--public-nude,#c4a882)]",
      )}
    >
      <div className="relative aspect-[4/5] sm:aspect-[3/4] bg-neutral-100 overflow-hidden">
        {d.coverImageUrl ? (
          <>
            <LazyImage
              src={d.coverImageUrl}
              alt={d.name}
              className="concept-card-image absolute inset-0 w-full h-full object-cover"
            />
            <div
              className="concept-card-overlay absolute inset-0 bg-gradient-to-t from-black/70 via-black/15 to-transparent pointer-events-none"
              aria-hidden
            />
            <div className="concept-card-title-hover absolute bottom-0 left-0 right-0 p-5 pointer-events-none">
              <p className="font-serif text-xl text-white leading-snug line-clamp-2">{d.name}</p>
              {d.rentalPrice > 0 && (
                (d.salePrice ?? 0) > 0 && (d.salePrice ?? 0) < d.rentalPrice ? (
                  <p className="text-xs mt-1.5 tracking-wide">
                    <span className="text-white/60 line-through">{formatVND(d.rentalPrice)}</span>{" "}
                    <span className="text-amber-300 font-semibold">{formatVND(d.salePrice!)}</span>
                  </p>
                ) : (d.goldenHourPercent ?? 0) > 0 ? (
                  <p className="text-xs mt-1.5 tracking-wide">
                    <span className="text-white/60 line-through">{formatVND(d.rentalPrice)}</span>{" "}
                    <span className="text-amber-300 font-semibold">{formatVND(ghDiscounted(d.rentalPrice, d.goldenHourPercent))}</span>
                  </p>
                ) : (
                  <p className="text-white/80 text-xs mt-1.5 tracking-wide">
                    Giá thuê: {formatVND(d.rentalPrice)}
                  </p>
                )
              )}
            </div>
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-4">
            <Shirt className="w-8 h-8 text-neutral-300" />
            <span className="text-[10px] tracking-widest uppercase text-neutral-400 text-center">
              {d.code}
            </span>
          </div>
        )}
        {!isAvailable && (
          <div className="absolute inset-0 bg-black/30 flex items-end p-3 z-10 pointer-events-none">
            <span className="text-[10px] bg-black/55 text-white px-2.5 py-1 rounded-full backdrop-blur-sm">
              Tạm hết
            </span>
          </div>
        )}
        {(d.outfitTag || ((d.goldenHourPercent ?? 0) > 0 && !((d.salePrice ?? 0) > 0 && (d.salePrice ?? 0) < d.rentalPrice))) && (
          <div className="absolute top-1.5 left-1.5 sm:top-3 sm:left-3 z-10 scale-90 sm:scale-100 origin-top-left flex flex-col items-start gap-1">
            {d.outfitTag && <OutfitTagBadge tag={d.outfitTag} size="sm" />}
            {(d.goldenHourPercent ?? 0) > 0 && !((d.salePrice ?? 0) > 0 && (d.salePrice ?? 0) < d.rentalPrice) && (
              <GoldenHourBadge percent={d.goldenHourPercent} />
            )}
          </div>
        )}
      </div>

      <div className="px-2 py-2 sm:px-4 sm:py-3 border-t border-neutral-100/80 bg-white">
        <p className="font-serif text-xs sm:text-lg text-neutral-900 leading-snug line-clamp-2">{d.name}</p>
        <p className="text-[9px] sm:text-[11px] text-neutral-500 font-mono mt-0.5 truncate">{d.code}</p>
        {d.rentalPrice > 0 && (
          (d.salePrice ?? 0) > 0 && (d.salePrice ?? 0) < d.rentalPrice ? (
            <p className="text-[11px] sm:text-sm mt-1 sm:mt-2 leading-tight">
              <span className="text-neutral-400 text-[10px] sm:text-xs line-through">{formatVND(d.rentalPrice)}</span>{" "}
              <span className="font-semibold text-rose-600">{formatVND(d.salePrice!)}</span>
            </p>
          ) : (d.goldenHourPercent ?? 0) > 0 ? (
            <p className="text-[11px] sm:text-sm mt-1 sm:mt-2 leading-tight">
              <span className="text-neutral-400 text-[10px] sm:text-xs line-through">{formatVND(d.rentalPrice)}</span>{" "}
              <span className="font-semibold text-amber-600">{formatVND(ghDiscounted(d.rentalPrice, d.goldenHourPercent))}</span>
            </p>
          ) : (
            <p className="text-[11px] sm:text-sm text-neutral-800 mt-1 sm:mt-2 leading-tight">
              <span className="text-neutral-500 text-[10px] sm:text-xs">Giá thuê </span>
              <span className="font-semibold sm:font-medium">{formatVND(d.rentalPrice)}</span>
            </p>
          )
        )}
        {(sizeTags.length > 0 || colorTags.length > 0) && (
          <div className="flex flex-wrap gap-1 sm:gap-1.5 mt-1 sm:mt-2">
            {sizeTags.map((t) => (
              <span
                key={`s-${t}`}
                className="text-[8px] sm:text-[10px] px-1.5 sm:px-2 py-px sm:py-0.5 rounded-full bg-[var(--public-cream-deep,#f3efe8)] text-neutral-600"
              >
                {t}
              </span>
            ))}
            {colorTags.map((t) => (
              <span
                key={`c-${t}`}
                className="text-[8px] sm:text-[10px] px-1.5 sm:px-2 py-px sm:py-0.5 rounded-full bg-[var(--public-cream-deep,#f3efe8)] text-neutral-600"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function RentalGridSkeleton() {
  return (
    <div className="rental-product-grid grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-6 lg:gap-8">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-[0.625rem] overflow-hidden bg-white shadow-sm">
          <div className="gallery-skeleton aspect-[4/5] sm:aspect-[3/4] w-full" />
          <div className="p-2 sm:p-4 space-y-1.5 sm:space-y-2">
            <div className="gallery-skeleton h-3 sm:h-4 w-3/4 rounded" />
            <div className="gallery-skeleton h-2.5 sm:h-3 w-1/2 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
