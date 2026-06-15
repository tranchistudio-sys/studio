import { Minus, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CurrencyInput } from "@/components/ui/currency-input";

export type DeductionItem = { label: string; amount: number };

function genId() {
  return Math.random().toString(36).slice(2, 9);
}

type InternalItem = DeductionItem & { _id: string };

function fmtVND(n: number) { return n.toLocaleString("vi-VN") + "đ"; }

interface DeductionEditorProps {
  deductions: DeductionItem[];
  onChange: (items: DeductionItem[]) => void;
  className?: string;
}

export function DeductionEditor({ deductions, onChange, className }: DeductionEditorProps) {
  const items: InternalItem[] = deductions.map((d, i) => ({ ...d, _id: String(i) }));
  const total = deductions.reduce((s, d) => s + (d.amount || 0), 0);

  const update = (_id: string, patch: Partial<DeductionItem>) => {
    const idx = items.findIndex(i => i._id === _id);
    if (idx < 0) return;
    const next = [...deductions];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  const remove = (_id: string) => {
    const idx = items.findIndex(i => i._id === _id);
    if (idx < 0) return;
    const next = [...deductions];
    next.splice(idx, 1);
    onChange(next);
  };

  const add = () => {
    onChange([...deductions, { label: "", amount: 0 }]);
  };

  const internalItems: InternalItem[] = deductions.map((d, i) => ({ ...d, _id: String(i) }));

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Minus className="w-3.5 h-3.5 text-red-500" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Giảm trừ dịch vụ
          </span>
        </div>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-semibold transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Thêm dòng
        </button>
      </div>

      {internalItems.length === 0 ? (
        <button
          type="button"
          onClick={add}
          className="w-full border-2 border-dashed border-border/60 rounded-xl py-3 text-xs text-muted-foreground hover:border-red-300/60 hover:bg-red-50/20 transition-all flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Thêm khoản giảm trừ dịch vụ
        </button>
      ) : (
        <div className="space-y-1.5">
          {internalItems.map((item, idx) => (
            <div key={item._id} className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-4 flex-shrink-0 text-center">{idx + 1}</span>
              <input
                className="flex-1 px-2.5 py-2 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-1 focus:ring-red-400/40"
                placeholder="Tên giảm trừ (VD: Hoàn phí, Khuyến mãi...)"
                value={item.label}
                onChange={e => update(item._id, { label: e.target.value })}
              />
              <div className="relative flex-shrink-0 w-32">
                <CurrencyInput
                  className="w-full px-2.5 py-2 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-1 focus:ring-red-400/40 text-right"
                  placeholder="0"
                  value={String(item.amount || "")}
                  onChange={raw => update(item._id, { amount: parseFloat(raw) || 0 })}
                />
              </div>
              <button
                type="button"
                onClick={() => remove(item._id)}
                className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors flex-shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          {total > 0 && (
            <div className="flex items-center justify-between px-2 pt-1.5 border-t border-border/40">
              <span className="text-[11px] text-muted-foreground">Tổng giảm trừ dịch vụ</span>
              <span className="text-sm font-bold text-red-600">−{fmtVND(total)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
