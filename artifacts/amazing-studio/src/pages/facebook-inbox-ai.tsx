import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, MessageSquare, Send, UserPlus, RefreshCw, Settings, ChevronLeft, Plus, X, Paperclip, AlertTriangle, Download, ZoomIn, Pencil, Bell, BellOff, Search, MoreHorizontal, Loader2 } from "lucide-react";
import { Link } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers as Record<string, string> ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

type LeadInfo = {
  id: number;
  name: string;
  phone: string | null;
  zalo: string | null;
  status: string | null;
  avatarUrl: string | null;
  aiPerThreadEnabled: boolean | null;
  aiMode: "active" | "paused" | "takeover";
  customerId?: number | null;
  notes?: string | null;
  currentScriptId?: number | null;
  currentSaleStep?: number | null;
  scriptName?: string | null;
  profileSyncStatus?: string | null;
  needsHuman?: boolean;
};

type Thread = {
  psid: string;
  lastAt: string;
  lastMessage: string;
  lastDirection: "incoming" | "outgoing";
  lastAiDecision: string | null;
  lead: LeadInfo | null;
};

type Message = {
  id: number;
  direction: "incoming" | "outgoing";
  message: string;
  sent_status: string;
  ai_decision: string | null;
  sent_by: string | null;
  created_at: string;
};

type AiStatus = { autoReplyEnabled: boolean; hasConfig: boolean };

const STATUS_OPTIONS = [
  { value: "new", label: "Mới", cls: "bg-blue-100 text-blue-700" },
  { value: "chatting", label: "Đang chat", cls: "bg-orange-100 text-orange-700" },
  { value: "hot", label: "Quan tâm", cls: "bg-red-100 text-red-700" },
  { value: "lost", label: "Từ chối", cls: "bg-gray-100 text-gray-500" },
];

function statusLabel(s: string | null) {
  return STATUS_OPTIONS.find((o) => o.value === s) ?? { label: s ?? "?", cls: "bg-gray-100 text-gray-500" };
}

const AI_MODE_OPTIONS = [
  { value: "active", label: "AI tự trả lời", short: "AI bật", dot: "bg-green-500" },
  { value: "paused", label: "Tạm dừng AI", short: "Tạm dừng", dot: "bg-gray-400" },
  { value: "takeover", label: "NV takeover", short: "Takeover", dot: "bg-red-500" },
] as const;

type InboxQuickFilter = "all" | "unread" | "ai_on" | "takeover" | "new";

const QUICK_FILTERS: { key: InboxQuickFilter; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "unread", label: "Chưa trả lời" },
  { key: "ai_on", label: "AI bật" },
  { key: "takeover", label: "Takeover" },
  { key: "new", label: "Mới" },
];

function isGenericFbName(name?: string | null): boolean {
  if (!name?.trim()) return true;
  return name.startsWith("Khách Facebook ") || /^Khách\s/i.test(name);
}

function displayThreadName(lead: LeadInfo | null, psid: string): string {
  if (lead?.name && !isGenericFbName(lead.name)) return lead.name;
  return `FB · …${psid.slice(-4)}`;
}

function avatarFallbackLabel(name: string, psid?: string): string {
  if (isGenericFbName(name) && psid) return psid.slice(-3).toUpperCase();
  const t = name.trim();
  if (t.length >= 2) return t.slice(0, 2).toUpperCase();
  return t[0]?.toUpperCase() ?? "FB";
}

