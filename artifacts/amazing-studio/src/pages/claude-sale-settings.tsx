import { useState, useEffect, useCallback } from "react";
import { apiUrl } from "@/lib/api-base";
import {
  Save, RotateCcw, Eye, Loader2, Power, Sparkles, MessageSquare, Gauge, TrendingUp,
  Image, Link2, ListOrdered, Plug, BookCheck, CalendarClock, X, CheckCircle2, AlertTriangle,
} from "lucide-react";

/**
 * Cài đặt Claude Sale — nguồn cấu hình DUY NHẤT cho Claude Sale Test & Facebook Messenger.
 * Chỉ admin. KHÔNG đụng booking/tài chính/CRM/khách hàng — chỉ cấu hình chatbot.
 */

type SaleStep = { title: string; content: string };

type Settings = {
  aiName: string; aiGender: "female" | "male"; aiRole: string;
  styleSelfEm: boolean; styleAddressByContext: boolean; styleNoQuyKhach: boolean;
  styleNoRepeatAnhChi: boolean; styleNoRobot: boolean; styleNoMarkdown: boolean;
  styleNoAsterisk: boolean; styleNoLongBullets: boolean;
  delayU10: number; delay10_20: number; delay20_30: number; delay30_40: number; delayO40: number; delayRandom30: boolean;
  saleLevel: 1 | 2 | 3 | 4 | 5;
  imgConcept: boolean; imgWedding: boolean; imgBeauty: boolean; imgPregnancy: boolean; imgFamily: boolean; imgDress: boolean;
  linkWebsite: boolean; linkFanpage: boolean; linkAlbum: boolean; linkPricing: boolean;
  saleSteps: SaleStep[];
  connectClaudeTest: boolean; connectMessenger: boolean; connectZalo: boolean;
  calendarEnabled: boolean;
  calBeautyBasicH: number; calBeautyMultiMinH: number; calBeautyMultiMaxH: number; calBeautyVipH: number;
  calStudioBasicH: number; calStudioMultiH: number; calStudioVipH: number;
  calGapH: number; calWeekendCaution: boolean; calWindowDays: number;
};

type Playbook = { content: string } | null;

function token(): string | null { return localStorage.getItem("amazingStudioToken_v2"); }
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

const DELAY_TIERS: { key: keyof Settings; label: string }[] = [
  { key: "delayU10", label: "Dưới 10 ký tự" },
  { key: "delay10_20", label: "10 – 20 ký tự" },
  { key: "delay20_30", label: "20 – 30 ký tự" },
  { key: "delay30_40", label: "30 – 40 ký tự" },
  { key: "delayO40", label: "Trên 40 ký tự" },
];
const SALE_LEVEL_LABELS: Record<number, string> = {
  1: "Chỉ trả lời câu hỏi", 2: "Trả lời + hỏi thêm", 3: "Chủ động tư vấn",
  4: "Chủ động xin SĐT", 5: "Chủ động dẫn khách chốt lịch",
};

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-rose-500" : "bg-gray-300"}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
      <span className="text-sm">
        <span className="text-gray-800">{label}</span>
        {hint && <span className="block text-xs text-gray-400">{hint}</span>}
      </span>
    </label>
  );
}

