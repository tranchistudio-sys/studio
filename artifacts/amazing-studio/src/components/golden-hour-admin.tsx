import { useEffect, useState } from "react";

// Nút + modal quản lý "Giờ vàng" cho 1 nhóm danh mục (scope='category').
// Tự chứa: tự gọi /api/golden-hour (POST upsert, DELETE, GET list). Không phụ thuộc
// state của trang categories.tsx → an toàn, dễ gắn vào hàng danh mục.

const TOKEN_KEY = "amazingStudioToken_v2";
function authHeaders(): Record<string, string> {
  const t = localStorage.getItem(TOKEN_KEY);
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Campaign {
  id: number; scope: string; refId: number; name: string; percent: number;
  startsAt: string | null; endsAt: string | null; isActive: boolean;
}

export function GoldenHourCategoryButton({ categoryId, categoryName }: { categoryId: number; categoryName: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState<Campaign | null>(null);
  const [active, setActive] = useState(true);
  const [percent, setPercent] = useState(30);
  const [name, setName] = useState("Giờ vàng hôm nay");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    setLoading(true); setMsg("");
    try {
      const r = await fetch(`/api/golden-hour`, { headers: authHeaders() });
      if (r.ok) {
        const all: Campaign[] = await r.json();
        const c = all.find((x) => x.scope === "category" && Number(x.refId) === Number(categoryId)) || null;
        setExisting(c);
        if (c) {
          setActive(c.isActive); setPercent(Number(c.percent) || 0);
          setName(c.name || "Giờ vàng hôm nay");
          setStartsAt(toLocalInput(c.startsAt)); setEndsAt(toLocalInput(c.endsAt));
        }
      }
    } catch { /* ignore */ } finally { setLoading(false); }
  }
  useEffect(() => { if (open) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  async function save() {
    setSaving(true); setMsg("");
    try {
      const body = {
        scope: "category", refId: categoryId, name: name.trim() || "Giờ vàng",
        percent: Number(percent),
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        isActive: active,
      };
      const r = await fetch(`/api/golden-hour`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setMsg(j.error || "Lỗi lưu");
      else { setExisting(j); setMsg("Đã lưu ✓"); }
    } catch { setMsg("Lỗi mạng"); } finally { setSaving(false); }
  }
  async function remove() {
    if (!existing) { setOpen(false); return; }
    setSaving(true);
    try {
      await fetch(`/api/golden-hour/${existing.id}`, { method: "DELETE", headers: authHeaders() });
      setExisting(null); setMsg("Đã xoá — về giá niêm yết");
    } catch { /* ignore */ } finally { setSaving(false); }
  }

  const isOn = !!existing?.isActive && Number(existing?.percent) > 0;

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={`text-[10px] px-2 py-1 rounded-full border whitespace-nowrap transition-colors ${isOn ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-neutral-50 text-neutral-500 border-neutral-200 hover:bg-amber-50"}`}
        title="Giảm giá giờ vàng cho cả nhóm"
      >
        ⚡ {isOn ? `-${Math.round(Number(existing!.percent))}%` : "Giờ vàng"}
      </button>

      {open && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">⚡ Giờ vàng — {categoryName}</h3>
              <button type="button" onClick={() => setOpen(false)} className="text-neutral-400 hover:text-neutral-700">✕</button>
            </div>
            {loading ? (
              <p className="text-sm text-neutral-500">Đang tải...</p>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                  Bật giảm giá giờ vàng (áp cho cả nhóm con)
                </label>
                <div>
                  <label className="text-xs text-neutral-500">% giảm</label>
                  <div className="flex gap-1.5 mt-1 flex-wrap">
                    {[10, 20, 30, 50].map((p) => (
                      <button key={p} type="button" onClick={() => setPercent(p)}
                        className={`px-2.5 py-1 rounded-lg text-sm border ${percent === p ? "bg-amber-500 text-white border-amber-500" : "border-neutral-200"}`}>{p}%</button>
                    ))}
                    <input type="number" min={1} max={99} value={percent}
                      onChange={(e) => setPercent(Number(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg text-sm" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-neutral-500">Tên chương trình</label>
                  <input value={name} onChange={(e) => setName(e.target.value)}
                    className="w-full mt-1 px-2 py-1.5 border rounded-lg text-sm" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-neutral-500">Bắt đầu</label>
                    <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
                      className="w-full mt-1 px-2 py-1 border rounded-lg text-xs" />
                  </div>
                  <div>
                    <label className="text-xs text-neutral-500">Kết thúc</label>
                    <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
                      className="w-full mt-1 px-2 py-1 border rounded-lg text-xs" />
                  </div>
                </div>
                <p className="text-[11px] text-neutral-400">
                  Để trống thời gian = không giới hạn. Hết giờ tự hết giảm. SP đã có giá giảm riêng sẽ KHÔNG bị áp giờ vàng.
                </p>
                {msg && <p className="text-xs text-amber-700">{msg}</p>}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <button type="button" onClick={remove} disabled={saving || !existing}
                    className="text-xs text-red-600 disabled:opacity-30">Xoá / Tắt hẳn</button>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm rounded-lg border">Đóng</button>
                    <button type="button" onClick={save} disabled={saving}
                      className="px-3 py-1.5 text-sm rounded-lg bg-amber-500 text-white disabled:opacity-50">{saving ? "Đang lưu..." : "Lưu"}</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
