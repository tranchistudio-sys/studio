let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  try {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function playTone(frequency: number, duration: number, volume: number, type: OscillatorType = "sine", delay = 0) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, ctx.currentTime + delay);
  gain.gain.setValueAtTime(0, ctx.currentTime + delay);
  gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + delay + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime + delay);
  osc.stop(ctx.currentTime + delay + duration);
}


const APP_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const LINDA_SOUNDS = {
  orderSuccess: `${APP_BASE}/sounds/linda/chu-ye.mp3`,
  error: `${APP_BASE}/sounds/linda/bo-keu.mp3`,
  payment: `${APP_BASE}/sounds/linda/tra-tien.mp3`,
} as const;

const mp3Pool = new Map<string, HTMLAudioElement>();
let activeMp3Stop: (() => void) | null = null;

function playMp3(src: string, opts?: { maxMs?: number; volume?: number; startAt?: number }) {
  try {
    const vol = opts?.volume ?? getSoundSettings().volume;
    if (vol <= 0) return;
    activeMp3Stop?.();
    activeMp3Stop = null;

    let audio = mp3Pool.get(src);
    if (!audio) {
      audio = new Audio(src);
      audio.preload = "auto";
      mp3Pool.set(src, audio);
    }

    audio.volume = Math.max(0, Math.min(1, vol));
    audio.currentTime = opts?.startAt ?? 0;
    const playPromise = audio.play();
    playPromise?.catch(() => {});

    const maxMs = opts?.maxMs ?? 0;
    if (maxMs > 0) {
      const stop = () => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch { /* ignore */ }
      };
      const timer = window.setTimeout(stop, maxMs);
      const onEnd = () => {
        window.clearTimeout(timer);
        audio.removeEventListener("ended", onEnd);
        if (activeMp3Stop === stop) activeMp3Stop = null;
      };
      audio.addEventListener("ended", onEnd);
      activeMp3Stop = stop;
    }
  } catch { /* ignore */ }
}

export interface RingtonePreset {
  id: string;
  label: string;
  play: (vol: number) => void;
}

