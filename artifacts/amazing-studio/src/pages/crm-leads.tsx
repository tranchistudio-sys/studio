import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, X, Funnel, UserCheck, ChevronDown, MessageSquare, Clock, Save } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("amazingStudioToken_v2");
  const headers = { ...(opts.headers as Record<string, string> ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return fetch(url, { ...opts, headers });
}

type CrmLead = {
  id: number;
  name: string;
  phone: string | null;
  message: string | null;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  source: string | null;
  status: string | null;
  type: string | null;
  channel: string | null;
  notes: string | null;
  facebookUserId: string | null;
  avatarUrl: string | null;
  createdAt: string;
};

const STATUS_OPTIONS = [
  { value: "new",      label: "Mới",           color: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  { value: "chatting", label: "Đang trao đổi", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  { value: "hot",      label: "Hot",           color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
  { value: "lost",     label: "Mất",           color: "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500" },
];

const TYPE_OPTIONS = [
  { value: "wedding", label: "Cưới",      color: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
  { value: "beauty",  label: "Làm đẹp",   color: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300" },
  { value: "unknown", label: "Chưa biết", color: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
];

const CHANNEL_OPTIONS = [
  { value: "inbox",   label: "Inbox",   color: "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300" },
  { value: "comment", label: "Comment", color: "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300" },
  { value: "ads",     label: "Ads",     color: "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-300" },
];

const SOURCE_OPTIONS = ["facebook", "zalo", "instagram", "website", "giới thiệu", "khác"];

function statusMeta(v: string | null) {
  return STATUS_OPTIONS.find(s => s.value === v) ?? STATUS_OPTIONS[0];
}
function typeMeta(v: string | null) {
  return TYPE_OPTIONS.find(t => t.value === v) ?? TYPE_OPTIONS[2];
}
const CHANNEL_UNKNOWN = { value: "", label: "—", color: "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500" };
function channelMeta(v: string | null) {
  if (!v) return CHANNEL_UNKNOWN;
  return CHANNEL_OPTIONS.find(c => c.value === v) ?? CHANNEL_UNKNOWN;
}

const EMPTY_FORM = { name: "", phone: "", message: "", source: "facebook" };

function formatDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${className}`}>
      {children}
    </span>
  );
}

export default function CrmLeadsPage() {
  const queryClient = useQueryClient();

  // Add lead modal
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  // Filters
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterSource, setFilterSource] = useState("all");
  const [filterType, setFilterType]     = useState("all");

  // Drawer
  const [selectedLead, setSelectedLead] = useState<CrmLead | null>(null);
  const [drawerNotes, setDrawerNotes]   = useState("");
  const [notesSaved, setNotesSaved]     = useState(false);

  const { data: leads = [], isLoading } = useQuery<CrmLead[]>({
    queryKey: ["crm-leads"],
    queryFn: () => authFetch(`${BASE}/api/crm-leads`).then(r => {
      if (!r.ok) throw new Error("Lỗi tải dữ liệu");
      return r.json().then((rows: (Omit<CrmLead, "lastMessageAt"> & { lastMessageAt: string | null })[]) =>
        rows.map(row => ({ ...row, lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt) : null }))
      );
    }),
  });

  // Keep drawer data fresh when query refetches
  useEffect(() => {
    if (!selectedLead) return;
    const fresh = leads.find(l => l.id === selectedLead.id);
    if (fresh) setSelectedLead(fresh);
  }, [leads]);

  const filteredLeads = leads.filter(l => {
    if (filterStatus !== "all" && l.status !== filterStatus) return false;
    if (filterSource !== "all" && l.source !== filterSource) return false;
    if (filterType !== "all" && l.type !== filterType) return false;
    return true;
  });

  const patchLead = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      authFetch(`${BASE}/api/crm-leads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Lỗi"); }
        return r.json() as Promise<CrmLead>;
      }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
      setSelectedLead(updated);
    },
  });

  const createLead = useMutation({
    mutationFn: (data: typeof EMPTY_FORM) =>
      authFetch(`${BASE}/api/crm-leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Lỗi"); }
        return r.json();
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
      setShowModal(false);
      setForm(EMPTY_FORM);
      setFormError("");
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const convertLead = useMutation({
    mutationFn: (leadId: number) =>
      authFetch(`${BASE}/api/crm-leads/${leadId}/convert-to-customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Lỗi"); }
        return r.json();
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
      setSelectedLead(null);
    },
    onError: (e: Error) => alert(e.message),
  });

  function openDrawer(lead: CrmLead) {
    setSelectedLead(lead);
    setDrawerNotes(lead.notes ?? "");
    setNotesSaved(false);
  }

  function closeDrawer() {
    setSelectedLead(null);
    setNotesSaved(false);
  }

  function handleSaveNotes() {
    if (!selectedLead) return;
    patchLead.mutate(
      { id: selectedLead.id, data: { notes: drawerNotes } },
      { onSuccess: () => { setNotesSaved(true); setTimeout(() => setNotesSaved(false), 2000); } }
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    if (!form.name.trim()) { setFormError("Vui lòng nhập tên khách"); return; }
    createLead.mutate(form);
  }

  const selectCls = "border border-border rounded-xl px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 cursor-pointer";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
            <Funnel className="w-5 h-5 text-orange-600 dark:text-orange-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">CRM Leads</h1>
            <p className="text-sm text-muted-foreground">Khách tiềm năng ({filteredLeads.length}/{leads.length})</p>
          </div>
        </div>
        <button
          onClick={() => { setShowModal(true); setForm(EMPTY_FORM); setFormError(""); }}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors">
          <UserPlus className="w-4 h-4" />
          Thêm lead
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-medium">Trạng thái:</span>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className={selectCls}>
            <option value="all">Tất cả</option>
            {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-medium">Nguồn:</span>
          <select value={filterSource} onChange={e => setFilterSource(e.target.value)} className={selectCls}>
            <option value="all">Tất cả</option>
            {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-medium">Loại:</span>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} className={selectCls}>
            <option value="all">Tất cả</option>
            {TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        {(filterStatus !== "all" || filterSource !== "all" || filterType !== "all") && (
          <button
            onClick={() => { setFilterStatus("all"); setFilterSource("all"); setFilterType("all"); }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-xl px-3 py-2 hover:bg-muted transition-colors">
            <X className="w-3 h-3" />
            Xoá bộ lọc
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Đang tải...</div>
        ) : filteredLeads.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">
            {leads.length === 0 ? 'Chưa có khách tiềm năng nào. Nhấn "+ Thêm lead" để bắt đầu.' : "Không có lead nào khớp với bộ lọc."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Tên</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground">SĐT</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Tin nhắn cuối</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Loại</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Kênh</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Nguồn</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Trạng thái</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Nhắn lúc</th>
                  <th className="text-left px-4 py-3 font-semibold text-muted-foreground">Hành động</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeads.map((lead, i) => {
                  const sm = statusMeta(lead.status);
                  const tm = typeMeta(lead.type);
                  const cm = channelMeta(lead.channel);
                  return (
                    <tr
                      key={lead.id}
                      onClick={() => openDrawer(lead)}
                      className={`border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer ${i % 2 === 0 ? "" : "bg-muted/10"}`}>
                      <td className="px-4 py-3 font-medium text-foreground">
                        <div className="flex items-center gap-2">
                          {lead.avatarUrl
                            ? <img src={lead.avatarUrl} alt={lead.name} className="w-8 h-8 rounded-full object-cover shrink-0" />
                            : <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-primary font-semibold text-xs">{lead.name.charAt(0).toUpperCase()}</div>
                          }
                          <span>{lead.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{lead.phone ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground max-w-[200px]">
                        {lead.lastMessage ? (
                          <span className="flex items-center gap-1.5">
                            <MessageSquare className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
                            <span className="truncate" title={lead.lastMessage}>
                              {lead.lastMessage.length > 60 ? lead.lastMessage.slice(0, 60) + "…" : lead.lastMessage}
                            </span>
                          </span>
                        ) : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={tm.color}>{tm.label}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={cm.color}>{cm.label}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground capitalize">{lead.source ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Badge className={sm.color}>{sm.label}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                        {lead.lastMessageAt ? (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDate(lead.lastMessageAt)}
                          </span>
                        ) : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => openDrawer(lead)}
                          className="text-xs text-primary hover:underline whitespace-nowrap">
                          Chi tiết
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail Drawer */}
      {selectedLead && (
        <>
          {/* Overlay */}
          <div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            onClick={closeDrawer}
          />
          {/* Panel */}
          <div className="fixed right-0 top-0 h-full z-50 w-full max-w-md bg-card border-l border-border shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-right duration-200">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                {selectedLead.avatarUrl
                  ? <img src={selectedLead.avatarUrl} alt={selectedLead.name} className="h-9 w-9 rounded-full object-cover shrink-0" />
                  : <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-primary">{selectedLead.name.charAt(0).toUpperCase()}</span>
                    </div>
                }
                <div className="min-w-0">
                  <p className="font-semibold text-foreground truncate">{selectedLead.name}</p>
                  <Badge className={statusMeta(selectedLead.status).color}>
                    {statusMeta(selectedLead.status).label}
                  </Badge>
                </div>
              </div>
              <button onClick={closeDrawer} className="p-1.5 hover:bg-muted rounded-lg transition-colors shrink-0 ml-2">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Drawer body (scrollable) */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">

              {/* Info grid */}
              <div className="grid grid-cols-2 gap-3">
                <InfoItem label="Tên" value={selectedLead.name} />
                <InfoItem label="Số điện thoại" value={selectedLead.phone ?? "—"} />
                <InfoItem label="Nguồn" value={selectedLead.source ?? "—"} capitalize />
                <InfoItem label="Kênh" value={channelMeta(selectedLead.channel).label} />
                <InfoItem label="Loại" value={typeMeta(selectedLead.type).label} />
                <InfoItem label="Ngày tạo" value={formatDate(selectedLead.createdAt)} />
              </div>

              {/* Last message */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tin nhắn cuối</p>
                <div className="bg-muted/40 rounded-xl px-3 py-2.5 text-sm text-foreground min-h-[40px]">
                  {selectedLead.lastMessage
                    ? <p>{selectedLead.lastMessage}</p>
                    : <span className="text-muted-foreground/50">—</span>
                  }
                </div>
              </div>

              {/* Last message time */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Thời gian cuối</p>
                <div className="bg-muted/40 rounded-xl px-3 py-2.5 text-sm text-foreground">
                  {selectedLead.lastMessageAt
                    ? <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{formatDate(selectedLead.lastMessageAt)}</span>
                    : <span className="text-muted-foreground/50">—</span>
                  }
                </div>
              </div>

              {/* Original message */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tin nhắn gốc</p>
                <div className="bg-muted/40 rounded-xl px-3 py-2.5 text-sm text-foreground min-h-[40px]">
                  {selectedLead.message
                    ? <p>{selectedLead.message}</p>
                    : <span className="text-muted-foreground/50">—</span>
                  }
                </div>
              </div>

              <hr className="border-border" />

              {/* Status changer */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">Đổi trạng thái</p>
                <div className="relative">
                  <select
                    value={selectedLead.status ?? "new"}
                    onChange={e => patchLead.mutate({ id: selectedLead.id, data: { status: e.target.value } })}
                    disabled={patchLead.isPending}
                    className={`w-full border border-border rounded-xl px-3 py-2 pr-8 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 cursor-pointer disabled:opacity-50 appearance-none`}>
                    {STATUS_OPTIONS.map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                </div>
              </div>

              {/* Notes editor */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">Ghi chú nội bộ</p>
                <textarea
                  value={drawerNotes}
                  onChange={e => { setDrawerNotes(e.target.value); setNotesSaved(false); }}
                  rows={4}
                  placeholder="Thêm ghi chú về lead này..."
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
                <button
                  onClick={handleSaveNotes}
                  disabled={patchLead.isPending}
                  className="flex items-center gap-2 w-full justify-center border border-border px-4 py-2 rounded-xl text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50">
                  <Save className="w-3.5 h-3.5" />
                  {notesSaved ? "Đã lưu!" : patchLead.isPending ? "Đang lưu..." : "Lưu ghi chú"}
                </button>
              </div>
            </div>

            {/* Drawer footer — convert button */}
            <div className="px-6 py-4 border-t border-border shrink-0">
              <button
                onClick={() => {
                  if (!selectedLead.phone) { alert("Lead này chưa có số điện thoại, không thể chuyển thành khách."); return; }
                  if (confirm(`Chuyển "${selectedLead.name}" thành khách hàng?`)) {
                    convertLead.mutate(selectedLead.id);
                  }
                }}
                disabled={convertLead.isPending}
                className="flex items-center justify-center gap-2 w-full bg-green-600 hover:bg-green-700 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50">
                <UserCheck className="w-4 h-4" />
                {convertLead.isPending ? "Đang chuyển..." : "Chuyển thành khách"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Add Lead Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b border-border">
              <h2 className="text-lg font-semibold">Thêm khách tiềm năng</h2>
              <button onClick={() => setShowModal(false)} className="p-1.5 hover:bg-muted rounded-lg transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">Tên khách <span className="text-destructive">*</span></label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Nguyễn Văn A"
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Số điện thoại</label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="0901 234 567"
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Nội dung / Ghi chú</label>
                <textarea
                  value={form.message}
                  onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                  placeholder="Khách hỏi về gói chụp cưới..."
                  rows={3}
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Nguồn</label>
                <select
                  value={form.source}
                  onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30">
                  {SOURCE_OPTIONS.map(s => (
                    <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                  ))}
                </select>
              </div>
              {formError && (
                <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{formError}</p>
              )}
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="flex-1 border border-border px-4 py-2 rounded-xl text-sm font-medium hover:bg-muted transition-colors">
                  Hủy
                </button>
                <button type="submit" disabled={createLead.isPending}
                  className="flex-1 bg-primary text-primary-foreground px-4 py-2 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
                  {createLead.isPending ? "Đang lưu..." : "Thêm lead"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoItem({ label, value, capitalize }: { label: string; value: string; capitalize?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className={`text-sm font-medium text-foreground ${capitalize ? "capitalize" : ""}`}>{value}</p>
    </div>
  );
}
