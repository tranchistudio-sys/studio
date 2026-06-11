import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Bell, CheckCheck, Calendar, Wallet, Image as ImgIcon, ListChecks, Filter, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Notification } from "@/hooks/use-notifications";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string, opts?: RequestInit) {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return fetch(url, { ...opts, headers: { ...opts?.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}

const MODULE_LABEL: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  calendar: { label: "Lịch chụp", icon: Calendar, color: "text-blue-600 bg-blue-50" },
  payments: { label: "Thanh toán", icon: Wallet, color: "text-emerald-600 bg-emerald-50" },
  "photoshop-jobs": { label: "Hậu kỳ", icon: ImgIcon, color: "text-purple-600 bg-purple-50" },
  tasks: { label: "Công việc", icon: ListChecks, color: "text-amber-600 bg-amber-50" },
};

const PRIORITY_BORDER: Record<string, string> = {
  urgent: "border-l-red-500 bg-red-50/40",
  high: "border-l-red-400 bg-red-50/20",
  warning: "border-l-amber-400 bg-amber-50/20",
  normal: "border-l-transparent",
};

function formatDateTime(s: string): string {
  try {
    const d = new Date(s);
    return d.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return s; }
}

function dayKey(s: string): string {
  try {
    const d = new Date(s);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    if (isToday) return "Hôm nay";
    if (isYesterday) return "Hôm qua";
    return d.toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  } catch { return s.slice(0, 10); }
}

export default function NotificationsPage() {
  // KHÔNG dùng useNotifications() ở đây để tránh trùng SSE với Layout — gọi API trực tiếp
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterModule, setFilterModule] = useState<string>("all");
  const [filterUnread, setFilterUnread] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    try {
      const r = await authFetch(`${BASE}/api/notifications?limit=200`);
      if (r.ok) {
        const data = await r.json();
        setItems(Array.isArray(data) ? data : []);
      }
    } finally {
      setLoading(false);
    }
  };

  const markAsRead = async (id: number) => {
    try { await authFetch(`${BASE}/api/notifications/${id}/read`, { method: "PATCH" }); } catch { /* ignore */ }
  };
  const markAllRead = async () => {
    try { await authFetch(`${BASE}/api/notifications/mark-all-read`, { method: "POST" }); } catch { /* ignore */ }
  };

  useEffect(() => { loadAll(); }, []);

  const filtered = useMemo(() => {
    return items.filter(n => {
      if (filterModule !== "all" && n.targetModule !== filterModule) return false;
      if (filterUnread && n.isRead) return false;
      return true;
    });
  }, [items, filterModule, filterUnread]);

  const grouped = useMemo(() => {
    const map = new Map<string, Notification[]>();
    for (const n of filtered) {
      const k = dayKey(n.createdAt);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(n);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const unreadInList = filtered.filter(n => !n.isRead).length;

  const handleClickNotif = (n: Notification) => {
    if (!n.isRead) {
      markAsRead(n.id);
      setItems(prev => prev.map(x => x.id === n.id ? { ...x, isRead: true } : x));
    }
  };

  const handleMarkAll = async () => {
    await markAllRead();
    setItems(prev => prev.map(x => ({ ...x, isRead: true })));
  };

  return (
    <div className="min-h-full bg-background">
      <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
            <Bell className="w-5 h-5 text-blue-600" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Lịch sử thông báo</h1>
            <p className="text-xs text-muted-foreground">Toàn bộ thông báo của bạn — bấm vào để mở thẳng đơn liên quan</p>
          </div>
          {unreadInList > 0 && (
            <button onClick={handleMarkAll} className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
              <CheckCheck className="w-4 h-4" /> Đọc hết ({unreadInList})
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mr-1">
            <Filter className="w-3.5 h-3.5" /> Lọc:
          </div>
          <button
            onClick={() => setFilterModule("all")}
            className={cn("text-xs px-2.5 py-1 rounded-full border", filterModule === "all" ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-muted")}
          >
            Tất cả ({items.length})
          </button>
          {Object.entries(MODULE_LABEL).map(([key, meta]) => {
            const cnt = items.filter(n => n.targetModule === key).length;
            const Icon = meta.icon;
            return (
              <button
                key={key}
                onClick={() => setFilterModule(key)}
                className={cn("flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border", filterModule === key ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-muted")}
              >
                <Icon className="w-3.5 h-3.5" />
                {meta.label} ({cnt})
              </button>
            );
          })}
          <label className="flex items-center gap-1.5 text-xs ml-2 cursor-pointer">
            <input type="checkbox" checked={filterUnread} onChange={e => setFilterUnread(e.target.checked)} />
            Chỉ chưa đọc
          </label>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-3 sm:px-6 py-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />
            ))}
          </div>
        ) : grouped.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Bell className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>Không có thông báo nào</p>
          </div>
        ) : (
          <div className="space-y-5">
            {grouped.map(([day, list]) => (
              <div key={day}>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1 capitalize">
                  {day}
                </div>
                <div className="bg-card border rounded-xl divide-y overflow-hidden">
                  {list.map(n => {
                    const meta = n.targetModule ? MODULE_LABEL[n.targetModule] : null;
                    const Icon = meta?.icon || Bell;
                    const bidQuery = n.bookingId ? `?bookingId=${n.bookingId}` : "";
                    const href = n.targetModule === "calendar" ? `/calendar${bidQuery}` :
                      n.targetModule === "payments" ? `/payments${bidQuery}` :
                      n.targetModule === "photoshop-jobs" ? `/photoshop-jobs${bidQuery}` :
                      n.targetModule === "tasks" ? `/tasks${bidQuery}` : null;
                    const priorityClass = PRIORITY_BORDER[n.priority] || PRIORITY_BORDER.normal;

                    const inner = (
                      <div className="flex items-start gap-3 p-3">
                        <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", meta?.color || "bg-muted text-muted-foreground")}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <span className={cn("text-sm leading-snug", !n.isRead ? "font-semibold text-foreground" : "text-foreground/70")}>
                              {n.title}
                            </span>
                            {!n.isRead && <span className="mt-1.5 w-2 h-2 rounded-full bg-primary flex-shrink-0" />}
                          </div>
                          <p className="text-[13px] text-foreground/75 mt-1 leading-relaxed">{n.message}</p>
                          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground/80 flex-wrap">
                            {n.senderName && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                                <User className="w-3 h-3" />{n.senderName}
                              </span>
                            )}
                            <span>{formatDateTime(n.createdAt)}</span>
                            {meta && <span>· {meta.label}</span>}
                          </div>
                        </div>
                      </div>
                    );

                    return (
                      <div
                        key={n.id}
                        onClick={() => handleClickNotif(n)}
                        className={cn("border-l-2 transition-colors hover:bg-muted/40", priorityClass, !n.isRead && "bg-primary/5")}
                      >
                        {href ? (
                          <Link href={href} className="block">{inner}</Link>
                        ) : (
                          inner
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