// ── Âm thanh mp3 tùy chỉnh của studio (đặt trong public/sounds/custom/) ──
// Thêm âm thanh mới: bỏ file .mp3 vào folder đó rồi thêm 1 dòng {id,label,file} vào mảng dưới.
// Tất cả quản lý 1 nơi: Cài đặt → Âm thanh & Rung (dùng được cho mọi sự kiện).
const CUSTOM_SOUND_DIR = `${APP_BASE}/sounds/custom`;
const CUSTOM_SOUNDS: { id: string; label: string; file: string }[] = [
  { id: "custom-an-ui", label: "AN UI", file: "an-ui.mp3" },
  { id: "custom-cai-gi-co", label: "CAI GI CO", file: "cai-gi-co.mp3" },
  { id: "custom-chan-1", label: "chan 1", file: "chan-1.mp3" },
  { id: "custom-cho-1ti", label: "CHO 1TI", file: "cho-1ti.mp3" },
  { id: "custom-chong-mat-nhuc-au-xoay-tron-chuyen-canh", label: "chong măt nhuc đầu xoay tròn chuyển cảnh", file: "chong-mat-nhuc-au-xoay-tron-chuyen-canh.mp3" },
  { id: "custom-chu-y-2", label: "CHU Y 2", file: "chu-y-2.mp3" },
  { id: "custom-chu-ye", label: "CHU YE", file: "chu-ye.mp3" },
  { id: "custom-cuoi-sac-sua", label: "CUOI SAC SUA", file: "cuoi-sac-sua.mp3" },
  { id: "custom-cai-gi-co-2", label: "CÁI GI CO", file: "cai-gi-co-2.mp3" },
  { id: "custom-dam-vo-mat", label: "DAM VO MAT", file: "dam-vo-mat.mp3" },
  { id: "custom-dragon-studio-simple-whoosh-382724", label: "dragon studio simple whoosh 382724", file: "dragon-studio-simple-whoosh-382724.mp3" },
  { id: "custom-dragon-studio-whoosh-cinematic-376875", label: "dragon studio whoosh cinematic 376875", file: "dragon-studio-whoosh-cinematic-376875.mp3" },
  { id: "custom-dragon-studio-whoosh-cinematic-sound-effect-376889", label: "dragon studio whoosh cinematic sound effect 376889", file: "dragon-studio-whoosh-cinematic-sound-effect-376889.mp3" },
  { id: "custom-dragon-studio-whoosh-effect-382717", label: "dragon studio whoosh effect 382717", file: "dragon-studio-whoosh-effect-382717.mp3" },
  { id: "custom-dry-fart", label: "dry fart", file: "dry-fart.mp3" },
  { id: "custom-goi-goi-toi-cong-chuyen-1", label: "goi goi toi cong chuyen (1)", file: "goi-goi-toi-cong-chuyen-1.mp3" },
  { id: "custom-kha-banh-ao-that-day", label: "kha banh ao that day", file: "kha-banh-ao-that-day.mp3" },
  { id: "custom-kho-hieu", label: "KHO HIEU", file: "kho-hieu.mp3" },
  { id: "custom-lang-man", label: "LANG MAN", file: "lang-man.mp3" },
  { id: "custom-linda-jz-ma", label: "linda jz ma", file: "linda-jz-ma.mp3" },
  { id: "custom-linda-oi-j-z-troi", label: "linda oi j z troi", file: "linda-oi-j-z-troi.mp3" },
  { id: "custom-linda-xin-chao-tro-lai", label: "linda xin chao tro lai", file: "linda-xin-chao-tro-lai.mp3" },
  { id: "custom-ma-thuat", label: "MA THUAT", file: "ma-thuat.mp3" },
  { id: "custom-may-anh", label: "MAY ANH", file: "may-anh.mp3" },
  { id: "custom-miraclei-tiktok-slide-ping1-sample-kofi-by-miraclei-360035", label: "miraclei tiktok slide ping1 sample kofi by miraclei 360035", file: "miraclei-tiktok-slide-ping1-sample-kofi-by-miraclei-360035.mp3" },
  { id: "custom-oi-gioi-oi", label: "OI GIOI OI", file: "oi-gioi-oi.mp3" },
  { id: "custom-sad-meow-song", label: "sad meow song", file: "sad-meow-song.mp3" },
  { id: "custom-tieng-chuong-tinh-tao", label: "TIENG CHUONG TINH TAO", file: "tieng-chuong-tinh-tao.mp3" },
  { id: "custom-tra-tien", label: "TRA TIEN", file: "tra-tien.mp3" },
  { id: "custom-tre-reop-ho", label: "TRE REOP HO", file: "tre-reop-ho.mp3" },
  { id: "custom-troi-oi-cuu-tui-troi-oi", label: "troi oi cuu tui troi oi", file: "troi-oi-cuu-tui-troi-oi.mp3" },
  { id: "custom-troi-troi-no-lam-gi-kho-coi-troi", label: "troi troi no lam gi kho coi troi", file: "troi-troi-no-lam-gi-kho-coi-troi.mp3" },
  { id: "custom-wao-dep", label: "WAO DEP", file: "wao-dep.mp3" },
  { id: "custom-oi", label: "ÓI", file: "oi.mp3" },
];

/** Tạo preset từ 1 file mp3 (volume theo settings, cắt tối đa maxMs để không phát quá dài). */
function mp3Preset(id: string, label: string, src: string, maxMs = 6000): RingtonePreset {
  return { id, label, play: (vol) => playMp3(src, { volume: vol, maxMs }) };
}

