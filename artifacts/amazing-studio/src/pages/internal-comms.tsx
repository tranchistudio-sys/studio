import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, Bell, AlertTriangle, Clock, CheckCircle2,
  Send, Plus, X, Users, Film, Calendar, User,
  AlertCircle, Check, RefreshCw, ChevronRight, Zap,
  ArrowLeft, Search, ChevronDown,
} from "lucide-react";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string, opts?: RequestInit) {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return fetch(url, {
    ...opts,
    headers: {
      ...opts?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function fetchJsonArray<T>(url: string): Promise<T[]> {
  try {
    const r = await authFetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}


type Notification = {
  id: number;
  recipientStaffId?: number | null;
  senderStaffId?: number | null;
  type: string;
  title: string;
  body?: string | null;
  message?: string | null;
  linkType?: string | null;
  linkId?: number | null;
  isRead: boolean;
  createdAt: string;
};

type Room = {
  id: number;
  name: string;
  type: string;
  linkType: string | null;
  linkId: number | null;
  createdByStaffId: number | null;
  isActive: boolean;
  createdAt: string;
};

type Message = {
  id: number;
  roomId: number;
  senderStaffId: number | null;
  senderName: string;
  content: string;
  isSystem: boolean;
  createdAt: string;
};

type DeadlineAlert = {
  id: number;
  jobCode: string;
  customerName: string;
  assignedStaffName: string;
  customerDeadline: string;
  internalDeadline: string;
  status: string;
  progressPercent: number;
  totalPhotos: number;
  donePhotos: number;
  daysLeft: number;
  urgency: string;
};

const URGENCY_CONFIG = {
  overdue: { label: "Quá hạn",     cls: "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400",     dot: "bg-red-500", border: "border-red-200 dark:border-red-800" },
  today:   { label: "Hôm nay!",    cls: "bg-orange-100 text-orange-700 dark:bg-orange-950/30 dark:text-orange-400", dot: "bg-orange-500", border: "border-orange-200 dark:border-orange-800" },
  urgent:  { label: "Sắp hết hạn", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400", dot: "bg-amber-500", border: "border-amber-200 dark:border-amber-800" },
  soon:    { label: "Cần chú ý",   cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-400", dot: "bg-yellow-400", border: "border-yellow-200 dark:border-yellow-800" },
};

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} giờ trước`;
  const days = Math.floor(hrs / 24);
  return `${days} ngày trước`;
}

type Tab = "alerts" | "notifications" | "chat";

const PRESET_ROOMS = [
  { name: "Studio nội bộ", type: "group" },
  { name: "Nhóm Chụp ảnh", type: "group" },
  { name: "Nhóm Makeup", type: "group" },
  { name: "Nhóm Photoshop", type: "group" },
];

export default function InternalCommsPage() {
  const qc = useQueryClient();
  const { viewer } = useStaffAuth();
  const [activeTab, setActiveTab] = useState<Tab>("alerts");
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoCreatedRef = useRef(false);

  const { data: notifications = [], isLoading: notifLoading } = useQuery<Notification[]>({
    queryKey: ["notifications"],
    queryFn: () => fetchJsonArray<Notification>(`${BASE}/api/notifications?limit=50`),
    refetchInterval: 30000,
  });

  const { data: alerts = [], isLoading: alertsLoading } = useQuery<DeadlineAlert[]>({
    queryKey: ["deadline-alerts"],
    queryFn: () => fetchJsonArray<DeadlineAlert>(`${BASE}/api/deadline-alerts`),
    refetchInterval: 60000,
  });

  const { data: rooms = [], isSuccess: roomsLoaded } = useQuery<Room[]>({
    queryKey: ["message-rooms"],
    queryFn: () => fetchJsonArray<Room>(`${BASE}/api/message-rooms`),
    refetchInterval: 30000,
  });

  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ["messages", selectedRoom?.id],
    queryFn: () => selectedRoom
      ? fetchJsonArray<Message>(`${BASE}/api/message-rooms/${selectedRoom.id}/messages`)
      : Promise.resolve([]),
    enabled: !!selectedRoom,
    refetchInterval: 8000,
  });

  const notifList = Array.isArray(notifications) ? notifications : [];
  const alertList = Array.isArray(alerts) ? alerts : [];
  const roomList = Array.isArray(rooms) ? rooms : [];
  const messageList = Array.isArray(messages) ? messages : [];
  const unreadCount = notifList.filter(n => !n.isRead).length;
  const overdueCount = alertList.filter(a => a.urgency === "overdue").length;
  const urgentCount = alertList.filter(a => a.urgency === "today" || a.urgency === "urgent").length;

  const markRead = useMutation({
    mutationFn: (id: number) => authFetch(`${BASE}/api/notifications/${id}/read`, { method: "PATCH" }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAllRead = useMutation({
    mutationFn: () => authFetch(`${BASE}/api/notifications/mark-all-read`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const sendMessage = useMutation({
    mutationFn: ({ roomId, content }: { roomId: number; content: string }) =>
      authFetch(`${BASE}/api/message-rooms/${roomId}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderStaffId: viewer?.id ?? null,
          senderName: viewer?.name ?? "Quản trị viên",
          content,
        })
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messages", selectedRoom?.id] });
      setNewMessage("");
      setTimeout(() => inputRef.current?.focus(), 50);
    },
  });

  const createRoom = useMutation({
    mutationFn: (name: string) => authFetch(`${BASE}/api/message-rooms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type: "group", createdByStaffId: viewer?.id ?? null })
    }).then(r => r.json()),
    onSuccess: (room: Room) => {
      qc.invalidateQueries({ queryKey: ["message-rooms"] });
      setShowNewRoom(false);
      setNewRoomName("");
      setSelectedRoom(room);
      setChatOpen(true);
      setActiveTab("chat");
    },
  });

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messageList]);

  // Auto-open default room when entering chat tab
  useEffect(() => {
    if (activeTab !== "chat" || !roomsLoaded) return;
    if (roomList.length > 0) {
      const def = roomList.find(r => r.name === "Amazing Studio nội bộ") ?? roomList[0];
      setSelectedRoom(def);
      setChatOpen(true);
    } else if (!autoCreatedRef.current && !createRoom.isPending) {
      autoCreatedRef.current = true;
      createRoom.mutate("Amazing Studio nội bộ");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, roomsLoaded, roomList.length]);

  const TABS = [
    { key: "alerts" as Tab, label: "Nhắc deadline", icon: AlertTriangle, badge: overdueCount + urgentCount },
    { key: "notifications" as Tab, label: "Thông báo", icon: Bell, badge: unreadCount },
    { key: "chat" as Tab, label: "Chat nội bộ", icon: MessageSquare, badge: 0 },
  ];

  function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!newMessage.trim() || !selectedRoom) return;
    sendMessage.mutate({ roomId: selectedRoom.id, content: newMessage.trim() });
  }

  function openRoom(room: Room) {
    setSelectedRoom(room);
    setChatOpen(true);
  }

  function closeChatView() {
    setChatOpen(false);
  }

  // ─── Full-screen chat view (mobile: overlay; desktop: right panel) ─────────
  const ChatView = () => (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Room header */}
      <div className="px-4 py-3 border-b border-border flex items-center gap-3 bg-background flex-shrink-0">
        <button onClick={closeChatView}
          className="p-1.5 rounded-xl hover:bg-muted text-muted-foreground lg:hidden">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Users className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate">{selectedRoom?.name}</p>
          <p className="text-[10px] text-muted-foreground">Nhóm · {messageList.length} tin nhắn</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 overscroll-contain">
        {messageList.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
            <MessageSquare className="w-12 h-12 mb-3 opacity-20" />
            <p className="font-medium text-sm">Chưa có tin nhắn</p>
            <p className="text-xs mt-1">Hãy gửi tin nhắn đầu tiên</p>
          </div>
        ) : (
          messageList.map(msg => {
            const isMe = msg.senderStaffId !== null && msg.senderStaffId === (viewer?.id ?? -1);
            if (msg.isSystem) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="max-w-xs bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-2xl px-3 py-2 text-center">
                    <Zap className="w-3 h-3 inline mr-1 text-amber-500" />
                    <span className="text-xs text-amber-700 dark:text-amber-300">{msg.content}</span>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{timeAgo(msg.createdAt)}</p>
                  </div>
                </div>
              );
            }
            return (
              <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"} items-end gap-2`}>
                {!isMe && (
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 text-xs font-bold text-primary">
                    {msg.senderName.charAt(0)}
                  </div>
                )}
                <div className={`max-w-[75%] sm:max-w-sm flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                  {!isMe && (
                    <p className="text-[10px] text-muted-foreground mb-0.5 px-2">{msg.senderName}</p>
                  )}
                  <div className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${isMe
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted rounded-bl-sm"
                  }`}>
                    {msg.content}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1 px-1">{timeAgo(msg.createdAt)}</p>
                </div>
                {isMe && (
                  <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0 text-xs font-bold text-primary-foreground">
                    {(viewer?.name ?? "?").charAt(0)}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Message input — sticky at bottom */}
      <form onSubmit={handleSendMessage}
        className="px-3 py-3 border-t border-border flex gap-2 bg-background flex-shrink-0 sticky bottom-0">
        <input
          ref={inputRef}
          value={newMessage}
          onChange={e => setNewMessage(e.target.value)}
          placeholder="Nhập tin nhắn nội bộ..."
          className="flex-1 text-sm border border-border rounded-2xl px-4 py-3 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 min-h-[44px]"
        />
        <button type="submit"
          disabled={!newMessage.trim() || sendMessage.isPending}
          className="w-11 h-11 bg-primary text-primary-foreground rounded-2xl flex items-center justify-center hover:bg-primary/90 disabled:opacity-50 transition-colors flex-shrink-0">
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
              <MessageSquare className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-bold">Trao đổi & Nhắc việc</h1>
              <p className="text-xs text-muted-foreground hidden sm:block">
                {overdueCount > 0 && <span className="text-red-500 font-medium">{overdueCount} quá hạn · </span>}
                {urgentCount > 0 && <span className="text-amber-500 font-medium">{urgentCount} sắp hết hạn · </span>}
                {unreadCount > 0 && <span className="text-blue-500 font-medium">{unreadCount} chưa đọc</span>}
                {overdueCount === 0 && urgentCount === 0 && unreadCount === 0 && "Không có cảnh báo mới"}
              </p>
            </div>
          </div>
        </div>

        {/* Tab bar — large touch targets on mobile */}
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {TABS.map(tab => (
            <button key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 rounded-xl text-sm font-medium transition-colors relative whitespace-nowrap flex-shrink-0 ${activeTab === tab.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}>
              <tab.icon className="w-4 h-4" />
              <span className="hidden xs:inline">{tab.label}</span>
              <span className="xs:hidden">{tab.key === "alerts" ? "Deadline" : tab.key === "notifications" ? "Thông báo" : "Chat"}</span>
              {tab.badge > 0 && (
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${activeTab === tab.key ? "bg-white/20 text-white" : "bg-red-500 text-white"}`}>
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex relative">

        {/* ── Tab: Deadline Alerts ── */}
        {activeTab === "alerts" && (
          <div className="flex-1 overflow-auto p-4 sm:p-6">
            {alertsLoading ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Đang tải...
              </div>
            ) : alertList.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <CheckCircle2 className="w-12 h-12 mb-3 text-emerald-400 opacity-60" />
                <p className="font-medium">Không có deadline nào cần chú ý</p>
                <p className="text-sm mt-1">Tất cả job đang trong thời hạn</p>
              </div>
            ) : (
              <div className="space-y-3 max-w-2xl">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">
                  {alertList.length} job cần chú ý
                </p>
                {alertList.map(alert => {
                  const cfg = URGENCY_CONFIG[alert.urgency as keyof typeof URGENCY_CONFIG] ?? URGENCY_CONFIG.soon;
                  return (
                    <div key={alert.id} className={`rounded-2xl border p-4 bg-card ${cfg.border}`}>
                      <div className="flex items-start gap-3">
                        <div className={`w-2.5 h-2.5 rounded-full mt-2 flex-shrink-0 ${cfg.dot}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cfg.cls}`}>{cfg.label}</span>
                            <span className="font-semibold text-sm">{alert.jobCode}</span>
                            <span className="text-sm text-muted-foreground">· {alert.customerName}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
                            {alert.assignedStaffName && (
                              <span className="flex items-center gap-1"><User className="w-3 h-3" />{alert.assignedStaffName}</span>
                            )}
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              Deadline: {new Date(alert.customerDeadline).toLocaleDateString("vi-VN")}
                            </span>
                            <span className={`font-semibold ${alert.daysLeft < 0 ? "text-red-600" : alert.daysLeft === 0 ? "text-orange-600" : "text-amber-600"}`}>
                              {alert.daysLeft < 0 ? `Trễ ${-alert.daysLeft} ngày` : alert.daysLeft === 0 ? "Hôm nay!" : `Còn ${alert.daysLeft} ngày`}
                            </span>
                          </div>
                          <div className="mt-2">
                            <div className="h-1.5 bg-muted rounded-full overflow-hidden w-full max-w-48">
                              <div
                                className={`h-full rounded-full ${alert.progressPercent >= 100 ? "bg-emerald-500" : alert.progressPercent >= 60 ? "bg-blue-500" : "bg-red-400"}`}
                                style={{ width: `${Math.min(100, alert.progressPercent)}%` }}
                              />
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">Tiến độ: {alert.progressPercent}%</p>
                          </div>
                        </div>
                        <a href={`${import.meta.env.BASE_URL}photoshop-jobs`}
                          className="flex-shrink-0 text-xs text-primary hover:underline flex items-center gap-1">
                          Xem <ChevronRight className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Notifications ── */}
        {activeTab === "notifications" && (
          <div className="flex-1 overflow-auto p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4 max-w-2xl">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {notifList.length} thông báo · {unreadCount} chưa đọc
              </p>
              {unreadCount > 0 && (
                <button onClick={() => markAllRead.mutate()}
                  className="text-xs text-primary hover:underline font-medium">
                  Đánh dấu tất cả đã đọc
                </button>
              )}
            </div>
            {notifLoading ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Đang tải...
              </div>
            ) : notifList.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <Bell className="w-12 h-12 mb-3 opacity-20" />
                <p className="font-medium">Chưa có thông báo</p>
              </div>
            ) : (
              <div className="space-y-2 max-w-2xl">
                {notifList.map(n => (
                  <div key={n.id}
                    className={`rounded-xl border p-4 bg-card cursor-pointer hover:bg-muted/30 transition-colors ${!n.isRead ? "border-primary/30 bg-primary/5" : "border-border"}`}
                    onClick={() => { if (!n.isRead) markRead.mutate(n.id); }}>
                    <div className="flex items-start gap-3">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${n.type === "warning" ? "bg-amber-100 text-amber-600" : n.type === "error" ? "bg-red-100 text-red-600" : n.type === "success" ? "bg-emerald-100 text-emerald-600" : "bg-blue-100 text-blue-600"}`}>
                        {n.type === "warning" ? <AlertTriangle className="w-4 h-4" /> : n.type === "error" ? <AlertCircle className="w-4 h-4" /> : n.type === "success" ? <CheckCircle2 className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className={`text-sm font-medium ${!n.isRead ? "text-foreground" : "text-muted-foreground"}`}>{n.title}</p>
                          {!n.isRead && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />}
                        </div>
                        {(n.message ?? n.body) && <p className="text-xs text-muted-foreground mt-0.5">{n.message ?? n.body}</p>}
                        <p className="text-xs text-muted-foreground mt-1">{timeAgo(n.createdAt)}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Chat ── */}
        {activeTab === "chat" && (
          <>
            {/* Mobile: show room list OR full-screen chat (overlay) */}
            {/* Desktop: show both side-by-side */}
            <div className={`${chatOpen ? "hidden lg:flex" : "flex"} flex-1 flex-col overflow-hidden`}>
              {/* Action buttons */}
              <div className="p-4 border-b border-border flex flex-wrap gap-2">
                <button onClick={() => setShowNewRoom(true)}
                  className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors min-h-[44px]">
                  <Plus className="w-4 h-4" />
                  Tạo nhóm chat
                </button>
                {PRESET_ROOMS.map(preset => {
                  const exists = rooms.some(r => r.name === preset.name);
                  if (exists) return null;
                  return (
                    <button key={preset.name}
                      onClick={() => createRoom.mutate(preset.name)}
                      className="flex items-center gap-2 px-3 py-2 border border-dashed border-border rounded-xl text-xs text-muted-foreground hover:text-foreground hover:border-foreground transition-colors">
                      <Plus className="w-3.5 h-3.5" /> {preset.name}
                    </button>
                  );
                })}
              </div>

              {/* Create room form */}
              {showNewRoom && (
                <div className="p-4 border-b border-border bg-muted/30">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Tên phòng chat mới</p>
                  <div className="flex gap-2">
                    <input
                      value={newRoomName}
                      onChange={e => setNewRoomName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && newRoomName.trim()) createRoom.mutate(newRoomName.trim()); }}
                      placeholder="VD: Nhóm ekip T4..."
                      autoFocus
                      className="flex-1 text-sm border border-border rounded-xl px-3 py-2.5 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 min-h-[44px]"
                    />
                    <button onClick={() => newRoomName.trim() && createRoom.mutate(newRoomName.trim())}
                      className="px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-semibold">Tạo</button>
                    <button onClick={() => { setShowNewRoom(false); setNewRoomName(""); }}
                      className="p-2 border border-border rounded-xl text-muted-foreground hover:bg-muted"><X className="w-4 h-4" /></button>
                  </div>
                </div>
              )}

              {/* Room list */}
              <div className="flex-1 overflow-y-auto">
                {roomList.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p className="font-medium text-sm">Chưa có phòng chat nào</p>
                    <p className="text-xs mt-1">Bấm "Tạo nhóm chat" để bắt đầu</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {roomList.map(room => (
                      <button key={room.id}
                        onClick={() => openRoom(room)}
                        className={`w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-muted/50 transition-colors ${selectedRoom?.id === room.id ? "bg-primary/5 border-l-2 border-primary" : ""}`}>
                        <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <Users className="w-5 h-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm truncate">{room.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">Bấm để mở chat</p>
                        </div>
                        <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Desktop: chat panel alongside list */}
            <div className="hidden lg:flex flex-1 border-l border-border overflow-hidden">
              {selectedRoom ? (
                <ChatView />
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                  <MessageSquare className="w-12 h-12 mb-3 opacity-20" />
                  <p className="font-medium">Chọn phòng để bắt đầu chat</p>
                  <p className="text-sm mt-1">Hoặc tạo phòng mới bằng nút trên</p>
                </div>
              )}
            </div>

            {/* Mobile: Full-screen chat overlay */}
            {chatOpen && selectedRoom && (
              <div className="absolute inset-0 z-10 bg-background flex flex-col lg:hidden">
                <ChatView />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
