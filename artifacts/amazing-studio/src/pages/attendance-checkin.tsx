import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Building2, Loader2, LogOut, MapPin, Wifi } from "lucide-react";
import { AttendanceEncouragementModal } from "@/components/AttendanceEncouragementModal";
import { OffsiteCheckInDialog } from "@/components/OffsiteCheckInDialog";
import { uploadFileViaPresign } from "@/components/cms-shared";
import type { PunchFeedback } from "@/lib/attendance-messages";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Status = "loading" | "ready" | "sending" | "success" | "error";

type TodayAttendance = {
  todayMode?: "SHOW" | "STUDIO" | "OFF";
  todayBookings?: Array<{ id: number; customerName: string | null; serviceLabel: string | null; packageType: string | null }>;
};

type GpsState = "checking" | "ok" | "out" | "fail";
type WifiState = "checking" | "ok" | "no" | "unconfigured";

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function AttendanceCheckinPage() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState("");
  const [checkedIn, setCheckedIn] = useState(false);
  const [checkInMode, setCheckInMode] = useState<"studio" | "offsite" | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [showOffsiteDialog, setShowOffsiteDialog] = useState(false);
  const [offsiteSaving, setOffsiteSaving] = useState(false);
  const [encourageOpen, setEncourageOpen] = useState(false);
  const [encourageFeedback, setEncourageFeedback] = useState<PunchFeedback | null>(null);
  const [todayMode, setTodayMode] = useState<"SHOW" | "STUDIO" | "OFF" | null>(null);
  const [todayBookings, setTodayBookings] = useState<TodayAttendance["todayBookings"]>([]);
  const [gpsState, setGpsState] = useState<GpsState>("checking");
  const [wifiState, setWifiState] = useState<WifiState>("checking");

  useEffect(() => {
    const token = localStorage.getItem("amazingStudioToken_v2");
    const month = new Date().toISOString().slice(0, 7);
    fetch(`${BASE}/api/attendance/me?month=${month}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: TodayAttendance | null) => {
        if (data?.todayMode) setTodayMode(data.todayMode);
        if (data?.todayBookings) setTodayBookings(data.todayBookings);
      })
      .catch(() => {})
      .finally(() => setStatus("ready"));
  }, []);

  // Kiểm tra trạng thái WiFi studio (server đối chiếu IP) + GPS (so với geofence)
  useEffect(() => {
    const token = localStorage.getItem("amazingStudioToken_v2");
    fetch(`${BASE}/api/attendance/wifi-status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.ok ? r.json() : null)
      .then((d: { configured?: boolean; verified?: boolean } | null) => {
        if (!d || !d.configured) setWifiState("unconfigured");
        else setWifiState(d.verified ? "ok" : "no");
      })
      .catch(() => setWifiState("unconfigured"));

    if (!navigator.geolocation) {
      setGpsState("fail");
      return;
    }
    fetch(`${BASE}/api/attendance/studio-info`)
      .then(r => r.json())
      .then((info: { lat: number; lng: number; radius: number }) => {
        navigator.geolocation.getCurrentPosition(
          pos => {
            const d = distanceMeters(pos.coords.latitude, pos.coords.longitude, info.lat, info.lng);
            setGpsState(d <= (info.radius || 300) ? "ok" : "out");
          },
          () => setGpsState("fail"),
          { timeout: 12000, enableHighAccuracy: true },
        );
      })
      .catch(() => setGpsState("fail"));
  }, []);

  const authHeaders = () => {
    const token = localStorage.getItem("amazingStudioToken_v2");
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  };

  const submitPunch = async (
    type: "check_in" | "check_out",
    lat: number | undefined,
    lng: number | undefined,
    mode?: "studio" | "offsite",
    extra?: { checkinPhotoUrl?: string; notes?: string },
  ) => {
    const endpoint = type === "check_in" ? "/api/attendance/check-in" : "/api/attendance/check-out";
    const coords = lat !== undefined && lng !== undefined ? { lat, lng } : {};
    const body =
      type === "check_in"
        ? {
            ...coords,
            workType: mode === "offsite" ? "di_show" : "studio",
            ...(extra?.checkinPhotoUrl ? { checkinPhotoUrl: extra.checkinPhotoUrl } : {}),
            ...(extra?.notes ? { notes: extra.notes } : {}),
          }
        : coords;

    setStatus("sending");
    try {
      const res = await fetch(`${BASE}${endpoint}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        error?: string;
        message?: string;
        time?: string;
        feedback?: PunchFeedback;
        createdAt?: string;
        method?: string;
      };

      if (!res.ok) {
        if (type === "check_in" && json.error?.includes("Bạn đã check-in")) {
          setStatus("ready");
          setCheckedIn(true);
          setMessage("Bạn đã chấm vào rồi");
          setDetail("Có thể chấm ra bây giờ");
          return;
        }
        setStatus("error");
        setMessage(json.error ?? "Chấm công thất bại");
        setDetail(`(Lỗi ${res.status})`);
        return;
      }

      if (json.feedback?.messageKey) {
        setEncourageFeedback(json.feedback);
        setEncourageOpen(true);
        setStatus("ready");
        setMessage("");
        setDetail("");
      } else {
        setStatus("success");
        setMessage(
          json.message ?? (type === "check_in" ? "Chấm vào thành công!" : "Chấm ra thành công!"),
        );
        const timeText = `Thời gian: ${json.time ?? new Date().toLocaleTimeString("vi-VN")}`;
        setDetail(json.method === "wifi" ? `Đã xác nhận có mặt tại studio qua WiFi. ${timeText}` : timeText);
      }
      if (type === "check_in") {
        setCheckedIn(true);
      } else {
        setCheckedIn(false);
        setCheckInMode(null);
      }
    } catch (e: unknown) {
      setStatus("error");
      setMessage("Lỗi kết nối máy chủ");
      setDetail((e as Error)?.message ?? "");
    }
  };

  const confirmOffsiteCheckIn = async ({ file, notes }: { file: File; notes: string }) => {
    setOffsiteSaving(true);
    setMessage("");
    setDetail("");
    try {
      const photoUrl = await uploadFileViaPresign(file, file.name || "selfie.jpg", file.type || "image/jpeg");
      if (!navigator.geolocation) throw new Error("Trình duyệt không hỗ trợ GPS");
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 15000, enableHighAccuracy: true }),
      );
      setCheckInMode("offsite");
      setShowOffsiteDialog(false);
      await submitPunch("check_in", pos.coords.latitude, pos.coords.longitude, "offsite", {
        checkinPhotoUrl: photoUrl,
        notes: notes || undefined,
      });
    } catch (e: unknown) {
      setStatus("error");
      setMessage((e as Error)?.message ?? "Không đăng ký được Show ngoài");
      setDetail("");
    } finally {
      setOffsiteSaving(false);
    }
  };

  const startPunch = async (type: "check_in" | "check_out", mode?: "studio" | "offsite") => {
    if (type === "check_in" && mode) setCheckInMode(mode);
    setGeoLoading(true);
    setStatus("sending");
    setMessage("");
    setDetail("");

    // GPS hỏng/không có quyền → vẫn gửi không kèm toạ độ; server sẽ kiểm tra WiFi studio (GPS pass OR WiFi pass)
    if (!navigator.geolocation) {
      void submitPunch(type, undefined, undefined, mode);
      setGeoLoading(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      pos => {
        setGeoLoading(false);
        void submitPunch(type, pos.coords.latitude, pos.coords.longitude, mode);
      },
      () => {
        setGeoLoading(false);
        void submitPunch(type, undefined, undefined, mode);
      },
      { timeout: 15000, enableHighAccuracy: true },
    );
  };

  return (
    <div className="flex items-center justify-center py-16 px-4 min-h-screen">
      <div className="w-full max-w-sm">

        {todayMode === "SHOW" && (
          <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-left">
            <p className="text-sm font-semibold text-sky-900">📍 Show Day — không cần chấm 08:00 tại studio</p>
            <p className="text-xs text-sky-800 mt-1">Anh có lịch chụp hôm nay. Chọn <strong>Đi Show ngoài</strong> (GPS + selfie) tại địa điểm khách.</p>
            {todayBookings && todayBookings.length > 0 && (
              <ul className="mt-2 text-xs text-sky-800 space-y-0.5">
                {todayBookings.slice(0, 3).map(b => (
                  <li key={b.id}>• {b.customerName ?? "Khách"} — {b.serviceLabel ?? b.packageType ?? "Show"}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-rose-400 to-purple-600 rounded-2xl shadow-xl mb-4">
            <span className="text-2xl">📸</span>
          </div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-rose-600 to-purple-600 bg-clip-text text-transparent">
            Amazing Studio
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Chấm công</p>
        </div>

        {status === "loading" ? (
          <div className="rounded-2xl shadow-lg border p-8 text-center bg-muted/30">
            <div className="text-4xl mb-4 animate-pulse">⏳</div>
            <p className="text-lg font-semibold text-muted-foreground">Đang tải...</p>
          </div>
        ) : status === "ready" ? (
          <>
            <div className="rounded-2xl shadow-lg border p-8 text-center mb-4 bg-blue-50">
              <div className="text-4xl mb-3">{checkedIn ? "✅" : "👤"}</div>
              <p className="text-lg font-semibold text-blue-700">
                {checkedIn ? "Đã chấm vào hôm nay" : "Chưa chấm vào hôm nay"}
              </p>
            </div>

            {/* Trạng thái xác thực: GPS pass OR WiFi pass là được chấm công */}
            <div className="rounded-xl border bg-white/70 px-4 py-3 mb-6 text-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-muted-foreground"><MapPin className="w-4 h-4" /> Định vị</span>
                {gpsState === "checking" ? (
                  <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang kiểm tra…</span>
                ) : gpsState === "ok" ? (
                  <span className="font-medium text-green-700">Đạt ✓</span>
                ) : (
                  <span className="font-medium text-red-600">{gpsState === "out" ? "Ngoài vùng studio" : "Không đạt"}</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-muted-foreground"><Wifi className="w-4 h-4" /> WiFi Studio</span>
                {wifiState === "checking" ? (
                  <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang kiểm tra…</span>
                ) : wifiState === "ok" ? (
                  <span className="font-medium text-green-700">Đạt ✓</span>
                ) : wifiState === "unconfigured" ? (
                  <span className="text-muted-foreground">Chưa cấu hình</span>
                ) : (
                  <span className="font-medium text-red-600">Không đạt</span>
                )}
              </div>
              {gpsState !== "checking" && wifiState !== "checking" && (
                <div className="flex items-center justify-between border-t pt-1.5 mt-1.5">
                  <span className="text-muted-foreground">Kết quả</span>
                  {gpsState === "ok" || wifiState === "ok" ? (
                    <span className="font-semibold text-green-700">Được phép chấm công</span>
                  ) : (
                    <span className="font-semibold text-red-600">Không được phép chấm công</span>
                  )}
                </div>
              )}
              {gpsState !== "ok" && gpsState !== "checking" && wifiState === "ok" && (
                <p className="text-xs text-green-700 pt-0.5">Đã xác nhận có mặt tại studio qua WiFi.</p>
              )}
            </div>

            {!checkedIn ? (
              <div className="grid gap-3 mb-3">
                <button
                  type="button"
                  onClick={() => void startPunch("check_in", "studio")}
                  disabled={geoLoading || offsiteSaving}
                  className="p-4 rounded-xl border-2 border-blue-300 bg-blue-50 text-left hover:bg-blue-100 disabled:opacity-50"
                >
                  <div className="flex items-center gap-2 font-bold text-blue-800">
                    <Building2 className="w-5 h-5" /> Tại Studio
                    {geoLoading && checkInMode === "studio" && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
                  </div>
                  <p className="text-xs text-blue-700 mt-1 pl-7">Dùng khi làm việc tại tiệm / studio.</p>
                </button>
                <button
                  type="button"
                  onClick={() => setShowOffsiteDialog(true)}
                  disabled={geoLoading}
                  className="p-4 rounded-xl border-2 border-amber-300 bg-amber-50 text-left hover:bg-amber-100 disabled:opacity-50"
                >
                  <div className="flex items-center gap-2 font-bold text-amber-900">
                    <MapPin className="w-5 h-5" /> Đi Show ngoài
                    {(offsiteSaving || (geoLoading && checkInMode === "offsite")) && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
                  </div>
                  <p className="text-xs text-amber-800 mt-1 pl-7">Dùng khi làm việc ngoài studio (chụp, trang điểm, giao đồ, gặp khách...).</p>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void startPunch("check_out")}
                disabled={geoLoading}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 mb-3 bg-gradient-to-r from-orange-500 to-amber-600 text-white rounded-xl font-semibold shadow-md disabled:opacity-60"
              >
                {geoLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogOut className="w-5 h-5" />}
                {geoLoading
                  ? "Đang lấy GPS…"
                  : checkInMode === "offsite"
                    ? "Kết thúc Show ngoài"
                    : "Ra ngoài Studio"}
              </button>
            )}

            <button
              type="button"
              onClick={() => setLocation("/attendance")}
              className="w-full py-2.5 px-4 border border-border rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-all"
            >
              Về trang chấm công
            </button>
          </>
        ) : (
          <>
            <div
              className={`rounded-2xl shadow-lg border p-8 text-center ${
                status === "success" ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
              }`}
            >
              <div className="text-4xl mb-3">{status === "success" ? "✅" : "❌"}</div>
              <p className={`text-lg font-semibold ${status === "success" ? "text-green-700" : "text-red-700"}`}>
                {message}
              </p>
              {detail && <p className="text-sm mt-2 text-muted-foreground">{detail}</p>}
            </div>
            <button
              type="button"
              onClick={() => {
                setStatus("ready");
                setMessage("");
                setDetail("");
              }}
              className="w-full mt-4 py-2.5 px-4 border border-border rounded-xl text-sm font-medium hover:bg-muted/50"
            >
              Thử lại
            </button>
          </>
        )}
      </div>

      <OffsiteCheckInDialog
        open={showOffsiteDialog}
        saving={offsiteSaving}
        onClose={() => { if (!offsiteSaving) setShowOffsiteDialog(false); }}
        onConfirm={confirmOffsiteCheckIn}
      />

      <AttendanceEncouragementModal
        open={encourageOpen}
        onOpenChange={setEncourageOpen}
        feedback={encourageFeedback}
      />
    </div>
  );
}
