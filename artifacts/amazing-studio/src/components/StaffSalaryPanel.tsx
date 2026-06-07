import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Banknote, TrendingUp, TrendingDown, ChevronDown, Lock,
  Eye, Loader2, AlertCircle, CheckCircle2,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const getAuthHeaders = (): Record<string, string> => {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return token ? { Authorization: `Bearer ${token}` } : {};
};
const fetchJson = (url: string, opts?: RequestInit) =>
  fetch(`${BASE}${url}`, { ...opts, headers: { ...getAuthHeaders(), ...(opts?.headers as Record<string, string> ?? {}) } })
    .then(r => { if (!r.ok) return r.json().then(j => { throw new Error(j.error || "Lỗi"); }); return r.json(); });

const fmtVND = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v);

const vnNow = () => {
  const d = new Date();
  return { month: d.getMonth() + 1, year: d.getFullYear() };
};

export interface SalaryEstimate {
  baseSalary: number;
  daysInMonth: number;
  daysAccrued: number;
  baseSalaryAccrued: number;
  showEarnings: number;
  bonus: number;
  penalty: number;
  leaveDeduction: number;
  advance: number;
  total: number;
  source: "paid_payroll" | "draft_payroll" | "realtime";
  payrollId?: number;
  showItems: Array<{ bookingId: number; shootDate: string; role: string; serviceName: string; rate: number }>;
  overtimePay?: number;
  forecastTotal?: number;
}

interface HistoryRow {
  month: number; year: number; monthLabel: string;
  baseSalary: number; showBonus: number; bonus: number; penalty: number;
  netSalary: number; status: string; payrollId: number | null;
  isLocked: boolean; paidAt: string | null;
}

interface TrendData {
  points: Array<{ month: number; year: number; label: string; total: number; source: string }>;
  currentMonth: number; previousMonth: number; changePct: number;
}

interface Props {
  staffId: number;
  isAdmin: boolean;
  estimate?: SalaryEstimate;
  showCount: number;
  selectedMonth: number;
  selectedYear: number;
  onMonthChange: (month: number, year: number) => void;
  renderEstimateDetail?: React.ReactNode;
}

