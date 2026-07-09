import React, { useState, useEffect, useCallback, useRef, useMemo, memo, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOutfitSchedule, useOutfitConflict } from "@/hooks/use-outfit-schedule";
import { format, parseISO } from "date-fns";
import { vi } from "date-fns/locale";
import { Shirt, Plus, X, AlertTriangle, Calendar, Search, QrCode, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatVND } from "@/lib/utils";
import { getImageSrc } from "@/lib/imageUtils";

const RENTAL_STATUS_LABEL: Record<string, string> = {
  san_sang: "Sẵn sàng",
  dang_thue: "Đang thuê",
  bao_tri: "Bảo trì",
  ngung: "Ngừng",
};

import { API_BASE } from "@/lib/api-base";
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_TIMEOUT_MS = 5000;
const MAX_RESULTS = 20;
const QR_DEDUPE_MS = 2000;

function parseCSV(v: string | null | undefined): string[] {
  if (!v) return [];
  return v.split(",").map(s => s.trim()).filter(Boolean);
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

function highlightMatch(text: string, q: string): React.ReactNode {
  if (!q || !text) return text;
  const lowText = text.toLowerCase();
  const lowQ = q.toLowerCase();
  const idx = lowText.indexOf(lowQ);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 text-foreground rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export type OutfitDraft = {
  tempId: string;
  dressId: number;
  outfitCode: string;
  outfitName: string;
  outfitImage?: string | null;
  category?: string | null;
  size?: string | null;
  rentalPrice?: number;
  pickupDate: string;
  returnDate: string;
  status: "reserved" | "picked_up" | "returned" | "cancelled";
  note?: string;
  dbId?: number | null;
  /** Váy data cũ còn gắn ở booking CHA — hiển thị tạm ở Dịch vụ 1, lưu xong move về child. */
  fromParent?: boolean;
};

type DressOption = {
  id: number;
  code: string;
  name: string;
  imageUrl?: string | null;
  coverImageUrl?: string | null;
  publicImageUrl?: string | null;
  extraImages?: string[] | null;
  category?: string;
  size?: string;
  sizeText?: string | null;
  color?: string;
  colorText?: string | null;
  tagsText?: string | null;
  rentalPrice?: number;
  rentalStatus?: string;
};

const QrScannerModal = lazy(() => import("./outfit-qr-scanner"));

function authFetch(url: string, opts?: RequestInit) {
  let token: string | null = null;
  try { token = localStorage.getItem("amazingStudioToken_v2"); } catch {}
  const headers = { ...(opts?.headers as Record<string, string> ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return fetch(url, { ...opts, headers });
}

function fmtDM(d: string) {
  try { return format(parseISO(d), "dd/MM", { locale: vi }); } catch { return d; }
}

function pickThumb(d: DressOption | OutfitDraft | null | undefined): string {
  if (!d) return "";
  const candidates: (string | null | undefined)[] = [
    (d as DressOption).coverImageUrl,
    (d as DressOption).extraImages?.[0],
    (d as DressOption).imageUrl,
    (d as OutfitDraft).outfitImage,
    (d as DressOption).publicImageUrl,
  ];
  for (const raw of candidates) {
    const resolved = getImageSrc(raw);
    if (resolved) return resolved;
  }
  return "";
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-shrink-0 px-2 py-0.5 text-[10px] border rounded transition-colors whitespace-nowrap ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground bg-background"
      }`}
    >
      {label}
    </button>
  );
}

function OutfitBookingSectionInner({
  draft,
  onChange,
}: {
  draft: OutfitDraft[];
  onChange: (next: OutfitDraft[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [qrOpen, setQrOpen] = useState(false);
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set());
  const [selectedWeights, setSelectedWeights] = useState<Set<string>>(new Set());
  const [selectedColors, setSelectedColors] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastScanRef = useRef<{ code: string; ts: number } | null>(null);
  const { toast } = useToast();

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch all dresses when dropdown opens (client-side filter for instant chip UX)
  const {
    data: allDresses = [],
    isFetching: allLoading,
    isError: allError,
  } = useQuery<DressOption[]>({
    queryKey: ["all-dresses-admin"],
    enabled: open,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      signal?.addEventListener("abort", onAbort);
      const timeoutId = setTimeout(() => ctl.abort(), SEARCH_TIMEOUT_MS);
      try {
        const res = await authFetch(`${API_BASE}/api/dresses?limit=500`, { signal: ctl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });

  // Reset highlight when results change
  useEffect(() => { setHighlight(0); }, [allDresses, debouncedSearch, selectedSizes, selectedWeights, selectedColors, selectedTags]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // ── Chip options computed from all dresses ───────────────────────────────
  const { sizeOptions, weightOptions } = useMemo(() => {
    const allTokens = new Set<string>();
    for (const d of allDresses) parseCSV(d.sizeText || d.size).forEach(v => allTokens.add(v));
    const sizes: string[] = [];
    const weights: string[] = [];
    for (const t of allTokens) (isWeightToken(t) ? weights : sizes).push(t);
    sizes.sort();
    weights.sort((a, b) => weightSortKey(a) - weightSortKey(b));
    return { sizeOptions: sizes, weightOptions: weights };
  }, [allDresses]);

  const colorOptions = useMemo(() => {
    const s = new Set<string>();
    for (const d of allDresses) parseCSV(d.colorText || d.color).forEach(v => s.add(v));
    return [...s].sort();
  }, [allDresses]);

  const tagOptions = useMemo(() => {
    const s = new Set<string>();
    for (const d of allDresses) parseCSV(d.tagsText).forEach(v => s.add(v));
    return [...s].sort();
  }, [allDresses]);

  // ── Client-side filter ───────────────────────────────────────────────────
  const filteredResults = useMemo(() => {
    let list = allDresses;

    const q = debouncedSearch.trim();
    if (q) {
      const tokens = stripDiacritics(q).split(/\s+/).filter(Boolean);
      list = list.filter(d => {
        const hay = stripDiacritics([
          d.name, d.code, d.tagsText ?? "",
          d.colorText || d.color || "",
          d.sizeText || d.size || "",
          d.category || "",
        ].join(" "));
        return tokens.every(t => hay.includes(t));
      });
    }

    if (selectedSizes.size > 0) {
      list = list.filter(d => {
        const v = (d.sizeText || d.size || "").toLowerCase();
        return [...selectedSizes].some(s => v.includes(s.toLowerCase()));
      });
    }
    if (selectedWeights.size > 0) {
      list = list.filter(d => {
        const v = (d.sizeText || d.size || "").toLowerCase();
        return [...selectedWeights].some(s => v.includes(s.toLowerCase()));
      });
    }
    if (selectedColors.size > 0) {
      list = list.filter(d => {
        const v = (d.colorText || d.color || "").toLowerCase();
        return [...selectedColors].some(s => v.includes(s.toLowerCase()));
      });
    }
    if (selectedTags.size > 0) {
      list = list.filter(d => {
        const v = (d.tagsText || "").toLowerCase();
        return [...selectedTags].some(s => v.includes(s.toLowerCase()));
      });
    }

    return list.slice(0, MAX_RESULTS);
  }, [allDresses, debouncedSearch, selectedSizes, selectedWeights, selectedColors, selectedTags]);

  const hasChipFilter =
    selectedSizes.size > 0 || selectedWeights.size > 0 ||
    selectedColors.size > 0 || selectedTags.size > 0;

  const addOutfit = useCallback((dress: DressOption, source: "manual" | "qr" = "manual") => {
    if (!dress || typeof dress.id !== "number") return;
    const exists = draft.some(d => d.dressId === dress.id);
    if (exists) {
      toast({ title: "Đã có trong danh sách", description: `${dress.code} đã được chọn.`, variant: "destructive" as any });
      if (source === "manual") {
        setSearch("");
        setDebouncedSearch("");
      }
      return;
    }
    const next: OutfitDraft = {
      tempId: Math.random().toString(36).slice(2),
      dressId: dress.id,
      outfitCode: dress.code,
      outfitName: dress.name,
      outfitImage: pickThumb(dress) || undefined,
      category: dress.category || null,
      size: dress.size || null,
      rentalPrice: dress.rentalPrice || 0,
      pickupDate: today,
      returnDate: today,
      status: "reserved",
      note: "",
      dbId: null,
    };
    onChange([...draft, next]);
    setSearch("");
    setDebouncedSearch("");
    setHighlight(0);
    if (source === "manual") {
      setTimeout(() => searchRef.current?.focus(), 0);
    } else {
      setOpen(false);
    }
  }, [draft, onChange, today, toast]);

  const handleQrScan = useCallback(async (code: string) => {
    const trimmed = (code || "").trim();
    if (!trimmed) return;
    const now = Date.now();
    const last = lastScanRef.current;
    if (last && last.code === trimmed && now - last.ts < QR_DEDUPE_MS) return;
    lastScanRef.current = { code: trimmed, ts: now };

    setOpen(true);
    setSearch(trimmed);
    setDebouncedSearch(trimmed);
    try { searchRef.current?.blur(); } catch {}

    const ctl = new AbortController();
    const timeoutId = setTimeout(() => ctl.abort(), SEARCH_TIMEOUT_MS);
    try {
      const res = await authFetch(
        `${API_BASE}/api/dresses?search=${encodeURIComponent(trimmed)}&limit=5`,
        { signal: ctl.signal }
      );
      if (!res.ok) throw new Error("Lookup failed");
      const data = await res.json();
      const arr: DressOption[] = Array.isArray(data) ? data : [];
      const exact = arr.find(d => (d.code || "").toLowerCase() === trimmed.toLowerCase());
      if (exact) {
        addOutfit(exact, "qr");
        setQrOpen(false);
      } else {
        toast({ title: "Không tìm thấy mã", description: trimmed, variant: "destructive" as any });
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        toast({ title: "Lỗi quét mã", description: String(e?.message || e), variant: "destructive" as any });
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }, [addOutfit, toast]);

  const handleCameraFail = useCallback(() => {
    setQrOpen(false);
    toast({ title: "Không thể mở camera", description: "Vui lòng nhập mã thủ công.", variant: "destructive" as any });
    setOpen(true);
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [toast]);

  const removeOutfit = useCallback((tempId: string) => {
    onChange(draft.filter(d => d.tempId !== tempId));
  }, [draft, onChange]);

  const updateOutfit = useCallback((tempId: string, patch: Partial<OutfitDraft>) => {
    onChange(draft.map(d => d.tempId === tempId ? { ...d, ...patch } : d));
  }, [draft, onChange]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(h => Math.min(h + 1, Math.max(0, filteredResults.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(h => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = debouncedSearch.toLowerCase();
      const exact = filteredResults.find(d => (d.code || "").toLowerCase() === q);
      const pick = exact ?? filteredResults[highlight];
      if (pick) addOutfit(pick, "manual");
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setSearch("");
    }
  }, [filteredResults, highlight, debouncedSearch, addOutfit]);

  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        <Shirt className="w-3.5 h-3.5" /> F. Trang phục / Đạo cụ đi kèm
      </h4>

      {draft.map(item => (
        <OutfitRow
          key={item.tempId}
          item={item}
          onUpdate={(patch) => updateOutfit(item.tempId, patch)}
          onRemove={() => removeOutfit(item.tempId)}
          today={today}
        />
      ))}

      {/* Add row */}
      <div className="relative" ref={containerRef}>
        {!open ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setOpen(true); setTimeout(() => searchRef.current?.focus(), 50); }}
              className="flex-1 border-2 border-dashed border-border rounded-xl py-2 text-xs text-muted-foreground hover:border-primary/40 hover:bg-muted/20 transition-all flex items-center justify-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" /> Thêm trang phục
            </button>
            <button
              type="button"
              onClick={() => setQrOpen(true)}
              title="Quét mã QR"
              className="border-2 border-dashed border-border rounded-xl px-3 text-muted-foreground hover:border-primary/40 hover:bg-muted/20 transition-all flex items-center justify-center"
            >
              <QrCode className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="bg-popover border border-border rounded-xl shadow-lg p-2 space-y-2">
            {/* Search + QR + Close */}
            <div className="flex gap-2 items-center">
              <div className="flex-1 relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  ref={searchRef}
                  className="w-full h-9 pl-8 pr-8 rounded-lg border border-input bg-background text-sm"
                  placeholder="Tìm theo tên, mã, tag, màu, size…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={onKeyDown}
                  autoComplete="off"
                />
                {allLoading && (
                  <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground animate-spin" />
                )}
              </div>
              <button
                type="button"
                onClick={() => setQrOpen(true)}
                title="Quét mã QR"
                className="h-9 px-2.5 rounded-lg border border-input bg-background text-muted-foreground hover:bg-muted flex items-center justify-center"
              >
                <QrCode className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => { setOpen(false); setSearch(""); }}
                className="h-9 px-2 rounded-lg text-xs text-muted-foreground hover:bg-muted"
              >
                Đóng
              </button>
            </div>

            {/* Chip filters */}
            <div className="space-y-1">
              {sizeOptions.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                  <span className="text-[9px] tracking-wider text-muted-foreground uppercase flex-shrink-0">Size</span>
                  {sizeOptions.map(s => (
                    <FilterChip
                      key={s}
                      label={s}
                      active={selectedSizes.has(s)}
                      onClick={() => setSelectedSizes(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; })}
                    />
                  ))}
                </div>
              )}
              {weightOptions.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                  <span className="text-[9px] tracking-wider text-muted-foreground uppercase flex-shrink-0">Số đo</span>
                  {weightOptions.map(s => (
                    <FilterChip
                      key={s}
                      label={s}
                      active={selectedWeights.has(s)}
                      onClick={() => setSelectedWeights(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; })}
                    />
                  ))}
                </div>
              )}
              {colorOptions.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                  <span className="text-[9px] tracking-wider text-muted-foreground uppercase flex-shrink-0">Màu</span>
                  {colorOptions.map(s => (
                    <FilterChip
                      key={s}
                      label={s}
                      active={selectedColors.has(s)}
                      onClick={() => setSelectedColors(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; })}
                    />
                  ))}
                </div>
              )}
              {tagOptions.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                  <span className="text-[9px] tracking-wider text-muted-foreground uppercase flex-shrink-0">Kiểu</span>
                  {tagOptions.map(s => (
                    <FilterChip
                      key={s}
                      label={s}
                      active={selectedTags.has(s)}
                      onClick={() => setSelectedTags(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; })}
                    />
                  ))}
                </div>
              )}
              {hasChipFilter && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedSizes(new Set());
                    setSelectedWeights(new Set());
                    setSelectedColors(new Set());
                    setSelectedTags(new Set());
                  }}
                  className="text-[10px] text-primary hover:underline"
                >
                  Xóa bộ lọc
                </button>
              )}
            </div>

            {/* Results / Loading / Error / Empty */}
            {allLoading && (
              <p className="text-xs text-muted-foreground px-2 py-2 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Đang tìm trang phục...
              </p>
            )}
            {!allLoading && allError && (
              <p className="text-xs text-destructive px-2 py-2 flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" /> Không thể tải danh sách trang phục
              </p>
            )}
            {!allLoading && !allError && filteredResults.length > 0 && (
              <div className="max-h-72 overflow-y-auto space-y-1">
                {filteredResults.map((d, idx) => {
                  const colorTxt = d.colorText || d.color || "";
                  const statusLabel = d.rentalStatus ? (RENTAL_STATUS_LABEL[d.rentalStatus] || d.rentalStatus) : "";
                  const statusClass = d.rentalStatus === "san_sang"
                    ? "bg-emerald-100 text-emerald-700"
                    : d.rentalStatus === "dang_thue"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-muted text-muted-foreground";
                  const thumb = pickThumb(d);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      className={`w-full text-left px-2 py-1.5 rounded-lg text-sm flex items-start gap-2 ${
                        idx === highlight ? "bg-primary/10" : "hover:bg-muted"
                      }`}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => addOutfit(d, "manual")}
                    >
                      {thumb ? (
                        <img
                          src={thumb}
                          className="w-16 h-16 rounded-lg object-cover bg-muted flex-shrink-0 border border-border"
                          alt=""
                          loading="lazy"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                        />
                      ) : (
                        <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 border border-border">
                          <Shirt className="w-6 h-6 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate text-sm">
                          <span className="font-mono text-primary">{highlightMatch(d.code || "", debouncedSearch)}</span>
                          {" · "}
                          <span>{highlightMatch(d.name || "", debouncedSearch)}</span>
                        </p>
                        <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground mt-0.5">
                          {d.category && <span>{d.category}</span>}
                          {d.size && <span>• {d.size}</span>}
                          {colorTxt && <span>• {colorTxt}</span>}
                          {typeof d.rentalPrice === "number" && d.rentalPrice > 0 && (
                            <span className="text-foreground font-medium">{formatVND(d.rentalPrice)}</span>
                          )}
                          {statusLabel && (
                            <span className={`px-1.5 py-0.5 rounded ${statusClass}`}>{statusLabel}</span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {!allLoading && !allError && filteredResults.length === 0 && (
              <p className="text-xs text-muted-foreground px-2 py-2">Không tìm thấy outfit</p>
            )}
          </div>
        )}
      </div>

      {qrOpen && (
        <Suspense fallback={null}>
          <QrScannerModal onClose={() => setQrOpen(false)} onScan={handleQrScan} onCameraFail={handleCameraFail} />
        </Suspense>
      )}
    </section>
  );
}

const OutfitBookingSection = memo(OutfitBookingSectionInner);
export default OutfitBookingSection;

const OutfitRow = memo(function OutfitRow({
  item,
  onUpdate,
  onRemove,
  today,
}: {
  item: OutfitDraft;
  onUpdate: (patch: Partial<OutfitDraft>) => void;
  onRemove: () => void;
  today: string;
}) {
  const { data: schedule = [] } = useOutfitSchedule(item.dressId, "admin");
  const { data: conflict } = useOutfitConflict(
    item.dressId,
    item.pickupDate,
    item.returnDate,
    item.dbId ?? null,
    true
  );

  const future = schedule.filter(s => s.returnDate >= today);
  const nearest = future[0];
  const hasConflict = (conflict?.conflicts?.length ?? 0) > 0;
  const [imgErr, setImgErr] = useState(false);
  const thumb = pickThumb(item);

  return (
    <div className={`rounded-xl border p-2.5 space-y-2 ${hasConflict ? "border-destructive bg-destructive/5" : "border-border bg-muted/30"}`}>
      <div className="flex items-center gap-3">
        <div className="w-24 h-24 rounded-xl bg-muted flex-shrink-0 border border-border overflow-hidden shadow-sm">
          {!imgErr && thumb ? (
            <img
              src={thumb}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
              onError={() => setImgErr(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Shirt className="w-8 h-8 text-muted-foreground" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            <span className="font-mono text-primary">{item.outfitCode}</span> · {item.outfitName}
          </p>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {nearest ? (
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Lịch gần nhất: {fmtDM(nearest.pickupDate)} → {fmtDM(nearest.returnDate)}
                {nearest.bookingCode ? ` · ${nearest.bookingCode}` : ""}
              </span>
            ) : (
              <span>Không có lịch tương lai</span>
            )}
          </div>
        </div>
        <button type="button" onClick={onRemove} className="p-1 text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
      </div>

      {hasConflict && (
        <div className="text-[10px] text-destructive flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          Trùng lịch: {conflict?.conflicts?.map(c => `${c.order_code || "BK"} (${fmtDM(c.pickup_date)} → ${fmtDM(c.return_date)})`).join(", ")}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">Lấy</span>
          <input
            type="date"
            className="h-7 px-1.5 rounded-md border border-input bg-background text-xs"
            value={item.pickupDate}
            onChange={e => onUpdate({ pickupDate: e.target.value })}
          />
        </div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">Trả</span>
          <input
            type="date"
            className="h-7 px-1.5 rounded-md border border-input bg-background text-xs"
            value={item.returnDate}
            onChange={e => onUpdate({ returnDate: e.target.value })}
          />
        </div>
        <select
          className="h-7 px-1.5 rounded-md border border-input bg-background text-xs"
          value={item.status}
          onChange={e => onUpdate({ status: e.target.value as OutfitDraft["status"] })}
        >
          <option value="reserved">Đã giữ</option>
          <option value="picked_up">Đã lấy</option>
          <option value="returned">Đã trả</option>
          <option value="cancelled">Huỷ</option>
        </select>
        <input
          className="flex-1 h-7 px-2 rounded-md border border-input bg-background text-xs"
          placeholder="Ghi chú..."
          value={item.note || ""}
          onChange={e => onUpdate({ note: e.target.value })}
        />
      </div>
    </div>
  );
});
