import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { ServiceSearchBox, type ServiceOption } from "@/components/service-search-box";
import {
  assignmentDedupeKey,
  resolveCastAmount,
  type CastRatePkg,
  type StaffRate,
} from "@/lib/resolve-cast";
import { formatVND } from "@/lib/utils";

export type AdditionalServiceStaff = {
  staffId: number;
  staffName: string;
  role: string;
  allocatedQty: number;
  castPerUnit?: number;
  castAmount: number;
};

export type AdditionalServiceLine = {
  id: string;
  title: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  unitLabel?: string;
  notes?: string;
  staffAssignments: AdditionalServiceStaff[];
};

const ROLE_OPTIONS = [
  { value: "photographer", label: "📷 Nhiếp ảnh" },
  { value: "makeup", label: "💄 Makeup" },
  { value: "assistant", label: "🤝 Trợ lý" },
  { value: "videographer", label: "🎬 Quay phim" },
  { value: "assistant_photo", label: "🔧 Thợ phụ" },
  { value: "marketing", label: "📢 Marketing" },
  { value: "sales", label: "💼 Sale" },
  { value: "other", label: "👤 Khác" },
];

function genId() {
  return `as-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function calcLineTotal(qty: number, unitPrice: number) {
  return Math.max(0, Math.round(qty * unitPrice));
}

function allocatedTotal(line: AdditionalServiceLine) {
  return (line.staffAssignments || []).reduce((s, st) => s + (st.allocatedQty || 0), 0);
}

function recalcCast(st: AdditionalServiceStaff): AdditionalServiceStaff {
  const castPerUnit = st.castPerUnit ?? 0;
  const allocatedQty = Math.max(0, Math.round(Number(st.allocatedQty) || 0));
  return {
    ...st,
    allocatedQty,
    castAmount: Math.round(castPerUnit * allocatedQty),
  };
}

function resolveCastPerUnit(
  staffId: number,
  role: string,
  allCastRates: CastRatePkg[] | undefined,
  allStaffRates: StaffRate[],
) {
  const r = resolveCastAmount(staffId, role, "mac_dinh", null, allCastRates, allStaffRates);
  return r.amount != null ? Math.round(r.amount) : 0;
}

export function newAdditionalServiceLine(): AdditionalServiceLine {
  return {
    id: genId(),
    title: "",
    qty: 1,
    unitPrice: 0,
    totalPrice: 0,
    unitLabel: "người",
    notes: "",
    staffAssignments: [],
  };
}

function newStaffRow(): AdditionalServiceStaff {
  return { staffId: 0, staffName: "", role: "", allocatedQty: 1, castPerUnit: 0, castAmount: 0 };
}

export function validateAdditionalServicesForm(lines: AdditionalServiceLine[]): {
  ok: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const active = lines.filter(l => (l.title || "").trim() && l.unitPrice > 0);

  for (const line of active) {
    const title = line.title.trim();
    const qty = Math.round(Number(line.qty) || 0);
    if (qty <= 0) errors.push(`${title}: Số lượng phải lớn hơn 0`);
    const allocated = allocatedTotal(line);
    if (allocated > qty) {
      errors.push(`${title}: Vượt quá số lượng đã bán (${allocated}/${qty})`);
    } else if (allocated < qty) {
      warnings.push(`${title}: Còn ${qty - allocated} chưa phân công`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

type StaffOption = { id: number; name: string; roles?: string[] };

type Props = {
  lines: AdditionalServiceLine[];
  onChange: (lines: AdditionalServiceLine[]) => void;
  staffOptions: StaffOption[];
  allCastRates?: CastRatePkg[];
  allStaffRates: StaffRate[];
  formatVND?: (n: number) => string;
};

function lineToServiceOption(line: AdditionalServiceLine): ServiceOption | null {
  if (!line.title?.trim() || !line.unitPrice) return null;
  return {
    key: `snap-${line.id}`,
    id: 0,
    name: line.title,
    groupName: "Đã chọn",
    price: line.unitPrice,
  };
}

function ExtraStaffEditor({
  line,
  staffOptions,
  allCastRates,
  allStaffRates,
  onChange,
  fmt,
}: {
  line: AdditionalServiceLine;
  staffOptions: StaffOption[];
  allCastRates?: CastRatePkg[];
  allStaffRates: StaffRate[];
  onChange: (staff: AdditionalServiceStaff[]) => void;
  fmt: (n: number) => string;
}) {
  const [dupError, setDupError] = useState<string | null>(null);
  const staff = line.staffAssignments || [];
  const unitLabel = line.unitLabel || "người";

  const updateAt = (idx: number, patch: Partial<AdditionalServiceStaff>) => {
    onChange(staff.map((row, i) => {
      if (i !== idx) return row;
      return recalcCast({ ...row, ...patch });
    }));
  };

  const removeAt = (idx: number) => {
    onChange(staff.filter((_, i) => i !== idx));
    setDupError(null);
  };

  const addRow = () => {
    onChange([...staff, newStaffRow()]);
    setDupError(null);
  };

  const applyCast = (idx: number, staffId: number, staffName: string, role: string) => {
    const castPerUnit = resolveCastPerUnit(staffId, role, allCastRates, allStaffRates);
    const row = staff[idx];
    updateAt(idx, {
      staffId,
      staffName,
      role,
      castPerUnit,
      castAmount: castPerUnit * (row?.allocatedQty || 1),
    });
  };

  const handleStaffChange = (idx: number, staffId: number, role: string) => {
    const staffName = staffOptions.find(s => s.id === staffId)?.name ?? "";
    if (!role) {
      updateAt(idx, { staffId, staffName, role: "", castPerUnit: 0, castAmount: 0 });
      return;
    }
    const dup = staff.some(
      (v, i) => i !== idx && v.staffId === staffId && v.role && assignmentDedupeKey(v.staffId, v.role) === assignmentDedupeKey(staffId, role),
    );
    if (dup) {
      setDupError("Nhân viên này đã được gán cùng vai trò");
      return;
    }
    setDupError(null);
    applyCast(idx, staffId, staffName, role);
  };

  const handleRoleChange = (idx: number, newRole: string) => {
    const row = staff[idx];
    if (!row?.staffId || !newRole) {
      updateAt(idx, { role: newRole, castPerUnit: 0, castAmount: 0 });
      return;
    }
    const dup = staff.some(
      (v, i) => i !== idx && v.staffId === row.staffId && v.role && assignmentDedupeKey(v.staffId, v.role) === assignmentDedupeKey(row.staffId, newRole),
    );
    if (dup) {
      setDupError("Nhân viên này đã được gán cùng vai trò");
      return;
    }
    setDupError(null);
    applyCast(idx, row.staffId, row.staffName, newRole);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          👥 Nhân sự
        </span>
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1 text-[11px] sm:text-xs text-primary hover:text-primary/80 font-semibold transition-colors"
        >
          <Plus className="w-3 h-3 sm:w-3.5 sm:h-3.5" /> Thêm nhân sự
        </button>
      </div>

      {dupError && <p className="text-xs text-destructive font-medium">{dupError}</p>}

      {staff.length === 0 ? (
        <button
          type="button"
          onClick={addRow}
          className="w-full border-2 border-dashed border-border/60 rounded-xl py-2 sm:py-3 text-xs text-muted-foreground hover:border-primary/40 hover:bg-muted/20 transition-all flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Thêm nhân sự cho công việc
        </button>
      ) : (
        <div className="space-y-1 sm:space-y-1.5">
          {staff.map((item, idx) => (
            <div key={`${idx}-${item.staffId}-${item.role}`} className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-4 flex-shrink-0 text-center">{idx + 1}</span>

              <select
                className="flex-1 min-w-[100px] px-2.5 py-2 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
                value={item.role}
                onChange={e => handleRoleChange(idx, e.target.value)}
              >
                <option value="">— Vai trò —</option>
                {ROLE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>

              <select
                className="flex-1 min-w-[100px] px-2.5 py-2 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
                value={item.staffId || ""}
                onChange={e => handleStaffChange(idx, parseInt(e.target.value, 10) || 0, item.role)}
              >
                <option value="">— Nhân sự —</option>
                {staffOptions.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>

              <div className="flex flex-col items-center flex-shrink-0">
                <span className="text-[9px] text-muted-foreground leading-none mb-0.5">SL giao</span>
                <Input
                  className="h-9 w-12 text-center text-sm font-semibold px-1"
                  value={item.allocatedQty}
                  onChange={e => updateAt(idx, { allocatedQty: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                />
                <span className="text-[9px] text-muted-foreground leading-none mt-0.5">{unitLabel}</span>
              </div>

              <div className="flex items-center gap-1 ml-auto flex-shrink-0">
                <span className="text-xs font-semibold text-amber-600 w-24 text-right">
                  {item.castAmount > 0 ? fmt(item.castAmount) : "Chưa có giá"}
                </span>
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  aria-label="Xoá nhân sự"
                  className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors flex-shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdditionalServicesSection({
  lines,
  onChange,
  staffOptions,
  allCastRates,
  allStaffRates,
  formatVND: fmt = formatVND,
}: Props) {
  const validation = validateAdditionalServicesForm(lines);

  const updateLine = (id: string, patch: Partial<AdditionalServiceLine>) => {
    onChange(lines.map(l => {
      if (l.id !== id) return l;
      const next = { ...l, ...patch };
      if (patch.qty != null || patch.unitPrice != null) {
        next.totalPrice = calcLineTotal(next.qty, next.unitPrice);
      }
      return next;
    }));
  };

  const removeLine = (id: string) => {
    onChange(lines.filter(l => l.id !== id));
  };

  const selectService = (lineId: string, svc: ServiceOption | null) => {
    if (!svc) {
      updateLine(lineId, { title: "", unitPrice: 0, totalPrice: 0 });
      return;
    }
    const line = lines.find(l => l.id === lineId);
    if (!line) return;
    const unitPrice = Math.round(svc.price || 0);
    updateLine(lineId, {
      title: svc.name,
      unitPrice,
      totalPrice: calcLineTotal(line.qty, unitPrice),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Dịch vụ cộng thêm theo số lượng
          </h4>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Chỉ chọn từ bảng giá. Phụ thu thủ công dùng mục phát sinh riêng.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1 flex-shrink-0"
          onClick={() => onChange([...lines, newAdditionalServiceLine()])}
        >
          <Plus className="w-3 h-3" /> Thêm
        </Button>
      </div>

      {!validation.ok && validation.errors[0] && (
        <p className="text-[10px] text-destructive font-medium">{validation.errors[0]}</p>
      )}
      {validation.ok && validation.warnings[0] && (
        <p className="text-[10px] text-amber-600 font-medium">{validation.warnings[0]}</p>
      )}

      {lines.length > 0 && (
        <div className="space-y-1.5">
          {lines.map(line => {
            const allocated = allocatedTotal(line);
            const unitLabel = line.unitLabel || "người";
            const hasService = !!line.title?.trim() && line.unitPrice > 0;
            const statusOk = hasService && allocated === line.qty && line.qty > 0;
            const statusOver = allocated > line.qty;

            return (
              <div key={line.id} className="p-2.5 bg-muted/30 rounded-xl border border-border/50 space-y-2">
                <div className="flex gap-1.5 items-start">
                  <div className="flex-1 min-w-0">
                    <label className="text-[10px] text-muted-foreground mb-1 block">Dịch vụ / bảng giá</label>
                    <ServiceSearchBox
                      value={lineToServiceOption(line)}
                      onChange={svc => selectService(line.id, svc)}
                      placeholder="Tìm gói / dịch vụ..."
                      allowCustom={false}
                    />
                  </div>

                  <div className="flex-shrink-0 w-[4.5rem]">
                    <label className="text-[10px] text-muted-foreground mb-1 block text-center">Số lượng</label>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        className="w-6 h-9 rounded-lg border bg-background text-xs font-bold hover:bg-muted"
                        onClick={() => updateLine(line.id, { qty: Math.max(1, line.qty - 1) })}
                      >
                        −
                      </button>
                      <Input
                        className="h-9 w-10 text-center text-sm font-semibold px-0"
                        value={line.qty}
                        onChange={e => updateLine(line.id, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                      />
                      <button
                        type="button"
                        className="w-6 h-9 rounded-lg border bg-background text-xs font-bold hover:bg-muted"
                        onClick={() => updateLine(line.id, { qty: line.qty + 1 })}
                      >
                        +
                      </button>
                    </div>
                    <p className="text-[9px] text-muted-foreground text-center mt-0.5">{unitLabel}</p>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeLine(line.id)}
                    className="p-1.5 mt-5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors flex-shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {hasService && (
                  <>
                    <div className="flex items-center justify-between text-xs px-0.5">
                      <span className="text-muted-foreground">
                        {line.qty} {unitLabel} × {fmt(line.unitPrice)}
                      </span>
                      <span className="font-bold text-primary">{fmt(line.totalPrice)}</span>
                    </div>

                    <span className={`text-[10px] font-semibold block px-0.5 ${statusOver ? "text-destructive" : statusOk ? "text-emerald-600" : "text-amber-600"}`}>
                      Đã phân công: {line.qty > 0 ? `${allocated}/${line.qty}` : "—"}
                    </span>

                    <ExtraStaffEditor
                      line={line}
                      staffOptions={staffOptions}
                      allCastRates={allCastRates}
                      allStaffRates={allStaffRates}
                      fmt={fmt}
                      onChange={staffAssignments => updateLine(line.id, { staffAssignments })}
                    />

                    <Input
                      className="h-8 text-xs"
                      placeholder="Ghi chú (tuỳ chọn)"
                      value={line.notes || ""}
                      onChange={e => updateLine(line.id, { notes: e.target.value })}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
