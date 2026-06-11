import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Edit2, Trash2, Check, Package, Tag,
  DollarSign, Clock, Eye, EyeOff, AlertCircle, TrendingUp
} from "lucide-react";
import { formatVND } from "@/lib/utils";
import { Button } from "@/components/ui";
import { ServiceFormModal } from "./services";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Service = {
  id: number; name: string; code: string; category: string; description: string;
  type: string; price: number; costPrice: number; duration: string | null;
  includes: string[]; isActive: boolean; createdAt: string;
  sortOrder: number;
  splits: { role: string; amount: number; rateType: "fixed" | "percent"; notes?: string | null }[];
};

const CATEGORY_LABELS: Record<string, string> = {
  wedding: "Cưới", beauty: "Beauty", family: "Gia đình",
  makeup: "Makeup", album: "Album", other: "Khác",
};
const CATEGORY_COLORS: Record<string, string> = {
  wedding: "bg-rose-100 text-rose-700",
  beauty: "bg-purple-100 text-purple-700",
  family: "bg-blue-100 text-blue-700",
  makeup: "bg-pink-100 text-pink-700",
  album: "bg-amber-100 text-amber-700",
  other: "bg-muted text-muted-foreground",
};

export default function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [showEdit, setShowEdit] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [apiError, setApiError] = useState("");

  const serviceId = parseInt(id ?? "");

  console.log("[ServiceDetail] Xem gói id:", serviceId);

  const { data: service, isLoading, isError, error } = useQuery<Service>({
    queryKey: ["service", serviceId],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/services/${serviceId}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `Lỗi ${r.status}`);
      }
      const data = (await r.json()) as Service;
      return { ...data, sortOrder: data.sortOrder ?? 0, splits: data.splits ?? [] };
    },
    enabled: !isNaN(serviceId),
  });

  const updateService = useMutation({
    mutationFn: (body: Partial<Service>) =>
      fetch(`${BASE}/api/services/${serviceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async r => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi cập nhật");
        return r.json();
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["service", serviceId] });
      qc.invalidateQueries({ queryKey: ["services"] });
      setShowEdit(false);
      setApiError("");
    },
    onError: (e: Error) => setApiError(e.message),
  });

  const deleteService = useMutation({
    mutationFn: () =>
      fetch(`${BASE}/api/services/${serviceId}`, { method: "DELETE" }).then(r => {
        if (!r.ok) throw new Error("Không thể xoá gói này");
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["services"] });
      navigate("/services");
    },
    onError: (e: Error) => setApiError(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: (val: boolean) =>
      fetch(`${BASE}/api/services/${serviceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: val }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["service", serviceId] });
      qc.invalidateQueries({ queryKey: ["services"] });
    },
  });

  if (isNaN(serviceId)) {
    return (
      <div className="text-center py-20">
        <AlertCircle className="w-12 h-12 mx-auto mb-3 text-destructive opacity-60" />
        <p className="font-semibold text-destructive">ID gói không hợp lệ</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/services")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Quay lại
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 animate-pulse">
        <div className="h-8 w-48 bg-muted rounded" />
        <div className="h-64 bg-muted rounded-2xl" />
        <div className="h-32 bg-muted rounded-2xl" />
      </div>
    );
  }

  if (isError || !service) {
    return (
      <div className="text-center py-20">
        <AlertCircle className="w-12 h-12 mx-auto mb-3 text-destructive opacity-60" />
        <p className="font-semibold text-destructive">
          {(error as Error)?.message ?? "Không tìm thấy gói dịch vụ"}
        </p>
        {apiError && <p className="text-sm text-muted-foreground mt-1">{apiError}</p>}
        <Button variant="outline" className="mt-4" onClick={() => navigate("/services")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Quay lại danh sách
        </Button>
      </div>
    );
  }

  const profit = service.price > 0 && service.costPrice > 0
    ? Math.round((1 - service.costPrice / service.price) * 100)
    : null;

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      {/* Back + Actions */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate("/services")}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Dịch vụ & Gói
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => toggleActive.mutate(!service.isActive)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              service.isActive
                ? "bg-muted text-muted-foreground hover:bg-muted/80"
                : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
            }`}
          >
            {service.isActive ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {service.isActive ? "Ẩn gói" : "Hiển thị"}
          </button>
          <Button
            onClick={() => setShowEdit(true)}
            className="gap-2"
            size="sm"
          >
            <Edit2 className="w-4 h-4" /> Chỉnh sửa
          </Button>
          <button
            onClick={() => setDeleteConfirm(true)}
            className="p-2 rounded-lg text-destructive/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {apiError && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-xl text-destructive text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />{apiError}
          <button className="ml-auto text-xs underline" onClick={() => setApiError("")}>Đóng</button>
        </div>
      )}

      {/* Main Card */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm">
        {/* Header */}
        <div className="p-6 border-b border-border">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Package className="w-6 h-6 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${CATEGORY_COLORS[service.category] ?? CATEGORY_COLORS.other}`}>
                  {CATEGORY_LABELS[service.category] ?? service.category}
                </span>
                {service.code && (
                  <span className="text-xs text-muted-foreground font-mono bg-muted px-2 py-0.5 rounded">{service.code}</span>
                )}
                {!service.isActive && (
                  <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">Đang ẩn</span>
                )}
              </div>
              <h1 className="text-xl font-bold leading-snug">{service.name}</h1>
            </div>
          </div>

          {service.description && (
            <p className="text-sm text-muted-foreground leading-relaxed">{service.description}</p>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-border">
          <div className="bg-card p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <DollarSign className="w-3.5 h-3.5" /> Giá bán
            </div>
            <p className="text-xl font-bold text-primary">{formatVND(service.price)}</p>
          </div>
          <div className="bg-card p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <DollarSign className="w-3.5 h-3.5" /> Giá vốn
            </div>
            <p className="text-xl font-bold">{formatVND(service.costPrice)}</p>
          </div>
          <div className="bg-card p-4 col-span-2 sm:col-span-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <TrendingUp className="w-3.5 h-3.5" /> Lợi nhuận
            </div>
            <p className="text-xl font-bold text-emerald-600">
              {profit !== null ? `${profit}%` : "—"}
            </p>
            {profit !== null && (
              <p className="text-xs text-muted-foreground">{formatVND(service.price - service.costPrice)}</p>
            )}
          </div>
        </div>

        {/* Extra info */}
        <div className="p-4 flex flex-wrap gap-4 border-t border-border/50 bg-muted/20">
          <div className="flex items-center gap-1.5 text-sm">
            <Tag className="w-4 h-4 text-muted-foreground" />
            <span className="text-muted-foreground">Loại:</span>
            <span className="font-medium">{service.type === "package" ? "Gói dịch vụ" : "Dịch vụ thêm"}</span>
          </div>
          {service.duration && (
            <div className="flex items-center gap-1.5 text-sm">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">Thời gian:</span>
              <span className="font-medium">{service.duration}</span>
            </div>
          )}
        </div>
      </div>

      {/* Includes */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <h2 className="font-semibold mb-4 flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-500" />
          Chi tiết gói ({service.includes.length} mục)
        </h2>
        {service.includes.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Check className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p className="text-sm">Chưa có chi tiết gói</p>
            <button
              onClick={() => setShowEdit(true)}
              className="mt-2 text-sm text-primary hover:underline"
            >
              Nhấn Chỉnh sửa để thêm chi tiết
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {service.includes.map((item, idx) => (
              <div key={idx} className="flex items-start gap-3 p-3 bg-muted/30 rounded-xl">
                <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                </div>
                <span className="text-sm">{item}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom Actions */}
      <div className="flex gap-3 pb-4">
        <Button
          variant="outline"
          className="flex-1 gap-2"
          onClick={() => navigate("/bookings")}
        >
          Tạo đơn hàng từ gói này
        </Button>
        <Button
          variant="outline"
          className="flex-1 gap-2"
          onClick={() => navigate("/quotes")}
        >
          Tạo báo giá từ gói này
        </Button>
      </div>

      {/* Delete Confirm Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-background rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center flex-shrink-0">
                <Trash2 className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <h3 className="font-bold text-base">Xoá gói dịch vụ?</h3>
                <p className="text-sm text-muted-foreground">Hành động này không thể hoàn tác</p>
              </div>
            </div>
            <p className="text-sm mb-5 p-3 bg-muted/50 rounded-xl">
              Bạn chắc chắn muốn xoá gói <strong>"{service.name}"</strong>?
            </p>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setDeleteConfirm(false)}>
                Huỷ
              </Button>
              <Button
                className="flex-1 bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                onClick={() => deleteService.mutate()}
                disabled={deleteService.isPending}
              >
                {deleteService.isPending ? "Đang xoá..." : "Xoá gói này"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEdit && (
        <ServiceFormModal
          service={service}
          onClose={() => { setShowEdit(false); setApiError(""); }}
          onSave={(data) => updateService.mutate(data)}
          saving={updateService.isPending}
          error={apiError}
        />
      )}
    </div>
  );
}
