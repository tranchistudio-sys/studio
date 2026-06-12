import { useCallback, useMemo, useState } from "react";
import { X } from "lucide-react";

/**
 * Chip tag input dùng chung cho các trang CMS (váy, album, ý tưởng).
 * - Chip gợi ý bấm để thêm/bỏ nhanh.
 * - Gõ tay + Enter để thêm tag mới; tag mới được nhớ vào danh sách gợi ý
 *   (localStorage, mỗi module một key riêng).
 * Tách ra từ pages/cms/gallery.tsx để dùng lại cho dresses & photo ideas —
 * dữ liệu tags này là đầu vào match của Public AI Advisor.
 */

export function normalizeTag(s: string): string { return s.trim().replace(/\s+/g, " "); }

function loadCommonTags(storageKey: string, defaults: string[]): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) {
      localStorage.setItem(storageKey, JSON.stringify(defaults));
      return [...defaults];
    }
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [...defaults];
    const list = arr.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0);
    // Bổ sung gợi ý mặc định mới (thêm vào sau khi user đã có list cũ)
    const lower = new Set(list.map(t => t.toLowerCase()));
    let changed = false;
    for (const d of defaults) {
      if (!lower.has(d.toLowerCase())) { list.push(d); lower.add(d.toLowerCase()); changed = true; }
    }
    if (changed) localStorage.setItem(storageKey, JSON.stringify(list));
    return list;
  } catch { return [...defaults]; }
}

function saveCommonTags(storageKey: string, list: string[]) {
  try { localStorage.setItem(storageKey, JSON.stringify(list)); } catch { /* ignore */ }
}

export function useCommonTags(storageKey: string, defaults: string[]) {
  const [list, setList] = useState<string[]>(() => loadCommonTags(storageKey, defaults));
  const add = useCallback((raw: string) => {
    const n = normalizeTag(raw); if (!n) return;
    const lower = n.toLowerCase();
    setList(prev => {
      if (prev.some(t => t.toLowerCase() === lower)) return prev;
      const next = [...prev, n]; saveCommonTags(storageKey, next); return next;
    });
  }, [storageKey]);
  return { list, add };
}

