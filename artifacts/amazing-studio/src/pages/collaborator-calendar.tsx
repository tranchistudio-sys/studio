import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  addMonths,
  endOfMonth,
  format,
  parseISO,
  startOfMonth,
  subMonths,
} from "date-fns";
import { vi } from "date-fns/locale";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock, MapPin, UserRound } from "lucide-react";
import { API_BASE } from "@/lib/api-base";

type Occurrence = {
  id: number;
  shootDate: string;
  shootTime: string | null;
  label: string | null;
  sortOrder: number;
};

type CollaboratorBooking = {
  bookingId: number;
  orderCode: string | null;
  shootDate: string;
  shootTime: string | null;
  customerName: string;
  serviceLabel: string | null;
  serviceCategory: string;
  packageType: string;
  serviceName: string;
  serviceNames: string[];
  location: string | null;
  status: string;
  assignedRoles: string[];
  occurrences: Occurrence[];
};

type WorkEvent = CollaboratorBooking & {
  eventKey: string;
  eventDate: string;
  eventTime: string | null;
  occurrenceLabel: string | null;
};

const ROLE_LABELS: Record<string, string> = {
  photographer: "Nhiếp ảnh",
  makeup: "Makeup",
  videographer: "Quay phim",
  photoshop: "Photoshop",
  assistant: "Trợ lý",
  assistant_photo: "Thợ phụ",
  sales: "Sale",
  marketing: "Marketing",
  other: "Công việc khác",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Chờ xác nhận",
  confirmed: "Đã xác nhận",
  completed: "Hoàn thành",
  cancelled: "Đã hủy",
};

