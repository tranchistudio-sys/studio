import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X, Calendar, Phone, User, MapPin } from "lucide-react";
import { Link } from "wouter";
import { formatVND } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type BookingResult = {
  id: number;
  orderCode: string;
  customerName: string;
  customerPhone: string;
  shootDate: string;
  packageType: string;
  serviceLabel: string | null;
  status: string;
  totalAmount: number;
  customerId: number;
};

type CustomerResult = {
  id: number;
  name: string;
  phone: string;
  address: string | null;
};

type SearchResponse = { bookings: BookingResult[]; customers: CustomerResult[] };

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
  // Debounce: chỉ gọi API sau khi ngừng gõ ~250ms (đỡ nặng, không cần bấm Enter).
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: ["global-search", debounced],
    queryFn: () =>
      fetch(`${BASE}/api/search?q=${encodeURIComponent(debounced)}&limit=8`).then(r =>
        r.ok ? r.json() : { bookings: [], customers: [] },
      ),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
    placeholderData: (prev) => prev, // giữ kết quả cũ khi gõ tiếp → không chớp "Không tìm thấy"
  });

  const bookings = data?.bookings ?? [];
  const customers = data?.customers ?? [];
  const hasResults = bookings.length > 0 || customers.length > 0;
  // Đang chờ debounce hoặc đang fetch cho query mới → coi như đang tìm.
  const searching = query.trim() !== debounced || isFetching;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const clear = () => { setQuery(""); setDebounced(""); setOpen(false); };

  return (
    <div className="relative" ref={containerRef}>
      <div className={`flex items-center gap-2 h-9 rounded-full border transition-all ${open || query ? "border-primary bg-background shadow-sm w-52 sm:w-64" : "border-border bg-muted/40 hover:border-primary/50 w-36 sm:w-48"} px-3`}>
        <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => query.length >= 2 && setOpen(true)}
          onKeyDown={e => { if (e.key === "Escape") clear(); }}
          placeholder="Tìm tên, SĐT, mã đơn..."
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
        />
        {query && (
          <button onClick={clear} className="text-muted-foreground hover:text-foreground flex-shrink-0" aria-label="Xoá">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && query.trim().length >= 2 && (
        <div className="fixed left-3 right-3 top-16 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96 bg-background border border-border rounded-2xl shadow-xl z-50 overflow-hidden">
          {searching && !hasResults ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Đang tìm...</div>
          ) : !hasResults ? (
            <div className="py-6 text-center">
              <Search className="w-6 h-6 mx-auto mb-2 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Không tìm thấy kết quả</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">Thử tên, SĐT hoặc mã đơn hàng</p>
            </div>
          ) : (
            <div className="max-h-[70vh] sm:max-h-96 overflow-y-auto">
              {/* ── Nhóm Khách hàng ── */}
              {customers.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 bg-muted/40 border-b border-border/50">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Khách hàng</p>
                  </div>
                  {customers.map(c => (
                    <Link key={`c-${c.id}`} href={`/customers?customerId=${c.id}`} onClick={clear}>
                      <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer border-b border-border/30">
                        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <User className="w-3.5 h-3.5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm truncate">{c.name}</p>
                          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                            {c.phone && <span className="flex items-center gap-1"><Phone className="w-2.5 h-2.5" />{c.phone}</span>}
                            {c.address && <span className="flex items-center gap-1 truncate"><MapPin className="w-2.5 h-2.5 shrink-0" /><span className="truncate">{c.address}</span></span>}
                          </div>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}

              {/* ── Nhóm Đơn hàng / Lịch chụp ── */}
              {bookings.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 bg-muted/40 border-b border-border/50">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Đơn hàng · Lịch chụp</p>
                  </div>
                  {bookings.map(b => (
                    <Link key={`b-${b.id}`} href={`/calendar?bookingId=${b.id}`} onClick={clear}>
                      <div className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer border-b border-border/30 last:border-0">
                        <div className={`w-2 h-2 mt-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[b.status] ?? "bg-gray-400"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-sm truncate">{b.customerName}</span>
                            {b.orderCode && <span className="text-[10px] text-muted-foreground shrink-0 font-mono">{b.orderCode}</span>}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-xs text-muted-foreground">
                            {b.customerPhone && <span className="flex items-center gap-1"><Phone className="w-2.5 h-2.5" />{b.customerPhone}</span>}
                            <span className="flex items-center gap-1"><Calendar className="w-2.5 h-2.5" />{formatShootDate(b.shootDate)}</span>
                            {b.totalAmount > 0 && <span className="font-medium text-foreground/70">{formatVND(b.totalAmount)}</span>}
                          </div>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium flex-shrink-0">
                          {STATUS_LABEL[b.status] ?? b.status}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
