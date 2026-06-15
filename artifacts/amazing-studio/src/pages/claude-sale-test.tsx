import { useState, useEffect, useRef, useCallback } from "react";
import { apiUrl } from "@/lib/api-base";
import { getImageSrc } from "@/lib/imageUtils";
import {
  Send, Trash2, Bot, User, Sparkles, Clock, Package, AlertTriangle, Loader2,
} from "lucide-react";

/**
 * Claude Sale Test (KARU) — sân test nội bộ cho admin.
 * Mô phỏng khách nhắn → xem Claude (đúng askClaudeForReply + sale-context) trả lời.
 * KHÔNG gửi Messenger, KHÔNG tạo booking, KHÔNG đụng CRM.
 */

type ChatMsg = { id: string; from: "customer" | "claude" | "error"; text: string; ts: number };
type Info = { model: string; hasApiKey: boolean; packageCount: number; totalActive: number; fbBotEnabled: boolean };

const STORAGE_KEY = "karuSaleTestHistory_v1";

function token(): string | null {
  return localStorage.getItem("amazingStudioToken_v2");
}
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** Render nội dung bubble: ảnh [image:url] thành <img>, link http thành <a> bấm được. */
function renderBubbleContent(text: string, isCustomer: boolean) {
  const img = text.match(/^\s*\[image:(.+?)\]\s*$/);
  if (img) {
    return <img src={img[1]} alt="ảnh mẫu" className="rounded-lg max-w-[220px] max-h-60 object-cover" />;
  }
  const linkCls = isCustomer ? "underline break-all" : "underline text-sky-600 break-all";
  return text.split(/(https?:\/\/[^\s]+)/g).map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noreferrer" className={linkCls}>{p}</a>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

export default function ClaudeSaleTestPage() {
  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as ChatMsg[]) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Lưu lịch sử test vào localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-200)));
    } catch { /* bỏ qua quota */ }
  }, [messages]);

  // Tự cuộn xuống cuối
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Lấy thông tin model + số gói context
  useEffect(() => {
    fetch(apiUrl("/api/claude-sale-test/info"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setInfo(d as Info))
      .catch(() => {});
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    const userMsg: ChatMsg = { id: newId(), from: "customer", text, ts: Date.now() };
    const prior = messages
      .filter((m) => m.from !== "error")
      .map((m) => ({ direction: m.from === "customer" ? "incoming" : "outgoing", text: m.text }));
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    try {
      const r = await fetch(apiUrl("/api/claude-sale-test/chat"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message: text, messages: prior }),
      });
      const data = await r.json();
      if (!r.ok) {
        setMessages((prev) => [...prev, { id: newId(), from: "error", text: data?.error || "Lỗi không xác định", ts: Date.now() }]);
      } else {
        const chunks: string[] = (Array.isArray(data.reply) ? data.reply : [String(data.reply ?? "")]).filter(
          (c: string) => c && c.trim(),
        );
        setLastMs(typeof data.responseTimeMs === "number" ? data.responseTimeMs : null);
        if (data.model && info) setInfo({ ...info, model: data.model });
        // Hiệu ứng chat: bubble đầu chờ đúng delay cấu hình (theo độ dài tin khách + random),
        // giống chatbot Fanpage; các bubble sau gõ nhanh tự nhiên.
        for (let i = 0; i < chunks.length; i++) {
          const delay = i === 0
            ? (typeof data.replyDelayMs === "number" ? data.replyDelayMs : 400)
            : Math.min(1800, 500 + chunks[i].length * 16);
          await sleep(delay);
          const c = chunks[i];
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: c, ts: Date.now() }]);
        }
        // Ảnh bảng giá nhóm (theo marker <<PRICE_IMAGE: MÃ>>): render INLINE như bubble ảnh.
        const priceImages: string[] = Array.isArray(data.priceImages) ? data.priceImages : [];
        for (const objectPath of priceImages) {
          const url = getImageSrc(objectPath);
          if (!url) continue;
          await sleep(500);
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: `[image:${url}]`, ts: Date.now() }]);
        }
      }
    } catch (e) {
      setMessages((prev) => [...prev, { id: newId(), from: "error", text: `Lỗi kết nối: ${String(e).slice(0, 200)}`, ts: Date.now() }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, info]);

  const clearChat = () => {
    if (messages.length === 0 || confirm("Xóa toàn bộ hội thoại test?")) {
      setMessages([]);
      setLastMs(null);
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-white rounded-t-xl">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-full bg-rose-500 flex items-center justify-center text-white shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-gray-800 truncate">Claude Sale Test</div>
            <div className="text-xs text-gray-500 truncate">Mô phỏng khách — không gửi ra Messenger, không tạo booking</div>
          </div>
        </div>
        <button
          onClick={clearChat}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-rose-600 px-2 py-1 rounded-md hover:bg-rose-50 shrink-0"
          title="Xóa hội thoại"
        >
          <Trash2 className="w-4 h-4" /> Xóa
        </button>
      </div>

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 bg-gray-50 border-b text-xs text-gray-600">
        <span className="flex items-center gap-1"><Bot className="w-3.5 h-3.5 text-rose-500" /> Model: <b className="text-gray-800">{info?.model ?? "…"}</b></span>
        <span className="flex items-center gap-1"><Package className="w-3.5 h-3.5 text-amber-500" /> Gói bán lẻ: <b className="text-gray-800">{info ? `${info.packageCount}/${info.totalActive}` : "…"}</b></span>
        <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-sky-500" /> Phản hồi: <b className="text-gray-800">{lastMs != null ? `${(lastMs / 1000).toFixed(1)}s` : "—"}</b></span>
        {info && !info.hasApiKey && (
          <span className="flex items-center gap-1 text-rose-600"><AlertTriangle className="w-3.5 h-3.5" /> Chưa có ANTHROPIC_API_KEY</span>
        )}
        {info && (
          <span className={`ml-auto px-2 py-0.5 rounded-full ${info.fbBotEnabled ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600"}`}>
            Fanpage: {info.fbBotEnabled ? "ĐANG BẬT" : "đang tắt"}
          </span>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-[#f5f3ef]">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm mt-10">
            Nhập tin nhắn như một khách hàng để xem Claude tư vấn.<br />
            Ví dụ: <i>"Chị muốn chụp album cưới thì giá sao em?"</i>
          </div>
        )}
        {messages.map((m) => {
          if (m.from === "error") {
            return (
              <div key={m.id} className="flex justify-center">
                <div className="max-w-[85%] bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg px-3 py-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {m.text}
                </div>
              </div>
            );
          }
          const isCustomer = m.from === "customer";
          return (
            <div key={m.id} className={`flex items-end gap-2 ${isCustomer ? "justify-end" : "justify-start"}`}>
              {!isCustomer && (
                <div className="w-7 h-7 rounded-full bg-rose-500 flex items-center justify-center text-white shrink-0">
                  <Bot className="w-4 h-4" />
                </div>
              )}
              <div
                className={`max-w-[75%] px-3.5 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                  isCustomer
                    ? "bg-sky-500 text-white rounded-br-sm"
                    : "bg-white text-gray-800 border border-gray-200 rounded-bl-sm"
                }`}
              >
                {renderBubbleContent(m.text, isCustomer)}
              </div>
              {isCustomer && (
                <div className="w-7 h-7 rounded-full bg-sky-600 flex items-center justify-center text-white shrink-0">
                  <User className="w-4 h-4" />
                </div>
              )}
            </div>
          );
        })}
        {loading && (
          <div className="flex items-end gap-2 justify-start">
            <div className="w-7 h-7 rounded-full bg-rose-500 flex items-center justify-center text-white shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-sm px-4 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex items-end gap-2 p-3 border-t bg-white rounded-b-xl">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Nhập tin nhắn của khách… (Enter để gửi, Shift+Enter xuống dòng)"
          rows={1}
          className="flex-1 resize-none max-h-32 px-3 py-2 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-rose-300"
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="w-10 h-10 rounded-full bg-rose-500 text-white flex items-center justify-center hover:bg-rose-600 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          title="Gửi"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
        </button>
      </div>
    </div>
  );
}
