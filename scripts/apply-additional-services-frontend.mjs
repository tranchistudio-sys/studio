import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const componentPath = path.join(
  root,
  "artifacts/amazing-studio/src/components/additional-services-section.tsx",
);

const componentSource = `import { useState } from "react";
import { Plus, ChevronDown, ChevronUp, X, Users } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { ServiceSearchBox, type ServiceOption } from "@/components/service-search-box";
import { resolveCastAmount, type CastRatePkg, type StaffRate } from "@/lib/resolve-cast";
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

function genId() {
  return \`as-\${Date.now()}-\${Math.random().toString(36).slice(2, 9)}\`;
}

function calcLineTotal(qty: number, unitPrice: number) {
  return Math.max(0, Math.round(qty * unitPrice));
}

function allocatedTotal(line: AdditionalServiceLine) {
  return (line.staffAssignments || []).reduce((s, st) => s + (st.allocatedQty || 0), 0);
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
    if (qty <= 0) errors.push(\`\${title}: Số lượng phải lớn hơn 0\`);
    const allocated = allocatedTotal(line);
    if (allocated > qty) {
      errors.push(\`\${title}: Vượt quá số lượng đã bán (\${allocated}/\${qty})\`);
    } else if (allocated < qty) {
      warnings.push(\`\${title}: Còn \${qty - allocated} chưa phân công\`);
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

function resolveCastPerUnit(
  staffId: number,
  role: string,
  allCastRates: CastRatePkg[] | undefined,
  allStaffRates: StaffRate[],
) {
  const r = resolveCastAmount(staffId, role, "mac_dinh", null, allCastRates, allStaffRates);
  return r.amount != null ? Math.round(r.amount) : 0;
}

function lineToServiceOption(line: AdditionalServiceLine): ServiceOption | null {
  if (!line.title?.trim() || !line.unitPrice) return null;
  return {
    key: \`snap-\${line.id}\`,
    id: 0,
    name: line.title,
    groupName: "Đã chọn",
    price: line.unitPrice,
  };
}

export default function AdditionalServicesSection({
  lines,
  onChange,
  staffOptions,
  allCastRates,
  allStaffRates,
  formatVND: fmt = formatVND,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
    if (expandedId === id) setExpandedId(null);
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

  const addStaff = (lineId: string, staff: StaffOption) => {
    const line = lines.find(l => l.id === lineId);
    if (!line || !line.title) return;
    if (line.staffAssignments.some(s => s.staffId === staff.id)) return;
    const role = staff.roles?.includes("makeup")
      ? "makeup"
      : staff.roles?.includes("hair")
        ? "hair"
        : (staff.roles?.[0] || "makeup");
    const castPerUnit = resolveCastPerUnit(staff.id, role, allCastRates, allStaffRates);
    const allocatedQty = 1;
    updateLine(lineId, {
      staffAssignments: [
        ...line.staffAssignments,
        {
          staffId: staff.id,
          staffName: staff.name,
          role,
          allocatedQty,
          castPerUnit,
          castAmount: castPerUnit * allocatedQty,
        },
      ],
    });
  };

  const updateStaff = (lineId: string, staffId: number, patch: Partial<AdditionalServiceStaff>) => {
    const line = lines.find(l => l.id === lineId);
    if (!line) return;
    updateLine(lineId, {
      staffAssignments: line.staffAssignments.map(st => {
        if (st.staffId !== staffId) return st;
        const next = { ...st, ...patch };
        if (patch.allocatedQty != null || patch.castPerUnit != null) {
          next.castAmount = Math.round((next.castPerUnit || 0) * (next.allocatedQty || 0));
        }
        return next;
      }),
    });
  };

  const removeStaff = (lineId: string, staffId: number) => {
    const line = lines.find(l => l.id === lineId);
    if (!line) return;
    updateLine(lineId, {
      staffAssignments: line.staffAssignments.filter(s => s.staffId !== staffId),
    });
  };

  return (
    <section className="space-y-2 rounded-xl border border-emerald-200/70 dark:border-emerald-900/40 bg-emerald-50/20 dark:bg-emerald-950/10 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Dịch vụ cộng thêm theo số lượng
        </h4>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={() => onChange([...lines, newAdditionalServiceLine()])}
        >
          <Plus className="w-3 h-3" /> Thêm
        </Button>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Chỉ chọn từ bảng giá. Phụ thu thủ công dùng mục phát sinh riêng.
      </p>

      {!validation.ok && validation.errors[0] && (
        <p className="text-[10px] text-destructive font-medium">{validation.errors[0]}</p>
      )}
      {validation.ok && validation.warnings[0] && (
        <p className="text-[10px] text-amber-600 font-medium">{validation.warnings[0]}</p>
      )}

      {lines.length === 0 ? null : (
        <div className="space-y-2">
          {lines.map(line => {
            const allocated = allocatedTotal(line);
            const isOpen = expandedId === line.id;
            const unitLabel = line.unitLabel || "người";
            const hasService = !!line.title?.trim() && line.unitPrice > 0;
            const statusOk = hasService && allocated === line.qty && line.qty > 0;
            const statusOver = allocated > line.qty;

            return (
              <div key={line.id} className="rounded-lg border border-border/60 bg-background overflow-hidden">
                <div className="p-2.5 space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <ServiceSearchBox
                        value={lineToServiceOption(line)}
                        onChange={svc => selectService(line.id, svc)}
                        placeholder="Chọn dịch vụ từ bảng giá..."
                        allowCustom={false}
                      />
                    </div>
                    <button type="button" onClick={() => removeLine(line.id)} className="p-1.5 text-muted-foreground hover:text-destructive flex-shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {hasService && (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1">
                          <button type="button" className="w-7 h-7 rounded border text-xs" onClick={() => updateLine(line.id, { qty: Math.max(1, line.qty - 1) })}>−</button>
                          <Input className="h-8 w-14 text-center text-xs px-1" value={line.qty} onChange={e => updateLine(line.id, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                          <button type="button" className="w-7 h-7 rounded border text-xs" onClick={() => updateLine(line.id, { qty: line.qty + 1 })}>+</button>
                          <span className="text-[10px] text-muted-foreground">{unitLabel}</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground">× {fmt(line.unitPrice)}</span>
                        <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400 ml-auto">= {fmt(line.totalPrice)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className={\`text-[10px] font-semibold \${statusOver ? "text-destructive" : statusOk ? "text-emerald-600" : "text-amber-600"}\`}>
                          Đã phân công: {line.qty > 0 ? \`\${allocated}/\${line.qty}\` : "—"}
                        </span>
                        <button type="button" className="text-[10px] font-semibold text-primary flex items-center gap-0.5" onClick={() => setExpandedId(isOpen ? null : line.id)}>
                          <Users className="w-3 h-3" /> {isOpen ? "Thu gọn" : "Xem chi tiết"}
                          {isOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {hasService && isOpen && (
                  <div className="border-t border-border/50 p-2.5 space-y-2 bg-muted/20">
                    {line.staffAssignments.map(st => (
                      <div key={st.staffId} className="flex items-center gap-2 flex-wrap text-xs">
                        <span className="font-medium min-w-[5rem] truncate">{st.staffName}</span>
                        <Input className="h-7 w-14 text-center text-xs" value={st.allocatedQty} onChange={e => updateStaff(line.id, st.staffId, { allocatedQty: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
                        <span className="text-[10px] text-muted-foreground">{unitLabel}</span>
                        <span className="text-[10px] text-muted-foreground ml-auto">cast {fmt(st.castAmount)}</span>
                        <button type="button" onClick={() => removeStaff(line.id, st.staffId)} className="p-1 text-muted-foreground hover:text-destructive"><X className="w-3 h-3" /></button>
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-1">
                      {staffOptions.filter(s => !line.staffAssignments.some(st => st.staffId === s.id)).slice(0, 16).map(s => (
                        <button key={s.id} type="button" className="text-[10px] px-2 py-1 rounded-full border hover:bg-muted" onClick={() => addStaff(line.id, s)}>+ {s.name}</button>
                      ))}
                    </div>
                    <Input className="h-8 text-xs" placeholder="Ghi chú (tuỳ chọn)" value={line.notes || ""} onChange={e => updateLine(line.id, { notes: e.target.value })} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
`;

