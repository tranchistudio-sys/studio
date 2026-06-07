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

export interface RingtonePreset {
  id: string;
  label: string;
  play: (vol: number) => void;
}

export const SUCCESS_RINGTONES: RingtonePreset[] = [
  {
    id: "tri-tone",
    label: "Tinh tinh (iPhone)",
    play: (vol) => {
      playTone(1318, 0.18, vol * 0.55, "sine", 0);
      playTone(1056, 0.18, vol * 0.5, "sine", 0.13);
      playTone(1568, 0.28, vol * 0.55, "sine", 0.26);
    },
  },
  {
    id: "ting-classic",
    label: "Ting cổ điển",
    play: (vol) => {
      playTone(880, 0.12, vol * 0.6, "sine", 0);
      playTone(1100, 0.12, vol * 0.5, "sine", 0.1);
      playTone(1320, 0.18, vol * 0.6, "sine", 0.2);
    },
  },
  {
    id: "coin",
    label: "Đồng xu",
    play: (vol) => {
      playTone(988, 0.08, vol * 0.5, "square", 0);
      playTone(1319, 0.15, vol * 0.4, "square", 0.08);
    },
  },
  {
    id: "chime",
    label: "Chuông gió",
    play: (vol) => {
      playTone(1047, 0.2, vol * 0.35, "sine", 0);
      playTone(1319, 0.2, vol * 0.3, "sine", 0.15);
      playTone(1568, 0.3, vol * 0.35, "sine", 0.3);
    },
  },
  {
    id: "pop",
    label: "Pop",
    play: (vol) => {
      playTone(600, 0.06, vol * 0.5, "sine", 0);
      playTone(900, 0.1, vol * 0.4, "sine", 0.06);
    },
  },
  {
    id: "marimba",
    label: "Marimba",
    play: (vol) => {
      playTone(523, 0.12, vol * 0.5, "triangle", 0);
      playTone(659, 0.12, vol * 0.45, "triangle", 0.12);
      playTone(784, 0.18, vol * 0.5, "triangle", 0.24);
    },
  },
  {
    id: "bell",
    label: "Chuông nhà thờ",
    play: (vol) => {
      playTone(440, 0.4, vol * 0.5, "sine", 0);
      playTone(554, 0.35, vol * 0.3, "sine", 0.05);
      playTone(660, 0.3, vol * 0.2, "sine", 0.1);
    },
  },
  {
    id: "none",
    label: "Tắt tiếng",
    play: () => {},
  },
];

export const NOTIF_RINGTONES: RingtonePreset[] = [
  {
    id: "iphone-note",
    label: "Tinh tinh (iPhone)",
    play: (vol) => {
      playTone(1318, 0.18, vol * 0.95, "sine", 0);
      playTone(1568, 0.3, vol * 0.95, "sine", 0.1);
    },
  },
  {
    id: "iphone-tri",
    label: "Tri-tone iPhone",
    play: (vol) => {
      playTone(1318, 0.18, vol * 0.95, "sine", 0);
      playTone(1056, 0.18, vol * 0.9, "sine", 0.12);
      playTone(1568, 0.28, vol * 0.95, "sine", 0.24);
    },
  },
  {
    id: "soft-bell",
    label: "Chuông nhẹ",
    play: (vol) => {
      playTone(660, 0.18, vol * 0.95, "sine", 0);
      playTone(880, 0.24, vol * 0.85, "sine", 0.15);
    },
  },
  {
    id: "drop",
    label: "Giọt nước",
    play: (vol) => {
      playTone(1200, 0.1, vol * 0.85, "sine", 0);
      playTone(800, 0.18, vol * 0.8, "sine", 0.08);
    },
  },
  {
    id: "bubble",
    label: "Bong bóng",
    play: (vol) => {
      playTone(400, 0.12, vol * 0.85, "sine", 0);
      playTone(600, 0.1, vol * 0.8, "sine", 0.08);
      playTone(500, 0.14, vol * 0.75, "sine", 0.14);
    },
  },
  {
    id: "ding",
    label: "Ding đơn",
    play: (vol) => {
      playTone(880, 0.3, vol * 0.95, "sine", 0);
    },
  },
  {
    id: "alert",
    label: "Cảnh báo",
    play: (vol) => {
      playTone(740, 0.12, vol * 0.9, "triangle", 0);
      playTone(740, 0.12, vol * 0.9, "triangle", 0.15);
      playTone(988, 0.18, vol * 0.95, "triangle", 0.3);
    },
  },
  {
    id: "bird",
    label: "Chim hót",
    play: (vol) => {
      playTone(1400, 0.1, vol * 0.8, "sine", 0);
      playTone(1600, 0.08, vol * 0.75, "sine", 0.1);
      playTone(1500, 0.12, vol * 0.8, "sine", 0.18);
    },
  },
  {
    id: "none",
    label: "Tắt tiếng",
    play: () => {},
  },
];

const STORAGE_KEYS = {
  successRingtone: "feedbackSuccessRingtone",
  notifRingtone: "feedbackNotifRingtone",
  volume: "feedbackVolume",
  vibration: "feedbackVibration",
};

export function getSoundSettings() {
  const rawVol = parseFloat(localStorage.getItem(STORAGE_KEYS.volume) || "1");
  const volume = Number.isFinite(rawVol) ? Math.max(0, Math.min(1, rawVol)) : 1;
  return {
    successRingtone: localStorage.getItem(STORAGE_KEYS.successRingtone) || "ting-classic",
    notifRingtone: localStorage.getItem(STORAGE_KEYS.notifRingtone) || "soft-bell",
    volume,
    vibration: localStorage.getItem(STORAGE_KEYS.vibration) !== "off",
  };
}

export function setSoundSettings(settings: Partial<ReturnType<typeof getSoundSettings>>) {
  if (settings.successRingtone !== undefined) localStorage.setItem(STORAGE_KEYS.successRingtone, settings.successRingtone);
  if (settings.notifRingtone !== undefined) localStorage.setItem(STORAGE_KEYS.notifRingtone, settings.notifRingtone);
  if (settings.volume !== undefined) localStorage.setItem(STORAGE_KEYS.volume, String(settings.volume));
  if (settings.vibration !== undefined) localStorage.setItem(STORAGE_KEYS.vibration, settings.vibration ? "on" : "off");
}

export function previewRingtone(preset: RingtonePreset, volume?: number) {
  const vol = volume ?? getSoundSettings().volume;
  preset.play(vol);
}

export function playSuccessSound() {
  try {
    const { successRingtone, volume } = getSoundSettings();
    const preset = SUCCESS_RINGTONES.find(r => r.id === successRingtone) || SUCCESS_RINGTONES[0];
    preset.play(volume);
  } catch {}
}

export function playNotificationSound() {
  try {
    const { notifRingtone, volume } = getSoundSettings();
    const preset = NOTIF_RINGTONES.find(r => r.id === notifRingtone) || NOTIF_RINGTONES[0];
    preset.play(volume);
  } catch {}
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

export function successFeedback() {
  playSuccessSound();
  triggerVibration([80, 50, 80]);
}

export function notificationFeedback() {
  playNotificationSound();
  triggerVibration(100);
}
