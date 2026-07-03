/**
 * contract-detail.tsx — trang hợp đồng NỘI BỘ (/contracts/:id).
 * Cùng 1 bản hợp đồng với trang public (/contract/:token) qua ContractDocument,
 * nhưng có: nút quay lại đúng đơn/lịch chụp, chỉnh sửa, in/PDF, copy link online,
 * ký Bên A, tab Thanh toán + tab Lịch sử chỉnh sửa (CHỈ nội bộ — khách không thấy).
 */
import { useState } from "react";
import { useRoute, useLocation, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Printer, Link2, Check, RefreshCw } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { formatVND } from "@/lib/utils";
import ContractDocument from "@/components/contract/ContractDocument";
import type { ContractPayload, ContractChangeLogRow } from "@/components/contract/contract-types";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("amazingStudioToken_v2");
  const headers = { ...(opts.headers as Record<string, string> ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return fetch(url, { ...opts, headers });
}

const FIELD_LABEL: Record<string, string> = {
  title: "Tiêu đề / dịch vụ",
  content: "Điều khoản",
  status: "Trạng thái",
  signedAt: "Ngày ký",
  expiresAt: "Ngày hết hạn",
  totalValue: "Tổng giá trị",
  notes: "Ghi chú nội bộ",
  customer_signature: "Khách ký tên",
  studio_signature: "Studio ký tên",
  resign_requested: "Yêu cầu khách ký lại",
};

function fmtDateTime(d: string): string {
  const t = new Date(d);
  return isNaN(t.getTime()) ? d : t.toLocaleString("vi-VN");
}

export default function ContractDetailPage() {
  const [, params] = useRoute("/contracts/:id");
  const contractId = params?.id ? parseInt(params.id) : NaN;
  const [, setLocation] = useLocation();
  const search = useSearch();
  const qc = useQueryClient();
  const { effectiveIsAdmin } = useStaffAuth();

  const sp = new URLSearchParams(search);
  const from = sp.get("from");
  const fromBookingId = sp.get("bookingId");

  const [activeTab, setActiveTab] = useState("contract");
  const [copied, setCopied] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ title: "", totalValue: "", status: "", expiresAt: "", notes: "", content: "" });
  const [actionErr, setActionErr] = useState<string | null>(null);

  const { data: payload, isLoading, error } = useQuery<ContractPayload>({
    queryKey: ["contract-document", contractId],
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/contracts/${contractId}/document`);
      if (!r.ok) throw new Error(`Không tải được hợp đồng (HTTP ${r.status})`);
      return r.json();
    },
    enabled: Number.isFinite(contractId),
  });

  const { data: changeLog = [], isLoading: logLoading } = useQuery<ContractChangeLogRow[]>({
    queryKey: ["contract-change-log", contractId],
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/contracts/${contractId}/change-log`);
      return r.ok ? r.json() : [];
    },
    enabled: Number.isFinite(contractId) && activeTab === "history",
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["contract-document", contractId] });
    qc.invalidateQueries({ queryKey: ["contract-change-log", contractId] });
    qc.invalidateQueries({ queryKey: ["contracts"] });
  };

  const signStudioMutation = useMutation({
    mutationFn: async (dataUrl: string) => {
      const r = await authFetch(`${BASE}/api/contracts/${contractId}/sign-studio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureData: dataUrl }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? "Không lưu được chữ ký");
    },
    onSuccess: invalidate,
    onError: (e: Error) => setActionErr(e.message),
  });

  const copyLinkMutation = useMutation({
    mutationFn: async () => {
      const r = await authFetch(`${BASE}/api/contracts/${contractId}/sign-link`, { method: "POST" });
      if (!r.ok) throw new Error("Không tạo được link hợp đồng");
      const data = await r.json();
      await navigator.clipboard.writeText(data.signUrl);
      return data.signUrl as string;
    },
    onSuccess: () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    },
    onError: (e: Error) => setActionErr(e.message),
  });

  const resignMutation = useMutation({
    mutationFn: async (enable: boolean) => {
      const r = await authFetch(`${BASE}/api/contracts/${contractId}/request-resign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enable }),
      });
      if (!r.ok) throw new Error("Không cập nhật được yêu cầu ký lại");
    },
    onSuccess: invalidate,
    onError: (e: Error) => setActionErr(e.message),
  });

  const editMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        title: editForm.title,
        status: editForm.status,
        notes: editForm.notes,
        content: editForm.content,
      };
      if (editForm.totalValue !== "") body.totalValue = Number(editForm.totalValue) || 0;
      body.expiresAt = editForm.expiresAt || null;
      const r = await authFetch(`${BASE}/api/contracts/${contractId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Không lưu được hợp đồng");
    },
    onSuccess: () => {
      setEditOpen(false);
      invalidate();
    },
    onError: (e: Error) => setActionErr(e.message),
  });

  const handleBack = () => {
    if (from === "calendar" && fromBookingId) { setLocation(`/calendar?bookingId=${fromBookingId}`); return; }
    if (from === "bookings" && fromBookingId) { setLocation(`/bookings?bookingId=${fromBookingId}`); return; }
    if (from === "contracts") { setLocation("/contracts"); return; }
    if (window.history.length > 1) { window.history.back(); return; }
    setLocation("/contracts");
  };

  const handlePrint = () => {
    // In luôn nội dung hợp đồng — ép về tab Hợp đồng trước để Radix không unmount nội dung.
    setActiveTab("contract");
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  };

  const openEdit = () => {
    if (!payload) return;
    setEditForm({
      title: payload.contract.title ?? "",
      totalValue: String(payload.contract.totalValue ?? ""),
      status: payload.contract.status ?? "active",
      expiresAt: payload.contract.expiresAt ?? "",
      notes: payload.internal?.notes ?? "",
      content: payload.contract.content ?? "",
    });
    setEditOpen(true);
  };

  const backLabel =
    from === "calendar" ? "Quay lại lịch chụp" : from === "bookings" ? "Quay lại đơn hàng" : "Quay lại";

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Đang tải hợp đồng...</div>;
  }
  if (error || !payload) {
    return (
      <div className="p-8 text-center">
        <div className="text-destructive font-semibold mb-3">{(error as Error)?.message ?? "Không tìm thấy hợp đồng"}</div>
        <Button variant="outline" onClick={handleBack}><ArrowLeft className="w-4 h-4 mr-1" /> Quay lại</Button>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-[980px] mx-auto print:p-0 print:max-w-none">
      {/* Thanh công cụ — ẩn khi in */}
      <div className="print:hidden">
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <Button variant="ghost" size="sm" onClick={handleBack} data-testid="btn-back">
            <ArrowLeft className="w-4 h-4 mr-1" /> {backLabel}
          </Button>
          <div className="flex-1" />
          {effectiveIsAdmin ? (
            <Button variant="outline" size="sm" onClick={openEdit}>
              <Pencil className="w-3.5 h-3.5 mr-1" /> Chỉnh sửa hợp đồng
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={handlePrint}>
            <Printer className="w-3.5 h-3.5 mr-1" /> In / Lưu PDF
          </Button>
          <Button size="sm" onClick={() => copyLinkMutation.mutate()} disabled={copyLinkMutation.isPending}>
            {copied ? <Check className="w-3.5 h-3.5 mr-1" /> : <Link2 className="w-3.5 h-3.5 mr-1" />}
            {copied ? "Đã sao chép!" : "Sao chép link hợp đồng online"}
          </Button>
        </div>

        {actionErr ? (
          <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 text-sm">
            {actionErr}
            <button className="ml-2 underline" onClick={() => setActionErr(null)}>đóng</button>
          </div>
        ) : null}

        {/* Yêu cầu khách ký lại — chỉ chủ động bởi admin, không bao giờ tự động */}
        {effectiveIsAdmin && payload.signState === "signed" ? (
          <div className="mb-3 flex items-center gap-2 text-sm">
            <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
            {payload.resignRequested ? (
              <>
                <span className="text-blue-700 font-medium">Đang yêu cầu khách ký xác nhận lại.</span>
                <Button variant="outline" size="sm" onClick={() => resignMutation.mutate(false)} disabled={resignMutation.isPending}>
                  Hủy yêu cầu
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => resignMutation.mutate(true)} disabled={resignMutation.isPending}>
                Yêu cầu khách ký lại
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="mb-4 print:hidden">
          <TabsTrigger value="contract">Hợp đồng</TabsTrigger>
          <TabsTrigger value="payment">Thanh toán</TabsTrigger>
          <TabsTrigger value="history">Lịch sử chỉnh sửa</TabsTrigger>
        </TabsList>

        <TabsContent value="contract" forceMount className="data-[state=inactive]:hidden">
          <div className="rounded-xl border print:border-0 overflow-hidden">
            <ContractDocument
              payload={payload}
              mode="internal"
              onSignStudio={(dataUrl) => signStudioMutation.mutate(dataUrl)}
              signingStudio={signStudioMutation.isPending}
            />
          </div>
        </TabsContent>

        <TabsContent value="payment" className="print:hidden">
          <div className="rounded-xl border p-4 sm:p-6 bg-card">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              <div className="rounded-lg bg-muted p-3">
                <div className="text-xs text-muted-foreground">Tổng tiền</div>
                <div className="font-bold text-lg">{formatVND(payload.money.totalAmount)}</div>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <div className="text-xs text-muted-foreground">Giảm giá</div>
                <div className="font-bold text-lg">{formatVND(payload.money.discountAmount)}</div>
              </div>
              <div className="rounded-lg bg-emerald-50 p-3">
                <div className="text-xs text-emerald-700">Đã thanh toán</div>
                <div className="font-bold text-lg text-emerald-700">{formatVND(payload.money.paidAmount)}</div>
              </div>
              <div className="rounded-lg bg-amber-50 p-3">
                <div className="text-xs text-amber-700">Còn lại</div>
                <div className="font-bold text-lg text-amber-700">{formatVND(payload.money.remainingAmount)}</div>
              </div>
            </div>

            {payload.payments.length === 0 ? (
              <div className="text-sm text-muted-foreground italic">Chưa có thanh toán nào.</div>
            ) : (
              <div className="space-y-2">
                {payload.payments.map((p, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-lg border p-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold">
                        +{formatVND(p.amount)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">
                          · {p.paymentType === "deposit" ? "Cọc" : "Thanh toán"} ·{" "}
                          {p.paymentMethod === "bank_transfer" ? "Chuyển khoản" : "Tiền mặt"}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {new Date(p.paidDate || p.paidAt || "").toLocaleDateString("vi-VN")}
                        {p.collectorName ? ` · Người thu: ${p.collectorName}` : ""}
                      </div>
                      {p.notes ? <div className="text-xs text-muted-foreground mt-0.5">{p.notes}</div> : null}
                    </div>
                    {p.proofImages.length > 0 ? (
                      <div className="flex gap-1.5">
                        {p.proofImages.map((u, j) => (
                          <a key={j} href={u} target="_blank" rel="noreferrer">
                            <img src={u} alt="Ảnh xác nhận" className="h-14 w-14 object-cover rounded-md border" loading="lazy" />
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="history" className="print:hidden">
          <div className="rounded-xl border p-4 sm:p-6 bg-card">
            <div className="text-xs text-muted-foreground mb-4">
              🔒 Lịch sử chỉnh sửa NỘI BỘ — khách mở link online không bao giờ thấy phần này.
            </div>
            {logLoading ? (
              <div className="text-sm text-muted-foreground">Đang tải...</div>
            ) : changeLog.length === 0 ? (
              <div className="text-sm text-muted-foreground italic">Chưa có chỉnh sửa nào được ghi lại.</div>
            ) : (
              <div className="space-y-2">
                {changeLog.map((c) => (
                  <div key={c.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="font-semibold">{FIELD_LABEL[c.fieldChanged] ?? c.fieldChanged}</span>
                      <span className="text-xs text-muted-foreground">
                        {fmtDateTime(c.createdAt)} · {c.changedByName ?? "Hệ thống / không đăng nhập"}
                      </span>
                    </div>
                    {(c.oldValue || c.newValue) && c.fieldChanged !== "customer_signature" && c.fieldChanged !== "studio_signature" ? (
                      <div className="mt-1.5 text-xs">
                        <span className="text-red-600 line-through break-all">{c.oldValue ?? "(trống)"}</span>
                        <span className="mx-1.5 text-muted-foreground">→</span>
                        <span className="text-emerald-700 break-all">{c.newValue ?? "(trống)"}</span>
                      </div>
                    ) : null}
                    {c.reason ? <div className="mt-1 text-xs text-muted-foreground">Lý do: {c.reason}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Dialog chỉnh sửa — admin */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Chỉnh sửa hợp đồng {payload.contract.contractCode}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Tiêu đề / dịch vụ</label>
              <Input value={editForm.title} onChange={(e) => setEditForm(f => ({ ...f, title: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Tổng giá trị (đ)</label>
                <Input
                  type="number"
                  value={editForm.totalValue}
                  onChange={(e) => setEditForm(f => ({ ...f, totalValue: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Trạng thái</label>
                <select
                  className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  value={editForm.status}
                  onChange={(e) => setEditForm(f => ({ ...f, status: e.target.value }))}
                >
                  <option value="draft">Nháp</option>
                  <option value="active">Hiệu lực</option>
                  <option value="signed">Đã ký</option>
                  <option value="expired">Hết hạn</option>
                  <option value="cancelled">Đã hủy</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Ngày hết hạn</label>
              <Input type="date" value={editForm.expiresAt} onChange={(e) => setEditForm(f => ({ ...f, expiresAt: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Điều khoản (hiện trên hợp đồng)</label>
              <Textarea rows={5} value={editForm.content} onChange={(e) => setEditForm(f => ({ ...f, content: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Ghi chú nội bộ (khách không thấy)</label>
              <Textarea rows={2} value={editForm.notes} onChange={(e) => setEditForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className="text-[11px] text-muted-foreground">
              Mọi thay đổi được ghi vào tab Lịch sử chỉnh sửa. Nếu khách đã ký, hệ thống hiện cảnh báo nội bộ
              "đã cập nhật sau khi ký" — khách KHÔNG bị bắt ký lại trừ khi bạn chủ động yêu cầu.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Hủy</Button>
            <Button onClick={() => editMutation.mutate()} disabled={editMutation.isPending}>
              {editMutation.isPending ? "Đang lưu..." : "Lưu thay đổi"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