export function ChipSuggest({ label, suggestions, value, onChange, onAddSuggestion }: {
  label: string; suggestions: string[]; value: string; onChange: (v: string) => void;
  onAddSuggestion?: (s: string) => void;
}) {
  const current = useMemo(
    () => (value ? value.split(",").map(s => s.trim()).filter(Boolean) : []),
    [value]
  );
  const currentLower = useMemo(() => new Set(current.map(t => t.toLowerCase())), [current]);
  const [draft, setDraft] = useState("");
  function commit(next: string[]) { onChange(next.join(", ")); }
  function addTag(raw: string) {
    const n = normalizeTag(raw); if (!n) return;
    if (currentLower.has(n.toLowerCase())) return;
    commit([...current, n]);
    onAddSuggestion?.(n);
  }
  function removeAt(idx: number) { const next = current.slice(); next.splice(idx, 1); commit(next); }
  function toggleSuggestion(s: string) {
    const lower = s.toLowerCase();
    if (currentLower.has(lower)) commit(current.filter(t => t.toLowerCase() !== lower));
    else commit([...current, s]);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (draft.trim()) { addTag(draft); setDraft(""); }
    } else if (e.key === "Backspace" && draft === "" && current.length > 0) {
      e.preventDefault(); removeAt(current.length - 1);
    }
  }
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-2 block">{label}</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {suggestions.map(s => {
          const active = currentLower.has(s.toLowerCase());
          return (
            <button key={s} type="button" onClick={() => toggleSuggestion(s)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
              }`}
            >{active ? "✓ " : ""}{s}</button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 min-h-[2.25rem] px-2 py-1.5 rounded-md border border-border bg-background focus-within:border-primary/60 transition-colors">
        {current.map((tag, idx) => (
          <span key={`${tag}-${idx}`} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-primary text-primary-foreground">
            {tag}
            <button type="button" onClick={() => removeAt(idx)} className="inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-white/20" aria-label={`Xoá ${tag}`}>
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown}
          onBlur={() => { if (draft.trim()) { addTag(draft); setDraft(""); } }}
          placeholder={current.length === 0 ? "Nhập tag rồi nhấn Enter…" : ""}
          className="flex-1 min-w-[8rem] bg-transparent outline-none text-sm h-6"
        />
      </div>
    </div>
  );
}

/**
 * Hàng chip lọc nhanh (multi-select, cuộn ngang) — cùng phong cách bộ lọc
 * bên CMS Cho thuê đồ. Dùng cho khu "bộ lọc thông minh" của Gallery & Ý tưởng.
 */
export function FilterChipRow({ label, options, selected, onToggle }: {
  label: string; options: string[]; selected: Set<string>; onToggle: (v: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
      <span className="text-[10px] text-muted-foreground flex-shrink-0 w-12">{label}</span>
      {options.map(s => {
        const active = selected.has(s);
        return (
          <button key={s} type="button"
            onClick={() => onToggle(s)}
            className={`flex-shrink-0 px-2 py-0.5 text-xs rounded-full border transition-all ${
              active
                ? "bg-foreground text-background border-foreground"
                : "bg-background text-muted-foreground border-border hover:border-foreground"
            }`}>
            {active ? "✓ " : ""}{s}
          </button>
        );
      })}
    </div>
  );
}

/** Hàng chip chọn 1 giá trị (single-select) cho trạng thái. */
export function FilterRadioRow<T extends string>({ label, options, value, onChange }: {
  label: string; options: Array<{ key: T; label: string }>; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
      <span className="text-[10px] text-muted-foreground flex-shrink-0 w-12">{label}</span>
      {options.map(o => (
        <button key={o.key} type="button"
          onClick={() => onChange(o.key)}
          className={`flex-shrink-0 px-2 py-0.5 text-xs rounded-full border transition-all ${
            value === o.key
              ? "bg-foreground text-background border-foreground"
              : "bg-background text-muted-foreground border-border hover:border-foreground"
          }`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Gộp tag từ dữ liệu thật + danh sách gợi ý mặc định (bỏ trùng, giữ thứ tự data trước). */
export function mergeTagOptions(fromData: Iterable<string>, defaults: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of fromData) {
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  for (const t of defaults) {
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

// ─── Danh sách gợi ý chuẩn theo module ───────────────────────────────────────

/** Tag gợi ý cho váy / trang phục cho thuê. */
export const DRESS_TAG_KEY = "cms-dress-common-tags-v1";
export const DRESS_TAG_DEFAULTS = [
  "nàng thơ", "kín đáo", "sang trọng", "sexy", "tiểu thư",
  "Hàn Quốc", "công chúa", "đơn giản", "cao cấp",
];

/** Tag gợi ý cho album bộ ảnh (đã dùng từ trước ở CMS Gallery). */
export const GALLERY_TAG_KEY = "cms-gallery-common-tags-v1";
export const GALLERY_TAG_DEFAULTS = [
  "beauty", "sexy", "nàng thơ", "sang trọng", "ngầu", "cá tính",
  "cưới", "studio", "ngoại cảnh", "phông xám",
  "áo dài", "truyền thống", "hiện đại", "việt phục",
  "sinh nhật", "vintage", "tối giản", "Hàn Quốc",
];

/** Tag gợi ý cho ý tưởng chụp ảnh. */
export const IDEA_TAG_KEY = "cms-idea-common-tags-v1";
export const IDEA_TAG_DEFAULTS = [
  "nàng thơ", "sexy", "sang trọng", "cổ điển", "hiện đại",
  "Hàn Quốc", "vintage", "Tết", "áo dài", "cưới", "beauty", "mới lạ",
];

/** Danh mục gợi ý cho album — bấm là chọn (tự tạo nếu chưa có). */
export const ALBUM_CATEGORY_SUGGESTIONS = [
  "Beauty", "Sinh nhật", "Bầu", "Cổng cưới", "Album cưới",
  "Ngoại cảnh", "Studio", "Áo dài", "Fashion",
];
