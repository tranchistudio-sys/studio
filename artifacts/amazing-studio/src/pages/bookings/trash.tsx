import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, RotateCcw, Flame, AlertTriangle, Loader2, User, Calendar } from "lucide-react";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const vnd = (n: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n);
function fmtDateTime(s?: string | null) {
  if (!s) return "";
  try { return new Date(s).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); }
  catch { return String(s); }
}
function fmtDate(s?: string | null) {
  if (!s) return "—";
  try { return new Date(s + "T00:00:00").toLocaleDateString("vi-VN"); } catch { return String(s); }
}

type TrashBooking = {
  id: number; orderCode: string | null; customerName: string | null; customerPhone: string | null;
  shootDate: string | null; serviceLabel: string | null; packageType: string | null;
  totalAmount: string | number | null; status: string | null;
  deletedAt: string | null; deletedByName: string | null; deleteReason: string | null;
};

export default function BookingsTrashPage() {
  const qc = useQueryClient();
  const { effectiveIsAdmin } = useStaffAuth();
  const token = localStorage.getItem("amazingStudioToken_v2");
  const authHeaders = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<{ b: TrashBooking; conflicts: string[] } | null>(null);

  const { data: rows = [], isLoading } = useQuery<TrashBooking[]>({
    queryKey: ["bookings-trash"],
    queryFn: () => fetch(`${BASE}/api/bookings/trash`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
    enabled: effectiveIsAdmin,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["bookings-trash"] });
    qc.invalidateQueries({ queryKey: ["bookings"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  // Bước 1: gọi restore để LẤY cảnh báo conflict; nếu có → mở dialog xác nhận, không refetch vội.
  const probeRestore = async (b: TrashBooking) => {
    setBusyId(b.id);
    try {
      const r = await fetch(`${BASE}/api/bookings/${b.id}/restore`, { method: "POST", headers: authHeaders, body: "{}" });
      const j = await r.json().catch(() => ({}));
      const conflicts: string[] = Array.isArray(j?.conflicts) ? j.conflicts : [];
      // Đơn ĐÃ được phục hồi ở backend (không chặn). Nếu có cảnh báo → cho admin biết để xử lý tay.
      if (conflicts.length) setConfirmRestore({ b, conflicts });
      invalidateAll();
    } finally { setBusyId(null); }
  };

  const purge = async (b: TrashBooking) => {
    if (!confirm(`Xóa VĨNH VIỄN booking ${b.orderCode || `#${b.id}`} (${b.customerName || "khách"})?\n\nKhông thể phục hồi. Toàn bộ dữ liệu con (giao việc, thu/chi, lương, hậu kỳ) sẽ bị xóa hẳn.`)) return;
    setBusyId(b.id);
    try {
      await fetch(`${BASE}/api/bookings/${b.id}/purge`, { method: "DELETE", headers: authHeaders });
      invalidateAll();
    } finally { setBusyId(null); }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Trash2 className="w-6 h-6 text-destructive" /> Thùng rác Booking
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Đơn đã chuyển vào thùng rác (đã ẩn khỏi lịch, danh sách, báo cáo & lương). Khôi phục hoặc xóa vĩnh viễn. Tổng: <strong>{rows.length}</strong> đơn.
        </p>
      </div>

      {!effectiveIsAdmin ? (
        <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> Chỉ admin mới xem được Thùng rác Booking.
        </div>
      ) : isLoading ? (
        <div className="text-center py-12 text-muted-foreground"><Loader2 className="w-8 h-8 animate-spin mx-auto" /></div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-border rounded-2xl text-muted-foreground">
          <Trash2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>Thùng rác trống.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map(b => (
            <div key={b.id} className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-xl border border-border bg-card">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 font-semibold text-sm">
                  <User className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{b.customerName || "Khách chưa rõ tên"}</span>
                  {b.customerPhone && <span className="text-xs text-muted-foreground font-normal">· {b.customerPhone}</span>}
                </div>
                <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="font-mono">{b.orderCode || `#${b.id}`}</span>
                  <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {fmtDate(b.shootDate)}</span>
                  <span className="truncate">{b.serviceLabel || b.packageType || "Dịch vụ"}</span>
                  {b.totalAmount != null && <span className="font-semibold text-foreground/70">{vnd(Number(b.totalAmount) || 0)}</span>}
                  {b.status && <span className="px-1.5 py-0.5 rounded-full bg-muted">{b.status}</span>}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Xóa lúc {fmtDateTime(b.deletedAt)}{b.deletedByName ? ` · bởi ${b.deletedByName}` : ""}
                  {b.deleteReason ? ` · Lý do: ${b.deleteReason}` : ""}
                </div>
              </div>
              <div className="flex gap-1.5 flex-shrink-0">
                <button onClick={() => probeRestore(b)} disabled={busyId === b.id}
                  className="flex items-center gap-1 text-xs font-medium border border-border px-3 py-1.5 rounded-lg hover:bg-muted disabled:opacity-50">
                  {busyId === b.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Phục hồi
                </button>
                <button onClick={() => purge(b)} disabled={busyId === b.id}
                  className="flex items-center gap-1 text-xs font-medium border border-destructive/30 text-destructive px-3 py-1.5 rounded-lg hover:bg-destructive/10 disabled:opacity-50">
                  <Flame className="w-3.5 h-3.5" /> Xóa vĩnh viễn
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cảnh báo conflict sau khi phục hồi (đơn đã được phục hồi — đây là thông tin để admin xử lý tay) */}
      {confirmRestore && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setConfirmRestore(null)}>
          <div className="bg-background w-full max-w-md rounded-2xl shadow-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-base flex items-center gap-2 text-amber-700">
              <AlertTriangle className="w-5 h-5" /> Đã phục hồi — có cảnh báo cần kiểm tra
            </h3>
            <p className="text-sm text-muted-foreground">
              Booking <b>{confirmRestore.b.orderCode || `#${confirmRestore.b.id}`}</b> đã được phục hồi, nhưng phát hiện:
            </p>
            <ul className="list-disc pl-5 text-sm text-amber-800 space-y-1">
              {confirmRestore.conflicts.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
            <p className="text-xs text-muted-foreground">Hãy kiểm tra/điều chỉnh tay nếu cần (bảng lương đã chốt sẽ KHÔNG tự sửa).</p>
            <div className="flex justify-end">
              <button onClick={() => setConfirmRestore(null)} className="py-2 px-4 bg-foreground text-background rounded-lg text-sm font-semibold">Đã hiểu</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
