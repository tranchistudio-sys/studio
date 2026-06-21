import { useState, useEffect, useRef, useCallback } from "react";
import { apiUrl } from "@/lib/api-base";
import { getImageSrc } from "@/lib/imageUtils";
import {
  Send, Trash2, Bot, User, Sparkles, Clock, Package, AlertTriangle, Loader2,
  Image as ImageIcon, X, Eye,
} from "lucide-react";

/**
 * Claude Sale Test (Lulu) — sân test nội bộ cho admin.
 * Mô phỏng khách nhắn (text + ẢNH) → xem Lulu (đúng askClaudeForReply + sale-context
 * + AI Vision) trả lời. KHÔNG gửi Messenger, KHÔNG tạo booking, KHÔNG đụng CRM.
 */

type ImageIntent = {
  image_type: string;
  service_intent: string;
  confidence: number;
  visual_description: string;
  outfit: string;
  mood: string;
  location_type: string;
  required_items: string[];
  can_studio_do: boolean;
  should_use_photo_ideas: boolean;
  recommended_data_source: string;
};

type SampleImage = {
  title: string;
  imageUrl: string;
  detailUrl?: string;
  sourceType: "service_package" | "rental_item" | "gallery" | "photo_idea";
  serviceIntent?: string;
};
type SampleLink = { title: string; url: string };

type ChatMsg = {
  id: string;
  from: "customer" | "claude" | "error" | "vision" | "sample" | "sampleDev";
  text: string;
  ts: number;
  image?: string;          // data URL ảnh khách gửi (bubble khách)
  intent?: ImageIntent;    // kết quả classifier (bubble "vision")
  sample?: SampleImage;    // 1 ảnh mẫu Lulu gửi (bubble "sample")
  samples?: SampleImage[]; // nguồn ảnh mẫu (card DEV "sampleDev")
};
type Info = { model: string; hasApiKey: boolean; packageCount: number; totalActive: number; fbBotEnabled: boolean };
type Attached = { dataUrl: string; mediaType: string; name: string };

const STORAGE_KEY = "karuSaleTestHistory_v1";
const ACCEPT = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("read_error"));
    fr.readAsDataURL(file);
  });
}

