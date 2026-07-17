/**
 * RevenueEvidenceModal — hộp "Bằng chứng số liệu" cho các ô tiền màn Doanh thu & Lợi nhuận.
 *
 * Nguyên tắc hiển thị (yêu cầu chủ studio 17/07):
 *  - Công thức tính rõ ràng ngay đầu modal.
 *  - Bảng TỪNG DÒNG như Excel: ngày, mã đơn, khách, loại khoản, nội dung, số tiền,
 *    trạng thái, người thu; link mở booking (Lịch) + phiếu thu/chi.
 *  - Dòng tổng cuối bảng + ĐỐI CHIẾU TỰ ĐỘNG với số trên ô: khớp → badge xanh,
 *    lệch dù 1 đồng → badge đỏ ghi rõ số lệch. Không che, không làm tròn.
 *  - Nút "Tải Excel": CSV có công thức =SUM để Excel tự cộng lại.
 */
import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  X, Download, CheckCircle2, AlertTriangle, CalendarDays, Receipt, Banknote, Loader2,
} from "lucide-react";
import {
  buildEvidenceCsv, evidenceCsvFilename, reconcile, sumFromRows,
  type EvidenceMetric, type EvidenceResponse, type EvidenceGroup,
} from "@/lib/evidence-csv";
import { bookingCalendarUrl, canOpenBookingCalendar } from "@/lib/open-calendar";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const vnd = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n);

/** Hiện delta không làm tròn: phần lẻ (nếu có) giữ nguyên tới 0.01đ. */
const vndExact = (n: number) => {
  if (Number.isInteger(n)) return `${n.toLocaleString("vi-VN")}đ`;
  return `${(Math.round(n * 100) / 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 })}đ`;
};

type Props = {
  metric: EvidenceMetric;
  metricLabel: string;
  /** Số ĐANG hiển thị trên ô người dùng vừa bấm. */
  cardTotal: number;
  from: string;
  to: string;
  rangeLabel: string;
  onClose: () => void;
};

const STATUS_LABEL: Record<string, string> = {
  active: "hợp lệ",
  confirmed: "đã xác nhận",
  completed: "hoàn thành",
  in_progress: "đang thực hiện",
  pending: "chờ xác nhận",
};

function fmtDmy(s: string | null): string {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  if (!y || !m || !d) return s;
  return `${d}/${m}/${y}`;
}

