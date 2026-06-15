import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  assignmentDedupeKey,
  castAmountFromResult,
  logCastResolve,
  resolveCastAmount,
  type CastRatePkg,
  type CastResolveResult,
  type StaffRate,
} from "@/lib/resolve-cast";

const BASE = import.meta.env.BASE_URL;

function authFetch(url: string, opts?: RequestInit) {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return fetch(url, { ...opts, headers: { ...opts?.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}

export type StaffAssignment = {
  id: string;
  staffId: number | null;
  staffName: string;
  role: string;
  castAmount: number;
  castSource?: string;
};

// Re-export for calendar.tsx
export { resolveCastAmount, castAmountFromResult, type CastResolveResult };

export type AllowanceRow = {
  id: number;
  bookingId: number;
  staffId: number;
  staffName: string | null;
  role: string | null;
  serviceBookingId: number | null;
  allowanceType: string;
  amount: number;
  note: string | null;
};

const ALLOWANCE_TYPE_LABELS: Record<string, string> = {
  di_xa: "Đi xa", tang_ca: "Tăng ca", xang_xe: "Xăng xe",
  gui_xe: "Gửi xe", an_uong: "Ăn uống", khac: "Khác",
};
const ALLOWANCE_TYPES = Object.entries(ALLOWANCE_TYPE_LABELS).map(([k, v]) => ({ value: k, label: v }));

function genId() {
  return Math.random().toString(36).slice(2, 9);
}

export function newStaffAssignment(): StaffAssignment {
  return { id: genId(), staffId: null, staffName: "", role: "", castAmount: 0 };
}

function fmtVND(n: number) { return n.toLocaleString("vi-VN") + "đ"; }

interface StaffAssignmentEditorProps {
  value: StaffAssignment[];
  onChange: (items: StaffAssignment[]) => void;
  staffOptions: { id: number; name: string; roles: string[] }[];
  allStaffRates: StaffRate[];
  baseJobType: string;
  /** When set, castAmount prefers staff-cast for this package (Giao việc / booking-level). */
  packageId?: number | null;
  allCastRates?: CastRatePkg[];
  className?: string;
  // Task #487 — allowance integration
  bookingId?: number | null;          // booking id for allowance scope (null = no allowance UI)
  serviceBookingId?: number | null;   // optional child service-booking id; can be null
  allowances?: AllowanceRow[];        // pre-filtered list for this booking (or all rows)
}

export function StaffAssignmentEditor({
  value,
  onChange,
  staffOptions,
  allStaffRates,
  baseJobType,
  packageId = null,
  allCastRates,
  className,
  bookingId = null,
  serviceBookingId = null,
  allowances = [],
}: StaffAssignmentEditorProps) {
  const [dupError, setDupError] = useState<string | null>(null);
  // Re-resolve cast when packageId / baseJobType loads after staff was picked first.
  useEffect(() => {
    if (!value.length) return;
    let changed = false;
    const next = value.map(item => {
      if (!item.staffId || !item.role) return item;
      const result = resolveCastAmount(item.staffId, item.role, baseJobType, packageId, allCastRates, allStaffRates);
      const amt = castAmountFromResult(result);
      if (amt === (item.castAmount ?? 0) && result.source === (item.castSource ?? result.source)) return item;
      changed = true;
      return { ...item, castAmount: amt, castSource: result.source };
    });
    if (changed) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId, baseJobType, allCastRates, allStaffRates]);


  const resolveSeq = useRef(0);

  const applyResolvedCast = (itemId: string, staffId: number, staffName: string, role: string) => {
    const result = resolveCastAmount(staffId, role, baseJobType, packageId, allCastRates, allStaffRates);
    logCastResolve({
      staffId,
      staffName,
      role,
      packageId,
      taskKey: baseJobType,
      result,
    });
    update(itemId, {
      staffId,
      staffName,
      role,
      castAmount: castAmountFromResult(result),
      castSource: result.source,
    });
  };

  const fetchAndApplyCast = async (itemId: string, staffId: number, staffName: string, role: string) => {
    const seq = ++resolveSeq.current;
    update(itemId, { staffId, staffName, role, castAmount: 0, castSource: "pending" });
    const q = new URLSearchParams({ staffId: String(staffId), role });
    if (packageId) q.set("packageId", String(packageId));
    if (baseJobType) q.set("taskKey", baseJobType);
    try {
      const r = await authFetch(`${BASE}api/staff-cast/resolve?${q}`);
      if (seq !== resolveSeq.current) return;
      if (r.ok) {
        const data = await r.json() as { amount: number | null; source: string };
        const result: CastResolveResult = {
          amount: data.amount,
          source: (data.source as CastResolveResult["source"]) || "none",
        };
        logCastResolve({ staffId, staffName, role, packageId, taskKey: baseJobType, result });
        update(itemId, {
          staffId,
          staffName,
          role,
          castAmount: castAmountFromResult(result),
          castSource: result.source,
        });
        return;
      }
    } catch {
      /* fall through to local resolve */
    }
    if (seq !== resolveSeq.current) return;
    applyResolvedCast(itemId, staffId, staffName, role);
  };

  const roleOptions = [
    { value: "photographer", label: "📷 Nhiếp ảnh" },
    { value: "makeup", label: "💄 Makeup" },
    { value: "assistant", label: "🤝 Trợ lý" },
    { value: "videographer", label: "🎬 Quay phim" },
    { value: "assistant_photo", label: "🔧 Thợ phụ" },
    { value: "marketing", label: "📢 Marketing" },
    { value: "sales", label: "💼 Sale" },
    { value: "other", label: "👤 Khác" },
  ];

  const update = (id: string, patch: Partial<StaffAssignment>) => {
    onChange(value.map(item => item.id === id ? { ...item, ...patch } : item));
  };

  const remove = (id: string) => {
    onChange(value.filter(item => item.id !== id));
  };

  const add = () => {
    onChange([...value, newStaffAssignment()]);
  };

  const handleStaffChange = (itemId: string, staffId: number, role: string) => {
    const staffName = staffOptions.find(s => s.id === staffId)?.name ?? "";
    if (!role) {
      update(itemId, { staffId, staffName, castAmount: 0, castSource: "none" });
      return;
    }
    const dup = value.some(
      v => v.id !== itemId && v.staffId === staffId && v.role && assignmentDedupeKey(v.staffId!, v.role) === assignmentDedupeKey(staffId, role),
    );
    if (dup) {
      setDupError("Nhân viên này đã được gán cùng vai trò trong booking");
      return;
    }
    setDupError(null);
    void fetchAndApplyCast(itemId, staffId, staffName, role);
  };

  // ── Allowance integration (Task #487) ────────────────────────────────────
  const qc = useQueryClient();
  const allowanceQKey = bookingId != null ? ["staff-allowances", bookingId] : null;
  // Fetch allowances internally when bookingId is present and parent didn't provide a list.
  const { data: fetchedAllowances = [] } = useQuery<AllowanceRow[]>({
    queryKey: allowanceQKey ?? ["staff-allowances", "noop"],
    queryFn: async () => {
      const r = await authFetch(`${BASE}api/bookings/${bookingId}/staff-allowances`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: bookingId != null && allowances.length === 0,
    staleTime: 30_000,
  });
  const effectiveAllowances = allowances.length > 0 ? allowances : fetchedAllowances;
  const [openAllowanceFor, setOpenAllowanceFor] = useState<string | null>(null);
  const [aType, setAType] = useState("di_xa");
  const [aAmount, setAAmount] = useState("");
  const [aNote, setANote] = useState("");
  const [aError, setAError] = useState<string | null>(null);

  const fmtThousands = (raw: string) => {
    const n = parseFloat(raw.replace(/[^\d]/g, ""));
    return isFinite(n) ? n.toLocaleString("vi-VN") : "";
  };

  const createAllowance = useMutation({
    mutationFn: async (payload: { staffId: number; role: string; amount: number; type: string; note: string | null }) => {
      const r = await authFetch(`${BASE}api/staff-allowances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId,
          staffId: payload.staffId,
          role: payload.role,
          serviceBookingId: serviceBookingId ?? null,
          allowanceType: payload.type,
          amount: payload.amount,
          note: payload.note,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: "Lỗi tạo phụ cấp" }));
        throw new Error(e.error || "Lỗi tạo phụ cấp");
      }
      return r.json();
    },
    onSuccess: () => {
      if (allowanceQKey) qc.invalidateQueries({ queryKey: allowanceQKey });
      setOpenAllowanceFor(null);
      setAType("di_xa"); setAAmount(""); setANote(""); setAError(null);
    },
    onError: (e: Error) => setAError(e.message),
  });

  const removeAllowance = useMutation({
    mutationFn: async (id: number) => {
      const r = await authFetch(`${BASE}api/staff-allowances/${id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 204) throw new Error("Lỗi xoá phụ cấp");
    },
    onSuccess: () => {
      if (allowanceQKey) qc.invalidateQueries({ queryKey: allowanceQKey });
    },
  });

  // Filter allowances for a given staff row: match by staffId + role + serviceBookingId exactly
  function rowAllowances(item: StaffAssignment): AllowanceRow[] {
    if (!item.staffId || !item.role) return [];
    return effectiveAllowances.filter(a => {
      if (a.staffId !== item.staffId) return false;
      if ((a.role ?? "") !== item.role) return false;
      if (a.serviceBookingId !== serviceBookingId) return false;
      return true;
    });
  }

  const openPopupFor = (id: string) => {
    setOpenAllowanceFor(id);
    setAType("di_xa"); setAAmount(""); setANote(""); setAError(null);
  };

  const submitAllowance = (item: StaffAssignment) => {
    if (!item.staffId || !item.role) return;
    // Vi-VN locale uses "." as thousands separator; strip it before parsing
    const amt = parseFloat(aAmount.replace(/\./g, "").replace(/,/g, ""));
    if (!isFinite(amt) || amt <= 0) { setAError("Số tiền phải > 0"); return; }
    createAllowance.mutate({
      staffId: item.staffId,
      role: item.role,
      amount: amt,
      type: aType,
      note: aNote || null,
    });
  };

  return (
    <div className={cn("space-y-1.5 sm:space-y-2", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          👥 Nhân sự
        </span>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 text-[11px] sm:text-xs text-primary hover:text-primary/80 font-semibold transition-colors"
        >
          <Plus className="w-3 h-3 sm:w-3.5 sm:h-3.5" /> Thêm nhân sự
        </button>
      </div>
      {dupError && (
        <p className="text-xs text-destructive font-medium">{dupError}</p>
      )}

      {/* Lines */}
      {value.length === 0 ? (
        <button
          type="button"
          onClick={add}
          className="w-full border-2 border-dashed border-border/60 rounded-xl py-2 sm:py-3 text-xs text-muted-foreground hover:border-primary/40 hover:bg-muted/20 transition-all flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Thêm nhân sự cho công việc
        </button>
      ) : (
        <div className="space-y-1 sm:space-y-1.5">
          {value.map((item, idx) => {
            const myAllowances = rowAllowances(item);
            const allowanceTotal = myAllowances.reduce((s, a) => s + a.amount, 0);
            const totalForRow = (item.castAmount || 0) + allowanceTotal;
            const canAddAllowance = bookingId != null && !!item.staffId && !!item.role;
            const isOpen = openAllowanceFor === item.id;
            return (
              <div key={item.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-4 flex-shrink-0 text-center">{idx + 1}</span>

                  {/* Role */}
                  <select
                    className="flex-1 min-w-[110px] px-2.5 py-2 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
                    value={item.role}
                    onChange={e => {
                      const newRole = e.target.value;
                      if (!item.staffId || !newRole) {
                        update(item.id, { role: newRole, castAmount: 0, castSource: "none" });
                        return;
                      }
                      const dup = value.some(
                        v => v.id !== item.id && v.staffId === item.staffId && v.role && assignmentDedupeKey(v.staffId!, v.role) === assignmentDedupeKey(item.staffId!, newRole),
                      );
                      if (dup) {
                        setDupError("Nhân viên này đã được gán cùng vai trò trong booking");
                        return;
                      }
                      setDupError(null);
                      void fetchAndApplyCast(item.id, item.staffId, item.staffName, newRole);
                    }}
                  >
                    <option value="">— Vai trò —</option>
                    {roleOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>

                  {/* Staff */}
                  <select
                    className="flex-1 min-w-[110px] px-2.5 py-2 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
                    value={item.staffId ?? ""}
                    onChange={e => {
                      const staffId = parseInt(e.target.value);
                      handleStaffChange(item.id, staffId, item.role);
                    }}
                  >
                    <option value="">— Nhân sự —</option>
                    {staffOptions.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>

                  {/* Cost + Allowance "+" + Delete */}
                  <div className="flex items-center gap-1 ml-auto flex-shrink-0">
                    <span className="text-xs font-semibold text-amber-600 w-24 text-right" title={item.castSource === "none" ? "Chưa có giá cast" : item.castSource}>
                      {item.castSource === "pending" ? "…" : item.castAmount > 0 ? fmtVND(item.castAmount) : "Chưa có giá"}
                    </span>
                    {bookingId != null && (
                      <button
                        type="button"
                        onClick={() => isOpen ? setOpenAllowanceFor(null) : openPopupFor(item.id)}
                        disabled={!canAddAllowance}
                        title={canAddAllowance ? "Thêm phụ cấp" : "Chọn vai trò + nhân sự trước"}
                        aria-label="Thêm phụ cấp"
                        className={cn(
                          "p-1 rounded-md transition-colors flex-shrink-0",
                          canAddAllowance
                            ? "text-amber-600 hover:bg-amber-50 hover:text-amber-700"
                            : "text-muted-foreground/40 cursor-not-allowed",
                          isOpen && "bg-amber-100 text-amber-700"
                        )}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(item.id)}
                      aria-label="Xoá nhân sự"
                      className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors flex-shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Allowance sub-lines (hiển thị dưới đúng dòng nhân sự) */}
                {myAllowances.length > 0 && (
                  <div className="ml-6 space-y-0.5">
                    {myAllowances.map(a => (
                      <div
                        key={a.id}
                        className="flex items-center gap-2 text-[11px] text-amber-800 bg-amber-50/60 border border-amber-200/50 rounded-md px-2 py-1"
                      >
                        <span className="font-medium">+ Phụ cấp {ALLOWANCE_TYPE_LABELS[a.allowanceType] || a.allowanceType}:</span>
                        <span className="font-semibold">{fmtVND(a.amount)}</span>
                        {a.note && <span className="text-muted-foreground truncate">— {a.note}</span>}
                        <button
                          type="button"
                          onClick={() => removeAllowance.mutate(a.id)}
                          disabled={removeAllowance.isPending}
                          aria-label="Xoá phụ cấp"
                          className="ml-auto p-0.5 text-amber-600 hover:text-red-500 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    <div className="text-[11px] font-semibold text-amber-900 px-2">
                      = Tổng nhân sự này: {fmtVND(totalForRow)}
                    </div>
                  </div>
                )}

                {/* Popup thêm phụ cấp (mở ngay dưới dòng đang chọn) */}
                {isOpen && canAddAllowance && (
                  <div className="ml-6 border border-amber-200 rounded-lg p-2 space-y-2 bg-amber-50/40">
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        className="h-8 border border-input rounded-lg px-2 text-xs bg-background"
                        value={aType}
                        onChange={e => setAType(e.target.value)}
                      >
                        {ALLOWANCE_TYPES.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="h-8 border border-input rounded-lg px-2 text-xs bg-background"
                        placeholder="Số tiền..."
                        value={aAmount}
                        onChange={e => setAAmount(fmtThousands(e.target.value))}
                      />
                    </div>
                    <input
                      className="w-full h-8 border border-input rounded-lg px-2 text-xs bg-background"
                      placeholder="Ghi chú (không bắt buộc)..."
                      value={aNote}
                      onChange={e => setANote(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => submitAllowance(item)}
                        disabled={createAllowance.isPending || !aAmount}
                        className="flex-1 h-7 text-xs font-semibold rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                      >
                        {createAllowance.isPending ? "Đang lưu..." : "Lưu phụ cấp"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setOpenAllowanceFor(null); setAError(null); }}
                        className="h-7 px-3 text-xs rounded-lg border border-border hover:bg-muted transition-colors"
                      >
                        Huỷ
                      </button>
                    </div>
                    {aError && <p className="text-[11px] text-red-500">{aError}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
