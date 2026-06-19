import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { apiUrl } from "@/lib/api-base";
import {
  Loader2, RefreshCw, Send, AlertTriangle, CheckCircle2, BookmarkPlus, Ban,
  MessageSquare, Bot, Clipboard, ShieldAlert,
} from "lucide-react";

/**
 * "Câu hỏi lạ cần xử lý" (Lulu Human Review).
 * Lulu dừng bot khi không chắc → nhân viên thật trả lời NGUYÊN VĂN, lưu kịch bản, bỏ qua, mở lại bot.
 * Không tự gửi, không cho AI viết lại câu trả lời của nhân viên.
 */

type Status = "open" | "sent" | "ignored";
type Priority = "normal" | "high" | "urgent";
type Review = {
  id: number; facebookUserId: string; channel: string; customerName: string | null;
  customerQuestion: string; customerImages: string[]; detectedIntent: string | null;
  confidence: number | null; reasonForEscalation: string; aiSuggestedReply: string | null;
  staffReply: string | null; staffId: number | null; status: Status; priority: Priority;
  savedToPlaybook: boolean; holdMessageSentAt: string | null; createdAt: string;
  updatedAt: string; sentAt: string | null;
};

function token() { return localStorage.getItem("amazingStudioToken_v2"); }
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

const STATUS_TABS: { key: Status | "all"; label: string }[] = [
  { key: "open", label: "Chờ xử lý" },
  { key: "sent", label: "Đã gửi" },
  { key: "ignored", label: "Bỏ qua" },
  { key: "all", label: "Tất cả" },
];

const PRIORITY_META: Record<Priority, { label: string; cls: string }> = {
  urgent: { label: "Khẩn", cls: "bg-red-600 text-white" },
  high: { label: "Cao", cls: "bg-orange-100 text-orange-700" },
  normal: { label: "Thường", cls: "bg-gray-100 text-gray-600" },
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }); }
  catch { return "—"; }
}

