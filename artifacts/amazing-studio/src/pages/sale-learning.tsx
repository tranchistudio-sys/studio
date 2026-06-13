import { useState, useEffect, useCallback } from "react";
import { apiUrl } from "@/lib/api-base";
import {
  GraduationCap, ScanSearch, Sparkles, Pencil, Check, X, Rocket, Loader2,
  AlertTriangle, FileText, RefreshCw,
} from "lucide-react";

/**
 * Sale Learning — học phong cách tư vấn từ chat Facebook thật, CÓ KIỂM DUYỆT.
 * Admin: Quét → Tạo nháp (Claude) → Xem/Sửa → Duyệt/Từ chối → Áp dụng cho Claude Sale.
 * Chỉ bản "active" mới được Claude Sale đọc. Playbook chỉ học giọng/cách dẫn, KHÔNG học giá.
 */

type Status = "draft" | "approved" | "rejected" | "active";
type PlaybookListItem = {
  id: number; title: string; status: Status; conversations_used: number;
  created_by_name: string | null; approved_by_name: string | null;
  created_at: string; activated_at: string | null; edited: boolean;
};
type PlaybookDetail = PlaybookListItem & { content: string; content_original: string | null; source_summary: string | null };
type ScanResult = {
  qualifying: number; withPhone: number; askedPrice: number; askedConcept: number; totalMessages: number;
  sample: Array<{ name: string; messages: number; hasPhone: boolean; askedPrice: boolean; askedConcept: boolean; askedSchedule: boolean }>;
};

