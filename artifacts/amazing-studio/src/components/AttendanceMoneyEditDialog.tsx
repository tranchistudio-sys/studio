import { useState, useEffect } from "react";
import { X, Pencil } from "lucide-react";
import { Button } from "@/components/ui";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";

const vnd = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n);

const inputCls = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";

export type MoneyEditContext = {
  staffId: number;
  staffName: string;
  date: string;
  field: "penalty" | "bonus" | "net";
  systemPenalty?: number;
  systemBonus?: number;
  label?: string;
};

const QUICK_REASONS = [
  "Gỡ lỗi hệ thống",
  "Sai quy tắc phạt",
  "Nhân viên có lý do chính đáng",
  "Điều chỉnh thưởng tháng",
];

type Props = {
  ctx: MoneyEditContext;
  saving: boolean;
  onClose: () => void;
  onSave: (data: {
    staffId: number;
    date: string;
    action: "waiver" | "penalty" | "bonus";
    amount: number;
    reason: string;
    systemPenalty?: number;
  }) => void;
};

export function AttendanceMoneyEditDialog({ ctx, saving, onClose, onSave }: Props) {
  const [date, setDate] = useState(ctx.date);
  const [action, setAction] = useState<"waiver" | "penalty" | "bonus">(
    ctx.field === "bonus" ? "bonus" : ctx.systemPenalty && ctx.systemPenalty > 0 ? "waiver" : "penalty",
  );
  const [amount, setAmount] = useState(
    ctx.systemPenalty && ctx.systemPenalty > 0 ? String(ctx.systemPenalty) : "",
  );
  const [reason, setReason] = useState("");

  useEffect(() => {
    setDate(ctx.date);
    setAction(ctx.field === "bonus" ? "bonus" : ctx.systemPenalty && ctx.systemPenalty > 0 ? "waiver" : "penalty");
    setAmount(ctx.systemPenalty && ctx.systemPenalty > 0 ? String(ctx.systemPenalty) : "");
    setReason("");
  }, [ctx]);

  const amtNum = parseFloat(amount.replace(/\./g, "")) || 0;
  const previewNet =
    action === "waiver" && ctx.systemPenalty
      ? Math.max(0, ctx.systemPenalty - amtNum)
      : action === "penalty"
        ? (ctx.systemPenalty ?? 0) + amtNum
        : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-background rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold text-sm">Sửa tiền phạt / thưởng</span>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs text-muted-foreground">
            Nhân viên: <span className="font-semibold text-foreground">{ctx.staffName}</span>
            {ctx.label && <> · <span>{ctx.label}</span></>}
          </div>
          {ctx.systemPenalty != null && ctx.systemPenalty > 0 && (
            <p className="text-[11px] bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 rounded px-2 py-1.5">
              Phạt hệ thống: <b>−{vnd(ctx.systemPenalty)}</b>
              {action === "waiver" && amtNum > 0 && (
                <> → sau gỡ: <b>{previewNet === 0 ? "0đ" : `−${vnd(previewNet!)}`}</b></>
              )}
            </p>
          )}
          <div>
            <label className="text-xs font-semibold block mb-1">Ngày áp dụng</label>
            <DateInput value={date} onChange={setDate} className={inputCls} />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1">Loại điều chỉnh</label>
            <select
              className={inputCls}
              value={action}
              onChange={(e) => setAction(e.target.value as "waiver" | "penalty" | "bonus")}
            >
              <option value="waiver">Gỡ phạt / thưởng bù (+)</option>
              <option value="penalty">Thêm phạt (−)</option>
              <option value="bonus">Thưởng (+)</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1">Số tiền (VND)</label>
            <CurrencyInput value={amount} onChange={(raw) => setAmount(raw)} className={inputCls} placeholder="100000" />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1">
              Lý do <span className="text-red-500">*</span>
            </label>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {QUICK_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className="text-[10px] px-2 py-0.5 rounded bg-muted hover:bg-muted/70"
                >
                  {r}
                </button>
              ))}
            </div>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className={inputCls}
              placeholder="Tối thiểu 5 ký tự…"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Không sửa giờ chấm công gốc. Lịch sử ai sửa được lưu trong hệ thống.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={onClose}>
              Hủy
            </Button>
            <Button
              size="sm"
              disabled={saving || reason.trim().length < 5 || amtNum <= 0 || !date}
              onClick={() =>
                onSave({
                  staffId: ctx.staffId,
                  date,
                  action,
                  amount: amtNum,
                  reason: reason.trim(),
                  systemPenalty: ctx.systemPenalty,
                })
              }
            >
              {saving ? "Đang lưu…" : "Lưu"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MoneyEditPencil({ onClick, title = "Sửa tiền phạt/thưởng" }: { onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex shrink-0 items-center justify-center w-7 h-7 rounded-md border border-border bg-background hover:bg-violet-50 hover:border-violet-300 text-violet-600 ml-1"
    >
      <Pencil className="w-3.5 h-3.5" />
    </button>
  );
}
