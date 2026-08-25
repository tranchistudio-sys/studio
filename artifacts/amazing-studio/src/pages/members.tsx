import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CheckCircle2,
  KeyRound,
  Loader2,
  Mail,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { API_BASE } from "@/lib/api-base";
import type { TenantRole } from "@/lib/auth-types";

interface TenantMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  avatar?: string;
  role: TenantRole;
  status: "active" | "suspended" | string;
  lastLoginAt?: string | null;
  tenantStaffId: number;
  permissions?: Record<string, unknown>;
  isCurrent?: boolean;
}

interface TenantInvitation {
  id: string;
  email: string;
  role: "ADMIN" | "STAFF";
  status: string;
  expiresAt?: string | null;
  createdAt?: string;
  tenantStaffId: number;
  permissions?: Record<string, unknown>;
}

interface StaffCandidate {
  id: number;
  name: string;
  email?: string | null;
  isActive: boolean;
  staffType?: string | null;
}

type ConfirmAction =
  | { kind: "status"; member: TenantMember; status: "active" | "suspended" }
  | { kind: "revoke"; member: TenantMember }
  | null;

const ROLE_LABEL: Record<TenantRole, string> = {
  OWNER: "Chủ studio",
  ADMIN: "Quản trị viên",
  STAFF: "Nhân viên",
};

function isCollaboratorPermissions(permissions?: Record<string, unknown>): boolean {
  return permissions?.accessPreset === "COLLABORATOR";
}

function formatLastLogin(value?: string | null): string {
  if (!value) return "Chưa đăng nhập";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Chưa đăng nhập";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

async function readApiError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: string; message?: string };
    return data.error || data.message || `Lỗi ${response.status}`;
  } catch {
    return `Lỗi ${response.status}`;
  }
}

