// Tiện ích dùng chung cho tính năng "Tích chọn hàng loạt" của các trang CMS ảnh
// (Concept ảnh + Ý tưởng chụp ảnh). Sao chép pattern từ trang Cho thuê đồ nhưng
// KHÔNG đụng vào file đó. Mọi thao tác chỉ chạy trên ID item (album/concept),
// không bao giờ xoá/chuyển chính danh mục cha/con.
import { useCallback, useMemo, useState } from "react";
import { Star, Trash2, FolderInput, X, Check, Minus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";

export interface BulkCat {
  id: number;
  parentId: number | null;
  name: string;
  sortOrder: number;
}

/** Tập id gồm danh mục gốc + toàn bộ con cháu (đệ quy). */
export function getDescendantCategoryIds(cats: BulkCat[], rootId: number): Set<number> {
  const ids = new Set<number>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const c of cats) {
      if (c.parentId != null && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        added = true;
      }
    }
  }
  return ids;
}

/** id của toàn bộ item nằm trong nhánh danh mục (gồm cả mục con). */
export function itemIdsInCategorySubtree<T extends { id: number; categoryId: number | null }>(
  items: T[],
  cats: BulkCat[],
  rootCatId: number,
): number[] {
  const sub = getDescendantCategoryIds(cats, rootCatId);
  return items.filter((it) => it.categoryId != null && sub.has(it.categoryId)).map((it) => it.id);
}

export type TriState = "none" | "some" | "all";

/** Trạng thái chọn của 1 nhánh danh mục dựa trên các item bên trong. */
export function subtreeSelectState(ids: number[], selected: Set<number>): TriState {
  if (ids.length === 0) return "none";
  let sel = 0;
  for (const id of ids) if (selected.has(id)) sel++;
  if (sel === 0) return "none";
  if (sel === ids.length) return "all";
  return "some";
}

/** Hook quản lý chế độ "Tích chọn" + tập id đã chọn. */
export function useBulkSelect() {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const toggle = useCallback((id: number) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const toggleMany = useCallback((ids: number[], select: boolean) => {
    setSelected((prev) => {
      const n = new Set(prev);
      for (const id of ids) {
        if (select) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);
  const enter = useCallback(() => setSelectMode(true), []);
  const exit = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  return { selectMode, selected, toggle, toggleMany, clear, enter, exit };
}

/** Ô tick 3 trạng thái (chọn / chọn một phần / chưa chọn). */
export function TriCheckbox({ state, className = "" }: { state: TriState | boolean; className?: string }) {
  const s: TriState = state === true ? "all" : state === false ? "none" : state;
  return (
    <span
      className={`inline-flex items-center justify-center w-5 h-5 rounded-[6px] border-2 transition-colors ${
        s === "all"
          ? "bg-primary border-primary text-white"
          : s === "some"
            ? "bg-primary/30 border-primary text-primary"
            : "bg-white/90 dark:bg-black/50 border-muted-foreground/50 text-transparent"
      } ${className}`}
    >
      {s === "some" ? <Minus className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
    </span>
  );
}

/** Thanh thao tác hàng loạt cố định đáy màn hình. Ẩn khi chưa chọn item nào. */
export function BulkActionBar({
  count,
  busy,
  onPriority,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  busy?: boolean;
  onPriority: () => void;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  if (count <= 0) return null;
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur px-4 py-2.5 shadow-[0_-2px_12px_rgba(0,0,0,0.08)]">
      <div className="max-w-5xl mx-auto flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold whitespace-nowrap">Đã chọn {count}</span>
        <button onClick={onClear} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
          <X className="w-3.5 h-3.5" /> Bỏ chọn
        </button>
        <div className="flex-1" />
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={onPriority}>
          <Star className="w-4 h-4" /> <span className="hidden sm:inline">Ưu tiên hiển thị</span>
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={onMove}>
          <FolderInput className="w-4 h-4" /> <span className="hidden sm:inline">Chuyển danh mục</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-destructive border-destructive/40 hover:bg-destructive/10"
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 className="w-4 h-4" /> <span className="hidden sm:inline">Xoá</span>
        </Button>
        {busy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
      </div>
    </div>
  );
}

/** Modal chọn danh mục đích để chuyển hàng loạt. Mount khi mở (state tự reset). */
export function BulkMoveDialog({
  cats,
  count,
  busy,
  onConfirm,
  onClose,
}: {
  cats: BulkCat[];
  count: number;
  busy?: boolean;
  onConfirm: (categoryId: number) => void;
  onClose: () => void;
}) {
  const [pick, setPick] = useState<number | null>(null);
  const flat = useMemo(() => {
    const byParent = new Map<number | null, BulkCat[]>();
    for (const c of cats) {
      const k = c.parentId ?? null;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(c);
    }
    for (const arr of byParent.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);
    const out: { cat: BulkCat; depth: number }[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const c of byParent.get(parent) ?? []) {
        out.push({ cat: c, depth });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [cats]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-background rounded-2xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="font-semibold text-sm">Chuyển {count} mục sang danh mục</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {flat.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Chưa có danh mục.</p>
          ) : (
            flat.map(({ cat, depth }) => (
              <button
                key={cat.id}
                onClick={() => setPick(cat.id)}
                className={`w-full text-left px-2 py-2 rounded-md text-sm hover:bg-muted ${
                  pick === cat.id ? "bg-primary/10 text-primary font-semibold" : ""
                }`}
                style={{ paddingLeft: 8 + depth * 16 }}
              >
                {cat.name}
              </button>
            ))
          )}
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Huỷ
          </Button>
          <Button size="sm" disabled={pick == null || busy} onClick={() => pick != null && onConfirm(pick)}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Chuyển"}
          </Button>
        </div>
      </div>
    </div>
  );
}
