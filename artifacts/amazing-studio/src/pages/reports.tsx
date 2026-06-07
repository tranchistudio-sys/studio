import { useQuery } from "@tanstack/react-query";
import { formatVND, formatDate } from "@/lib/utils";
import { TrendingUp, TrendingDown, DollarSign, Users, Camera, Target, Award, BarChart3 } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell, Legend
} from "recharts";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const getAuthHeaders = (): Record<string, string> => {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return token ? { Authorization: `Bearer ${token}` } : {};
};
const fetchArray = (url: string) => fetch(`${BASE}${url}`, { headers: getAuthHeaders() }).then(r => r.ok ? r.json() : []).catch(() => []).then((d: unknown) => Array.isArray(d) ? d : []);
const fetchObject = (url: string) => fetch(`${BASE}${url}`, { headers: getAuthHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null);

const COLORS = ["#e11d48", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6"];

const SOURCE_LABELS: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", referral: "Giới thiệu",
  google: "Google", tiktok: "TikTok", walk_in: "Tự đến", other: "Khác",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Chờ xác nhận", confirmed: "Đã xác nhận", in_progress: "Đang làm",
  completed: "Hoàn thành", cancelled: "Đã hủy",
};

export default function ReportsPage() {
  const { data: stats } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => fetchObject("/api/dashboard"),
  });

  const { data: bookings = [] } = useQuery<any[]>({
    queryKey: ["bookings-report"],
    queryFn: () => fetchArray("/api/bookings"),
  });

  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ["customers-report"],
    queryFn: () => fetchArray("/api/customers"),
  });

  const { data: expenses = [] } = useQuery<any[]>({
    queryKey: ["expenses-report"],
    queryFn: () => fetchArray("/api/expenses"),
  });

  // Compute monthly revenue from bookings (last 6 months)
  const now = new Date();
  const monthlyData = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const month = d.getMonth();
    const year = d.getFullYear();
    const label = `T${month + 1}/${String(year).slice(2)}`;
    const monthBookings = bookings.filter(b => {
      const bd = new Date(b.shootDate || b.createdAt);
      return bd.getMonth() === month && bd.getFullYear() === year;
    });
    const revenue = monthBookings.reduce((s: number, b: any) => s + (parseFloat(b.totalAmount) || 0), 0);
    const paid = monthBookings.reduce((s: number, b: any) => s + (parseFloat(b.paidAmount) || 0), 0);
    return { label, revenue, paid, count: monthBookings.length };
  });

  // Status distribution
  const statusDist = Object.entries(STATUS_LABELS).map(([k, v]) => ({
    name: v, value: bookings.filter(b => b.status === k).length,
  })).filter(d => d.value > 0);

  // Source distribution
  const sourceDist = Object.entries(SOURCE_LABELS).map(([k, v]) => ({
    name: v, value: customers.filter((c: any) => c.source === k).length,
  })).filter(d => d.value > 0);

  // Service category distribution
  const catDist: Record<string, number> = {};
  bookings.forEach(b => {
    catDist[b.serviceCategory] = (catDist[b.serviceCategory] || 0) + 1;
  });
  const catChartData = Object.entries(catDist).map(([k, v]) => ({
    name: { wedding: "Cưới", beauty: "Beauty", family: "Gia đình", fashion: "Thời trang", event: "Sự kiện", other: "Khác" }[k] || k,
    value: v,
  }));

  // Expense by category
  const expCat: Record<string, number> = {};
  expenses.forEach((e: any) => { expCat[e.category] = (expCat[e.category] || 0) + parseFloat(e.amount || 0); });
  const expChartData = Object.entries(expCat).map(([k, v]) => ({
    name: { salary: "Lương", equipment: "Thiết bị", transport: "Đi lại", marketing: "Marketing", venue: "Địa điểm", supplies: "Vật tư", other: "Khác" }[k] || k,
    amount: v,
  })).sort((a, b) => b.amount - a.amount);

  const totalRevenue = bookings.reduce((s: number, b: any) => s + parseFloat(b.totalAmount || 0), 0);
  const totalPaid = bookings.reduce((s: number, b: any) => s + parseFloat(b.paidAmount || 0), 0);
  const totalExpenses = expenses.reduce((s: number, e: any) => s + parseFloat(e.amount || 0), 0);
  const thisMonthRevenue = bookings.filter(b => {
    const d = new Date(b.shootDate || b.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).reduce((s: number, b: any) => s + parseFloat(b.totalAmount || 0), 0);

  const summaryCards = [
    { label: "Tổng doanh thu", value: formatVND(totalRevenue), sub: "Tất cả đơn hàng", icon: DollarSign, color: "text-primary", bg: "from-primary/10 to-card" },
    { label: "Đã thu", value: formatVND(totalPaid), sub: `${Math.round(totalRevenue > 0 ? (totalPaid / totalRevenue) * 100 : 0)}% doanh thu`, icon: TrendingUp, color: "text-green-600", bg: "from-green-50 to-card" },
    { label: "Tổng chi phí", value: formatVND(totalExpenses), sub: "Chi phí vận hành", icon: TrendingDown, color: "text-red-600", bg: "from-red-50 to-card" },
    { label: "Tháng này", value: formatVND(thisMonthRevenue), sub: `${bookings.filter(b => { const d = new Date(b.shootDate || b.createdAt); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).length} đơn`, icon: Target, color: "text-blue-600", bg: "from-blue-50 to-card" },
    { label: "Tổng khách hàng", value: customers.length, sub: "Đã đăng ký", icon: Users, color: "text-purple-600", bg: "from-purple-50 to-card" },
    { label: "Tổng đơn hàng", value: bookings.length, sub: `${bookings.filter(b => b.status === "completed").length} hoàn thành`, icon: Camera, color: "text-orange-600", bg: "from-orange-50 to-card" },
    { label: "Lợi nhuận gộp", value: formatVND(totalRevenue - totalExpenses), sub: "Doanh thu - Chi phí", icon: Award, color: totalRevenue - totalExpenses >= 0 ? "text-green-600" : "text-red-600", bg: "from-green-50 to-card" },
    { label: "Tỷ lệ hoàn thành", value: `${Math.round(bookings.length > 0 ? (bookings.filter(b => b.status === "completed").length / bookings.length) * 100 : 0)}%`, sub: "Đơn hoàn thành", icon: BarChart3, color: "text-teal-600", bg: "from-teal-50 to-card" },
  ];

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-background border rounded-xl shadow-lg p-3 text-sm">
        <p className="font-bold mb-1">{label}</p>
        {payload.map((p: any) => (
          <p key={p.name} style={{ color: p.color }}>
            {p.name}: {typeof p.value === "number" && p.value > 10000 ? formatVND(p.value) : p.value}
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Báo cáo & Thống kê</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Phân tích tổng quan hoạt động kinh doanh Amazing Studio</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {summaryCards.map(c => (
          <div key={c.label} className={`rounded-xl border bg-gradient-to-br ${c.bg} p-4`}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className={`text-xl font-bold mt-0.5 ${c.color}`}>{c.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{c.sub}</p>
              </div>
              <div className={`p-2 rounded-xl bg-background/80 ${c.color}`}>
                <c.icon className="w-4 h-4" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Monthly Revenue */}
        <div className="bg-card rounded-2xl border p-5">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-primary" />Doanh thu 6 tháng gần đây</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyData} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => v >= 1000000 ? `${v / 1000000}M` : `${v / 1000}K`} />
              <RechartsTooltip content={<CustomTooltip />} />
              <Legend formatter={(v: string) => v === "revenue" ? "Doanh thu" : v === "paid" ? "Đã thu" : v} />
              <Bar dataKey="revenue" name="Doanh thu" fill="#e11d48" radius={[4, 4, 0, 0]} />
              <Bar dataKey="paid" name="Đã thu" fill="#22c55e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Bookings per month */}
        <div className="bg-card rounded-2xl border p-5">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Camera className="w-4 h-4 text-primary" />Số đơn hàng theo tháng</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <RechartsTooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="count" name="Số đơn" stroke="#e11d48" strokeWidth={2.5} dot={{ r: 4, fill: "#e11d48" }} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Status distribution */}
        <div className="bg-card rounded-2xl border p-5">
          <h3 className="font-semibold mb-4">Tình trạng đơn hàng</h3>
          {statusDist.length === 0 ? <div className="h-40 flex items-center justify-center text-muted-foreground text-sm">Chưa có dữ liệu</div> : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={statusDist} dataKey="value" cx="50%" cy="50%" outerRadius={75} label={({ name, percent }) => `${name} ${Math.round(percent * 100)}%`} labelLine={false} fontSize={10}>
                  {statusDist.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <RechartsTooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Source distribution */}
        <div className="bg-card rounded-2xl border p-5">
          <h3 className="font-semibold mb-4">Nguồn khách hàng</h3>
          {sourceDist.length === 0 ? <div className="h-40 flex items-center justify-center text-muted-foreground text-sm">Chưa có dữ liệu</div> : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={sourceDist} dataKey="value" cx="50%" cy="50%" outerRadius={75} label={({ name, percent }) => `${name} ${Math.round(percent * 100)}%`} labelLine={false} fontSize={10}>
                  {sourceDist.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <RechartsTooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Expense by category */}
        <div className="bg-card rounded-2xl border p-5">
          <h3 className="font-semibold mb-4">Chi phí theo danh mục</h3>
          {expChartData.length === 0 ? <div className="h-40 flex items-center justify-center text-muted-foreground text-sm">Chưa có dữ liệu</div> : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={expChartData} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `${v / 1000000}M`} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={70} />
                <RechartsTooltip content={<CustomTooltip />} />
                <Bar dataKey="amount" name="Chi phí" fill="#f97316" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Service category distribution */}
      {catChartData.length > 0 && (
        <div className="bg-card rounded-2xl border p-5">
          <h3 className="font-semibold mb-4">Phân bổ theo loại dịch vụ</h3>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={catChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <RechartsTooltip />
              <Bar dataKey="value" name="Số đơn" fill="#8b5cf6" radius={[4, 4, 0, 0]}>
                {catChartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
