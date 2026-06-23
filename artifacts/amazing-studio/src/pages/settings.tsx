import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { Card, CardContent, Input, Button, Textarea } from "@/components/ui";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Save, Store, Mail, Phone, MapPin, Building, Clock, Navigation, Loader2, LocateFixed, CheckCircle2, AlertCircle, Bot, MessageSquare, Wrench, Volume2, Play, Vibrate, VolumeX, Wifi } from "lucide-react";
import { RINGTONE_LIBRARY, SOUND_EVENTS, getEventSoundId, setEventSoundId, getSoundSettings, setSoundSettings, previewRingtone, type RingtonePreset, type SoundEvent } from "@/lib/feedback";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

function GpsDetectButton({ onDetected }: { onDetected: (lat: number, lng: number) => void }) {
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [msg, setMsg] = useState("");

  const detect = () => {
    if (!navigator.geolocation) {
      setState("error");
      setMsg("Trình duyệt không hỗ trợ GPS");
      return;
    }
    setState("loading");
    setMsg("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Math.round(pos.coords.latitude * 1000000) / 1000000;
        const lng = Math.round(pos.coords.longitude * 1000000) / 1000000;
        onDetected(lat, lng);
        setState("success");
        setMsg(`Đã lấy vị trí: ${lat}, ${lng} (độ chính xác ~${Math.round(pos.coords.accuracy)}m)`);
        setTimeout(() => setState("idle"), 8000);
      },
      (err) => {
        setState("error");
        if (err.code === 1) setMsg("Bị từ chối quyền GPS. Hãy cho phép trình duyệt truy cập vị trí.");
        else if (err.code === 2) setMsg("Không lấy được vị trí. Hãy thử lại.");
        else setMsg("Hết thời gian chờ GPS. Hãy thử lại.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-4 rounded-xl border border-dashed bg-muted/30">
      <Button type="button" variant="outline" className="gap-2 shrink-0" onClick={detect} disabled={state === "loading"}>
        {state === "loading"
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <LocateFixed className="w-4 h-4 text-blue-500" />}
        {state === "loading" ? "Đang lấy vị trí..." : "Lấy vị trí hiện tại"}
      </Button>
      {state === "success" && (
        <span className="flex items-center gap-1.5 text-sm text-green-700">
          <CheckCircle2 className="w-4 h-4" /> {msg}
        </span>
      )}
      {state === "error" && (
        <span className="flex items-center gap-1.5 text-sm text-red-600">
          <AlertCircle className="w-4 h-4" /> {msg}
        </span>
      )}
      {state === "idle" && (
        <span className="text-sm text-muted-foreground">Bấm nút này khi đang đứng <strong>tại tiệm</strong> để tự động lấy tọa độ GPS</span>
      )}
    </div>
  );
}

function WifiDetectButton({ onDetected }: { onDetected: (ip: string) => void }) {
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [msg, setMsg] = useState("");

  const detect = async () => {
    setState("loading");
    setMsg("");
    try {
      const r = await fetch(`${BASE}/api/attendance/wifi-status`, { headers: authH() });
      const d = (await r.json()) as { clientIp?: string; error?: string };
      if (!r.ok || !d.clientIp) throw new Error(d.error || "Không lấy được IP hiện tại");
      onDetected(d.clientIp);
      setState("success");
      setMsg(`IP hiện tại: ${d.clientIp} — đã thêm vào danh sách`);
      setTimeout(() => setState("idle"), 8000);
    } catch (e) {
      setState("error");
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-4 rounded-xl border border-dashed bg-muted/30">
      <Button type="button" variant="outline" className="gap-2 shrink-0" onClick={() => void detect()} disabled={state === "loading"}>
        {state === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4 text-blue-500" />}
        {state === "loading" ? "Đang lấy IP..." : "Lấy IP mạng hiện tại"}
      </Button>
      {state === "success" && (
        <span className="flex items-center gap-1.5 text-sm text-green-700">
          <CheckCircle2 className="w-4 h-4" /> {msg}
        </span>
      )}
      {state === "error" && (
        <span className="flex items-center gap-1.5 text-sm text-red-600">
          <AlertCircle className="w-4 h-4" /> {msg}
        </span>
      )}
      {state === "idle" && (
        <span className="text-sm text-muted-foreground">Bấm khi thiết bị đang nối <strong>WiFi studio</strong> để lấy IP mạng và thêm vào danh sách hợp lệ</span>
      )}
    </div>
  );
}

function StudioMap({ lat, lng, radius }: { lat: number; lng: number; radius: number }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;
    if (!mapInstanceRef.current) {
      const map = L.map(mapRef.current, { zoomControl: true, attributionControl: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(map);
      mapInstanceRef.current = map;
    }
    const map = mapInstanceRef.current;
    const center: [number, number] = [lat || 11.3101, lng || 106.1074];
    map.setView(center, 17);
    if (markerRef.current) markerRef.current.remove();
    if (circleRef.current) circleRef.current.remove();
    const icon = L.divIcon({
      html: `<div style="background:#e11d48;width:20px;height:20px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4)"></div>`,
      className: "",
      iconAnchor: [10, 10],
    });
    markerRef.current = L.marker(center, { icon }).addTo(map).bindPopup("📍 Studio").openPopup();
    circleRef.current = L.circle(center, {
      radius: radius || 300,
      color: "#7c3aed",
      fillColor: "#7c3aed",
      fillOpacity: 0.12,
      weight: 2,
    }).addTo(map);
    return () => {};
  }, [lat, lng, radius]);

  useEffect(() => {
    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  return <div ref={mapRef} style={{ height: 280, borderRadius: "0.75rem", zIndex: 0 }} />;
}

function SoundSettingsCard() {
  const [settings, setLocal] = useState(getSoundSettings);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [eventSel, setEventSel] = useState<Record<string, string>>(() =>
    Object.fromEntries(SOUND_EVENTS.map((e) => [e.key, getEventSoundId(e.key)])),
  );
  const isIOS = typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
  const supportsVibration = typeof navigator !== "undefined" && !!navigator.vibrate && !isIOS;

  const update = (patch: Partial<ReturnType<typeof getSoundSettings>>) => {
    setSoundSettings(patch);
    setLocal(getSoundSettings());
  };

  const preview = (preset: RingtonePreset) => {
    setPlayingId(preset.id);
    previewRingtone(preset, settings.volume);
    setTimeout(() => setPlayingId(null), 600);
  };

  const pickForEvent = (ev: SoundEvent, preset: RingtonePreset) => {
    setEventSoundId(ev.key, preset.id);
    setEventSel((m) => ({ ...m, [ev.key]: preset.id }));
    if (preset.id !== "none") preview(preset);
  };

  return (
    <Card>
      <div className="p-6 border-b bg-muted/30">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <Volume2 className="w-5 h-5 text-primary" /> Âm thanh & Rung
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Chọn tiếng chuông và điều chỉnh âm lượng cho từng loại thông báo
        </p>
      </div>
      <CardContent className="p-6 space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-medium">Âm lượng chung</label>
          <div className="flex items-center gap-3">
            <VolumeX className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.volume}
              onChange={e => update({ volume: parseFloat(e.target.value) })}
              className="flex-1 h-2 accent-primary cursor-pointer"
            />
            <Volume2 className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground w-10 text-right">{Math.round(settings.volume * 100)}%</span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Vibrate className="w-4 h-4 text-muted-foreground" />
            <label className="text-sm font-medium">Rung</label>
          </div>
          <button
            onClick={() => update({ vibration: !settings.vibration })}
            disabled={!supportsVibration}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.vibration && supportsVibration ? "bg-primary" : "bg-muted-foreground/30"} ${!supportsVibration ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow ${settings.vibration && supportsVibration ? "translate-x-6" : "translate-x-1"}`} />
          </button>
          {isIOS ? (
            <p className="text-xs text-amber-600 dark:text-amber-500 flex items-start gap-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>iPhone/iPad <strong>không hỗ trợ rung qua trình duyệt</strong> (giới hạn của Apple). Tính năng này chỉ chạy trên Android.</span>
            </p>
          ) : !supportsVibration ? (
            <p className="text-xs text-muted-foreground">Trình duyệt/thiết bị này không hỗ trợ rung</p>
          ) : (
            <p className="text-xs text-muted-foreground">{settings.vibration ? "Bật — rung khi thao tác thành công" : "Tắt — không rung"}</p>
          )}
        </div>

        <div className="space-y-1">
          <p className="text-sm font-semibold">Âm thanh cho từng sự kiện</p>
          <p className="text-xs text-muted-foreground">Mỗi sự kiện chọn 1 tiếng riêng — nghe là biết ngay. Bấm vào tiếng để nghe thử &amp; chọn luôn.</p>
        </div>

        {SOUND_EVENTS.map((ev) => (
          <div key={ev.key} className="space-y-2 border-t pt-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <label className="text-sm font-medium">{ev.label}</label>
              {!ev.wired && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-500 border border-amber-200 dark:border-amber-800">chưa bật</span>
              )}
            </div>
            {ev.hint && <p className="text-xs text-muted-foreground -mt-1">{ev.hint}</p>}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-64 overflow-auto pr-1">
              {RINGTONE_LIBRARY.map((r) => (
                <button
                  key={r.id}
                  onClick={() => pickForEvent(ev, r)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-all ${eventSel[ev.key] === r.id ? "border-primary bg-primary/10 text-primary font-medium ring-1 ring-primary/30" : "border-border hover:border-primary/40 hover:bg-muted/50"}`}
                >
                  {r.id !== "none" ? (
                    <Play className={`w-3.5 h-3.5 shrink-0 ${playingId === r.id ? "text-primary animate-pulse" : "text-muted-foreground"}`} />
                  ) : (
                    <VolumeX className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{r.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Settings = {
  studioName: string;
  phone: string;
  email: string;
  address: string;
  taxCode: string | null;
  bankAccount: string | null;
  bankName: string | null;
  logoUrl: string | null;
  workingHours: string;
  defaultDeposit: number;
  studio_lat: number;
  studio_lng: number;
  attendance_radius_m: number;
  studio_wifi_name: string;
  studio_wifi_ips: string;
  aiPricingInfo: string | null;
};

type FbAiConfig = {
  hasPageAccessToken: boolean;
  hasOpenAiKey: boolean;
  hasVerifyToken: boolean;
  autoReplyEnabled: boolean;
  pageAccessTokenHint: string | null;
  openAiKeyHint: string | null;
  verifyTokenHint: string | null;
};

const token = () => localStorage.getItem("amazingStudioToken_v2");
const authH = () => ({
  "Content-Type": "application/json",
  ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
});

export default function SettingsPage() {
  const { isAdmin } = useStaffAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState<Partial<Settings>>({});
  const [saved, setSaved] = useState(false);
  const [fbPageAccessToken, setFbPageAccessToken] = useState("");
  const [fbVerifyToken, setFbVerifyToken] = useState("");
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [fbAutoReplyEnabled, setFbAutoReplyEnabled] = useState(false);
  const [fbSaved, setFbSaved] = useState(false);
  const [pageInfo, setPageInfo] = useState<{ pageId: string; pageName: string; fanCount?: number; picture?: string | null } | null>(null);
  const [pageInfoError, setPageInfoError] = useState("");
  const [showWebhookLog, setShowWebhookLog] = useState(false);

  const { data: settings, isLoading } = useQuery<Settings>({
    queryKey: ["settings"],
    queryFn: () => fetch(`${BASE}/api/settings`, { headers: authH() }).then(r => { if (!r.ok) throw new Error("Lỗi tải cài đặt"); return r.json(); }),
  });

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const { data: fbAiConfig } = useQuery<FbAiConfig>({
    queryKey: ["fb-ai-config"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/fb-ai/config`, { headers: authH() });
      if (!r.ok) throw new Error("Lỗi tải cấu hình Facebook AI");
      return r.json();
    },
  });

  const { data: aiKeyStatus } = useQuery<{ configured: boolean }>({
    queryKey: ["check-ai-key"],
    queryFn: () => fetch(`${BASE}/api/check-ai-key`, { headers: authH() }).then(r => r.json()),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (fbAiConfig) setFbAutoReplyEnabled(fbAiConfig.autoReplyEnabled);
  }, [fbAiConfig]);

  const saveMut = useMutation({
    mutationFn: async (body: Partial<Settings>) => {
      const r = await fetch(`${BASE}/api/settings`, { method: "PUT", headers: authH(), body: JSON.stringify(body) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as { error?: string }).error || "Lưu cài đặt thất bại"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  type WebhookEvent = { at: string; type: string; summary: string; psid?: string };
  const { data: webhookLog, refetch: refetchWebhookLog, isFetching: webhookLogFetching } = useQuery<{ events: WebhookEvent[]; total: number }>({
    queryKey: ["webhook-log"],
    queryFn: () => fetch(`${BASE}/api/fb-ai/webhook-log`, { headers: authH() }).then(r => r.json()),
    enabled: showWebhookLog,
    refetchInterval: showWebhookLog ? 5000 : false,
  });

  const [syncResult, setSyncResult] = useState<{ total: number; updated: number; failed: number; errors?: { psid: string; error: string }[] } | null>(null);
  const syncProfilesMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/fb-ai/sync-profiles`, { method: "POST", headers: authH() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Lỗi đồng bộ");
      return d as { total: number; updated: number; failed: number; errors?: { psid: string; error: string }[] };
    },
    onSuccess: (data) => setSyncResult(data),
    onError: () => setSyncResult(null),
  });

  const checkPageMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/fb-ai/page-info`, { headers: authH() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Lỗi kiểm tra fanpage");
      return d as { pageId: string; pageName: string; fanCount?: number; picture?: string | null };
    },
    onSuccess: (data) => { setPageInfo(data); setPageInfoError(""); },
    onError: (e: Error) => { setPageInfoError(e.message); setPageInfo(null); },
  });

  const subscribeWebhookMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/fb-ai/subscribe-webhook`, { method: "POST", headers: authH() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Đăng ký webhook thất bại");
      return d as { success: boolean; pageId: string; pageName: string };
    },
    onSuccess: (data) => { setPageInfo(p => p ? { ...p, pageId: data.pageId, pageName: data.pageName } : { pageId: data.pageId, pageName: data.pageName }); setPageInfoError(""); },
    onError: (e: Error) => { setPageInfoError(e.message); },
  });

  const saveFbMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/fb-ai/config`, {
        method: "PUT",
        headers: authH(),
        body: JSON.stringify({
          pageAccessToken: fbPageAccessToken || undefined,
          verifyToken: fbVerifyToken || undefined,
          openaiApiKey: openAiApiKey || undefined,
          autoReplyEnabled: fbAutoReplyEnabled,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Lưu cấu hình Facebook AI thất bại");
      }
      return r.json();
    },
    onSuccess: () => {
      setFbSaved(true);
      setTimeout(() => setFbSaved(false), 2500);
      qc.invalidateQueries({ queryKey: ["fb-ai-config"] });
      setFbPageAccessToken("");
      setFbVerifyToken("");
      setOpenAiApiKey("");
    },
  });

  const [backfillResult, setBackfillResult] = useState<{ updatedRows: number } | null>(null);
  const backfillMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/bookings/backfill-creator`, { method: "POST", headers: authH() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Lỗi backfill");
      return d as { message: string; updatedRows: number };
    },
    onSuccess: (data) => setBackfillResult(data),
    onError: () => setBackfillResult(null),
  });

  const f = (key: keyof Settings) => ({
    value: form[key] !== undefined ? String(form[key] ?? "") : "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [key]: e.target.value })),
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
      <Loader2 className="w-5 h-5 animate-spin mr-2" /> Đang tải...
    </div>
  );

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Cài đặt hệ thống</h1>
        <p className="text-muted-foreground mt-1">Cấu hình thông tin cơ bản cho studio của bạn</p>
      </div>

      {/* Studio Info */}
      <Card>
        <div className="p-6 border-b bg-muted/30">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Store className="w-5 h-5 text-primary" /> Thông tin Studio
          </h3>
        </div>
        <CardContent className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">Tên Studio</label>
              <Input {...f("studioName")} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2"><Phone className="w-4 h-4 text-muted-foreground" /> Hotline</label>
              <Input {...f("phone")} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2"><Mail className="w-4 h-4 text-muted-foreground" /> Email</label>
              <Input {...f("email")} type="email" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2"><Clock className="w-4 h-4 text-muted-foreground" /> Giờ làm việc</label>
              <Input {...f("workingHours")} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium flex items-center gap-2"><MapPin className="w-4 h-4 text-muted-foreground" /> Địa chỉ</label>
              <Input {...f("address")} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Financial */}
      <Card>
        <div className="p-6 border-b bg-muted/30">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Building className="w-5 h-5 text-primary" /> Thông tin Tài chính & Thuế
          </h3>
        </div>
        <CardContent className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">Mã số thuế</label>
              <Input {...f("taxCode")} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Mức cọc mặc định (%)</label>
              <CurrencyInput
                value={form.defaultDeposit !== undefined ? String(Math.round(form.defaultDeposit ?? 0) || "") : ""}
                onChange={raw => setForm(p => ({ ...p, defaultDeposit: parseFloat(raw) || 0 }))}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium">Tài khoản ngân hàng (Hiển thị trên báo giá)</label>
              <Textarea {...f("bankAccount")} rows={3} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Geofence / Attendance */}
      <Card>
        <div className="p-6 border-b bg-muted/30">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Navigation className="w-5 h-5 text-primary" /> Định vị chấm công (Geofence)
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Nhân viên chỉ được chấm công tại studio nếu GPS nằm trong bán kính cho phép.
          </p>
        </div>
        <CardContent className="p-6 space-y-6">
          {/* Auto-detect location button */}
          <GpsDetectButton
            onDetected={(lat, lng) => setForm(p => ({ ...p, studio_lat: lat, studio_lng: lng }))}
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">Vĩ độ Studio (Latitude)</label>
              <Input type="number" step="0.000001" {...f("studio_lat")} placeholder="11.3101" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Kinh độ Studio (Longitude)</label>
              <Input type="number" step="0.000001" {...f("studio_lng")} placeholder="106.1074" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Bán kính cho phép (mét)</label>
              <Input type="number" {...f("attendance_radius_m")} placeholder="300" />
            </div>
          </div>
          {(form.studio_lat || form.studio_lng) && (
            <div>
              <label className="text-sm font-medium block mb-2 flex items-center gap-2">
                <MapPin className="w-4 h-4 text-primary" /> Bản đồ vị trí Studio
              </label>
              <StudioMap
                lat={Number(form.studio_lat)}
                lng={Number(form.studio_lng)}
                radius={Number(form.attendance_radius_m) || 300}
              />
            </div>
          )}
          <div className="text-xs text-muted-foreground space-y-1">
            <p>💡 <strong>Cách đơn giản nhất:</strong> Mở trang này <em>tại tiệm</em>, bấm nút "Lấy vị trí hiện tại" → tọa độ tự động điền.</p>
            <p>📌 Hoặc mở Google Maps, nhấp chuột phải vào studio → chọn <em>"What's here?"</em> để thấy lat/lng.</p>
          </div>

          {/* WiFi studio — fallback khi GPS của nhân viên hỏng */}
          <div className="pt-6 border-t space-y-4">
            <div>
              <h4 className="text-base font-bold flex items-center gap-2">
                <Wifi className="w-4 h-4 text-primary" /> WiFi Studio (dự phòng khi GPS hỏng)
              </h4>
              <p className="text-sm text-muted-foreground mt-1">
                Nhân viên được chấm công nếu <strong>GPS đạt HOẶC đang nối WiFi studio</strong>. Trình duyệt không đọc được tên WiFi nên hệ thống xác thực bằng IP mạng của thiết bị.
              </p>
            </div>
            <WifiDetectButton
              onDetected={ip =>
                setForm(p => {
                  const cur = String(p.studio_wifi_ips ?? "");
                  const list = cur.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
                  if (list.includes(ip)) return p;
                  return { ...p, studio_wifi_ips: [...list, ip].join(", ") };
                })
              }
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">Tên WiFi (hiển thị)</label>
                <Input {...f("studio_wifi_name")} placeholder="Amazing Studio" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">IP mạng hợp lệ</label>
                <Input {...f("studio_wifi_ips")} placeholder="113.161.x.x, 192.168.1.*" />
                <p className="text-xs text-muted-foreground">Nhiều IP cách nhau dấu phẩy. Hỗ trợ IP chính xác, wildcard (192.168.1.*) hoặc CIDR (192.168.1.0/24). Để trống = tắt xác thực WiFi.</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* AI Assistant Status */}
      <Card>
        <div className="p-6 border-b bg-muted/30">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" /> Trợ lý AI nội bộ
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Trợ lý AI phân tích dữ liệu và hỗ trợ nhân viên trong ứng dụng.
          </p>
        </div>
        <CardContent className="p-6">
          <div className="flex items-center justify-between p-4 rounded-xl border bg-background">
            <div className="space-y-1">
              <p className="font-medium text-sm">ChatGPT (OpenAI) qua Replit AI Integrations</p>
              <p className="text-xs text-muted-foreground">Không cần nhập API key — tích hợp sẵn và tính phí qua Replit Credits.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {aiKeyStatus === undefined ? (
                <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Đang kiểm tra...</span>
              ) : aiKeyStatus.configured ? (
                <span className="flex items-center gap-1.5 text-sm font-medium text-green-700">
                  <CheckCircle2 className="w-4 h-4" /> Đã kết nối
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-sm font-medium text-red-600">
                  <AlertCircle className="w-4 h-4" /> Chưa kết nối
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* AI Pricing Info */}
      <Card>
        <div className="p-6 border-b bg-muted/30">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" /> Nội dung bảng giá / thông tin cho AI trả lời
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            AI sẽ đọc nội dung này để trả lời khách hàng qua Facebook Inbox. Paste nội dung từ trang báo giá của bạn vào đây.
          </p>
        </div>
        <CardContent className="p-6 space-y-4">
          <textarea
            className="w-full min-h-[280px] rounded-xl border border-border bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y font-mono"
            placeholder={`Ví dụ:\n\nGÓI CHỤP ẢNH CƯỚI:\n- Gói Studio Cơ Bản: 5.500.000đ — Chụp tại studio, 1 bộ váy, makeup, 40 ảnh chỉnh sửa\n- Gói Ngoại Cảnh: 8.500.000đ — 2 địa điểm, 2 bộ váy, makeup, 80 ảnh\n- Gói Premium: 15.000.000đ — Trọn gói A-Z, album, ảnh phóng\n\nCHO THUÊ VÁY CƯỚI:\n- Váy ngắn từ 500.000đ/ngày\n- Váy dài từ 800.000đ/ngày\n- Váy cao cấp từ 2.000.000đ/ngày\n\nLIÊN HỆ: 0901 234 567`}
            {...f("aiPricingInfo")}
          />
          <p className="text-xs text-muted-foreground">
            Nội dung này sẽ được đưa vào prompt AI khi trả lời khách qua Facebook. Bạn có thể nhập bảng giá, chính sách đặt cọc, thời gian làm việc, địa chỉ và bất kỳ thông tin nào muốn AI biết.
          </p>
        </CardContent>
      </Card>

      {/* Facebook + ChatGPT */}
      <Card>
        <div className="p-6 border-b bg-muted/30">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" /> Cấu hình Facebook Fanpage + ChatGPT
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Dành cho mô-đun Inbox Facebook AI. Có thể bàn giao cho khách tự thiết lập.
          </p>
        </div>
        <CardContent className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Facebook Page Access Token</label>
              <Input
                type="password"
                value={fbPageAccessToken}
                onChange={(e) => setFbPageAccessToken(e.target.value)}
                placeholder={fbAiConfig?.pageAccessTokenHint ? `Đang dùng: ${fbAiConfig.pageAccessTokenHint}` : "Chưa có — nhập token mới"}
              />
              {fbAiConfig?.pageAccessTokenHint && (
                <p className="text-xs text-muted-foreground">Hiện tại: <code className="bg-muted px-1 rounded">{fbAiConfig.pageAccessTokenHint}</code> — nhập token mới để thay thế, bỏ trống để giữ nguyên</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Webhook Verify Token</label>
              <Input
                value={fbVerifyToken}
                onChange={(e) => setFbVerifyToken(e.target.value)}
                placeholder={fbAiConfig?.verifyTokenHint ? `Đang dùng: ${fbAiConfig.verifyTokenHint}` : "Ví dụ: amazing-studio-verify-2026"}
              />
              {fbAiConfig?.verifyTokenHint && (
                <p className="text-xs text-muted-foreground">Hiện tại: <code className="bg-muted px-1 rounded">{fbAiConfig.verifyTokenHint}</code></p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">OpenAI API Key</label>
              <Input
                type="password"
                value={openAiApiKey}
                onChange={(e) => setOpenAiApiKey(e.target.value)}
                placeholder={fbAiConfig?.openAiKeyHint ? `Đang dùng: ${fbAiConfig.openAiKeyHint}` : "sk-..."}
              />
              {fbAiConfig?.openAiKeyHint && (
                <p className="text-xs text-muted-foreground">Hiện tại: <code className="bg-muted px-1 rounded">{fbAiConfig.openAiKeyHint}</code> — nhập key mới để thay thế</p>
              )}
            </div>
          </div>

          <label className="text-sm font-medium flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={fbAutoReplyEnabled}
              onChange={(e) => setFbAutoReplyEnabled(e.target.checked)}
              className="rounded"
            />
            Bật tự động trả lời (AI chỉ tự gửi khi đúng kịch bản, ngoài phạm vi sẽ để nhân viên xử lý)
          </label>

          <div className="text-xs text-muted-foreground space-y-1 rounded-xl border p-3">
            <p>
              Trạng thái hiện tại: FB Token <strong className={fbAiConfig?.hasPageAccessToken ? "text-green-600" : "text-red-500"}>{fbAiConfig?.hasPageAccessToken ? "✓ OK" : "✗ Thiếu"}</strong> | Verify Token <strong className={fbAiConfig?.hasVerifyToken ? "text-green-600" : "text-red-500"}>{fbAiConfig?.hasVerifyToken ? "✓ OK" : "✗ Thiếu"}</strong> | OpenAI <strong className={fbAiConfig?.hasOpenAiKey ? "text-green-600" : "text-red-500"}>{fbAiConfig?.hasOpenAiKey ? "✓ OK" : "✗ Thiếu"}</strong> | Auto <strong>{fbAiConfig?.autoReplyEnabled ? "Bật" : "Tắt"}</strong>
            </p>
          </div>

          {/* Fanpage Info + Subscribe */}
          <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
            <p className="text-sm font-semibold flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" /> Fanpage đang kết nối
            </p>
            {pageInfo && (
              <div className="flex items-center gap-3 p-3 bg-green-50 dark:bg-green-900/20 rounded-xl border border-green-200 dark:border-green-800">
                {pageInfo.picture && <img src={pageInfo.picture} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />}
                <div>
                  <p className="font-semibold text-sm text-green-800 dark:text-green-300">{pageInfo.pageName}</p>
                  <p className="text-xs text-green-700 dark:text-green-400">ID: {pageInfo.pageId}{pageInfo.fanCount ? ` · ${pageInfo.fanCount.toLocaleString("vi-VN")} người theo dõi` : ""}</p>
                </div>
              </div>
            )}
            {pageInfoError && <p className="text-sm text-red-600">{pageInfoError}</p>}
            {subscribeWebhookMut.isSuccess && (
              <p className="text-sm text-green-600 font-medium">✓ Đã đăng ký webhook thành công cho fanpage: {subscribeWebhookMut.data?.pageName}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="gap-2" onClick={() => checkPageMut.mutate()} disabled={checkPageMut.isPending || !fbAiConfig?.hasPageAccessToken}>
                {checkPageMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}
                Kiểm tra Fanpage hiện tại
              </Button>
              <Button size="sm" className="gap-2 bg-blue-600 hover:bg-blue-700 text-white" onClick={() => subscribeWebhookMut.mutate()} disabled={subscribeWebhookMut.isPending || !fbAiConfig?.hasPageAccessToken}>
                {subscribeWebhookMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Kết nối Fanpage mới (đăng ký webhook)
              </Button>
              <Button variant="outline" size="sm" className="gap-2 border-orange-300 text-orange-700 hover:bg-orange-50" onClick={() => syncProfilesMut.mutate()} disabled={syncProfilesMut.isPending || !fbAiConfig?.hasPageAccessToken}>
                {syncProfilesMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Đồng bộ tên + ảnh Facebook
              </Button>
            </div>
            {syncResult && syncResult.updated > 0 && (
              <p className="text-sm text-green-600 font-medium">✓ Đồng bộ xong: {syncResult.updated}/{syncResult.total} khách đã cập nhật tên thật</p>
            )}
            {syncResult && syncResult.failed > 0 && syncResult.errors && syncResult.errors.length > 0 && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 p-3 space-y-1">
                <p className="text-sm font-semibold text-red-700">❌ {syncResult.failed} lỗi từ Facebook API:</p>
                {[...new Set(syncResult.errors.map(e => e.error))].map((errMsg, i) => (
                  <p key={i} className="text-xs text-red-600 font-mono">{errMsg}</p>
                ))}
                {syncResult.errors.some(e => e.error.includes("permission") || e.error.includes("(#10)") || e.error.includes("(#200)")) && (
                  <p className="text-xs text-red-700 mt-1 font-medium">→ App Facebook chưa được cấp quyền <code>pages_messaging</code>. Vào Meta Developer → App Review → yêu cầu quyền này.</p>
                )}
                {syncResult.errors.some(e => e.error.includes("Development") || e.error.includes("development")) && (
                  <p className="text-xs text-red-700 mt-1 font-medium">→ App đang ở chế độ Development. Đổi sang Live Mode để đọc tên khách thật.</p>
                )}
              </div>
            )}
            {syncProfilesMut.isError && (
              <p className="text-sm text-red-600">{(syncProfilesMut.error as Error).message}</p>
            )}
            <p className="text-xs text-muted-foreground">Sau khi lưu Page Access Token của Fanpage mới, nhấn <strong>"Kết nối Fanpage mới"</strong> để đăng ký nhận tin nhắn từ fanpage đó. Nếu không nhấn, hệ thống vẫn nhận tin từ fanpage cũ.</p>
          </div>

          {/* Save button inside the card */}
          <div className="flex items-center gap-3 pt-2 border-t border-border">
            {fbSaved && <span className="text-sm text-green-600 font-medium">✓ Đã lưu cấu hình Facebook AI</span>}
            {saveFbMut.isError && <span className="text-sm text-red-600 font-medium">{(saveFbMut.error as Error).message}</span>}
            <a
              href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/ai-sale-scripts`}
              className="ml-auto flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <Bot className="w-4 h-4" /> Quản lý kịch bản sale AI →
            </a>
            <Button
              className="gap-2"
              onClick={() => saveFbMut.mutate()}
              disabled={saveFbMut.isPending}
            >
              {saveFbMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
              Lưu cấu hình Facebook + ChatGPT
            </Button>
          </div>

          {/* Webhook Debug Log */}
          <div className="rounded-xl border border-border bg-muted/10 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold flex items-center gap-2">
                <Bot className="w-4 h-4 text-primary" /> Debug: Log sự kiện webhook ({webhookLog?.total ?? 0} sự kiện)
              </p>
              <div className="flex gap-2">
                {showWebhookLog && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => refetchWebhookLog()} disabled={webhookLogFetching}>
                    {webhookLogFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : "↻ Refresh"}
                  </Button>
                )}
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowWebhookLog(v => !v)}>
                  {showWebhookLog ? "Ẩn log" : "Xem log webhook"}
                </Button>
              </div>
            </div>
            {showWebhookLog && (
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {!webhookLog || webhookLog.events.length === 0 ? (
                  <div className="rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3 text-sm text-yellow-800 dark:text-yellow-300">
                    <strong>⚠️ Chưa có sự kiện nào từ Facebook!</strong><br />
                    Facebook chưa gửi bất kỳ request nào vào webhook này. Hãy kiểm tra các nguyên nhân bên dưới.
                  </div>
                ) : (
                  webhookLog.events.map((ev, i) => (
                    <div key={i} className={`text-xs rounded px-2 py-1 font-mono ${ev.type === "message" ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300" : ev.type === "error" ? "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300" : ev.type === "verification" ? "bg-blue-50 text-blue-800 dark:bg-blue-900/20 dark:text-blue-300" : "bg-muted text-foreground"}`}>
                      <span className="opacity-60">{ev.at.slice(0, 19).replace("T", " ")}</span> {ev.summary}
                    </div>
                  ))
                )}
              </div>
            )}
            {showWebhookLog && webhookLog?.events.length === 0 && (
              <div className="text-xs space-y-1 p-3 rounded-lg bg-muted border border-border text-muted-foreground">
                <p className="font-semibold text-foreground">Checklist kiểm tra khi không nhận được tin nhắn:</p>
                <p>1. <strong>App Facebook đang ở chế độ Development?</strong> → Vào Meta Developer → App Settings → đổi sang <em>Live Mode</em></p>
                <p>2. <strong>Webhook URL đã được verify trên Meta Developer?</strong> → Messenger → Webhooks → thêm URL: <code className="text-xs bg-muted-foreground/20 px-1 rounded">{window.location.origin.replace("24230", "8080")}/api/webhook/facebook</code></p>
                <p>3. <strong>Đã subscribe sự kiện <code>messages</code>?</strong> → Trong Webhooks, bấm "Edit" và chọn messages, messaging_postbacks</p>
                <p>4. <strong>Verify Token đúng chưa?</strong> → Phải khớp giữa Meta Developer và ô "Webhook Verify Token" ở trên</p>
                <p>5. <strong>Fanpage đã được kết nối app chưa?</strong> → Messenger → Cài đặt → Thêm trang → chọn đúng Fanpage</p>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-dashed p-4 text-sm space-y-2">
            <p className="font-semibold flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" /> Hướng dẫn bàn giao cho khách tự setup
            </p>
            <p><strong>Bước 1:</strong> Tạo Meta App, thêm Messenger, kết nối Fanpage cần dùng.</p>
            <p><strong>Bước 2:</strong> Lấy <em>Page Access Token</em> dán vào ô tương ứng ở trên.</p>
            <p><strong>Bước 3:</strong> Tạo chuỗi bí mật cho <em>Webhook Verify Token</em> (ví dụ `studio-verify-2026`) và lưu vào đây.</p>
            <p><strong>Bước 4:</strong> Trên Meta Developer, cấu hình Webhook URL: <code>{window.location.origin}{BASE}/api/webhook/facebook</code> và Verify Token giống bước 3.</p>
            <p><strong>Bước 5:</strong> Subscribe ít nhất các event: <code>messages</code>, <code>messaging_postbacks</code>.</p>
            <p><strong>Bước 6:</strong> Tạo OpenAI API key và dán vào ô OpenAI API Key.</p>
            <p><strong>Bước 7:</strong> Bật Auto Reply nếu muốn tự động trả lời, sau đó vào tab Inbox Facebook AI để theo dõi và xử lý ngoại lệ.</p>
          </div>
        </CardContent>
      </Card>

      <SoundSettingsCard />

      {/* Admin Tools — admin only */}
      {isAdmin && <Card>
        <div className="p-6 border-b bg-muted/30">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Wrench className="w-5 h-5 text-primary" /> Công cụ Admin
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Các thao tác quản trị hệ thống — chỉ admin mới thấy tác dụng.
          </p>
        </div>
        <CardContent className="p-6 space-y-4">
          <div className="rounded-xl border p-4 space-y-3">
            <div>
              <p className="font-medium text-sm">Gắn màu lịch cho booking cũ</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Các booking tạo trước khi cập nhật hệ thống chưa có thông tin người tạo → màu lịch hiển thị ngẫu nhiên.
                Nhấn nút này để tự động điền người tạo dựa trên lịch sử thay đổi sớm nhất của từng booking.
                An toàn khi chạy lại nhiều lần — chỉ cập nhật những booking còn thiếu thông tin.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => { setBackfillResult(null); backfillMut.mutate(); }}
                disabled={backfillMut.isPending}
              >
                {backfillMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                Backfill người tạo booking
              </Button>
              {backfillResult && (
                <span className="flex items-center gap-1.5 text-sm text-green-700">
                  <CheckCircle2 className="w-4 h-4" />
                  Đã cập nhật {backfillResult.updatedRows} booking
                </span>
              )}
              {backfillMut.isError && (
                <span className="flex items-center gap-1.5 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4" />
                  {(backfillMut.error as Error).message}
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>}

      <div className="flex justify-end gap-3 items-center">
        {saved && <span className="text-sm text-green-600 font-medium">✓ Đã lưu thay đổi</span>}
        {saveMut.isError && <span className="text-sm text-red-600 font-medium">{(saveMut.error as Error).message}</span>}
        <Button size="lg" className="gap-2 px-8" onClick={() => saveMut.mutate(form)} disabled={saveMut.isPending}>
          {saveMut.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
          Lưu thay đổi
        </Button>
      </div>
    </div>
  );
}
