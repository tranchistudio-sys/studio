import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from "recharts";
import {
  TrendingUp, DollarSign, BarChart2,
  Users, Award, Calendar, ArrowUpRight, ArrowDownRight,
  AlertTriangle, FileText, Wallet, CreditCard, Minus,
  Settings, Plus, Trash2, X,
} from "lucide-react";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const vnd = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n);

const vndShort = (n: number | null | undefined) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}tỷ`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}tr`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return v.toLocaleString("vi-VN");
};

const SERVICE_LABELS: Record<string, string> = {
  wedding: "Tiệc cưới",
  tiec: "Tiệc cưới",
  tiec_cuoi: "Tiệc cưới",
  studio: "Studio",
  album_studio: "Studio",
  outdoor: "Ngoại cảnh",
  album_outdoor: "Ngoại cảnh",
  prewedding: "Ngoại cảnh",
  beauty: "Beauty",
  fashion: "Beauty",
  nang_tho: "Nàng thơ",
  family: "Gia đình",
  gia_dinh: "Gia đình",
  video: "Quay phim",
  videography: "Quay phim",
  combo_makeup: "Combo makeup",
  combo_no_makeup: "Combo không makeup",
  event: "Sự kiện",
  other: "Khác",
};

const PIE_COLORS = [
  "#2563eb", "#f59e0b", "#10b981", "#ef4444",
  "#3b82f6", "#ec4899", "#14b8a6", "#f97316",
];

type MonthRow = {
  month: string;
  label: string;
  contractValue: number;
  collected: number;
  remaining: number;
  staffCast: number;
  directExpenses: number;
  operatingExpenses: number;
  depreciation: number;
  interest: number;
  directCost: number;
  grossProfit: number;
  operatingProfit: number;
  netProfit: number;
  totalCost: number;
  realProfit: number;
  bookingCount: number;
};

type MonthlyResponse = {
  months: MonthRow[];
  totals: Omit<MonthRow, "month" | "label">;
  dateFrom: string;
  dateTo: string;
};

type ServiceRow = {
  service: string;
  serviceKey: string;
  count: number;
  contractValue: number;
  collected: number;
  remaining: number;
  staffCast: number;
  directExpenses: number;
  profit: number;
};

type FixedCost = {
  id: number;
  label: string;
  amount: number;
  notes: string | null;
  active: boolean;
};

type SaleRow = {
  staffId: number;
  staffName: string;
  count: number;
  revenue: number;
  profit: number;
  contribution: number;
};

type DailyCashflowDay = {
  date: string;
  label: string;
  collected: number;
  spent: number;
  net: number;
  paymentCount: number;
  expenseCount: number;
};

type DailyCashflowResponse = {
  from: string | null;
  to: string | null;
  month: string | null;
  days: DailyCashflowDay[];
  totals: { collected: number; spent: number; net: number };
  peakDay: { date: string; label: string; collected: number; paymentCount: number } | null;
  peakExpenseDay: { date: string; label: string; spent: number; expenseCount: number } | null;
  topCollectionDays: { date: string; label: string; collected: number; paymentCount: number }[];
};