function formatMessagePreview(msg: string, outgoing = false): string {
  if (/^\[image:/i.test(msg)) return "📷 Hình ảnh";
  if (/^\[sticker:/i.test(msg)) return "😊 Sticker";
  if (/^\[(file|attachment):/i.test(msg)) return "📎 Tệp đính kèm";
  const text = msg.trim();
  if (!text) return "…";
  return outgoing ? `Bạn: ${text}` : text;
}

function threadNeedsAttention(t: Thread): boolean {
  return t.lastDirection === "incoming" && t.lastAiDecision !== "auto_replied";
}

function aiModeMeta(mode: string) {
  return AI_MODE_OPTIONS.find((o) => o.value === mode) ?? AI_MODE_OPTIONS[1];
}

function buildThreadInsight(lead: LeadInfo | null): string | null {
  if (!lead) return null;
  const parts: string[] = [];
  if (lead.phone?.trim()) parts.push(`📞 ${lead.phone.trim()}`);
  if (lead.scriptName?.trim()) parts.push(`🎯 ${lead.scriptName.trim()}`);
  return parts.length ? parts.join(" · ") : null;
}

function matchesQuickFilter(t: Thread, filter: InboxQuickFilter, globalAiOn: boolean): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return threadNeedsAttention(t);
  if (filter === "new") return (t.lead?.status ?? "new") === "new";
  if (filter === "takeover") return (t.lead?.aiMode ?? "active") === "takeover";
  if (filter === "ai_on") return globalAiOn && (t.lead?.aiMode ?? "active") === "active";
  return true;
}

function matchesSearchQuery(t: Thread, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const name = displayThreadName(t.lead, t.psid).toLowerCase();
  const rawName = (t.lead?.name ?? "").toLowerCase();
  const phone = (t.lead?.phone ?? "").toLowerCase();
  const psid = t.psid.toLowerCase();
  const preview = formatMessagePreview(t.lastMessage, t.lastDirection === "outgoing").toLowerCase();
  return (
    name.includes(needle) ||
    rawName.includes(needle) ||
    phone.includes(needle) ||
    psid.includes(needle) ||
    preview.includes(needle)
  );
}

const AVATAR_PALETTE = [
  { bg: "#DBEAFE", fg: "#1E40AF" },
  { bg: "#FEE2E2", fg: "#991B1B" },
  { bg: "#D1FAE5", fg: "#065F46" },
  { bg: "#FEF3C7", fg: "#92400E" },
  { bg: "#EDE9FE", fg: "#5B21B6" },
  { bg: "#FCE7F3", fg: "#9D174D" },
  { bg: "#FFEDD5", fg: "#9A3412" },
  { bg: "#E0F2FE", fg: "#0C4A6E" },
  { bg: "#FDF4FF", fg: "#6B21A8" },
  { bg: "#ECFDF5", fg: "#064E3B" },
];

function hashAvatarColor(key: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

function Avatar({ url, name, size = 36, psid }: { url: string | null; name: string; size?: number; psid?: string }) {
  const [imgError, setImgError] = useState(false);
  useEffect(() => { setImgError(false); }, [url]);
  const style = { width: size, height: size, minWidth: size, minHeight: size, borderRadius: "50%" };
  const initial = avatarFallbackLabel(name, psid);
  const { bg, fg } = hashAvatarColor(psid || name || "K");

  if (url && !imgError) {
    return <img src={url} alt={name} style={{ ...style, objectFit: "cover" }} className="shrink-0" onError={() => setImgError(true)} />;
  }
  return (
    <div style={{ ...style, backgroundColor: bg, color: fg }} className="shrink-0 flex items-center justify-center font-bold text-xs select-none">
      {initial}
    </div>
  );
}

function MessageTag({ direction, aiDecision, sentStatus, sentBy }: { direction: "incoming" | "outgoing"; aiDecision: string | null; sentStatus: string; sentBy?: string | null }) {
  if (direction === "outgoing") {
    if (aiDecision?.startsWith("auto_replied")) return <span>• 🤖 AI</span>;
    if (aiDecision === "page_sent") {
      if (sentBy) return <span>• 👤 {sentBy}</span>;
      return <span title="Sent directly from Facebook Inbox">• 📱 Facebook Inbox</span>;
    }
    if (aiDecision === "manual_sent" || aiDecision === "manual_image") {
      return <span>• 👤 {sentBy ? sentBy : "Nhân viên"}</span>;
    }
    return <span>• 👤 {sentBy ? sentBy : "Nhân viên"}</span>;
  }
  if (!aiDecision) return null;
  if (aiDecision.startsWith("ai_disabled")) return <span>• AI tắt</span>;
  if (aiDecision.startsWith("missing_config")) return <span>• Thiếu cấu hình</span>;
  if (aiDecision.startsWith("out_of_scope")) return <span>• Ngoài phạm vi</span>;
  return <span>• {aiDecision || sentStatus}</span>;
}

type FollowUpStatus = { count: number; lastAt: string | null; optedOut: boolean; inQueue: boolean };

function LeadInfoPanel({ lead, psid, onOpenCustomer, onOpenLead, onSave, onSyncProfile, syncing }: { lead: LeadInfo; psid: string; onOpenCustomer?: () => void; onOpenLead?: () => void; onSave?: (patch: Partial<LeadInfo>) => void; onSyncProfile?: () => void; syncing?: boolean; }) {
  const [name, setName] = useState(lead.name ?? "");
  const [phone, setPhone] = useState(lead.phone ?? "");
  const [zalo, setZalo] = useState(lead.zalo ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  useEffect(() => { setName(lead.name ?? ""); setPhone(lead.phone ?? ""); setZalo(lead.zalo ?? ""); setNotes(lead.notes ?? ""); }, [lead]);
  const isGenericName = isGenericFbName(lead.name);

  const { data: fu, refetch: refetchFu } = useQuery<FollowUpStatus>({
    queryKey: ["fb-follow-up", psid],
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/fb-inbox/threads/${psid}/follow-up`);
      if (!r.ok) return { count: 0, lastAt: null, optedOut: false, inQueue: false };
      return r.json();
    },
    staleTime: 15000,
  });
  const triggerMutation = useMutation({
    mutationFn: async () => {
      const r = await authFetch(`${BASE}/api/fb-inbox/threads/${psid}/follow-up/trigger`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Gửi thất bại");
      return d;
    },
    onSuccess: () => { void refetchFu(); },
  });
  const optOutMutation = useMutation({
    mutationFn: async (optedOut: boolean) => {
      const r = await authFetch(`${BASE}/api/fb-inbox/threads/${psid}/follow-up/opt-out`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optedOut }) });
      if (!r.ok) throw new Error("Lỗi cập nhật");
      return r.json();
    },
    onSuccess: () => { void refetchFu(); },
  });

  const fuStatusLabel = fu?.optedOut ? "Đã tắt" : (fu?.count ?? 0) >= 3 ? "Đã xong" : "Hoạt động";
  const fuStatusCls = fu?.optedOut ? "bg-gray-100 text-gray-500" : (fu?.count ?? 0) >= 3 ? "bg-yellow-100 text-yellow-700" : "bg-blue-100 text-blue-700";

  return (
    <div className="w-[250px] border-l border-border bg-muted/30 p-3 flex flex-col gap-3 overflow-y-auto">
      <div className="flex items-start gap-3">
        <Avatar url={lead.avatarUrl ?? null} name={lead.name} size={60} psid={psid} />
        <div className="min-w-0 flex-1">
          <p className={`font-semibold text-sm truncate ${isGenericName ? "text-muted-foreground italic" : ""}`}>{lead.name}</p>
          <p className="text-[11px] text-muted-foreground">PSID: {psid.slice(-10)}</p>
          <span className={`mt-1 inline-flex text-[10px] font-medium px-2 py-0.5 rounded-full ${statusLabel(lead.status).cls}`}>{statusLabel(lead.status).label}</span>
        </div>
      </div>
      {/* Đồng bộ tên/avatar Facebook (giữ tên admin đã sửa) */}
      <div className="flex items-center justify-between gap-2 -mt-1">
        {(() => {
          const st = lead.profileSyncStatus;
          const badge = st === "synced"
            ? { t: "Đã đồng bộ Facebook", c: "text-green-600" }
            : (st === "failed" || st === "unavailable")
              ? { t: "Không lấy được từ Facebook", c: "text-orange-500" }
              : isGenericName
                ? { t: "Chưa đồng bộ tên", c: "text-gray-400" }
                : { t: "Đã có tên", c: "text-green-600" };
          return <span className={`text-[10px] ${badge.c}`}>{badge.t}</span>;
        })()}
        <button
          onClick={onSyncProfile}
          disabled={syncing}
          className="text-[11px] flex items-center gap-1 px-2 py-1 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50 shrink-0"
          title="Lấy tên & avatar thật từ Facebook"
        >
          {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Đồng bộ tên
        </button>
      </div>
      {(() => {
        const hasGroup = (lead.currentSaleStep ?? 0) >= 3 && !!lead.currentScriptId && !!lead.scriptName;
        return (
          <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium border ${hasGroup ? "bg-purple-50 border-purple-200 text-purple-700" : "bg-gray-50 border-gray-200 text-gray-400"}`}>
            <span className="shrink-0">{hasGroup ? "🎯" : "❓"}</span>
            <span className="truncate">
              {hasGroup ? `Nhóm DV: ${lead.scriptName}` : "Chưa xác định nhóm"}
            </span>
          </div>
        );
      })()}
      <div className="rounded-xl border bg-white p-3 text-xs space-y-2">
        <div>
          <div className="text-muted-foreground mb-1 flex items-center gap-1">
            Tên khách
            {isGenericName && <span className="text-orange-500 text-[10px]">· chưa có tên thật</span>}
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name.trim() && name !== lead.name) onSave?.({ name }); }}
            placeholder="Nhập tên thật..."
            className="w-full border rounded-lg px-2 py-1 text-xs"
          />
        </div>
        <div>
          <div className="text-muted-foreground mb-1">SĐT</div>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={() => onSave?.({ phone })} className="w-full border rounded-lg px-2 py-1 text-xs" />
        </div>
        <div>
          <div className="text-muted-foreground mb-1">Zalo</div>
          <input value={zalo} onChange={(e) => setZalo(e.target.value)} onBlur={() => onSave?.({ zalo })} className="w-full border rounded-lg px-2 py-1 text-xs" />
        </div>
        <div>
          <div className="text-muted-foreground mb-1">Ghi chú</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => onSave?.({ notes })} rows={3} className="w-full border rounded-lg px-2 py-1 text-xs resize-none" />
        </div>
      </div>

      <div className="rounded-xl border bg-white p-3 text-xs space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium">Follow-up tự động</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${fuStatusCls}`}>{fuStatusLabel}</span>
        </div>
        <p className="text-muted-foreground">
          {fu && fu.count > 0
            ? `Đã gửi: ${fu.count}/3 lần${fu.lastAt ? ` · ${new Date(fu.lastAt).toLocaleDateString("vi-VN")}` : ""}`
            : "Chưa gửi follow-up nào"}
        </p>
        <div className="flex gap-1.5">
          <button
            onClick={() => triggerMutation.mutate()}
            disabled={triggerMutation.isPending || !!fu?.optedOut}
            className="flex-1 border rounded-lg px-2 py-1 text-xs hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {triggerMutation.isPending ? "Đang gửi..." : "Gửi ngay"}
          </button>
          <button
            onClick={() => optOutMutation.mutate(!fu?.optedOut)}
            disabled={optOutMutation.isPending}
            className={`flex-1 border rounded-lg px-2 py-1 text-xs disabled:opacity-40 ${fu?.optedOut ? "bg-red-50 text-red-600 hover:bg-red-100" : "hover:bg-muted"}`}
          >
            {fu?.optedOut ? "Bật lại" : "Tắt follow-up"}
          </button>
        </div>
        {triggerMutation.isError && <p className="text-red-500 text-[10px]">{(triggerMutation.error as Error).message}</p>}
        {triggerMutation.isSuccess && <p className="text-green-600 text-[10px]">Đã gửi follow-up!</p>}
      </div>

      <div className="grid grid-cols-1 gap-2">
        {onOpenLead && <button onClick={onOpenLead} className="text-xs border rounded-xl px-3 py-2 hover:bg-white">Mở CRM Lead</button>}
        {onOpenCustomer && <button onClick={onOpenCustomer} className="text-xs border rounded-xl px-3 py-2 hover:bg-white">Mở hồ sơ KH</button>}
        <button onClick={() => window.location.assign(`/bookings/new?customerId=${lead.customerId ?? ""}`)} className="text-xs border rounded-xl px-3 py-2 hover:bg-white">Tạo đơn hàng</button>
      </div>
    </div>
  );
}

function timeAgo(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return "Vừa xong";
  if (diff < 3600) return `${Math.floor(diff / 60)} phút`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ`;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startToday - startMsg) / 86400000);
  if (dayDiff === 1) return "Hôm qua";
  if (dayDiff === 2) return "2 ngày trước";
  if (dayDiff > 2 && dayDiff < 7) return `${dayDiff} ngày trước`;
  return d.toLocaleDateString("vi-VN");
}


