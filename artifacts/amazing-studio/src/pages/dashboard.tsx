import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatVND } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer,
} from "recharts";
import {
  ClipboardList, Wallet, AlertTriangle, TrendingUp,
  CalendarDays, ArrowRight, Receipt, BadgeAlert, Layers,
  Users, Clock, CheckCircle2, AlertCircle, UserX, Calendar,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

// ── Types ─────────────────────────────────────────────────────────────────────
interface DashboardSummary {
  bookedAmount?: number;
  bookedCount?: number;
  collectedAmount?: number;
  collectedCount?: number;
  owedTotal?: number;
  owedCount?: number;
  owedInPeriod?: number;
  profit?: number;
  linkedExpenses?: number;
  generalExpenses?: number;
  totalExpenses?: number;
}

interface OperationalKPIs {
  totalBookings: number;
  unassigned: number;
  understaffed: number;
  upcomingShoot: number;
}

interface ProgressKPIs {
  inProgress: number;
  overdueJobs: number;
  completedJobs: number;
}

interface ChartPoint {
  date: string;
  amount: number;
  count: number;
}

interface ServiceRow {
  category: string;
  serviceKey?: string;
  label: string;
  bookedCount: number;
  bookedAmount: number;
  collectedAmount: number;
  owedAmount: number;
  bookedPercent: number;
  collectedPercent: number;
}

interface DebtRow {
  bookingId: number;
  bookingCode: string;
  customerName: string;
  customerPhone: string;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  shootDate: string;
  status: string;
}

interface UpcomingRow {
  id: number;
  customerName: string;
  customerPhone: string;
  shootDate: string;
  shootTime: string | null;
  packageType: string;
  serviceLabel: string | null;
  status: string;
}

interface DashboardV2 {
  period: { preset?: string; mode?: string; month?: string; from: string; to: string; bookingDateMode?: string };
  summary: DashboardSummary;
  operationalKPIs?: OperationalKPIs;
  progressKPIs?: ProgressKPIs;
  charts?: { booked: ChartPoint[]; collected: ChartPoint[] };
  breakdown: { byService: ServiceRow[]; byCategory: ServiceRow[] };
  debts: { topDebtors: DebtRow[] };
  upcomingBookings: UpcomingRow[];
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const token = () => localStorage.getItem("amazingStudioToken_v2");
const fetchJson = (url: string) => fetch(`${BASE}${url}`, {
  headers: token() ? { Authorization: `Bearer ${token()}` } : {},
}).then(r => r.json());

type Period = "today" | "7days" | "month" | "year";

const PERIOD_TABS: { key: Period; label: string }[] = [
  { key: "today", label: "Hôm nay" },
  { key: "7days", label: "7 ngày" },
  { key: "month", label: "Tháng này" },
  { key: "year", label: "Năm nay" },
];

const STATUS_LABELS: Record<string, string> = {
  pending: "Chờ XN", confirmed: "Đã XN", in_progress: "Đang làm",
  completed: "Hoàn thành", cancelled: "Đã hủy",
};
const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  confirmed: "bg-blue-100 text-blue-700",
  in_progress: "bg-purple-100 text-purple-700",
  completed: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-700",
};

// ── MonthYearPicker ────────────────────────────────────────────────────────────
function MonthYearPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const now = new Date();
  const months: { value: string; label: string }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("vi-VN", { month: "long", year: "numeric" });
    months.push({ value: v, label });
  }
  // Next 2 months
  for (let i = 1; i <= 2; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("vi-VN", { month: "long", year: "numeric" });
    months.push({ value: v, label });
  }
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="border rounded-lg px-2 py-1.5 text-sm bg-background"
    >
      {months.map(m => (
        <option key={m.value} value={m.value}>{m.label}</option>
      ))}
    </select>
  );
}

// ── Helper ────────────────────────────────────────────────────────────────────
function fmtChartLabel(date: string, preset: Period): string {
  if (preset === "year") {
    const m = parseInt(date.split("-")[1]);
    return `T${m}`;
  }
  const [, mm, dd] = date.split("-");
  return `${parseInt(dd)}/${parseInt(mm)}`;
}