const MONTH_NAMES = ["Tháng 1","Tháng 2","Tháng 3","Tháng 4","Tháng 5","Tháng 6","Tháng 7","Tháng 8","Tháng 9","Tháng 10","Tháng 11","Tháng 12"];

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number; name: string; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const nameMap: Record<string, string> = {
    collected: "Đã thu",
    contractValue: "Doanh thu hợp đồng",
    realProfit: "Lợi nhuận thực",
    totalCost: "Tổng chi",
    netProfit: "Lợi nhuận ròng",
  };
  return (
    <div className="bg-popover border border-border rounded-xl p-3 shadow-lg text-xs">
      <p className="font-semibold mb-2 text-foreground">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted-foreground">{nameMap[p.name] || p.name}:</span>
          <span className="font-medium text-foreground">{vnd(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

const KPI_ICON = "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100";

function SummaryCard({ label, value, icon: Icon, color, sub, valueClassName, highlight, className }: {
  label: string; value: number; icon: React.ElementType; color?: string; sub?: string;
  valueClassName?: string; highlight?: boolean; className?: string;
}) {
  const iconCls = color ?? KPI_ICON;
  const valueColor = valueClassName ?? "text-foreground";
  return (
    <div className={`rounded-2xl border border-border bg-card p-3 sm:p-4 ${highlight ? "ring-2 ring-foreground/15 border-foreground/20" : ""} ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${iconCls}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground mt-2 leading-tight">{label}</p>
      <p className={`${highlight ? "text-xl sm:text-2xl" : "text-base sm:text-lg"} font-bold mt-0.5 leading-tight truncate ${valueColor}`}>{vnd(value)}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

export default function RevenuePage() {
  const { isAdmin } = useStaffAuth();
  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");

  const isCustomRange = !!(customFrom && customTo);

  const dateRangeError = useMemo(() => {
    if (!isCustomRange) return "";
    if (customTo < customFrom) return "Đến ngày phải lớn hơn hoặc bằng Từ ngày";
    const fromMs = new Date(customFrom).getTime();
    const toMs = new Date(customTo).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return "Ngày không hợp lệ";
    if (toMs - fromMs > 1000 * 60 * 60 * 24 * 366 * 2) return "Khoảng thời gian không được vượt quá 2 năm";
    return "";
  }, [isCustomRange, customFrom, customTo]);

  const isCustomActive = isCustomRange && !dateRangeError;

  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (isCustomActive) {
      p.set("from", customFrom);
      p.set("to", customTo);
    } else {
      const ym = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
      const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
      p.set("from", `${ym}-01`);
      p.set("to", `${ym}-${String(lastDay).padStart(2, "0")}`);
    }
    return p.toString();
  }, [selectedMonth, selectedYear, isCustomActive, customFrom, customTo]);

  const filterKey = isCustomActive
    ? `custom:${customFrom}:${customTo}`
    : `${selectedYear}-${selectedMonth}`;

  const openDatePicker = () => {
    if (customFrom || customTo) return;
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setCustomFrom(fmt(first));
    setCustomTo(fmt(today));
  };

  const resetCustomRange = () => {
    setCustomFrom("");
    setCustomTo("");
  };

  const fmtYmd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const applyPreset = (preset: "last7" | "last30" | "thisQuarter" | "thisYear") => {
    const today = new Date();
    let from: Date;
    let to: Date = today;
    if (preset === "last7") {
      from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    } else if (preset === "last30") {
      from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
    } else if (preset === "thisQuarter") {
      const qStartMonth = Math.floor(today.getMonth() / 3) * 3;
      from = new Date(today.getFullYear(), qStartMonth, 1);
    } else {
      from = new Date(today.getFullYear(), 0, 1);
    }
    setCustomFrom(fmtYmd(from));
    setCustomTo(fmtYmd(to));
  };

  const activePreset = useMemo<"last7" | "last30" | "thisQuarter" | "thisYear" | null>(() => {
    if (!isCustomActive) return null;
    const today = new Date();
    const todayStr = fmtYmd(today);
    if (customTo !== todayStr) return null;
    const last7 = fmtYmd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6));
    if (customFrom === last7) return "last7";
    const last30 = fmtYmd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29));
    if (customFrom === last30) return "last30";
    const qStartMonth = Math.floor(today.getMonth() / 3) * 3;
    const qStart = fmtYmd(new Date(today.getFullYear(), qStartMonth, 1));
    if (customFrom === qStart) return "thisQuarter";
    const yStart = fmtYmd(new Date(today.getFullYear(), 0, 1));
    if (customFrom === yStart) return "thisYear";
    return null;
  }, [isCustomActive, customFrom, customTo]);

  const formatDmy = (s: string) => {
    if (!s) return "";
    const [y, m, d] = s.split("-");
    return `${d}/${m}/${y}`;
  };

  const { data: monthlyData, isLoading: monthlyLoading } = useQuery<MonthlyResponse>({
    queryKey: ["revenue-monthly", filterKey],
    queryFn: () => fetch(`${BASE}/api/revenue/v2/monthly?${queryParams}`).then(r => r.json()),
    refetchInterval: 60000,
    enabled: !isCustomRange || !dateRangeError,
  });

  // ── Doanh thu hôm nay & tuần này (luôn hiển thị, không phụ thuộc filter tháng) ──
  const todayRange = useMemo(() => {
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { from: ymd, to: ymd };
  }, []);
  const weekRange = useMemo(() => {
    const today = new Date();
    const day = today.getDay(); // 0=CN, 1=T2, ... 6=T7
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + mondayOffset);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { from: fmt(monday), to: fmt(sunday) };
  }, []);

  const { data: todayData } = useQuery<MonthlyResponse>({
    queryKey: ["revenue-today", todayRange.from],
    queryFn: () => fetch(`${BASE}/api/revenue/v2/monthly?from=${todayRange.from}&to=${todayRange.to}`).then(r => r.json()),
    refetchInterval: 60000,
  });
  const { data: weekData } = useQuery<MonthlyResponse>({
    queryKey: ["revenue-week", weekRange.from],
    queryFn: () => fetch(`${BASE}/api/revenue/v2/monthly?from=${weekRange.from}&to=${weekRange.to}`).then(r => r.json()),
    refetchInterval: 60000,
  });

  const serviceParams = useMemo(() => {
    if (!monthlyData) return "";
    const p = new URLSearchParams();
    p.set("from", monthlyData.dateFrom);
    p.set("to", monthlyData.dateTo);
    return p.toString();
  }, [monthlyData]);

  const filtersValid = !isCustomRange || !dateRangeError;

  const { data: serviceData = [], isLoading: serviceLoading } = useQuery<ServiceRow[]>({
    queryKey: ["revenue-by-service-v2", filterKey],
    queryFn: () => fetch(`${BASE}/api/revenue/v2/by-service?${serviceParams}`).then(r => r.ok ? r.json() : []).catch(() => []),
    enabled: !!serviceParams && filtersValid,
    refetchInterval: 60000,
  });

  const { data: saleData = [], isLoading: saleLoading } = useQuery<SaleRow[]>({
    queryKey: ["revenue-by-sale", filterKey],
    queryFn: () => fetch(`${BASE}/api/revenue/by-sale?${queryParams}`).then(r => r.ok ? r.json() : []).catch(() => []),
    enabled: filtersValid,
    refetchInterval: 60000,
  });

  // Chi phí cố định
  const queryClient = useQueryClient();
  const [showFixedModal, setShowFixedModal] = useState(false);

  const { data: cashflowData, isLoading: cashflowLoading, isError: cashflowError } = useQuery<DailyCashflowResponse>({
    queryKey: ["revenue-daily-cashflow", "30"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/revenue/v2/daily-cashflow?days=30`);
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    },
    refetchInterval: 60000,
  });

  const cashflowChartData = useMemo(
    () => (cashflowData?.days ?? []).map(d => ({
      ...d,
      spentNeg: -d.spent,
    })),
    [cashflowData],
  );
  const { data: fixedCosts = [] } = useQuery<FixedCost[]>({
    queryKey: ["fixed-costs"],
    queryFn: () => {
      const token = localStorage.getItem("amazingStudioToken_v2");
      return fetch(`${BASE}/api/fixed-costs`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).then(r => r.ok ? r.json() : []).catch(() => []);
    },
  });
  const fixedTotal = useMemo(
    () => fixedCosts.filter(f => f.active).reduce((s, f) => s + (f.amount || 0), 0),
    [fixedCosts],
  );

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
        <TrendingUp className="w-12 h-12 mb-3 opacity-20" />
        <p className="font-medium">Không có quyền truy cập</p>
        <p className="text-sm mt-1">Chức năng này chỉ dành cho quản trị viên</p>
      </div>
    );
  }

  const totals = monthlyData?.totals;
  const months = monthlyData?.months ?? [];

  const serviceSummary = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const s of serviceData) {
      const label = SERVICE_LABELS[s.serviceKey] || s.service;
      const existing = map.get(label);
      if (existing) {
        existing.count += s.count;
      } else {
        map.set(label, { label, count: s.count });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [serviceData]);

  return (
    <div className="min-h-full bg-background">
      <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-border">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Doanh thu & Lợi nhuận</h1>
              <p className="text-xs text-muted-foreground">Thống kê chi tiết: doanh số, thu thực tế, cast, chi phí, lợi nhuận thật</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowFixedModal(true)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-border bg-card hover:bg-muted font-medium"
            title="Khai báo chi phí cố định hàng tháng (mặt bằng, điện, lương cứng, marketing...)"
          >
            <Settings className="w-4 h-4" />
            Chi phí cố định
            {fixedTotal > 0 && (
              <span className="text-[11px] text-muted-foreground">({vndShort(fixedTotal)}/tháng)</span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <select
            value={selectedMonth}
            onChange={e => setSelectedMonth(parseInt(e.target.value))}
            disabled={isCustomActive}
            className="text-sm border border-border rounded-lg px-3 py-1.5 bg-card font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {MONTH_NAMES.map((name, i) => (
              <option key={i + 1} value={i + 1}>{name}</option>
            ))}
          </select>
          <select
            value={selectedYear}
            onChange={e => setSelectedYear(parseInt(e.target.value))}
            disabled={isCustomActive}
            className="text-sm border border-border rounded-lg px-3 py-1.5 bg-card font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {Array.from({ length: 5 }, (_, i) => now.getFullYear() - 2 + i).map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>

          <div className="h-5 w-px bg-border mx-1" />

          <label className="text-xs text-muted-foreground">Từ ngày</label>
          <input
            type="date"
            value={customFrom}
            onClick={openDatePicker}
            onChange={e => setCustomFrom(e.target.value)}
            className="text-sm border border-border rounded-lg px-2 py-1.5 bg-card font-medium"
          />
          <label className="text-xs text-muted-foreground">Đến ngày</label>
          <input
            type="date"
            value={customTo}
            onClick={openDatePicker}
            onChange={e => setCustomTo(e.target.value)}
            className="text-sm border border-border rounded-lg px-2 py-1.5 bg-card font-medium"
          />
          {(customFrom || customTo) && (
            <button
              type="button"
              onClick={resetCustomRange}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-border bg-card hover:bg-muted font-medium"
            >
              Xoá
            </button>
          )}

          <div className="h-5 w-px bg-border mx-1" />

          {([
            { key: "last7", label: "7 ngày qua" },
            { key: "last30", label: "30 ngày qua" },
            { key: "thisQuarter", label: "Quý này" },
            { key: "thisYear", label: "Năm nay" },
          ] as const).map(p => {
            const isActive = activePreset === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p.key)}
                className={`text-xs px-2.5 py-1.5 rounded-lg border font-medium ${
                  isActive
                    ? "bg-blue-600 text-white border-blue-600"
                    : "border-border bg-card hover:bg-muted"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {isCustomActive && (
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Đang xem từ <span className="font-medium text-foreground">{formatDmy(customFrom)}</span> → <span className="font-medium text-foreground">{formatDmy(customTo)}</span>
          </p>
        )}
        {isCustomRange && dateRangeError && (
          <p className="text-[11px] text-foreground mt-1.5">{dateRangeError}</p>
        )}


        {/* Hero: số đầu tiên chủ studio nhìn thấy = tiền đã thu thực tế */}
        {!monthlyLoading && totals && (
          <div className="mt-4 rounded-2xl border-2 border-foreground/10 bg-card p-4 sm:p-5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Tiền đã thu thực tế
              {isCustomActive
                ? ` · ${formatDmy(customFrom)} → ${formatDmy(customTo)}`
                : ` · Tháng ${String(selectedMonth).padStart(2, "0")}/${selectedYear}`}
            </p>
            <p className="text-3xl sm:text-4xl font-bold mt-1 tracking-tight text-foreground">{vnd(totals.collected)}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
              <span>Còn nợ: <strong className="text-foreground">{vnd(totals.remaining)}</strong></span>
              <span>Chi phí: <strong className="text-foreground">{vnd(totals.totalCost)}</strong></span>
              <span>Lợi nhuận thực: <strong className="text-foreground">{vnd(totals.realProfit)}</strong></span>
            </div>
          </div>
        )}

        {/* Ảnh chụp nhanh: Hôm nay + Tuần này */}
        <div className="grid grid-cols-2 gap-2 mt-4">
          <SummaryCard
            label="Thu hôm nay"
            value={todayData?.totals?.collected ?? 0}
            icon={Wallet}
            sub={`${todayData?.totals?.bookingCount ?? 0} đơn · HĐ ${vndShort(todayData?.totals?.contractValue ?? 0)}`}
          />
          <SummaryCard
            label="Thu tuần này"
            value={weekData?.totals?.collected ?? 0}
            icon={Wallet}
            sub={`${weekData?.totals?.bookingCount ?? 0} đơn · HĐ ${vndShort(weekData?.totals?.contractValue ?? 0)}`}
          />
        </div>

        {monthlyLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="rounded-2xl border border-border bg-card p-3 h-20 animate-pulse bg-muted" />
            ))}
          </div>
        ) : totals ? (
          <>
            {/* ── TIỀN THẬT (ưu tiên — tiền đã vào túi thật) ── */}
            <div className="mt-4 rounded-2xl border border-border bg-card p-3 sm:p-4">
              <div className="flex items-baseline justify-between gap-2 mb-3">
                <div>
                  <p className="text-xs font-bold text-foreground uppercase tracking-wide">Tiền thật</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">= Đã thu − Chi phí thực tế</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                <SummaryCard
                  label="Đã thu"
                  value={totals.collected}
                  icon={Wallet}
                  highlight
                  className="order-1"
                  sub="Tiền thực nhận trong kỳ"
                />
                <SummaryCard
                  label="Còn nợ"
                  value={totals.remaining}
                  icon={CreditCard}
                  className="order-2"
                  sub="Chưa thu từ khách"
                />
                <SummaryCard
                  label="Lợi nhuận thực"
                  value={totals.realProfit}
                  icon={DollarSign}
                  className="order-3"
                  sub="= Đã thu − Chi phí thực tế"
                />
                <SummaryCard
                  label="Chi phí"
                  value={totals.totalCost}
                  icon={Minus}
                  className="order-4 hidden sm:block"
                  sub="Chi phí thực tế đã phát sinh"
                />
              </div>
            </div>

            {/* ── TIỀN KỲ VỌNG (hợp đồng — chưa chắc đã thu đủ) ── */}
            <div className="mt-3 rounded-2xl border border-border bg-muted/20 dark:bg-muted/10 p-3 sm:p-4">
              <div className="mb-3">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Tiền kỳ vọng</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">= Doanh thu hợp đồng − Chi phí dự kiến</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-2">
                <SummaryCard
                  label="Doanh thu hợp đồng"
                  value={totals.contractValue}
                  icon={FileText}
                  sub={`${totals.bookingCount} đơn chốt trong kỳ`}
                />
                <SummaryCard
                  label="Chi phí dự kiến"
                  value={totals.totalCost}
                  icon={AlertTriangle}
                  sub="Cast + CP trực tiếp + vận hành + khấu hao + lãi"
                />
                <SummaryCard
                  label="Lợi nhuận kỳ vọng"
                  value={totals.netProfit}
                  icon={TrendingUp}
                  className="col-span-2 sm:col-span-1"
                  sub="= Doanh thu HĐ − Chi phí dự kiến"
                />
              </div>
              {/* Chi tiết chi phí dự kiến */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-border/60">
                <SummaryCard label="Cast nhân viên" value={totals.staffCast} icon={Users}
                  sub="Tính vào CP trực tiếp" />
                <SummaryCard label="CP trực tiếp" value={totals.directCost} icon={Minus}
                  sub="Chi gắn show + cast NV" />
                <SummaryCard label="CP vận hành" value={totals.operatingExpenses} icon={AlertTriangle}
                  sub="Mặt bằng, lương cố định…" />
                <SummaryCard label="Khấu hao + Lãi vay" value={totals.depreciation + totals.interest} icon={ArrowDownRight}
                  sub={`KH ${vndShort(totals.depreciation)} · Lãi ${vndShort(totals.interest)}`} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
                <SummaryCard label="Lợi nhuận gộp" value={totals.grossProfit} icon={DollarSign}
                  sub="= Doanh thu HĐ − CP trực tiếp" />
                <SummaryCard label="Lợi nhuận hoạt động" value={totals.operatingProfit} icon={DollarSign}
                  sub="= Gộp − CP vận hành" />
                <SummaryCard label="Lợi nhuận ròng" value={totals.netProfit} icon={DollarSign}
                  sub="= Hoạt động − Khấu hao − Lãi vay" />
              </div>
            </div>

            {serviceSummary.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-3">
                <span className="text-[11px] font-semibold text-muted-foreground mr-1">Phân loại đơn:</span>
                {serviceSummary.map((s, i) => (
                  <span key={s.label} className="inline-flex items-center gap-1 text-[11px] bg-muted rounded-full px-2.5 py-0.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="font-medium">{s.label}</span>
                    <span className="text-muted-foreground">({s.count})</span>
                  </span>
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>

      <div className="p-4 sm:p-6 space-y-6">

        {/* Biểu đồ 30 ngày — mỗi cột = 1 ngày */}
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="mb-4">
            <h2 className="font-bold text-base flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-foreground" />
              Biểu đồ 30 ngày
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              30 cột = 30 ngày gần nhất · Đen = tiền thu vào · Xám = tiền chi ra
            </p>
          </div>

          {cashflowLoading ? (
            <div className="h-48 animate-pulse bg-muted rounded-xl" />
          ) : cashflowError ? (
            <p className="text-sm text-muted-foreground text-center py-8">Không tải được dữ liệu dòng tiền — thử tải lại trang</p>
          ) : cashflowData?.days ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Tổng thu</p>
                  <p className="text-lg font-bold text-foreground">{vnd(cashflowData.totals.collected)}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Tổng chi</p>
                  <p className="text-lg font-bold text-foreground">{vnd(cashflowData.totals.spent)}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Tăng/giảm ròng</p>
                  <p className="text-lg font-bold text-foreground">{vnd(cashflowData.totals.net)}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Ngày thu cao nhất</p>
                  <p className="text-lg font-bold text-foreground">
                    {cashflowData.peakDay
                      ? `${cashflowData.peakDay.label} · ${vndShort(cashflowData.peakDay.collected)}`
                      : "—"}
                  </p>
                  {cashflowData.peakDay && (
                    <p className="text-[10px] text-muted-foreground">{cashflowData.peakDay.paymentCount} phiếu thu</p>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto -mx-1 px-1 mb-4">
                <div style={{ minWidth: Math.max(cashflowChartData.length * 28, 320), height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={cashflowChartData} margin={{ top: 8, right: 8, left: 0, bottom: 4 }} barCategoryGap="20%" barGap={2}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                        axisLine={false}
                        tickLine={false}
                        interval={0}
                        angle={-45}
                        textAnchor="end"
                        height={52}
                      />
                      <YAxis tickFormatter={vndShort} tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={52} />
                      <Tooltip
                        formatter={(value: number, name: string) => [vnd(Math.abs(value)), name === "collected" ? "Thu vào" : "Chi ra"]}
                        labelFormatter={(_, payload) => {
                          const row = payload?.[0]?.payload as DailyCashflowDay | undefined;
                          return row ? `Ngày ${row.label}` : "";
                        }}
                      />
                      <Legend formatter={(v) => (v === "collected" ? "Thu vào" : "Chi ra")} iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="collected" name="collected" fill="#171717" radius={[2, 2, 0, 0]} maxBarSize={18} />
                      <Bar dataKey="spent" name="spent" fill="#a3a3a3" radius={[2, 2, 0, 0]} maxBarSize={18} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {cashflowData.topCollectionDays.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Top ngày thu nhiều nhất</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 font-semibold text-muted-foreground">#</th>
                          <th className="text-left py-2 font-semibold text-muted-foreground">Ngày</th>
                          <th className="text-right py-2 font-semibold text-muted-foreground">Thu vào</th>
                          <th className="text-right py-2 font-semibold text-muted-foreground">Phiếu thu</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {cashflowData.topCollectionDays.map((row, i) => (
                          <tr key={row.date} className={cashflowData.peakDay?.date === row.date ? "bg-muted/40" : ""}>
                            <td className="py-2 text-muted-foreground">{i + 1}</td>
                            <td className="py-2 font-medium">{row.label}{cashflowData.peakDay?.date === row.date ? " ★" : ""}</td>
                            <td className="py-2 text-right font-bold">{vnd(row.collected)}</td>
                            <td className="py-2 text-right text-muted-foreground">{row.paymentCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">Chưa có dữ liệu dòng tiền</p>
          )}
        </div>


        {months.length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <h2 className="font-bold text-base flex items-center gap-2 mb-4">
              <Calendar className="w-4 h-4 text-foreground" />
              Chi tiết theo tháng
            </h2>
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full text-xs min-w-[900px]">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-muted-foreground font-semibold pb-2 pl-4 sm:pl-2">Tháng</th>
                    <th className="text-right text-muted-foreground font-semibold pb-2">Đơn</th>
                    <th className="text-right text-foreground font-semibold pb-2">Đã thu</th>
                    <th className="text-right text-foreground font-semibold pb-2">Còn nợ</th>
                    <th className="text-right text-foreground font-semibold pb-2">LN thực</th>
                    <th className="text-right text-muted-foreground font-semibold pb-2">Doanh thu HĐ</th>
                    <th className="text-right text-muted-foreground font-semibold pb-2">CP trực tiếp</th>
                    <th className="text-right text-muted-foreground font-semibold pb-2">CP vận hành</th>
                    <th className="text-right text-muted-foreground font-semibold pb-2">Khấu hao</th>
                    <th className="text-right text-muted-foreground font-semibold pb-2">Lãi vay</th>
                    <th className="text-right text-muted-foreground font-semibold pb-2">LN gộp</th>
                    <th className="text-right text-muted-foreground font-semibold pb-2 pr-4 sm:pr-2">LN ròng</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {months.map(row => (
                    <tr key={row.month} className="hover:bg-muted/30 transition-colors">
                      <td className="py-2.5 pl-4 sm:pl-2 font-medium text-foreground">{row.label}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{row.bookingCount}</td>
                      <td className="py-2.5 text-right font-bold text-foreground">{vndShort(row.collected)}</td>
                      <td className="py-2.5 text-right font-medium text-foreground">{vndShort(row.remaining)}</td>
                      <td className={`py-2.5 text-right font-semibold ${row.realProfit >= 0 ? "text-emerald-800" : "text-foreground"}`}>{vndShort(row.realProfit)}</td>
                      <td className="py-2.5 text-right font-medium text-muted-foreground">{vndShort(row.contractValue)}</td>
                      <td className="py-2.5 text-right text-foreground">{vndShort(row.directCost)}</td>
                      <td className="py-2.5 text-right text-foreground">{vndShort(row.operatingExpenses)}</td>
                      <td className="py-2.5 text-right text-foreground">{vndShort(row.depreciation)}</td>
                      <td className="py-2.5 text-right text-foreground">{vndShort(row.interest)}</td>
                      <td className={`py-2.5 text-right font-semibold ${row.grossProfit >= 0 ? "text-foreground" : "text-foreground"}`}>
                        {vndShort(row.grossProfit)}
                      </td>
                      <td className={`py-2.5 text-right pr-4 sm:pr-2 font-bold ${row.netProfit >= 0 ? "text-foreground" : "text-foreground"}`}>
                        {vndShort(row.netProfit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t-2 border-foreground/20 bg-muted/30">
                      <td className="py-2.5 pl-4 sm:pl-2 font-bold text-foreground">Tổng cộng</td>
                      <td className="py-2.5 text-right font-bold">{totals.bookingCount}</td>
                      <td className="py-2.5 text-right font-bold text-foreground">{vndShort(totals.collected)}</td>
                      <td className="py-2.5 text-right font-bold text-foreground">{vndShort(totals.remaining)}</td>
                      <td className={`py-2.5 text-right font-bold ${totals.realProfit >= 0 ? "text-emerald-800" : "text-foreground"}`}>{vndShort(totals.realProfit)}</td>
                      <td className="py-2.5 text-right font-bold text-muted-foreground">{vndShort(totals.contractValue)}</td>
                      <td className="py-2.5 text-right font-bold text-foreground">{vndShort(totals.directCost)}</td>
                      <td className="py-2.5 text-right font-bold text-rose-500">{vndShort(totals.operatingExpenses)}</td>
                      <td className="py-2.5 text-right font-bold text-violet-500">{vndShort(totals.depreciation)}</td>
                      <td className="py-2.5 text-right font-bold text-fuchsia-500">{vndShort(totals.interest)}</td>
                      <td className={`py-2.5 text-right font-bold ${totals.grossProfit >= 0 ? "text-foreground" : "text-foreground"}`}>
                        {vndShort(totals.grossProfit)}
                      </td>
                      <td className={`py-2.5 text-right pr-4 sm:pr-2 font-bold ${totals.netProfit >= 0 ? "text-foreground" : "text-foreground"}`}>
                        {vndShort(totals.netProfit)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <h2 className="font-bold text-base flex items-center gap-2 mb-4">
              <Award className="w-4 h-4 text-amber-500" />
              Phân loại đơn theo dịch vụ
            </h2>
            {serviceLoading ? (
              <div className="h-56 animate-pulse bg-muted rounded-xl" />
            ) : serviceData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground text-sm">
                <BarChart2 className="w-8 h-8 mb-2 opacity-20" />
                Chưa có dữ liệu
              </div>
            ) : (
              <>
                <div className="w-full h-48 mb-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={serviceData}
                        dataKey="count"
                        nameKey="service"
                        cx="50%" cy="50%"
                        innerRadius="40%" outerRadius="70%"
                        labelLine={false}
                        label={({ cx, cy, midAngle, innerRadius, outerRadius, percent }) => {
                          if (percent < 0.05) return null;
                          const RADIAN = Math.PI / 180;
                          const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
                          const x = cx + radius * Math.cos(-midAngle * RADIAN);
                          const y = cy + radius * Math.sin(-midAngle * RADIAN);
                          return <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight="600">{Math.round(percent * 100)}%</text>;
                        }}
                      >
                        {serviceData.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(val: number, _name: string, entry: { payload?: ServiceRow }) =>
                        [`${val} đơn (${vnd(entry.payload?.contractValue ?? 0)})`, ""]
                      } />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto -mx-4 sm:mx-0">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left text-muted-foreground font-semibold pb-2 pl-4 sm:pl-0">Dịch vụ</th>
                        <th className="text-right text-muted-foreground font-semibold pb-2">Đơn</th>
                        <th className="text-right text-muted-foreground font-semibold pb-2">Doanh số</th>
                        <th className="text-right text-muted-foreground font-semibold pb-2">Cast</th>
                        <th className="text-right text-muted-foreground font-semibold pb-2 pr-4 sm:pr-0">Lợi nhuận</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {serviceData.map((row, i) => (
                        <tr key={row.serviceKey} className="hover:bg-muted/30 transition-colors">
                          <td className="py-2 pl-4 sm:pl-0">
                            <div className="flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                              <span className="font-medium text-foreground">{row.service}</span>
                            </div>
                          </td>
                          <td className="py-2 text-right text-muted-foreground">{row.count}</td>
                          <td className="py-2 text-right font-medium text-foreground">{vndShort(row.contractValue)}</td>
                          <td className="py-2 text-right text-orange-600">{vndShort(row.staffCast)}</td>
                          <td className={`py-2 text-right pr-4 sm:pr-0 font-medium ${row.profit >= 0 ? "text-foreground" : "text-foreground"}`}>
                            {vndShort(row.profit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-border">
                        <td className="py-2 pl-4 sm:pl-0 font-bold text-foreground">Tổng cộng</td>
                        <td className="py-2 text-right font-bold">{serviceData.reduce((s, r) => s + r.count, 0)}</td>
                        <td className="py-2 text-right font-bold text-foreground">{vndShort(serviceData.reduce((s, r) => s + r.contractValue, 0))}</td>
                        <td className="py-2 text-right font-bold text-orange-600">{vndShort(serviceData.reduce((s, r) => s + r.staffCast, 0))}</td>
                        <td className={`py-2 text-right pr-4 sm:pr-0 font-bold ${serviceData.reduce((s, r) => s + r.profit, 0) >= 0 ? "text-foreground" : "text-foreground"}`}>
                          {vndShort(serviceData.reduce((s, r) => s + r.profit, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <h2 className="font-bold text-base flex items-center gap-2 mb-4">
              <Users className="w-4 h-4 text-blue-500" />
              Bảng xếp hạng Sale
            </h2>
            {saleLoading ? (
              <div className="space-y-2">
                {[...Array(4)].map((_, i) => <div key={i} className="h-10 animate-pulse bg-muted rounded-xl" />)}
              </div>
            ) : saleData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground text-sm">
                <Users className="w-8 h-8 mb-2 opacity-20" />
                Chưa có dữ liệu
              </div>
            ) : (
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-muted-foreground font-semibold pb-2 pl-4 sm:pl-0">#</th>
                      <th className="text-left text-muted-foreground font-semibold pb-2">Sale</th>
                      <th className="text-right text-muted-foreground font-semibold pb-2">Đơn</th>
                      <th className="text-right text-muted-foreground font-semibold pb-2">Doanh thu</th>
                      <th className="text-right text-muted-foreground font-semibold pb-2">Lợi nhuận</th>
                      <th className="text-right text-muted-foreground font-semibold pb-2 pr-4 sm:pr-0">%</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {saleData.map((row, i) => (
                      <tr key={row.staffId} className="hover:bg-muted/30 transition-colors">
                        <td className="py-2.5 pl-4 sm:pl-0">
                          {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : <span className="text-muted-foreground">{i + 1}</span>}
                        </td>
                        <td className="py-2.5 font-medium text-foreground">{row.staffName}</td>
                        <td className="py-2.5 text-right text-muted-foreground">{row.count}</td>
                        <td className="py-2.5 text-right font-medium text-foreground">{vndShort(row.revenue)}</td>
                        <td className={`py-2.5 text-right font-medium ${row.profit >= 0 ? "text-foreground" : "text-foreground"}`}>
                          {vndShort(row.profit)}
                        </td>
                        <td className="py-2.5 text-right pr-4 sm:pr-0">
                          <div className="flex items-center justify-end gap-1.5">
                            <div className="w-12 bg-muted rounded-full h-1.5 overflow-hidden hidden sm:block">
                              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(100, row.contribution)}%` }} />
                            </div>
                            <span className="font-bold text-foreground">{row.contribution}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {showFixedModal && (
        <FixedCostsModal
          items={fixedCosts}
          onClose={() => setShowFixedModal(false)}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ["fixed-costs"] });
            queryClient.invalidateQueries({ queryKey: ["revenue-monthly"] });
            queryClient.invalidateQueries({ queryKey: ["revenue-by-service-v2"] });
            queryClient.invalidateQueries({ queryKey: ["revenue-by-sale"] });
            queryClient.invalidateQueries({ queryKey: ["revenue-today"] });
            queryClient.invalidateQueries({ queryKey: ["revenue-week"] });
          }}
        />
      )}
    </div>
  );
}

