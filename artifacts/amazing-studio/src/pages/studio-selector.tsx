import { useState } from "react";
import { Building2, Camera, Loader2, LogOut, ShieldCheck } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { tenantCanRunApp, type TenantMembershipSummary } from "@/lib/auth-types";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Chủ studio",
  ADMIN: "Quản trị viên",
  STAFF: "Nhân viên",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Đang hoạt động",
  trial: "Đang dùng thử",
  provisioning: "Đang khởi tạo",
  suspended: "Đã tạm khóa",
  cancelled: "Đã hủy",
  provisioning_failed: "Khởi tạo lỗi",
};

export default function StudioSelectorPage({ onSelected }: { onSelected: () => void }) {
  const { memberships, platformUser, viewer, selectTenant, logout } = useStaffAuth();
  const [selectingId, setSelectingId] = useState<string | number | null>(null);
  const [error, setError] = useState("");

  const choose = async (tenant: TenantMembershipSummary) => {
    if (!tenantCanRunApp(tenant) || selectingId !== null) return;
    setSelectingId(tenant.id);
    setError("");
    try {
      await selectTenant(tenant.id);
      onSelected();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không thể mở studio này");
    } finally {
      setSelectingId(null);
    }
  };

  const displayName = platformUser?.name || viewer?.name || "Tài khoản Amazing Studio";
  const displayAvatar = platformUser?.avatar || viewer?.avatar;

  return (
    <div className="relative min-h-[100dvh] overflow-y-auto bg-gradient-to-br from-rose-50 via-pink-50 to-purple-50 px-4 py-10 dark:from-slate-950 dark:via-slate-900 dark:to-purple-950">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -right-40 -top-40 h-96 w-96 rounded-full bg-rose-200/40 blur-3xl dark:bg-rose-900/20" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-purple-200/40 blur-3xl dark:bg-purple-900/20" />
      </div>

      <div className="relative mx-auto w-full max-w-xl">
        <div className="mb-7 text-center">
          <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-400 to-purple-600 shadow-xl">
            <Camera className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold">Chọn studio làm việc</h1>
          <p className="mt-1 text-sm text-muted-foreground">Mỗi studio có dữ liệu và quyền truy cập riêng biệt.</p>
        </div>

        <div className="mb-4 flex items-center gap-3 rounded-2xl border bg-card/90 p-4 shadow-sm backdrop-blur">
          <Avatar className="h-11 w-11 border">
            <AvatarImage src={displayAvatar} alt={displayName} referrerPolicy="no-referrer" />
            <AvatarFallback>{displayName.trim().charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{displayName}</p>
            <p className="truncate text-xs text-muted-foreground">{platformUser?.email || viewer?.email || "Đã xác thực"}</p>
          </div>
          <button
            type="button"
            onClick={() => void logout().catch(caught => setError(caught instanceof Error ? caught.message : "Không thể đăng xuất"))}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10"
          >
            <LogOut className="h-4 w-4" /> Thoát
          </button>
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {memberships.map(tenant => {
            const enabled = tenantCanRunApp(tenant);
            const loading = selectingId === tenant.id;
            return (
              <button
                key={String(tenant.membershipId || tenant.id)}
                type="button"
                onClick={() => void choose(tenant)}
                disabled={!enabled || selectingId !== null}
                className="group flex w-full items-center gap-4 rounded-2xl border bg-card/90 p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 dark:bg-card/80"
              >
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <Building2 className="h-6 w-6" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-semibold">{tenant.name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${enabled ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                      {STATUS_LABEL[tenant.status] || tenant.status}
                    </span>
                  </div>
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5" /> {ROLE_LABEL[tenant.role] || tenant.role}
                  </p>
                </div>
                <span className="text-sm font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  Mở →
                </span>
              </button>
            );
          })}
        </div>

        {memberships.length === 0 && (
          <div className="rounded-2xl border border-dashed bg-card/70 px-6 py-10 text-center">
            <Building2 className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">Tài khoản chưa thuộc studio nào</p>
            <p className="mt-1 text-sm text-muted-foreground">Vui lòng liên hệ quản trị viên để được mời vào studio.</p>
          </div>
        )}
      </div>
    </div>
  );
}