function Section({ icon: Icon, title, desc, children }: { icon: React.ElementType; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-lg bg-rose-50 flex items-center justify-center text-rose-500 shrink-0"><Icon className="w-5 h-5" /></div>
        <div>
          <h3 className="font-semibold text-gray-800 text-sm sm:text-base">{title}</h3>
          {desc && <p className="text-xs text-gray-400">{desc}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

export default function ClaudeSaleSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [masterEnabled, setMasterEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);
  const [preview, setPreview] = useState<{ persona: string; calendar: string; scheduleContext: string; pricingContext: string; playbook: Playbook } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [togglingMaster, setTogglingMaster] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(apiUrl("/api/claude-sale/settings"), { headers: authHeaders() });
      const d = await r.json();
      if (r.ok) { setSettings(d.settings); setMasterEnabled(!!d.masterEnabled); }
      else setFlash({ ok: false, msg: d.error || "Không tải được cấu hình" });
    } catch (e) { setFlash({ ok: false, msg: `Lỗi: ${String(e).slice(0, 120)}` }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => (s ? { ...s, [key]: value } : s));
  const setStep = (i: number, patch: Partial<SaleStep>) =>
    setSettings((s) => s ? { ...s, saleSteps: s.saleSteps.map((st, idx) => idx === i ? { ...st, ...patch } : st) } : s);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const r = await fetch(apiUrl("/api/claude-sale/settings"), { method: "PUT", headers: authHeaders(), body: JSON.stringify({ settings }) });
      const d = await r.json();
      if (r.ok) { setSettings(d.settings); setFlash({ ok: true, msg: "Đã lưu cấu hình. Áp dụng cho cả Claude Sale Test và Messenger." }); }
      else setFlash({ ok: false, msg: d.error || "Lưu thất bại" });
    } catch (e) { setFlash({ ok: false, msg: `Lỗi: ${String(e).slice(0, 120)}` }); }
    finally { setSaving(false); }
  };

  const reset = async () => {
    if (!confirm("Khôi phục toàn bộ cấu hình về mặc định?")) return;
    setSaving(true);
    try {
      const r = await fetch(apiUrl("/api/claude-sale/settings/reset"), { method: "POST", headers: authHeaders() });
      const d = await r.json();
      if (r.ok) { setSettings(d.settings); setFlash({ ok: true, msg: "Đã khôi phục mặc định." }); }
    } catch (e) { setFlash({ ok: false, msg: `Lỗi: ${String(e).slice(0, 120)}` }); }
    finally { setSaving(false); }
  };

  const openPreview = async () => {
    setShowPreview(true); setPreview(null);
    try {
      const r = await fetch(apiUrl("/api/claude-sale/settings/prompt-preview"), { headers: authHeaders() });
      const d = await r.json();
      if (r.ok) setPreview(d);
    } catch { /* ignore */ }
  };

  const toggleMaster = async () => {
    setTogglingMaster(true);
    try {
      const r = await fetch(apiUrl("/api/claude-sale/master"), { method: "PUT", headers: authHeaders(), body: JSON.stringify({ enabled: !masterEnabled }) });
      const d = await r.json();
      if (r.ok) setMasterEnabled(!!d.enabled);
    } catch { /* ignore */ }
    finally { setTogglingMaster(false); }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (!settings) {
    return (
      <div className="max-w-md mx-auto mt-16 text-center px-4">
        <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
        <p className="font-semibold text-gray-800">Chưa tải được cấu hình</p>
        <p className="text-sm text-gray-500 mt-1">{flash?.msg || "API Claude Sale chưa sẵn sàng. Hãy khởi động lại server (pnpm dev:api) rồi thử lại."}</p>
        <button onClick={load} className="mt-4 px-4 py-2 rounded-xl bg-rose-500 text-white text-sm">Thử lại</button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto pb-28 px-3 sm:px-0">
      <div className="py-4">
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><Sparkles className="w-5 h-5 text-rose-500" /> Cài đặt Claude Sale</h1>
        <p className="text-sm text-gray-500">Một nơi cấu hình duy nhất — áp dụng cho cả Claude Sale Test và chatbot Fanpage.</p>
      </div>

      {/* CẦU DAO TỔNG */}
      <div className={`rounded-2xl border p-4 sm:p-5 mb-4 ${masterEnabled ? "border-green-300 bg-green-50" : "border-gray-300 bg-gray-50"}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${masterEnabled ? "bg-green-500 text-white" : "bg-gray-300 text-gray-600"}`}><Power className="w-6 h-6" /></div>
            <div className="min-w-0">
              <div className="font-semibold text-gray-800">Cầu dao tổng Claude Sale</div>
              <div className={`text-sm font-medium ${masterEnabled ? "text-green-700" : "text-gray-500"}`}>
                {masterEnabled ? "🟢 ĐANG HOẠT ĐỘNG — Claude chăm lead" : "🔴 ĐANG TẮT — Nhân viên chăm lead"}
              </div>
            </div>
          </div>
          <button
            onClick={toggleMaster}
            disabled={togglingMaster}
            className={`shrink-0 px-4 py-2 rounded-xl font-medium text-white disabled:opacity-50 ${masterEnabled ? "bg-gray-500 hover:bg-gray-600" : "bg-green-600 hover:bg-green-700"}`}
          >
            {togglingMaster ? <Loader2 className="w-5 h-5 animate-spin" /> : masterEnabled ? "Tắt" : "Bật"}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-3">Khi tắt: Fanpage vẫn nhận tin, vẫn lưu lead & lịch sử chat — chatbot chỉ không trả lời. Dùng chung công tắc này cho mọi chatbot hiện tại và sau này.</p>
      </div>

      <div className="space-y-4">
        {/* A. THÔNG TIN NHÂN VIÊN AI */}
        <Section icon={Sparkles} title="A. Thông tin nhân viên AI">
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="text-gray-600">Tên AI</span>
              <input value={settings.aiName} onChange={(e) => set("aiName", e.target.value)} className="mt-1 w-full px-3 py-2 border rounded-lg" />
            </label>
            <label className="text-sm">
              <span className="text-gray-600">Giới tính</span>
              <select value={settings.aiGender} onChange={(e) => set("aiGender", e.target.value as Settings["aiGender"])} className="mt-1 w-full px-3 py-2 border rounded-lg bg-white">
                <option value="female">Nữ</option>
                <option value="male">Nam</option>
              </select>
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="text-gray-600">Vai trò</span>
              <input value={settings.aiRole} onChange={(e) => set("aiRole", e.target.value)} className="mt-1 w-full px-3 py-2 border rounded-lg" />
            </label>
          </div>
        </Section>

        {/* B. PHONG CÁCH GIAO TIẾP */}
        <Section icon={MessageSquare} title="B. Phong cách giao tiếp" desc='Mong muốn: "Chào anh 😊", "Em là Hoa bên Amazing Studio." — KHÔNG "Xin chào anh/chị", KHÔNG "quý khách", KHÔNG **đậm**.'>
          <div className="grid sm:grid-cols-2 gap-x-6">
            <Toggle checked={settings.styleSelfEm} onChange={(v) => set("styleSelfEm", v)} label="Xưng em" />
            <Toggle checked={settings.styleAddressByContext} onChange={(v) => set("styleAddressByContext", v)} label="Gọi khách anh/chị theo ngữ cảnh" />
            <Toggle checked={settings.styleNoQuyKhach} onChange={(v) => set("styleNoQuyKhach", v)} label='Không dùng "quý khách"' />
            <Toggle checked={settings.styleNoRepeatAnhChi} onChange={(v) => set("styleNoRepeatAnhChi", v)} label='Không lặp "anh/chị" liên tục' />
            <Toggle checked={settings.styleNoRobot} onChange={(v) => set("styleNoRobot", v)} label="Không văn phong robot" />
            <Toggle checked={settings.styleNoMarkdown} onChange={(v) => set("styleNoMarkdown", v)} label="Không dùng markdown" />
            <Toggle checked={settings.styleNoAsterisk} onChange={(v) => set("styleNoAsterisk", v)} label="Không dùng dấu **" />
            <Toggle checked={settings.styleNoLongBullets} onChange={(v) => set("styleNoLongBullets", v)} label="Không bullet dài dòng" />
          </div>
        </Section>

        {/* C. TỐC ĐỘ TRẢ LỜI — delay theo độ dài tin khách */}
        <Section icon={Gauge} title="C. Tốc độ trả lời" desc="Đặt số giây chờ trước khi AI trả lời, theo độ dài tin khách gửi. Áp dụng cho cả Claude Sale Test và chatbot Fanpage.">
          <div className="space-y-2">
            {DELAY_TIERS.map((t) => (
              <div key={t.key as string} className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-700">{t.label}</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number" min={0} step={0.5}
                    value={settings[t.key] as number}
                    onChange={(e) => set(t.key, Number(e.target.value) as never)}
                    className="w-20 px-2 py-1.5 border rounded-lg text-sm text-right"
                  />
                  <span className="text-xs text-gray-400 w-8">giây</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 pt-3 border-t">
            <Toggle
              checked={settings.delayRandom30}
              onChange={(v) => set("delayRandom30", v)}
              label="Random ±30%"
              hint="Ví dụ cài 10 giây → AI trả lời ngẫu nhiên 7–13 giây cho giống người thật."
            />
          </div>
        </Section>

        {/* D. MỨC ĐỘ SALE */}
        <Section icon={TrendingUp} title="D. Mức độ sale">
          <input type="range" min={1} max={5} value={settings.saleLevel} onChange={(e) => set("saleLevel", Number(e.target.value) as Settings["saleLevel"])} className="w-full accent-rose-500" />
          <div className="flex justify-between text-[10px] text-gray-400 px-1">{[1, 2, 3, 4, 5].map((n) => <span key={n}>{n}</span>)}</div>
          <div className="mt-1 text-sm text-rose-700 font-medium">Mức {settings.saleLevel}: {SALE_LEVEL_LABELS[settings.saleLevel]}</div>
        </Section>

        {/* E. GỬI ẢNH MẪU */}
        <Section icon={Image} title="E. Gửi ảnh mẫu" desc="Bật/tắt loại ảnh AI được gửi. (Sau này đọc ảnh thật từ CMS — hiện là placeholder.)">
          <div className="grid sm:grid-cols-2 gap-x-6">
            <Toggle checked={settings.imgConcept} onChange={(v) => set("imgConcept", v)} label="Ảnh mẫu concept" />
            <Toggle checked={settings.imgWedding} onChange={(v) => set("imgWedding", v)} label="Ảnh cưới" />
            <Toggle checked={settings.imgBeauty} onChange={(v) => set("imgBeauty", v)} label="Ảnh beauty" />
            <Toggle checked={settings.imgPregnancy} onChange={(v) => set("imgPregnancy", v)} label="Ảnh bầu" />
            <Toggle checked={settings.imgFamily} onChange={(v) => set("imgFamily", v)} label="Ảnh gia đình" />
            <Toggle checked={settings.imgDress} onChange={(v) => set("imgDress", v)} label="Ảnh váy cưới" />
          </div>
        </Section>

        {/* F. GỬI LINK */}
        <Section icon={Link2} title="F. Gửi link">
          <div className="grid sm:grid-cols-2 gap-x-6">
            <Toggle checked={settings.linkWebsite} onChange={(v) => set("linkWebsite", v)} label="Website" />
            <Toggle checked={settings.linkFanpage} onChange={(v) => set("linkFanpage", v)} label="Fanpage" />
            <Toggle checked={settings.linkAlbum} onChange={(v) => set("linkAlbum", v)} label="Album mẫu" />
            <Toggle checked={settings.linkPricing} onChange={(v) => set("linkPricing", v)} label="Bảng giá" />
          </div>
        </Section>

        {/* G. QUY TRÌNH SALE */}
        <Section icon={ListOrdered} title="G. Quy trình sale" desc="Sửa nội dung dẫn dắt từng bước. (Rào an toàn giá & lịch luôn cố định, không sửa được.)">
          <div className="space-y-3">
            {settings.saleSteps.map((st, i) => (
              <div key={i} className="border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 text-xs font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                  <input value={st.title} onChange={(e) => setStep(i, { title: e.target.value })} className="flex-1 px-2 py-1 border rounded text-sm font-medium" />
                </div>
                <textarea value={st.content} onChange={(e) => setStep(i, { content: e.target.value })} rows={2} className="w-full px-2 py-1 border rounded text-sm text-gray-700" />
              </div>
            ))}
          </div>
        </Section>

        {/* J. ĐỌC LỊCH THÔNG MINH */}
        <Section icon={CalendarClock} title="J. Đọc lịch thông minh" desc="CHỈ ĐỌC & đề xuất — Claude không bao giờ tạo/sửa/giữ/khóa booking.">
          <Toggle checked={settings.calendarEnabled} onChange={(v) => set("calendarEnabled", v)} label="Cho phép Claude đọc & phân tích lịch" />
          {settings.calendarEnabled && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2">
              {([
                ["calBeautyBasicH", "Beauty cơ bản (giờ)"],
                ["calBeautyMultiMinH", "Beauty nhiều layout — từ"],
                ["calBeautyMultiMaxH", "Beauty nhiều layout — đến"],
                ["calBeautyVipH", "Beauty VIP"],
                ["calStudioBasicH", "Chụp cổng/album cơ bản"],
                ["calStudioMultiH", "Nhiều trang phục"],
                ["calStudioVipH", "Gói VIP"],
                ["calGapH", "Nghỉ giữa show (giờ)"],
                ["calWindowDays", "Đọc lịch trước (ngày)"],
              ] as [keyof Settings, string][]).map(([k, label]) => (
                <label key={k as string} className="text-xs">
                  <span className="text-gray-600">{label}</span>
                  <input type="number" min={0} value={settings[k] as number} onChange={(e) => set(k, Number(e.target.value) as never)} className="mt-1 w-full px-2 py-1.5 border rounded-lg" />
                </label>
              ))}
              <div className="col-span-2 sm:col-span-3">
                <Toggle checked={settings.calWeekendCaution} onChange={(v) => set("calWeekendCaution", v)} label="Cuối tuần (T7/CN) phải kiểm tra kỹ, không khẳng định chắc" />
              </div>
            </div>
          )}
        </Section>

        {/* H. KẾT NỐI CHATBOT */}
        <Section icon={Plug} title="H. Kết nối chatbot">
          <Toggle checked={settings.connectClaudeTest} onChange={(v) => set("connectClaudeTest", v)} label="Claude Sale Test" />
          <Toggle checked={settings.connectMessenger} onChange={(v) => set("connectMessenger", v)} label="Facebook Messenger" hint="Bật Messenger: Fanpage dùng cùng cấu hình này." />
          <div className="flex items-center gap-3 py-2 opacity-50">
            <div className="h-6 w-11 rounded-full bg-gray-300 shrink-0 relative"><span className="inline-block h-5 w-5 rounded-full bg-white shadow translate-x-0.5 mt-0.5" /></div>
            <span className="text-sm text-gray-500">Zalo <span className="text-xs">(chưa hoạt động)</span></span>
          </div>
        </Section>

        {/* I. PLAYBOOK ĐÃ DUYỆT */}
        <Section icon={BookCheck} title="I. Playbook đã duyệt" desc="Nguồn: Sale Learning (chỉ bản đang áp dụng).">
          {preview?.playbook?.content
            ? <pre className="whitespace-pre-wrap text-xs text-gray-600 bg-gray-50 rounded-lg p-3 max-h-40 overflow-auto">{preview.playbook.content.slice(0, 800)}</pre>
            : <p className="text-sm text-gray-400">Bấm "Xem prompt đang dùng" để xem playbook hiện hành (nếu có). Quản lý/duyệt playbook ở trang Sale Learning.</p>}
        </Section>
      </div>

      {/* Thanh hành động cố định */}
      <div className="fixed bottom-0 left-0 right-0 sm:left-auto bg-white/95 backdrop-blur border-t p-3 flex gap-2 justify-center sm:justify-end sm:pr-6 z-20">
        <button onClick={openPreview} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-gray-700 hover:bg-gray-50 text-sm"><Eye className="w-4 h-4" /> Xem prompt đang dùng</button>
        <button onClick={reset} disabled={saving} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-gray-700 hover:bg-gray-50 text-sm disabled:opacity-50"><RotateCcw className="w-4 h-4" /> Khôi phục mặc định</button>
        <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-500 text-white hover:bg-rose-600 text-sm disabled:opacity-50">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Lưu cấu hình</button>
      </div>

      {flash && (
        <div className={`fixed bottom-20 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-xl text-sm shadow-lg flex items-center gap-2 ${flash.ok ? "bg-green-600 text-white" : "bg-rose-600 text-white"}`}>
          {flash.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />} {flash.msg}
        </div>
      )}

      {/* Modal prompt preview */}
      {showPreview && (
        <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4" onClick={() => setShowPreview(false)}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold text-gray-800 flex items-center gap-2"><Eye className="w-4 h-4" /> Prompt Claude đang dùng</h3>
              <button onClick={() => setShowPreview(false)} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="overflow-auto p-4 text-xs space-y-4">
              {!preview ? <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div> : (
                <>
                  <PreviewBlock title="Persona & phong cách & quy trình" text={preview.persona} />
                  {preview.calendar && <PreviewBlock title="Quy tắc đọc lịch" text={preview.calendar} />}
                  {preview.scheduleContext && <PreviewBlock title="Lịch sắp tới (read-only)" text={preview.scheduleContext} />}
                  <PreviewBlock title="Dữ liệu giá / link (đã lọc an toàn)" text={preview.pricingContext} />
                  {preview.playbook?.content && <PreviewBlock title="Playbook đã duyệt" text={preview.playbook.content} />}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewBlock({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="font-semibold text-gray-700 mb-1">{title}</div>
      <pre className="whitespace-pre-wrap text-gray-600 bg-gray-50 rounded-lg p-3">{text}</pre>
    </div>
  );
}