// Tiếng mp3 có sẵn của Lulu (giữ làm mặc định + cho chọn trong settings).
const LINDA_PRESETS: RingtonePreset[] = [
  mp3Preset("linda-order", "Lulu: chốt đơn (Chú ý)", LINDA_SOUNDS.orderSuccess, 3500),
  mp3Preset("linda-pay", "Lulu: thu tiền (Trả tiền)", LINDA_SOUNDS.payment, 4500),
  mp3Preset("linda-error", "Lulu: lỗi (Bò kêu)", LINDA_SOUNDS.error, 1100),
];

// Các mp3 custom → preset (im lặng nếu thiếu/lỗi file, không crash).
const CUSTOM_PRESETS: RingtonePreset[] = CUSTOM_SOUNDS.map((s) =>
  mp3Preset(s.id, s.label, `${CUSTOM_SOUND_DIR}/${encodeURIComponent(s.file)}`),
);

// ── Tiếng tổng hợp (synth) — palette gốc ──
const SYNTH_RINGTONES: RingtonePreset[] = [
  { id: "tri-tone", label: "Tinh tinh (iPhone)", play: (vol) => { playTone(1318, 0.18, vol * 0.55, "sine", 0); playTone(1056, 0.18, vol * 0.5, "sine", 0.13); playTone(1568, 0.28, vol * 0.55, "sine", 0.26); } },
  { id: "ting-classic", label: "Ting cổ điển", play: (vol) => { playTone(880, 0.12, vol * 0.6, "sine", 0); playTone(1100, 0.12, vol * 0.5, "sine", 0.1); playTone(1320, 0.18, vol * 0.6, "sine", 0.2); } },
  { id: "coin", label: "Đồng xu", play: (vol) => { playTone(988, 0.08, vol * 0.5, "square", 0); playTone(1319, 0.15, vol * 0.4, "square", 0.08); } },
  { id: "chime", label: "Chuông gió", play: (vol) => { playTone(1047, 0.2, vol * 0.35, "sine", 0); playTone(1319, 0.2, vol * 0.3, "sine", 0.15); playTone(1568, 0.3, vol * 0.35, "sine", 0.3); } },
  { id: "pop", label: "Pop", play: (vol) => { playTone(600, 0.06, vol * 0.5, "sine", 0); playTone(900, 0.1, vol * 0.4, "sine", 0.06); } },
  { id: "marimba", label: "Marimba", play: (vol) => { playTone(523, 0.12, vol * 0.5, "triangle", 0); playTone(659, 0.12, vol * 0.45, "triangle", 0.12); playTone(784, 0.18, vol * 0.5, "triangle", 0.24); } },
  { id: "bell", label: "Chuông nhà thờ", play: (vol) => { playTone(440, 0.4, vol * 0.5, "sine", 0); playTone(554, 0.35, vol * 0.3, "sine", 0.05); playTone(660, 0.3, vol * 0.2, "sine", 0.1); } },
  { id: "iphone-note", label: "Tinh tinh 2", play: (vol) => { playTone(1318, 0.18, vol * 0.95, "sine", 0); playTone(1568, 0.3, vol * 0.95, "sine", 0.1); } },
  { id: "iphone-tri", label: "Tri-tone", play: (vol) => { playTone(1318, 0.18, vol * 0.95, "sine", 0); playTone(1056, 0.18, vol * 0.9, "sine", 0.12); playTone(1568, 0.28, vol * 0.95, "sine", 0.24); } },
  { id: "soft-bell", label: "Chuông nhẹ", play: (vol) => { playTone(660, 0.18, vol * 0.95, "sine", 0); playTone(880, 0.24, vol * 0.85, "sine", 0.15); } },
  { id: "drop", label: "Giọt nước", play: (vol) => { playTone(1200, 0.1, vol * 0.85, "sine", 0); playTone(800, 0.18, vol * 0.8, "sine", 0.08); } },
  { id: "bubble", label: "Bong bóng", play: (vol) => { playTone(400, 0.12, vol * 0.85, "sine", 0); playTone(600, 0.1, vol * 0.8, "sine", 0.08); playTone(500, 0.14, vol * 0.75, "sine", 0.14); } },
  { id: "ding", label: "Ding đơn", play: (vol) => { playTone(880, 0.3, vol * 0.95, "sine", 0); } },
  { id: "alert", label: "Cảnh báo", play: (vol) => { playTone(740, 0.12, vol * 0.9, "triangle", 0); playTone(740, 0.12, vol * 0.9, "triangle", 0.15); playTone(988, 0.18, vol * 0.95, "triangle", 0.3); } },
  { id: "bird", label: "Chim hót", play: (vol) => { playTone(1400, 0.1, vol * 0.8, "sine", 0); playTone(1600, 0.08, vol * 0.75, "sine", 0.1); playTone(1500, 0.12, vol * 0.8, "sine", 0.18); } },
];

