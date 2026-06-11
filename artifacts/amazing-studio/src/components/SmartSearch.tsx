import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X, Calendar, Phone, Hash } from "lucide-react";
import { Link } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type SearchResult = {
  id: number;
  orderCode: string;
  customerName: string;
  customerPhone: string;
  shootDate: string;
  packageType: string;
  status: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Chờ xác nhận",
  confirmed: "Đã xác nhận",
  shooting: "Đang chụp",
  editing: "Đang chỉnh sửa",
  delivered: "Đã giao",
  completed: "Hoàn thành",
  cancelled: "Đã hủy",
};

const STATUS_DOT: Record<string, string> = {
  pending: "bg-amber-400",
  confirmed: "bg-blue-400",
  shooting: "bg-purple-400",
  editing: "bg-orange-400",
  delivered: "bg-teal-400",
  completed: "bg-green-400",
  cancelled: "bg-gray-400",
};

function formatShootDate(date: string) {
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return date;
    return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return date;
  }
}

export function SmartSearch() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: results = [], isFetching } = useQuery<SearchResult[]>({
    queryKey: ["smart-search", query],
    queryFn: () =>
      fetch(`${BASE}/api/bookings?q=${encodeURIComponent(query)}&limit=8`)
        .then(r => r.json()),
    enabled: query.trim().length >= 2,
    staleTime: 3_000,
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); setQuery(""); }
  };

  const clear = () => { setQuery(""); setOpen(false); };

  return (
    <div className="relative" ref={containerRef}>
      <div className={`flex items-center gap-2 h-9 rounded-full border transition-all ${open || query ? "border-primary bg-background shadow-sm w-52 sm:w-64" : "border-border bg-muted/40 hover:border-primary/50 w-36 sm:w-48"} px-3`}>
        <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => query.length >= 2 && setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Tìm khách, đơn hàng..."
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
        />
        {query && (
          <button onClick={clear} className="text-muted-foreground hover:text-foreground flex-shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && query.trim().length >= 2 && (
        <div className="absolute top-full right-0 mt-2 w-80 bg-background border border-border rounded-2xl shadow-xl z-50 overflow-hidden">
          {isFetching && results.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Đang tìm...</div>
          ) : results.length === 0 ? (
            <div className="py-6 text-center">
              <Search className="w-6 h-6 mx-auto mb-2 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Không tìm thấy kết quả</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">Thử tên, SĐT hoặc mã đơn hàng</p>
            </div>
          ) : (
            <>
              <div className="px-3 py-2 border-b border-border/50">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {results.length} kết quả · nhấn để xem
                </p>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {results.map(r => (
                  <Link key={r.id} href="/calendar" onClick={() => { clear(); }}>
                    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer border-b border-border/30 last:border-0">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[r.status] ?? "bg-gray-400"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-sm truncate">{r.customerName}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0 font-mono">{r.orderCode}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Phone className="w-2.5 h-2.5" />{r.customerPhone}
                          </span>
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Calendar className="w-2.5 h-2.5" />{formatShootDate(r.shootDate)}
                          </span>
                        </div>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium flex-shrink-0">
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
              <div className="px-3 py-2 border-t border-border/30">
                <Link href={`/calendar?q=${encodeURIComponent(query)}`} onClick={clear}>
                  <p className="text-xs text-primary hover:underline text-center">
                    Xem tất cả trên lịch →
                  </p>
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