async function fetchMyCalendar(from: string, to: string): Promise<CollaboratorBooking[]> {
  const response = await fetch(
    `${API_BASE}/api/bookings/my-calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { credentials: "include" },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || "Không tải được lịch công việc");
  }
  const payload = await response.json() as { bookings?: unknown };
  return Array.isArray(payload.bookings) ? payload.bookings as CollaboratorBooking[] : [];
}

export default function CollaboratorCalendarPage() {
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const [expandedEventKey, setExpandedEventKey] = useState<string | null>(null);
  const range = useMemo(() => ({
    from: format(startOfMonth(currentMonth), "yyyy-MM-dd"),
    to: format(endOfMonth(currentMonth), "yyyy-MM-dd"),
  }), [currentMonth]);
  const query = useQuery({
    queryKey: ["collaborator-calendar", range.from, range.to],
    queryFn: () => fetchMyCalendar(range.from, range.to),
    staleTime: 0,
  });

  const events = useMemo(() => {
    const output: WorkEvent[] = [];
    for (const booking of query.data ?? []) {
      if (booking.shootDate >= range.from && booking.shootDate <= range.to) {
        output.push({
          ...booking,
          eventKey: `booking-${booking.bookingId}`,
          eventDate: booking.shootDate,
          eventTime: booking.shootTime,
          occurrenceLabel: null,
        });
      }
      for (const occurrence of booking.occurrences ?? []) {
        output.push({
          ...booking,
          eventKey: `booking-${booking.bookingId}-occurrence-${occurrence.id}`,
          eventDate: occurrence.shootDate,
          eventTime: occurrence.shootTime,
          occurrenceLabel: occurrence.label,
        });
      }
    }
    return output.sort((left, right) =>
      left.eventDate.localeCompare(right.eventDate) ||
      String(left.eventTime ?? "99:99").localeCompare(String(right.eventTime ?? "99:99")) ||
      left.bookingId - right.bookingId,
    );
  }, [query.data, range.from, range.to]);

  const groups = useMemo(() => {
    const result = new Map<string, WorkEvent[]>();
    for (const event of events) {
      const list = result.get(event.eventDate) ?? [];
      list.push(event);
      result.set(event.eventDate, list);
    }
    return [...result.entries()];
  }, [events]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-10">
      <section className="rounded-2xl border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setCurrentMonth(month => subMonths(month, 1))}
            className="rounded-full border p-2 text-muted-foreground hover:bg-muted"
            aria-label="Tháng trước"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="text-center">
            <div className="flex items-center justify-center gap-2">
              <CalendarDays className="h-5 w-5 text-primary" />
              <h1 className="text-xl font-bold">Lịch của tôi</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {format(currentMonth, "'Tháng' M 'năm' yyyy", { locale: vi })}
            </p>
            {!query.isLoading && !query.isError && (
              <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
                Từ {format(parseISO(range.from), "dd/MM")} đến {format(parseISO(range.to), "dd/MM")} · {events.length} show được phân công
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCurrentMonth(month => addMonths(month, 1))}
            className="rounded-full border p-2 text-muted-foreground hover:bg-muted"
            aria-label="Tháng sau"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </section>

      {query.isLoading && (
        <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Đang tải lịch công việc…
        </div>
      )}
      {query.isError && (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Không tải được lịch công việc"}
          <button type="button" className="ml-2 underline" onClick={() => query.refetch()}>Thử lại</button>
        </div>
      )}
      {!query.isLoading && !query.isError && groups.length === 0 && (
        <div className="rounded-2xl border bg-card p-8 text-center">
          <CalendarDays className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="font-medium">Tháng này chưa có lịch được phân công</p>
          <p className="mt-1 text-sm text-muted-foreground">Khi Studio giao việc, lịch sẽ xuất hiện tại đây.</p>
        </div>
      )}

      {groups.map(([date, dayEvents]) => (
        <section key={date} className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="border-b bg-muted/40 px-4 py-3">
            <p className="font-semibold capitalize">
              {format(parseISO(date), "EEEE, dd/MM/yyyy", { locale: vi })}
            </p>
          </div>
          <div className="divide-y">
            {dayEvents.map(event => (
              <article key={event.eventKey} className="p-4">
                <button
                  type="button"
                  className="w-full space-y-2 text-left"
                  aria-expanded={expandedEventKey === event.eventKey}
                  onClick={() => setExpandedEventKey(current => current === event.eventKey ? null : event.eventKey)}
                >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <UserRound className="h-4 w-4 shrink-0 text-primary" />
                      <h2 className="truncate font-semibold">{event.customerName}</h2>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {event.serviceName || event.serviceLabel || event.packageType}
                      {event.occurrenceLabel ? ` · ${event.occurrenceLabel}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
                    {STATUS_LABELS[event.status] ?? event.status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {event.eventTime?.slice(0, 5) || "Chưa chốt giờ"}
                  </span>
                  {event.location && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" /> {event.location}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {event.assignedRoles.map(role => (
                    <span key={role} className="rounded-md bg-muted px-2 py-1 text-xs font-medium">
                      {ROLE_LABELS[role] ?? role}
                    </span>
                  ))}
                  {event.orderCode && <span className="px-1 py-1 text-xs text-muted-foreground">{event.orderCode}</span>}
                  <ChevronDown className={`ml-auto h-4 w-4 text-muted-foreground transition-transform ${expandedEventKey === event.eventKey ? "rotate-180" : ""}`} />
                </div>
                </button>
                {expandedEventKey === event.eventKey && (
                  <div className="mt-3 space-y-1.5 rounded-xl bg-muted/50 p-3 text-sm">
                    <p><span className="text-muted-foreground">Ngày:</span> {format(parseISO(event.eventDate), "dd/MM/yyyy")}</p>
                    <p><span className="text-muted-foreground">Thời gian:</span> {event.eventTime?.slice(0, 5) || "Chưa chốt giờ"}</p>
                    <p><span className="text-muted-foreground">Tên show:</span> {event.customerName}</p>
                    <p><span className="text-muted-foreground">Dịch vụ:</span> {event.serviceName || event.serviceLabel || event.packageType}</p>
                    <p><span className="text-muted-foreground">Vai trò:</span> {event.assignedRoles.map(role => ROLE_LABELS[role] ?? role).join(", ")}</p>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