const NONE_RINGTONE: RingtonePreset = { id: "none", label: "Tắt tiếng", play: () => {} };

// Thư viện đầy đủ dùng chung cho MỌI sự kiện (synth + Lulu + custom + tắt tiếng).
export const RINGTONE_LIBRARY: RingtonePreset[] = [
  ...SYNTH_RINGTONES,
  ...LINDA_PRESETS,
  ...CUSTOM_PRESETS,
  NONE_RINGTONE,
];

// ── Danh mục sự kiện có âm thanh riêng. Mỗi sự kiện chọn 1 tiếng trong RINGTONE_LIBRARY. ──
export interface SoundEvent {
  key: string;
  label: string;
  /** Ghi chú ngắn (vd: chưa nối sự kiện). */
  hint?: string;
  defaultId: string;
  /** Đã nối vào sự kiện thật trong app chưa. */
  wired: boolean;
  /** Nhóm hiển thị trong trang Cài đặt (mặc định "Chung"). */
  group?: string;
}

const PENDING_HINT = "Chưa nối sự kiện — chọn trước, bật sau";
const CONFIRM_HINT = "Chưa có trạng thái khách xác nhận trong hệ thống — chọn trước, bật sau";
const PUBLIC_HINT = "Trang công khai — mặc định tắt, chọn 1 tiếng nhẹ/sang để bật. Khách có nút tắt riêng.";

// Thứ tự hiển thị nhóm trong Cài đặt → Âm thanh. Nhóm chưa liệt kê sẽ xếp cuối.
export const SOUND_GROUPS = ["Chung", "Tiến độ hậu kỳ", "Chấm công", "Website công khai"] as const;