function KpiCard({ icon: Icon, label, value, sub, sub2, color, bg }: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
  sub2?: string;
  color: string;
  bg: string;
}) {
  return (
    <div className={`rounded-2xl border bg-gradient-to-br ${bg} p-4 flex flex-col gap-2`}>
      <div className="flex items-start justify-between">
        <p className="text-xs text-muted-foreground font-medium">{label}</p>
        <div className={`p-2 rounded-xl bg-white/60 ${color}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <p className={`text-2xl font-bold tracking-tight ${color}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
      {sub2 && <p className="text-xs font-medium text-muted-foreground border-t pt-1.5 mt-0.5">{sub2}</p>}
    </div>
  );
}

function SmallKpiCard({ icon: Icon, label, value, color, bg, accent }: {
  icon: React.ElementType;
  label: string;
  value: number;
  color: string;
  bg: string;
  accent?: boolean;
}) {
  return (
    <div className={`rounded-xl border ${bg} p-3 flex items-center gap-3 ${accent ? "border-red-200" : ""}`}>
      <div className={`p-2 rounded-lg bg-white/70 ${color}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-xl font-bold ${color}`}>{value}</p>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border bg-muted/30 p-4 animate-pulse">
      <div className="h-3 w-20 bg-muted rounded mb-3" />
      <div className="h-7 w-32 bg-muted rounded mb-2" />
      <div className="h-3 w-24 bg-muted rounded" />
    </div>
  );
}

function SkeletonChart() {
  return (
    <div className="rounded-2xl border bg-card p-5 animate-pulse">
      <div className="h-4 w-40 bg-muted rounded mb-4" />
      <div className="h-40 bg-muted/40 rounded" />
    </div>
  );
}

function ChartBar({ data, color, label, emptyMsg, period }: {
  data: { label: string; amount: number; count: number }[];
  color: string;
  label: string;
  emptyMsg: string;
  period: Period;
}) {
  return (
    <div className="w-full h-64">
      {data.length === 0 ? (
        <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
          {emptyMsg}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} />
            <RTooltip formatter={(value: number) => formatVND(value)} />
            <Bar dataKey="amount" fill={color} radius={[8, 8, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

export function SimpleFinanceSummary() {
  const { data, isLoading } = useQuery<{
    period: { from: string; to: string };
    totalIncome: number;
    totalExpense: number;
    profit: number;
    customerDebt: number;
    directExpense?: number;
    fixedCostMonthly?: number;
    totalSpent?: number;
    realProfit?: number;
    breakeven?: { status: 'over' | 'under'; delta: number };
  }>({
    queryKey: ["dashboard-simple"],
    queryFn: () => fetchJson(`/api/dashboard/simple`),
    staleTime: 30_000,
  });

  const fromLabel = data?.period.from ? new Date(data.period.from).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) : "01/..";
  const toLabel = data?.period.to ? new Date(data.period.to).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) : "..";

  const directExpense = data?.directExpense ?? data?.totalExpense ?? 0;
  const fixedCostMonthly = data?.fixedCostMonthly ?? 0;
  const totalSpent = data?.totalSpent ?? (directExpense + fixedCostMonthly);
  const realProfit = data?.realProfit ?? ((data?.totalIncome ?? 0) - totalSpent);
  const breakevenOver = (data?.breakeven?.status ?? (realProfit >= 0 ? 'over' : 'under')) === 'over';
  const breakevenDelta = data?.breakeven?.delta ?? Math.abs(realProfit);
  const deltaInMillions = (n: number) => {
    const m = n / 1_000_000;
    if (m >= 10) return `${Math.round(m)}tr`;
    return `${(Math.round(m * 10) / 10).toString().replace(/\.0$/, "")}tr`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span className="px-2.5 py-1 rounded-full bg-muted/50 border">Thực tế từ {fromLabel} đến {toLabel}</span>
      </div>
      <div className="grid grid-cols-1 gap-4">
        <div className="rounded-[2rem] border bg-white p-6 sm:p-8 shadow-sm min-h-[140px]">
          <p className="text-xs sm:text-sm font-medium tracking-[0.18em] uppercase text-muted-foreground">Đã thu</p>
          <p className="mt-3 text-4xl sm:text-5xl font-bold text-emerald-700 tabular-nums leading-none">{isLoading ? "…" : formatVND(data?.totalIncome ?? 0)}</p>
        </div>
        <div className="rounded-[2rem] border bg-white p-6 sm:p-8 shadow-sm min-h-[140px]">
          <p className="text-xs sm:text-sm font-medium tracking-[0.18em] uppercase text-muted-foreground">Đã chi</p>
          <p className="mt-3 text-4xl sm:text-5xl font-bold text-rose-700 tabular-nums leading-none">{isLoading ? "…" : formatVND(totalSpent)}</p>
          <p className="mt-2 text-xs sm:text-sm text-muted-foreground">
            Chi trực tiếp: <span className="font-medium text-foreground tabular-nums">{formatVND(directExpense)}</span>
            <span className="mx-2">•</span>
            Chi phí cố định: <span className="font-medium text-foreground tabular-nums">{formatVND(fixedCostMonthly)}</span>
          </p>
        </div>
        <div className={`rounded-[2rem] border p-6 sm:p-8 shadow-sm min-h-[140px] ${realProfit >= 0 ? "bg-sky-50/70" : "bg-rose-50/70"}`}>
          <p className="text-xs sm:text-sm font-medium tracking-[0.18em] uppercase text-muted-foreground">Lợi nhuận thực tế</p>
          <p className={`mt-3 text-4xl sm:text-5xl font-bold tabular-nums leading-none ${realProfit >= 0 ? "text-sky-700" : "text-rose-700"}`}>{isLoading ? "…" : formatVND(realProfit)}</p>
        </div>
        <div className={`rounded-[2rem] border p-6 sm:p-8 shadow-sm min-h-[140px] ${breakevenOver ? "bg-emerald-50/70 border-emerald-200" : "bg-rose-50/70 border-rose-200"}`}>
          <p className="text-xs sm:text-sm font-medium tracking-[0.18em] uppercase text-muted-foreground">Trạng thái hòa vốn</p>
          <p className={`mt-3 text-2xl sm:text-3xl font-bold leading-tight ${breakevenOver ? "text-emerald-700" : "text-rose-700"}`}>
            {isLoading
              ? "…"
              : breakevenOver
                ? `🟢 Đã vượt hòa vốn +${deltaInMillions(breakevenDelta)}`
                : `🔴 Chưa đạt hòa vốn, còn thiếu ${deltaInMillions(breakevenDelta)}`}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [viewMode, setViewMode] = useState<"period" | "month">("period");
  const [period, setPeriod] = useState<Period>("month");
  const [breakdownTab, setBreakdownTab] = useState<"service" | "category">("service");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { effectiveIsAdmin } = useStaffAuth();

  // Default selected month = current month
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [selectedMonth, setSelectedMonth] = useState(defaultMonth);

  const queryUrl = viewMode === "month"
    ? `/api/dashboard/v2?month=${selectedMonth}`
    : `/api/dashboard/v2?period=${period}`;

  const { data, isLoading } = useQuery<DashboardV2>({
    queryKey: ["dashboard-v2", viewMode, viewMode === "month" ? selectedMonth : period],
    queryFn: () => fetchJson(queryUrl),
    staleTime: 30_000,
  });

  const dateLabel = now.toLocaleDateString("vi-VN", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const summary = data?.summary ?? {};
  const charts = data?.charts;
  const breakdown = data?.breakdown;
  const debts = data?.debts;
  const upcoming: UpcomingRow[] = data?.upcomingBookings ?? [];
  const opsKPIs = data?.operationalKPIs;
  const progressKPIs = data?.progressKPIs;

  const bookedChartData = (charts?.booked ?? []).map(d => ({
    label: fmtChartLabel(d.date, period),
    amount: d.amount,
    count: d.count,
  }));
  const collectedChartData = (charts?.collected ?? []).map(d => ({
    label: fmtChartLabel(d.date, period),
    amount: d.amount,
    count: d.count,
  }));

  const activeBreakdown: ServiceRow[] =
    breakdownTab === "service"
      ? (breakdown?.byService ?? [])
      : (breakdown?.byCategory ?? []);

  const topDebtors: DebtRow[] = debts?.topDebtors ?? [];
  const hasFinancialData = effectiveIsAdmin && Object.keys(summary).length > 0;
  const profitPositive = (summary?.profit ?? 0) >= 0;

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Tổng quan tài chính</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Đã thu − (Chi trực tiếp + Chi phí cố định) = Lợi nhuận thực tế</p>
          </div>
        </div>
        <SimpleFinanceSummary />
      </section>
      <details open={detailsOpen} className="rounded-3xl border bg-card">
        <summary
          className="cursor-pointer list-none px-4 py-4 sm:px-5 flex items-center justify-between gap-3"
          onClick={(e) => {
            e.preventDefault();
            setDetailsOpen(v => !v);
          }}
        >
          <div>
            <h1 className="text-2xl font-bold">Chi tiết & báo cáo</h1>
            <p className="text-sm text-muted-foreground mt-0.5 capitalize">{dateLabel}</p>
          </div>
          <span className="text-sm font-medium text-muted-foreground">{detailsOpen ? "Ẩn chi tiết" : "Xem chi tiết"}</span>
        </summary>
        {detailsOpen && (
          <div className="px-4 pb-5 sm:px-5 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex gap-1 bg-muted rounded-xl p-1 self-start">
                <button
                  onClick={() => setViewMode("period")}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    viewMode === "period" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Theo kỳ
                </button>
                <button
                  onClick={() => setViewMode("month")}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    viewMode === "month" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Tháng chụp
                </button>
              </div>
              {viewMode === "period" ? (
                <div className="flex gap-1 bg-muted rounded-xl p-1 self-start">
                  {PERIOD_TABS.map(t => (
                    <button
                      key={t.key}
                      onClick={() => setPeriod(t.key)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                        period === t.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              ) : (
                <MonthYearPicker value={selectedMonth} onChange={setSelectedMonth} />
              )}
            </div>
            {(opsKPIs || isLoading) && (
              <div>
                <h2 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" />
                  Vận hành{viewMode === "month" ? ` · Tháng ${selectedMonth.slice(5, 7)}/${selectedMonth.slice(0, 4)}` : ""}
                </h2>
                {isLoading ? (
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <SmallKpiCard icon={ClipboardList} label="Tổng đơn" value={opsKPIs?.totalBookings ?? 0} color="text-slate-600" bg="from-slate-50 to-card bg-gradient-to-br" />
                    <SmallKpiCard icon={UserX} label="Chưa giao việc" value={opsKPIs?.unassigned ?? 0} color={opsKPIs && opsKPIs.unassigned > 0 ? "text-orange-600" : "text-slate-500"} bg="from-orange-50 to-card bg-gradient-to-br" accent={opsKPIs && opsKPIs.unassigned > 0} />
                    <SmallKpiCard icon={AlertTriangle} label="Thiếu người" value={opsKPIs?.understaffed ?? 0} color={opsKPIs && opsKPIs.understaffed > 0 ? "text-red-600" : "text-slate-500"} bg="from-red-50 to-card bg-gradient-to-br" accent={opsKPIs && opsKPIs.understaffed > 0} />
                    <SmallKpiCard icon={Calendar} label="Sắp chụp (7 ngày)" value={opsKPIs?.upcomingShoot ?? 0} color={opsKPIs && opsKPIs.upcomingShoot > 0 ? "text-blue-600" : "text-slate-500"} bg="from-blue-50 to-card bg-gradient-to-br" />
                  </div>
                )}
              </div>
            )}
            {(progressKPIs || isLoading) && (
              <div>
                <h2 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  Tiến độ hậu kỳ
                </h2>
                {isLoading ? (
                  <div className="grid grid-cols-3 gap-3">
                    {Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)}
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    <SmallKpiCard icon={Clock} label="Đang xử lý" value={progressKPIs?.inProgress ?? 0} color="text-purple-600" bg="from-purple-50 to-card bg-gradient-to-br" />
                    <SmallKpiCard icon={AlertCircle} label="Quá hạn" value={progressKPIs?.overdueJobs ?? 0} color={progressKPIs && progressKPIs.overdueJobs > 0 ? "text-red-600" : "text-slate-500"} bg="from-red-50 to-card bg-gradient-to-br" accent={progressKPIs && progressKPIs.overdueJobs > 0} />
                    <SmallKpiCard icon={CheckCircle2} label="Hoàn thành" value={progressKPIs?.completedJobs ?? 0} color="text-emerald-600" bg="from-emerald-50 to-card bg-gradient-to-br" />
                  </div>
                )}
              </div>
            )}

      {/* ── Financial KPIs (admin only) ──────────────────────── */}
      {effectiveIsAdmin && (
        <>
          <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5 -mb-3">
            <Wallet className="w-3.5 h-3.5" />
            Tài chính
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
            ) : hasFinancialData ? (
              <>
                <KpiCard
                  icon={ClipboardList}
                  label="Đã chốt"
                  value={formatVND(summary?.bookedAmount ?? 0)}
                  sub={`${summary?.bookedCount ?? 0} đơn${viewMode === "month" ? " trong tháng chụp" : " trong kỳ"}`}
                  sub2={viewMode === "period" ? "Theo ngày ký hợp đồng" : "Theo tháng chụp"}
                  color="text-violet-600"
                  bg="from-violet-50 to-card"
                />
                <KpiCard
                  icon={Wallet}
                  label="Đã thu"
                  value={formatVND(summary?.collectedAmount ?? 0)}
                  sub={viewMode === "period" ? `${summary?.collectedCount ?? 0} giao dịch` : "Tổng thanh toán"}
                  sub2={viewMode === "period" ? "Theo ngày nhận tiền thực tế" : "Từ các booking tháng này"}
                  color="text-emerald-600"
                  bg="from-emerald-50 to-card"
                />
                <KpiCard
                  icon={AlertTriangle}
                  label="Còn nợ"
                  value={formatVND(summary?.owedTotal ?? 0)}
                  sub={`${summary?.owedCount ?? 0} booking chưa thanh toán đủ`}
                  sub2={
                    viewMode === "period" && (summary?.owedInPeriod ?? 0) > 0
                      ? `Phát sinh kỳ này: ${formatVND(summary!.owedInPeriod!)}`
                      : undefined
                  }
                  color="text-amber-600"
                  bg="from-amber-50 to-card"
                />
                <KpiCard
                  icon={TrendingUp}
                  label="Lợi nhuận"
                  value={formatVND(summary?.profit ?? 0)}
                  sub={`Sau ${formatVND(summary?.totalExpenses ?? 0)} chi phí`}
                  sub2={profitPositive ? "Đang có lãi" : "Đang lỗ"}
                  color={profitPositive ? "text-blue-600" : "text-red-600"}
                  bg={profitPositive ? "from-blue-50 to-card" : "from-red-50 to-card"}
                />
              </>
            ) : (
              <div className="col-span-2 lg:col-span-4 rounded-2xl border bg-muted/20 p-8 text-center text-muted-foreground text-sm">
                Chưa có dữ liệu tài chính cho kỳ này
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Charts (admin only, period mode) ─────────────────── */}
      {effectiveIsAdmin && viewMode === "period" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {isLoading ? (
            <>
              <SkeletonChart />
              <SkeletonChart />
            </>
          ) : (
            <>
              <div className="bg-card rounded-2xl border p-5">
                <h3 className="font-semibold text-sm mb-1 flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-violet-600" />
                  Doanh số chốt
                  <span className="text-xs font-normal text-muted-foreground ml-1">(theo ngày ký HĐ)</span>
                </h3>
                <p className="text-xs text-muted-foreground mb-4">Tổng giá trị booking tạo mới</p>
                <ChartBar
                  data={bookedChartData}
                  color="#7c3aed"
                  label="Đã chốt"
                  emptyMsg="Không có dữ liệu trong kỳ này"
                  period={period}
                />
              </div>
              <div className="bg-card rounded-2xl border p-5">
                <h3 className="font-semibold text-sm mb-1 flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-emerald-600" />
                  Tiền đã thu
                  <span className="text-xs font-normal text-muted-foreground ml-1">(theo ngày nhận tiền)</span>
                </h3>
                <p className="text-xs text-muted-foreground mb-4">Tổng tiền thực nhận từ khách</p>
                <ChartBar
                  data={collectedChartData}
                  color="#059669"
                  label="Đã thu"
                  emptyMsg="Không có tiền thu trong kỳ này"
                  period={period}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Service Breakdown ─────────────────────────────────── */}
      <div className="bg-card rounded-2xl border overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-semibold flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            Phân tích dịch vụ
            {viewMode === "month" && (
              <span className="text-xs font-normal text-muted-foreground">
                (tháng chụp {selectedMonth.slice(5, 7)}/{selectedMonth.slice(0, 4)})
              </span>
            )}
          </h3>
          <div className="flex gap-1 bg-muted rounded-lg p-0.5">
            {(["service", "category"] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setBreakdownTab(tab)}
                className={`px-3 py-1 rounded text-xs font-medium transition-all ${
                  breakdownTab === tab ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                {tab === "service" ? "Theo dịch vụ" : "Theo nhóm"}
              </button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-8 bg-muted/40 rounded animate-pulse" />
            ))}
          </div>
        ) : activeBreakdown.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            Không có dữ liệu dịch vụ trong kỳ này
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Dịch vụ</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Đơn</th>
                  {effectiveIsAdmin && <>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Đã chốt</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">%</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Đã thu</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">%</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Còn nợ</th>
                  </>}
                </tr>
              </thead>
              <tbody className="divide-y">
                {activeBreakdown.map((row, i) => (
                  <tr key={i} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium truncate max-w-[140px]">{row.label}</div>
                      {breakdownTab === "service" && row.category && (
                        <div className="text-xs text-muted-foreground capitalize">{row.category}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.bookedCount}</td>
                    {effectiveIsAdmin && <>
                      <td className="px-4 py-3 text-right tabular-nums font-medium text-violet-700">
                        {formatVND(row.bookedAmount)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground hidden sm:table-cell text-xs">
                        {row.bookedPercent}%
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium text-emerald-700">
                        {formatVND(row.collectedAmount)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground hidden sm:table-cell text-xs">
                        {row.collectedPercent}%
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium text-amber-700">
                        {row.owedAmount > 0
                          ? formatVND(row.owedAmount)
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                    </>}
                  </tr>
                ))}
              </tbody>
              {effectiveIsAdmin && activeBreakdown.length > 1 && (
                <tfoot>
                  <tr className="border-t bg-muted/20 font-semibold">
                    <td className="px-4 py-2.5 text-sm">Tổng</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-sm">
                      {activeBreakdown.reduce((s, r) => s + r.bookedCount, 0)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-sm text-violet-700">
                      {formatVND(activeBreakdown.reduce((s, r) => s + r.bookedAmount, 0))}
                    </td>
                    <td className="hidden sm:table-cell" />
                    <td className="px-4 py-2.5 text-right tabular-nums text-sm text-emerald-700">
                      {formatVND(activeBreakdown.reduce((s, r) => s + r.collectedAmount, 0))}
                    </td>
                    <td className="hidden sm:table-cell" />
                    <td className="px-4 py-2.5 text-right tabular-nums text-sm text-amber-700">
                      {formatVND(activeBreakdown.reduce((s, r) => s + r.owedAmount, 0))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {/* ── Debt Section (admin only) ─────────────────────────── */}
      {effectiveIsAdmin && (
        <div className="bg-card rounded-2xl border overflow-hidden">
          <div className="p-4 border-b flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2">
              <BadgeAlert className="w-4 h-4 text-amber-500" />
              Công nợ phải thu
              {!isLoading && (summary?.owedTotal ?? 0) > 0 && (
                <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
                  {formatVND(summary!.owedTotal!)}
                </span>
              )}
            </h3>
            <Link href="/bookings" className="text-muted-foreground hover:text-primary">
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-8 bg-muted/40 rounded animate-pulse" />
              ))}
            </div>
          ) : topDebtors.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              Không có công nợ — tuyệt vời!
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Mã HĐ</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Khách</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Tổng HĐ</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Đã trả</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Còn nợ</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">Ngày chụp</th>
                    <th className="text-center px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">TT</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {topDebtors.map(d => (
                    <tr key={d.bookingId} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3">
                        <Link
                          href={`/calendar?id=${d.bookingId}`}
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {d.bookingCode}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-sm">{d.customerName}</div>
                        {d.customerPhone && (
                          <div className="text-xs text-muted-foreground">{d.customerPhone}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums hidden md:table-cell">
                        {formatVND(d.totalAmount)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                        {formatVND(d.paidAmount)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-bold text-red-600">
                        {formatVND(d.remainingAmount)}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground hidden sm:table-cell">
                        {d.shootDate
                          ? new Date(d.shootDate).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-center hidden sm:table-cell">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_COLORS[d.status] ?? "bg-muted text-muted-foreground"}`}>
                          {STATUS_LABELS[d.status] ?? d.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Expense & Profit (admin + period mode) ─────────────── */}
      {effectiveIsAdmin && viewMode === "period" && !isLoading && hasFinancialData && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-card rounded-2xl border p-5">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Receipt className="w-4 h-4 text-muted-foreground" />
              Chi phí trong kỳ
            </h3>
            <div className="space-y-2.5">
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Chi gắn booking</span>
                <span className="font-medium tabular-nums">{formatVND(summary?.linkedExpenses ?? 0)}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Chi tổng quát</span>
                <span className="font-medium tabular-nums">{formatVND(summary?.generalExpenses ?? 0)}</span>
              </div>
              <div className="border-t pt-2.5 flex justify-between items-center">
                <span className="font-semibold">Tổng chi</span>
                <span className="font-bold tabular-nums text-red-600">{formatVND(summary?.totalExpenses ?? 0)}</span>
              </div>
            </div>
          </div>

          <div className={`rounded-2xl border p-5 ${profitPositive ? "bg-emerald-50/60" : "bg-red-50/60"}`}>
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <TrendingUp className={`w-4 h-4 ${profitPositive ? "text-emerald-600" : "text-red-600"}`} />
              Lợi nhuận thực
            </h3>
            <div className="space-y-2.5">
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Đã thu</span>
                <span className="font-medium text-emerald-700 tabular-nums">+{formatVND(summary?.collectedAmount ?? 0)}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Tổng chi</span>
                <span className="font-medium text-red-600 tabular-nums">−{formatVND(summary?.totalExpenses ?? 0)}</span>
              </div>
              <div className="border-t pt-2.5 flex justify-between items-center">
                <span className="font-semibold">Lợi nhuận</span>
                <div className="text-right">
                  <span className={`font-bold text-lg tabular-nums ${profitPositive ? "text-emerald-700" : "text-red-600"}`}>
                    {formatVND(summary?.profit ?? 0)}
                  </span>
                  <div className="text-xs mt-0.5">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${profitPositive ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                      {profitPositive ? "Có lãi" : "Bị lỗ"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Upcoming Bookings (period mode only) ──────────────── */}
      {viewMode === "period" && (
        <div className="bg-card rounded-2xl border overflow-hidden">
          <div className="p-4 border-b flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-primary" />
              Lịch chụp sắp tới
            </h3>
            <Link href="/calendar" className="text-muted-foreground hover:text-primary">
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          <div className="divide-y">
            {upcoming.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-muted-foreground text-sm gap-2">
                <CalendarDays className="w-10 h-10 opacity-20" />
                <p>Không có lịch chụp sắp tới</p>
              </div>
            ) : (
              upcoming.map(b => (
                <div key={b.id} className="px-4 py-3 flex justify-between items-center hover:bg-muted/20 transition-colors">
                  <div>
                    <p className="font-medium text-sm">{b.customerName}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{b.serviceLabel || b.packageType || "—"}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">
                      {b.shootDate
                        ? new Date(b.shootDate).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })
                        : "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">{b.shootTime ?? ""}</p>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="p-3 border-t">
            <Link href="/bookings">
              <Button variant="outline" size="sm" className="w-full">Xem tất cả đơn</Button>
            </Link>
          </div>
        </div>
      )}
          </div>
        )}
      </details>
    </div>
  );
}
