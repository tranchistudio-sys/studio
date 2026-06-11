// Task #504: Tính tăng ca theo logs riêng (type=overtime_check_in / overtime_check_out).
// Quy tắc:
//   - Gom log theo NGÀY (local VN), pair check-in → check-out theo thứ tự thời gian.
//   - Cộng tổng phút trong ngày trước khi làm tròn.
//   - Làm tròn theo phần lẻ phút trên mỗi giờ:
//       remainder <15p   → 0
//       15p ≤ rem <45p   → 0.5h
//       rem ≥45p         → 1h
//     hours_day = floor(minutes / 60) + roundFragment(minutes % 60)
//   - pay = sum(hours_day) × ratePerHour. Snapshot rate vào payroll khi generate.

export interface OvertimeLog {
  /** YYYY-MM-DD theo timezone VN */
  date: string;
  /** "overtime_check_in" | "overtime_check_out" */
  type: string;
  /** HH:MM (24h) theo VN */
  time: string;
}

export interface OvertimeDayBreakdown {
  date: string;
  minutes: number;
  hours: number;
  pay: number;
  /** Khoảng OT đã pair (đã trừ checkout trước check-in / unmatched). */
  segments: Array<{ start: string; end: string; minutes: number }>;
}

export interface OvertimeMonthResult {
  hours: number;
  rate: number;
  pay: number;
  byDate: OvertimeDayBreakdown[];
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

export function roundOvertimeMinutes(minutes: number): number {
  if (minutes <= 0) return 0;
  const full = Math.floor(minutes / 60);
  const rem = minutes % 60;
  const extra = rem < 15 ? 0 : rem < 45 ? 0.5 : 1;
  return full + extra;
}

export function computeOvertimeForMonth(
  logs: OvertimeLog[],
  ratePerHour: number,
): OvertimeMonthResult {
  const byDateRaw = new Map<string, OvertimeLog[]>();
  for (const l of logs) {
    if (l.type !== "overtime_check_in" && l.type !== "overtime_check_out") continue;
    const arr = byDateRaw.get(l.date) ?? [];
    arr.push(l);
    byDateRaw.set(l.date, arr);
  }

  const byDate: OvertimeDayBreakdown[] = [];
  let totalHours = 0;

  const sortedDates = [...byDateRaw.keys()].sort();
  for (const date of sortedDates) {
    const items = byDateRaw.get(date)!.slice().sort((a, b) => a.time.localeCompare(b.time));
    let minutes = 0;
    const segments: Array<{ start: string; end: string; minutes: number }> = [];
    let pendingIn: OvertimeLog | null = null;
    for (const it of items) {
      if (it.type === "overtime_check_in") {
        // Nếu đã có pendingIn mà gặp check-in mới → bỏ pendingIn cũ (không pair được).
        pendingIn = it;
      } else if (it.type === "overtime_check_out" && pendingIn) {
        const mIn = toMinutes(pendingIn.time);
        const mOut = toMinutes(it.time);
        if (!Number.isNaN(mIn) && !Number.isNaN(mOut) && mOut > mIn) {
          const seg = mOut - mIn;
          minutes += seg;
          segments.push({ start: pendingIn.time, end: it.time, minutes: seg });
        }
        pendingIn = null;
      }
    }
    const hours = roundOvertimeMinutes(minutes);
    const pay = Math.round(hours * ratePerHour);
    totalHours += hours;
    byDate.push({ date, minutes, hours, pay, segments });
  }

  const pay = Math.round(totalHours * ratePerHour);
  return { hours: totalHours, rate: ratePerHour, pay, byDate };
}