/** Render nội dung bubble: ảnh [image:url] thành <img>, link http thành <a> bấm được. */
function renderBubbleContent(text: string, isCustomer: boolean, onZoom: (u: string) => void) {
  const img = text.match(/^\s*\[image:(.+?)\]\s*$/);
  if (img) {
    return (
      <img
        src={img[1]} alt="ảnh mẫu" onClick={() => onZoom(img[1])}
        className="rounded-lg max-w-[220px] max-h-60 object-cover cursor-zoom-in"
      />
    );
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

function VisionCard({ intent }: { intent: ImageIntent }) {
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex gap-1.5"><span className="text-gray-500 shrink-0">{k}:</span><span className="font-medium text-gray-800 break-words">{v}</span></div>
  );
  const conf = Math.round((intent.confidence ?? 0) * 100);
  return (
    <div className="max-w-[85%] mx-auto w-full bg-violet-50 border border-violet-200 rounded-xl px-3 py-2 text-[11px] text-gray-700">
      <div className="flex items-center gap-1.5 font-semibold text-violet-700 mb-1">
        <Eye className="w-3.5 h-3.5" /> AI Vision (DEV) — phân loại ảnh khách
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Row k="service_intent" v={<b className="text-violet-700">{intent.service_intent}</b>} />
        <Row k="confidence" v={`${conf}%`} />
        <Row k="image_type" v={intent.image_type || "—"} />
        <Row k="mood" v={intent.mood || "—"} />
        <Row k="outfit" v={intent.outfit || "—"} />
        <Row k="recommended" v={intent.recommended_data_source || "—"} />
        <Row k="dùng_ý_tưởng" v={intent.should_use_photo_ideas ? "có" : "không"} />
        <Row k="studio_làm_được" v={intent.can_studio_do ? "có" : "không"} />
      </div>
      {intent.visual_description && <div className="mt-1 text-gray-600 italic">“{intent.visual_description}”</div>}
    </div>
  );
}

const SOURCE_LABEL: Record<SampleImage["sourceType"], string> = {
  service_package: "Gói dịch vụ",
  rental_item: "Cho thuê đồ",
  gallery: "Bộ ảnh / Album",
  photo_idea: "Ý tưởng chụp",
};

/** Một ảnh mẫu Lulu gửi (giống ảnh gửi thật trong Messenger): ảnh + caption + Xem thêm. */
function SampleBubble({ sample, onZoom }: { sample: SampleImage; onZoom: (u: string) => void }) {
  const src = getImageSrc(sample.imageUrl);
  return (
    <div className="flex items-end gap-2 justify-start">
      <div className="w-7 h-7 rounded-full bg-rose-500 flex items-center justify-center text-white shrink-0">
        <Bot className="w-4 h-4" />
      </div>
      <div className="max-w-[75%] bg-white border border-gray-200 rounded-2xl rounded-bl-sm p-1.5">
        {src ? (
          <img
            src={src} alt={sample.title} onClick={() => onZoom(src)}
            className="rounded-xl max-w-[230px] max-h-72 object-cover cursor-zoom-in"
          />
        ) : (
          <div className="w-[230px] h-40 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 text-xs">
            (ảnh lỗi)
          </div>
        )}
        <div className="px-1.5 pt-1 pb-0.5">
          <div className="text-[13px] font-medium text-gray-800 break-words">{sample.title}</div>
          {sample.detailUrl && (
            <a
              href={sample.detailUrl} target="_blank" rel="noreferrer"
              className="text-[12px] text-sky-600 hover:underline inline-flex items-center gap-0.5"
            >
              Xem thêm <Eye className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Card DEV: nguồn ảnh mẫu Lulu chọn — để kiểm tra AI bốc đúng nhóm. */
function SampleSourceCard({ samples }: { samples: SampleImage[] }) {
  return (
    <div className="max-w-[88%] mx-auto w-full bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-[11px] text-gray-700">
      <div className="flex items-center gap-1.5 font-semibold text-amber-700 mb-1">
        <ImageIcon className="w-3.5 h-3.5" /> Nguồn ảnh mẫu Lulu chọn (DEV) — {samples.length} ảnh
      </div>
      <div className="space-y-1.5">
        {samples.map((s, i) => (
          <div key={i} className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t border-amber-100 pt-1 first:border-t-0 first:pt-0">
            <span className="text-gray-500">title</span><span className="font-medium text-gray-800 break-words">{s.title}</span>
            <span className="text-gray-500">sourceType</span><span><b className="text-amber-700">{s.sourceType}</b> ({SOURCE_LABEL[s.sourceType]})</span>
            <span className="text-gray-500">serviceIntent</span><span className="text-amber-700">{s.serviceIntent || "—"}</span>
            <span className="text-gray-500">imageUrl</span><span className="text-gray-600 break-all">{s.imageUrl}</span>
            <span className="text-gray-500">detailUrl</span><span className="text-gray-600 break-all">{s.detailUrl || "—"}</span>
          </div>
        ))}
      </div>
    </div>
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
  const [attached, setAttached] = useState<Attached | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-200))); } catch { /* quota */ }
  }, [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    fetch(apiUrl("/api/claude-sale-test/info"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setInfo(d as Info))
      .catch(() => {});
  }, []);

  const acceptFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    if (!ACCEPT.includes(file.type)) { alert("Chỉ nhận ảnh jpg, jpeg, png, webp"); return; }
    if (file.size > MAX_BYTES) { alert("Ảnh quá lớn (tối đa 5MB)"); return; }
    try {
      const dataUrl = await fileToDataUrl(file);
      setAttached({ dataUrl, mediaType: file.type, name: file.name || "image" });
    } catch { alert("Không đọc được ảnh"); }
  }, []);

  // Ctrl+V dán ảnh — CHỈ trên màn này (listener gỡ khi rời trang).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); acceptFile(f); break; }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFile]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !attached) || loading) return;
    const img = attached;
    const userMsg: ChatMsg = { id: newId(), from: "customer", text, ts: Date.now(), image: img?.dataUrl };
    // Gồm cả ảnh mẫu ĐÃ GỬI (dạng [image:url]) để backend loại trùng — KHÔNG gửi lại ảnh cũ.
    const prior = messages
      .filter((m) => m.from === "customer" || m.from === "claude" || m.from === "sample")
      .map((m) => {
        if (m.from === "sample") {
          return { direction: "outgoing", text: m.sample?.imageUrl ? `[image:${m.sample.imageUrl}]` : "" };
        }
        return {
          direction: m.from === "customer" ? "incoming" : "outgoing",
          text: m.text || (m.image ? "[Khách gửi một hình ảnh]" : ""),
        };
      })
      .filter((m) => m.text);
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setAttached(null);
    setLoading(true);
    try {
      const r = await fetch(apiUrl("/api/claude-sale-test/chat"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          message: text,
          messages: prior,
          ...(img ? { imageBase64: img.dataUrl, imageMediaType: img.mediaType } : {}),
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setMessages((prev) => [...prev, { id: newId(), from: "error", text: data?.error || "Lỗi không xác định", ts: Date.now() }]);
      } else {
        setLastMs(typeof data.responseTimeMs === "number" ? data.responseTimeMs : null);
        if (data.model && info) setInfo({ ...info, model: data.model });
        // Kết quả AI Vision (DEV) hiện ngay trước câu trả lời.
        if (data.imageIntent) {
          setMessages((prev) => [...prev, { id: newId(), from: "vision", text: "", ts: Date.now(), intent: data.imageIntent as ImageIntent }]);
        }
        // ẢNH MẪU THẬT: gửi HÌNH trực tiếp TRƯỚC text (giống Messenger). DEV card hiện nguồn ảnh.
        const sampleImages: SampleImage[] = Array.isArray(data.sampleImages) ? data.sampleImages : [];
        if (sampleImages.length > 0) {
          setMessages((prev) => [...prev, { id: newId(), from: "sampleDev", text: "", ts: Date.now(), samples: sampleImages }]);
          for (const s of sampleImages) {
            await sleep(500);
            setMessages((prev) => [...prev, { id: newId(), from: "sample", text: "", ts: Date.now(), sample: s }]);
          }
        }
        // BẢNG GIÁ: gửi HÌNH bảng giá TRƯỚC text (yêu cầu: hình giá trước, lời giải thích bên dưới).
        const priceImages: string[] = Array.isArray(data.priceImages) ? data.priceImages : [];
        for (const objectPath of priceImages) {
          const url = getImageSrc(objectPath);
          if (!url) continue;
          await sleep(500);
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: `[image:${url}]`, ts: Date.now() }]);
        }
        const chunks: string[] = (Array.isArray(data.reply) ? data.reply : [String(data.reply ?? "")]).filter((c: string) => c && c.trim());
        for (let i = 0; i < chunks.length; i++) {
          const delay = i === 0
            ? (typeof data.replyDelayMs === "number" ? data.replyDelayMs : 400)
            : Math.min(1800, 500 + chunks[i].length * 16);
          await sleep(delay);
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: chunks[i], ts: Date.now() }]);
        }
        // Link "xem thêm" (nếu Lulu có ảnh mẫu kèm link chi tiết) — 1 bubble gọn sau text.
        const sampleLinks: SampleLink[] = Array.isArray(data.sampleLinks) ? data.sampleLinks : [];
        for (const lk of sampleLinks) {
          if (!lk?.url) continue;
          await sleep(400);
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: `${lk.title}: ${lk.url}`, ts: Date.now() }]);
        }
        // Khách đòi xem thêm nhưng đã hết mẫu mới → câu nhắn khéo (không lặp ảnh cũ).
        if (typeof data.sampleNote === "string" && data.sampleNote.trim()) {
          await sleep(400);
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: data.sampleNote, ts: Date.now() }]);
        }
      }
    } catch (e) {
      setMessages((prev) => [...prev, { id: newId(), from: "error", text: `Lỗi kết nối: ${String(e).slice(0, 200)}`, ts: Date.now() }]);
    } finally {
      setLoading(false);
    }
  }, [input, attached, loading, messages, info]);

  const clearChat = () => {
    if (messages.length === 0 || confirm("Xóa toàn bộ hội thoại test?")) {
      setMessages([]);
      setLastMs(null);
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) acceptFile(f);
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
            <div className="font-semibold text-gray-800 truncate">Lulu Sale Test</div>
            <div className="text-xs text-gray-500 truncate">Mô phỏng khách (text + ảnh) — không gửi ra Messenger, không tạo booking</div>
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

      {/* Messages (drop zone) */}
      <div
        ref={scrollRef}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
        onDrop={onDrop}
        className="relative flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-[#f5f3ef]"
      >
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-rose-500/10 border-2 border-dashed border-rose-400 rounded-lg pointer-events-none">
            <div className="bg-white/90 px-4 py-2 rounded-lg text-rose-600 font-medium flex items-center gap-2">
              <ImageIcon className="w-5 h-5" /> Thả ảnh để gửi thử
            </div>
          </div>
        )}
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm mt-10">
            Nhập tin nhắn như một khách hàng để xem Lulu tư vấn.<br />
            Gửi kèm ảnh (nút 🖼️, kéo-thả, hoặc Ctrl+V) để test AI Vision.<br />
            Ví dụ: <i>"Bộ này bên mình chụp được không?"</i> + đính kèm ảnh.
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
          if (m.from === "vision" && m.intent) {
            return <div key={m.id} className="flex justify-center"><VisionCard intent={m.intent} /></div>;
          }
          if (m.from === "sampleDev" && m.samples) {
            return <div key={m.id} className="flex justify-center"><SampleSourceCard samples={m.samples} /></div>;
          }
          if (m.from === "sample" && m.sample) {
            return <SampleBubble key={m.id} sample={m.sample} onZoom={setZoom} />;
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
                {m.image && (
                  <img
                    src={m.image} alt="ảnh khách" onClick={() => setZoom(m.image!)}
                    className={`rounded-lg max-w-[220px] max-h-60 object-cover cursor-zoom-in ${m.text ? "mb-1.5" : ""}`}
                  />
                )}
                {m.text && (m.image ? <div>{m.text}</div> : renderBubbleContent(m.text, isCustomer, setZoom))}
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

      {/* Preview ảnh đính kèm */}
      {attached && (
        <div className="flex items-center gap-2 px-3 py-2 border-t bg-gray-50">
          <div className="relative">
            <img src={attached.dataUrl} alt="đính kèm" className="w-14 h-14 rounded-lg object-cover border" />
            <button
              onClick={() => setAttached(null)}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-700 text-white flex items-center justify-center hover:bg-rose-600"
              title="Bỏ ảnh"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <span className="text-xs text-gray-500 truncate">{attached.name} — sẽ gửi kèm tin nhắn</span>
        </div>
      )}

      {/* Input */}
      <div className="flex items-end gap-2 p-3 border-t bg-white rounded-b-xl">
        <input
          ref={fileRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" className="hidden"
          onChange={(e) => { acceptFile(e.target.files?.[0]); if (fileRef.current) fileRef.current.value = ""; }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={loading}
          className="w-10 h-10 rounded-full border border-gray-300 text-gray-500 flex items-center justify-center hover:bg-gray-100 disabled:opacity-40 shrink-0"
          title="Gửi ảnh (jpg, png, webp) — hoặc kéo-thả / Ctrl+V"
        >
          <ImageIcon className="w-5 h-5" />
        </button>
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
          disabled={loading || (!input.trim() && !attached)}
          className="w-10 h-10 rounded-full bg-rose-500 text-white flex items-center justify-center hover:bg-rose-600 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          title="Gửi"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
        </button>
      </div>

      {/* Lightbox phóng to ảnh */}
      {zoom && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6" onClick={() => setZoom(null)}>
          <img src={zoom} alt="phóng to" className="max-w-full max-h-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}
