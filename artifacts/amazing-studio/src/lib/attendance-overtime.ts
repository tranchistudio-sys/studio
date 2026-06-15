/** Client mirror of api-server overtime session rules (journal + tab Tăng ca). */

export type OvertimeSessionStatus = "valid" | "missing_checkout" | "over_limit";

export type OvertimeLogLite = {
  staffId: number;
  staffName?: string;
  date: string;
  type: string;
  time: string;
};

export type OvertimeSessionLite = {
  staffId: number;
  staffName?: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  minutes: number;
  hours: number;
  pay: number;
  status: OvertimeSessionStatus;
  statusLabel: string;
};

export const MAX_OT_SESSION_MINUTES = 5 * 60;

export const ATTENDANCE_CHECKOUT_RULES = {
  officialEnd: "18:00",
  checkoutFrom: "18:00",
  checkoutUntil: "19:00",
  forgotPenalty: 5_000,
} as const;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

function sessionFromPair(
  inLog: OvertimeLogLite,
  outLog: OvertimeLogLite | null,
  ratePerHour: number,
): OvertimeSessionLite {
  const { staffId, staffName, date } = inLog;
  const startTime = inLog.time;
  if (!outLog) {
    return {
      staffId, staffName, date, startTime, endTime: null,
      minutes: 0, hours: 0, pay: 0,
      status: "missing_checkout", statusLabel: "Thiếu check-out",
    };
  }
  const endTime = outLog.time;
  const mIn = toMinutes(startTime);
  const mOut = toMinutes(endTime);
  if (Number.isNaN(mIn) || Number.isNaN(mOut) || mOut <= mIn) {
    return {
      staffId, staffName, date, startTime, endTime,
      minutes: 0, hours: 0, pay: 0,
      status: "missing_checkout", statusLabel: "Thiếu check-out",
    };
  }
  const minutes = mOut - mIn;
  const hours = Math.round((minutes / 60) * 100) / 100;
  if (minutes > MAX_OT_SESSION_MINUTES) {
    return {
      staffId, staffName, date, startTime, endTime, minutes, hours, pay: 0,
      status: "over_limit", statusLabel: "Quá 5 tiếng",
    };
  }
  return {
    staffId, staffName, date, startTime, endTime, minutes, hours,
    pay: Math.round((minutes / 60) * ratePerHour),
    status: "valid", statusLabel: "Hợp lệ",
  };
}

export function computeOvertimeSessions(
  logs: OvertimeLogLite[],
  ratePerHour: number,
): OvertimeSessionLite[] {
  const byKey = new Map<string, OvertimeLogLite[]>();
  for (const l of logs) {
    if (l.type !== "overtime_check_in" && l.type !== "overtime_check_out") continue;
    const key = `${l.staffId}:${l.date}`;
    const arr = byKey.get(key) ?? [];
    arr.push(l);
    byKey.set(key, arr);
  }
  const sessions: OvertimeSessionLite[] = [];
  for (const [, items] of byKey) {
    const sorted = items.slice().sort((a, b) => a.time.localeCompare(b.time));
    const staffId = sorted[0].staffId;
    const staffName = sorted[0].staffName;
    let pendingIn: OvertimeLogLite | null = null;
    for (const it of sorted) {
      if (it.type === "overtime_check_in") {
        if (pendingIn) sessions.push(sessionFromPair(pendingIn, null, ratePerHour));
        pendingIn = it;
      } else if (it.type === "overtime_check_out" && pendingIn) {
        sessions.push(sessionFromPair(pendingIn, it, ratePerHour));
        pendingIn = null;
      }
    }
    if (pendingIn) sessions.push(sessionFromPair(pendingIn, null, ratePerHour));
  }
  return sessions.sort((a, b) => b.date.localeCompare(a.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
}

export function shouldAssessForgotCheckout(date: string): boolean {
  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const nowHHMM = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(11, 16);
  if (date < todayStr) return true;
  if (date === todayStr && nowHHMM >= ATTENDANCE_CHECKOUT_RULES.checkoutUntil) return true;
  return false;
}

export function hasCheckOutOnDate(
  logs: Array<{ staffId: number; type: string; localDate?: string; createdAt: string }>,
  staffId: number,
  date: string,
): boolean {
  return logs.some(l =>
    Number(l.staffId) === staffId &&
    l.type === "check_out" &&
    (l.localDate ?? l.createdAt.slice(0, 10)) === date,
  );
}