export const SOUND_EVENTS: SoundEvent[] = [
  { key: "order_created", label: "Chốt đơn / tạo show", defaultId: "linda-order", wired: true, group: "Chung" },
  { key: "payment_in", label: "Thu tiền", defaultId: "linda-pay", wired: true, group: "Chung" },
  { key: "payment_out", label: "Chi tiền", defaultId: "coin", wired: true, group: "Chung" },
  { key: "notification", label: "Thông báo mới", defaultId: "soft-bell", wired: true, group: "Chung" },
  { key: "error", label: "Lỗi", defaultId: "alert", wired: true, group: "Chung" },
  { key: "module_switch", label: "Chuyển màn hình / module", hint: PENDING_HINT, defaultId: "custom-dragon-studio-simple-whoosh-382724", wired: false, group: "Chung" },
  { key: "apply_success", label: "Áp dụng thành công", hint: PENDING_HINT, defaultId: "ting-classic", wired: false, group: "Chung" },
  { key: "needs_attention", label: "Người cần xử lý", hint: PENDING_HINT, defaultId: "custom-oi-gioi-oi", wired: false, group: "Chung" },

  // ── Nhóm "Tiến độ hậu kỳ" (/photoshop-jobs) ──
  { key: "postprod_job_claimed", label: "Nhận việc (Tôi nhận việc này)", defaultId: "ting-classic", wired: true, group: "Tiến độ hậu kỳ" },
  { key: "postprod_progress_saved", label: "Lưu tiến độ", defaultId: "pop", wired: true, group: "Tiến độ hậu kỳ" },
  { key: "postprod_job_paused", label: "Tạm hoãn", defaultId: "bubble", wired: true, group: "Tiến độ hậu kỳ" },
  { key: "postprod_show_completed", label: "Xong show", defaultId: "linda-order", wired: true, group: "Tiến độ hậu kỳ" },
  { key: "postprod_print_link_saved", label: "Lưu link in / hoàn thành", defaultId: "coin", wired: true, group: "Tiến độ hậu kỳ" },
  { key: "postprod_deadline_overdue", label: "Trễ deadline", defaultId: "custom-tre-reop-ho", wired: true, group: "Tiến độ hậu kỳ" },
  { key: "postprod_job_needs_handler", label: "Đơn cần người nhận", defaultId: "custom-oi-gioi-oi", wired: true, group: "Tiến độ hậu kỳ" },
  { key: "postprod_customer_confirmed", label: "Khách xác nhận xong show", hint: CONFIRM_HINT, defaultId: "none", wired: false, group: "Tiến độ hậu kỳ" },

  // ── Nhóm "Chấm công" ──
  { key: "attendance_checkin_success", label: "Check-in thành công", defaultId: "ting-classic", wired: true, group: "Chấm công" },
  { key: "attendance_checkin_early", label: "Check-in sớm / rất đẹp", defaultId: "custom-wao-dep", wired: true, group: "Chấm công" },
  { key: "attendance_checkin_late", label: "Check-in trễ (cảnh báo nhẹ)", defaultId: "alert", wired: true, group: "Chấm công" },
  { key: "attendance_checkout_success", label: "Check-out thành công", defaultId: "pop", wired: true, group: "Chấm công" },
  { key: "attendance_month_closed", label: "Chốt công tháng", defaultId: "linda-pay", wired: true, group: "Chấm công" },
  { key: "attendance_overtime_saved", label: "Lưu / duyệt tăng ca", defaultId: "coin", wired: true, group: "Chấm công" },
  { key: "attendance_leave_approved", label: "Duyệt nghỉ phép", defaultId: "soft-bell", wired: true, group: "Chấm công" },
  { key: "attendance_leave_rejected", label: "Từ chối nghỉ phép", defaultId: "bubble", wired: true, group: "Chấm công" },
  { key: "attendance_staff_absent_detected", label: "Phát hiện nhân viên vắng / chưa vào", hint: "Mặc định tắt để tránh ồn — chọn 1 tiếng để bật.", defaultId: "none", wired: true, group: "Chấm công" },
  { key: "attendance_staff_detail_opened", label: "Mở chi tiết nhân viên", hint: "Tiếng nhẹ khi bấm xem chi tiết — mặc định tắt.", defaultId: "none", wired: true, group: "Chấm công" },

  // ── Nhóm "Website công khai" (mặc định TẮT — chọn tiếng nhẹ để bật; có nút tắt cho khách) ──
  { key: "public_nav_clicked", label: "Bấm menu chính", hint: PUBLIC_HINT, defaultId: "none", wired: true, group: "Website công khai" },
  { key: "public_category_selected", label: "Chọn danh mục", hint: PUBLIC_HINT, defaultId: "none", wired: true, group: "Website công khai" },
  { key: "public_product_card_opened", label: "Mở chi tiết sản phẩm / trang phục", hint: PUBLIC_HINT, defaultId: "none", wired: true, group: "Website công khai" },
  { key: "public_gallery_album_opened", label: "Mở album concept", hint: PUBLIC_HINT, defaultId: "none", wired: true, group: "Website công khai" },
  { key: "public_gallery_image_opened", label: "Mở ảnh trong gallery / lightbox", hint: PUBLIC_HINT, defaultId: "none", wired: true, group: "Website công khai" },
  { key: "public_smart_search_opened", label: "Mở Tìm kiếm thông minh", hint: PUBLIC_HINT, defaultId: "none", wired: true, group: "Website công khai" },
  { key: "public_smart_search_success", label: "Tìm kiếm có kết quả", hint: PUBLIC_HINT, defaultId: "none", wired: true, group: "Website công khai" },
  { key: "public_contact_clicked", label: "Bấm gọi / liên hệ / đặt lịch", hint: PUBLIC_HINT, defaultId: "none", wired: true, group: "Website công khai" },
  { key: "public_image_hover_soft", label: "Hover ảnh (rất nhẹ)", hint: "Chỉ dùng rất nhẹ — mặc định tắt để không gây khó chịu.", defaultId: "none", wired: true, group: "Website công khai" },
];

