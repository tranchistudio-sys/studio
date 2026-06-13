import { useState, useEffect, useCallback } from "react";
import { apiUrl } from "@/lib/api-base";
import { Link } from "wouter";
import {
  Loader2, Bot, UserCog, PauseCircle, AlertTriangle, Phone, CalendarCheck, CheckCircle2,
  Users, RefreshCw, Power, ExternalLink, ShieldAlert,
} from "lucide-react";

/**
 * Claude Sale Monitor — theo dõi AI đang chăm lead nào, ai cần nhân viên tiếp quản.
 * Chỉ ĐỌC crm_leads + cờ module. KHÔNG đụng booking/tài chính/khách hàng.
 */

type Stats = {
  aiActive: number; takeover: number; paused: number; needsHuman: number;
  phoneCaptured: number; appointmentIntent: number; converted: number; total: number;
};
type Lead = {
  facebookUserId: string; name: string | null; avatarUrl: string | null; aiMode: string;
  phone: string | null; lastMessage: string | null; lastMessageAt: string | null;
  phoneCaptured: boolean; appointmentIntent: boolean; needsHuman: boolean; escalationReason: string | null;
};

function token() { return localStorage.getItem("amazingStudioToken_v2"); }
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
function displayName(l: Lead): string {
  if (l.name && !l.name.startsWith("Khách Facebook ") && !/^Khách\s/i.test(l.name)) return l.name;
  return `FB …${l.facebookUserId.slice(-4)}`;
}
function timeAgo(s: string | null): string {
  if (!s) return "—";
  const mins = Math.floor((Date.now() - new Date(s).getTime()) / 60000);
  if (mins < 60) return `${mins} phút trước`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} giờ trước`;
  return `${Math.floor(hrs / 24)} ngày trước`;
}

const AI_MODE_META: Record<string, { label: string; cls: string }> = {
  active: { label: "🟢 AI đang chăm", cls: "bg-green-100 text-green-700" },
  takeover: { label: "🟡 NV tiếp quản", cls: "bg-amber-100 text-amber-700" },
  paused: { label: "🔴 AI tắt", cls: "bg-gray-200 text-gray-600" },
};

function StatCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: number; color: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${color}`}><Icon className="w-5 h-5" /></div>
      <div className="min-w-0">
        <div className="text-lg font-bold text-gray-800 leading-tight">{value}</div>
        <div className="text-[11px] text-gray-500 leading-tight">{label}</div>
      </div>
    </div>
  );
}

export default function ClaudeSaleMonitorPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [masterEnabled, setMasterEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "takeover" | "paused" | "needs_human">("all");

  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/api/claude-sale/monitor"), { headers: authHeaders() });
      const d = await r.json();
      if (r.ok) { setStats(d.stats); setLeads(d.leads ?? []); setMasterEnabled(!!d.masterEnabled); }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setAiMode = async (psid: string, aiMode: string) => {
    setBusy(psid);
    try {
      await fetch(apiUrl(`/api/fb-ai/threads/${psid}/ai-mode`), { method: "PUT", headers: authHeaders(), body: JSON.stringify({ aiMode }) });
      setLeads((ls) => ls.map((l) => l.facebookUserId === psid ? { ...l, aiMode } : l));
    } catch { /* ignore */ }
    finally { setBusy(null); }
  };

  const clearEscalation = async (psid: string) => {
    setBusy(psid);
    try {
      await fetch(apiUrl(`/api/claude-sale/leads/${psid}/clear-escalation`), { method: "PATCH", headers: authHeaders() });
      setLeads((ls) => ls.map((l) => l.facebookUserId === psid ? { ...l, needsHuman: false } : l));
    } catch { /* ignore */ }
    finally { setBusy(null); }
  };

  const shown = leads.filter((l) => {
    if (filter === "all") return true;
    if (filter === "needs_human") return l.needsHuman;
    return (l.aiMode ?? "active") === filter;
  });

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-0 pb-10">
      <div className="py-4 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><Bot className="w-5 h-5 text-rose-500" /> Claude Sale Monitor</h1>
          <p className="text-sm text-gray-500">Theo dõi AI đang chăm lead — bật/tắt từng khách, tiếp quản nhanh.</p>
        </div>
        <button onClick={() => { setLoading(true); load(); }} className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm text-gray-600 hover:bg-gray-50"><RefreshCw className="w-4 h-4" /> Tải lại</button>
      </div>

      <div className={`rounded-xl border p-3 mb-4 flex items-center gap-3 ${masterEnabled ? "border-green-300 bg-green-50" : "border-gray-300 bg-gray-50"}`}>
        <Power className={`w-5 h-5 ${masterEnabled ? "text-green-600" : "text-gray-500"}`} />
        <span className={`text-sm font-medium ${masterEnabled ? "text-green-700" : "text-gray-600"}`}>
          Cầu dao tổng: {masterEnabled ? "🟢 ĐANG HOẠT ĐỘNG" : "🔴 ĐANG TẮT"}
        </span>
        <Link href="/claude-sale-settings" className="ml-auto text-xs text-rose-600 hover:underline">Chỉnh cài đặt →</Link>
      </div>

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <StatCard icon={Bot} label="AI đang chăm" value={stats.aiActive} color="bg-green-100 text-green-600" />
          <StatCard icon={UserCog} label="NV tiếp quản" value={stats.takeover} color="bg-amber-100 text-amber-600" />
          <StatCard icon={PauseCircle} label="AI tắt" value={stats.paused} color="bg-gray-100 text-gray-500" />
          <StatCard icon={ShieldAlert} label="Cần xác nhận" value={stats.needsHuman} color="bg-red-100 text-red-600" />
          <StatCard icon={Phone} label="Đã xin SĐT" value={stats.phoneCaptured} color="bg-sky-100 text-sky-600" />
          <StatCard icon={CalendarCheck} label="Muốn hẹn lịch" value={stats.appointmentIntent} color="bg-violet-100 text-violet-600" />
          <StatCard icon={CheckCircle2} label="Đã chốt khách" value={stats.converted} color="bg-emerald-100 text-emerald-600" />
          <StatCard icon={Users} label="Tổng lead" value={stats.total} color="bg-rose-100 text-rose-600" />
        </div>
      )}

      <div className="flex gap-1.5 mb-3 overflow-x-auto">
        {([["all", "Tất cả"], ["active", "AI đang chăm"], ["takeover", "NV tiếp quản"], ["paused", "AI tắt"], ["needs_human", "Cần xác nhận"]] as [typeof filter, string][]).map(([k, lbl]) => (
          <button key={k} onClick={() => setFilter(k)} className={`shrink-0 px-3 py-1.5 rounded-full text-xs ${filter === k ? "bg-rose-500 text-white" : "bg-gray-100 text-gray-600"}`}>{lbl}</button>
        ))}
      </div>

      <div className="space-y-2">
        {shown.length === 0 && <div className="text-center text-gray-400 text-sm py-10">Không có lead nào trong mục này.</div>}
        {shown.map((l) => (
          <div key={l.facebookUserId} className={`bg-white rounded-xl border p-3 ${l.needsHuman ? "border-red-300" : "border-gray-200"}`}>
            <div className="flex items-start gap-3">
              {l.avatarUrl
                ? <img src={l.avatarUrl} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
                : <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs shrink-0">{l.facebookUserId.slice(-3)}</div>}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-gray-800 text-sm truncate">{displayName(l)}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${AI_MODE_META[l.aiMode]?.cls ?? AI_MODE_META.active.cls}`}>{AI_MODE_META[l.aiMode]?.label ?? l.aiMode}</span>
                  {l.phoneCaptured && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-600 flex items-center gap-0.5"><Phone className="w-3 h-3" /> SĐT</span>}
                  {l.appointmentIntent && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600 flex items-center gap-0.5"><CalendarCheck className="w-3 h-3" /> hẹn lịch</span>}
                </div>
                <div className="text-xs text-gray-500 truncate mt-0.5">{l.lastMessage ?? "—"}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">{timeAgo(l.lastMessageAt)}{l.phone ? ` · ${l.phone}` : ""}</div>
                {l.needsHuman && (
                  <div className="mt-1.5 text-xs text-red-700 bg-red-50 rounded-lg px-2 py-1 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Cần nhân viên: {l.escalationReason ?? "tiếp quản"}
                    <button onClick={() => clearEscalation(l.facebookUserId)} disabled={busy === l.facebookUserId} className="ml-auto text-red-600 underline shrink-0">Đã xử lý</button>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2 pl-13">
              <select value={l.aiMode} onChange={(e) => setAiMode(l.facebookUserId, e.target.value)} disabled={busy === l.facebookUserId}
                className="text-xs border rounded-lg px-2 py-1.5 bg-white">
                <option value="active">🟢 AI đang chăm</option>
                <option value="paused">🔴 Tắt AI (NV chăm)</option>
                <option value="takeover">🟡 NV tiếp quản</option>
              </select>
              <Link href="/facebook-inbox-ai" className="text-xs text-rose-600 hover:underline flex items-center gap-0.5">Mở Inbox <ExternalLink className="w-3 h-3" /></Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