function GroupSection({ group, onOpenBooking, onOpenPayment, onOpenExpense }: {
  group: EvidenceGroup;
  onOpenBooking: (id: number) => void;
  onOpenPayment: (bookingId: number) => void;
  onOpenExpense: (id: number) => void;
}) {
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/50">
        <p className="text-xs font-semibold text-foreground">
          {group.sign === -1 && <span className="text-red-600 dark:text-red-400 mr-1">(−)</span>}
          {group.label}
          <span className="text-muted-foreground font-normal"> · {group.rows.length} dòng</span>
        </p>
        <p className={`text-xs font-bold ${group.sign === -1 ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>
          {group.sign === -1 ? "−" : ""}{vnd(group.subtotal)}
        </p>
      </div>
      {group.rows.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">Không có khoản nào trong kỳ.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {group.rows.map((r, i) => (
            <li key={i} className="px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">
                    {r.name || r.code || r.kind || "—"}
                    {r.name && r.code && <span className="text-muted-foreground font-normal"> · {r.code}</span>}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {fmtDmy(r.date)}
                    {r.kind && <> · {r.kind}</>}
                    {r.status && <> · {STATUS_LABEL[r.status] ?? r.status}</>}
                    {r.by && <> · thu bởi {r.by}</>}
                  </p>
                  {r.detail && <p className="text-[11px] text-muted-foreground mt-0.5 break-words">{r.detail}</p>}
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {canOpenBookingCalendar(r.bookingId) && (
                      <button
                        type="button"
                        onClick={() => onOpenBooking(r.bookingId as number)}
                        className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md border border-border hover:bg-muted text-muted-foreground"
                      >
                        <CalendarDays className="w-3 h-3" /> Mở booking
                      </button>
                    )}
                    {r.paymentId != null && canOpenBookingCalendar(r.bookingId) && (
                      <button
                        type="button"
                        onClick={() => onOpenPayment(r.bookingId as number)}
                        className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md border border-border hover:bg-muted text-muted-foreground"
                      >
                        <Receipt className="w-3 h-3" /> Phiếu thu
                      </button>
                    )}
                    {r.expenseId != null && (
                      <button
                        type="button"
                        onClick={() => onOpenExpense(r.expenseId as number)}
                        className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md border border-border hover:bg-muted text-muted-foreground"
                      >
                        <Banknote className="w-3 h-3" /> Phiếu chi
                      </button>
                    )}
                  </div>
                </div>
                <p className={`text-xs font-bold whitespace-nowrap ${group.sign === -1 ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>
                  {group.sign === -1 ? "−" : ""}{vnd(r.amount)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RevenueEvidenceModal({ metric, metricLabel, cardTotal, from, to, rangeLabel, onClose }: Props) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<EvidenceResponse>({
    queryKey: ["revenue-evidence", metric, from, to],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/revenue/v2/evidence?metric=${metric}&from=${from}&to=${to}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    // Bằng chứng phải TƯƠI đúng lúc mở modal — không dùng cache 5 phút toàn cục
    // (ô card tự refresh 60s, cache cũ sẽ tạo cảnh lệch giả).
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Đối chiếu 3 lớp, so CHÍNH XÁC (EPS 0.001đ chỉ hấp thụ nhiễu float):
  //  1) tự cộng lại TỪNG DÒNG (không tin subtotal server) so với detailTotal server
  //  2) detailTotal server so với cardTotal server (server tự đối chiếu)
  //  3) so với số ĐANG hiển thị trên ô (cardTotal prop)
  const recon = useMemo(() => {
    if (!data) return null;
    const clientSum = sumFromRows(data.groups);
    const vsTile = reconcile(clientSum, cardTotal);
    const vsServerCard = reconcile(data.detailTotal, data.cardTotal);
    const vsServerDetail = reconcile(clientSum, data.detailTotal);
    const allMatch = vsTile.match && vsServerCard.match && vsServerDetail.match;
    // Ô hiển thị bản cũ: server + bảng chi tiết đồng thuận một số MỚI, chỉ số trên ô lệch
    // → dữ liệu vừa thay đổi giữa 2 lần tải, không phải bug tính tiền.
    const tileStale = !vsTile.match && vsServerCard.match && vsServerDetail.match;
    return { clientSum, vsTile, vsServerCard, vsServerDetail, allMatch, tileStale };
  }, [data, cardTotal]);

  // Ô đang hiển thị bản cũ → ép các query card của màn Doanh thu refetch để ô
  // tự cập nhật về đúng số server (badge sẽ tự chuyển xanh khi prop cardTotal mới về).
  const tileRefreshed = useRef(false);
  useEffect(() => {
    if (recon?.tileStale && !tileRefreshed.current) {
      tileRefreshed.current = true;
      for (const key of ["revenue-monthly", "revenue-today", "revenue-week"]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
  }, [recon?.tileStale, queryClient]);

  const plusGroups = data?.groups.filter(g => g.sign === 1) ?? [];
  const minusGroups = data?.groups.filter(g => g.sign === -1) ?? [];

  const openBooking = (id: number) => { onClose(); setLocation(bookingCalendarUrl(id)); };
  const openPayment = (bookingId: number) => { onClose(); setLocation(`/payments?bookingId=${bookingId}`); };
  const openExpense = (id: number) => { onClose(); setLocation(`/expenses?expenseId=${id}`); };

  const downloadCsv = () => {
    if (!data) return;
    const csv = buildEvidenceCsv(data, { metricLabel, cardTotalOnTile: cardTotal, rangeLabel });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = evidenceCsvFilename(metric, from, to);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3 sm:p-4" onClick={onClose}>
      <div
        className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-border">
          <div className="min-w-0">
            <h2 className="font-bold text-base text-foreground">Bằng chứng số liệu: {metricLabel}</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">Kỳ lọc: {rangeLabel} ({fmtDmy(from)} → {fmtDmy(to)})</p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={downloadCsv}
              disabled={!data}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" /> Tải Excel
            </button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted" aria-label="Đóng">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-4 sm:px-5 py-3.5 space-y-3">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Đang lấy bằng chứng…
            </div>
          )}
          {isError && (
            <p className="text-sm text-red-600 dark:text-red-400 py-6 text-center">
              Không lấy được bằng chứng số liệu. Thử đóng modal và bấm lại.
            </p>
          )}
          {data && recon && (
            <>
              {/* Công thức */}
              <div className="rounded-xl bg-muted/50 border border-border px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Công thức</p>
                <p className="text-xs text-foreground mt-1 font-medium">{data.formula}</p>
                {data.scopeNote && <p className="text-[11px] text-muted-foreground mt-1">{data.scopeNote}</p>}
                {(data.notes ?? []).map((n, i) => (
                  <p key={i} className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">⚠ {n}</p>
                ))}
              </div>

              {/* Badge đối chiếu — 3 lớp phải cùng khớp mới xanh */}
              {recon.allMatch ? (
                <div className="flex items-center gap-2 rounded-xl border border-green-600/30 bg-green-50 dark:bg-green-950/20 px-3 py-2.5">
                  <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
                  <p className="text-xs font-semibold text-green-700 dark:text-green-400">
                    ✓ Khớp chính xác với số trên thẻ — {vnd(cardTotal)}
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-red-600/40 bg-red-50 dark:bg-red-950/20 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                    <p className="text-xs font-bold text-red-700 dark:text-red-400">
                      CẢNH BÁO: Chi tiết lệch số tổng {vndExact(recon.vsTile.match ? recon.vsServerCard.delta : recon.vsTile.delta)}
                    </p>
                  </div>
                  <p className="text-[11px] text-red-700/80 dark:text-red-400/80 mt-1">
                    Tổng từng dòng = {vnd(recon.clientSum)} · Số trên thẻ = {vnd(cardTotal)} · Server tính lại = {vnd(data.cardTotal)}
                  </p>
                  {recon.tileStale ? (
                    <p className="text-[11px] text-red-700/80 dark:text-red-400/80 mt-1">
                      Bảng chi tiết và server đang ĐỒNG THUẬN ở {vnd(data.cardTotal)} — số trên ô là bản cũ
                      (dữ liệu vừa được sửa). Ô đang được làm mới tự động, badge sẽ chuyển xanh khi ô cập nhật.
                    </p>
                  ) : (
                    <p className="text-[11px] text-red-700/80 dark:text-red-400/80 mt-1">
                      {!recon.vsServerCard.match && (
                        <>Server cũng ghi nhận lệch {vndExact(data.reconciliationDelta)} — đây là bug tính tiền thật, cần báo dev. </>
                      )}
                      {!recon.vsServerDetail.match && (
                        <>Tổng cộng lại trên máy ({vnd(recon.clientSum)}) khác detailTotal server ({vnd(data.detailTotal)}) — lỗi truyền dữ liệu, cần báo dev.</>
                      )}
                    </p>
                  )}
                </div>
              )}

              {/* Nhóm cộng / trừ */}
              {minusGroups.length > 0 && (
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">A. Phần cộng (+)</p>
              )}
              {plusGroups.map(g => (
                <GroupSection key={g.key} group={g} onOpenBooking={openBooking} onOpenPayment={openPayment} onOpenExpense={openExpense} />
              ))}
              {minusGroups.length > 0 && (
                <>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mt-2">B. Phần trừ (−)</p>
                  {minusGroups.map(g => (
                    <GroupSection key={g.key} group={g} onOpenBooking={openBooking} onOpenPayment={openPayment} onOpenExpense={openExpense} />
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer: dòng tổng */}
        {data && recon && (
          <div className="border-t border-border px-4 sm:px-5 py-3 bg-muted/30">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-foreground">
                TỔNG ({data.rowCount} dòng)
              </p>
              <p className={`text-sm font-bold ${recon.allMatch ? "text-foreground" : "text-red-600 dark:text-red-400"}`}>
                {vnd(recon.clientSum)}
              </p>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Tổng được cộng lại từ từng dòng ngay trên máy anh/chị — không lấy sẵn từ server.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