const EVENT_SOUND_PREFIX = "feedbackEventSound:";

function eventDefault(key: string): string {
  return SOUND_EVENTS.find((e) => e.key === key)?.defaultId ?? "none";
}

export function getEventSoundId(key: string): string {
  try {
    return localStorage.getItem(EVENT_SOUND_PREFIX + key) || eventDefault(key);
  } catch {
    return eventDefault(key);
  }
}

export function setEventSoundId(key: string, id: string) {
  try { localStorage.setItem(EVENT_SOUND_PREFIX + key, id); } catch { /* ignore */ }
}

const VOLUME_KEY = "feedbackVolume";
const VIBRATION_KEY = "feedbackVibration";

export function getSoundSettings() {
  const rawVol = parseFloat(localStorage.getItem(VOLUME_KEY) || "1");
  const volume = Number.isFinite(rawVol) ? Math.max(0, Math.min(1, rawVol)) : 1;
  return {
    volume,
    vibration: localStorage.getItem(VIBRATION_KEY) !== "off",
  };
}

export function setSoundSettings(settings: Partial<ReturnType<typeof getSoundSettings>>) {
  if (settings.volume !== undefined) localStorage.setItem(VOLUME_KEY, String(settings.volume));
  if (settings.vibration !== undefined) localStorage.setItem(VIBRATION_KEY, settings.vibration ? "on" : "off");
}

export function previewRingtone(preset: RingtonePreset, volume?: number) {
  const vol = volume ?? getSoundSettings().volume;
  preset.play(vol);
}

/** Phát tiếng đã chọn cho 1 sự kiện. Im lặng nếu tắt/thiếu — không crash. */
export function playEventSound(key: string, opts?: { volumeScale?: number }) {
  try {
    const id = getEventSoundId(key);
    if (id === "none") return;
    const preset = RINGTONE_LIBRARY.find((r) => r.id === id);
    const vol = getSoundSettings().volume * (opts?.volumeScale ?? 1);
    preset?.play(vol);
  } catch { /* ignore */ }
}

// ── Helper dùng chung có chống spam (cooldown theo eventKey) ──
// Không phát nếu: tiếng = "none", volume = 0 (đã chặn trong playEventSound/playMp3),
// hoặc sự kiện vừa phát trong khoảng cooldownMs trước đó.
const _lastPlayed: Record<string, number> = {};

export function playAppSound(
  key: string,
  opts?: { cooldownMs?: number; vibrate?: number | number[]; volumeScale?: number },
) {
  try {
    const cd = opts?.cooldownMs ?? 0;
    if (cd > 0) {
      const now = Date.now();
      if (now - (_lastPlayed[key] ?? 0) < cd) return;
      _lastPlayed[key] = now;
    }
    playEventSound(key, opts?.volumeScale ? { volumeScale: opts.volumeScale } : undefined);
    if (opts?.vibrate) triggerVibration(opts.vibrate);
  } catch { /* ignore */ }
}

// ── Âm thanh cho TRANG CÔNG KHAI (khách) ──
// Dùng chung kho/player/setting trung tâm; chỉ thêm: nút tắt riêng cho khách (localStorage)
// + cổng autoplay (chỉ phát sau tương tác đầu tiên) + tiếng nhẹ (volumeScale) + cooldown.
const PUBLIC_MUTE_KEY = "publicSoundMuted";

