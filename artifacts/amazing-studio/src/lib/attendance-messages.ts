/** Encouragement copy for attendance punch modal (client-only, not persisted). */

export type AttendanceMessageKey =
  | "very_early"
  | "on_time"
  | "late_light"
  | "late_heavy"
  | "checkout_on_time"
  | "checkout_late"
  | "overtime_start"
  | "overtime_end";

export type PunchFeedback = {
  messageKey: AttendanceMessageKey;
  localTime?: string;
  lateMinutes?: number;
  penaltyAmount?: number;
  overtimeHours?: number;
  overtimeAmount?: number;
};

export type AttendanceTone = "positive" | "neutral" | "warning" | "celebrate";

export type AttendanceMessageResult = {
  title: string;
  description: string;
  tone: AttendanceTone;
  statusLine?: string;
};

const TITLES: Record<AttendanceMessageKey, string> = {
  very_early: "Đến sớm quá!",
  on_time: "Đúng giờ rồi!",
  late_light: "Hơi trễ một chút",
  late_heavy: "Hôm nay trễ hơn dự kiến",
  checkout_on_time: "Tan ca đúng giờ",
  checkout_late: "Tan ca muộn",
  overtime_start: "Bắt đầu tăng ca",
  overtime_end: "Kết thúc tăng ca",
};

const TONES: Record<AttendanceMessageKey, AttendanceTone> = {
  very_early: "positive",
  on_time: "celebrate",
  late_light: "warning",
  late_heavy: "warning",
  checkout_on_time: "positive",
  checkout_late: "neutral",
  overtime_start: "positive",
  overtime_end: "celebrate",
};

/** 26 câu — ~3–4 mỗi nhóm */
export const MESSAGE_POOLS: Record<AttendanceMessageKey, string[]> = {
  very_early: [
    "Bạn đến sớm thật đấy — Amazing Studio ghi nhận tinh thần chuẩn bị của bạn!",
    "Sớm một chút, năng lượng cả ngày — cứ giữ nhịp này nhé!",
    "Đến trước ca là thói quen của người chuyên nghiệp — tuyệt vời!",
  ],
  on_time: [
    "Đúng giờ — chuẩn Amazing Studio! Hôm nay bạn bắt đầu rất ổn.",
    "Giờ vàng đã đến — làm việc thật vui và hiệu quả nhé!",
    "Check-in đúng giờ — một ngày tốt bắt đầu từ đây.",
  ],
  late_light: [
    "Trễ nhẹ thôi — mai cố gắng sớm hơn một chút, bạn làm được!",
    "Không sao, hôm nay bù bằng năng lượng tích cực nhé!",
    "Một lần trễ nhẹ — hãy để ngày còn lại thật xuất sắc.",
    "Team vẫn tin bạn — tập trung vào việc quan trọng phía trước.",
  ],
  late_heavy: [
    "Hôm nay trễ hơn dự kiến — ngày mai mình cố sớm hơn nhé!",
    "Cố gắng bù đắp bằng chất lượng công việc — bạn có thể!",
    "Lần sau để đồng hồ báo thức sớm hơn — team đang chờ bạn đúng giờ.",
    "Trễ nặng hơn bình thường — hãy rút kinh nghiệm và tiến lên.",
  ],
  checkout_on_time: [
    "Tan ca đúng giờ — nghỉ ngơi xứng đáng sau một ngày làm việc!",
    "Kết thúc ca gọn gàng — hẹn gặp lại ngày mai tại Amazing Studio!",
    "Ra về đúng khung giờ — cảm ơn bạn đã hoàn thành ca hôm nay.",
    "Chuẩn giờ tan ca — về nhà thư giãn nhé!",
  ],
  checkout_late: [
    "Tan ca muộn — cảm ơn bạn đã cố gắng thêm cho team!",
    "Ra muộn một chút — nhớ nghỉ ngơi và giữ sức khỏe.",
    "Kết thúc sau giờ chuẩn — team trân trọng sự hy sinh của bạn.",
    "Muộn tan ca — mai nhớ check-out đúng khung nếu có thể nhé.",
  ],
  overtime_start: [
    "Bắt đầu tăng ca — năng lượng và an toàn luôn là ưu tiên!",
    "Phiên tăng ca mới — làm việc hiệu quả, Amazing Studio đồng hành!",
    "OT bắt đầu — cảm ơn bạn đã sẵn sàng hỗ trợ thêm.",
    "Tăng ca đã ghi nhận — cố gắng vừa sức, sức khỏe trước tiên!",
  ],
  overtime_end: [
    "Kết thúc tăng ca — cảm ơn bạn! Nghỉ ngơi thật tốt nhé.",
    "Phiên OT xong — bạn đã đóng góp thêm rất đáng trân trọng.",
    "Tan tăng ca — về nhà an toàn, ngày mai gặp lại!",
    "Hoàn thành OT — Amazing Studio ghi nhận công sức của bạn.",
  ],
};