export default function MembersPage() {
  const queryClient = useQueryClient();
  const { activeTenant, canManageMembers, csrfToken, token } = useStaffAuth();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "STAFF">("STAFF");
  const [selectedStaffId, setSelectedStaffId] = useState<number | null>(null);
  const [pageError, setPageError] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const api = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const headers = new Headers(options.headers);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.method && options.method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers,
    });
    if (!response.ok) throw new Error(await readApiError(response));
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  };

  const membersQuery = useQuery({
    queryKey: ["tenant-members", activeTenant?.id],
    queryFn: () => api<{ members: TenantMember[] }>("/api/tenant/members"),
    enabled: canManageMembers && Boolean(activeTenant),
  });
  const invitationsQuery = useQuery({
    queryKey: ["tenant-invitations", activeTenant?.id],
    queryFn: () => api<{ invitations: TenantInvitation[] }>("/api/tenant/invitations"),
    enabled: canManageMembers && Boolean(activeTenant),
  });
  const staffQuery = useQuery({
    queryKey: ["tenant-staff-candidates", activeTenant?.id],
    queryFn: () => api<{ staff: StaffCandidate[] }>("/api/tenant/staff-candidates"),
    enabled: canManageMembers && Boolean(activeTenant) && inviteOpen,
  });

  const members = membersQuery.data?.members ?? [];
  const invitations = (invitationsQuery.data?.invitations ?? []).filter(invitation => invitation.status === "pending");
  const staffCandidates = staffQuery.data?.staff ?? [];
  const isOwner = activeTenant?.role === "OWNER";
  const selectedStaff = useMemo(
    () => staffCandidates.find(staff => staff.id === selectedStaffId) ?? null,
    [selectedStaffId, staffCandidates],
  );

  const refreshLists = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tenant-members", activeTenant?.id] }),
      queryClient.invalidateQueries({ queryKey: ["tenant-invitations", activeTenant?.id] }),
      queryClient.invalidateQueries({ queryKey: ["tenant-staff-candidates", activeTenant?.id] }),
    ]);
  };

  const inviteMutation = useMutation({
    mutationFn: () => api("/api/tenant/invitations", {
      method: "POST",
      body: JSON.stringify({
        email: inviteEmail.trim(),
        role: inviteRole,
        tenantStaffId: selectedStaffId,
      }),
    }),
    onSuccess: async () => {
      await refreshLists();
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("STAFF");
      setSelectedStaffId(null);
      setPageError("");
    },
    onError: error => setPageError(error instanceof Error ? error.message : "Không tạo được lời mời"),
  });

  const memberMutation = useMutation({
    mutationFn: async (input:
      | { kind: "role"; member: TenantMember; role: TenantRole }
      | { kind: "status"; member: TenantMember; status: "active" | "suspended" }
      | { kind: "revoke"; member: TenantMember }
    ) => {
      if (input.kind === "revoke") {
        return api(`/api/tenant/members/${input.member.id}/revoke-sessions`, { method: "POST" });
      }
      const body = input.kind === "role" ? { role: input.role } : { status: input.status };
      return api(`/api/tenant/members/${input.member.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    onSuccess: async () => {
      setConfirmAction(null);
      setPageError("");
      await refreshLists();
    },
    onError: error => {
      setConfirmAction(null);
      setPageError(error instanceof Error ? error.message : "Không cập nhật được thành viên");
    },
  });

  const chooseStaff = (rawId: string) => {
    const staffId = Number(rawId);
    const staff = staffCandidates.find(candidate => candidate.id === staffId);
    setSelectedStaffId(staffId);
    if (staff?.email) setInviteEmail(staff.email);
    if (staff?.staffType === "freelancer") setInviteRole("STAFF");
  };

  const submitInvite = () => {
    setPageError("");
    if (!selectedStaffId) {
      setPageError("Vui lòng chọn hồ sơ nhân sự để liên kết tài khoản.");
      return;
    }
    if (!inviteEmail.trim() || !inviteEmail.includes("@")) {
      setPageError("Vui lòng nhập địa chỉ Gmail hợp lệ.");
      return;
    }
    inviteMutation.mutate();
  };

  if (!canManageMembers) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <ShieldCheck className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
        <h1 className="text-xl font-semibold">Bạn không có quyền quản lý thành viên</h1>
        <p className="mt-2 text-sm text-muted-foreground">Chỉ OWNER hoặc ADMIN được cấp quyền mới sử dụng trang này.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Users className="h-6 w-6 text-primary" /> Tài khoản &amp; phân quyền
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Thành viên của {activeTenant?.name}. Mỗi người dùng tài khoản Google riêng của mình.
          </p>
        </div>
        <Button onClick={() => { setPageError(""); setInviteOpen(true); }} className="gap-2 sm:self-auto">
          <UserPlus className="h-4 w-4" /> Mời thành viên
        </Button>
      </div>

      {pageError && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {pageError}
        </div>
      )}

      <div className="rounded-2xl border bg-card shadow-sm">
        <div className="border-b px-5 py-4">
          <h2 className="font-semibold">Thành viên đang sử dụng</h2>
          <p className="text-xs text-muted-foreground">Role nền tảng và chức vụ nghiệp vụ được quản lý riêng.</p>
        </div>

        {membersQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Đang tải thành viên…
          </div>
        ) : membersQuery.isError ? (
          <div className="px-5 py-12 text-center text-sm text-destructive">
            {membersQuery.error instanceof Error ? membersQuery.error.message : "Không tải được thành viên"}
          </div>
        ) : members.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">Chưa có thành viên.</div>
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Thành viên</TableHead>
                    <TableHead>Quyền</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead>Lần đăng nhập gần nhất</TableHead>
                    <TableHead className="text-right">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map(member => (
                    <TableRow key={member.id}>
                      <TableCell><MemberIdentity member={member} /></TableCell>
                      <TableCell>
                        <RoleControl
                          member={member}
                          isOwner={isOwner}
                          disabled={memberMutation.isPending}
                          onChange={role => memberMutation.mutate({ kind: "role", member, role })}
                        />
                      </TableCell>
                      <TableCell><MemberStatus member={member} /></TableCell>
                      <TableCell className="text-muted-foreground">{formatLastLogin(member.lastLoginAt)}</TableCell>
                      <TableCell className="text-right">
                        <MemberActions member={member} managerIsOwner={isOwner} busy={memberMutation.isPending} onConfirm={setConfirmAction} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="divide-y md:hidden">
              {members.map(member => (
                <div key={member.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <MemberIdentity member={member} />
                    <MemberStatus member={member} />
                  </div>
                  <div className="grid grid-cols-[1fr_auto] items-center gap-3">
                    <RoleControl
                      member={member}
                      isOwner={isOwner}
                      disabled={memberMutation.isPending}
                      onChange={role => memberMutation.mutate({ kind: "role", member, role })}
                    />
                    <MemberActions member={member} managerIsOwner={isOwner} busy={memberMutation.isPending} onConfirm={setConfirmAction} />
                  </div>
                  <p className="text-xs text-muted-foreground">Đăng nhập gần nhất: {formatLastLogin(member.lastLoginAt)}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {invitations.length > 0 && (
        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold">Lời mời đang chờ</h2>
            <p className="text-xs text-muted-foreground">Người được mời chỉ cần đăng nhập đúng Gmail này.</p>
          </div>
          <div className="divide-y">
            {invitations.map(invitation => (
              <div key={invitation.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                    <Mail className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{invitation.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {isCollaboratorPermissions(invitation.permissions) ? "CTV / Freelancer" : ROLE_LABEL[invitation.role]} · hết hạn {invitation.expiresAt ? formatLastLogin(invitation.expiresAt) : "theo chính sách hệ thống"}
                    </p>
                  </div>
                </div>
                <Badge variant="secondary">{invitation.status === "pending" ? "Đang chờ" : invitation.status}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog open={inviteOpen} onOpenChange={open => { if (!inviteMutation.isPending) setInviteOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mời thành viên</DialogTitle>
            <DialogDescription>
              Chọn đúng hồ sơ nhân sự và Gmail mà người đó sẽ dùng để đăng nhập.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {pageError && (
              <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {pageError}
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Hồ sơ nhân sự</Label>
              <Select value={selectedStaffId ? String(selectedStaffId) : ""} onValueChange={chooseStaff}>
                <SelectTrigger>
                  <SelectValue placeholder={staffQuery.isLoading ? "Đang tải nhân sự…" : "Chọn nhân viên"} />
                </SelectTrigger>
                <SelectContent>
                  {staffCandidates.filter(staff => staff.isActive).map(staff => (
                    <SelectItem key={staff.id} value={String(staff.id)}>
                      {staff.name}{staff.staffType === "freelancer" ? " · CTV" : ""}{staff.email ? ` · ${staff.email}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedStaff && !selectedStaff.email && (
                <p className="text-xs text-amber-600">Hồ sơ này chưa có email; nhập Gmail chính xác bên dưới.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Gmail được cấp quyền</Label>
              <Input
                id="invite-email"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="nhanvien@gmail.com"
                value={inviteEmail}
                onChange={event => setInviteEmail(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Quyền trong studio</Label>
              <Select
                value={inviteRole}
                onValueChange={value => setInviteRole(value as "ADMIN" | "STAFF")}
                disabled={selectedStaff?.staffType === "freelancer"}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="STAFF">Nhân viên</SelectItem>
                  {isOwner && <SelectItem value="ADMIN">Quản trị viên</SelectItem>}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {selectedStaff?.staffType === "freelancer"
                  ? "CTV / Freelancer chỉ được xem Lịch của tôi."
                  : "Không thể cấp PLATFORM_OWNER hoặc chuyển quyền sở hữu tại đây."}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)} disabled={inviteMutation.isPending}>Hủy</Button>
            <Button onClick={submitInvite} disabled={inviteMutation.isPending} className="gap-2">
              {inviteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              Tạo lời mời
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(confirmAction)} onOpenChange={open => { if (!open && !memberMutation.isPending) setConfirmAction(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.kind === "revoke" ? "Thu hồi toàn bộ phiên?" : confirmAction?.status === "suspended" ? "Khóa tài khoản?" : "Mở khóa tài khoản?"}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.kind === "revoke"
                ? `${confirmAction.member.name} sẽ phải đăng nhập lại trên tất cả thiết bị.`
                : confirmAction?.status === "suspended"
                  ? `${confirmAction?.member.name} sẽ mất quyền gọi API ngay lập tức.`
                  : `${confirmAction?.member.name} sẽ được phép đăng nhập lại.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)} disabled={memberMutation.isPending}>Hủy</Button>
            <Button
              variant={confirmAction?.kind === "status" && confirmAction.status === "active" ? "default" : "destructive"}
              disabled={!confirmAction || memberMutation.isPending}
              onClick={() => {
                if (!confirmAction) return;
                memberMutation.mutate(confirmAction.kind === "revoke"
                  ? { kind: "revoke", member: confirmAction.member }
                  : { kind: "status", member: confirmAction.member, status: confirmAction.status });
              }}
            >
              {memberMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Xác nhận
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MemberIdentity({ member }: { member: TenantMember }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar className="h-10 w-10 border">
        <AvatarImage src={member.avatar} alt={member.name} referrerPolicy="no-referrer" />
        <AvatarFallback>{member.name.trim().charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-semibold">{member.name}</p>
          {isCollaboratorPermissions(member.permissions) && <Badge variant="secondary" className="text-[10px]">CTV</Badge>}
          {member.isCurrent && <Badge variant="outline" className="text-[10px]">Bạn</Badge>}
        </div>
        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
      </div>
    </div>
  );
}

function MemberStatus({ member }: { member: TenantMember }) {
  const active = member.status === "active";
  return (
    <Badge className={active ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100" : "bg-red-100 text-red-700 hover:bg-red-100"}>
      {active ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <Ban className="mr-1 h-3 w-3" />}
      {active ? "Hoạt động" : "Đã khóa"}
    </Badge>
  );
}

function RoleControl({
  member,
  isOwner,
  disabled,
  onChange,
}: {
  member: TenantMember;
  isOwner: boolean;
  disabled: boolean;
  onChange: (role: TenantRole) => void;
}) {
  if (isCollaboratorPermissions(member.permissions)) {
    return <Badge variant="secondary"><ShieldCheck className="mr-1 h-3 w-3" /> CTV / Freelancer</Badge>;
  }
  if (!isOwner || member.isCurrent) {
    return <Badge variant="secondary"><ShieldCheck className="mr-1 h-3 w-3" /> {ROLE_LABEL[member.role]}</Badge>;
  }
  return (
    <Select value={member.role} onValueChange={value => onChange(value as TenantRole)} disabled={disabled}>
      <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="OWNER">Chủ studio</SelectItem>
        <SelectItem value="ADMIN">Quản trị viên</SelectItem>
        <SelectItem value="STAFF">Nhân viên</SelectItem>
      </SelectContent>
    </Select>
  );
}

function MemberActions({
  member,
  managerIsOwner,
  busy,
  onConfirm,
}: {
  member: TenantMember;
  managerIsOwner: boolean;
  busy: boolean;
  onConfirm: (action: ConfirmAction) => void;
}) {
  if (member.isCurrent || (!managerIsOwner && member.role !== "STAFF")) {
    return <span className="text-xs text-muted-foreground">Được bảo vệ</span>;
  }
  return (
    <div className="inline-flex items-center justify-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        title="Thu hồi mọi phiên đăng nhập"
        onClick={() => onConfirm({ kind: "revoke", member })}
      >
        <KeyRound className="h-4 w-4" />
        <span className="sr-only">Thu hồi mọi phiên</span>
      </Button>
      <Button
        size="sm"
        variant={member.status === "active" ? "outline" : "default"}
        disabled={busy}
        title={member.status === "active" ? "Khóa tài khoản" : "Mở khóa tài khoản"}
        onClick={() => onConfirm({ kind: "status", member, status: member.status === "active" ? "suspended" : "active" })}
      >
        {member.status === "active" ? <Ban className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        <span className="sr-only">{member.status === "active" ? "Khóa" : "Mở khóa"}</span>
      </Button>
    </div>
  );
}