export function isPublicSoundMuted(): boolean {
  try { return localStorage.getItem(PUBLIC_MUTE_KEY) === "1"; } catch { return false; }
}

export function setPublicSoundMuted(muted: boolean) {
  try { localStorage.setItem(PUBLIC_MUTE_KEY, muted ? "1" : "0"); } catch { /* ignore */ }
}

let _userInteracted = false;
let _publicAudioArmed = false;

/** Gắn 1 lần listener để biết khách đã tương tác (tôn trọng autoplay của trình duyệt). */
export function ensurePublicAudioArmed() {
  if (_publicAudioArmed) return;
  _publicAudioArmed = true;
  try {
    const mark = () => { _userInteracted = true; };
    window.addEventListener("pointerdown", mark, { once: true, passive: true });
    window.addEventListener("keydown", mark, { once: true });
    window.addEventListener("touchstart", mark, { once: true, passive: true });
  } catch { /* ignore */ }
}

/** Phát tiếng cho trang công khai. Im lặng (không crash) nếu: khách tắt tiếng,
 *  chưa tương tác lần nào, tiếng = "none", volume 0, hoặc vừa phát (cooldown). */
export function playPublicSound(
  key: string,
  opts?: { cooldownMs?: number; volumeScale?: number },
) {
  try {
    ensurePublicAudioArmed();
    if (isPublicSoundMuted()) return;
    if (!_userInteracted) return;
    playAppSound(key, { cooldownMs: opts?.cooldownMs ?? 400, volumeScale: opts?.volumeScale ?? 0.4 });
  } catch { /* ignore */ }
}

export function triggerVibration(pattern: number | number[] = [80, 50, 80]) {
  try {
    const { vibration } = getSoundSettings();
    if (!vibration) return;
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  } catch {}
}

/** Tạo đơn / lưu show thành công */
export function orderCreatedFeedback() {
  playEventSound("order_created");
  triggerVibration([80, 50, 80]);
}

/** Giao dịch tiền: thu (in, mặc định) hoặc chi (out) */
export function paymentFeedback(direction: "in" | "out" = "in") {
  playEventSound(direction === "out" ? "payment_out" : "payment_in");
  triggerVibration(direction === "out" ? [60, 40, 60] : [60, 40, 60, 40, 100]);
}

/** Báo lỗi */
export function errorFeedback() {
  playEventSound("error");
  triggerVibration([120, 80, 120]);
}

export function successFeedback() {
  orderCreatedFeedback();
}

export function notificationFeedback() {
  playEventSound("notification");
  triggerVibration(100);
}

// ── Helper cho các sự kiện CHƯA nối (đã có ô chọn trong settings; gọi khi muốn bật) ──
export function moduleSwitchFeedback() {
  playEventSound("module_switch");
}
export function applySuccessFeedback() {
  playEventSound("apply_success");
  triggerVibration(80);
}
export function needsAttentionFeedback() {
  playEventSound("needs_attention");
  triggerVibration([100, 60, 100]);
}

/** Phát tiếng chấm công theo messageKey trả về từ API (sớm/đúng giờ/trễ/check-out). */
export function attendancePunchSound(messageKey: string | undefined, type: "check_in" | "check_out") {
  let key: string;
  switch (messageKey) {
    case "very_early": key = "attendance_checkin_early"; break;
    case "on_time": key = "attendance_checkin_success"; break;
    case "late_light":
    case "late_heavy": key = "attendance_checkin_late"; break;
    case "checkout_on_time":
    case "checkout_late": key = "attendance_checkout_success"; break;
    case "overtime_start":
    case "overtime_end": key = "attendance_overtime_saved"; break;
    default: key = type === "check_in" ? "attendance_checkin_success" : "attendance_checkout_success";
  }
  playAppSound(key, { vibrate: key === "attendance_checkin_late" ? [120, 80, 120] : [80, 50, 80] });
}