fs.writeFileSync(componentPath, componentSource, "utf8");
console.log("Wrote", componentPath);

const calendarPath = path.join(root, "artifacts/amazing-studio/src/pages/calendar.tsx");
let cal = fs.readFileSync(calendarPath, "utf8");

// Fix broken extrasFormValidation line
cal = cal.replace(
  /const totalAmount = packageTotal \+ extrasTotal;\s*\n\s*const extrasFormValidation = validateAdditionalServicesForm\(subDrafts\.flatMap\(s => s\.additionalServices \|\| \[\]\)\.filter\(l => \(l\.title \|\| ""\)\.trim\(\);\s*\nconst depositNum/,
  `const totalAmount = packageTotal + extrasTotal;
  const extrasFormValidation = validateAdditionalServicesForm(
    subDrafts.flatMap(s => s.additionalServices || []).filter(l => (l.title || "").trim()),
  );
  const depositNum`,
);

// Fix broken total summary div
cal = cal.replace(
  /<div className="flex\s+\{extrasTotal > 0 && \(<><div className="flex justify-between text-sm"><span>Gói chính<\/span><span>\{formatVND\(packageTotal\)\}<\/span><\/div><div className="flex justify-between text-sm"><span>Cộng thêm<\/span><span className="text-primary">\{formatVND\(extrasTotal\)\}<\/span><\/div><\/>\)\}/,
  `{extrasTotal > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Gói chính</span>
                    <span>{formatVND(packageTotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Cộng thêm</span>
                    <span className="text-primary">{formatVND(extrasTotal)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between items-center`,
);

// Remove orphaned JSX at end of file
cal = cal.replace(
  /\}\s*<AdditionalServicesSection[\s\S]*$/,
  `}\n`,
);

// Insert AdditionalServicesSection after OrderLineRow block if not already inside subDrafts map
const sectionSnippet = `
                    <AdditionalServicesSection
                      lines={sub.additionalServices || []}
                      onChange={lines => updateSubDraft(sub.id, { additionalServices: lines })}
                      staffOptions={allStaff.map(s => ({ id: s.id, name: s.name, roles: s.roles || [] }))}
                      allCastRates={allCastRates}
                      allStaffRates={allStaffRates}
                      formatVND={formatVND}
                    />`;

if (!cal.includes("Dịch vụ cộng thêm theo số lượng") || !cal.includes(sectionSnippet.trim().split("\n")[1])) {
  const anchor = `                        {sub.items.map(line => (
                          <OrderLineRow key={line.tempId} line={line} photographers={photographers} makeupArtists={makeupArtists} services={allServices} allStaffRates={allStaffRates} allCastRates={allCastRates} allStaff={allStaff} isAdmin={isAdmin}
                            bookingId={booking?.id ?? null}
                            serviceBookingId={sub.siblingId ?? null}
                            onChange={updated => updateSubDraft(sub.id, { items: sub.items.map(l => l.tempId === line.tempId ? updated : l) })}
                            onRemove={() => updateSubDraft(sub.id, { items: sub.items.filter(l => l.tempId !== line.tempId) })}
                          />
                        ))}`;

  if (cal.includes(anchor) && !cal.includes(sectionSnippet.trim())) {
    cal = cal.replace(anchor, anchor + sectionSnippet);
    console.log("Inserted AdditionalServicesSection in calendar");
  } else {
    console.warn("Could not find anchor for AdditionalServicesSection insert");
  }
}

fs.writeFileSync(calendarPath, cal, "utf8");
console.log("Patched", calendarPath);