function EditableAmount({ value, onCommit, format, parse }: {
  value: number;
  onCommit: (v: number) => void;
  format: (s: string) => string;
  parse: (s: string) => number;
}) {
  const [text, setText] = useState(format(String(value || 0)));
  useEffect(() => { setText(format(String(value || 0))); }, [value, format]);
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={e => setText(format(e.target.value))}
      onBlur={() => {
        const v = parse(text);
        if (Number.isFinite(v) && v >= 0) onCommit(v);
        else setText(format(String(value || 0)));
      }}
      className="w-32 text-sm bg-transparent border border-transparent hover:border-border focus:border-border rounded px-2 py-1 text-right font-medium"
    />
  );
}

function FixedCostsModal({ items, onClose, onChanged }: {
  items: FixedCost[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newLabel, setNewLabel] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const total = items.filter(f => f.active).reduce((s, f) => s + (f.amount || 0), 0);

  // Format số với dấu chấm ngăn cách hàng nghìn khi user gõ (vd: 500000 → "500.000")
  const formatAmountInput = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (!digits) return "";
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  };
  const parseAmountInput = (s: string) => {
    const n = parseFloat(s.replace(/\D/g, ""));
    return Number.isFinite(n) ? n : NaN;
  };

  async function add() {
    setError("");
    const amt = parseAmountInput(newAmount);
    if (!newLabel.trim()) return setError("Nhập tên khoản chi");
    if (!Number.isFinite(amt) || amt < 0) return setError("Số tiền không hợp lệ");
    setSaving(true);
    try {
      const token = localStorage.getItem("amazingStudioToken_v2");
      const r = await fetch(`${BASE}/api/fixed-costs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ label: newLabel.trim(), amount: amt }),
      });
      if (!r.ok) throw new Error(await r.text());
      setNewLabel("");
      setNewAmount("");
      onChanged();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  }

  async function update(id: number, patch: Partial<FixedCost>) {
    const token = localStorage.getItem("amazingStudioToken_v2");
    await fetch(`${BASE}/api/fixed-costs/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(patch),
    });
    onChanged();
  }

  async function remove(id: number) {
    if (!confirm("Xoá khoản chi cố định này?")) return;
    const token = localStorage.getItem("amazingStudioToken_v2");
    await fetch(`${BASE}/api/fixed-costs/${id}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="font-bold text-base">Chi phí cố định hàng tháng</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Mỗi khoản sẽ được cộng vào "Chi phí vận hành" của từng tháng để tính lợi nhuận thật
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 border-b border-border bg-muted/30">
          <div className="grid grid-cols-12 gap-2">
            <input
              type="text"
              placeholder="Tên khoản (vd: Mặt bằng, Lương cứng A, Internet...)"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              className="col-span-7 text-sm border border-border rounded-lg px-3 py-2 bg-card"
              onKeyDown={e => { if (e.key === "Enter") add(); }}
            />
            <input
              type="text"
              inputMode="numeric"
              placeholder="Số tiền/tháng"
              value={newAmount}
              onChange={e => setNewAmount(formatAmountInput(e.target.value))}
              className="col-span-3 text-sm border border-border rounded-lg px-3 py-2 bg-card text-right"
              onKeyDown={e => { if (e.key === "Enter") add(); }}
            />
            <button
              type="button"
              onClick={add}
              disabled={saving}
              className="col-span-2 inline-flex items-center justify-center gap-1 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-60"
            >
              <Plus className="w-4 h-4" /> Thêm
            </button>
          </div>
          {error && <p className="text-[11px] text-foreground mt-2">{error}</p>}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {items.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-10">
              Chưa khai báo khoản chi cố định nào.<br />
              <span className="text-xs">Ví dụ: Mặt bằng 10tr, Tiền điện 3tr, Lương cứng nhân viên A 8tr…</span>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {items.map(it => (
                <div key={it.id} className="flex items-center gap-2 py-2.5">
                  <input
                    type="checkbox"
                    checked={it.active}
                    onChange={e => update(it.id, { active: e.target.checked })}
                    title={it.active ? "Đang tính vào chi phí" : "Tạm tắt"}
                    className="w-4 h-4"
                  />
                  <input
                    type="text"
                    defaultValue={it.label}
                    onBlur={e => { if (e.target.value.trim() && e.target.value !== it.label) update(it.id, { label: e.target.value.trim() }); }}
                    className={`flex-1 text-sm bg-transparent border border-transparent hover:border-border focus:border-border rounded px-2 py-1 ${!it.active ? "line-through text-muted-foreground" : ""}`}
                  />
                  <EditableAmount
                    value={it.amount}
                    onCommit={(v) => { if (v !== it.amount) update(it.id, { amount: v }); }}
                    format={formatAmountInput}
                    parse={parseAmountInput}
                  />
                  <span className="text-xs text-muted-foreground w-6">đ</span>
                  <button
                    type="button"
                    onClick={() => remove(it.id)}
                    className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-foreground"
                    title="Xoá"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border bg-muted/30 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Tổng đang tính: <span className="font-bold text-foreground">{vnd(total)}</span> / tháng
          </span>
          <button
            onClick={onClose}
            className="text-sm px-4 py-1.5 rounded-lg bg-foreground text-background font-medium"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
