import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X, ChevronDown, Sparkles, ListFilter, Package2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { searchServiceOptions } from "@/lib/service-package-search";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const fetchJson = (url: string) => fetch(`${BASE}${url}`).then(r => r.json());

const RECENT_KEY = "svc_recent_keys";
const MAX_RECENT = 5;

function saveRecent(key: string) {
  try {
    const arr: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    const next = [key, ...arr.filter(k => k !== key)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}
function getRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}

export type ServiceOption = {
  key: string;          // "pkg-{id}" or "svc-{id}"
  id: number;
  name: string;
  groupName: string;
  price: number;
  serviceType?: string | null;
  includesMakeup?: boolean;
  photoCount?: number | null;
  includedRetouchedPhotos?: number | null;
  printCost?: number;
  operatingCost?: number;
  salePercent?: number;
  addons?: { key: string; name: string; price: number }[];
  items?: { name: string; quantity: number; unit: string; notes?: string }[];
  products?: string[];
  description?: string | null;
  notes?: string | null;
};

const TYPE_LABEL: Record<string, { icon: string; label: string; color: string }> = {
  tiec:             { icon: "🎊", label: "Tiệc cưới",          color: "bg-rose-100 text-rose-700"    },
  tiec_le:          { icon: "🎊", label: "Tiệc + Lễ",          color: "bg-rose-100 text-rose-700"    },
  phong_su:         { icon: "📸", label: "Phóng sự",            color: "bg-blue-100 text-blue-700"    },
  phong_su_luxury:  { icon: "📸", label: "Phóng sự Luxury",     color: "bg-indigo-100 text-indigo-700"},
  combo_co_makeup:  { icon: "💄", label: "Combo + Makeup",      color: "bg-pink-100 text-pink-700"    },
  combo_khong_makeup:{ icon:"👗", label: "Combo (no makeup)",   color: "bg-purple-100 text-purple-700"},
  quay_phim:        { icon: "🎬", label: "Quay phim",           color: "bg-amber-100 text-amber-700"  },
  beauty:           { icon: "✨", label: "Chụp Beauty",          color: "bg-fuchsia-100 text-fuchsia-700"},
  gia_dinh:         { icon: "👨‍👩‍👧", label: "Gia đình",       color: "bg-green-100 text-green-700"  },
  makeup_le:        { icon: "💋", label: "Makeup lẻ",           color: "bg-red-100 text-red-700"      },
  in_anh:           { icon: "🖨️", label: "In ảnh",              color: "bg-gray-100 text-gray-700"    },
};

function fmtVND(n: number) { return n.toLocaleString("vi-VN") + "đ"; }

function ServiceTag({ serviceType }: { serviceType?: string | null }) {
  if (!serviceType) return null;
  const cfg = TYPE_LABEL[serviceType];
  if (!cfg) return null;
  return (
    <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded", cfg.color)}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

function ServiceCard({
  svc,
  selected,
  onClick,
}: {
  svc: ServiceOption;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onMouseDown={onClick}
      className={cn(
        "w-full text-left px-3 py-2.5 transition-all border-b border-border/20 last:border-0",
        selected ? "bg-primary/8" : "hover:bg-muted/60 active:bg-muted"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className={cn("text-sm font-semibold leading-tight", selected ? "text-primary" : "text-foreground")}>
            {svc.name}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{svc.groupName}</p>
          <div className="flex items-center gap-1 flex-wrap mt-1">
            <ServiceTag serviceType={svc.serviceType} />
            {svc.includesMakeup === true && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-pink-100 text-pink-700">💄 có makeup</span>
            )}
            {svc.addons && svc.addons.length > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700">✚ add-on</span>
            )}
            {svc.products && svc.products.length > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">🎁 album</span>
            )}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <p className={cn("text-sm font-bold", selected ? "text-primary" : "text-foreground")}>
            {fmtVND(svc.price)}
          </p>
        </div>
      </div>
    </button>
  );
}

interface ServiceSearchBoxProps {
  value?: ServiceOption | null;
  onChange: (svc: ServiceOption | null) => void;
  placeholder?: string;
  allowCustom?: boolean;
  customLabel?: string;
  onCustom?: () => void;
  className?: string;
}

export function ServiceSearchBox({
  value,
  onChange,
  placeholder = "Tìm gói dịch vụ...",
  allowCustom = true,
  onCustom,
  className,
}: ServiceSearchBoxProps) {
  const [query, setQuery]           = useState(value?.name ?? "");
  const [focused, setFocused]       = useState(false);
  const [mode, setMode]             = useState<"suggestions" | "search">("suggestions");
  const inputRef                    = useRef<HTMLInputElement>(null);
  const timer                       = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load all packages + groups
  const { data: packages = [] } = useQuery<any[]>({
    queryKey: ["service-packages"],
    queryFn: () => fetchJson("/api/service-packages"),
    staleTime: 60_000,
  });
  const { data: groups = [] } = useQuery<any[]>({
    queryKey: ["service-groups"],
    queryFn: () => fetchJson("/api/service-groups"),
    staleTime: 60_000,
  });

  const groupMap = Object.fromEntries(groups.map((g: any) => [g.id, g.name]));

  const allOptions: ServiceOption[] = packages.map((p: any) => ({
    key: `pkg-${p.id}`,
    id: p.id,
    name: p.name,
    groupName: groupMap[p.groupId] ?? "",
    price: parseFloat(p.price) || 0,
    serviceType: p.serviceType ?? null,
    includesMakeup: p.includesMakeup !== false && p.includesMakeup !== 0,
    photoCount: p.photoCount ?? null,
    includedRetouchedPhotos: p.includedRetouchedPhotos ?? 0,
    printCost: parseFloat(p.printCost) || 0,
    operatingCost: parseFloat(p.operatingCost) || 0,
    salePercent: parseFloat(p.salePercent) || 0,
    addons: p.addons || [],
    items: p.items || [],
    products: p.products || [],
    description: p.description ?? null,
    notes: p.notes ?? null,
  }));

  // Suggestions = recent first, then popular
  const suggestions = (() => {
    const recent = getRecent();
    const recentOpts = recent.map(k => allOptions.find(o => o.key === k)).filter(Boolean) as ServiceOption[];
    const rest = allOptions.filter(o => !recent.includes(o.key)).slice(0, 10 - recentOpts.length);
    return [...recentOpts, ...rest].slice(0, 10);
  })();

  // Filtered search results
  const [searchResults, setSearchResults] = useState<ServiceOption[]>([]);

  const doSearch = useCallback((q: string) => {
    clearTimeout(timer.current);
    if (!q.trim()) { setMode("suggestions"); setSearchResults([]); return; }
    setMode("search");
    timer.current = setTimeout(() => {
      setSearchResults(searchServiceOptions(allOptions, q, 20));
    }, 150);
  }, [allOptions]);

  const handleSelect = (svc: ServiceOption) => {
    saveRecent(svc.key);
    onChange(svc);
    setQuery(svc.name);
    setFocused(false);
    inputRef.current?.blur();
  };

  const handleClear = () => {
    onChange(null);
    setQuery("");
    setMode("suggestions");
    setSearchResults([]);
    inputRef.current?.focus();
  };

  // Sync query with external value
  useEffect(() => {
    if (value?.name !== undefined) setQuery(value.name);
  }, [value?.name]);

  const listItems = mode === "search" ? searchResults : suggestions;
  const showDropdown = focused;

  return (
    <div className={cn("relative", className)}>
      {/* Input */}
      <div className="relative">
        <Package2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          className={cn(
            "w-full pl-9 pr-9 py-2.5 border rounded-xl text-sm bg-background transition-all",
            "focus:outline-none focus:ring-2 focus:ring-primary/30",
            focused ? "border-primary/60 shadow-sm" : "border-border"
          )}
          placeholder={placeholder}
          value={query}
          onChange={e => { setQuery(e.target.value); doSearch(e.target.value); }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 180)}
          autoComplete="off"
        />
        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {value && (
            <button onClick={handleClear} className="p-0.5 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          )}
          {!value && (
            <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", focused && "rotate-180")} />
          )}
        </div>
      </div>

      {/* Selected preview */}
      {value && !focused && (
        <div className="mt-1.5 p-2.5 bg-primary/5 border border-primary/20 rounded-xl space-y-1">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-primary">{value.name}</p>
              <p className="text-[10px] text-muted-foreground">{value.groupName}</p>
            </div>
            <p className="text-sm font-bold text-primary">{fmtVND(value.price)}</p>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <ServiceTag serviceType={value.serviceType} />
            {value.includesMakeup && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-pink-100 text-pink-700">💄 có makeup</span>
            )}
          </div>
        </div>
      )}

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute z-50 left-0 right-0 mt-1.5 bg-background border border-border rounded-2xl shadow-xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b border-border/60">
            {mode === "suggestions" ? (
              <>
                <Sparkles className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Gói phổ biến / Dùng gần đây
                </span>
              </>
            ) : (
              <>
                <ListFilter className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Kết quả tìm kiếm
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">{searchResults.length} gói</span>
              </>
            )}
          </div>

          {/* List */}
          <div className="max-h-64 overflow-y-auto overscroll-contain">
            {listItems.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {mode === "search"
                  ? <>Không tìm thấy gói nào khớp với "{query}"</>
                  : "Chưa có gói dịch vụ nào"}
              </div>
            ) : (
              listItems.map(svc => (
                <ServiceCard
                  key={svc.key}
                  svc={svc}
                  selected={value?.key === svc.key}
                  onClick={() => handleSelect(svc)}
                />
              ))
            )}
          </div>

          {/* Custom option */}
          {allowCustom && (
            <div className="border-t border-border/60 px-3 py-2 bg-muted/20">
              <button
                onMouseDown={() => { onCustom?.(); setFocused(false); }}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
              >
                <span className="text-base">✏️</span> Nhập tên tự do (không chọn từ danh sách)
              </button>
            </div>
          )}

          {/* Footer hint */}
          {mode === "suggestions" && listItems.length > 0 && (
            <div className="px-3 py-1.5 bg-muted/30 border-t border-border/40 text-[10px] text-muted-foreground text-center">
              Gõ để tìm kiếm • Ví dụ: "tiệc", "3tr", "5700", "5tr7"
            </div>
          )}
        </div>
      )}
    </div>
  );
}