function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => ctx.close().catch(() => {});
  } catch { /* ignore if AudioContext unavailable */ }
}

function parseMessageContent(msg: string): { type: "text" | "image"; value: string } {
  const m = msg.match(/^\[image:(.+)\]$/);
  return m ? { type: "image", value: m[1] } : { type: "text", value: msg };
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleDownload = async () => {
    try {
      const parsed = new URL(src);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
      const res = await fetch(src);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = blob.type.split("/")[1] || "jpg";
      a.download = `anh_facebook.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      try {
        const parsed = new URL(src);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          window.open(src, "_blank", "noopener,noreferrer");
        }
      } catch { /* invalid URL, do nothing */ }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt="Xem ảnh"
          className="max-w-[90vw] max-h-[80vh] object-contain rounded-xl shadow-2xl"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-sm font-medium backdrop-blur-sm transition-colors"
          >
            <Download className="w-4 h-4" />
            Tải ảnh về
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-sm font-medium backdrop-blur-sm transition-colors"
          >
            <X className="w-4 h-4" />
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FacebookInboxAiPage() {
  const qc = useQueryClient();
  const [selectedPsid, setSelectedPsid] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [modalPhone, setModalPhone] = useState("");
  const [modalZalo, setModalZalo] = useState("");
  const [createdCustomerId, setCreatedCustomerId] = useState<number | null>(null);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [pendingPreviewUrls, setPendingPreviewUrls] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [showEditSheet, setShowEditSheet] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editZalo, setEditZalo] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(() =>
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem("fb_inbox_sound") !== "off"; } catch { return true; }
  });
  const [staffFilter, setStaffFilter] = useState<string>("");
  const [quickFilter, setQuickFilter] = useState<InboxQuickFilter>("all");
  const [threadSearch, setThreadSearch] = useState("");
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const seenRef = useRef<Map<string, string>>(new Map());
  const initializedRef = useRef(false);

  const { data: staffSenders = [] } = useQuery<string[]>({ queryKey: ["fb-inbox-staff-senders"], queryFn: async () => { const r = await authFetch(`${BASE}/api/fb-inbox/staff-senders`); if (!r.ok) return []; return r.json(); }, refetchInterval: 30000 });

  const { data: threads = [] } = useQuery<Thread[]>({ queryKey: ["fb-inbox-threads", staffFilter], queryFn: async () => { const url = staffFilter ? `${BASE}/api/fb-inbox/threads?sentBy=${encodeURIComponent(staffFilter)}` : `${BASE}/api/fb-inbox/threads`; const r = await authFetch(url); if (!r.ok) throw new Error("Không tải được hội thoại"); return r.json(); }, refetchInterval: 5000 });
  const { data: messagesData, isLoading: messagesLoading } = useQuery<Message[]>({ queryKey: ["fb-thread-messages", selectedPsid], enabled: !!selectedPsid, queryFn: async () => { const r = await authFetch(`${BASE}/api/fb-inbox/threads/${selectedPsid}/messages`); if (!r.ok) throw new Error("Không tải được tin nhắn"); return r.json(); }, refetchInterval: 4000, staleTime: 0 });
  const messages = useMemo(() => messagesData ?? [], [messagesData]);
  const { data: aiStatus } = useQuery<AiStatus>({ queryKey: ["fb-ai-status"], queryFn: async () => { const r = await authFetch(`${BASE}/api/fb-ai/status`); if (!r.ok) return { autoReplyEnabled: false, hasConfig: false }; return r.json(); }, refetchInterval: 30000 });

  const globalAiOn = !!(aiStatus?.autoReplyEnabled && aiStatus?.hasConfig);

  const filteredThreads = useMemo(() => {
    return threads
      .filter((t) => matchesQuickFilter(t, quickFilter, globalAiOn))
      .filter((t) => matchesSearchQuery(t, threadSearch))
      .sort((a, b) => {
        const aNeed = threadNeedsAttention(a);
        const bNeed = threadNeedsAttention(b);
        if (aNeed !== bNeed) return aNeed ? -1 : 1;
        return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
      });
  }, [threads, quickFilter, threadSearch, globalAiOn]);

  const selectedThread = threads.find((t) => t.psid === selectedPsid) ?? null;

  useEffect(() => {
    if (!showHeaderMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setShowHeaderMenu(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showHeaderMenu]);
  useEffect(() => { if (messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const pendingPreviewUrlsRef = useRef<string[]>([]);
  useEffect(() => { pendingPreviewUrlsRef.current = pendingPreviewUrls; }, [pendingPreviewUrls]);
  useEffect(() => { return () => { pendingPreviewUrlsRef.current.forEach((u) => URL.revokeObjectURL(u)); }; }, []);

  const unreadCount = useMemo(
    () => threads.filter((t) => t.lastDirection === "incoming" && t.lastAiDecision !== "auto_replied").length,
    [threads]
  );

  useEffect(() => {
    const base = "Inbox Facebook AI";
    document.title = unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
    return () => { document.title = base; };
  }, [unreadCount]);

  useEffect(() => {
    if (threads.length === 0) return;
    if (!initializedRef.current) {
      threads.forEach((t) => seenRef.current.set(t.psid, t.lastAt));
      initializedRef.current = true;
      return;
    }
    threads.forEach((t) => {
      const prevAt = seenRef.current.get(t.psid);
      const isNew = t.lastDirection === "incoming" && (prevAt === undefined || prevAt !== t.lastAt);
      if (isNew) {
        if (soundEnabled) playNotificationSound();
        if (notifPermission === "granted" && document.visibilityState !== "visible") {
          const name = displayThreadName(t.lead, t.psid);
          const preview = formatMessagePreview(t.lastMessage, t.lastDirection === "outgoing");
          try {
            new Notification(`Tin nhắn mới từ ${name}`, {
              body: preview.length > 80 ? `${preview.slice(0, 80)}…` : preview,
              icon: t.lead?.avatarUrl ?? undefined,
              tag: `fb-inbox-${t.psid}`,
            });
          } catch { /* ignore */ }
        }
      }
      seenRef.current.set(t.psid, t.lastAt);
    });
  }, [threads, soundEnabled, notifPermission]);

  const requestNotifPermission = async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setNotifPermission(result);
  };

  const toggleSound = () => {
    setSoundEnabled((prev) => {
      const next = !prev;
      try { localStorage.setItem("fb_inbox_sound", next ? "on" : "off"); } catch { /* ignore */ }
      return next;
    });
  };

  const sendMutation = useMutation({ mutationFn: async () => { if (!selectedPsid) throw new Error("Chưa chọn hội thoại"); const text = draft.trim(); if (!text) throw new Error("Chưa có nội dung gửi"); const r = await authFetch(`${BASE}/api/fb-inbox/threads/${selectedPsid}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }); const d = await r.json() as { error?: string; fbError?: string; detail?: string }; if (!r.ok) throw new Error(d.fbError || d.detail || d.error || "Gửi Facebook thất bại"); return d; }, onSuccess: () => { setDraft(""); setHint(""); qc.invalidateQueries({ queryKey: ["fb-inbox-threads"] }); qc.invalidateQueries({ queryKey: ["fb-thread-messages", selectedPsid] }); }, onError: (e: Error) => setHint(e.message) });

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length || !selectedPsid) return;
    const urls = files.map((f) => URL.createObjectURL(f));
    setPendingImages((prev) => [...prev, ...files]);
    setPendingPreviewUrls((prev) => [...prev, ...urls]);
    setHint("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePendingImage = (idx: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
    setPendingPreviewUrls((prev) => {
      URL.revokeObjectURL(prev[idx]);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleSendImages = async () => {
    if (!selectedPsid || pendingImages.length === 0) return;
    const total = pendingImages.length;
    setUploadProgress({ current: 0, total });
    setHint("");
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < total; i++) {
      setUploadProgress({ current: i + 1, total });
      try {
        const fd = new FormData();
        fd.append("image", pendingImages[i]);
        const r = await authFetch(`${BASE}/api/fb-inbox/threads/${selectedPsid}/send-image`, { method: "POST", body: fd });
        const d = await r.json() as { error?: string; fbError?: string; detail?: string };
        if (!r.ok) throw new Error(d.fbError || d.detail || d.error || "Gửi ảnh thất bại");
        successCount++;
      } catch (err) {
        failCount++;
        console.error(`Lỗi gửi ảnh ${i + 1}:`, err);
      }
    }
    pendingPreviewUrls.forEach((u) => URL.revokeObjectURL(u));
    setPendingImages([]);
    setPendingPreviewUrls([]);
    setUploadProgress(null);
    qc.invalidateQueries({ queryKey: ["fb-thread-messages", selectedPsid] });
    qc.invalidateQueries({ queryKey: ["fb-inbox-threads"] });
    if (failCount === 0) {
      setHint(`Đã gửi ${successCount} ảnh thành công!`);
    } else if (successCount === 0) {
      setHint(`Gửi thất bại tất cả ${total} ảnh. Vui lòng thử lại.`);
    } else {
      setHint(`Gửi ${successCount}/${total} ảnh thành công, ${failCount} thất bại.`);
    }
  };
  const statusMutation = useMutation({ mutationFn: async ({ leadId, status }: { leadId: number; status: string }) => { const r = await authFetch(`${BASE}/api/crm-leads/${leadId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Cập nhật thất bại"); return d; }, onSuccess: () => { qc.invalidateQueries({ queryKey: ["fb-inbox-threads"] }); setHint("Đã cập nhật trạng thái."); }, onError: (e: Error) => setHint(e.message) });
  const aiModeMutation = useMutation({ mutationFn: async ({ psid, aiMode }: { psid: string; aiMode: string }) => { const r = await authFetch(`${BASE}/api/fb-ai/threads/${psid}/ai-mode`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aiMode }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Cập nhật AI thất bại"); return d; }, onSuccess: () => { qc.invalidateQueries({ queryKey: ["fb-inbox-threads"] }); }, onError: (e: Error) => setHint(e.message) });
  const createCustomerMutation = useMutation({ mutationFn: async ({ psid, phone, zalo }: { psid: string; phone: string; zalo: string }) => { const r = await authFetch(`${BASE}/api/fb-inbox/threads/${psid}/create-customer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: phone || undefined, zalo: zalo || undefined }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Tạo khách hàng thất bại"); return d as { customerId?: number; leadId?: number }; }, onSuccess: (d) => { setShowModal(false); setModalPhone(""); setModalZalo(""); setCreatedCustomerId(d.customerId ?? null); qc.invalidateQueries({ queryKey: ["fb-inbox-threads"] }); setSelectedPsid((v) => v); }, onError: (e: Error) => setHint(e.message) });
  const globalAiMutation = useMutation({
    // CẦU DAO TỔNG duy nhất: bật/tắt Claude Sale toàn hệ thống (dùng chung mọi nơi).
    mutationFn: async (autoReplyEnabled: boolean) => {
      const r = await authFetch(`${BASE}/api/claude-sale/master`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: autoReplyEnabled }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Cập nhật thất bại");
      return d;
    },
    onMutate: async (autoReplyEnabled: boolean) => {
      await qc.cancelQueries({ queryKey: ["fb-ai-status"] });
      const previous = qc.getQueryData<AiStatus>(["fb-ai-status"]);
      qc.setQueryData<AiStatus>(["fb-ai-status"], (old) => old ? { ...old, autoReplyEnabled } : old);
      return { previous };
    },
    onError: (e: Error, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(["fb-ai-status"], ctx.previous);
      setHint(e.message);
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["fb-ai-status"] }); },
  });
  const syncProfilesMutation = useMutation({
    mutationFn: async () => {
      const r = await authFetch(`${BASE}/api/fb-ai/sync-profiles`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Đồng bộ thất bại");
      return d as { success: boolean; scanned: number; updated: number; failed: number; errors?: string[] };
    },
    onSuccess: (d) => {
      let errInfo = "";
      if (d.failed > 0 && d.errors?.length) {
        const raw = d.errors[0].toLowerCase();
        if (raw.includes("token") || raw.includes("expired") || raw.includes("hết hạn")) {
          errInfo = ` — Token hết hạn, cần cấp lại Page Access Token trong Cài đặt`;
        } else if (raw.includes("permission") || raw.includes("quyền") || raw.includes("(#10)") || raw.includes("(#200)")) {
          errInfo = ` — Thiếu quyền FB API (pages_messaging), kiểm tra lại token`;
        } else {
          errInfo = ` — ${d.failed} khách thất bại: ${d.errors[0]}`;
        }
      } else if (d.failed > 0) {
        errInfo = ` — ${d.failed} khách không lấy được tên (FB không trả dữ liệu)`;
      }
      setHint(`Đồng bộ xong: ${d.updated}/${d.scanned} cập nhật${errInfo}`);
      qc.invalidateQueries({ queryKey: ["fb-inbox-threads"] });
    },
    onError: (e: Error) => setHint(e.message),
  });
  // Đồng bộ tên/avatar 1 hội thoại (giữ nguyên tên admin đã sửa).
  const syncOneProfileMutation = useMutation({
    mutationFn: async (psid: string) => {
      const r = await authFetch(`${BASE}/api/fb-inbox/threads/${psid}/sync-profile`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Đồng bộ thất bại");
      return d as { success: boolean; status: string; name?: string; nameKept?: boolean; error?: string };
    },
    onSuccess: (d) => {
      if (d.success) setHint(d.nameKept ? "Đã đồng bộ avatar (giữ tên bạn đã sửa)" : "Đã đồng bộ tên/avatar từ Facebook");
      else setHint(`Không lấy được từ Facebook: ${d.error ?? "không có dữ liệu"}`);
      qc.invalidateQueries({ queryKey: ["fb-inbox-threads"] });
    },
    onError: (e: Error) => setHint(e.message),
  });

  // Nhân viên gửi tay khi AI đang chăm → hỏi tiếp quản (section 9). Đồng ý → gửi (BE tự chuyển takeover).
  const handleSend = () => {
    if (!draft.trim() || sendMutation.isPending || uploadProgress) return;
    if ((lead?.aiMode ?? "active") === "active") {
      if (!window.confirm("Bạn muốn tiếp quản cuộc hội thoại này? AI sẽ tự tắt ở khách này để bạn chăm thủ công.")) return;
    }
    sendMutation.mutate();
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSend(); } };
  const handleSelectThread = (psid: string) => { if (uploadProgress) return; setSelectedPsid(psid); setDraft(""); setHint(""); setCreatedCustomerId(null); setShowActionSheet(false); pendingPreviewUrls.forEach((u) => URL.revokeObjectURL(u)); setPendingImages([]); setPendingPreviewUrls([]); };
  const handleBack = () => { if (uploadProgress) return; setSelectedPsid(null); setShowActionSheet(false); setHint(""); pendingPreviewUrls.forEach((u) => URL.revokeObjectURL(u)); setPendingImages([]); setPendingPreviewUrls([]); };
  const lead = selectedThread?.lead ?? null;
  const threadAiMode = lead?.aiMode ?? "active";
  const effectiveAi = (aiStatus?.autoReplyEnabled ?? false) && threadAiMode === "active";
  const openCustomer = lead?.customerId ? () => window.location.assign(`/customers/${lead.customerId}`) : undefined;
  const saveLead = (patch: Partial<LeadInfo>) => { if (!lead?.id) return; authFetch(`${BASE}/api/crm-leads/${lead.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.phone !== undefined ? { phone: patch.phone } : {}), ...(patch.zalo !== undefined ? { zalo: patch.zalo } : {}), ...(patch.notes !== undefined ? { notes: patch.notes } : {}) }) }).then(() => qc.invalidateQueries({ queryKey: ["fb-inbox-threads"] })); };

  return (
    <div className="flex flex-col gap-3">

      {/* Page header — hidden on mobile when viewing a chat */}
      <div className={`${selectedPsid ? "hidden md:flex" : "flex"} bg-card border border-border rounded-2xl px-4 py-3 items-center justify-between gap-3`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <h2 className="font-semibold text-base flex items-center gap-2">
              <MessageSquare className="w-4 h-4 shrink-0" />
              Inbox Facebook AI
              {unreadCount > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-blue-600 text-white">{unreadCount}</span>
              )}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">Quản lý hội thoại Fanpage, hỗ trợ sale trực page</p>
          </div>
          {aiStatus && (
            <button
              onClick={() => globalAiMutation.mutate(!aiStatus.autoReplyEnabled)}
              disabled={globalAiMutation.isPending}
              className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full disabled:opacity-60 cursor-pointer ${aiStatus.autoReplyEnabled && aiStatus.hasConfig ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}
            >
              {aiStatus.autoReplyEnabled && aiStatus.hasConfig ? "AI: Bật" : "AI: Tắt"}
            </button>
          )}
        </div>
        <div className="hidden md:flex items-center gap-2 shrink-0">
          <button
            onClick={toggleSound}
            title={soundEnabled ? "Tắt âm thanh" : "Bật âm thanh"}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium hover:bg-muted ${soundEnabled ? "text-foreground" : "text-muted-foreground"}`}
          >
            {soundEnabled ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
            {soundEnabled ? "Âm thanh" : "Im lặng"}
          </button>
          {typeof Notification !== "undefined" && notifPermission !== "granted" && (
            <button onClick={requestNotifPermission} className="inline-flex items-center gap-1.5 rounded-xl border border-blue-300 bg-blue-50 text-blue-700 px-3 py-1.5 text-xs font-medium hover:bg-blue-100">
              <Bell className="w-3.5 h-3.5" /> Thông báo
            </button>
          )}
          <button onClick={() => syncProfilesMutation.mutate()} disabled={syncProfilesMutation.isPending} className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncProfilesMutation.isPending ? "animate-spin" : ""}`} />
            {syncProfilesMutation.isPending ? "Đang đồng bộ..." : "Đồng bộ"}
          </button>
          <Link href="/settings" className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            <Settings className="w-3.5 h-3.5" /> Cài đặt
          </Link>
        </div>
        <div className="md:hidden relative shrink-0" ref={headerMenuRef}>
          <button
            onClick={() => setShowHeaderMenu((v) => !v)}
            className="inline-flex items-center justify-center w-9 h-9 rounded-xl border hover:bg-muted"
            aria-label="Tùy chọn"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
          {showHeaderMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-xl border border-border bg-card shadow-xl py-1 text-sm">
              <button onClick={() => { toggleSound(); setShowHeaderMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-2">
                {soundEnabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                {soundEnabled ? "Tắt âm thanh" : "Bật âm thanh"}
              </button>
              {typeof Notification !== "undefined" && notifPermission !== "granted" && (
                <button onClick={() => { void requestNotifPermission(); setShowHeaderMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-2">
                  <Bell className="w-4 h-4" /> Bật thông báo
                </button>
              )}
              <button onClick={() => { syncProfilesMutation.mutate(); setShowHeaderMenu(false); }} disabled={syncProfilesMutation.isPending} className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-2 disabled:opacity-50">
                <RefreshCw className={`w-4 h-4 ${syncProfilesMutation.isPending ? "animate-spin" : ""}`} /> Đồng bộ tên/avatar
              </button>
              <Link href="/settings" onClick={() => setShowHeaderMenu(false)} className="block px-3 py-2 hover:bg-muted flex items-center gap-2">
                <Settings className="w-4 h-4" /> Cài đặt webhook
              </Link>
            </div>
          )}
        </div>
      </div>

      {createdCustomerId && <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm flex items-center justify-between gap-3"><span>Đã tạo khách hàng thành công.</span><Link href={`/customers/${createdCustomerId}`} className="text-green-700 underline font-medium">Mở hồ sơ khách hàng</Link></div>}

      {/* Main grid — desktop: 2 cols fixed; mobile: single active panel */}
      <div className="flex gap-3 md:grid md:grid-cols-[320px_1fr]" style={{ height: "calc(100vh - 210px)", minHeight: 500 }}>

        {/* Thread list column — mobile: hidden when chat is open */}
        <div className={`${selectedPsid ? "hidden md:flex" : "flex"} bg-card border border-border rounded-2xl flex-col overflow-hidden flex-1 md:flex-none`}>
          <div className="px-3 pt-3 pb-2 border-b border-border shrink-0 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                Hội thoại
                <span className="text-muted-foreground font-normal"> ({filteredThreads.length}{filteredThreads.length !== threads.length ? `/${threads.length}` : ""})</span>
              </p>
              {unreadCount > 0 && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{unreadCount} chưa trả lời</span>
              )}
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                value={threadSearch}
                onChange={(e) => setThreadSearch(e.target.value)}
                placeholder="Tìm tên, SĐT, PSID..."
                className="w-full border rounded-xl pl-8 pr-3 py-2 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
            <div className="flex gap-1 overflow-x-auto pb-0.5 -mx-0.5 px-0.5 scrollbar-none">
              {QUICK_FILTERS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setQuickFilter(tab.key)}
                  className={`shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${quickFilter === tab.key ? "bg-primary text-primary-foreground border-primary" : "bg-background text-muted-foreground border-border hover:bg-muted"}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <select
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              className="w-full border rounded-lg px-2 py-1.5 text-xs bg-background"
            >
              <option value="">Tất cả nhân viên</option>
              {staffSenders.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {threads.length === 0 && (
              <div className="text-center mt-10 px-4 space-y-3">
                <MessageSquare className="w-10 h-10 mx-auto text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">Chưa có hội thoại Facebook.</p>
                <Link href="/settings" className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-primary text-primary-foreground hover:opacity-90">
                  <Settings className="w-3.5 h-3.5" /> Cấu hình webhook
                </Link>
              </div>
            )}
            {threads.length > 0 && filteredThreads.length === 0 && (
              <p className="text-sm text-muted-foreground text-center mt-8 px-4">
                Không có hội thoại khớp bộ lọc hiện tại.
              </p>
            )}
            {filteredThreads.map((t) => {
              const name = displayThreadName(t.lead, t.psid);
              const rawGeneric = isGenericFbName(t.lead?.name);
              const st = statusLabel(t.lead?.status ?? null);
              const isSelected = selectedPsid === t.psid;
              const needsAttention = threadNeedsAttention(t);
              const tAiMode = t.lead?.aiMode ?? "active";
              const aiMeta = aiModeMeta(tAiMode);
              const insight = buildThreadInsight(t.lead);
              const preview = formatMessagePreview(t.lastMessage, t.lastDirection === "outgoing");
              return (
                <button
                  key={t.psid}
                  onClick={() => handleSelectThread(t.psid)}
                  className={`relative w-full text-left rounded-xl pl-3 pr-3 py-2.5 flex items-start gap-2.5 transition-colors overflow-hidden ${needsAttention ? "border-l-[3px] border-l-blue-500" : "border-l-[3px] border-l-transparent"} ${isSelected ? "bg-primary/10 border border-primary/30" : "hover:bg-muted/80 border border-transparent"}`}
                >
                  <div className="relative shrink-0 mt-0.5">
                    <Avatar url={t.lead?.avatarUrl ?? null} name={t.lead?.name ?? name} size={42} psid={t.psid} />
                    <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 ${!globalAiOn ? "bg-gray-400" : aiMeta.dot} rounded-full border-2 border-background`} title={aiMeta.label} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className={`text-sm truncate flex-1 min-w-0 ${needsAttention ? "font-bold text-foreground" : "font-medium text-foreground/90"}`}>{name}</p>
                      <span className={`shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                      <p className={`text-[10px] shrink-0 ${needsAttention ? "text-blue-600 font-semibold" : "text-muted-foreground"}`}>{timeAgo(t.lastAt)}</p>
                    </div>
                    {rawGeneric && (
                      <p className="text-[9px] text-orange-600/90 mt-0.5">Chưa đồng bộ tên</p>
                    )}
                    <p className={`text-xs truncate mt-0.5 ${needsAttention ? "text-foreground/80 font-medium" : "text-muted-foreground"}`}>{preview}</p>
                    {insight && (
                      <p className="text-[10px] text-muted-foreground truncate mt-1">{insight}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Chat area — mobile: hidden when no thread selected */}
        <div className={`${!selectedPsid ? "hidden md:flex" : "flex"} bg-card border border-border rounded-2xl min-h-0 overflow-hidden flex-1 md:flex-none`}>
          {!selectedPsid ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center"><MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" /><p className="text-sm">Chọn một hội thoại bên trái để bắt đầu</p></div>
            </div>
          ) : (
            <>
              <div className="flex-1 min-w-0 flex flex-col min-h-0">

                {/* Mobile chat header */}
                <div className="md:hidden flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
                  <button onClick={handleBack} className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors">
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <Avatar url={lead?.avatarUrl ?? null} name={lead?.name ?? displayThreadName(lead, selectedPsid)} size={34} psid={selectedPsid} />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate leading-tight">{displayThreadName(lead, selectedPsid)}</p>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <select
                        value={threadAiMode}
                        onChange={(e) => aiModeMutation.mutate({ psid: selectedPsid, aiMode: e.target.value })}
                        disabled={aiModeMutation.isPending}
                        className="text-[10px] border rounded-md px-1 py-0.5 bg-background leading-tight disabled:opacity-50"
                        style={{ maxWidth: 118 }}
                      >
                        <option value="active">AI tự trả lời</option>
                        <option value="paused">Tạm dừng AI</option>
                        <option value="takeover">NV takeover</option>
                      </select>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusLabel(lead?.status ?? null).cls}`}>{statusLabel(lead?.status ?? null).label}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setEditName(lead?.name ?? "");
                      setEditPhone(lead?.phone ?? "");
                      setEditZalo(lead?.zalo ?? "");
                      setEditNotes(lead?.notes ?? "");
                      setShowEditSheet(true);
                    }}
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-xl border bg-white text-muted-foreground hover:bg-muted active:scale-95 transition-all text-xs font-medium"
                  >
                    <Pencil className="w-3 h-3" />
                    Sửa
                  </button>
                  <button onClick={() => setShowActionSheet(true)} className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 shadow-sm transition-all active:scale-95">
                    <Plus className="w-5 h-5" />
                  </button>
                </div>

                {/* Desktop chat header */}
                <div className="hidden md:block px-4 py-3 border-b border-border shrink-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar url={lead?.avatarUrl ?? null} name={lead?.name ?? displayThreadName(lead, selectedPsid)} size={36} psid={selectedPsid} />
                      <div className="min-w-0"><p className="font-semibold text-sm truncate">{displayThreadName(lead, selectedPsid)}</p><p className="text-xs text-muted-foreground">PSID: {selectedPsid.slice(-8)}{isGenericFbName(lead?.name) ? " · Chưa đồng bộ" : ""}</p></div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-[11px] font-medium px-2 py-1 rounded-full border bg-white leading-tight"><div className={aiStatus?.autoReplyEnabled && aiStatus.hasConfig ? "text-green-700" : "text-gray-500"}>Global AI: {aiStatus?.autoReplyEnabled && aiStatus.hasConfig ? "BẬT" : "TẮT"}</div><div className={effectiveAi ? "text-green-700" : "text-red-700"}>Hiệu lực: {effectiveAi ? "BẬT" : "TẮT"}</div></div>
                      {lead && <select value={lead.status ?? "new"} onChange={(e) => statusMutation.mutate({ leadId: lead.id, status: e.target.value })} className="text-xs border rounded-lg px-2 py-1.5 bg-background" disabled={statusMutation.isPending}>{STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
                      {lead && <div className="flex items-center gap-1"><Bot className={`w-3.5 h-3.5 ${effectiveAi ? "text-green-600" : "text-gray-400"}`} /><select value={threadAiMode} onChange={(e) => aiModeMutation.mutate({ psid: selectedPsid, aiMode: e.target.value })} className="text-xs border rounded-lg px-2 py-1.5 bg-background" disabled={aiModeMutation.isPending} title="Chế độ AI cho hội thoại này"><option value="active">AI tự trả lời</option><option value="paused">Tạm dừng AI</option><option value="takeover">NV takeover</option></select></div>}
                      {lead && <button onClick={() => { setShowModal(true); setHint(""); }} className="inline-flex items-center gap-1.5 border rounded-xl px-3 py-1.5 text-xs font-medium hover:bg-muted bg-green-50 border-green-200 text-green-700"><UserPlus className="w-3.5 h-3.5" />Tạo KH</button>}
                    </div>
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                  {messagesLoading && <div className="text-center text-sm text-muted-foreground mt-4">Đang tải tin nhắn...</div>}
                  {!messagesLoading && messages.length === 0 && <div className="text-center text-sm text-muted-foreground mt-4">Chưa có tin nhắn trong hội thoại này.</div>}
                  {messages.map((m) => {
                    const parsed = parseMessageContent(m.message);
                    const isFailed = m.sent_status === "failed";
                    return (
                      <div key={m.id} className={`flex ${m.direction === "incoming" ? "justify-start" : "justify-end"}`}>
                        <div className={`max-w-[75%] rounded-2xl text-sm ${parsed.type === "image" ? "overflow-hidden" : "px-3 py-2"} ${isFailed ? "opacity-70 ring-1 ring-red-400" : ""} ${m.direction === "incoming" ? "bg-muted rounded-tl-sm" : "bg-primary text-primary-foreground rounded-tr-sm"}`}>
                          {parsed.type === "image" ? (
                            <div className="relative group cursor-pointer" onClick={() => setLightboxSrc(parsed.value)}>
                              <img
                                src={parsed.value}
                                alt="ảnh"
                                className="max-w-[220px] max-h-[300px] object-cover block"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                              />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors rounded-sm flex items-center justify-center">
                                <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
                              </div>
                            </div>
                          ) : (
                            <p className="whitespace-pre-wrap break-words">{m.message}</p>
                          )}
                          <div className={`flex items-center gap-1.5 mt-1 text-[10px] ${parsed.type === "image" ? "px-2 pb-1" : ""} ${m.direction === "incoming" ? "text-muted-foreground" : "text-primary-foreground/70"}`}>
                            <span>{new Date(m.created_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</span>
                            {isFailed ? (
                              <span className="flex items-center gap-0.5 text-red-400"><AlertTriangle className="w-2.5 h-2.5" />Không gửi được</span>
                            ) : (
                              <MessageTag direction={m.direction} aiDecision={m.ai_decision} sentStatus={m.sent_status} sentBy={m.sent_by} />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input area */}
                <div className="border-t border-border px-4 py-3 space-y-2 shrink-0">
                  {hint && (
                    <div className={`text-xs px-2 py-1 rounded-lg ${hint.includes("thành công") ? "bg-green-50 text-green-700 border border-green-200" : hint.includes("thất bại") || hint.includes("Lỗi") || hint.includes("Không") ? "bg-red-50 text-red-600 border border-red-200" : "bg-blue-50 text-blue-600"}`}>
                      {hint}
                    </div>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    multiple={true}
                    ref={fileInputRef}
                    onChange={handleImageSelect}
                    className="hidden"
                  />
                  {/* Pending image thumbnails */}
                  {pendingPreviewUrls.length > 0 && (
                    <div className="flex flex-wrap gap-2 p-2 bg-muted/50 rounded-xl border border-dashed border-border">
                      {pendingPreviewUrls.map((url, idx) => (
                        <div key={idx} className="relative group shrink-0">
                          <img
                            src={url}
                            alt={`Ảnh ${idx + 1}`}
                            className="w-16 h-16 object-cover rounded-lg border border-border"
                          />
                          <button
                            onClick={() => removePendingImage(idx)}
                            disabled={!!uploadProgress}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-30 shadow-sm"
                            title="Xóa ảnh này"
                          >
                            <X className="w-3 h-3" />
                          </button>
                          {uploadProgress && uploadProgress.current > idx + 1 && (
                            <div className="absolute inset-0 rounded-lg bg-green-500/60 flex items-center justify-center">
                              <span className="text-white text-xs font-bold">✓</span>
                            </div>
                          )}
                          {uploadProgress && uploadProgress.current === idx + 1 && (
                            <div className="absolute inset-0 rounded-lg bg-black/40 flex items-center justify-center">
                              <RefreshCw className="w-4 h-4 text-white animate-spin" />
                            </div>
                          )}
                        </div>
                      ))}
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={!!uploadProgress}
                        className="w-16 h-16 flex items-center justify-center rounded-lg border-2 border-dashed border-border text-muted-foreground hover:bg-muted disabled:opacity-40 transition-colors"
                        title="Thêm ảnh"
                      >
                        <Plus className="w-5 h-5" />
                      </button>
                    </div>
                  )}
                  {/* Progress bar */}
                  {uploadProgress && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Đang gửi ảnh {uploadProgress.current}/{uploadProgress.total}...</span>
                        <span>{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5">
                        <div
                          className="bg-primary h-1.5 rounded-full transition-all duration-300"
                          style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={handleKeyDown} rows={3} placeholder="Gõ tin nhắn... (Ctrl+Enter để gửi)" className="w-full border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary" />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!!uploadProgress || sendMutation.isPending}
                      title="Chọn ảnh (có thể chọn nhiều)"
                      className="inline-flex items-center justify-center w-9 h-9 border rounded-xl text-muted-foreground hover:bg-muted disabled:opacity-50 shrink-0"
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                    {pendingImages.length > 0 ? (
                      <button
                        onClick={handleSendImages}
                        disabled={!!uploadProgress}
                        className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50 hover:opacity-90"
                      >
                        {uploadProgress ? (
                          <><RefreshCw className="w-4 h-4 animate-spin" />Đang gửi {uploadProgress.current}/{uploadProgress.total}...</>
                        ) : (
                          <><Send className="w-4 h-4" />Gửi {pendingImages.length} ảnh</>
                        )}
                      </button>
                    ) : null}
                    <button onClick={handleSend} disabled={!draft.trim() || sendMutation.isPending || !!uploadProgress} className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50 hover:opacity-90"><Send className="w-4 h-4" />{sendMutation.isPending ? "Đang gửi..." : "Gửi"}</button>
                  </div>
                </div>
              </div>

              {/* LeadInfoPanel — desktop only */}
              <div className="hidden md:block">
                {lead && <LeadInfoPanel lead={lead} psid={selectedPsid} onOpenLead={() => window.location.assign("/crm")} onOpenCustomer={openCustomer} onSave={saveLead} onSyncProfile={() => syncOneProfileMutation.mutate(selectedPsid)} syncing={syncOneProfileMutation.isPending} />}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Create customer modal */}
      {showModal && selectedThread && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md shadow-xl mx-4">
            <h3 className="font-semibold text-base mb-4">Tạo khách hàng từ Facebook</h3>
            <div className="flex items-center gap-3 bg-muted rounded-xl p-3 mb-4">
              <Avatar url={selectedThread.lead?.avatarUrl ?? null} name={selectedThread.lead?.name ?? "Khách"} size={44} psid={selectedPsid ?? ""} />
              <div>
                <p className="font-medium text-sm">{selectedThread.lead?.name ?? `Khách ${selectedPsid?.slice(-6)}`}</p>
                <p className="text-xs text-muted-foreground"><a href={`https://www.facebook.com/${selectedPsid}`} target="_blank" rel="noopener noreferrer" className="hover:underline text-blue-600">facebook.com/{selectedPsid}</a></p>
                {selectedThread.lead?.phone && <p className="text-xs text-muted-foreground">SĐT đã có: {selectedThread.lead.phone}</p>}
              </div>
            </div>
            <div className="space-y-3 mb-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Số điện thoại (không bắt buộc)</label>
                <input type="tel" value={modalPhone} onChange={(e) => setModalPhone(e.target.value)} placeholder="0912 345 678" className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Zalo (không bắt buộc)</label>
                <input type="text" value={modalZalo} onChange={(e) => setModalZalo(e.target.value)} placeholder="0912 345 678" className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm rounded-xl border hover:bg-muted">Hủy</button>
              <button onClick={() => createCustomerMutation.mutate({ psid: selectedPsid!, phone: modalPhone, zalo: modalZalo })} disabled={createCustomerMutation.isPending} className="px-4 py-2 text-sm rounded-xl bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">{createCustomerMutation.isPending ? "Đang tạo..." : "Tạo khách hàng"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Image lightbox */}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      {/* Mobile edit lead bottom sheet */}
      {showEditSheet && selectedPsid && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowEditSheet(false)} />
          <div className="relative bg-card rounded-t-2xl shadow-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border shrink-0">
              <div>
                <p className="font-semibold text-sm">Sửa thông tin khách</p>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{lead?.name ?? `Khách ${selectedPsid.slice(-6)}`}</p>
              </div>
              <button onClick={() => setShowEditSheet(false)} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Tên khách</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Nhập tên thật..."
                  className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Số điện thoại</label>
                <input
                  type="tel"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  placeholder="0912 345 678"
                  className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Zalo</label>
                <input
                  type="text"
                  value={editZalo}
                  onChange={(e) => setEditZalo(e.target.value)}
                  placeholder="Số Zalo hoặc link..."
                  className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Ghi chú</label>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  placeholder="Ghi chú thêm về khách..."
                  rows={3}
                  className="w-full border rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div className="px-4 py-3 pb-10 border-t border-border shrink-0 flex gap-2">
              <button
                onClick={() => setShowEditSheet(false)}
                className="flex-1 py-2.5 text-sm rounded-xl border hover:bg-muted font-medium"
              >
                Hủy
              </button>
              <button
                onClick={async () => {
                  if (!lead?.id) return;
                  setEditSaving(true);
                  try {
                    const res = await authFetch(`${BASE}/api/crm-leads/${lead.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: editName, phone: editPhone, zalo: editZalo, notes: editNotes }),
                    });
                    if (!res.ok) throw new Error("Lưu thất bại");
                    await qc.invalidateQueries({ queryKey: ["fb-inbox-threads"] });
                    setShowEditSheet(false);
                  } catch {
                    alert("Không lưu được thông tin khách. Vui lòng thử lại.");
                  } finally {
                    setEditSaving(false);
                  }
                }}
                disabled={editSaving}
                className="flex-1 py-2.5 text-sm rounded-xl bg-primary text-primary-foreground font-medium disabled:opacity-50 hover:opacity-90 active:scale-[0.98]"
              >
                {editSaving ? "Đang lưu..." : "Lưu"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile action sheet (bottom sheet) */}
      {showActionSheet && selectedPsid && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowActionSheet(false)} />
          <div className="relative bg-card rounded-t-2xl shadow-2xl">
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <p className="font-semibold text-sm">{displayThreadName(lead, selectedPsid)}</p>
              <button onClick={() => setShowActionSheet(false)} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 pb-10 space-y-3 mt-1">
              {/* AI mode section */}
              {lead && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Chế độ AI cho khách này</p>
                  <div className="grid grid-cols-3 gap-2">
                    {([ { mode: "active", emoji: "🟢", label: "AI tự trả lời", sub: "Tự động trả khách" }, { mode: "paused", emoji: "⚫", label: "Tạm dừng AI", sub: "AI im lặng" }, { mode: "takeover", emoji: "🔴", label: "NV takeover", sub: "Nhân viên xử lý" } ] as { mode: "active"|"paused"|"takeover"; emoji: string; label: string; sub: string }[]).map(({ mode, emoji, label, sub }) => (
                      <button
                        key={mode}
                        onClick={() => { aiModeMutation.mutate({ psid: selectedPsid!, aiMode: mode }); setShowActionSheet(false); }}
                        disabled={aiModeMutation.isPending}
                        className={`flex flex-col items-center px-2 py-3 rounded-xl border text-xs font-medium transition-colors active:scale-[0.98] disabled:opacity-50 ${threadAiMode === mode ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted text-foreground"}`}
                      >
                        <span className="text-xl leading-none mb-1">{emoji}</span>
                        <span className="leading-tight text-center">{label}</span>
                        <span className="text-[9px] text-muted-foreground mt-0.5 font-normal">{sub}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!lead?.customerId && (
                <button onClick={() => { setShowActionSheet(false); setShowModal(true); setHint(""); }} className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm font-medium hover:bg-green-100 transition-colors active:scale-[0.98]">
                  <UserPlus className="w-5 h-5 shrink-0" />
                  Tạo khách hàng chính thức
                </button>
              )}
              {lead?.customerId && (
                <button onClick={() => { setShowActionSheet(false); window.location.assign(`/customers/${lead.customerId}`); }} className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-blue-50 border border-blue-200 text-blue-700 text-sm font-medium hover:bg-blue-100 transition-colors active:scale-[0.98]">
                  <UserPlus className="w-5 h-5 shrink-0" />
                  Mở hồ sơ khách hàng
                </button>
              )}
              <button onClick={() => { setShowActionSheet(false); window.location.assign("/crm"); }} className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border text-sm font-medium hover:bg-muted transition-colors active:scale-[0.98]">
                <MessageSquare className="w-5 h-5 shrink-0 text-muted-foreground" />
                Mở CRM Lead
              </button>
              <button onClick={() => { setShowActionSheet(false); window.location.assign(`/bookings/new?customerId=${lead?.customerId ?? ""}`); }} className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border text-sm font-medium hover:bg-muted transition-colors active:scale-[0.98]">
                <Send className="w-5 h-5 shrink-0 text-muted-foreground" />
                Tạo đơn hàng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