const LAST_KEY_PREFIX = "attendance-msg-last-";

export function pickMessage(key: AttendanceMessageKey): string {
  const pool = MESSAGE_POOLS[key];
  if (pool.length === 0) return "";
  if (pool.length === 1) return pool[0];

  const storageKey = `${LAST_KEY_PREFIX}${key}`;
  let lastIdx = -1;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw != null) lastIdx = parseInt(raw, 10);
  } catch {
    /* SSR / private mode */
  }

  for (let attempt = 0; attempt < pool.length; attempt++) {
    const idx = Math.floor(Math.random() * pool.length);
    if (idx !== lastIdx) {
      try {
        sessionStorage.setItem(storageKey, String(idx));
      } catch {
        /* ignore */
      }
      return pool[idx];
    }
  }
  const fallback = (lastIdx + 1) % pool.length;
  try {
    sessionStorage.setItem(storageKey, String(fallback));
  } catch {
    /* ignore */
  }
  return pool[fallback];
}

function formatVnd(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(Math.round(n)) + " đ";
}

function buildStatusLine(feedback: PunchFeedback): string | undefined {
  const { messageKey, localTime, lateMinutes, penaltyAmount, overtimeHours, overtimeAmount } = feedback;
  const timePart = localTime ? ` · ${localTime}` : "";

  if (messageKey === "late_light" || messageKey === "late_heavy") {
    const parts: string[] = [];
    if (lateMinutes != null && lateMinutes > 0) parts.push(`Trễ ${lateMinutes} phút`);
    if (penaltyAmount != null && penaltyAmount > 0) parts.push(`Phạt ${formatVnd(penaltyAmount)}`);
    const base = parts.join(" · ");
    return base ? base + timePart : localTime;
  }
  if (messageKey === "checkout_late" && penaltyAmount != null && penaltyAmount > 0) {
    return `Có thể phạt quên check-out ${formatVnd(penaltyAmount)}${timePart}`;
  }
  if (messageKey === "overtime_end" && (overtimeHours != null || overtimeAmount != null)) {
    const h = overtimeHours ?? 0;
    const pay = overtimeAmount ?? 0;
    return `~${h.toFixed(1)} giờ · ${formatVnd(pay)}${timePart}`;
  }
  if (localTime) return localTime;
  return undefined;
}

export function getAttendanceMessage(feedback: PunchFeedback): AttendanceMessageResult {
  const key = feedback.messageKey;
  let description = pickMessage(key);
  if (key === "overtime_end") {
    const h = (feedback.overtimeHours ?? 0).toFixed(1);
    const amt = new Intl.NumberFormat("vi-VN").format(Math.round(feedback.overtimeAmount ?? 0));
    description = description.replace(/\{hours\}/g, h).replace(/\{amount\}/g, amt);
  }
  return {
    title: TITLES[key],
    description,
    tone: TONES[key],
    statusLine: buildStatusLine(feedback),
  };
}

/** Total lines across pools (for tests). */
export function totalMessageCount(): number {
  return Object.values(MESSAGE_POOLS).reduce((n, arr) => n + arr.length, 0);
}
