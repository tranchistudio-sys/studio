import { Plus, Trash2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { CurrencyInput } from "@/components/ui/currency-input";

export type SurchargeItem = {
  id: string;
  name: string;
  amount: number;
};

function genId() {
  return Math.random().toString(36).slice(2, 9);
}

export function newSurcharge(): SurchargeItem {
  return { id: genId(), name: "", amount: 0 };
}

function fmtVND(n: number) { return n.toLocaleString("vi-VN") + "đ"; }

interface SurchargeEditorProps {
  value: SurchargeItem[];
  onChange: (items: SurchargeItem[]) => void;
  className?: string;
}

export function SurchargeEditor({ value, onChange, className }: SurchargeEditorProps) {
  const total = value.reduce((s, i) => s + (i.amount || 0), 0);

  const update = (id: string, patch: Partial<SurchargeItem>) => {
    onChange(value.map(item => item.id === id ? { ...item, ...patch } : item));
  };

  const remove = (id: string) => {
    onChange(value.filter(item => item.id !== id));
  };

  const add = () => {
    onChange([...value, newSurcharge()]);
  };

  return (
    <div className={cn("space-y-2", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Phụ thu / Phát sinh
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

      {/* Lines */}
      {value.length === 0 ? (
        <button
          type="button"
          onClick={add}
          className="w-full border-2 border-dashed border-border/60 rounded-xl py-3 text-xs text-muted-foreground hover:border-primary/40 hover:bg-muted/20 transition-all flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Thêm chi phí phát sinh / phụ thu ngoài gói
        </button>
      ) : (
        <div className="space-y-1.5">
          {value.map((item, idx) => (
            <div key={item.id} className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-4 flex-shrink-0 text-center">{idx + 1}</span>
              <input
                className="flex-1 px-2.5 py-2 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
                placeholder="Tên phát sinh (VD: Phụ thu xa, Thêm giờ...)"
                value={item.name}
                onChange={e => update(item.id, { name: e.target.value })}
              />
              <div className="relative flex-shrink-0 w-32">
                <CurrencyInput
                  className="w-full px-2.5 py-2 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary/40 text-right"
                  placeholder="0"
                  value={String(item.amount || "")}
                  onChange={raw => update(item.id, { amount: parseFloat(raw) || 0 })}
                />
              </div>
              <button
                type="button"
                onClick={() => remove(item.id)}
                className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors flex-shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          {/* Total */}
          {total > 0 && (
            <div className="flex items-center justify-between px-2 pt-1.5 border-t border-border/40">
              <span className="text-[11px] text-muted-foreground">Tổng phát sinh</span>
              <span className="text-sm font-bold text-amber-600">+{fmtVND(total)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