export default function LuluHumanReviewPage() {
  const [, setLocation] = useLocation();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Status | "all">("open");
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<Record<number, { kind: "ok" | "err"; text: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(apiUrl(`/api/lulu-human-reviews?status=${tab}`), { headers: authHeaders() });
      const d = await r.json();
      if (r.ok) { setReviews(d.reviews ?? []); setOpenCount(d.openCount ?? 0); }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [tab]);
  useEffect(() => { load(); }, [load]);

  const setNoteFor = (id: number, kind: "ok" | "err", text: string) =>
    setNote((n) => ({ ...n, [id]: { kind, text } }));

  const act = async (id: number, path: string, body?: unknown): Promise<boolean> => {
    setBusy(id);
    try {
      const r = await fetch(apiUrl(`/api/lulu-human-reviews/${id}/${path}`), {
        method: "POST", headers: authHeaders(), body: body ? JSON.stringify(body) : undefined,
      });
      const d = await r.json();
      if (r.ok && d.success) { setNoteFor(id, "ok", d.message ?? "Xong"); return true; }
      setNoteFor(id, "err", d.fbError || d.error || "Thất bại");
      return false;
    } catch (e) { setNoteFor(id, "err", String(e).slice(0, 120)); return false; }
    finally { setBusy(null); }
  };

  const sendReply = async (rv: Review) => {
    const text = (drafts[rv.id] ?? "").trim();
    if (!text) { setNoteFor(rv.id, "err", "Hãy nhập câu trả lời trước khi gửi"); return; }
    if (await act(rv.id, "reply", { text })) await load();
  };
  const savePlaybook = async (rv: Review) => { if (await act(rv.id, "save-playbook")) await load(); };
  const ignore = async (rv: Review) => { if (await act(rv.id, "ignore")) await load(); };
  const reopenBot = async (rv: Review) => { if (await act(rv.id, "reopen-bot")) await load(); };

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-0 pb-10">
      <div className="py-4">
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-red-500" /> Câu hỏi lạ cần xử lý
          {openCount > 0 && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-600 text-white">{openCount} chờ</span>
          )}
        </h1>
        <p className="text-sm text-gray-500">
          Lulu dừng bot khi không chắc (câu lạ, deal giá, ảnh không rõ, khiếu nại…). Nhân viên trả lời nguyên văn,
          không cho AI viết lại. Gửi xong vẫn giữ takeover để chăm tiếp.
        </p>
      </div>

      <div className="flex items-center gap-1.5 mb-3 overflow-x-auto">
        {STATUS_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs ${tab === t.key ? "bg-red-500 text-white" : "bg-gray-100 text-gray-600"}`}>
            {t.label}{t.key === "open" && openCount > 0 ? ` (${openCount})` : ""}
          </button>
        ))}
        <button onClick={load} disabled={loading} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-gray-600 text-sm disabled:opacity-50">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Tải lại
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
      ) : (
        <div className="space-y-3">
          {reviews.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-10">Không có mục nào trong bộ lọc này 🎉</div>
          )}
          {reviews.map((rv) => {
            const pmeta = PRIORITY_META[rv.priority];
            const st = note[rv.id];
            const isOpen = rv.status === "open";
            return (
              <div key={rv.id} className={`bg-white rounded-xl border p-3 ${isOpen ? "border-red-300" : "border-gray-200"}`}>
                <div className="flex items-start gap-2 flex-wrap">
                  {isOpen && <span className="mt-1 w-2 h-2 rounded-full bg-red-500 shrink-0" title="Chưa xử lý" />}
                  <span className="font-semibold text-gray-800 text-sm">{rv.customerName || `Khách …${rv.facebookUserId.slice(-4)}`}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${pmeta.cls}`}>{pmeta.label}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-600">{rv.channel}</span>
                  {rv.detectedIntent && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600">{rv.detectedIntent}</span>}
                  {rv.confidence != null && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">conf {Math.round(rv.confidence * 100)}%</span>
                  )}
                  {rv.status === "sent" && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">đã gửi</span>}
                  {rv.status === "ignored" && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500">bỏ qua</span>}
                  {rv.savedToPlaybook && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-700">đã lưu kịch bản</span>}
                  <span className="ml-auto text-[11px] text-gray-400">{fmtTime(rv.createdAt)}</span>
                </div>

                <div className="mt-2 text-xs text-red-600 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" /> {rv.reasonForEscalation}
                </div>

                <div className="mt-1.5 bg-gray-50 rounded-lg p-2 text-sm text-gray-700">
                  <span className="text-[11px] text-gray-400 block mb-0.5">Khách hỏi:</span>
                  {rv.customerQuestion || "—"}
                </div>

                {rv.customerImages.length > 0 && (
                  <div className="mt-2 flex gap-2 flex-wrap">
                    {rv.customerImages.map((u, i) => (
                      <img key={i} src={u} alt="" className="w-16 h-16 rounded-lg object-cover border" />
                    ))}
                  </div>
                )}

                {rv.aiSuggestedReply && isOpen && (
                  <div className="mt-2 bg-blue-50/60 rounded-lg p-2 text-xs text-gray-600">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className="text-[11px] text-blue-500 flex items-center gap-1"><Bot className="w-3 h-3" /> Lulu định trả lời (tham khảo):</span>
                      <button onClick={() => setDrafts((d) => ({ ...d, [rv.id]: rv.aiSuggestedReply ?? "" }))}
                        className="text-[11px] text-blue-600 flex items-center gap-1 hover:underline">
                        <Clipboard className="w-3 h-3" /> Dùng làm nháp
                      </button>
                    </div>
                    <div className="whitespace-pre-wrap">{rv.aiSuggestedReply}</div>
                  </div>
                )}

                {isOpen ? (
                  <>
                    <textarea
                      value={drafts[rv.id] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [rv.id]: e.target.value }))}
                      rows={3} placeholder="Nhập câu trả lời gửi cho khách (gửi nguyên văn)…"
                      className="mt-2 w-full px-3 py-2 border rounded-lg text-sm"
                    />
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <button onClick={() => sendReply(rv)} disabled={busy === rv.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 text-white text-sm disabled:opacity-50">
                        {busy === rv.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Gửi cho khách
                      </button>
                      <button onClick={() => savePlaybook(rv)} disabled={busy === rv.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-gray-600 text-sm disabled:opacity-50">
                        <BookmarkPlus className="w-4 h-4" /> Lưu kịch bản
                      </button>
                      <button onClick={() => ignore(rv)} disabled={busy === rv.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-gray-500 text-sm disabled:opacity-50">
                        <Ban className="w-4 h-4" /> Bỏ qua
                      </button>
                      <button onClick={() => setLocation("/facebook-inbox-ai")}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sky-600 text-sm">
                        <MessageSquare className="w-4 h-4" /> Mở hội thoại
                      </button>
                      <button onClick={() => reopenBot(rv)} disabled={busy === rv.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-emerald-600 text-sm disabled:opacity-50">
                        <Bot className="w-4 h-4" /> Mở lại bot
                      </button>
                    </div>
                  </>
                ) : (
                  rv.staffReply && (
                    <div className="mt-2 bg-green-50/60 rounded-lg p-2 text-sm text-gray-700">
                      <span className="text-[11px] text-green-600 block mb-0.5">Nhân viên đã trả lời:</span>
                      <div className="whitespace-pre-wrap">{rv.staffReply}</div>
                      <div className="mt-1.5 flex items-center gap-2">
                        {!rv.savedToPlaybook && (
                          <button onClick={() => savePlaybook(rv)} disabled={busy === rv.id}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-gray-600 text-xs disabled:opacity-50">
                            <BookmarkPlus className="w-3.5 h-3.5" /> Lưu kịch bản
                          </button>
                        )}
                        <button onClick={() => reopenBot(rv)} disabled={busy === rv.id}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-emerald-600 text-xs disabled:opacity-50">
                          <Bot className="w-3.5 h-3.5" /> Mở lại bot
                        </button>
                      </div>
                    </div>
                  )
                )}

                {st && (
                  <div className={`mt-2 text-xs flex items-center gap-1 ${st.kind === "ok" ? "text-green-600" : "text-red-600"}`}>
                    {st.kind === "ok" ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />} {st.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
