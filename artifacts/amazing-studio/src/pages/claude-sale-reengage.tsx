import { useState, useEffect, useCallback } from "react";
import { apiUrl } from "@/lib/api-base";
import {
  Loader2, RefreshCw, Send, Copy, Clock, Phone, AlertTriangle, CheckCircle2, Flame, Sun, Snowflake, Ban,
} from "lucide-react";

/**
 * Follow-up khách cũ Facebook — "Khách cần chăm lại".
 * Tìm hội thoại Fanpage bị bỏ quên, phân loại, gợi ý tin nhắn. KHÔNG tự gửi:
 * admin/Hoa duyệt từng tin rồi bấm gửi. KHÔNG đụng booking/tài chính/khách hàng.
 */

type Priority = "hot" | "warm" | "cold" | "skip";
type Candidate = {
  facebookUserId: string; name: string | null; displayName: string; avatarUrl: string | null; phone: string | null;
  lastMessage: string | null; lastDirection: "incoming" | "outgoing" | null; lastInteractionAt: string | null;
  silenceDays: number; predictedNeed: string; priority: Priority; reason: string; suggestedMessage: string;
  within24h: boolean; windowNote: string; optedOut: boolean;
};

function token() { return localStorage.getItem("amazingStudioToken_v2"); }
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

const PRIORITY_META: Record<Priority, { label: string; cls: string; icon: React.ElementType }> = {
  hot: { label: "Nóng", cls: "bg-red-100 text-red-700", icon: Flame },
  warm: { label: "Ấm", cls: "bg-amber-100 text-amber-700", icon: Sun },
  cold: { label: "Lạnh", cls: "bg-sky-100 text-sky-700", icon: Snowflake },
  skip: { label: "Không nên nhắn", cls: "bg-gray-200 text-gray-500", icon: Ban },
};

export default function ClaudeSaleReengagePage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [minDays, setMinDays] = useState(2);
  const [includeSkip, setIncludeSkip] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, "ok" | string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Priority | "all">("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(apiUrl(`/api/claude-sale/reengage?minSilenceDays=${minDays}&includeSkip=${includeSkip ? 1 : 0}`), { headers: authHeaders() });
      const d = await r.json();
      if (r.ok) {
        setCandidates(d.candidates ?? []);
        const dr: Record<string, string> = {};
        for (const c of d.candidates ?? []) dr[c.facebookUserId] = c.suggestedMessage;
        setDrafts(dr);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [minDays, includeSkip]);
  useEffect(() => { load(); }, [load]);

  const send = async (psid: string) => {
    const text = (drafts[psid] ?? "").trim();
    if (!text) return;
    setBusy(psid);
    try {
      const r = await fetch(apiUrl(`/api/fb-inbox/threads/${psid}/send`), { method: "POST", headers: authHeaders(), body: JSON.stringify({ text }) });
      const d = await r.json();
      if (r.ok && d.success) setSent((s) => ({ ...s, [psid]: "ok" }));
      else setSent((s) => ({ ...s, [psid]: d.fbError || d.error || "Gửi thất bại (có thể ngoài cửa sổ 24h của Meta)" }));
    } catch (e) { setSent((s) => ({ ...s, [psid]: String(e).slice(0, 120) })); }
    finally { setBusy(null); }
  };

  const copy = (psid: string) => { navigator.clipboard?.writeText(drafts[psid] ?? "").catch(() => {}); };

  const shown = candidates.filter((c) => filter === "all" ? true : c.priority === filter);
  const counts = candidates.reduce((acc, c) => { acc[c.priority] = (acc[c.priority] ?? 0) + 1; return acc; }, {} as Record<string, number>);

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-0 pb-10">
      <div className="py-4">
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><RefreshCw className="w-5 h-5 text-rose-500" /> Khách cần chăm lại</h1>
        <p className="text-sm text-gray-500">Hội thoại Fanpage bị bỏ quên — duyệt & gửi từng tin. Không tự động gửi, không spam.</p>
      </div>

      <div className="bg-white rounded-xl border p-3 mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm flex items-center gap-2">Khách im từ
          <input type="number" min={1} value={minDays} onChange={(e) => setMinDays(Math.max(1, Number(e.target.value)))} className="w-16 px-2 py-1 border rounded-lg" /> ngày
        </label>
        <label className="text-sm flex items-center gap-1.5">
          <input type="checkbox" checked={includeSkip} onChange={(e) => setIncludeSkip(e.target.checked)} /> Hiện cả "không nên nhắn"
        </label>
        <button onClick={load} disabled={loading} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500 text-white text-sm disabled:opacity-50">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Quét lại
        </button>
      </div>

      <div className="flex gap-1.5 mb-3 overflow-x-auto">
        {(["all", "hot", "warm", "cold", ...(includeSkip ? ["skip" as Priority] : [])] as (Priority | "all")[]).map((k) => (
          <button key={k} onClick={() => setFilter(k)} className={`shrink-0 px-3 py-1.5 rounded-full text-xs ${filter === k ? "bg-rose-500 text-white" : "bg-gray-100 text-gray-600"}`}>
            {k === "all" ? `Tất cả (${candidates.length})` : `${PRIORITY_META[k].label} (${counts[k] ?? 0})`}
          </button>
        ))}
      </div>

      {loading ? <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div> : (
        <div className="space-y-3">
          {shown.length === 0 && <div className="text-center text-gray-400 text-sm py-10">Không có khách nào cần chăm lại trong bộ lọc này 🎉</div>}
          {shown.map((c) => {
            const meta = PRIORITY_META[c.priority];
            const Icon = meta.icon;
            const status = sent[c.facebookUserId];
            return (
              <div key={c.facebookUserId} className="bg-white rounded-xl border border-gray-200 p-3">
                <div className="flex items-start gap-3">
                  {c.avatarUrl
                    ? <img src={c.avatarUrl} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
                    : <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs shrink-0">{c.facebookUserId.slice(-3)}</div>}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-800 text-sm truncate">{c.displayName}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${meta.cls}`}><Icon className="w-3 h-3" /> {meta.label}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600">{c.predictedNeed}</span>
                      {c.phone && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-600 flex items-center gap-0.5"><Phone className="w-3 h-3" /> {c.phone}</span>}
                    </div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">Cuối: {c.lastMessage ?? "—"}</div>
                    <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1"><Clock className="w-3 h-3" /> im {c.silenceDays} ngày · {c.reason}</div>
                  </div>
                </div>

                <textarea
                  value={drafts[c.facebookUserId] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.facebookUserId]: e.target.value }))}
                  rows={2}
                  className="mt-2 w-full px-3 py-2 border rounded-lg text-sm"
                />

                <div className={`mt-1.5 text-[11px] flex items-center gap-1 ${c.within24h ? "text-green-600" : "text-amber-600"}`}>
                  <AlertTriangle className="w-3 h-3 shrink-0" /> {c.windowNote}
                </div>

                <div className="flex items-center gap-2 mt-2">
                  <button onClick={() => send(c.facebookUserId)} disabled={busy === c.facebookUserId || c.priority === "skip"}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500 text-white text-sm disabled:opacity-50">
                    {busy === c.facebookUserId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Duyệt & gửi
                  </button>
                  <button onClick={() => copy(c.facebookUserId)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-gray-600 text-sm"><Copy className="w-4 h-4" /> Sao chép</button>
                  {status === "ok" && <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Đã gửi</span>}
                  {status && status !== "ok" && <span className="text-xs text-red-600 truncate">{status}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
