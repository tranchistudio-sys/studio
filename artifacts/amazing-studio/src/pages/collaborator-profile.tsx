import { Building2, Mail, ShieldCheck, UserRound } from "lucide-react";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

export default function CollaboratorProfilePage() {
  const { viewer, platformUser, activeTenant } = useStaffAuth();
  const name = viewer?.name ?? platformUser?.name ?? "CTV/Freelancer";
  const email = platformUser?.email ?? viewer?.email;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserRound className="h-7 w-7" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold">{name}</h1>
            <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700">
              <ShieldCheck className="h-3.5 w-3.5" /> CTV / Freelancer
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border bg-card p-5 shadow-sm">
        <h2 className="font-semibold">Thông tin tài khoản</h2>
        <div className="flex items-center gap-3 text-sm">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span>{activeTenant?.name ?? "Amazing Studio"}</span>
        </div>
        {email && (
          <div className="flex items-center gap-3 text-sm">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{email}</span>
          </div>
        )}
        <p className="pt-2 text-xs leading-relaxed text-muted-foreground">
          Tài khoản này chỉ được xem những lịch công việc mà Studio đã phân công trực tiếp cho bạn.
        </p>
      </section>
    </div>
  );
}