export function StaffSalaryPanel({
  staffId, isAdmin, estimate, showCount,
  selectedMonth, selectedYear, onMonthChange, renderEstimateDetail,
}: Props) {
  const qc = useQueryClient();
  const now = vnNow();
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);

  const { data: trend, isLoading: trendLoading } = useQuery<TrendData>({
    queryKey: ["salary-trend", staffId],
    queryFn: () => fetchJson(`/api/staff/${staffId}/salary-trend?months=12`),
    enabled: !!staffId,
    staleTime: 60_000,
  });

  const { data: history = [], isLoading: historyLoading } = useQuery<HistoryRow[]>({
    queryKey: ["salary-history", staffId],
    queryFn: () => fetchJson(`/api/staff/${staffId}/salary-history?limit=24`),
    enabled: !!staffId,
    staleTime: 30_000,
  });

  const { data: snapshotData } = useQuery({
    queryKey: ["salary-snapshot", staffId, selectedMonth, selectedYear],
    queryFn: () => fetchJson(`/api/staff/${staffId}/salary-snapshot?month=${selectedMonth}&year=${selectedYear}`),
    enabled: snapshotOpen && estimate?.source === "paid_payroll",
  });

  const finalizePay = useMutation({
    mutationFn: () => fetchJson("/api/payrolls/finalize-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffId, month: selectedMonth, year: selectedYear }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      qc.invalidateQueries({ queryKey: ["salary-history", staffId] });
      qc.invalidateQueries({ queryKey: ["salary-trend", staffId] });
    },
  });

  const years = Array.from({ length: 5 }, (_, i) => now.year - 2 + i);
  const isLocked = estimate?.source === "paid_payroll";
  const statusLabel = isLocked ? "Đã chốt lương" : "Tạm tính";
  const statusCls = isLocked ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700";
  const changePct = trend?.changePct ?? 0;
  const changeUp = changePct >= 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground font-medium">Thu nhập tháng này</p>
          <p className="text-lg font-bold mt-0.5">{fmtVND(trend?.currentMonth ?? estimate?.total ?? 0)}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground font-medium">Tháng trước</p>
          <p className="text-lg font-bold mt-0.5">{fmtVND(trend?.previousMonth ?? 0)}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-[11px] text-muted-foreground font-medium flex items-center gap-1">
            {changeUp ? <TrendingUp className="w-3 h-3 text-emerald-600" /> : <TrendingDown className="w-3 h-3 text-red-500" />}
            So với tháng trước
          </p>
          <p className={cn("text-lg font-bold mt-0.5", changeUp ? "text-emerald-700" : "text-red-600")}>
            {changeUp ? "+" : ""}{changePct}%
          </p>
        </div>
      </div>

      <section className="bg-card border border-border rounded-2xl p-4">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-3">
          Thu nhập 12 tháng gần nhất
        </p>
        {trendLoading ? (
          <div className="h-40 flex items-center justify-center text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Đang tải...
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={trend?.points ?? []} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={48}
                tickFormatter={(v: number) => `${Math.round(v / 1_000_000)}tr`} />
              <Tooltip formatter={(v: number) => fmtVND(v)} labelStyle={{ fontSize: 12 }} />
              <Bar dataKey="total" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Banknote className="w-3.5 h-3.5" /> Lương tháng {String(selectedMonth).padStart(2, "0")}/{selectedYear}
          </p>
          <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", statusCls)}>
            {isLocked && <Lock className="w-2.5 h-2.5 inline mr-0.5" />}{statusLabel}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
          <select className="h-9 rounded-lg border bg-background px-2 text-sm" value={selectedMonth}
            onChange={e => onMonthChange(parseInt(e.target.value), selectedYear)}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
              <option key={m} value={m}>Tháng {String(m).padStart(2, "0")}</option>
            ))}
          </select>
          <select className="h-9 rounded-lg border bg-background px-2 text-sm" value={selectedYear}
            onChange={e => onMonthChange(selectedMonth, parseInt(e.target.value))}>
            {years.map(y => <option key={y} value={y}>Năm {y}</option>)}
          </select>
        </div>

        {estimate ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] text-muted-foreground">Show tham gia</p>
              <p className="font-bold">{showCount}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] text-muted-foreground">Tiền cast</p>
              <p className="font-bold text-emerald-700">{fmtVND(estimate.showEarnings)}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] text-muted-foreground">Lương cứng</p>
              <p className="font-bold">{fmtVND(estimate.baseSalaryAccrued)}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] text-muted-foreground">Thưởng</p>
              <p className="font-bold text-emerald-700">+{fmtVND(estimate.bonus)}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="text-[10px] text-muted-foreground">Phạt</p>
              <p className="font-bold text-red-600">-{fmtVND(estimate.penalty)}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-2.5 col-span-2 sm:col-span-1">
              <p className="text-[10px] text-muted-foreground">Tổng thực nhận</p>
              <p className="font-bold text-primary text-base">{fmtVND(estimate.total)}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">Không có dữ liệu lương</p>
        )}

        {renderEstimateDetail}

        <div className="flex flex-wrap gap-2 pt-1">
          {isLocked && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSnapshotOpen(true)}>
              <Eye className="w-3.5 h-3.5" /> Xem snapshot
            </Button>
          )}
          {isAdmin && !isLocked && estimate && (
            <Button size="sm" className="gap-1.5" disabled={finalizePay.isPending}
              onClick={() => {
                if (!confirm(`Chốt thanh toán lương tháng ${String(selectedMonth).padStart(2,"0")}/${selectedYear}?`)) return;
                finalizePay.mutate();
              }}>
              {finalizePay.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              Đã thanh toán lương
            </Button>
          )}
          {finalizePay.isError && (
            <span className="text-xs text-red-600">{(finalizePay.error as Error).message}</span>
          )}
        </div>
      </section>

      <section className="bg-card border border-border rounded-2xl overflow-hidden">
        <button type="button" className="w-full px-4 py-3 flex items-center justify-between text-left"
          onClick={() => setHistoryOpen(v => !v)}>
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Lịch sử lương</span>
          <ChevronDown className={cn("w-4 h-4 transition-transform", historyOpen && "rotate-180")} />
        </button>
        {historyOpen && (historyLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Đang tải...</div>
        ) : history.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Chưa có lịch sử lương</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-t border-b bg-muted/30 text-muted-foreground">
                  <th className="px-3 py-2 text-left">Tháng</th>
                  <th className="px-3 py-2 text-right">Lương cứng</th>
                  <th className="px-3 py-2 text-right">Tiền show</th>
                  <th className="px-3 py-2 text-right">Thưởng</th>
                  <th className="px-3 py-2 text-right">Phạt</th>
                  <th className="px-3 py-2 text-right">Tổng</th>
                  <th className="px-3 py-2 text-center">TT</th>
                </tr>
              </thead>
              <tbody>
                {history.map(row => (
                  <tr key={`${row.year}-${row.month}`}
                    className={cn("border-b border-border/40 hover:bg-muted/20 cursor-pointer",
                      row.month === selectedMonth && row.year === selectedYear && "bg-primary/5")}
                    onClick={() => onMonthChange(row.month, row.year)}>
                    <td className="px-3 py-2.5 font-medium">{row.monthLabel}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtVND(row.baseSalary)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{fmtVND(row.showBonus)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtVND(row.bonus)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-red-600">{fmtVND(row.penalty)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-bold">{fmtVND(row.netSalary)}</td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-full",
                        row.isLocked ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700")}>
                        {row.isLocked ? "Đã chốt" : "Tạm tính"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <Dialog open={snapshotOpen} onOpenChange={setSnapshotOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Snapshot lương</DialogTitle></DialogHeader>
          {snapshotData?.snapshot ? (
            <div className="space-y-2 text-sm max-h-60 overflow-y-auto">
              {((snapshotData.snapshot as { showItems?: Array<{ serviceName: string; rate: number; shootDate: string }> }).showItems ?? []).map((s, i) => (
                <div key={i} className="flex justify-between text-xs border-b py-1">
                  <span>{s.serviceName}</span><span>{fmtVND(s.rate)}</span>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">Đang tải...</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
