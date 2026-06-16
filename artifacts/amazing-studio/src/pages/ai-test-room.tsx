import React, { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Trash2, Plus, Send, RefreshCw, Bug, ArrowLeft, FlaskConical, X, ChevronDown, ChevronUp, FileDown, FileText, Download } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string, options?: RequestInit) {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return fetch(url, {
    ...options,
    headers: {
      ...(options?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

type SessionSummary = {
  id: string;
  name: string;
  customerName: string;
  scriptId: number | null;
  currentScriptId: number | null;
  currentSaleStep: number | null;
  scriptUpdatedAt: string | null;
  messageCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  createdAt: string;
};

type TestMessage = {
  id: string;
  role: "user" | "bot";
  text: string;
  type?: "text" | "image" | "follow_up_auto";
  decision?: string;
  currentStep?: number;
  source?: "qa" | "gpt";
  score?: number;
  createdAt: string;
};

type SessionDebug = {
  sessionId: string;
  currentStep: number | null;
  scriptId: number | null;
  scriptUpdatedAt: string | null;
  lastCustomerMessageAt: string | null;
  nextFollowUpAt: string | null;
  lastFollowUpAt: string | null;
  lastFollowUpStep: number | null;
  lastFollowUpSlotIndex: number | null;
  followUpCount: number;
  slotMatched: boolean;
  slotMatchReason: string;
};

type DebugInfo = {
  decision: string;
  scriptId: number | null;
  scriptName: string | null;
  step: number | null;
  rawGptResponse: string | null;
  chunks: string[];
  qaMatch: { matched: boolean; rowId: number | null; score: number };
  isOutOfScope: boolean;
  shouldHandoff: boolean;
  sendPriceImages?: boolean;
  sendPriceTextAfterImage?: boolean;
  priceImageCount?: number;
};

type ScriptOption = { id: number; name: string };

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "vừa xong";
  if (diff < 3600) return `${Math.floor(diff / 60)} phút`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ`;
  return new Date(iso).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

function resolveImageUrl(src: string) {
  const clean = src.trim();
  if (!clean) return "";
  if (clean.startsWith("http://") || clean.startsWith("https://")) return clean;
  const normalized = clean.replace(/^\/objects\//, "");
  return `${BASE}/api/storage/objects/${normalized}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const getChunkDelay = (text: string) => 800 + Math.min(2000, text.length * 25);

const AVATAR_COLORS = [
  "from-violet-500 to-purple-600",
  "from-blue-500 to-indigo-600",
  "from-emerald-500 to-teal-600",
  "from-rose-500 to-pink-600",
  "from-orange-500 to-amber-600",
];

function avatarColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xfffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const sz = size === "sm" ? "h-8 w-8 text-xs" : size === "lg" ? "h-11 w-11 text-base" : "h-9 w-9 text-sm";
  return (
    <div className={cn("rounded-full bg-gradient-to-br flex items-center justify-center text-white font-bold flex-shrink-0", avatarColor(name), sz)}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function decisionLabel(decision: string): string {
  if (decision.startsWith("qa_matched")) return "Khớp Q&A";
  if (decision === "unknown_question") return "Câu hỏi lạ";
  if (decision.includes("ai_error")) return "Lỗi AI";
  if (decision.startsWith("auto_replied")) return "GPT trả lời";
  if (decision === "gpt_fallback") return "GPT dự phòng";
  return decision;
}

function decisionBadgeColor(decision: string) {
  if (decision.startsWith("qa_matched")) return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (decision === "unknown_question") return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  if (decision.includes("ai_error")) return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
  if (decision.startsWith("auto_replied")) return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
  if (decision === "gpt_fallback") return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
  return "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300";
}

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2 mb-2">
      <div className="h-7 w-7 rounded-full bg-gradient-to-br from-slate-400 to-slate-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
        AI
      </div>
      <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center">
        <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:0ms]" />
        <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:150ms]" />
        <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

class AiTestErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorMsg: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMsg: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMsg: error?.message ?? "Lỗi không xác định" };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[AiTestRoom] crash:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full flex flex-col items-center justify-center text-center p-8 gap-4">
          <div className="h-14 w-14 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
            <span className="text-2xl">⚠️</span>
          </div>
          <div>
            <p className="text-sm font-semibold text-destructive">Trang gặp lỗi</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">{this.state.errorMsg}</p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors"
          >
            Tải lại trang
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AiTestRoomInner() {
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
  const [showDebugDrawer, setShowDebugDrawer] = useState(false);
  const [showRawGpt, setShowRawGpt] = useState(false);
  const [inputText, setInputText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [saveUnknown, setSaveUnknown] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newSessionName, setNewSessionName] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newScriptId, setNewScriptId] = useState<string>("none");
  const [sessionDebug, setSessionDebug] = useState<SessionDebug | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [followUpCountdown, setFollowUpCountdown] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const animIdRef = useRef<number>(0);

  const { data: sessions = [], isLoading: sessionsLoading, isError: sessionsError } = useQuery<SessionSummary[]>({
    queryKey: ["ai-test-sessions"],
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/ai-test/sessions`);
      if (!r.ok) throw new Error("Lỗi tải danh sách session");
      return r.json();
    },
    select: (data) => (Array.isArray(data) ? data : []),
    refetchInterval: false,
    retry: 1,
  });

  const { data: scripts = [] } = useQuery<ScriptOption[]>({
    queryKey: ["ai-test-scripts"],
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/ai-test/scripts`);
      if (!r.ok) return [];
      return r.json();
    },
    select: (data) => (Array.isArray(data) ? data : []),
  });

  const selectedSession = sessions?.find((s) => s.id === selectedId);

  const createSession = useMutation({
    mutationFn: async () => {
      const r = await authFetch(`${BASE}/api/ai-test/sessions`, {
        method: "POST",
        body: JSON.stringify({
          name: newSessionName.trim() || undefined,
          customerName: newCustomerName.trim() || undefined,
          scriptId: newScriptId !== "none" ? Number(newScriptId) : null,
        }),
      });
      if (!r.ok) throw new Error("Tạo session thất bại");
      return r.json() as Promise<SessionSummary>;
    },
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ["ai-test-sessions"] });
      setSelectedId(session.id);
      setMessages([]);
      setDebugInfo(null);
      setSessionDebug(null);
      setNewSessionName("");
      setNewCustomerName("");
      setNewScriptId("none");
      setShowNewDialog(false);
      setMobileView("chat");
      setTimeout(() => inputRef.current?.focus(), 150);
    },
  });

  const deleteSession = useMutation({
    mutationFn: async (id: string) => {
      await authFetch(`${BASE}/api/ai-test/sessions/${id}`, { method: "DELETE" });
    },
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["ai-test-sessions"] });
      if (selectedId === id) {
        setSelectedId(null);
        setMessages([]);
        setDebugInfo(null);
        setMobileView("list");
      }
    },
  });

  const resetSession = useMutation({
    mutationFn: async (id: string) => {
      const r = await authFetch(`${BASE}/api/ai-test/sessions/${id}/reset`, {
        method: "POST",
        body: JSON.stringify({ customerName: selectedSession?.customerName ?? "Khách Test", scriptId: selectedSession?.scriptId ?? null }),
      });
      if (!r.ok) throw new Error("Reset thất bại");
      return r.json() as Promise<{ success: boolean; session: SessionSummary }>;
    },
    onSuccess: () => {
      animIdRef.current++;
      setIsTyping(false);
      setMessages([]);
      setDebugInfo(null);
      setSessionDebug(null);
      qc.invalidateQueries({ queryKey: ["ai-test-sessions"] });
      setTimeout(() => inputRef.current?.focus(), 100);
    },
  });

  const sendMessage = useMutation({
    mutationFn: async ({ sessionId, text }: { sessionId: string; text: string }) => {
      const r = await authFetch(`${BASE}/api/ai-test/sessions/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ text, saveUnknown }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: "Lỗi không xác định" }));
        throw new Error((err as { error?: string }).error ?? "Lỗi gửi tin nhắn");
      }
      return r.json() as Promise<{ messages: TestMessage[]; debug: DebugInfo }>;
    },
    onMutate: ({ text }) => {
      setIsTyping(true);
      const optimistic: TestMessage = {
        id: `optimistic-${Date.now()}`,
        role: "user",
        text,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
    },
    onSuccess: async (data) => {
      const myId = ++animIdRef.current;
      const allMessages = data.messages;

      // Find the last user message — bot replies come after it
      let lastUserIdx = -1;
      for (let i = allMessages.length - 1; i >= 0; i--) {
        if (allMessages[i].role === "user") { lastUserIdx = i; break; }
      }

      const refreshDebug = () => {
        authFetch(`${BASE}/api/ai-test/sessions/${selectedId ?? ""}/debug`)
          .then((r) => r.ok ? r.json() : null)
          .then((d) => { if (d) setSessionDebug(d as SessionDebug); })
          .catch(() => {});
      };

      // No bot replies to animate — show everything at once
      if (lastUserIdx < 0 || lastUserIdx >= allMessages.length - 1) {
        setMessages(allMessages);
        setDebugInfo(data.debug);
        setIsTyping(false);
        refreshDebug();
        qc.invalidateQueries({ queryKey: ["ai-test-sessions"] });
        return;
      }

      const prevMessages = allMessages.slice(0, lastUserIdx + 1);
      const botReplies = allMessages.slice(lastUserIdx + 1);

      setMessages(prevMessages);
      setDebugInfo(data.debug);
      // isTyping already true from onMutate

      const shownMessages: TestMessage[] = [...prevMessages];
      for (let i = 0; i < botReplies.length; i++) {
        // Typing indicator is visible — wait based on reply length
        await sleep(getChunkDelay(botReplies[i].text));
        if (animIdRef.current !== myId) return;

        setIsTyping(false);
        shownMessages.push(botReplies[i]);
        setMessages([...shownMessages]);

        if (i < botReplies.length - 1) {
          await sleep(300);
          if (animIdRef.current !== myId) return;
          setIsTyping(true);
        }
      }

      if (animIdRef.current !== myId) return;
      setMessages(allMessages);
      refreshDebug();
      qc.invalidateQueries({ queryKey: ["ai-test-sessions"] });
    },
    onError: (err) => {
      animIdRef.current++;
      setIsTyping(false);
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("optimistic-")));
      alert((err as Error).message);
    },
  });

  useEffect(() => {
    console.log("AI TEST PAGE MOUNTED");
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // SSE connection for live follow-up push from the server
  useEffect(() => {
    if (!selectedId) return;
    const token = localStorage.getItem("amazingStudioToken_v2");
    if (!token) return;

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const connect = () => {
      if (destroyed) return;
      const url = `${BASE}/api/ai-test/sessions/${selectedId}/events?token=${encodeURIComponent(token)}`;
      es = new EventSource(url);

      es.onopen = () => {
        setSseConnected(true);
      };

      es.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data) as { type: string; message?: TestMessage; debug?: SessionDebug };
          if (evt.type === "follow_up" && evt.message) {
            setMessages((prev) => {
              const exists = prev.some((m) => m.id === evt.message!.id);
              if (exists) return prev;
              return [...prev, evt.message!];
            });
            // Refresh debug state after a follow-up fires
            authFetch(`${BASE}/api/ai-test/sessions/${selectedId}/debug`)
              .then((r) => r.ok ? r.json() : null)
              .then((d) => { if (d) setSessionDebug(d as SessionDebug); })
              .catch(() => {});
          }
        } catch { /* ignore malformed events */ }
      };

      es.onerror = () => {
        setSseConnected(false);
        es?.close();
        es = null;
        if (!destroyed) {
          reconnectTimer = setTimeout(connect, 5000);
        }
      };
    };

    connect();

    return () => {
      destroyed = true;
      setSseConnected(false);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [selectedId]);

  // Fallback poll for new messages every 30s (catches anything SSE might miss)
  useEffect(() => {
    if (!selectedId) return;
    const poll = async () => {
      if (document.hidden || isTyping) return;
      try {
        const r = await authFetch(`${BASE}/api/ai-test/sessions/${selectedId}/messages`);
        if (!r.ok) return;
        const data = await r.json() as { messages: TestMessage[] };
        if (!Array.isArray(data.messages)) return;
        setMessages((prev) => {
          if (data.messages.length > prev.length) return data.messages;
          return prev;
        });
      } catch { /* ignore */ }
    };
    const timer = setInterval(poll, 30000);
    return () => clearInterval(timer);
  }, [selectedId, isTyping]);

  // Fetch debug state on session open and poll every 30s as fallback
  useEffect(() => {
    if (!selectedId) return;
    const fetchDebug = async () => {
      if (document.hidden) return;
      try {
        const r = await authFetch(`${BASE}/api/ai-test/sessions/${selectedId}/debug`);
        if (r.ok) setSessionDebug(await r.json() as SessionDebug);
      } catch { /* ignore */ }
    };
    fetchDebug();
    const timer = setInterval(fetchDebug, 30000);
    return () => clearInterval(timer);
  }, [selectedId]);

  // Live countdown ticker — ticks every second from nextFollowUpAt
  useEffect(() => {
    if (!sessionDebug?.nextFollowUpAt) {
      setFollowUpCountdown(null);
      return;
    }
    const fireAt = new Date(sessionDebug.nextFollowUpAt).getTime();
    const tick = () => {
      const diff = Math.ceil((fireAt - Date.now()) / 1000);
      if (diff <= 0) {
        setFollowUpCountdown("Đang gửi…");
      } else if (diff < 60) {
        setFollowUpCountdown(`${diff}s`);
      } else if (diff < 3600) {
        const m = Math.floor(diff / 60);
        const s = diff % 60;
        setFollowUpCountdown(`${m}p ${s < 10 ? "0" : ""}${s}s`);
      } else {
        const h = Math.floor(diff / 3600);
        const m = Math.floor((diff % 3600) / 60);
        setFollowUpCountdown(`${h}g ${m}p`);
      }
    };
    tick();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      tick();
      timer = setInterval(tick, 1000);
    };
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    if (!document.hidden) start();
    const onVis = () => { if (document.hidden) stop(); else start(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [sessionDebug?.nextFollowUpAt]);

  const handleSelectSession = useCallback(async (id: string) => {
    animIdRef.current++;
    setIsTyping(false);
    setSelectedId(id);
    setDebugInfo(null);
    setSessionDebug(null);
    setMobileView("chat");
    try {
      const r = await authFetch(`${BASE}/api/ai-test/sessions/${id}/messages`);
      if (r.ok) {
        const data = await r.json() as { messages: TestMessage[] };
        setMessages(data.messages);
      }
    } catch {
      setMessages([]);
    }
    setTimeout(() => inputRef.current?.focus(), 200);
  }, []);

  const [isExportingAll, setIsExportingAll] = useState(false);

  const handleExportAll = async () => {
    if (isExportingAll) return;
    setIsExportingAll(true);
    try {
      const token = localStorage.getItem("amazingStudioToken_v2");
      const url = `${BASE}/api/ai-test/sessions/export-all`;
      const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) { alert("Không thể xuất tất cả phiên test"); return; }
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      a.download = `tat-ca-phien-test-${date}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setIsExportingAll(false);
    }
  };

  const handleExportCsv = async () => {
    if (!selectedId) return;
    const token = localStorage.getItem("amazingStudioToken_v2");
    const url = `${BASE}/api/ai-test/sessions/${selectedId}/export?format=csv`;
    const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) { alert("Không thể xuất CSV"); return; }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `phien-test-${selectedId}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleExportPdf = async () => {
    if (!selectedId || !selectedSession) return;
    const token = localStorage.getItem("amazingStudioToken_v2");
    const url = `${BASE}/api/ai-test/sessions/${selectedId}/export`;
    const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) { alert("Không thể xuất PDF"); return; }
    const data = await r.json() as {
      session: { name: string; customerName: string; scriptName: string | null; scriptUpdatedAt: string | null; currentSaleStep: number | null; createdAt: string; messageCount: number };
      aggregates?: { totalMessages: number; qaCount: number; gptCount: number; followUpCount: number; stepsReached: number[] };
      messages: TestMessage[];
    };

    const formatDt = (iso: string) =>
      new Date(iso).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

    const esc = (v: unknown): string =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const msgHtml = data.messages.map((m) => {
      const isUser = m.role === "user";
      const isFollowUp = m.type === "follow_up_auto";
      let labelHtml = "";
      if (isFollowUp && m.decision) {
        const match = m.decision.match(/step(\d+)_slot(\d+)/);
        if (match) {
          labelHtml = `<div class="fu-label">⏰ Follow-up · Bước ${esc(match[1])} · Slot ${esc(String(Number(match[2]) + 1))}</div>`;
        }
      }
      let badgeHtml = "";
      if (!isFollowUp && m.role === "bot") {
        if (m.currentStep != null) badgeHtml += `<span class="badge step">Bước ${esc(m.currentStep)}</span>`;
        if (m.source === "qa" || m.source === "gpt") {
          const label = m.source === "qa" ? "QA" : "GPT";
          const score = m.score != null ? ` · ${m.score.toFixed(2)}` : "";
          badgeHtml += `<span class="badge ${m.source === "qa" ? "qa" : "gpt"}">${label}${esc(score)}</span>`;
        }
      }
      const bubbleClass = isUser ? "bubble-user" : isFollowUp ? "bubble-followup" : "bubble-bot";
      const rowClass = isUser ? "row-user" : "row-bot";
      const contentHtml = m.type === "image"
        ? `<div class="img-placeholder">📷 [Ảnh bảng giá]</div>`
        : `<div class="${bubbleClass}">${esc(m.text).replace(/\n/g, "<br>")}</div>`;
      return `<div class="msg-row ${rowClass}">
        ${labelHtml}
        ${contentHtml}
        <div class="meta">${esc(formatDt(m.createdAt))}${badgeHtml}</div>
      </div>`;
    }).join("");

    // ── Decision summary aggregates (prefer server-computed, fall back to local) ──
    const _botMsgs = data.messages.filter((m) => m.role === "bot");
    const followUpCount = data.aggregates?.followUpCount
      ?? data.messages.filter((m) => m.type === "follow_up_auto").length;
    const qaCount = data.aggregates?.qaCount
      ?? _botMsgs.filter(
        (m) => m.type !== "follow_up_auto" && (m.source === "qa" || (m.decision ?? "").startsWith("qa_matched")),
      ).length;
    const gptCount = data.aggregates?.gptCount
      ?? _botMsgs.filter(
        (m) => m.type !== "follow_up_auto" && m.source !== "qa" && !(m.decision ?? "").startsWith("qa_matched"),
      ).length;
    const stepsReached = data.aggregates?.stepsReached
      ?? [...new Set(
        _botMsgs
          .filter((m) => m.type !== "follow_up_auto" && m.currentStep != null)
          .map((m) => m.currentStep as number),
      )].sort((a, b) => a - b);

    const sessionNameEsc = esc(data.session.name);
    const customerNameEsc = esc(data.session.customerName);
    const scriptLabel = esc(data.session.scriptName ?? "(Không có)") +
      (data.session.scriptUpdatedAt ? ` · v.${esc(new Date(data.session.scriptUpdatedAt).toLocaleDateString("vi-VN"))}` : "") +
      (data.session.currentSaleStep != null ? ` · Đang ở Bước ${esc(data.session.currentSaleStep)}` : "");
    const createdAtEsc = esc(formatDt(data.session.createdAt));

    const stepsLabel = stepsReached.length > 0
      ? stepsReached.map((s) => `Bước ${esc(s)}`).join(", ")
      : "<em>Chưa có</em>";

    const summaryTableHtml = `
  <table class="summary-table">
    <thead><tr><th colspan="2">Tóm tắt quyết định AI</th></tr></thead>
    <tbody>
      <tr><td>Tổng tin nhắn</td><td class="num">${esc(data.session.messageCount)}</td></tr>
      <tr><td>Bot trả lời QA matching</td><td class="num qa-num">${esc(qaCount)}</td></tr>
      <tr><td>Bot trả lời GPT</td><td class="num gpt-num">${esc(gptCount)}</td></tr>
      <tr><td>Follow-up tự động</td><td class="num fu-num">${esc(followUpCount)}</td></tr>
      <tr><td>Các bước sale đã đạt</td><td class="steps">${stepsLabel}</td></tr>
    </tbody>
  </table>`;

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>Phiên test: ${sessionNameEsc}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; padding: 32px; }
  h1 { font-size: 18px; font-weight: 700; color: #4c1d95; margin-bottom: 4px; }
  .meta-block { background: #f3f0ff; border: 1px solid #ddd6fe; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  .meta-block p { font-size: 12px; color: #555; margin: 2px 0; }
  .meta-block strong { color: #1a1a1a; }
  .summary-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px; }
  .summary-table th { background: #4c1d95; color: #fff; text-align: left; padding: 7px 12px; font-size: 12px; border-radius: 4px 4px 0 0; }
  .summary-table td { padding: 6px 12px; border-bottom: 1px solid #e5e7eb; color: #374151; }
  .summary-table tr:last-child td { border-bottom: none; }
  .summary-table tr:nth-child(even) td { background: #f9fafb; }
  .summary-table .num { font-weight: 700; text-align: right; width: 60px; }
  .summary-table .qa-num { color: #065f46; }
  .summary-table .gpt-num { color: #1e40af; }
  .summary-table .fu-num { color: #b45309; }
  .summary-table .steps { font-weight: 600; color: #6d28d9; }
  .chat { display: flex; flex-direction: column; gap: 8px; }
  .msg-row { display: flex; flex-direction: column; max-width: 70%; }
  .row-user { align-self: flex-end; align-items: flex-end; }
  .row-bot { align-self: flex-start; align-items: flex-start; }
  .bubble-user { background: linear-gradient(135deg, #c026d3, #7c3aed, #4338ca); color: #fff; padding: 8px 14px; border-radius: 14px 14px 3px 14px; font-size: 13px; line-height: 1.5; }
  .bubble-bot { background: #f3f4f6; color: #111; padding: 8px 14px; border-radius: 14px 14px 14px 3px; font-size: 13px; line-height: 1.5; border: 1px solid #e5e7eb; }
  .bubble-followup { background: #fffbeb; color: #78350f; padding: 8px 14px; border-radius: 14px 14px 14px 3px; font-size: 13px; line-height: 1.5; border: 1px solid #fde68a; }
  .fu-label { font-size: 10px; color: #b45309; font-weight: 600; margin-bottom: 2px; }
  .img-placeholder { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 16px; color: #64748b; font-size: 12px; }
  .meta { font-size: 10px; color: #9ca3af; margin-top: 3px; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  .badge { font-size: 10px; border-radius: 4px; padding: 1px 5px; font-weight: 500; }
  .badge.step { background: #ede9fe; color: #6d28d9; }
  .badge.qa { background: #d1fae5; color: #065f46; }
  .badge.gpt { background: #dbeafe; color: #1e40af; }
  .divider { border: none; border-top: 1px solid #e5e7eb; margin: 16px 0; }
  @media print {
    body { padding: 16px; }
    @page { margin: 16mm; }
  }
</style>
</head>
<body>
  <h1>Phiên test: ${sessionNameEsc}</h1>
  <div class="meta-block">
    <p><strong>Khách giả lập:</strong> ${customerNameEsc}</p>
    <p><strong>Kịch bản:</strong> ${scriptLabel}</p>
    <p><strong>Thời gian tạo:</strong> ${createdAtEsc}</p>
  </div>
  ${summaryTableHtml}
  <hr class="divider">
  <div class="chat">${msgHtml}</div>
</body>
</html>`;

    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) { alert("Vui lòng cho phép popup để xuất PDF"); return; }
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 600);
  };

  const handleSend = () => {
    if (!selectedId || !inputText.trim() || isTyping) return;
    const text = inputText.trim();
    setInputText("");
    sendMessage.mutate({ sessionId: selectedId, text });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const scriptName = selectedSession?.scriptId
    ? (scripts?.find((s) => s.id === selectedSession.scriptId)?.name ?? `Script #${selectedSession.scriptId}`)
    : null;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      <div className="flex flex-1 overflow-hidden relative">

        {/* Session list panel */}
        <aside
          className={cn(
            "flex-shrink-0 border-r border-border flex flex-col bg-card",
            "md:w-80 md:flex",
            mobileView === "list" ? "flex w-full" : "hidden",
          )}
        >
          <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border bg-card">
            <div className="h-8 w-8 rounded-xl bg-violet-500/10 flex items-center justify-center flex-shrink-0">
              <FlaskConical className="w-4 h-4 text-violet-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-bold text-foreground leading-tight">Phòng Test AI Sale</h1>
              <p className="text-[10px] text-muted-foreground leading-tight">Giả lập chat — không ảnh hưởng dữ liệu thật</p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <div
                role="button"
                tabIndex={0}
                onClick={handleExportAll}
                onKeyDown={(e) => { if (e.key === "Enter") handleExportAll(); }}
                title="Xuất tất cả phiên test (CSV)"
                className={cn(
                  "h-8 px-2.5 rounded-full flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer",
                  isExportingAll
                    ? "text-muted-foreground bg-muted cursor-wait"
                    : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20",
                )}
              >
                {isExportingAll ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">Xuất tất cả</span>
              </div>
              <Button
                size="sm"
                className="h-8 w-8 p-0 rounded-full bg-violet-600 hover:bg-violet-700 text-white"
                onClick={() => setShowNewDialog(true)}
                title="Chat test mới"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {sessionsLoading ? (
              <div className="flex flex-col gap-3 p-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-3 items-center animate-pulse">
                    <div className="h-11 w-11 rounded-full bg-muted flex-shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 bg-muted rounded w-3/4" />
                      <div className="h-2.5 bg-muted rounded w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : sessionsError ? (
              <div className="flex flex-col items-center justify-center h-full text-center p-8 text-muted-foreground gap-3">
                <p className="text-sm font-medium text-destructive">Không tải được danh sách session</p>
                <button
                  onClick={() => window.location.reload()}
                  className="text-xs text-violet-600 underline hover:no-underline"
                >
                  Tải lại trang
                </button>
              </div>
            ) : (sessions?.length ?? 0) === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center p-8 text-muted-foreground">
                <FlaskConical className="w-10 h-10 mb-3 opacity-20" />
                <p className="text-sm font-medium">Chưa có cuộc test nào</p>
                <p className="text-xs mt-1 opacity-70">Nhấn + để tạo chat test mới</p>
              </div>
            ) : (
              <ul>
                {sessions?.map((s) => (
                  <li key={s.id} className="border-b border-border/50 last:border-b-0">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => handleSelectSession(s.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleSelectSession(s.id); }}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3 hover:bg-accent/60 transition-colors cursor-pointer group relative",
                        selectedId === s.id && "bg-violet-50 dark:bg-violet-900/20 hover:bg-violet-50 dark:hover:bg-violet-900/20",
                      )}
                    >
                      <Avatar name={s.customerName || s.name} size="lg" />
                      <div className="flex-1 min-w-0 pr-7">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={cn("text-sm font-semibold truncate", selectedId === s.id ? "text-violet-700 dark:text-violet-300" : "text-foreground")}>
                            {s.name || s.customerName || "Cuộc test không tên"}
                          </span>
                          <span className="text-[10px] text-muted-foreground flex-shrink-0">
                            {s.lastMessageAt ? timeAgo(s.lastMessageAt) : timeAgo(s.createdAt)}
                          </span>
                        </div>
                        {s.name && s.customerName && (
                          <p className="text-[11px] text-muted-foreground truncate">👤 {s.customerName}</p>
                        )}
                        <p className="text-xs text-muted-foreground truncate italic">
                          {s.lastMessagePreview ?? (s.messageCount > 0 ? `${s.messageCount} tin nhắn` : "Chưa có tin nhắn nào")}
                        </p>
                        {s.scriptId && (
                          <p className="text-[10px] text-violet-500 dark:text-violet-400 truncate mt-0.5">
                            📋 {scripts?.find((sc) => sc.id === s.scriptId)?.name ?? `Script #${s.scriptId}`}
                            {s.scriptUpdatedAt && (
                              <span className="ml-1 opacity-60">
                                v.{new Date(s.scriptUpdatedAt).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })}
                              </span>
                            )}
                            {s.currentSaleStep != null && (
                              <span className="ml-1 opacity-70">· Bước {s.currentSaleStep}</span>
                            )}
                          </p>
                        )}
                      </div>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm("Xoá cuộc test này?")) deleteSession.mutate(s.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            if (confirm("Xoá cuộc test này?")) deleteSession.mutate(s.id);
                          }
                        }}
                        className="md:opacity-0 md:group-hover:opacity-100 absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-full hover:bg-red-100 dark:hover:bg-red-900/30 text-muted-foreground hover:text-red-600 transition-all"
                        title="Xoá"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Chat panel */}
        <div
          className={cn(
            "flex-1 flex flex-col overflow-hidden",
            "md:flex",
            mobileView === "chat" ? "flex" : "hidden",
          )}
        >
          {selectedSession ? (
            <>
              {/* Chat header */}
              <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card/95 backdrop-blur-sm">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setMobileView("list")}
                  onKeyDown={(e) => { if (e.key === "Enter") setMobileView("list"); }}
                  className="md:hidden -ml-1 p-2 rounded-full hover:bg-accent text-muted-foreground cursor-pointer"
                >
                  <ArrowLeft className="w-5 h-5" />
                </div>

                <Avatar name={selectedSession.customerName} size="md" />

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground leading-tight truncate">{selectedSession.customerName}</p>
                  <p className="text-[10px] text-muted-foreground leading-none mt-0.5 truncate">
                    {scriptName ?? "Chưa chọn kịch bản"}
                    {selectedSession.currentSaleStep != null && (
                      <span className="ml-1.5 inline-flex items-center bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 rounded-full px-1.5 py-0 text-[9px] font-medium">
                        Bước {selectedSession.currentSaleStep}
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={handleExportCsv}
                    onKeyDown={(e) => { if (e.key === "Enter") handleExportCsv(); }}
                    title="Xuất CSV"
                    className="p-2 rounded-full transition-colors text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer"
                  >
                    <FileDown className="w-[18px] h-[18px]" />
                  </div>

                  <div
                    role="button"
                    tabIndex={0}
                    onClick={handleExportPdf}
                    onKeyDown={(e) => { if (e.key === "Enter") handleExportPdf(); }}
                    title="Xuất PDF"
                    className="p-2 rounded-full transition-colors text-muted-foreground hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 cursor-pointer"
                  >
                    <FileText className="w-[18px] h-[18px]" />
                  </div>

                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setShowDebugDrawer(true)}
                    onKeyDown={(e) => { if (e.key === "Enter") setShowDebugDrawer(true); }}
                    title="Xem debug"
                    className={cn(
                      "p-2 rounded-full transition-colors text-muted-foreground hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 cursor-pointer",
                      debugInfo && "text-amber-600",
                    )}
                  >
                    <Bug className="w-[18px] h-[18px]" />
                  </div>

                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (messages.length === 0 || confirm("Xoá toàn bộ tin nhắn và bắt đầu lại?")) {
                        resetSession.mutate(selectedId!);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (messages.length === 0 || confirm("Xoá toàn bộ tin nhắn và bắt đầu lại?")) {
                          resetSession.mutate(selectedId!);
                        }
                      }
                    }}
                    title="Đặt lại hội thoại"
                    className="p-2 rounded-full transition-colors text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                  >
                    <RefreshCw className={cn("w-[18px] h-[18px]", resetSession.isPending && "animate-spin")} />
                  </div>
                </div>
              </div>

              {/* Messages area */}
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
                {messages.length === 0 && !isTyping && (
                  <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground pb-12">
                    <div className="h-14 w-14 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center mb-3">
                      <FlaskConical className="w-7 h-7 text-violet-500 opacity-60" />
                    </div>
                    <p className="text-sm font-medium">Bắt đầu chat test</p>
                    <p className="text-xs mt-1 opacity-60 max-w-xs">
                      Nhập tin nhắn giả lập từ phía khách — bot sẽ trả lời đúng như production nhưng không gửi Facebook thật.
                    </p>
                  </div>
                )}

                {messages.map((msg, idx) => {
                  const isUser = msg.role === "user";
                  const isFollowUp = msg.type === "follow_up_auto";
                  const prevMsg = messages[idx - 1];
                  const isSameRole = prevMsg?.role === msg.role && prevMsg?.type !== "follow_up_auto" && !isFollowUp;

                  return (
                    <div
                      key={msg.id}
                      className={cn("flex items-end gap-2", isUser ? "flex-row-reverse" : "flex-row", isSameRole ? "mt-0.5" : "mt-3")}
                    >
                      {!isUser ? (
                        isSameRole ? (
                          <div className="w-7 flex-shrink-0" />
                        ) : isFollowUp ? (
                          <div className="h-7 w-7 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0" title="Follow-up tự động">
                            ⏰
                          </div>
                        ) : (
                          <div className="h-7 w-7 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                            AI
                          </div>
                        )
                      ) : null}

                      <div className={cn("flex flex-col gap-0.5", isUser ? "items-end" : "items-start", "max-w-[75%] md:max-w-[60%]")}>
                        {isFollowUp && (() => {
                          // Parse step/slot from decision string: auto_follow_up_step{N}_slot{M}
                          const m = msg.decision?.match(/step(\d+)_slot(\d+)/);
                          const displayStep = m ? Number(m[1]) : (msg.currentStep ?? null);
                          const displaySlot = m ? Number(m[2]) + 1 : null; // 1-based slot
                          return (
                            <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold px-1 flex items-center gap-1 flex-wrap">
                              {displayStep != null && (
                                <span className="bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 rounded px-1 py-0.5 leading-none text-[10px]">
                                  Bước {displayStep}
                                </span>
                              )}
                              <span className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded px-1 py-0.5 leading-none">
                                Follow-up{displaySlot != null ? ` · Slot ${displaySlot}` : ""}
                              </span>
                            </span>
                          );
                        })()}
                        {msg.type === "image" ? (
                          <div className="rounded-2xl rounded-bl-sm overflow-hidden border border-slate-200/80 dark:border-slate-600 shadow-sm max-w-[240px] bg-white dark:bg-slate-800">
                            <img
                              src={resolveImageUrl(msg.text)}
                              alt="Ảnh bảng giá"
                              className="w-full object-contain"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                                const parent = e.currentTarget.parentElement;
                                if (parent && !parent.querySelector("[data-img-fallback='1']")) {
                                  const fallback = document.createElement("div");
                                  fallback.dataset.imgFallback = "1";
                                  fallback.className = "px-4 py-2.5 text-xs text-muted-foreground";
                                  fallback.textContent = "📷 Không tải được ảnh bảng giá";
                                  parent.appendChild(fallback);
                                }
                              }}
                            />
                          </div>
                        ) : (
                          <div
                            className={cn(
                              "px-4 py-2.5 text-sm leading-relaxed min-w-[60px]",
                              isUser
                                ? "bg-gradient-to-br from-fuchsia-400 via-violet-500 to-indigo-500 text-white rounded-2xl rounded-br-sm shadow-sm"
                                : isFollowUp
                                  ? "bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-100 rounded-2xl rounded-bl-sm border border-amber-200 dark:border-amber-800 shadow-sm"
                                  : "bg-white/95 dark:bg-slate-700 text-slate-900 dark:text-slate-100 rounded-2xl rounded-bl-sm border border-slate-200/80 dark:border-slate-600 shadow-sm",
                            )}
                            style={{ overflowWrap: "break-word", wordBreak: "break-word" }}
                          >
                            {msg.text}
                          </div>
                        )}
                        <div className="flex items-center gap-1 px-1 flex-wrap">
                          <span className="text-[10px] text-muted-foreground">{formatTime(msg.createdAt)}</span>
                          {!isFollowUp && msg.role === "bot" && (
                            <>
                              {msg.currentStep != null && (
                                <span className="text-[10px] bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 rounded px-1 py-0.5 leading-none">
                                  Bước {msg.currentStep}
                                </span>
                              )}
                              {msg.source && (
                                <span className={cn(
                                  "text-[10px] rounded px-1 py-0.5 leading-none font-medium",
                                  msg.source === "qa"
                                    ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
                                    : "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400",
                                )}>
                                  {msg.source === "qa" ? "QA" : "GPT"}
                                  {msg.score != null && <span className="ml-0.5 opacity-80">· {msg.score.toFixed(2)}</span>}
                                </span>
                              )}
                              {!msg.source && msg.decision && (
                                <span className="text-[10px] bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 rounded px-1 py-0.5 leading-none max-w-[160px] truncate" title={msg.decision}>
                                  {msg.decision}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {isTyping && <TypingIndicator />}
                <div ref={messagesEndRef} />
              </div>

              {/* Input bar */}
              <ChatInputBar
                value={inputText}
                onChange={setInputText}
                onSend={handleSend}
                onKeyDown={handleKeyDown}
                disabled={isTyping}
                inputRef={inputRef}
              />
            </>
          ) : (
            <div className="hidden md:flex flex-col items-center justify-center h-full text-center text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center mb-4">
                <FlaskConical className="w-8 h-8 text-violet-500 opacity-60" />
              </div>
              <p className="text-base font-semibold text-foreground">Phòng Test AI Sale</p>
              <p className="text-sm mt-2 text-muted-foreground max-w-xs">
                Chọn một cuộc test bên trái hoặc nhấn <strong>+</strong> để tạo mới.
              </p>
              <Button
                size="sm"
                className="mt-4 gap-2 bg-violet-600 hover:bg-violet-700 text-white"
                onClick={() => setShowNewDialog(true)}
              >
                <Plus className="w-4 h-4" />
                Chat test mới
              </Button>
            </div>
          )}
        </div>

        {/* Debug drawer */}
        {showDebugDrawer && (
          <>
            <div
              className="fixed inset-0 bg-black/30 z-40"
              onClick={() => setShowDebugDrawer(false)}
            />
            <div className="fixed right-0 top-0 bottom-0 w-full max-w-sm bg-card border-l border-border shadow-2xl z-50 flex flex-col">
              <div className="flex items-center justify-between px-4 py-3.5 border-b border-border flex-shrink-0">
                <div className="flex items-center gap-2">
                  <Bug className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-semibold text-foreground">Thông tin debug</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <Switch id="save-unknown-drawer" checked={saveUnknown} onCheckedChange={setSaveUnknown} className="scale-75" />
                    <Label htmlFor="save-unknown-drawer" className="text-xs text-muted-foreground cursor-pointer">Lưu câu hỏi lạ</Label>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setShowDebugDrawer(false)}
                    onKeyDown={(e) => { if (e.key === "Enter") setShowDebugDrawer(false); }}
                    className="p-1.5 rounded-full hover:bg-accent text-muted-foreground cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {!debugInfo ? (
                  <p className="text-sm text-muted-foreground text-center mt-8">
                    Gửi tin nhắn để thấy thông tin debug ở đây.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <span className={cn("px-2.5 py-1 rounded-full text-xs font-medium", decisionBadgeColor(debugInfo.decision))}>
                        {decisionLabel(debugInfo.decision)}
                      </span>
                      {debugInfo.scriptName && (
                        <span className="px-2.5 py-1 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 text-xs">
                          {debugInfo.scriptName}
                        </span>
                      )}
                      {debugInfo.step != null && (
                        <span className="px-2.5 py-1 rounded-full bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300 text-xs font-medium">
                          Bước {debugInfo.step}
                        </span>
                      )}
                      {debugInfo.isOutOfScope && (
                        <span className="px-2.5 py-1 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-xs">Ngoài phạm vi</span>
                      )}
                      {debugInfo.shouldHandoff && (
                        <span className="px-2.5 py-1 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 text-xs">Chuyển nhân viên</span>
                      )}
                      {debugInfo.sendPriceImages && (
                        <span className="px-2.5 py-1 rounded-full bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300 text-xs">
                          📷 Gửi {debugInfo.priceImageCount ?? 0} ảnh giá
                        </span>
                      )}
                    </div>

                    {debugInfo.qaMatch.matched && (
                      <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-3 border border-emerald-200 dark:border-emerald-800">
                        <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 mb-1">Khớp Q&A</p>
                        <p className="text-xs text-emerald-700 dark:text-emerald-400">
                          Row #{debugInfo.qaMatch.rowId} · Điểm: <strong>{debugInfo.qaMatch.score.toFixed(2)}</strong>
                        </p>
                      </div>
                    )}

                    {debugInfo.chunks.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-foreground mb-2">Các đoạn tin ({debugInfo.chunks.length})</p>
                        <div className="space-y-1.5">
                          {debugInfo.chunks.map((c, i) => (
                            <div key={i} className="bg-muted/50 rounded-lg px-3 py-2 text-xs text-foreground/80 break-words">
                              <span className="text-muted-foreground mr-2 font-mono">[{i}]</span>{c}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {debugInfo.rawGptResponse && (
                      <div>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => setShowRawGpt((v) => !v)}
                          onKeyDown={(e) => { if (e.key === "Enter") setShowRawGpt((v) => !v); }}
                          className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-2 hover:text-violet-600 cursor-pointer"
                        >
                          {showRawGpt ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          Phản hồi GPT thô
                        </div>
                        {showRawGpt && (
                          <pre className="bg-muted/50 rounded-lg p-3 text-[10px] font-mono text-foreground/80 whitespace-pre-wrap break-all overflow-auto max-h-52">
                            {(() => {
                              try { return JSON.stringify(JSON.parse(debugInfo.rawGptResponse!), null, 2); }
                              catch { return debugInfo.rawGptResponse; }
                            })()}
                          </pre>
                        )}
                      </div>
                    )}

                    <div className="bg-muted/40 rounded-xl p-3 text-xs font-mono text-muted-foreground space-y-0.5">
                      <p>scriptId: <span className="text-foreground">{debugInfo.scriptId ?? "null"}</span></p>
                      <p>step: <span className="text-foreground">{debugInfo.step ?? "null"}</span></p>
                      <p>decision: <span className="text-foreground">{debugInfo.decision}</span></p>
                      <p>isOutOfScope: <span className="text-foreground">{String(debugInfo.isOutOfScope)}</span></p>
                      <p>shouldHandoff: <span className="text-foreground">{String(debugInfo.shouldHandoff)}</span></p>
                    </div>
                  </>
                )}

                {/* Follow-up debug state */}
                <div className="border-t border-border pt-4">
                  <p className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                    ⏰ Trạng thái Follow-up
                    <span className={cn(
                      "text-[10px] font-normal px-1.5 py-0.5 rounded-full",
                      sseConnected
                        ? "bg-emerald-500/15 text-emerald-600"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {sseConnected ? "● live" : "○ fallback 30s"}
                    </span>
                  </p>
                  {!sessionDebug ? (
                    <p className="text-xs text-muted-foreground">Đang tải...</p>
                  ) : (
                    <div className="bg-muted/40 rounded-xl p-3 text-xs font-mono text-muted-foreground space-y-0.5">
                      <p>currentStep: <span className="text-foreground">{sessionDebug.currentStep ?? "null"}</span></p>
                      <p>scriptId: <span className="text-foreground">{sessionDebug.scriptId ?? "null"}</span>
                        {sessionDebug.scriptUpdatedAt && (
                          <span className="text-[10px] text-muted-foreground ml-1">
                            (v.{new Date(sessionDebug.scriptUpdatedAt).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })})
                          </span>
                        )}
                      </p>
                      <p>followUpCount: <span className="text-foreground">{sessionDebug.followUpCount}</span></p>
                      <p>lastCustomerMsg: <span className="text-foreground">{sessionDebug.lastCustomerMessageAt ? new Date(sessionDebug.lastCustomerMessageAt).toLocaleTimeString("vi-VN") : "null"}</span></p>
                      <p>nextFollowUpAt:{" "}
                        <span className={cn("text-foreground", sessionDebug.slotMatched && "text-amber-500 font-semibold")}>
                          {sessionDebug.nextFollowUpAt ? new Date(sessionDebug.nextFollowUpAt).toLocaleTimeString("vi-VN") : "null"}
                        </span>
                        {followUpCountdown && (
                          <span className={cn(
                            "ml-2 font-semibold tabular-nums",
                            sessionDebug.slotMatched ? "text-amber-500" : "text-sky-500"
                          )}>
                            ({followUpCountdown})
                          </span>
                        )}
                      </p>
                      <p>lastFollowUpAt: <span className="text-foreground">{sessionDebug.lastFollowUpAt ? new Date(sessionDebug.lastFollowUpAt).toLocaleTimeString("vi-VN") : "null"}</span></p>
                      <p>slotMatched: <span className={cn("text-foreground", sessionDebug.slotMatched && "text-amber-500 font-semibold")}>{String(sessionDebug.slotMatched)}</span></p>
                      <p>reason: <span className="text-foreground break-all">{sessionDebug.slotMatchReason}</span></p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* New session dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-violet-500" />
              Chat test mới
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-1">
            <div className="space-y-1.5">
              <Label className="text-sm">Tên cuộc test</Label>
              <Input
                placeholder="VD: Test kịch bản album, Test follow-up bước 2..."
                value={newSessionName}
                onChange={(e) => setNewSessionName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createSession.mutate(); }}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Tên khách giả</Label>
              <Input
                placeholder="VD: Nguyễn Lan, Chị Hoa, ..."
                value={newCustomerName}
                onChange={(e) => setNewCustomerName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createSession.mutate(); }}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Kịch bản sale</Label>
              <Select value={newScriptId} onValueChange={setNewScriptId}>
                <SelectTrigger>
                  <SelectValue placeholder="Không chọn (auto detect)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Không chọn (auto detect)</SelectItem>
                  {scripts?.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Nếu không chọn, bot tự detect kịch bản phù hợp như production.</p>
            </div>

            <div className="flex gap-2 pt-1">
              <Button
                className="flex-1 bg-violet-600 hover:bg-violet-700 text-white gap-2"
                onClick={() => createSession.mutate()}
                disabled={createSession.isPending}
              >
                {createSession.isPending ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                {createSession.isPending ? "Đang tạo..." : "Bắt đầu chat test"}
              </Button>
              <Button variant="outline" onClick={() => setShowNewDialog(false)}>Huỷ</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChatInputBar({
  value,
  onChange,
  onSend,
  onKeyDown,
  disabled,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    function onResize() {
      if (!barRef.current) return;
      const offset = window.innerHeight - (vv!.height + vv!.offsetTop);
      barRef.current.style.paddingBottom = offset > 0
        ? `${offset}px`
        : "max(12px, env(safe-area-inset-bottom))";
    }

    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, []);

  return (
    <div
      ref={barRef}
      className="flex-shrink-0 border-t border-border bg-card/95 backdrop-blur-sm px-3 pt-3"
      style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
    >
      <div className="flex items-end gap-2 max-w-3xl mx-auto">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder="Nhập tin nhắn giả lập từ khách..."
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-2xl border border-border bg-muted/50 px-4 py-2.5 text-sm leading-relaxed",
            "placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400",
            "transition-all overflow-hidden",
            disabled && "opacity-60 cursor-not-allowed",
          )}
          style={{ minHeight: "42px", maxHeight: "120px" }}
        />
        <div
          role="button"
          tabIndex={0}
          onClick={onSend}
          onKeyDown={(e) => { if (e.key === "Enter") onSend(); }}
          aria-disabled={disabled || !value.trim()}
          className={cn(
            "h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 transition-all select-none",
            value.trim() && !disabled
              ? "bg-violet-600 hover:bg-violet-700 text-white shadow-md hover:shadow-lg hover:scale-105 cursor-pointer"
              : "bg-muted text-muted-foreground cursor-not-allowed",
          )}
        >
          <Send className="w-4 h-4" />
        </div>
      </div>
    </div>
  );
}

export default function AiTestRoomPage() {
  return (
    <AiTestErrorBoundary>
      <AiTestRoomInner />
    </AiTestErrorBoundary>
  );
}