function token() { return localStorage.getItem("amazingStudioToken_v2"); }
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
async function api(path: string, opts?: RequestInit) {
  const r = await fetch(apiUrl(path), { ...opts, headers: { ...authHeaders(), ...(opts?.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Lỗi ${r.status}`);
  return data;
}

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  draft: { label: "Nháp", cls: "bg-gray-100 text-gray-600" },
  approved: { label: "Đã duyệt", cls: "bg-blue-100 text-blue-700" },
  rejected: { label: "Từ chối", cls: "bg-rose-100 text-rose-700" },
  active: { label: "Đang áp dụng", cls: "bg-green-100 text-green-700" },
};

export default function SaleLearningPage() {
  const [playbooks, setPlaybooks] = useState<PlaybookListItem[]>([]);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<PlaybookDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // 'scan' | 'generate' | 'save' | id-action
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const flash = (msg: string) => { setInfo(msg); setTimeout(() => setInfo(null), 4000); };

  const loadList = useCallback(async () => {
    try {
      const d = await api("/api/sale-learning/playbooks");
      setPlaybooks(d.playbooks || []);
    } catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const openPlaybook = async (id: number) => {
    setErr(null); setEditing(false);
    try {
      const d = await api(`/api/sale-learning/playbooks/${id}`);
      setSelected(d.playbook);
      setEditContent(d.playbook.content || "");
    } catch (e) { setErr(String(e)); }
  };

  const doScan = async () => {
    setBusy("scan"); setErr(null);
    try { setScan(await api("/api/sale-learning/scan", { method: "POST", body: "{}" })); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(null); }
  };

  const doGenerate = async () => {
    setBusy("generate"); setErr(null);
    try {
      const d = await api("/api/sale-learning/generate", { method: "POST", body: JSON.stringify({}) });
      flash(`Đã tạo bản nháp từ ${d.conversationsUsed} hội thoại`);
      await loadList();
      if (d.playbook?.id) await openPlaybook(d.playbook.id);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(null); }
  };

  const act = async (id: number, action: "approve" | "reject" | "activate") => {
    setBusy(`${action}-${id}`); setErr(null);
    try {
      await api(`/api/sale-learning/playbooks/${id}/${action}`, { method: "POST", body: "{}" });
      flash(action === "activate" ? "Đã áp dụng cho Claude Sale" : action === "approve" ? "Đã duyệt" : "Đã từ chối");
      await loadList();
      await openPlaybook(id);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(null); }
  };

  const saveEdit = async () => {
    if (!selected) return;
    setBusy("save"); setErr(null);
    try {
      const d = await api(`/api/sale-learning/playbooks/${selected.id}`, { method: "PUT", body: JSON.stringify({ content: editContent }) });
      setSelected(d.playbook); setEditing(false); flash("Đã lưu bản sửa"); await loadList();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(null); }
  };

  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-9 h-9 rounded-full bg-violet-500 flex items-center justify-center text-white"><GraduationCap className="w-5 h-5" /></div>
        <div>
          <h1 className="text-lg font-semibold text-gray-800">Sale Learning</h1>
          <p className="text-xs text-gray-500">Học phong cách từ chat Facebook thật — có kiểm duyệt. Chỉ học giọng/cách dẫn, KHÔNG học giá.</p>
        </div>
      </div>

      {err && <div className="my-2 text-sm bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 flex items-center gap-2"><AlertTriangle className="w-4 h-4" />{err}</div>}
      {info && <div className="my-2 text-sm bg-green-50 border border-green-200 text-green-700 rounded-lg px-3 py-2">{info}</div>}

      {/* Hành động chính */}
      <div className="flex flex-wrap gap-2 my-3">
        <button onClick={doScan} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-50">
          {busy === "scan" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4 text-violet-500" />} Quét hội thoại
        </button>
        <button onClick={doGenerate} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-500 text-white text-sm hover:bg-violet-600 disabled:opacity-50">
          {busy === "generate" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Tạo playbook nháp
        </button>
        <button onClick={loadList} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white border border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw className="w-4 h-4 text-gray-500" /> Tải lại
        </button>
      </div>

      {/* Kết quả quét */}
      {scan && (
        <div className="mb-4 bg-violet-50 border border-violet-200 rounded-lg p-3 text-sm">
          <div className="font-medium text-violet-800 mb-1">Kết quả quét hội thoại</div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-gray-700">
            <span>Đủ tiêu chuẩn: <b>{scan.qualifying}</b></span>
            <span>Có SĐT: <b>{scan.withPhone}</b></span>
            <span>Hỏi giá: <b>{scan.askedPrice}</b></span>
            <span>Hỏi concept: <b>{scan.askedConcept}</b></span>
            <span>Tổng tin: <b>{scan.totalMessages}</b></span>
          </div>
          {scan.sample.length > 0 && (
            <div className="mt-2 text-xs text-gray-500">
              Ví dụ: {scan.sample.slice(0, 6).map((s, i) => `${s.name} (${s.messages} tin${s.hasPhone ? ", có SĐT" : ""})`).join(" · ")}
            </div>
          )}
          <div className="mt-1 text-xs text-gray-400">Đã loại tin test/rác/quá ngắn và tin chứa giá đối tác/nội bộ/CTV. Bấm "Tạo playbook nháp" để AI đề xuất.</div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-4">
        {/* Danh sách playbook */}
        <div className="border rounded-lg bg-white overflow-hidden">
          <div className="px-3 py-2 border-b text-sm font-medium text-gray-700">Các playbook ({playbooks.length})</div>
          <div className="divide-y max-h-[60vh] overflow-y-auto">
            {playbooks.length === 0 && <div className="p-4 text-sm text-gray-400">Chưa có playbook nào. Quét hội thoại rồi tạo nháp.</div>}
            {playbooks.map((p) => (
              <button key={p.id} onClick={() => openPlaybook(p.id)}
                className={`w-full text-left px-3 py-2 hover:bg-gray-50 ${selected?.id === p.id ? "bg-violet-50" : ""}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-800 truncate">{p.title}</span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_META[p.status].cls}`}>{STATUS_META[p.status].label}</span>
                </div>
                <div className="text-[11px] text-gray-400 mt-0.5">{p.conversations_used} hội thoại · {p.created_by_name || "?"}{p.edited ? " · đã sửa" : ""}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Chi tiết */}
        <div className="border rounded-lg bg-white p-4 min-h-[300px]">
          {!selected ? (
            <div className="text-sm text-gray-400 flex items-center gap-2"><FileText className="w-4 h-4" /> Chọn một playbook để xem chi tiết.</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-gray-800">{selected.title}</h2>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${STATUS_META[selected.status].cls}`}>{STATUS_META[selected.status].label}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selected.status !== "active" && !editing && (
                    <button onClick={() => { setEditing(true); setEditContent(selected.content); }} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-white border hover:bg-gray-50"><Pencil className="w-3.5 h-3.5" /> Sửa</button>
                  )}
                  {editing && (
                    <>
                      <button onClick={saveEdit} disabled={busy === "save"} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-violet-500 text-white hover:bg-violet-600">{busy === "save" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Lưu</button>
                      <button onClick={() => setEditing(false)} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-white border hover:bg-gray-50"><X className="w-3.5 h-3.5" /> Hủy</button>
                    </>
                  )}
                  {!editing && (selected.status === "draft" || selected.status === "approved") && (
                    <button onClick={() => act(selected.id, "approve")} disabled={!!busy} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-500 text-white hover:bg-blue-600"><Check className="w-3.5 h-3.5" /> Duyệt</button>
                  )}
                  {!editing && selected.status !== "rejected" && selected.status !== "active" && (
                    <button onClick={() => act(selected.id, "reject")} disabled={!!busy} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-white border text-rose-600 hover:bg-rose-50"><X className="w-3.5 h-3.5" /> Từ chối</button>
                  )}
                  {!editing && selected.status !== "rejected" && selected.status !== "active" && (
                    <button onClick={() => act(selected.id, "activate")} disabled={!!busy} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700">{busy === `activate-${selected.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />} Áp dụng cho Claude Sale</button>
                  )}
                </div>
              </div>
              <div className="text-[11px] text-gray-400 mb-3">
                Tạo: {new Date(selected.created_at).toLocaleString("vi-VN")} bởi {selected.created_by_name || "?"} · {selected.conversations_used} hội thoại
                {selected.approved_by_name ? ` · Duyệt bởi ${selected.approved_by_name}` : ""}
                {selected.content_original ? " · (đã chỉnh sửa từ bản gốc)" : ""}
              </div>
              {editing ? (
                <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={22}
                  className="w-full text-sm border border-gray-300 rounded-lg p-3 font-mono focus:outline-none focus:ring-2 focus:ring-violet-300" />
              ) : (
                <pre className="whitespace-pre-wrap break-words text-sm text-gray-800 bg-gray-50 rounded-lg p-3 max-h-[60vh] overflow-y-auto font-sans">{selected.content}</pre>
              )}
              {selected.status === "active" && <div className="mt-2 text-xs text-green-700">✅ Bản này đang được Claude Sale dùng để học phong cách.</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
