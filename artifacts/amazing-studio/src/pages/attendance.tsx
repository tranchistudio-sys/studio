import { useState, useEffect, useRef, useCallback, useMemo, type MouseEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Timer, MapPin, CheckCircle2, LogIn, LogOut, Calendar,
  Users, AlertCircle, Clock, Plus, Settings, Loader2, QrCode, Building2,
  X, CameraOff, Camera, Trash2, ChevronDown, ExternalLink, History, Pencil
} from "lucide-react";
import { Link } from "wouter";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { Button } from "@/components/ui";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import {
  ATTENDANCE_CHECKOUT_RULES,
  computeOvertimeSessions,
  hasCheckOutOnDate,
  shouldAssessForgotCheckout,
} from "@/lib/attendance-overtime";
import jsQR from "jsqr";
import QRCode from "qrcode";
import { isAttendanceBlockedIdentity, isAttendanceEligibleStaff } from "@/lib/attendance-eligible";
import { AttendanceEncouragementModal } from "@/components/AttendanceEncouragementModal";
import { OffsiteCheckInDialog } from "@/components/OffsiteCheckInDialog";
import { uploadFileViaPresign } from "@/components/cms-shared";
import { AttendanceMoneyEditDialog, MoneyEditPencil, type MoneyEditContext } from "@/components/AttendanceMoneyEditDialog";
import type { PunchFeedback } from "@/lib/attendance-messages";
import { getImageSrc } from "@/lib/imageUtils";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");


function AttendanceSelfieThumb({ path, size = "sm" }: { path: string | null | undefined; size?: "sm" | "md" }) {
  const src = getImageSrc(path);
  if (!src) return null;
  const cls = size === "md" ? "w-16 h-16" : "w-9 h-9";
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Xem selfie xác thực" onClick={e => e.stopPropagation()}
      className="inline-flex shrink-0 rounded-lg overflow-hidden border border-amber-200 hover:ring-2 hover:ring-amber-300">
      <img src={src} alt="Selfie" className={`${cls} object-cover`} />
    </a>
  );
}

const vnd = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n);

const authH = () => {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
};

const fetchAuth = (url: string, opts?: RequestInit) =>
  fetch(`${BASE}${url}`, { headers: authH(), ...opts }).then(async r => {
    const text = await r.text();
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(
        r.status === 404
          ? "API chưa có endpoint này — hãy restart server API (port 3000)"
          : `Lỗi server (${r.status}) — kiểm tra API đang chạy`,
      );
    }
    if (!r.ok) throw new Error(String(d?.error || "Lỗi kết nối"));
    return d;
  });

const ATTENDANCE_ACT_AS_HEADER = "x-attendance-staff-id";

type AttendanceTestStaff = { id: number; name: string; role: string; staffType: string };

function mergeAttendanceHeaders(opts?: RequestInit, actAsStaffId?: number): HeadersInit {
  const base = authH() as Record<string, string>;
  if (actAsStaffId != null && actAsStaffId > 0) {
    base[ATTENDANCE_ACT_AS_HEADER] = String(actAsStaffId);
  }
  return { ...base, ...(opts?.headers as Record<string, string> | undefined) };
}

const fetchAttendanceSelf = (url: string, actAsStaffId: number | undefined, opts?: RequestInit) =>
  fetch(`${BASE}${url}`, { headers: mergeAttendanceHeaders(opts, actAsStaffId), ...opts }).then(async r => {
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || "Lỗi kết nối");
    return d;
  });

type WorkType = "studio" | "studio_auto" | "di_show" | "makeup_ngoai" | "hau_ky" | "linh_dong";

const WORK_TYPE_LABELS: Record<WorkType, string> = {
  studio: "Studio",
  studio_auto: "Studio auto",
  di_show: "Đi show",
  makeup_ngoai: "Makeup ngoài",
  hau_ky: "Hậu kỳ",
  linh_dong: "Linh động",
};

function isOffsiteMethod(method?: string | null): boolean {
  return method === "offsite" || method === "gps_selfie";
}

function isStudioAutoLog(log?: Pick<LogEntry, "method" | "attendanceType" | "workType" | "isOffsite"> | null): boolean {
  return !!log && !log.isOffsite && (log.method === "gps_auto" || log.attendanceType === "studio_auto" || log.workType === "studio_auto");
}

function attendanceMethodLabel(log?: Pick<LogEntry, "method" | "attendanceType" | "workType" | "isOffsite"> | null): string {
  if (!log) return "—";
  if (isStudioAutoLog(log)) return "GPS Auto";
  if (isOffsiteMethod(log.method) || log.isOffsite || log.attendanceType === "offsite") return "Ngoài studio + selfie";
  if (log.method === "qr") return "QR";
  if (log.method === "wifi" || log.attendanceType === "studio_wifi") return "WiFi Studio";
  if (log.method === "manual") return "Thủ công";
  return "Studio";
}

function requiresManualCheckout(log?: Pick<LogEntry, "method" | "attendanceType" | "workType" | "isOffsite"> | null): boolean {
  return !!log && (isOffsiteMethod(log.method) || log.isOffsite || log.attendanceType === "offsite" || log.workType === "di_show" || log.workType === "makeup_ngoai");
}

type LogOverrideInfo = {
  time: string | null;
  isLate: number | null;
  reason: string;
  createdByName: string | null;
  createdAt: string;
};

type LogEntry = {
  id: number;
  staffId: number;
  staffName?: string;
  type: "check_in" | "check_out" | "overtime_check_in" | "overtime_check_out";
  method?: string;
  checkInMethod?: string;
  attendanceType?: string;
  workType?: WorkType | null;
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  isOffsite: boolean;
  locationVerified?: boolean;
  selfieRequired?: boolean;
  qrRequired?: boolean;
  checkinPhotoUrl?: string | null;
  notes: string | null;
  localTime?: string;
  localDate?: string;
  createdAt: string;
  override?: LogOverrideInfo | null;
};

type BonusPenaltyItem = {
  type: string; amount: number; description: string; date: string;
  isLate?: boolean; waived?: boolean; waiverReason?: string | null; overrideReason?: string | null;
};

type AdjustmentItem = {
  id: number; type: string; category?: string | null;
  amount: number; reason: string | null; date: string;
  createdByName?: string | null; createdAt?: string;
};

type ShiftInfoLite = {
  name: string; startTime: string; endTime: string;
  standardHours: number; flexibleBreakHours: number;
  source: "override" | "default"; scope?: "all" | "selected";
};

type LateRuleLite = { lateFromTime: string | null; lateToTime: string | null; penaltyAmount: number };
type ApprovedLeaveLite = { date: string; reason?: string };
type OvertimeByDateItem = { date: string; hours: number; amount?: number; pay?: number };

type MyAttendance = {
  logs: LogEntry[];
  bonusPenalty: BonusPenaltyItem[];
  adjustments: AdjustmentItem[];
  totalDays: number;
  onTimeCount: number;
  onTimeRate: number;
  earnedBonus: number;
  penalty: number;
  net: number;
  checkInTo?: string;
  todayShift?: ShiftInfoLite & { date: string };
  shifts?: Record<string, ShiftInfoLite>;
  // Task #508
  lateRules?: LateRuleLite[];
  approvedLeaves?: ApprovedLeaveLite[];
  overtime?: { hours: number; pay: number; byDate: { date: string; hours: number; pay: number }[] };
  showDayDates?: string[];
  showTimes?: Record<string, string>;
  todayMode?: AttendanceMode;
  todayBookings?: { id: number; customerName: string | null; serviceLabel: string | null; packageType: string | null; shootDate: string }[];
};

type StaffSummaryResp = {
  staffId: number; month: string;
  totalDays: number; lateCount: number; missedCheckout: number; showCount: number; onTimeRate: number;
  totalPenalty: number; totalBonus: number; net: number;
  checkInTo?: string;
  shifts?: Record<string, ShiftInfoLite>;
  lateRules?: LateRuleLite[];
  approvedLeaves?: ApprovedLeaveLite[];
  overtimeByDate?: OvertimeByDateItem[];
  logs?: LogEntry[];
  showDayDates?: string[];
  showTimes?: Record<string, string>;
};

type ShiftOverrideLite = { date: string; scope: string; startTime: string; staffIds: number[] };
type OvertimeSessionRow = {
  staffId: number;
  staffName?: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  minutes: number;
  hours: number;
  pay: number;
  status: string;
  statusLabel: string;
};

type TeamExtras = {
  month: string;
  checkInTo: string;
  weeklyOnTimeBonus?: number;
  monthlyOnTimeBonus?: number;
  overtimeRatePerHour?: number;
  checkoutRules?: typeof ATTENDANCE_CHECKOUT_RULES;
  lateRules: LateRuleLite[];
  staffLeaves: Record<string, { date: string; reason?: string }[]>;
  staffOvertime: Record<string, OvertimeByDateItem[]>;
  overtimeSessions?: OvertimeSessionRow[];
  shiftOverrides?: ShiftOverrideLite[];
  staffWaivers?: Record<string, Record<string, { amount: number; reason: string | null; createdByName?: string | null; createdAt?: string }>>;
  staffAdjustments?: Record<string, Array<{ id: number; date: string; type: string; category: string | null; amount: number; reason: string | null; createdByName: string | null; createdAt: string }>>;
  staffShowDays?: Record<string, string[]>;
  // date -> giờ hẹn chụp "HH:MM" sớm nhất (để chấm trễ show ngoài)
  staffShowTimes?: Record<string, Record<string, string>>;
};

function isWaived(staffId: number, date: string, extras: TeamExtras | undefined): { waived: boolean; reason: string | null } {
  const w = extras?.staffWaivers?.[String(staffId)]?.[date];
  return { waived: !!w, reason: w?.reason ?? null };
}

/** Cùng nguồn + logic với TeamCalendar (adminLogs + teamExtras + rules). */
function buildJournalAndStaffMoney(args: {
  month: string;
  logs: AdminLog[];
  staffList: { id: number; name: string }[];
  extras: TeamExtras | undefined;
  rules: AttRules | undefined;
}): {
  entries: AttendanceJournalEntry[];
  staffMoney: Map<number, {
    name: string;
    workDays: number;
    onTimeDays: number;
    totalPenalty: number;
    totalBonus: number;
    net: number;
  }>;
} {
  const { month, logs, staffList, extras, rules } = args;
  const lateRulesRaw = extras?.lateRules ?? rules?.lateRules ?? [];
  const lateRules: LateRuleLite[] = lateRulesRaw.map((r) => ({
    lateFromTime: r.lateFromTime ?? null,
    lateToTime: r.lateToTime ?? null,
    penaltyAmount: r.penaltyAmount ?? 0,
  }));
  const checkInTo = extras?.checkInTo ?? rules?.rule?.checkinEndTime ?? "08:10";
  const weeklyBonus = extras?.weeklyOnTimeBonus ?? rules?.rule?.weeklyBonusAmount ?? 50_000;
  const shiftOverrides = extras?.shiftOverrides;

  const checkIns = logs.filter(l => l.type === "check_in");
  const entries: AttendanceJournalEntry[] = [];
  const staffMoney = new Map<number, {
    name: string;
    workDays: number;
    onTimeDays: number;
    totalPenalty: number;
    totalBonus: number;
    net: number;
  }>();

  for (const s of staffList) {
    staffMoney.set(s.id, { name: s.name, workDays: 0, onTimeDays: 0, totalPenalty: 0, totalBonus: 0, net: 0 });
  }

  const ciByStaffDate = new Map<string, AdminLog>();
  for (const l of checkIns) {
    const date = l.localDate ?? l.createdAt.slice(0, 10);
    const key = `${l.staffId}:${date}`;
    if (!ciByStaffDate.has(key)) ciByStaffDate.set(key, l);
  }

  for (const l of checkIns) {
    const date = l.localDate ?? l.createdAt.slice(0, 10);
    const key = `${l.staffId}:${date}`;
    if (ciByStaffDate.get(key)?.id !== l.id) continue;

    const staffId = Number(l.staffId);
    const staffName = l.staffName ?? staffList.find(s => s.id === staffId)?.name ?? `#${staffId}`;
    const leaves = extras?.staffLeaves?.[String(staffId)] ?? [];
    const shiftStart = resolveShiftStart(staffId, date, shiftOverrides, checkInTo);
    const { waived, reason: waiverReason } = isWaived(staffId, date, extras);
    const effTime = l.override?.time ?? l.localTime ?? "";

    const showDays = extras?.staffShowDays?.[String(staffId)] ?? [];
    const showTime = extras?.staffShowTimes?.[String(staffId)]?.[date];
    const dayStatus = resolveDayStatus({
      date,
      dayLogs: [{ type: "check_in", localTime: effTime || undefined, isOffsite: l.isOffsite, method: l.method, workType: l.workType, attendanceType: l.attendanceType }],
      shiftStart,
      lateRules,
      approvedLeaves: leaves,
      isWeekend: false,
      isFuture: false,
      hasShowBooking: showDays.includes(date),
      showTime,
      checkInTo,
    });

    let status = dayStatus.label || "Đúng giờ";
    let lateMinutes = dayStatus.lateMinutes ?? 0;
    let penaltyAmount = dayStatus.penalty ?? 0;

    if (l.override?.isLate === 0) {
      status = "Đúng giờ";
      lateMinutes = 0;
      penaltyAmount = 0;
    } else if (l.override?.isLate === 1 && dayStatus.color === "green" && effTime) {
      const forced = resolveDayStatus({
        date,
        dayLogs: [{ type: "check_in", localTime: effTime, isOffsite: l.isOffsite, method: l.method, workType: l.workType, attendanceType: l.attendanceType }],
        shiftStart,
        lateRules,
        approvedLeaves: [],
        isWeekend: false,
        isFuture: false,
        hasShowBooking: showDays.includes(date),
        showTime,
        checkInTo,
      });
      if (forced.isLate) {
        status = forced.label;
        lateMinutes = forced.lateMinutes ?? 0;
        penaltyAmount = forced.penalty ?? 0;
      } else {
        status = "Trễ nhẹ";
        lateMinutes = lateMinutesBetween(effTime, shiftStart);
        penaltyAmount = lateRules.filter(r => r.lateFromTime && r.lateFromTime > shiftStart)[0]?.penaltyAmount ?? 10_000;
      }
    }

    if (waived) {
      penaltyAmount = 0;
      if (status.startsWith("Trễ")) status = "Miễn phạt";
    }

    let notes = "";
    if (status === "Nghỉ phép") {
      notes = leaves.find(lv => lv.date === date)?.reason ?? "Nghỉ phép";
    } else if (status === "Đúng giờ") {
      notes = "Đúng giờ";
    } else if (waived) {
      notes = waiverReason ? `Đã gỡ phạt · ${waiverReason}` : "Đã gỡ phạt / Miễn phạt";
    } else if (penaltyAmount > 0) {
      notes = `Trễ ${lateMinutes} phút — phạt ${penaltyAmount.toLocaleString("vi-VN")}đ`;
    } else if (lateMinutes > 0) {
      notes = `Trễ ${lateMinutes} phút`;
    }
    if (l.override?.reason) {
      notes = notes ? `${notes} · Sửa giờ: ${l.override.reason}` : `Sửa giờ: ${l.override.reason}`;
    }
    const workNote = l.notes ? String(l.notes).trim() : "";
    if (workNote && l.isOffsite) {
      notes = notes && notes !== "Đúng giờ" ? `${notes} · ${workNote}` : workNote;
    }

    const money = staffMoney.get(staffId) ?? {
      name: staffName, workDays: 0, onTimeDays: 0, totalPenalty: 0, totalBonus: 0, net: 0,
    };
    money.workDays++;
    if (status === "Đúng giờ" || status === "Miễn phạt" || status === "Nghỉ phép") {
      if (status === "Đúng giờ" || status === "Miễn phạt") money.onTimeDays++;
    }
    if (!waived && penaltyAmount > 0) money.totalPenalty += penaltyAmount;
    staffMoney.set(staffId, money);

    entries.push({
      kind: "check_in",
      logId: l.id,
      staffId,
      staffName,
      date,
      localTime: (effTime || l.localTime) ?? null,
      method: l.method ?? null,
      attendanceType: l.attendanceType ?? null,
      isOffsite: !!l.isOffsite,
      workType: (l.workType as WorkType | null) ?? null,
      checkinPhotoUrl: l.checkinPhotoUrl ?? null,
      status,
      lateMinutes,
      penaltyAmount: waived ? 0 : penaltyAmount,
      bonusAmount: 0,
      waived,
      waiverReason,
      notes,
      override: l.override ?? null,
      createdAt: l.createdAt,
    });
  }

  const [y, mo] = month.split("-").map(Number);
  const todayStrBonus = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const daysInMonthBonus = new Date(y, mo, 0).getDate();
  // Thưởng chuyên cần CHỈ theo tuần. Tháng chia 4 tuần: [1-7][8-14][15-21][22-cuối tháng].
  // Mỗi tuần đi đủ công + đúng giờ tất cả ngày bắt buộc (bỏ CN + ≤2 ngày nghỉ phép) = +50k.
  // Tối đa 4 tuần = 200k/tháng. KHÔNG còn thưởng tháng riêng.
  const WEEK_BLOCKS: [number, number][] = [[1, 7], [8, 14], [15, 21], [22, daysInMonthBonus]];

  for (const s of staffList) {
    const leaves = extras?.staffLeaves?.[String(s.id)] ?? [];
    const excused = new Set(leaves.map(l => l.date).slice(0, 2));
    const showDaysS = extras?.staffShowDays?.[String(s.id)] ?? [];
    const ciDates = new Map<string, AdminLog>();
    for (const l of checkIns.filter(x => Number(x.staffId) === s.id)) {
      const d = l.localDate ?? l.createdAt.slice(0, 10);
      if (!ciDates.has(d)) ciDates.set(d, l);
    }
    // Ngày d có đi đúng giờ không (xanh / gỡ phạt / override đúng giờ; trễ hoặc chưa chấm = false).
    const isOnTimeDay = (d: string): boolean => {
      const ci = ciDates.get(d);
      if (!ci) return false;
      const { waived } = isWaived(s.id, d, extras);
      if (ci.override?.isLate === 0 || waived) return true;
      if (ci.override?.isLate === 1) return false;
      const effTime = ci.override?.time ?? ci.localTime ?? "";
      const st = resolveDayStatus({
        date: d,
        dayLogs: [{ type: "check_in", localTime: effTime || undefined, isOffsite: ci.isOffsite, method: ci.method, workType: ci.workType, attendanceType: ci.attendanceType }],
        shiftStart: resolveShiftStart(s.id, d, shiftOverrides, checkInTo),
        lateRules,
        approvedLeaves: [],
        isWeekend: false,
        isFuture: false,
        hasShowBooking: showDaysS.includes(d),
        showTime: extras?.staffShowTimes?.[String(s.id)]?.[d],
        checkInTo,
      });
      return st.color === "green";
    };

    const money = staffMoney.get(s.id)!;
    // Mỗi tuần đã trôi qua hết + đi đủ công đúng giờ → +50k (tối đa 4 tuần = 200k).
    for (let wi = 0; wi < WEEK_BLOCKS.length; wi++) {
      const [startD, endD] = WEEK_BLOCKS[wi];
      const lastDate = `${month}-${String(endD).padStart(2, "0")}`;
      if (lastDate > todayStrBonus) continue; // tuần chưa kết thúc → chưa xét (sửa bug phát thưởng sớm)
      const required: string[] = [];
      for (let d = startD; d <= endD; d++) {
        const date = `${month}-${String(d).padStart(2, "0")}`;
        if (new Date(`${date}T12:00:00`).getDay() === 0) continue; // Chủ Nhật off
        if (excused.has(date)) continue; // ngày nghỉ phép (≤2/tháng) được trừ
        required.push(date);
      }
      if (required.length === 0) continue;
      if (!required.every(isOnTimeDay)) continue; // trễ/vắng 1 ngày bất kỳ → mất thưởng tuần đó
      money.totalBonus += weeklyBonus;
      entries.push({
        kind: "bonus",
        logId: null,
        staffId: s.id,
        staffName: s.name,
        date: lastDate,
        localTime: null,
        method: null,
        isOffsite: false,
        workType: null,
        status: "Thưởng chuyên cần",
        lateMinutes: 0,
        penaltyAmount: 0,
        bonusAmount: weeklyBonus,
        waived: false,
        waiverReason: null,
        notes: `Thưởng chuyên cần tuần ${wi + 1} (+${weeklyBonus.toLocaleString("vi-VN")}đ)`,
        override: null,
        createdAt: `${lastDate}T23:59:00.000Z`,
      });
    }
    money.net = money.totalBonus - money.totalPenalty;
    staffMoney.set(s.id, money);
  }

  const otRate = extras?.overtimeRatePerHour ?? rules?.rule?.overtimeRatePerHour ?? 30_000;
  const forgotPenalty = extras?.checkoutRules?.forgotPenalty ?? ATTENDANCE_CHECKOUT_RULES.forgotPenalty;
  const otLogs = logs
    .filter(l => l.type === "overtime_check_in" || l.type === "overtime_check_out")
    .map(l => ({
      staffId: Number(l.staffId),
      staffName: l.staffName,
      date: l.localDate ?? l.createdAt.slice(0, 10),
      type: l.type,
      time: l.localTime ?? "",
    }))
    .filter(l => l.time);
  for (const sess of computeOvertimeSessions(otLogs, otRate)) {
    const money = staffMoney.get(sess.staffId) ?? {
      name: sess.staffName ?? `#${sess.staffId}`,
      workDays: 0, onTimeDays: 0, totalPenalty: 0, totalBonus: 0, net: 0,
    };
    if (sess.status === "valid" && sess.pay > 0) {
      money.totalBonus += sess.pay;
      money.net = money.totalBonus - money.totalPenalty;
    }
    staffMoney.set(sess.staffId, money);
    const hoursLabel = sess.hours > 0 ? `${sess.hours} giờ` : "—";
    entries.push({
      kind: "overtime",
      logId: null,
      staffId: sess.staffId,
      staffName: sess.staffName ?? money.name,
      date: sess.date,
      localTime: sess.startTime,
      method: null,
      isOffsite: false,
      workType: null,
      status: sess.status === "valid" ? `Tăng ca ${hoursLabel}` : sess.statusLabel,
      lateMinutes: 0,
      penaltyAmount: 0,
      bonusAmount: sess.pay,
      waived: false,
      waiverReason: null,
      notes:
        sess.status === "valid"
          ? `${sess.startTime ?? "?"}–${sess.endTime ?? "?"} · ${sess.statusLabel}`
          : sess.status === "missing_checkout"
            ? "Có bắt đầu tăng ca, chưa kết thúc"
            : "Vượt quá 5 giờ/phiên",
      override: null,
      createdAt: `${sess.date}T${(sess.endTime ?? sess.startTime ?? "20:00").replace(":", "")}00.000Z`,
    });
  }

  for (const [, ci] of ciByStaffDate) {
    const staffId = Number(ci.staffId);
    const date = ci.localDate ?? ci.createdAt.slice(0, 10);
    if (!requiresManualCheckout(ci)) continue;
    if (hasCheckOutOnDate(logs, staffId, date)) continue;
    if (!shouldAssessForgotCheckout(date)) continue;
    const staffName = ci.staffName ?? staffList.find(s => s.id === staffId)?.name ?? `#${staffId}`;
    const money = staffMoney.get(staffId) ?? {
      name: staffName, workDays: 0, onTimeDays: 0, totalPenalty: 0, totalBonus: 0, net: 0,
    };
    money.totalPenalty += forgotPenalty;
    money.net = money.totalBonus - money.totalPenalty;
    staffMoney.set(staffId, money);
    entries.push({
      kind: "forgot_checkout",
      logId: null,
      staffId,
      staffName,
      date,
      localTime: null,
      method: null,
      isOffsite: false,
      workType: null,
      status: "Quên check-out",
      lateMinutes: 0,
      penaltyAmount: forgotPenalty,
      bonusAmount: 0,
      waived: false,
      waiverReason: null,
      notes: `Không check-out sau ${extras?.checkoutRules?.checkoutUntil ?? ATTENDANCE_CHECKOUT_RULES.checkoutUntil} · ngày công vẫn tính (ra ${ATTENDANCE_CHECKOUT_RULES.officialEnd})`,
      override: null,
      createdAt: `${date}T19:05:00.000Z`,
    });
  }

  // Điều chỉnh thủ công từ DB (admin sửa tiền — không đụng giờ)
  for (const [sidStr, adjs] of Object.entries(extras?.staffAdjustments ?? {})) {
    const staffId = parseInt(sidStr);
    const staffName = staffList.find(s => s.id === staffId)?.name ?? `#${staffId}`;
    for (const adj of adjs) {
      if (adj.category === "waiver") continue; // đã tính qua isWaived
      const money = staffMoney.get(staffId) ?? {
        name: staffName, workDays: 0, onTimeDays: 0, totalPenalty: 0, totalBonus: 0, net: 0,
      };
      if (adj.type === "bonus") {
        money.totalBonus += adj.amount;
        entries.push({
          kind: "bonus",
          logId: null,
          staffId,
          staffName,
          date: adj.date,
          localTime: null,
          method: null,
          isOffsite: false,
          workType: null,
          status: adj.category === "manual_edit" ? "Điều chỉnh thưởng" : "Thưởng",
          lateMinutes: 0,
          penaltyAmount: 0,
          bonusAmount: adj.amount,
          waived: false,
          waiverReason: null,
          notes: `${adj.reason ?? "Điều chỉnh"} · ${adj.createdByName ?? "Admin"} · ${String(adj.createdAt).slice(0, 16)}`,
          override: null,
          createdAt: adj.createdAt || `${adj.date}T12:00:00.000Z`,
        });
      } else if (adj.type === "penalty") {
        money.totalPenalty += adj.amount;
        entries.push({
          kind: "check_in",
          logId: null,
          staffId,
          staffName,
          date: adj.date,
          localTime: null,
          method: null,
          isOffsite: false,
          workType: null,
          status: "Phạt thủ công",
          lateMinutes: 0,
          penaltyAmount: adj.amount,
          bonusAmount: 0,
          waived: false,
          waiverReason: null,
          notes: `${adj.reason ?? "Điều chỉnh phạt"} · ${adj.createdByName ?? "Admin"} · ${String(adj.createdAt).slice(0, 16)}`,
          override: null,
          createdAt: adj.createdAt || `${adj.date}T12:00:00.000Z`,
        });
      }
      money.net = money.totalBonus - money.totalPenalty;
      staffMoney.set(staffId, money);
    }
  }

  // Trừ phần waiver khỏi totalPenalty (bonus bù đã cộng ở trên nếu manual_edit)
  for (const [sidStr, dates] of Object.entries(extras?.staffWaivers ?? {})) {
    const staffId = parseInt(sidStr);
    const money = staffMoney.get(staffId);
    if (!money) continue;
    for (const [date, w] of Object.entries(dates)) {
      const waivedAmt = w.amount ?? 0;
      if (waivedAmt > 0) {
        money.totalBonus += waivedAmt;
        money.net = money.totalBonus - money.totalPenalty;
      }
    }
    staffMoney.set(staffId, money);
  }

  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { entries, staffMoney };
}

function lateMinutesBetween(localTime: string, shiftStart: string): number {
  const [sh, sm] = shiftStart.split(":").map(Number);
  const [ch, cm] = localTime.split(":").map(Number);
  return Math.max(0, ch * 60 + cm - (sh * 60 + sm));
}

// Chấm trễ cho Show ngoài: so giờ chấm với giờ hẹn chụp (showTime). Quy tắc trễ
// (theo giờ tuyệt đối quanh checkInTo) được quy về OFFSET phút rồi áp lên showTime.
// Mirror backend computeShowLateness. tierIdx: 0=vàng, 1=cam, >=2=đỏ.
function computeShowLatenessFE(
  checkIn: string, showTime: string, lateRules: LateRuleLite[], checkInTo: string,
): { isLate: boolean; penalty: number; tierIdx: number; lateMinutes: number } {
  if (!checkIn || !showTime) return { isLate: false, penalty: 0, tierIdx: -1, lateMinutes: 0 };
  const lateMinutes = lateMinutesBetween(checkIn, showTime);
  if (checkIn <= showTime || lateMinutes <= 0) return { isLate: false, penalty: 0, tierIdx: -1, lateMinutes: 0 };
  const anchor = (() => { const [h, m] = checkInTo.split(":").map(Number); return (h || 0) * 60 + (m || 0); })();
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const bands = lateRules
    .filter(r => r.lateFromTime)
    .map(r => ({
      fromOff: Math.max(1, toMin(r.lateFromTime!) - anchor),
      toOff: r.lateToTime ? toMin(r.lateToTime) - anchor : null,
      penalty: r.penaltyAmount ?? 0,
    }))
    .sort((a, b) => a.fromOff - b.fromOff);
  if (bands.length === 0) return { isLate: true, penalty: 0, tierIdx: 0, lateMinutes };
  let tierIdx = -1;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (lateMinutes >= b.fromOff && (b.toOff === null || lateMinutes <= b.toOff)) { tierIdx = i; break; }
  }
  if (tierIdx === -1) tierIdx = bands.length - 1;
  return { isLate: true, penalty: bands[tierIdx]?.penalty ?? 0, tierIdx, lateMinutes };
}

// Resolve shift start cho 1 staff ngày cụ thể: scope=selected match > scope=all > default.
function resolveShiftStart(
  staffId: number, date: string, overrides: ShiftOverrideLite[] | undefined, fallback: string
): string {
  if (!overrides?.length) return fallback;
  const dayOvs = overrides.filter(o => o.date === date);
  for (const o of dayOvs) if (o.scope === "selected" && o.staffIds.includes(staffId)) return o.startTime;
  for (const o of dayOvs) if (o.scope === "all") return o.startTime;
  return fallback;
}

// ─── Task #508: DayStatus resolver + color map ────────────────────────────────
type AttendanceMode = "SHOW" | "STUDIO" | "OFF";
type DayColor = "green" | "yellow" | "orange" | "red" | "red-dark" | "slate" | "blue" | "blank";
type DayStatus = {
  date: string;
  color: DayColor;
  label: string;
  attendanceMode?: AttendanceMode;
  checkIn?: string;
  checkOut?: string;
  isLate?: boolean;
  lateMinutes?: number;
  penalty?: number;
  otHours?: number;
  otAmount?: number;
  isLeave?: boolean;
  leaveReason?: string;
  isWeekend?: boolean;
  isFuture?: boolean;
  requiresCheckout?: boolean;
};

const DAY_COLOR_CLS: Record<DayColor, string> = {
  green:      "bg-green-100  dark:bg-green-900/30  text-green-800  dark:text-green-200 border-green-200  dark:border-green-800",
  yellow:     "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 border-yellow-200 dark:border-yellow-800",
  orange:     "bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200 border-orange-200 dark:border-orange-800",
  red:        "bg-red-100    dark:bg-red-900/30    text-red-800    dark:text-red-200    border-red-200    dark:border-red-800",
  "red-dark": "bg-red-200    dark:bg-red-900/60    text-red-900    dark:text-red-100    border-red-300    dark:border-red-700",
  slate:      "bg-slate-100  dark:bg-slate-800/40  text-slate-600  dark:text-slate-400 border-slate-200  dark:border-slate-700",
  blue:       "bg-sky-100   dark:bg-sky-900/30   text-sky-800   dark:text-sky-200   border-sky-200   dark:border-sky-800",
  blank:      "bg-card border-border text-muted-foreground",
};

function resolveDayStatus(args: {
  date: string;
  dayLogs: { type: string; localTime?: string; isOffsite?: boolean; method?: string | null; workType?: WorkType | null; attendanceType?: string | null }[];
  shiftStart: string;
  lateRules: LateRuleLite[];
  approvedLeaves: ApprovedLeaveLite[];
  overtime?: OvertimeByDateItem;
  isWeekend: boolean;
  isFuture: boolean;
  hasShowBooking?: boolean;
  showTime?: string;
  checkInTo?: string;
}): DayStatus {
  const { date, dayLogs, shiftStart, lateRules, approvedLeaves, overtime, isWeekend, isFuture, hasShowBooking, showTime, checkInTo } = args;
  const ci = dayLogs.find(l => l.type === "check_in");
  const co = dayLogs.find(l => l.type === "check_out");
  const checkIn = ci?.localTime;
  const checkOut = co?.localTime;
  const requiresCheckout = requiresManualCheckout(ci as Pick<LogEntry, "method" | "attendanceType" | "workType" | "isOffsite"> | null);
  const otHours = overtime?.hours;
  const otAmount = overtime?.amount ?? overtime?.pay;

  const leave = approvedLeaves.find(l => l.date === date);
  if (leave) {
    return { date, color: "slate", label: "Off Day", attendanceMode: "OFF", checkIn, checkOut, isLeave: true, leaveReason: leave.reason, otHours, otAmount, requiresCheckout };
  }
  if (isWeekend && !isFuture) {
    return { date, color: "slate", label: "Off Day", attendanceMode: "OFF", isWeekend: true, otHours, otAmount };
  }

  const mode: AttendanceMode = hasShowBooking ? "SHOW" : "STUDIO";

  if (mode === "SHOW") {
    // Show ngoài: nhân viên chấm GPS+selfie → tính trễ theo giờ hẹn chụp (showTime).
    if (!checkIn) {
      if (isFuture) return { date, color: "blank", label: "", isFuture: true, attendanceMode: "SHOW" };
      return { date, color: "blue", label: "Show Day", attendanceMode: "SHOW", isLate: false, otHours, otAmount, requiresCheckout };
    }
    if (!showTime) {
      // Không có giờ hẹn để so → coi đúng giờ.
      return { date, color: "green", label: "Show — đúng giờ", attendanceMode: "SHOW", checkIn, checkOut, isLate: false, otHours, otAmount, requiresCheckout };
    }
    const sl = computeShowLatenessFE(checkIn, showTime, lateRules, checkInTo ?? shiftStart);
    if (!sl.isLate) {
      return { date, color: "green", label: "Show — đúng giờ", attendanceMode: "SHOW", checkIn, checkOut, isLate: false, otHours, otAmount, requiresCheckout };
    }
    const showColor: DayColor = sl.tierIdx === 0 ? "yellow" : sl.tierIdx === 1 ? "orange" : "red";
    const showLabel = sl.tierIdx === 0 ? "Show trễ nhẹ" : sl.tierIdx === 1 ? "Show trễ vừa" : "Show trễ nặng";
    return {
      date, color: showColor, label: showLabel, attendanceMode: "SHOW",
      checkIn, checkOut, isLate: true, lateMinutes: sl.lateMinutes, penalty: sl.penalty,
      otHours, otAmount, requiresCheckout,
    };
  }

  if (checkIn) {
    const sorted = [...lateRules]
      .filter(r => r.lateFromTime && r.lateFromTime > shiftStart)
      .sort((a, b) => (a.lateFromTime ?? "").localeCompare(b.lateFromTime ?? ""));
    const isLate = checkIn > shiftStart;
    if (!isLate) {
      return { date, color: "green", label: "Studio Day", attendanceMode: "STUDIO", checkIn, checkOut, isLate: false, otHours, otAmount, requiresCheckout };
    }
    let tierIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const from = r.lateFromTime!;
      const to = r.lateToTime;
      if (checkIn >= from && (to === null || checkIn <= to)) { tierIdx = i; break; }
    }
    if (tierIdx === -1) tierIdx = Math.max(0, sorted.length - 1);
    const [sh, sm] = shiftStart.split(":").map(Number);
    const [ch, cm] = checkIn.split(":").map(Number);
    const lateMinutes = Math.max(0, (ch * 60 + cm) - (sh * 60 + sm));
    const penalty = sorted[tierIdx]?.penaltyAmount ?? 0;
    const color: DayColor = tierIdx === 0 ? "yellow" : tierIdx === 1 ? "orange" : "red";
    const label = tierIdx === 0 ? "Trễ nhẹ" : tierIdx === 1 ? "Trễ vừa" : "Trễ nặng";
    return { date, color, label, attendanceMode: "STUDIO", checkIn, checkOut, isLate: true, lateMinutes, penalty, otHours, otAmount, requiresCheckout };
  }

  if (isFuture) return { date, color: "blank", label: "", isFuture: true, attendanceMode: "STUDIO" };
  return { date, color: "red-dark", label: "Vắng", attendanceMode: "STUDIO" };
}

function buildMonthDayStatuses(args: {
  month: string;
  logs: LogEntry[];
  shifts?: Record<string, ShiftInfoLite>;
  defaultShiftStart: string;
  lateRules: LateRuleLite[];
  approvedLeaves: ApprovedLeaveLite[];
  overtimeByDate: OvertimeByDateItem[];
  showDayDates?: string[];
  showTimes?: Record<string, string>;
}): DayStatus[] {
  const { month, logs, shifts, defaultShiftStart, lateRules, approvedLeaves, overtimeByDate, showDayDates, showTimes } = args;
  const showSet = new Set(showDayDates ?? []);
  const [y, m] = month.split("-").map(Number);
  const total = new Date(y, m, 0).getDate();
  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const otMap = new Map(overtimeByDate.map(o => [o.date, o]));
  const out: DayStatus[] = [];
  for (let d = 1; d <= total; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const dt = new Date(`${date}T00:00:00`);
    const dow = dt.getDay();
    const isWeekend = dow === 0; // Sunday off; T7 vẫn làm theo studio
    const isFuture = date > todayStr;
    const dayLogs = logs.filter(l => (l.localDate ?? l.createdAt.slice(0, 10)) === date);
    const shiftStart = shifts?.[date]?.startTime ?? defaultShiftStart;
    out.push(resolveDayStatus({
      date, dayLogs, shiftStart, lateRules, approvedLeaves,
      overtime: otMap.get(date),
      isWeekend, isFuture,
      hasShowBooking: showSet.has(date),
      showTime: showTimes?.[date],
      checkInTo: defaultShiftStart,
    }));
  }
  return out;
}

type ShiftOverride = {
  id: number; date: string; name: string;
  startTime: string; endTime: string;
  standardHours: number; flexibleBreakHours: number;
  notes: string | null; scope: "all" | "selected";
  staffIds: number[];
  createdBy?: number | null; createdByName?: string | null;
};

type LateRule = {
  id?: number;
  lateFromTime: string;
  lateToTime: string | null;
  penaltyAmount: number | null;
};

type AttRules = {
  rule: {
    id?: number;
    name?: string;
    checkinStartTime: string;
    checkinEndTime: string;
    workStartTime?: string;
    checkoutTime?: string;
    weeklyBonusAmount: number;
    overtimeRatePerHour?: number;
    isActive?: number;
  } | null;
  lateRules: LateRule[];
};

type AdminLog = LogEntry & { staffName: string };

type StaffInfo = {
  id: number;
  name: string;
  role: string;
  staffType?: string;
  roles?: string[];
  username?: string;
  isAdmin?: boolean;
};

const QUICK_OVERRIDE_REASONS = [
  "Đi show tỉnh, về trễ",
  "Quét QR lỗi do mạng",
  "Lỗi GPS, đã có mặt tại studio",
  "Duyệt đi trễ có lý do chính đáng",
  "Sửa giờ do nhân viên báo lại",
];

// ─── Task #508: Visual Calendar + Summary + Legend + Team Matrix ────────────
const STATUS_LEGEND: { color: DayColor; label: string }[] = [
  { color: "blue",     label: "Show Day (đi show / makeup)" },
  { color: "green",    label: "Studio Day — đúng giờ" },
  { color: "yellow",   label: "Studio Day — trễ nhẹ" },
  { color: "orange",   label: "Studio Day — trễ vừa" },
  { color: "red",      label: "Studio Day — trễ nặng" },
  { color: "red-dark", label: "Studio Day — vắng" },
  { color: "slate",    label: "Off Day (nghỉ phép / CN)" },
];

function StatusLegend() {
  return (
    <div className="flex flex-wrap gap-3 mt-2 text-[11px] text-muted-foreground">
      {STATUS_LEGEND.map(s => (
        <span key={s.color} className="flex items-center gap-1.5">
          <span className={`w-3 h-3 rounded border ${DAY_COLOR_CLS[s.color]}`} />
          {s.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded border-2 border-purple-400 bg-card" />
        Có tăng ca (OT)
      </span>
    </div>
  );
}

function SummaryStrip({ days, penaltyTotal }: { days: DayStatus[]; penaltyTotal?: number }) {
  const stats = {
    show: days.filter(d => d.attendanceMode === "SHOW").length,
    onTime: days.filter(d => d.color === "green").length,
    late: days.filter(d => d.color === "yellow" || d.color === "orange" || d.color === "red").length,
    leave: days.filter(d => d.attendanceMode === "OFF").length,
    absent: days.filter(d => d.color === "red-dark").length,
    otHours: days.reduce((s, d) => s + (d.otHours ?? 0), 0),
    otAmount: days.reduce((s, d) => s + (d.otAmount ?? 0), 0),
    penalty: penaltyTotal ?? days.reduce((s, d) => s + (d.penalty ?? 0), 0),
  };
  const chip = (cls: string, label: string, val: string) => (
    <div className={`rounded-lg px-2.5 py-1.5 border text-center ${cls}`}>
      <div className="text-[10px] font-medium opacity-80">{label}</div>
      <div className="text-sm font-bold leading-tight">{val}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-3 sm:grid-cols-7 gap-1.5">
      {chip(DAY_COLOR_CLS.blue,       "Show Day", String(stats.show))}
      {chip(DAY_COLOR_CLS.green,      "Studio OK", String(stats.onTime))}
      {chip(DAY_COLOR_CLS.yellow,     "Studio trễ", String(stats.late))}
      {chip(DAY_COLOR_CLS.slate,      "Off Day", String(stats.leave))}
      {chip(DAY_COLOR_CLS["red-dark"], "Studio vắng", String(stats.absent))}
      {chip("bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900",
        "Phạt", stats.penalty > 0 ? vnd(stats.penalty) : "0đ")}
      {chip("bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border-purple-300 dark:border-purple-800",
        "Tăng ca", stats.otHours > 0 ? `${stats.otHours}h · ${vnd(stats.otAmount)}` : "—")}
    </div>
  );
}

function VisualCalendar({ month, days, onClickDay }: {
  month: string; days: DayStatus[]; onClickDay?: (d: DayStatus) => void;
}) {
  const [y, m] = month.split("-").map(Number);
  const firstDow = new Date(y, m - 1, 1).getDay(); // 0=CN
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(<div key={`e${i}`} />);
  days.forEach((d, idx) => {
    const day = parseInt(d.date.slice(8, 10), 10);
    const hasOT = (d.otHours ?? 0) > 0;
    const cls = DAY_COLOR_CLS[d.color];
    cells.push(
      <button
        key={d.date}
        type="button"
        onClick={() => onClickDay?.(d)}
        className={`relative aspect-square sm:aspect-[5/4] flex flex-col items-stretch justify-between rounded-lg border p-1 text-left transition-shadow hover:shadow-md hover:scale-[1.02] ${cls} ${hasOT ? "ring-2 ring-purple-400 dark:ring-purple-500" : ""}`}
        title={`${d.date} — ${d.label}`}
        data-testid={`cal-day-${idx + 1}`}
      >
        <div className="flex items-start justify-between">
          <span className="text-[11px] font-bold leading-none">{day}</span>
          {hasOT && (
            <span className="text-[9px] font-bold px-1 py-0 rounded bg-purple-500 text-white leading-tight">OT</span>
          )}
        </div>
        <div className="flex-1 flex flex-col justify-end gap-0.5 min-h-0">
          {d.checkIn && (
            <div className="text-[10px] font-mono leading-tight truncate">
              {d.checkIn}{d.checkOut ? `→${d.checkOut}` : ""}
            </div>
          )}
          {!d.isFuture && (
            <div className="text-[9px] font-semibold leading-tight truncate opacity-90">{d.label}</div>
          )}
          {d.isLate && d.lateMinutes ? (
            <div className="text-[9px] leading-tight">trễ {d.lateMinutes}p{d.penalty ? ` · ${vnd(d.penalty)}` : ""}</div>
          ) : null}
          {hasOT && (
            <div className="text-[9px] leading-tight text-purple-700 dark:text-purple-300 font-semibold">+{d.otHours}h · {vnd(d.otAmount ?? 0)}</div>
          )}
        </div>
      </button>
    );
  });
  return (
    <div>
      <div className="grid grid-cols-7 gap-1 mb-1">
        {["CN", "T2", "T3", "T4", "T5", "T6", "T7"].map(d => (
          <div key={d} className="text-center text-[10px] font-bold text-muted-foreground py-1">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">{cells}</div>
    </div>
  );
}

type TeamDayRow = { staff: { id: number; name: string }; status: DayStatus };

/** Đúng giờ trước (sớm nhất) → trễ → vắng → nghỉ phép. */
function sortTeamDayRows(rows: TeamDayRow[]): TeamDayRow[] {
  const rank = (s: DayStatus): number => {
    if (s.attendanceMode === "OFF" || s.isLeave) return 3;
    if (s.color === "red-dark") return 2;
    if (s.isLate || s.color === "yellow" || s.color === "orange" || s.color === "red") return 1;
    return 0;
  };
  return [...rows].sort((a, b) => {
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    const ta = a.status.checkIn ?? (ra >= 2 ? "99:99" : "");
    const tb = b.status.checkIn ?? (rb >= 2 ? "99:99" : "");
    if (ta !== tb) return ta.localeCompare(tb);
    return a.staff.name.localeCompare(b.staff.name, "vi");
  });
}

function teamDayDisplayStatus(
  status: DayStatus,
  staffId: number,
  date: string,
  dayLogs: { type: string; localDate?: string; createdAt: string; staffId?: number; isOffsite?: boolean; method?: string | null; workType?: WorkType | null; attendanceType?: string | null }[],
): string {
  if (status.attendanceMode === "OFF" || status.isLeave) return "Off Day";
  if (status.attendanceMode === "SHOW") return status.checkIn ? `Show Day · ${status.checkIn}` : "Show Day";
  if (status.color === "red-dark") return "Vắng";
  if (status.checkIn) {
    const logs = dayLogs.map(l => ({
      staffId: Number(l.staffId ?? staffId),
      type: l.type,
      localDate: l.localDate,
      createdAt: l.createdAt,
    }));
    const ci = dayLogs.find(l => l.type === "check_in");
    if (requiresManualCheckout(ci as Pick<LogEntry, "method" | "attendanceType" | "workType" | "isOffsite"> | null) && !hasCheckOutOnDate(logs, staffId, date) && shouldAssessForgotCheckout(date)) {
      return "Quên check-out";
    }
    return status.label || "Đúng giờ";
  }
  return status.label || "—";
}

function TeamDayDetailModal({
  date,
  rows,
  logsByStaff,
  onClose,
  onStaffClick,
}: {
  date: string;
  rows: TeamDayRow[];
  logsByStaff: Map<number, { type: string; localTime?: string; localDate?: string; createdAt: string; staffId?: number }[]>;
  onClose: () => void;
  onStaffClick: (staffId: number, staffName: string) => void;
}) {
  const [dd, mm, yyyy] = date.split("-").reverse();
  const sorted = sortTeamDayRows(rows);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] bg-background rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div>
            <h3 className="font-semibold text-sm">Chi tiết ngày {dd}/{mm}/{yyyy}</h3>
            <p className="text-xs text-muted-foreground">{sorted.length} nhân viên</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-muted">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 divide-y divide-border">
          {sorted.map(({ staff, status }) => {
            const dayLogs = logsByStaff.get(staff.id) ?? [];
            const label = teamDayDisplayStatus(status, staff.id, date, dayLogs);
            const penalty = status.penalty ?? 0;
            const bonus = (status.otAmount ?? 0) > 0 ? status.otAmount! : 0;
            return (
              <button
                key={staff.id}
                type="button"
                className="w-full text-left px-4 py-3 hover:bg-muted/30 transition-colors"
                onClick={() => { onStaffClick(staff.id, staff.name); onClose(); }}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-sm">{staff.name}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${STATUS_BADGE[label] ?? "bg-muted text-muted-foreground"}`}>
                    {label}
                  </span>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Giờ vào: <b className="text-foreground font-mono">{status.checkIn ?? "—"}</b></span>
                  <span>Giờ ra: <b className="text-foreground font-mono">{status.checkOut ?? "—"}</b></span>
                  <span>Phút trễ: <b className="text-foreground">{status.lateMinutes ?? 0}</b></span>
                  <span>
                    Phạt/thưởng:{" "}
                    <b className={penalty > 0 ? "text-red-600" : bonus > 0 ? "text-green-600" : "text-foreground"}>
                      {penalty > 0 ? `−${vnd(penalty)}` : bonus > 0 ? `+${vnd(bonus)}` : "0đ"}
                    </b>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Mỗi NV 1 thanh ngang trong ô ngày của TeamCalendar.
function StaffBar({ staff, status, onClick }: {
  staff: { id: number; name: string };
  status: DayStatus;
  onClick: (e: MouseEvent) => void;
}) {
  const cls = DAY_COLOR_CLS[status.color];
  const hasOT = (status.otHours ?? 0) > 0;
  const parts = staff.name.trim().split(/\s+/);
  const short = parts.length > 1 ? parts[parts.length - 1] : staff.name; // tên cuối
  let meta = "";
  if (status.isLeave) meta = "Nghỉ phép";
  else if (status.color === "red-dark") meta = "Vắng";
  else if (status.checkIn) {
    meta = status.checkIn + (status.checkOut ? `–${status.checkOut}` : " · quên ra");
    if (status.isLate && status.lateMinutes) meta += ` ·${status.lateMinutes}p`;
  }
  if (status.checkIn && !status.checkOut && !status.requiresCheckout) {
    meta = `${status.checkIn} · 18:00`;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-1.5 py-0.5 min-h-[18px] rounded text-[10px] leading-tight border ${cls} ${hasOT ? "ring-1 ring-purple-400 dark:ring-purple-500" : ""} hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-blue-400 truncate flex items-center gap-1`}
      aria-label={`${staff.name}, ${status.label}${status.checkIn ? `, vào ${status.checkIn}` : ""}${status.checkOut ? `, ra ${status.checkOut}` : ""}`}
      title={`${staff.name} · ${status.label}${status.checkIn ? ` · ${status.checkIn}${status.checkOut ? "–" + status.checkOut : ""}` : ""}${hasOT ? ` · OT ${status.otHours}h` : ""}`}
      data-testid={`team-bar-${staff.id}-${status.date}`}
    >
      <span className="font-bold uppercase truncate max-w-[55%]">{short}</span>
      {meta && <span className="opacity-90 truncate flex-1 font-mono">{meta}</span>}
      {hasOT && <span className="font-bold text-purple-700 dark:text-purple-300 shrink-0">OT</span>}
    </button>
  );
}

// Lịch team theo tháng — mỗi ô ngày stack nhiều thanh NV.
function TeamCalendar({ month, staffList, logsByStaff, extras, onClickStaffDay, maxBars = 4 }: {
  month: string;
  staffList: { id: number; name: string }[];
  logsByStaff: Map<number, { type: string; localTime?: string; localDate?: string; createdAt: string; isOffsite?: boolean; method?: string | null; workType?: WorkType | null; attendanceType?: string | null }[]>;
  extras: TeamExtras | undefined;
  onClickStaffDay: (staffId: number, staffName: string, date: string) => void;
  maxBars?: number;
}) {
  const [y, m] = month.split("-").map(Number);
  const total = new Date(y, m, 0).getDate();
  const firstDow = new Date(y, m - 1, 1).getDay();
  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const lateRules = extras?.lateRules ?? [];
  const defaultShiftStart = extras?.checkInTo ?? "08:10";
  const shiftOverrides = extras?.shiftOverrides;
  const [dayModal, setDayModal] = useState<{ date: string; rows: TeamDayRow[] } | null>(null);

  // Pre-compute statuses per date (memoized — chỉ recompute khi data đổi)
  const { byDate, monthSummary } = useMemo(() => {
  const byDate = new Map<string, TeamDayRow[]>();
  const monthSummary = { show: 0, onTime: 0, late: 0, absent: 0, leave: 0 };
  // Pre-group logs by staff+date once
  const logsByStaffDate = new Map<number, Map<string, { type: string; localTime?: string; localDate?: string; createdAt: string; isOffsite?: boolean; method?: string | null; workType?: WorkType | null; attendanceType?: string | null }[]>>();
  for (const [sid, logs] of logsByStaff) {
    const m = new Map<string, typeof logs>();
    for (const l of logs) {
      const dt = l.localDate ?? l.createdAt.slice(0, 10);
      const arr = m.get(dt) ?? [];
      arr.push(l);
      m.set(dt, arr);
    }
    logsByStaffDate.set(sid, m);
  }
  // Pre-build OT map per staff
  const otByStaff = new Map<number, Map<string, OvertimeByDateItem>>();
  for (const s of staffList) {
    const otList = extras?.staffOvertime?.[String(s.id)] ?? [];
    otByStaff.set(s.id, new Map(otList.map(o => [o.date, o])));
  }
  for (let d = 1; d <= total; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const dt = new Date(`${date}T00:00:00`);
    const dow = dt.getDay();
    const isWeekend = dow === 0;
    const isFuture = date > todayStr;
    const rows: { staff: { id: number; name: string }; status: DayStatus }[] = [];
    for (const s of staffList) {
      const leaves = extras?.staffLeaves?.[String(s.id)] ?? [];
      const dayLogs = logsByStaffDate.get(s.id)?.get(date) ?? [];
      const shiftStartForDay = resolveShiftStart(s.id, date, shiftOverrides, defaultShiftStart);
      const showDays = extras?.staffShowDays?.[String(s.id)] ?? [];
      const status = resolveDayStatus({
        date,
        dayLogs: dayLogs.map(l => ({ type: l.type, localTime: l.localTime, isOffsite: l.isOffsite, method: l.method, workType: l.workType, attendanceType: l.attendanceType })),
        shiftStart: shiftStartForDay, lateRules, approvedLeaves: leaves,
        overtime: otByStaff.get(s.id)?.get(date), isWeekend, isFuture,
        hasShowBooking: showDays.includes(date),
        showTime: extras?.staffShowTimes?.[String(s.id)]?.[date],
        checkInTo: defaultShiftStart,
      });
      rows.push({ staff: s, status });
      if (!isFuture && !isWeekend) {
        if (status.attendanceMode === "SHOW") monthSummary.show++;
        else if (status.color === "green") monthSummary.onTime++;
        else if (status.color === "yellow" || status.color === "orange" || status.color === "red") monthSummary.late++;
        else if (status.color === "red-dark") monthSummary.absent++;
        else if (status.attendanceMode === "OFF" || status.isLeave) monthSummary.leave++;
      }
    }
    byDate.set(date, sortTeamDayRows(rows));
  }
  return { byDate, monthSummary };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, total, staffList, logsByStaff, extras, defaultShiftStart, shiftOverrides, lateRules, todayStr]);

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(<div key={`e${i}`} />);
  for (let d = 1; d <= total; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const dt = new Date(`${date}T00:00:00`);
    const dow = dt.getDay();
    const isSun = dow === 0;
    const isToday = date === todayStr;
    const isFuture = date > todayStr;
    const rows = byDate.get(date) ?? [];
    const visible = isFuture ? [] : rows.slice(0, maxBars);
    const hidden = isFuture ? 0 : Math.max(0, rows.length - visible.length);
    const openDayModal = () => {
      if (rows.length > 0) setDayModal({ date, rows });
    };

    cells.push(
      <div
        key={d}
        role={!isFuture && rows.length > 0 ? "button" : undefined}
        tabIndex={!isFuture && rows.length > 0 ? 0 : undefined}
        onClick={!isFuture && rows.length > 0 ? openDayModal : undefined}
        onKeyDown={e => {
          if (!isFuture && rows.length > 0 && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            openDayModal();
          }
        }}
        className={`rounded-lg border p-1 flex flex-col gap-0.5 transition-colors min-h-[108px] max-h-[108px] overflow-hidden ${isToday ? "border-blue-500 ring-1 ring-blue-300 dark:ring-blue-700" : "border-border"} ${isSun ? "bg-slate-50/60 dark:bg-slate-900/30" : "bg-card"} ${!isFuture && rows.length > 0 ? "cursor-pointer hover:bg-muted/20" : ""}`}
      >
        <div className="flex items-center justify-between px-0.5 shrink-0">
          <span className={`text-xs font-bold leading-none ${isSun ? "text-red-500" : isToday ? "text-blue-600" : "text-foreground"}`}>{d}</span>
          {isToday && <span className="text-[8px] font-bold px-1 rounded bg-blue-500 text-white leading-tight">HÔM NAY</span>}
        </div>
        {isFuture ? null : (
          <div className="flex flex-col gap-[2px] flex-1 min-h-0 overflow-hidden">
            {visible.map(({ staff, status }) => (
              <StaffBar
                key={staff.id}
                staff={staff}
                status={{ ...status, date }}
                onClick={e => {
                  e.stopPropagation();
                  onClickStaffDay(staff.id, staff.name, date);
                }}
              />
            ))}
            {hidden > 0 && (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  openDayModal();
                }}
                className="text-[9px] text-primary hover:underline text-left px-1 font-semibold shrink-0"
              >
                +{hidden} người nữa
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b flex items-center gap-2 flex-wrap">
        <Users className="w-4 h-4 text-blue-600" />
        <span className="font-semibold text-sm">Lịch team — Tháng {month.slice(5)}/{month.slice(0, 4)}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{staffList.length} NV · click vào thanh để xem chi tiết</span>
      </div>
      <div className="px-3 pt-3">
        <div className="grid grid-cols-5 gap-1.5 mb-3">
          <div className={`rounded-lg px-2 py-1.5 border text-center ${DAY_COLOR_CLS.blue}`}>
            <div className="text-[10px] opacity-80 font-medium">Show Day</div>
            <div className="text-sm font-bold leading-tight">{monthSummary.show}</div>
          </div>
          <div className={`rounded-lg px-2 py-1.5 border text-center ${DAY_COLOR_CLS.green}`}>
            <div className="text-[10px] opacity-80 font-medium">Studio OK</div>
            <div className="text-sm font-bold leading-tight">{monthSummary.onTime}</div>
          </div>
          <div className={`rounded-lg px-2 py-1.5 border text-center ${DAY_COLOR_CLS.yellow}`}>
            <div className="text-[10px] opacity-80 font-medium">Studio trễ</div>
            <div className="text-sm font-bold leading-tight">{monthSummary.late}</div>
          </div>
          <div className={`rounded-lg px-2 py-1.5 border text-center ${DAY_COLOR_CLS["red-dark"]}`}>
            <div className="text-[10px] opacity-80 font-medium">Studio vắng</div>
            <div className="text-sm font-bold leading-tight">{monthSummary.absent}</div>
          </div>
          <div className={`rounded-lg px-2 py-1.5 border text-center ${DAY_COLOR_CLS.slate}`}>
            <div className="text-[10px] opacity-80 font-medium">Off Day</div>
            <div className="text-sm font-bold leading-tight">{monthSummary.leave}</div>
          </div>
        </div>
      </div>
      <div className="p-2 pt-0">
        <div className="grid grid-cols-7 gap-1 mb-1">
          {["CN", "T2", "T3", "T4", "T5", "T6", "T7"].map(d => (
            <div key={d} className="text-center text-[10px] font-bold text-muted-foreground py-1">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">{cells}</div>
        <div className="mt-2"><StatusLegend /></div>
      </div>
      {dayModal && (
        <TeamDayDetailModal
          date={dayModal.date}
          rows={dayModal.rows}
          logsByStaff={logsByStaff}
          onClose={() => setDayModal(null)}
          onStaffClick={(staffId, staffName) => onClickStaffDay(staffId, staffName, dayModal.date)}
        />
      )}
    </div>
  );
}

// (Cũ — không dùng nữa) Matrix NV × ngày: giữ lại nếu cần debug.
function TeamMatrixGrid({ month, staffList, logsByStaff, extras, onClickCell }: {
  month: string;
  staffList: { id: number; name: string }[];
  logsByStaff: Map<number, { type: string; localTime?: string; localDate?: string; createdAt: string; isOffsite?: boolean; method?: string | null; workType?: WorkType | null; attendanceType?: string | null }[]>;
  extras: TeamExtras | undefined;
  onClickCell: (staffId: number, staffName: string, date: string) => void;
}) {
  const [y, m] = month.split("-").map(Number);
  const total = new Date(y, m, 0).getDate();
  const days = Array.from({ length: total }, (_, i) => i + 1);
  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const lateRules = extras?.lateRules ?? [];
  const defaultShiftStart = extras?.checkInTo ?? "08:10";
  const shiftOverrides = extras?.shiftOverrides;

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b flex items-center gap-2">
        <Users className="w-4 h-4 text-blue-600" />
        <span className="font-semibold text-sm">Bảng tổng toàn team — tháng {month.slice(5)}/{month.slice(0, 4)}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">Cuộn ngang để xem hết</span>
      </div>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 bg-card border-b border-r border-border px-3 py-2 text-left text-[11px] font-bold text-muted-foreground min-w-[140px]">
                Nhân viên
              </th>
              {days.map(d => {
                const dt = new Date(`${month}-${String(d).padStart(2, "0")}T00:00:00`);
                const dow = dt.getDay();
                const dowLbl = ["CN","T2","T3","T4","T5","T6","T7"][dow];
                const isSun = dow === 0;
                return (
                  <th key={d} className={`sticky top-0 z-10 bg-card border-b border-border px-1 py-1 text-center text-[10px] font-bold min-w-[58px] ${isSun ? "text-red-500" : "text-muted-foreground"}`}>
                    <div className="leading-none">{d}</div>
                    <div className="text-[8px] opacity-70 leading-tight">{dowLbl}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {staffList.map(staff => {
              const leaves = (extras?.staffLeaves?.[String(staff.id)] ?? []);
              const otList = (extras?.staffOvertime?.[String(staff.id)] ?? []);
              const otMap = new Map(otList.map(o => [o.date, o]));
              const sLogs = logsByStaff.get(staff.id) ?? [];
              const initials = staff.name.trim().split(/\s+/).map(s => s[0]).slice(-2).join("").toUpperCase();
              return (
                <tr key={staff.id}>
                  <td className="sticky left-0 z-10 bg-card border-r border-b border-border px-3 py-1.5 text-xs font-medium min-w-[140px]">
                    <Link href={`/staff-profile/${staff.id}`} className="flex items-center gap-2 hover:text-primary">
                      <span className="w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-[10px] font-bold flex items-center justify-center">{initials || "?"}</span>
                      <span className="truncate">{staff.name}</span>
                    </Link>
                  </td>
                  {days.map(d => {
                    const date = `${month}-${String(d).padStart(2, "0")}`;
                    const dt = new Date(`${date}T00:00:00`);
                    const dow = dt.getDay();
                    const isWeekend = dow === 0;
                    const isFuture = date > todayStr;
                    const dayLogs = sLogs.filter(l => (l.localDate ?? l.createdAt.slice(0, 10)) === date);
                    const showDays = extras?.staffShowDays?.[String(staff.id)] ?? [];
                    const status = resolveDayStatus({
                      date,
                      dayLogs: dayLogs.map(l => ({ type: l.type, localTime: l.localTime, isOffsite: l.isOffsite, method: l.method, workType: l.workType, attendanceType: l.attendanceType })),
                      shiftStart: resolveShiftStart(staff.id, date, shiftOverrides, defaultShiftStart),
                      lateRules,
                      approvedLeaves: leaves,
                      overtime: otMap.get(date),
                      isWeekend, isFuture,
                      hasShowBooking: showDays.includes(date),
                      showTime: extras?.staffShowTimes?.[String(staff.id)]?.[date],
                      checkInTo: defaultShiftStart,
                    });
                    const hasOT = (status.otHours ?? 0) > 0;
                    const cls = DAY_COLOR_CLS[status.color];
                    const short = status.attendanceMode === "OFF" ? "OFF"
                      : status.attendanceMode === "SHOW" ? "SHOW"
                      : status.color === "red-dark" ? "Vắng"
                      : (status.checkIn ?? (status.isFuture ? "" : "—"));
                    return (
                      <td key={d} className="border-b border-border p-0">
                        <button
                          type="button"
                          onClick={() => onClickCell(staff.id, staff.name, date)}
                          className={`relative w-full h-[48px] min-w-[58px] px-1 py-0.5 text-[9px] font-semibold border-l border-border flex flex-col items-center justify-center transition-colors hover:brightness-95 ${cls} ${hasOT ? "ring-2 ring-inset ring-purple-400 dark:ring-purple-500" : ""}`}
                          title={`${staff.name} · ${date} · ${status.label}${hasOT ? ` · OT ${status.otHours}h` : ""}`}
                          data-testid={`matrix-cell-${staff.id}-${d}`}
                        >
                          <span className="font-mono leading-none">{short}</span>
                          {status.isLate && status.lateMinutes ? (
                            <span className="text-[8px] opacity-90 leading-tight">{status.lateMinutes}p</span>
                          ) : null}
                          {hasOT && (
                            <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-purple-500" />
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── QR Scanner component ────────────────────────────────────────────────────
function QrScanner({ onScan, onClose, title }: { onScan: (data: string) => void; onClose: () => void; title?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraErr, setCameraErr] = useState<string | null>(null);

  const startScan = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch {
      setCameraErr("Không thể mở camera. Hãy cho phép truy cập camera trong trình duyệt.");
    }
  }, []);

  const stopScan = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    startScan();
    return stopScan;
  }, [startScan, stopScan]);

  useEffect(() => {
    if (cameraErr) return;
    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
      if (code?.data) {
        onScan(code.data);
        stopScan();
        return;
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [cameraErr, onScan, stopScan]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm bg-background rounded-2xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold text-sm flex items-center gap-2"><QrCode className="w-4 h-4" /> {title ?? "Quét mã QR"}</span>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="relative bg-black aspect-square overflow-hidden">
          {cameraErr ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center text-white">
              <CameraOff className="w-10 h-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{cameraErr}</p>
            </div>
          ) : (
            <>
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted autoPlay />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-52 h-52 border-4 border-white rounded-2xl opacity-60" />
              </div>
            </>
          )}
          <canvas ref={canvasRef} className="hidden" />
        </div>
        <div className="px-4 py-3 text-center">
          <p className="text-xs text-muted-foreground">{title ? `Đặt mã QR studio vào khung — ${title}` : "Đặt mã QR vào khung hình để chấm công"}</p>
        </div>
      </div>
    </div>
  );
}

type AttendanceJournalEntry = {
  kind: "check_in" | "bonus" | "forgot_checkout" | "overtime";
  logId: number | null;
  staffId: number;
  staffName: string;
  date: string;
  localTime: string | null;
  method: string | null;
  attendanceType?: string | null;
  isOffsite: boolean;
  workType: string | null;
  checkinPhotoUrl?: string | null;
  status: string;
  lateMinutes: number;
  penaltyAmount: number;
  bonusAmount: number;
  waived: boolean;
  waiverReason: string | null;
  notes: string;
  override: LogOverrideInfo | null;
  createdAt: string;
};

const STATUS_BADGE: Record<string, string> = {
  "Đúng giờ": "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  "Trễ nhẹ": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200",
  "Trễ vừa": "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  "Trễ nặng": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  "Miễn phạt": "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  "Nghỉ phép": "bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300",
  "Thưởng chuyên cần": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "Quên check-out": "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200",
  "Thiếu check-out": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "Quá 5 tiếng": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  "Hợp lệ": "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
};

function AttendanceJournalTable({
  entries,
  isAdmin,
  adminLogsById,
  onOverride,
  onWaiver,
  onMoneyEdit,
  monthIsClosed = false,
  defaultOpen = false,
}: {
  entries: AttendanceJournalEntry[];
  isAdmin: boolean;
  adminLogsById: Map<number, AdminLog>;
  onOverride: (log: AdminLog) => void;
  onWaiver: (args: { staffId: number; staffName: string; date: string; penalty: number; time: string }) => void;
  onMoneyEdit: (ctx: MoneyEditContext) => void;
  monthIsClosed?: boolean;
  defaultOpen?: boolean;
}) {
  const checkIns = entries.filter(e => e.kind === "check_in").length;
  const bonusRows = entries.filter(e => e.kind === "bonus").length;
  const forgotRows = entries.filter(e => e.kind === "forgot_checkout").length;
  const otRows = entries.filter(e => e.kind === "overtime").length;

  return (
    <details className="rounded-2xl border border-border bg-card overflow-hidden" open={defaultOpen || undefined}>
      <summary className="flex items-center gap-2 px-4 py-2.5 cursor-pointer font-semibold text-sm select-none hover:bg-muted/20">
        <ChevronDown className="w-4 h-4 text-muted-foreground" />
        Nhật ký chấm công ({checkIns} vào
        {forgotRows > 0 ? ` · ${forgotRows} quên ra` : ""}
        {otRows > 0 ? ` · ${otRows} tăng ca` : ""}
        {bonusRows > 0 ? ` · ${bonusRows} thưởng` : ""})
        <span className="text-[10px] font-normal text-muted-foreground ml-1">— minh bạch phạt/thưởng nội quy</span>
      </summary>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[1020px]">
          <thead className="bg-muted/30">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-xs text-muted-foreground">Nhân viên</th>
              <th className="text-left px-3 py-2 font-semibold text-xs text-muted-foreground">Ngày / Giờ</th>
              <th className="text-left px-3 py-2 font-semibold text-xs text-muted-foreground">Trạng thái</th>
              <th className="text-center px-3 py-2 font-semibold text-xs text-muted-foreground">Phút trễ</th>
              <th className="text-right px-3 py-2 font-semibold text-xs text-muted-foreground min-w-[148px]">Tiền phạt / thưởng</th>
              <th className="text-left px-3 py-2 font-semibold text-xs text-muted-foreground max-w-[160px]">Ghi chú</th>
              <th className="text-left px-3 py-2 font-semibold text-xs text-muted-foreground">Vị trí</th>
              <th className="text-center px-3 py-2 font-semibold text-xs text-muted-foreground">Selfie</th>
              {isAdmin && (
                <th className="text-right px-3 py-2 font-semibold text-xs text-muted-foreground">Hành động</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entries.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 9 : 8} className="px-4 py-8 text-center text-muted-foreground text-sm">
                  Chưa có dữ liệu chấm công trong tháng này.
                </td>
              </tr>
            ) : entries.map((e, idx) => {
              const adminLog = e.logId != null ? adminLogsById.get(e.logId) : undefined;
              const showWaiver =
                isAdmin &&
                e.kind === "check_in" &&
                !e.waived &&
                e.penaltyAmount > 0 &&
                (e.status.startsWith("Trễ") || e.lateMinutes > 0);
              return (
                <tr key={`${e.kind}-${e.logId ?? "b"}-${e.staffId}-${e.date}-${idx}`} className="hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5 font-medium">
                    <Link href={`/staff-profile/${e.staffId}`} className="text-primary hover:underline inline-flex items-center gap-1">
                      {e.staffName}
                      <ExternalLink className="w-3 h-3 opacity-50" />
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                    {new Date(e.date + "T12:00:00").toLocaleDateString("vi-VN")}
                    {e.localTime && (
                      <>
                        {" "}
                        <span className={e.lateMinutes > 0 && !e.waived ? "text-red-600 font-semibold font-mono" : "font-mono"}>
                          {e.localTime}
                        </span>
                      </>
                    )}
                    {e.override?.time && (
                      <span title={e.override.reason} className="ml-1 text-[9px] px-1 rounded bg-violet-100 text-violet-700 font-semibold cursor-help">
                        SỬA
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      e.kind === "overtime" ? "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200"
                      : STATUS_BADGE[e.status] ?? "bg-muted text-muted-foreground"
                    }`}>
                      {e.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center text-xs font-mono">
                    {e.lateMinutes > 0 ? e.lateMinutes : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs min-w-[148px]">
                    <div className="inline-flex items-center justify-end gap-1 max-w-full">
                      {e.waived && e.kind === "check_in" ? (
                        <span className="text-slate-600 font-semibold tabular-nums">0đ <span className="text-[10px] font-normal">(đã gỡ)</span></span>
                      ) : e.penaltyAmount > 0 ? (
                        <span className="text-red-600 font-bold tabular-nums">−{vnd(e.penaltyAmount)}</span>
                      ) : e.bonusAmount > 0 ? (
                        <span className="text-green-600 font-bold tabular-nums">+{vnd(e.bonusAmount)}</span>
                      ) : e.kind === "check_in" || e.kind === "forgot_checkout" ? (
                        <span className="text-muted-foreground font-medium tabular-nums">0đ</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {isAdmin && (e.kind === "check_in" || e.kind === "forgot_checkout" || e.kind === "bonus" || e.penaltyAmount > 0 || e.bonusAmount > 0) && (
                        <MoneyEditPencil
                          onClick={() => onMoneyEdit({
                            staffId: e.staffId,
                            staffName: e.staffName,
                            date: e.date,
                            field: e.bonusAmount > 0 ? "bonus" : "penalty",
                            systemPenalty: !e.waived && e.penaltyAmount > 0 ? e.penaltyAmount : undefined,
                            label: `${e.status} · ${new Date(e.date + "T12:00:00").toLocaleDateString("vi-VN")}`,
                          })}
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground max-w-[200px]">
                    <span className="line-clamp-2" title={e.notes}>{e.notes || "—"}</span>
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {e.kind === "bonus" || e.kind === "overtime" ? (
                      <span className="text-emerald-600">{e.kind === "overtime" ? "Tăng ca" : "Thưởng"}</span>
                    ) : e.kind === "forgot_checkout" ? (
                      <span className="text-gray-600">Quên ra</span>
                    ) : e.isOffsite ? (
                      <span className="flex items-center gap-1 text-amber-600"><MapPin className="w-3 h-3" />Ngoài</span>
                    ) : e.method === "manual" ? (
                      <span className="text-violet-600">Thủ công</span>
                    ) : (
                      <span className="flex items-center gap-1 text-green-600"><CheckCircle2 className="w-3 h-3" />Studio</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {e.kind === "check_in" && e.checkinPhotoUrl ? (
                      <AttendanceSelfieThumb path={e.checkinPhotoUrl} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="px-3 py-2.5 text-right">
                      {e.kind === "check_in" && adminLog ? (
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          <button
                            type="button"
                            onClick={() => onOverride(adminLog)}
                            className="text-[10px] px-2 py-1 rounded bg-violet-50 hover:bg-violet-100 text-violet-700 font-medium"
                          >
                            Sửa giờ
                          </button>
                          {showWaiver && (
                            <button
                              type="button"
                              onClick={() =>
                                onWaiver({
                                  staffId: e.staffId,
                                  staffName: e.staffName,
                                  date: e.date,
                                  penalty: e.penaltyAmount,
                                  time: e.localTime ?? "",
                                })
                              }
                              className="text-[10px] px-2 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-700 font-medium"
                            >
                              Gỡ phạt
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function AttendancePage() {
  const qc = useQueryClient();
  const { effectiveIsAdmin, isAdmin, viewer, viewMode, simulateRole } = useStaffAuth();
  /** Chỉnh sửa quy tắc / chấm thủ công / gỡ phạt — admin thật ở chế độ quản trị. */
  const canEditAttendance = effectiveIsAdmin;
  /** Chốt công tháng — admin/owner (kể cả khi xem chế độ nhân viên). */
  const canCloseMonth = isAdmin;

  /** Admin ở chế độ nhân viên → chấm công thay NHÂN VIÊN TEST. */
  const useAttendanceTestActor = isAdmin && viewMode === "staff" && !simulateRole;
  const { data: attendanceTestStaff } = useQuery<AttendanceTestStaff>({
    queryKey: ["attendance-test-staff"],
    queryFn: () => fetchAuth("/api/attendance/test-staff"),
    enabled: useAttendanceTestActor,
    staleTime: 60_000,
  });
  const attendanceActAsId = useAttendanceTestActor ? attendanceTestStaff?.id : undefined;
  const attendanceSelfName = useAttendanceTestActor
    ? (attendanceTestStaff?.name ?? "NHÂN VIÊN TEST")
    : (viewer?.name ?? "Tôi");
  const attendanceSelfId = useAttendanceTestActor ? attendanceTestStaff?.id : viewer?.id;

  const [tab, setTab] = useState<"me" | "admin" | "rules" | "overtime" | "closures">("me");
  // Admin/owner mặc định mở thẳng tab "Toàn nhân sự" vì họ không chấm công cá nhân.
  const tabInitRef = useRef(false);
  useEffect(() => {
    if (tabInitRef.current) return;
    if (effectiveIsAdmin) { setTab("admin"); tabInitRef.current = true; }
  }, [effectiveIsAdmin]);

  useEffect(() => {
    if (useAttendanceTestActor) setTab("me");
  }, [useAttendanceTestActor]);

  useEffect(() => {
    if (!canEditAttendance) setEditingRules(false);
  }, [canEditAttendance]);
  const [geoErr, setGeoErr] = useState<string | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [checkMsg, setCheckMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [encourageOpen, setEncourageOpen] = useState(false);
  const [encourageFeedback, setEncourageFeedback] = useState<PunchFeedback | null>(null);

  const showEncouragement = (data: { feedback?: PunchFeedback }) => {
    if (data?.feedback?.messageKey) {
      setEncourageFeedback(data.feedback);
      setEncourageOpen(true);
    }
  };
  const [month, setMonth] = useState(() => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7));
  const [yearPart, monthPart] = month.split("-").map(Number);
  const setMonthFromParts = (y: number, m: number) => {
    setMonth(`${y}-${String(m).padStart(2, "0")}`);
  };
  const monthYearOptions = useMemo(() => {
    const cur = new Date(Date.now() + 7 * 3600 * 1000).getFullYear();
    return Array.from({ length: 5 }, (_, i) => cur - 2 + i);
  }, []);
  const [showQr, setShowQr] = useState(false);
  const [showOffsiteDialog, setShowOffsiteDialog] = useState(false);
  const [offsiteSaving, setOffsiteSaving] = useState(false);
  const [qrAction, setQrAction] = useState<"checkin" | "checkout" | "ot_checkin" | "ot_checkout">("checkin");
  const [workType, setWorkType] = useState<WorkType>("studio");
  const [todayFilter, setTodayFilter] = useState<null | "daVao" | "diTre" | "dangDiShow" | "chuaCheckOut" | "showDay" | "studioDay">(null);
  const [inGeofence, setInGeofence] = useState<boolean | null>(null);
  const [locationPermission, setLocationPermission] = useState<"unknown" | "prompt" | "granted" | "denied" | "unsupported" | "error">("unknown");
  const [studioDistanceM, setStudioDistanceM] = useState<number | null>(null);
  const [lastStudioCoords, setLastStudioCoords] = useState<{ lat: number; lng: number; accuracyM?: number; distanceM: number; inGeofence: boolean; ts: number } | null>(null);
  const [autoCheckInAt, setAutoCheckInAt] = useState<string | null>(null);
  const inGeoRef = useRef<boolean | null>(null);
  const lastAutoCheckInAttemptRef = useRef(0);
  useEffect(() => { inGeoRef.current = inGeofence; }, [inGeofence]);

  // Admin adjustments form
  const [showAdjForm, setShowAdjForm] = useState(false);
  const [adjForm, setAdjForm] = useState({ staffId: "", type: "bonus", amount: "", reason: "", date: new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10) });
  const [adjViewStaffId, setAdjViewStaffId] = useState<string>("");

  // Admin manual check form
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualForm, setManualForm] = useState({ staffId: "", type: "check_in", notes: "" });

  // Task #505: shifts state
  const [shiftDialog, setShiftDialog] = useState<null | { mode: "create" | "edit"; data?: ShiftOverride }>(null);
  const todayVNStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const [shiftForm, setShiftForm] = useState<{ id?: number; date: string; name: string; startTime: string; endTime: string; standardHours: string; flexibleBreakHours: string; notes: string; scope: "all" | "selected"; staffIds: number[] }>(
    { date: todayVNStr, name: "Ca đặc biệt", startTime: "12:00", endTime: "21:00", standardHours: "8", flexibleBreakHours: "1", notes: "", scope: "all", staffIds: [] }
  );

  // Rules edit state
  const [editingRules, setEditingRules] = useState(false);
  const [ruleForm, setRuleForm] = useState({ name: "Mặc định", checkInFrom: "07:30", checkInTo: "09:00", weeklyOnTimeBonus: "50000", overtimeRatePerHour: "30000" });
  const [lateRules, setLateRules] = useState<LateRule[]>([]);

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: myAtt, isLoading: myLoading } = useQuery<MyAttendance>({
    queryKey: ["attendance-me", month, attendanceActAsId ?? "self"],
    queryFn: () => fetchAttendanceSelf(`/api/attendance/me?month=${month}`, attendanceActAsId),
    enabled: (tab === "me" || tab === "overtime") && (!useAttendanceTestActor || !!attendanceActAsId),
  });

  const { data: adminLogs = [], isLoading: adminLogsLoading } = useQuery<AdminLog[]>({
    queryKey: ["attendance-admin", month],
    queryFn: () => fetchAuth(`/api/attendance/admin?month=${month}`),
    enabled: !!viewer && (tab === "me" || tab === "overtime" || tab === "admin"),
  });

  // Separate today query so drill-down always matches today-summary cards
  const todayMonth = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const { data: adminLogsToday = [] } = useQuery<AdminLog[]>({
    queryKey: ["attendance-admin", todayMonth],
    queryFn: () => fetchAuth(`/api/attendance/admin?month=${todayMonth}`),
    enabled: !!viewer && tab === "admin",
  });

  type TodaySummary = {
    daVao: number; chuaVao: number; diTre: number; dangDiShow: number; chuaCheckOut: number;
    showDayCount: number; studioDayCount: number; offDayCount: number;
    activeStaff: number; checkInTo: string;
    showDayStaffIds?: number[];
    showDayStaff?: { id: number; name: string; role: string; checkedIn: boolean; checkInTime?: string }[];
    notCheckedIn: { id: number; name: string; role: string }[];
  };
  const { data: todaySummary } = useQuery<TodaySummary>({
    queryKey: ["attendance-today-summary"],
    queryFn: () => fetchAuth(`/api/attendance/today-summary`),
    enabled: !!viewer && tab === "admin",
    refetchInterval: 60_000,
  });

  const { data: staffListAll = [] } = useQuery<StaffInfo[]>({
    queryKey: ["attendance-eligible-staff", month],
    queryFn: () => fetchAuth(`/api/attendance/eligible-staff?month=${month}`),
    enabled: !!viewer,
  });

  /** Lịch team: mọi NV active eligible (API); fallback tên từ log nếu API trống. */
  const staffList = useMemo(() => {
    const byId = new Map<number, StaffInfo>();
    for (const s of staffListAll) {
      if (!isAttendanceEligibleStaff(s)) continue;
      const id = Number(s.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      byId.set(id, { ...s, id, staffType: s.staffType ?? "official" });
    }
    if (byId.size === 0) {
      for (const l of adminLogs) {
        if (l.type !== "check_in") continue;
        const id = Number(l.staffId);
        if (!Number.isInteger(id) || id <= 0 || byId.has(id)) continue;
        const logName = l.staffName ?? `#${id}`;
        if (isAttendanceBlockedIdentity({ name: logName })) continue;
        const fromApi = staffListAll.find(x => Number(x.id) === id);
        const candidate: StaffInfo = fromApi ?? {
          id,
          name: logName,
          role: "staff",
          staffType: "official",
          roles: [],
          username: undefined,
          isAdmin: false,
        };
        if (isAttendanceEligibleStaff(candidate)) byId.set(id, candidate);
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [staffListAll, adminLogs]);

  const attendanceStaffIds = useMemo(() => new Set(staffList.map(s => s.id)), [staffList]);
  const adminLogsAttendance = useMemo(
    () => adminLogs.filter(l => attendanceStaffIds.has(Number(l.staffId))),
    [adminLogs, attendanceStaffIds],
  );
  const adminLogsTodayAttendance = useMemo(
    () => adminLogsToday.filter(l => attendanceStaffIds.has(Number(l.staffId))),
    [adminLogsToday, attendanceStaffIds],
  );

  // Static QR URL - không phụ thuộc API
  const staticQrUrl = `/attendance/check-in`;

  const { data: adminAdjustments = [] } = useQuery<{ id: number; type: string; category?: string | null; amount: number; reason: string | null; date: string; created_by_name?: string | null }[]>({
    queryKey: ["attendance-adjustments-admin", adjViewStaffId, month],
    queryFn: () => fetchAuth(`/api/attendance/adjustments?staffId=${adjViewStaffId}&month=${month}`),
    enabled: canEditAttendance && !!adjViewStaffId,
  });

  // ── Admin override / waiver dialog state ────────────────────────────────────
  const [adminViewMode, setAdminViewMode] = useState<"table" | "timeline">("table");
  const [overrideDialog, setOverrideDialog] = useState<null | { log: AdminLog }>(null);
  const [overrideForm, setOverrideForm] = useState({ time: "", forceOnTime: false, reason: "" });
  const [waiverDialog, setWaiverDialog] = useState<null | { staffId: number; staffName: string; date: string; penalty: number; time: string }>(null);
  const [waiverReason, setWaiverReason] = useState("");
  const [moneyEditCtx, setMoneyEditCtx] = useState<MoneyEditContext | null>(null);
  const [dayDetail, setDayDetail] = useState<null | { staffId: number; staffName: string; date: string }>(null);

  // Task #508: admin chọn 1 NV để xem visual calendar riêng
  const [adminCalStaffId, setAdminCalStaffId] = useState<string>("");
  const { data: adminStaffSummary } = useQuery<StaffSummaryResp>({
    queryKey: ["attendance-staff-summary", adminCalStaffId, month],
    queryFn: () => fetchAuth(`/api/attendance/staff-summary?staffId=${adminCalStaffId}&month=${month}`),
    enabled: !!viewer && tab === "admin" && !!adminCalStaffId,
  });
  const { data: teamExtras } = useQuery<TeamExtras>({
    queryKey: ["attendance-team-extras", month],
    queryFn: () => fetchAuth(`/api/attendance/team-extras?month=${month}`),
    enabled: !!viewer && (tab === "me" || tab === "overtime" || tab === "admin"),
  });

  type MonthClosureLine = {
    id: number;
    month: string;
    staffId: number;
    staffName: string;
    workDays: number;
    onTimeCount: number;
    lateCount: number;
    latePenaltyTotal: number;
    forgotCheckoutPenaltyTotal: number;
    attendanceBonusTotal: number;
    overtimeHours: number;
    overtimePay: number;
    totalPenalty: number;
    totalBonus: number;
    netAmount: number;
    closedAt: string;
    closedByName: string | null;
    status: "closed";
  };

  type MonthCloseStatus = {
    month: string;
    closed: boolean;
    staffCount: number;
    closedAt: string | null;
    closedByName: string | null;
  };

  const { data: monthCloseStatus } = useQuery<MonthCloseStatus>({
    queryKey: ["attendance-month-close-status", month],
    queryFn: () => fetchAuth(`/api/attendance/month-closures/status?month=${month}`),
    enabled: !!viewer,
  });

  const { data: monthClosureLines = [] } = useQuery<MonthClosureLine[]>({
    queryKey: ["attendance-month-closures", month],
    queryFn: () => fetchAuth(`/api/attendance/month-closures?month=${month}`),
    enabled: !!viewer && (monthCloseStatus?.closed === true || tab === "closures"),
  });

  const { data: closureHistoryAll = [] } = useQuery<MonthClosureLine[]>({
    queryKey: ["attendance-month-closures-all"],
    queryFn: () => fetchAuth(`/api/attendance/month-closures`),
    enabled: !!viewer && tab === "closures",
  });

  const closeMonth = useMutation({
    mutationFn: (reclose: boolean) =>
      fetchAuth(`/api/attendance/month-closures/${month}/${reclose ? "reclose" : "close"}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-month-close-status"] });
      qc.invalidateQueries({ queryKey: ["attendance-month-closures"] });
      qc.invalidateQueries({ queryKey: ["attendance-month-closures-all"] });
    },
    onError: (e: Error) => alert(e.message),
  });

  const overrideLog = useMutation({
    mutationFn: (data: { logId: number; overrideTime?: string; overrideIsLate?: number | null; reason: string }) =>
      fetchAuth(`/api/attendance/logs/${data.logId}/override`, {
        method: "POST",
        body: JSON.stringify({ overrideTime: data.overrideTime || null, overrideIsLate: data.overrideIsLate ?? null, reason: data.reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-admin"] });
      qc.invalidateQueries({ queryKey: ["attendance-today-summary"] });
      qc.invalidateQueries({ queryKey: ["attendance-me"] });
      qc.invalidateQueries({ queryKey: ["attendance-team-extras"] });
      qc.invalidateQueries({ queryKey: ["staff-att-summary"] });
      setOverrideDialog(null);
      setOverrideForm({ time: "", forceOnTime: false, reason: "" });
    },
    onError: (e: Error) => alert(e.message),
  });

  const penaltyWaiver = useMutation({
    mutationFn: (data: { staffId: number; date: string; reason: string }) =>
      fetchAuth(`/api/attendance/penalty-waiver`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-admin"] });
      qc.invalidateQueries({ queryKey: ["attendance-adjustments-admin"] });
      qc.invalidateQueries({ queryKey: ["attendance-me"] });
      qc.invalidateQueries({ queryKey: ["attendance-team-extras"] });
      qc.invalidateQueries({ queryKey: ["staff-att-summary"] });
      setWaiverDialog(null);
      setWaiverReason("");
    },
    onError: (e: Error) => alert(e.message),
  });

  const moneyEdit = useMutation({
    mutationFn: (data: { staffId: number; date: string; action: string; amount: number; reason: string; systemPenalty?: number }) =>
      fetchAuth(`/api/attendance/money-edit`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-admin"] });
      qc.invalidateQueries({ queryKey: ["attendance-adjustments-admin"] });
      qc.invalidateQueries({ queryKey: ["attendance-me"] });
      qc.invalidateQueries({ queryKey: ["attendance-team-extras"] });
      qc.invalidateQueries({ queryKey: ["attendance-staff-summary"] });
      qc.invalidateQueries({ queryKey: ["staff-att-summary"] });
      setMoneyEditCtx(null);
    },
    onError: (e: Error) => alert(e.message),
  });

  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [qrDownloading, setQrDownloading] = useState(false);

  // Render QR từ static URL
  useEffect(() => {
    QRCode.toDataURL(staticQrUrl, {
      width: 200,
      margin: 2,
      color: { dark: "#1e1b4b", light: "#ffffff" },
      errorCorrectionLevel: "H",
      type: "image/png",
    }).then(url => setQrImageUrl(url))
      .catch(err => console.error("QR generation error:", err));
  }, [staticQrUrl]);

  // Studio GPS info for client-side geofence check
  const { data: studioInfo } = useQuery<{ lat: number; lng: number; radius: number }>({
    queryKey: ["attendance-studio-info"],
    queryFn: () => fetchAuth(`/api/attendance/studio-info`),
  });

  // Check GPS once when tab "me" opens to know if in-geofence
  useEffect(() => {
    if (tab !== "me" || !studioInfo) return;
    if (!navigator.geolocation) {
      setInGeofence(null);
      setLocationPermission("unsupported");
      return;
    }
    let permissionStatus: PermissionStatus | null = null;
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: "geolocation" as PermissionName })
        .then(status => {
          permissionStatus = status;
          setLocationPermission(status.state);
          status.onchange = () => setLocationPermission(status.state);
        })
        .catch(() => {});
    }
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setLocationPermission("granted");
        const R = 6371000;
        const dLat = (latitude - studioInfo.lat) * Math.PI / 180;
        const dLng = (longitude - studioInfo.lng) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(studioInfo.lat * Math.PI/180) * Math.cos(latitude * Math.PI/180) * Math.sin(dLng/2)**2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const dist = R * c;
        const nowIn = dist <= studioInfo.radius;
        inGeoRef.current = nowIn;
        setInGeofence(nowIn);
        setStudioDistanceM(dist);
        setLastStudioCoords({
          lat: latitude,
          lng: longitude,
          accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
          distanceM: dist,
          inGeofence: nowIn,
          ts: Date.now(),
        });
      },
      (err) => {
        setInGeofence(null);
        setLastStudioCoords(null);
        setLocationPermission(err.code === 1 ? "denied" : "error");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
    return () => {
      navigator.geolocation.clearWatch(watch);
      if (permissionStatus) permissionStatus.onchange = null;
    };
  }, [tab, studioInfo]);

  const handleDownloadQr = async () => {
    if (!qrImageUrl) return;
    setQrDownloading(true);
    try {
      const link = document.createElement("a");
      link.href = qrImageUrl;
      link.download = `amazing-studio-qr-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
    } finally {
      setQrDownloading(false);
    }
  };

  const handleCopyQrLink = async () => {
    try {
      await navigator.clipboard.writeText(staticQrUrl);
      alert("Đã copy link QR!");
    } catch (err) {
      console.error("Copy error:", err);
    }
  };

  const { data: rules, isLoading: rulesLoading } = useQuery<AttRules>({
    queryKey: ["attendance-rules"],
    queryFn: () => fetchAuth(`/api/attendance/rules`),
    enabled: tab === "rules" || tab === "me" || tab === "admin" || tab === "overtime",
  });

  const adminLogsById = useMemo(() => {
    const m = new Map<number, AdminLog>();
    for (const l of adminLogs) m.set(l.id, l);
    return m;
  }, [adminLogs]);

  const journalStaffList = useMemo(() => {
    if (staffList.length > 0) return staffList.map(s => ({ id: s.id, name: s.name }));
    const m = new Map<number, string>();
    for (const l of adminLogsAttendance) {
      if (!m.has(l.staffId)) m.set(l.staffId, l.staffName ?? `#${l.staffId}`);
    }
    return Array.from(m.entries()).map(([id, name]) => ({ id, name }));
  }, [staffList, adminLogsAttendance]);

  const { journalEntries, staffMoneyMap } = useMemo(() => {
    const { entries, staffMoney } = buildJournalAndStaffMoney({
      month,
      logs: adminLogsAttendance,
      staffList: journalStaffList,
      extras: teamExtras,
      rules,
    });
    return { journalEntries: entries, staffMoneyMap: staffMoney };
  }, [month, adminLogsAttendance, journalStaffList, teamExtras, rules]);

  const monthOtSessions = useMemo(
    () => (teamExtras?.overtimeSessions ?? []).filter(s => s.date.startsWith(month)),
    [teamExtras?.overtimeSessions, month],
  );

  const displayOtSessions = monthOtSessions;

  const journalEntriesOvertimeTab = useMemo(
    () => journalEntries.filter(e => e.kind === "overtime" || e.kind === "forgot_checkout"),
    [journalEntries],
  );

  // Task #505: shifts list theo tháng (admin) + ca hôm nay (staff)
  const { data: shiftsList = [] } = useQuery<ShiftOverride[]>({
    queryKey: ["attendance-shifts", month],
    queryFn: () => fetchAuth(`/api/attendance/shifts?month=${month}`),
    enabled: false,
  });

  const { data: shiftToday } = useQuery<ShiftInfoLite & { date: string }>({
    queryKey: ["attendance-shift-today"],
    queryFn: () => fetchAttendanceSelf(`/api/attendance/shift-today`, attendanceActAsId),
    enabled: tab === "me" && (!useAttendanceTestActor || !!attendanceActAsId),
    refetchInterval: 5 * 60_000,
  });

  const saveShift = useMutation({
    mutationFn: (data: { id?: number; body: Record<string, unknown> }) => {
      if (data.id) return fetchAuth(`/api/attendance/shifts/${data.id}`, { method: "PUT", body: JSON.stringify(data.body) });
      return fetchAuth(`/api/attendance/shifts`, { method: "POST", body: JSON.stringify(data.body) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-shifts"] });
      qc.invalidateQueries({ queryKey: ["attendance-shift-today"] });
      qc.invalidateQueries({ queryKey: ["attendance-me"] });
      qc.invalidateQueries({ queryKey: ["attendance-today-summary"] });
      setShiftDialog(null);
    },
    onError: (e: Error) => alert(e.message),
  });

  const deleteShift = useMutation({
    mutationFn: (id: number) => fetchAuth(`/api/attendance/shifts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-shifts"] });
      qc.invalidateQueries({ queryKey: ["attendance-shift-today"] });
      qc.invalidateQueries({ queryKey: ["attendance-me"] });
      qc.invalidateQueries({ queryKey: ["attendance-today-summary"] });
    },
    onError: (e: Error) => alert(e.message),
  });

  function openCreateShift() {
    setShiftForm({ date: todayVNStr, name: "Ca đặc biệt", startTime: "12:00", endTime: "21:00", standardHours: "8", flexibleBreakHours: "1", notes: "", scope: "all", staffIds: [] });
    setShiftDialog({ mode: "create" });
  }
  function openEditShift(s: ShiftOverride) {
    setShiftForm({
      id: s.id, date: s.date, name: s.name,
      startTime: s.startTime, endTime: s.endTime,
      standardHours: String(s.standardHours), flexibleBreakHours: String(s.flexibleBreakHours),
      notes: s.notes ?? "", scope: s.scope, staffIds: [...s.staffIds],
    });
    setShiftDialog({ mode: "edit", data: s });
  }
  function submitShift() {
    const body = {
      date: shiftForm.date, name: shiftForm.name,
      startTime: shiftForm.startTime, endTime: shiftForm.endTime,
      standardHours: parseFloat(shiftForm.standardHours || "8"),
      flexibleBreakHours: parseFloat(shiftForm.flexibleBreakHours || "0"),
      notes: shiftForm.notes || null,
      scope: shiftForm.scope, staffIds: shiftForm.scope === "selected" ? shiftForm.staffIds : [],
    };
    saveShift.mutate({ id: shiftForm.id, body });
  }

  // Sync rules into local edit state when loaded
  useEffect(() => {
    if (rules) {
      if (rules.rule) {
        setRuleForm({
          name: (rules.rule.name as string) ?? "Mặc định",
          checkInFrom: rules.rule.checkinStartTime ?? "07:30",
          checkInTo: rules.rule.checkinEndTime ?? "09:00",
          weeklyOnTimeBonus: String(rules.rule.weeklyBonusAmount ?? 50000),
          overtimeRatePerHour: String(rules.rule.overtimeRatePerHour ?? 30000),
        });
      }
      setLateRules(rules.lateRules ?? []);
    }
  }, [rules]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const checkin = useMutation({
    mutationFn: (coords: { lat?: number; lng?: number; accuracyM?: number; qrPayload?: string; workType?: WorkType; checkinPhotoUrl?: string; notes?: string; attendanceType?: string; checkInMethod?: string; auto?: boolean }) =>
      fetchAttendanceSelf(`/api/attendance/check-in`, attendanceActAsId, { method: "POST", body: JSON.stringify(coords) }),
    onSuccess: (data: { feedback?: PunchFeedback }) => {
      qc.invalidateQueries({ queryKey: ["attendance-me"] });
      qc.invalidateQueries({ queryKey: ["attendance-admin"] });
      qc.invalidateQueries({ queryKey: ["attendance-team-extras"] });
      showEncouragement(data);
    },
    onError: (e: Error) => {
      setCheckMsg({ ok: false, text: e.message });
      setTimeout(() => setCheckMsg(null), 4000);
    },
  });

  const checkout = useMutation({
    mutationFn: (coords: { lat?: number; lng?: number }) =>
      fetchAttendanceSelf(`/api/attendance/check-out`, attendanceActAsId, { method: "POST", body: JSON.stringify(coords) }),
    onSuccess: (data: { feedback?: PunchFeedback }) => {
      qc.invalidateQueries({ queryKey: ["attendance-me"] });
      qc.invalidateQueries({ queryKey: ["attendance-admin"] });
      qc.invalidateQueries({ queryKey: ["attendance-team-extras"] });
      showEncouragement(data);
    },
    onError: (e: Error) => {
      setCheckMsg({ ok: false, text: e.message });
      setTimeout(() => setCheckMsg(null), 4000);
    },
  });

  const invalidateAfterOvertimePunch = () => {
    qc.invalidateQueries({ queryKey: ["attendance-me"] });
    qc.invalidateQueries({ queryKey: ["attendance-admin"] });
    qc.invalidateQueries({ queryKey: ["attendance-team-extras"] });
    qc.invalidateQueries({ queryKey: ["attendance-today-summary"] });
    qc.invalidateQueries({ queryKey: ["staff-att-summary"] });
  };

  const overtimeCheckin = useMutation({
    mutationFn: (coords: { lat?: number; lng?: number }) =>
      fetchAttendanceSelf(`/api/attendance/overtime/check-in`, attendanceActAsId, { method: "POST", body: JSON.stringify(coords) }),
    onSuccess: (data: { feedback?: PunchFeedback }) => {
      invalidateAfterOvertimePunch();
      showEncouragement(data);
    },
    onError: (e: Error) => {
      setCheckMsg({ ok: false, text: e.message });
      setTimeout(() => setCheckMsg(null), 5000);
    },
  });

  const overtimeCheckout = useMutation({
    mutationFn: (coords: { lat?: number; lng?: number }) =>
      fetchAttendanceSelf(`/api/attendance/overtime/check-out`, attendanceActAsId, { method: "POST", body: JSON.stringify(coords) }),
    onSuccess: (data: { feedback?: PunchFeedback }) => {
      invalidateAfterOvertimePunch();
      showEncouragement(data);
    },
    onError: (e: Error) => {
      setCheckMsg({ ok: false, text: e.message });
      setTimeout(() => setCheckMsg(null), 5000);
    },
  });

  const saveRules = useMutation({
    mutationFn: (body: { name: string; checkInFrom: string; checkInTo: string; weeklyOnTimeBonus: string; overtimeRatePerHour: string; lateRules: LateRule[] }) =>
      fetchAuth(`/api/attendance/rules`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-rules"] });
      setEditingRules(false);
    },
  });

  const addAdjustment = useMutation({
    mutationFn: (data: Record<string, unknown>) => fetchAuth(`/api/attendance/adjustments`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-me"] });
      qc.invalidateQueries({ queryKey: ["attendance-admin"] });
      setShowAdjForm(false);
      setAdjForm({ staffId: "", type: "bonus", amount: "", reason: "", date: new Date().toISOString().slice(0, 10) });
    },
  });

  const addManual = useMutation({
    mutationFn: (data: Record<string, unknown>) => fetchAuth(`/api/attendance/manual`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-admin"] });
      setShowManualForm(false);
      setManualForm({ staffId: "", type: "check_in", notes: "" });
    },
  });

  // ── GPS actions ────────────────────────────────────────────────────────────
  async function getGeolocationWithFallback(): Promise<GeolocationPosition> {
    if (!navigator.geolocation) throw new Error("Trình duyệt không hỗ trợ định vị GPS");
    // Try high-accuracy first (mobile/GPS), fall back to low-accuracy (WiFi/IP) on timeout
    const tryOnce = (opts: PositionOptions) =>
      new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, opts)
      );
    try {
      return await tryOnce({ timeout: 10000, enableHighAccuracy: true, maximumAge: 30000 });
    } catch (e) {
      const code = (e as GeolocationPositionError)?.code;
      // PERMISSION_DENIED (1) — không cần thử lại
      if (code === 1) throw e;
      // TIMEOUT (3) hoặc POSITION_UNAVAILABLE (2) — fallback low accuracy + timeout dài
      return await tryOnce({ timeout: 25000, enableHighAccuracy: false, maximumAge: 60000 });
    }
  }
  function geoErrorMessage(e: unknown): string {
    const err = e as GeolocationPositionError;
    if (err?.code === 1) return "Bạn cần cho phép truy cập vị trí (Settings → Location → Allow)";
    if (err?.code === 2) return "Không xác định được vị trí — kiểm tra Wi-Fi/4G hoặc bật Location trên thiết bị";
    if (err?.code === 3) return "Quá thời gian lấy GPS — thử lại hoặc ra chỗ có sóng tốt hơn";
    return (e as Error)?.message ?? "Không lấy được vị trí GPS";
  }
  async function doGPS(action: "checkin" | "checkout" | "ot_checkin" | "ot_checkout") {
    setGeoErr(null);
    setCheckMsg(null);
    setQrAction(action);
    setGeoLoading(true);
    try {
      // GPS hỏng → vẫn gửi không kèm toạ độ; server fallback kiểm tra WiFi studio
      let coords: { lat?: number; lng?: number; accuracyM?: number } = {};
      try {
        const pos = await getGeolocationWithFallback();
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        coords = { lat, lng, accuracyM: Number.isFinite(accuracy) ? accuracy : undefined };
      } catch {
        coords = {};
      }
      if (action === "checkin") {
        await checkin.mutateAsync({
          ...coords,
          workType: "studio_auto",
          attendanceType: "studio_auto",
          checkInMethod: "gps_auto",
          auto: true,
        });
      } else if (action === "checkout") {
        await checkout.mutateAsync(coords);
      } else if (action === "ot_checkin") {
        await overtimeCheckin.mutateAsync(coords);
      } else {
        await overtimeCheckout.mutateAsync(coords);
      }
    } catch (e: unknown) {
      setGeoErr(geoErrorMessage(e));
    } finally {
      setGeoLoading(false);
    }
  }

  // ── QR scanned ─────────────────────────────────────────────────────────────
  async function handleQrScan(_data: string) {
    setShowQr(false);
    setGeoLoading(true);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 12000, enableHighAccuracy: true })
      );
      const { latitude: lat, longitude: lng } = pos.coords;
      if (qrAction === "checkin") {
        await checkin.mutateAsync({ lat, lng, workType });
      } else if (qrAction === "checkout") {
        await checkout.mutateAsync({ lat, lng });
      } else if (qrAction === "ot_checkin") {
        await overtimeCheckin.mutateAsync({ lat, lng });
      } else {
        await overtimeCheckout.mutateAsync({ lat, lng });
      }
    } catch (e: unknown) {
      const msg = geoErrorMessage(e) || (e as Error)?.message || "Lỗi khi lấy GPS sau khi quét QR";
      setGeoErr(msg);
      setCheckMsg({ ok: false, text: msg });
    } finally {
      setGeoLoading(false);
    }
  }

  // ── Derived data ───────────────────────────────────────────────────────────
  // Compute today in VN timezone (UTC+7) to correctly match localDate from server
  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const todayLogs = (myAtt?.logs ?? []).filter(l => (l.localDate ?? l.createdAt.slice(0, 10)) === todayStr);
  const hasCheckedIn = todayLogs.some(l => l.type === "check_in");
  const hasCheckedOut = todayLogs.some(l => l.type === "check_out");
  const todayCheckIn = todayLogs.find(l => l.type === "check_in");
  let otPendingCount = 0;
  for (const l of todayLogs) {
    if (l.type === "overtime_check_in") otPendingCount++;
    else if (l.type === "overtime_check_out" && otPendingCount > 0) otPendingCount--;
  }
  const hasOtPending = otPendingCount > 0;
  const checkoutRules = teamExtras?.checkoutRules ?? ATTENDANCE_CHECKOUT_RULES;
  const otRateDisplay = teamExtras?.overtimeRatePerHour ?? rules?.rule?.overtimeRatePerHour ?? 30_000;
  const isTodayShowDay = myAtt?.todayMode === "SHOW" || (myAtt?.showDayDates?.includes(todayStr) ?? false);
  const todayBookings = myAtt?.todayBookings ?? [];
  const checkedInOffsite =
    !!todayCheckIn &&
    (todayCheckIn.isOffsite ||
      todayCheckIn.workType === "di_show" ||
      todayCheckIn.workType === "makeup_ngoai" ||
      isOffsiteMethod(todayCheckIn.method));
  const checkedInStudio = !!todayCheckIn && !checkedInOffsite;
  const displayAutoCheckInAt =
    autoCheckInAt ??
    (isStudioAutoLog(todayCheckIn) ? (todayCheckIn?.localTime ?? new Date(todayCheckIn.createdAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })) : null);

  useEffect(() => {
    if (tab !== "me") return;
    if (!lastStudioCoords?.inGeofence) return;
    if (hasCheckedIn || isTodayShowDay || myLoading) return;
    if (checkin.isPending || geoLoading) return;
    const now = Date.now();
    if (now - lastAutoCheckInAttemptRef.current < 5 * 60_000) return;
    lastAutoCheckInAttemptRef.current = now;
    setGeoErr(null);
    void checkin.mutateAsync({
      lat: lastStudioCoords.lat,
      lng: lastStudioCoords.lng,
      accuracyM: lastStudioCoords.accuracyM,
      workType: "studio_auto",
      attendanceType: "studio_auto",
      checkInMethod: "gps_auto",
      auto: true,
    }).then((data: { time?: string; localTime?: string; createdAt?: string; alreadyCheckedIn?: boolean }) => {
      const t = data.time ?? data.localTime ?? (data.createdAt ? new Date(data.createdAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }));
      setAutoCheckInAt(t);
      setCheckMsg({ ok: true, text: data.alreadyCheckedIn ? "Đã có chấm công hôm nay" : `Đã tự chấm công lúc ${t}` });
      setTimeout(() => setCheckMsg(null), 3500);
    }).catch((e: Error) => {
      setCheckMsg({ ok: false, text: e.message });
      setTimeout(() => setCheckMsg(null), 5000);
    });
  }, [tab, lastStudioCoords, hasCheckedIn, isTodayShowDay, myLoading, checkin, geoLoading]);

  const beginCheckInStudio = () => {
    setWorkType("studio");
    setQrAction("checkin");
    void doGPS("checkin");
  };
  const beginCheckInOffsite = () => {
    setWorkType("di_show");
    setQrAction("checkin");
    setGeoErr(null);
    setCheckMsg(null);
    setShowOffsiteDialog(true);
  };

  const confirmOffsiteCheckIn = async ({ file, notes }: { file: File; notes: string }) => {
    setOffsiteSaving(true);
    setGeoErr(null);
    setCheckMsg(null);
    try {
      const photoUrl = await uploadFileViaPresign(file, file.name || "selfie.jpg", file.type || "image/jpeg");
      const pos = await getGeolocationWithFallback();
      const { latitude: lat, longitude: lng } = pos.coords;
      await checkin.mutateAsync({ lat, lng, workType: "di_show", checkinPhotoUrl: photoUrl, notes: notes || undefined });
      setShowOffsiteDialog(false);
    } catch (e: unknown) {
      const msg = geoErrorMessage(e) || (e as Error)?.message || "Không đăng ký được Show ngoài";
      setGeoErr(msg);
      setCheckMsg({ ok: false, text: msg });
    } finally {
      setOffsiteSaving(false);
    }
  };
  const beginCheckInStudioQr = () => {
    setWorkType("studio");
    setQrAction("checkin");
    setShowQr(true);
  };

  const beginOvertimeCheckInQr = () => {
    setGeoErr(null);
    setCheckMsg(null);
    setQrAction("ot_checkin");
    setShowQr(true);
  };

  const beginOvertimeCheckOutQr = () => {
    setGeoErr(null);
    setCheckMsg(null);
    setQrAction("ot_checkout");
    setShowQr(true);
  };

  const qrScannerTitle =
    qrAction === "ot_checkin" ? "Bắt đầu tăng ca"
    : qrAction === "ot_checkout" ? "Kết thúc tăng ca"
    : qrAction === "checkout" ? "Check-out"
    : "Check-in";

  const daysInMonth = (() => {
    const [y, m] = month.split("-").map(Number);
    const total = new Date(y, m, 0).getDate();
    return Array.from({ length: total }, (_, i) => {
      const d = i + 1;
      const dateStr = `${month}-${String(d).padStart(2, "0")}`;
      const dayLogs = (myAtt?.logs ?? []).filter(l => (l.localDate ?? l.createdAt.slice(0, 10)) === dateStr);
      return { date: dateStr, dayNum: d, logs: dayLogs };
    });
  })();

  const monthIsClosed = monthCloseStatus?.closed === true;

  // Per-staff summary for admin tab (ưu tiên snapshot đã chốt)
  const staffSummary = (() => {
    if (monthIsClosed && monthClosureLines.length > 0) {
      return monthClosureLines.map(line => ({
        id: line.staffId,
        name: line.staffName,
        checkIns: Array.from({ length: line.workDays }, (_, i) => ({
          id: -line.staffId - i,
          staffId: line.staffId,
          staffName: line.staffName,
          type: "check_in" as const,
          isOffsite: false,
          localDate: month,
          localTime: "",
          createdAt: month,
        })) as AdminLog[],
        checkOuts: [] as AdminLog[],
        closedSnapshot: line,
      }));
    }
    const map = new Map<number, { name: string; checkIns: AdminLog[]; checkOuts: AdminLog[] }>();
    for (const l of adminLogsAttendance) {
      const sid = Number(l.staffId);
      if (!Number.isInteger(sid) || sid <= 0) continue;
      const name = l.staffName ?? staffList.find(s => s.id === sid)?.name ?? `#${sid}`;
      if (!map.has(sid)) map.set(sid, { name, checkIns: [], checkOuts: [] });
      if (l.type === "check_in") map.get(sid)!.checkIns.push(l);
      else if (l.type === "check_out") map.get(sid)!.checkOuts.push(l);
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({ id, ...v, closedSnapshot: undefined as MonthClosureLine | undefined }))
      .sort((a, b) => a.name.localeCompare(b.name, "vi"));
  })();

  const inputCls = "w-full border border-border rounded-lg px-2.5 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <div className="min-h-full bg-background">
      {/* Header */}
      <div className="px-4 sm:px-6 py-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <Timer className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Chấm công</h1>
              <p className="text-xs text-muted-foreground">Theo dõi giờ làm & chuyên cần</p>
            </div>
          </div>
        </div>

        <div className="flex gap-1 mt-3">
          {(["me"] as const).map(t => (
            <button key={t} onClick={() => setTab("me")}
              className={`px-4 py-1.5 rounded-xl text-xs font-medium transition-colors ${tab === "me" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground"}`}>
              Của tôi
            </button>
          ))}
          <button onClick={() => setTab("admin")}
            className={`px-4 py-1.5 rounded-xl text-xs font-medium transition-colors ${tab === "admin" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground"}`}>
            <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />Toàn nhân sự</span>
          </button>
          <button onClick={() => setTab("rules")}
            className={`px-4 py-1.5 rounded-xl text-xs font-medium transition-colors ${tab === "rules" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground"}`}>
            <span className="flex items-center gap-1"><Settings className="w-3.5 h-3.5" />Quy tắc</span>
          </button>
          <button onClick={() => setTab("overtime")}
            className={`px-4 py-1.5 rounded-xl text-xs font-medium transition-colors ${tab === "overtime" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground"}`}>
            <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />Tăng ca</span>
          </button>
          <button onClick={() => setTab("closures")}
            className={`px-4 py-1.5 rounded-xl text-xs font-medium transition-colors ${tab === "closures" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground"}`}>
            <span className="flex items-center gap-1"><History className="w-3.5 h-3.5" />Lịch sử chốt</span>
          </button>
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-4">
        {/* Bộ lọc tháng / năm — áp dụng mọi tab */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground font-medium">Tháng xem:</span>
          <select
            value={monthPart}
            onChange={e => setMonthFromParts(yearPart, parseInt(e.target.value, 10))}
            className="border border-border rounded-xl px-3 py-1.5 text-sm bg-background"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
              <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
            ))}
          </select>
          <select
            value={yearPart}
            onChange={e => setMonthFromParts(parseInt(e.target.value, 10), monthPart)}
            className="border border-border rounded-xl px-3 py-1.5 text-sm bg-background"
          >
            {monthYearOptions.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <span className="text-sm font-semibold text-foreground">
            {month.slice(5)}/{month.slice(0, 4)}
          </span>
          {monthIsClosed && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-semibold">
              Đã chốt công
            </span>
          )}
        </div>

        {monthIsClosed && monthCloseStatus?.closedAt && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 dark:bg-emerald-950/30 px-4 py-2.5 text-xs text-emerald-900 dark:text-emerald-100">
            Tháng <b>{month.slice(5)}/{month.slice(0, 4)}</b> đã chốt
            {monthCloseStatus.closedByName ? ` bởi ${monthCloseStatus.closedByName}` : ""}
            {" · "}
            {new Date(monthCloseStatus.closedAt).toLocaleString("vi-VN")}
            . Tổng hợp tháng dùng số đã chốt; nhật ký/lịch vẫn xem log gốc.
            {canCloseMonth && (
              <button
                type="button"
                className="ml-2 underline font-semibold"
                disabled={closeMonth.isPending}
                onClick={() => {
                  if (!confirm(`Tính lại và chốt lại tháng ${month}?`)) return;
                  closeMonth.mutate(true);
                }}
              >
                Tính lại / Chốt lại
              </button>
            )}
          </div>
        )}

        {canCloseMonth && !monthIsClosed && tab !== "closures" && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={closeMonth.isPending}
              onClick={() => {
                if (!confirm(`Chốt công tháng ${month}? Snapshot sẽ lưu cho bảng lương.`)) return;
                closeMonth.mutate(false);
              }}
            >
              {closeMonth.isPending ? "Đang chốt…" : "Chốt công tháng"}
            </Button>
            <span className="text-[11px] text-muted-foreground">Chỉ admin/owner · không xóa log gốc</span>
          </div>
        )}

        {/* ── MY ATTENDANCE TAB ──────────────────────────────────────────── */}
        {tab === "me" && (
          <div className="space-y-4">
            {useAttendanceTestActor && (
              <div className="rounded-2xl border border-blue-200 bg-blue-50 dark:bg-blue-950/30 px-4 py-3 text-sm text-blue-900 dark:text-blue-100">
                <p className="font-semibold">Chế độ test chấm công</p>
                <p className="text-xs mt-1 text-blue-800/90 dark:text-blue-200/90">
                  Bạn đang chấm công với tài khoản <strong>{attendanceSelfName}</strong> (nhân viên hệ thống).
                  Check-in/out, QR tăng ca và GPS áp dụng cho NV test — không ghi nhận cho tài khoản admin.
                </p>
              </div>
            )}
            {/* Task #505: Shift hôm nay */}
            {shiftToday && (
              <div className={`rounded-2xl border p-3 flex items-center gap-3 ${shiftToday.source === "override" ? "border-purple-300 bg-purple-50 dark:bg-purple-900/20" : "border-border bg-card"}`}>
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${shiftToday.source === "override" ? "bg-purple-100 dark:bg-purple-900/40" : "bg-blue-100 dark:bg-blue-900/30"}`}>
                  <Calendar className={`w-5 h-5 ${shiftToday.source === "override" ? "text-purple-600" : "text-blue-600"}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-muted-foreground">Ca hôm nay {shiftToday.source === "override" && <span className="ml-1 px-1.5 py-0.5 rounded bg-purple-200 text-purple-800 text-[10px] font-medium">Đặc biệt</span>}</div>
                  <div className="font-semibold text-sm">{shiftToday.name} · {shiftToday.startTime}–{shiftToday.endTime}</div>
                  <div className="text-[11px] text-muted-foreground">Chuẩn {shiftToday.standardHours}h · nghỉ linh hoạt {shiftToday.flexibleBreakHours}h</div>
                </div>
              </div>
            )}

            {/* Check-in / Check-out panel */}
            <div className="rounded-2xl border border-border bg-card p-4">
              <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4 text-blue-600" />
                Hôm nay — {new Date().toLocaleDateString("vi-VN", { weekday: "long", day: "numeric", month: "numeric" })}
              </h3>

              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 dark:bg-emerald-950/20 p-3 mb-3 text-sm">
                <div className="flex items-start gap-2">
                  <MapPin className="w-4 h-4 text-emerald-700 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-emerald-900 dark:text-emerald-100">Định vị studio tự động</p>
                    <div className="mt-1 grid gap-1 text-xs text-emerald-800/90 dark:text-emerald-100/80">
                      <span>{locationPermission === "granted" ? "Đã cấp quyền vị trí" : "Chưa cấp quyền vị trí"}</span>
                      <span>
                        {inGeofence === true
                          ? "Bạn đang trong studio"
                          : inGeofence === false
                            ? `Ngoài phạm vi studio${studioDistanceM != null ? ` · ${Math.round(studioDistanceM)}m` : ""}`
                            : "Đang kiểm tra phạm vi studio"}
                      </span>
                      {displayAutoCheckInAt && <span className="font-semibold">Đã tự chấm công lúc {displayAutoCheckInAt}</span>}
                      {checkedInStudio && !displayAutoCheckInAt && todayCheckIn?.localTime && (
                        <span className="font-semibold">Đã chấm công studio lúc {todayCheckIn.localTime}</span>
                      )}
                    </div>
                    {locationPermission !== "granted" && !hasCheckedIn && !isTodayShowDay && (
                      <button
                        type="button"
                        onClick={beginCheckInStudio}
                        disabled={geoLoading || checkin.isPending}
                        className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-60"
                      >
                        {(geoLoading || checkin.isPending) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Bật định vị để tự chấm công
                      </button>
                    )}
                    {(locationPermission === "denied" || locationPermission === "error" || locationPermission === "unsupported") && (
                      <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                        Vui lòng bật định vị trên trình duyệt/điện thoại hoặc dùng QR dự phòng.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Messages */}
              {checkMsg && (
                <div className={`flex items-center gap-2 text-sm p-2.5 rounded-lg mb-3 ${
                  checkMsg.ok ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-destructive/10 text-destructive"
                }`}>
                  {checkMsg.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
                  {checkMsg.text}
                </div>
              )}
              {geoErr && !checkMsg && (
                <div className="flex items-center gap-2 text-destructive text-xs p-2 bg-destructive/10 rounded-lg mb-3">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" /> {geoErr}
                </div>
              )}

              {isTodayShowDay && !hasCheckedIn && (
                <div className="rounded-xl border-2 border-sky-300 bg-sky-50 dark:bg-sky-950/30 p-4 mb-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <MapPin className="w-5 h-5 text-sky-700 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-sky-900 dark:text-sky-100">Hôm nay là Show Day — không cần chấm công studio</p>
                      <p className="text-xs text-sky-800/90 dark:text-sky-200/90 mt-1">
                        Bạn đã được gán lịch đi show. Hệ thống <strong>không tính phạt trễ 08:00</strong> và không bắt buộc check-in tại studio.
                        Cứ tập trung làm việc tại khách — khỏi lo nhớ chấm công.
                      </p>
                    </div>
                  </div>
                  {todayBookings.length > 0 && (
                    <ul className="text-xs text-sky-800/90 dark:text-sky-200/90 space-y-1 pl-7 list-disc">
                      {todayBookings.map(b => (
                        <li key={b.id}>
                          {b.customerName || "Khách"}
                          {b.serviceLabel ? ` · ${b.serviceLabel}` : b.packageType ? ` · ${b.packageType}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  <details className="text-xs">
                    <summary className="cursor-pointer text-sky-700 underline font-medium">Tuỳ chọn: ghi nhận GPS/selfie tại khách</summary>
                    <p className="text-muted-foreground mt-1 mb-2">Không bắt buộc. Chỉ dùng nếu muốn lưu vị trí làm việc.</p>
                    <button
                      type="button"
                      onClick={beginCheckInOffsite}
                      disabled={geoLoading || checkin.isPending}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-medium disabled:opacity-50"
                    >
                      <MapPin className="w-4 h-4" />
                      Ghi nhận tại khách (selfie + GPS)
                    </button>
                  </details>
                </div>
              )}

              {!hasCheckedIn && !isTodayShowDay && (
                <>
                  <p className="text-xs text-muted-foreground mb-3 text-center">
                    Chọn hình thức chấm vào → GPS
                    {inGeofence === true && (
                      <span className="block text-green-600 mt-0.5">📍 Bạn đang trong vùng studio</span>
                    )}
                    {inGeofence === false && (
                      <span className="block text-amber-600 mt-0.5">📍 Bạn đang ngoài vùng studio</span>
                    )}
                  </p>
                  <div className="grid gap-3 mb-3">
                    <button
                      type="button"
                      onClick={beginCheckInStudio}
                      disabled={geoLoading || checkin.isPending}
                      className="flex flex-col items-start gap-1.5 p-4 rounded-xl border-2 border-blue-300 bg-blue-50 hover:bg-blue-100 text-left transition-all active:scale-[0.99] disabled:opacity-50"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <Building2 className="w-6 h-6 text-blue-700 flex-shrink-0" />
                        <span className="font-bold text-blue-800">Tại Studio</span>
                        {(geoLoading && qrAction === "checkin" && workType === "studio") && (
                          <Loader2 className="w-4 h-4 animate-spin ml-auto text-blue-600" />
                        )}
                      </div>
                      <p className="text-xs text-blue-700/90 pl-8">
                        Dùng khi làm việc tại tiệm / studio. Cần GPS trong vùng studio.
                      </p>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); beginCheckInStudioQr(); }}
                        disabled={geoLoading || checkin.isPending}
                        className="text-[11px] text-blue-600 underline pl-8 hover:text-blue-800 disabled:opacity-50"
                      >
                        Hoặc quét QR tại cửa studio
                      </button>
                    </button>
                    <button
                      type="button"
                      onClick={beginCheckInOffsite}
                      disabled={geoLoading || checkin.isPending}
                      className="flex flex-col items-start gap-1.5 p-4 rounded-xl border-2 border-amber-300 bg-amber-50 hover:bg-amber-100 text-left transition-all active:scale-[0.99] disabled:opacity-50"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <MapPin className="w-6 h-6 text-amber-700 flex-shrink-0" />
                        <span className="font-bold text-amber-900">Đi Show ngoài</span>
                        {(geoLoading && qrAction === "checkin" && workType === "di_show") && (
                          <Loader2 className="w-4 h-4 animate-spin ml-auto text-amber-700" />
                        )}
                      </div>
                      <p className="text-xs text-amber-800/90 pl-8">
                        Dùng khi làm việc ngoài studio nhưng <strong>chưa có lịch booking</strong> trong hệ thống.
                      </p>
                    </button>
                  </div>
                </>
              )}

              {hasCheckedIn && !hasCheckedOut && checkedInOffsite && (
                <button
                  type="button"
                  onClick={() => {
                    setQrAction("checkout");
                    void doGPS("checkout");
                  }}
                  disabled={geoLoading || checkout.isPending}
                  className="w-full flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-orange-300 bg-orange-50 hover:bg-orange-100 text-orange-800 transition-all font-semibold text-sm active:scale-[0.99] disabled:opacity-50 mb-3"
                >
                  {(checkout.isPending || (geoLoading && qrAction === "checkout")) ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                  ) : (
                    <LogOut className="w-6 h-6" />
                  )}
                  {(geoLoading && qrAction === "checkout")
                    ? "Đang lấy GPS..."
                    : checkedInOffsite
                      ? "Kết thúc Show ngoài"
                      : "Ra ngoài Studio"}
                </button>
              )}

              {hasCheckedIn && !hasCheckedOut && !checkedInOffsite && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 mb-3 text-sm text-emerald-800">
                  <div className="flex items-center gap-2 font-semibold">
                    <CheckCircle2 className="w-4 h-4" />
                    Studio đã ghi nhận. Hệ thống mặc định tính đủ ca đến 18:00.
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setQrAction("checkout");
                      void doGPS("checkout");
                    }}
                    disabled={geoLoading || checkout.isPending}
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-300 bg-white text-emerald-700 text-xs font-medium hover:bg-emerald-50 disabled:opacity-60"
                  >
                    {(checkout.isPending || (geoLoading && qrAction === "checkout")) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Ghi nhận check-out thực tế (tuỳ chọn)
                  </button>
                </div>
              )}

              {hasCheckedIn && hasCheckedOut && (
                <div className="flex items-center justify-center gap-2 p-3 rounded-xl border-2 border-green-300 bg-green-50 text-green-700 font-semibold text-sm mb-3">
                  <CheckCircle2 className="w-5 h-5" />
                  Đã hoàn tất chấm công hôm nay
                </div>
              )}

              {isTodayShowDay && !hasCheckedIn ? (
                <p className="text-[11px] text-sky-700/80 mb-2">
                  Show Day: không bắt buộc check-in/check-out studio. Lịch booking đã được ghi nhận là đi làm.
                </p>
              ) : (
                <>
                <p className="hidden text-[11px] text-muted-foreground mb-2">
                  Check-out hành chính: {checkoutRules.checkoutFrom}–{checkoutRules.checkoutUntil}
                  {" · "}Quên check-out sau {checkoutRules.checkoutUntil}: phạt {vnd(checkoutRules.forgotPenalty)} (ngày công vẫn tính).
                </p>
                <p className="text-[11px] text-muted-foreground mb-2">
                  Tại studio: tự chấm bằng định vị, mặc định tính đủ ca đến 18:00. QR chỉ dùng dự phòng.
                  {" · "}Ngoài studio: cần GPS + selfie và kết thúc ca theo logic cũ.
                </p>
                </>
              )}

              {/* Today's logs */}
              {todayLogs.length > 0 && (
                <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                  {todayLogs.map(l => (
                    <div key={l.id} className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                      {l.type === "check_in" ? <LogIn className="w-3.5 h-3.5 text-blue-500" />
                        : l.type === "check_out" ? <LogOut className="w-3.5 h-3.5 text-orange-500" />
                        : l.type === "overtime_check_in" ? <Timer className="w-3.5 h-3.5 text-purple-500" />
                        : <Timer className="w-3.5 h-3.5 text-purple-400" />}
                      <span className="font-medium">
                        {l.type === "check_in" ? "Vào"
                          : l.type === "check_out" ? "Ra"
                          : l.type === "overtime_check_in" ? "Bắt đầu TC"
                          : "Kết thúc TC"}:
                      </span>
                      <span>{new Date(l.createdAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</span>
                      <span className={requiresManualCheckout(l) ? "text-amber-600" : isStudioAutoLog(l) ? "text-emerald-600" : "text-green-600"}>
                        {attendanceMethodLabel(l)}
                        {l.distanceM ? ` (${Math.round(Number(l.distanceM))}m)` : ""}
                      </span>
                      {false && l.isOffsite
                        ? <span className="text-amber-600">📍 Ngoài studio {l.distanceM ? `(${Math.round(Number(l.distanceM))}m)` : ""}</span>
                        : <span className="text-green-600">✓ Tại studio</span>}
                      {l.method === "manual" && <span className="text-violet-500 font-medium">[Thủ công]</span>}
                      {l.type === "check_in" && l.checkinPhotoUrl && <AttendanceSelfieThumb path={l.checkinPhotoUrl} />}
                      {l.notes && <span className="text-muted-foreground italic truncate max-w-[200px]" title={l.notes}>{l.notes}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Tăng ca — tách khỏi giờ hành chính */}
            <div className="rounded-2xl border border-purple-200 bg-purple-50/50 dark:bg-purple-950/20 p-4">
              <h3 className="font-semibold text-sm mb-1 flex items-center gap-2 text-purple-900 dark:text-purple-100">
                <Timer className="w-4 h-4" />
                Tăng ca
              </h3>
              <p className="text-[11px] text-muted-foreground mb-3">
                {vnd(otRateDisplay)}/giờ · tối đa 5 giờ/phiên · cần quét QR bắt đầu và kết thúc.
              </p>
              {!hasOtPending ? (
                <button
                  type="button"
                  onClick={beginOvertimeCheckInQr}
                  disabled={geoLoading || overtimeCheckin.isPending || showQr}
                  className="w-full flex items-center justify-center gap-2 p-4 rounded-xl border-2 border-purple-400 bg-white dark:bg-card hover:bg-purple-100 font-bold text-sm text-purple-800 disabled:opacity-50"
                >
                  {(geoLoading && qrAction === "ot_checkin") || overtimeCheckin.isPending
                    ? <Loader2 className="w-6 h-6 animate-spin" />
                    : <QrCode className="w-6 h-6" />}
                  Bắt đầu tăng ca (quét QR)
                </button>
              ) : (
                <button
                  type="button"
                  onClick={beginOvertimeCheckOutQr}
                  disabled={geoLoading || overtimeCheckout.isPending || showQr}
                  className="w-full flex items-center justify-center gap-2 p-4 rounded-xl border-2 border-purple-600 bg-purple-600 text-white hover:bg-purple-700 font-bold text-sm disabled:opacity-50"
                >
                  {(geoLoading && qrAction === "ot_checkout") || overtimeCheckout.isPending
                    ? <Loader2 className="w-6 h-6 animate-spin" />
                    : <QrCode className="w-6 h-6" />}
                  Kết thúc tăng ca (quét QR)
                </button>
              )}
            </div>

            {/* Summary cards */}
            {myLoading ? (
              <div className="flex items-center justify-center h-16 text-muted-foreground text-sm">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Đang tải...
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-border bg-card p-3 text-center">
                    <p className="text-2xl font-black text-blue-600">{myAtt?.totalDays ?? 0}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Ngày công</p>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-3 text-center">
                    <p className="text-2xl font-black text-emerald-600">{myAtt?.onTimeRate ?? 0}%</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Đúng giờ</p>
                  </div>
                </div>
                {/* Thưởng / Phạt / Net breakdown card */}
                <div className="rounded-2xl border border-border bg-card p-4 space-y-2">
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Thưởng / Phạt tháng này</p>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Thưởng</span>
                    <span className="font-bold text-green-600">+{vnd(myAtt?.earnedBonus ?? 0)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Phạt</span>
                    <span className="font-bold text-red-600">-{vnd(myAtt?.penalty ?? 0)}</span>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="text-sm font-semibold">Net</span>
                    <span className={`text-lg font-black ${(myAtt?.net ?? 0) >= 0 ? "text-green-700" : "text-red-700"}`}>
                      {(myAtt?.net ?? 0) >= 0 ? "+" : ""}{vnd(myAtt?.net ?? 0)}
                    </span>
                  </div>
                </div>
              </>
            )}

            {/* Calendar — Task #508 Visual */}
            {(() => {
              const dayStatuses = buildMonthDayStatuses({
                month,
                logs: myAtt?.logs ?? [],
                shifts: myAtt?.shifts,
                defaultShiftStart: myAtt?.checkInTo ?? "08:10",
                lateRules: myAtt?.lateRules ?? [],
                approvedLeaves: myAtt?.approvedLeaves ?? [],
                overtimeByDate: (myAtt?.overtime?.byDate ?? []).map(d => ({ date: d.date, hours: d.hours, amount: d.pay })),
                showDayDates: myAtt?.showDayDates ?? [],
                showTimes: myAtt?.showTimes ?? {},
              });
              return (
                <div className="rounded-2xl border border-border bg-card overflow-hidden">
                  <div className="px-4 py-2.5 border-b flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-blue-600" />
                    <span className="font-semibold text-sm">Tháng {month.slice(5)}/{month.slice(0, 4)}</span>
                  </div>
                  <div className="p-3 space-y-3">
                    <SummaryStrip days={dayStatuses} penaltyTotal={myAtt?.penalty} />
                    <VisualCalendar
                      month={month}
                      days={dayStatuses}
                      onClickDay={(d) => {
                        if (attendanceSelfId) setDayDetail({ staffId: attendanceSelfId, staffName: attendanceSelfName, date: d.date });
                      }}
                    />
                    <StatusLegend />
                  </div>
                </div>
              );
            })()}

            {/* Per-day attendance table */}
            {(myAtt?.totalDays ?? 0) > 0 && (
              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-2.5 border-b font-semibold text-sm flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-primary" /> Chi tiết từng ngày
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold">Ngày</th>
                        <th className="px-3 py-2 text-left font-semibold">Giờ vào</th>
                        <th className="px-3 py-2 text-left font-semibold">Giờ ra</th>
                        <th className="px-3 py-2 text-center font-semibold">Đúng giờ</th>
                        <th className="px-3 py-2 text-right font-semibold">Thưởng/Phạt</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {daysInMonth.filter(d => d.logs.some(l => l.type === "check_in")).map(({ date, logs }) => {
                        const ci = logs.find(l => l.type === "check_in");
                        const co = logs.find(l => l.type === "check_out");
                        const dayBp = (myAtt?.bonusPenalty ?? []).filter(bp => bp.date === date);
                        const latePenalty = dayBp.find(bp => bp.type === "penalty" && bp.isLate);
                        const isLate = !!latePenalty;
                        const waived = !!latePenalty?.waived;
                        const penaltyAmt = (latePenalty && !waived) ? latePenalty.amount : 0;
                        const bonusAmt = dayBp.filter(bp => bp.type === "bonus").reduce((s, bp) => s + bp.amount, 0);
                        const [, mm, dd] = date.split("-");
                        const ovReason = ci?.override?.reason;
                        return (
                          <tr key={date} className="hover:bg-muted/20 transition-colors">
                            <td className="px-3 py-2 font-medium">{dd}/{mm}</td>
                            <td className="px-3 py-2 font-mono">
                              <span className={isLate ? "text-red-600 font-semibold" : ""}>{ci?.localTime ?? "—"}</span>
                              {ci?.override?.time && (
                                <span title={ovReason ?? ""} className="ml-1 text-[9px] px-1 rounded bg-violet-100 text-violet-700 font-semibold cursor-help">SỬA</span>
                              )}
                              {ci?.workType && (
                                <span className="ml-1.5 text-[10px] text-muted-foreground">{WORK_TYPE_LABELS[ci.workType as WorkType] ?? ci.workType}</span>
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono text-muted-foreground">{co?.localTime ?? "—"}</td>
                            <td className="px-3 py-2 text-center">
                              {!isLate
                                ? <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700">Đúng giờ</span>
                                : waived
                                  ? <span title={latePenalty?.waiverReason ?? ""} className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-200 text-gray-700 cursor-help">Đã gỡ phạt</span>
                                  : <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700">Trễ</span>}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {dayBp.length === 0 ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <div className="flex flex-wrap justify-end gap-1">
                                  {dayBp.map((bp, i) => {
                                    const isB = bp.type === "bonus";
                                    const w = !!bp.waived;
                                    return (
                                      <span key={i}
                                        title={w ? `Đã gỡ phạt – ${bp.waiverReason ?? ""}` : (bp.description || (bp.isLate ? "Đi trễ" : "Thưởng"))}
                                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold cursor-help ${
                                          w ? "bg-gray-200 text-gray-600 line-through"
                                          : isB ? "bg-green-100 text-green-700"
                                          : "bg-red-100 text-red-700"
                                        }`}>
                                        {isB ? "+" : "−"}{vnd(bp.amount).replace(/\s?₫/, "")}
                                        <span className="font-medium opacity-70 max-w-[80px] truncate">
                                          {w ? "Đã gỡ" : (bp.description || (bp.isLate ? "Trễ" : ""))}
                                        </span>
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {adminLogsLoading ? (
              <div className="rounded-2xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Đang tải nhật ký chung…
              </div>
            ) : (
              <AttendanceJournalTable
                entries={journalEntries}
                isAdmin={isAdmin}
                adminLogsById={adminLogsById}
                onOverride={(log) => {
                  setOverrideDialog({ log });
                  setOverrideForm({ time: log.localTime ?? "", forceOnTime: false, reason: "" });
                }}
                onWaiver={(args) => {
                  setWaiverDialog(args);
                  setWaiverReason("");
                }}
                onMoneyEdit={setMoneyEditCtx}
                monthIsClosed={monthIsClosed}
              />
            )}

            {/* Bonuses */}
            {(myAtt?.bonusPenalty?.length ?? 0) > 0 && (
              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-2.5 border-b font-semibold text-sm">Thưởng / Phạt tháng</div>
                <div className="divide-y divide-border">
                  {myAtt?.bonusPenalty?.map((bp, i) => (
                    <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <div>
                        <p className="font-medium">{bp.description}</p>
                        <p className="text-xs text-muted-foreground">{bp.date}</p>
                      </div>
                      <span className={`font-bold ${bp.type === "bonus" ? "text-green-600" : "text-red-600"}`}>
                        {bp.type === "bonus" ? "+" : "-"}{vnd(bp.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Admin adjustments (visible in "me" tab for admin) */}
            {canEditAttendance && (
              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">Điều chỉnh thủ công</span>
                    <select value={adjViewStaffId} onChange={e => setAdjViewStaffId(e.target.value)}
                      className="text-xs border border-border rounded px-1.5 py-0.5 bg-background">
                      <option value="">-- Xem theo NV --</option>
                      {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <button onClick={() => setShowAdjForm(v => !v)}
                    className="text-xs text-primary hover:underline flex items-center gap-1">
                    <Plus className="w-3.5 h-3.5" /> Thêm
                  </button>
                </div>
                {showAdjForm && (
                  <div className="p-4 space-y-3 bg-muted/20 border-b border-border">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Nhân viên *</label>
                        <select value={adjForm.staffId} onChange={e => { setAdjForm(f => ({ ...f, staffId: e.target.value })); setAdjViewStaffId(e.target.value); }}
                          className={inputCls}>
                          <option value="">-- Chọn --</option>
                          {staffList.map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Loại</label>
                        <select value={adjForm.type} onChange={e => setAdjForm(f => ({ ...f, type: e.target.value }))}
                          className={inputCls}>
                          <option value="bonus">Thưởng</option>
                          <option value="penalty">Phạt</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Số tiền (đ)</label>
                        <CurrencyInput value={adjForm.amount} onChange={raw => setAdjForm(f => ({ ...f, amount: raw }))}
                          className={inputCls} placeholder="0" />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Ngày</label>
                        <DateInput value={adjForm.date} onChange={v => setAdjForm(f => ({ ...f, date: v }))}
                          className={inputCls} />
                      </div>
                    </div>
                    <input value={adjForm.reason} onChange={e => setAdjForm(f => ({ ...f, reason: e.target.value }))}
                      className={inputCls} placeholder="Lý do..." />
                    <div className="flex gap-2">
                      <Button size="sm"
                        onClick={() => addAdjustment.mutate({
                          staffId: parseInt(adjForm.staffId), type: adjForm.type,
                          amount: parseFloat(adjForm.amount), reason: adjForm.reason, date: adjForm.date,
                        })}
                        disabled={!adjForm.staffId || !adjForm.amount || addAdjustment.isPending}>
                        {addAdjustment.isPending ? "Đang lưu..." : "Lưu"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setShowAdjForm(false)}>Hủy</Button>
                    </div>
                  </div>
                )}
                {!adjViewStaffId ? (
                  <div className="text-center py-4 text-xs text-muted-foreground">Chọn nhân viên để xem điều chỉnh</div>
                ) : adminAdjustments.length === 0 && !showAdjForm ? (
                  <div className="text-center py-4 text-xs text-muted-foreground">Chưa có điều chỉnh tháng này</div>
                ) : (
                  adminAdjustments.map(adj => (
                    <div key={adj.id} className="flex items-center justify-between px-4 py-2.5 text-sm border-t border-border">
                      <div>
                        <p className="font-medium">{adj.reason || "(Không ghi chú)"}</p>
                        <p className="text-xs text-muted-foreground">{adj.date}</p>
                      </div>
                      <span className={`font-bold ${adj.type === "bonus" ? "text-green-600" : "text-red-600"}`}>
                        {adj.type === "bonus" ? "+" : "-"}{vnd(adj.amount)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* ── ADMIN TAB ──────────────────────────────────────────────────── */}
        {tab === "admin" && (
          <div className="space-y-4">
            {/* Today dashboard cards */}
            {todaySummary && (
              <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-2.5 border-b flex items-center gap-2">
                  <Clock className="w-4 h-4 text-blue-600" />
                  <span className="font-semibold text-sm">Hôm nay — {new Date().toLocaleDateString("vi-VN", { weekday: "long", day: "numeric", month: "numeric" })}</span>
                  <span className="ml-auto text-xs text-muted-foreground">Mở cửa từ {todaySummary.checkInTo}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 p-3 border-b border-border/60">
                  <button onClick={() => setTodayFilter(f => f === "showDay" ? null : "showDay")}
                    className={`rounded-xl p-3 text-center border-2 transition-all ${todayFilter === "showDay" ? "border-sky-500 bg-sky-50" : "border-transparent bg-sky-50/50 hover:bg-sky-50"}`}>
                    <p className="text-2xl font-black text-sky-700">{todaySummary.showDayCount ?? 0}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Show Day</p>
                  </button>
                  <button onClick={() => setTodayFilter(f => f === "studioDay" ? null : "studioDay")}
                    className={`rounded-xl p-3 text-center border-2 transition-all ${todayFilter === "studioDay" ? "border-emerald-500 bg-emerald-50" : "border-transparent bg-emerald-50/50 hover:bg-emerald-50"}`}>
                    <p className="text-2xl font-black text-emerald-700">{todaySummary.studioDayCount ?? 0}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Studio Day</p>
                  </button>
                  <div className="rounded-xl p-3 text-center bg-slate-50">
                    <p className="text-2xl font-black text-slate-600">{todaySummary.offDayCount ?? 0}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Off Day</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 p-3">
                  <button onClick={() => setTodayFilter(f => f === "daVao" ? null : "daVao")}
                    className={`rounded-xl p-3 text-center border-2 transition-all ${todayFilter === "daVao" ? "border-blue-500 bg-blue-50" : "border-transparent bg-blue-50/50 hover:bg-blue-50"}`}>
                    <p className="text-2xl font-black text-blue-700">{todaySummary.daVao}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Đã check-in</p>
                  </button>
                  <div className="rounded-xl p-3 text-center bg-slate-50">
                    <p className="text-2xl font-black text-slate-600">{todaySummary.chuaVao}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Studio chưa vào</p>
                  </div>
                  <button onClick={() => setTodayFilter(f => f === "diTre" ? null : "diTre")}
                    className={`rounded-xl p-3 text-center border-2 transition-all ${todayFilter === "diTre" ? "border-red-500 bg-red-50" : "border-transparent bg-red-50/50 hover:bg-red-50"}`}>
                    <p className="text-2xl font-black text-red-600">{todaySummary.diTre}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Studio trễ</p>
                  </button>
                  <button onClick={() => setTodayFilter(f => f === "dangDiShow" ? null : "dangDiShow")}
                    className={`rounded-xl p-3 text-center border-2 transition-all ${todayFilter === "dangDiShow" ? "border-amber-500 bg-amber-50" : "border-transparent bg-amber-50/50 hover:bg-amber-50"}`}>
                    <p className="text-2xl font-black text-amber-600">{todaySummary.dangDiShow}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Đang đi show</p>
                  </button>
                  <button onClick={() => setTodayFilter(f => f === "chuaCheckOut" ? null : "chuaCheckOut")}
                    className={`rounded-xl p-3 text-center border-2 transition-all ${todayFilter === "chuaCheckOut" ? "border-orange-500 bg-orange-50" : "border-transparent bg-orange-50/50 hover:bg-orange-50"}`}>
                    <p className="text-2xl font-black text-orange-600">{todaySummary.chuaCheckOut}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Chưa check-out</p>
                  </button>
                </div>
                {/* Drill-down list when a card is selected — uses today data, not month */}
                {todayFilter !== null && (() => {
                  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
                  // Always use current month for drill-down so counts match today-summary cards
                  const todayAdminLogs = (adminLogsTodayAttendance ?? []).filter(l => (l.localDate ?? l.createdAt.slice(0, 10)) === todayStr);
                  type StaffRow = { staffId: number; staffName: string; ci?: AdminLog; co?: AdminLog };
                  const map = new Map<number, StaffRow>();
                  for (const l of todayAdminLogs) {
                    const row = map.get(l.staffId) ?? { staffId: l.staffId, staffName: l.staffName ?? `#${l.staffId}` };
                    if (l.type === "check_in" && !row.ci) row.ci = l;
                    if (l.type === "check_out") row.co = l;
                    map.set(l.staffId, row);
                  }
                  let rows = Array.from(map.values());
                  if (todayFilter === "daVao") rows = rows.filter(r => r.ci);
                  const showIds = new Set(todaySummary.showDayStaffIds ?? []);
                  if (todayFilter === "diTre") rows = rows.filter(r => {
                    if (showIds.has(r.staffId)) return false;
                    if (!r.ci?.localTime) return false;
                    const ov = r.ci.override;
                    if (ov?.isLate === 0) return false;
                    if (ov?.isLate === 1) return true;
                    return r.ci.localTime > todaySummary.checkInTo;
                  });
                  if (todayFilter === "showDay") {
                    rows = (todaySummary.showDayStaff ?? []).map(s => ({
                      staffId: s.id,
                      staffName: s.name,
                      ci: s.checkedIn && s.checkInTime ? { localTime: s.checkInTime, workType: "di_show" } as AdminLog : undefined,
                      co: undefined,
                    }));
                  }
                  if (todayFilter === "studioDay") {
                    const studioIds = new Set(
                      (todaySummary.notCheckedIn ?? []).map(s => s.id).concat(
                        Array.from(map.values()).filter(r => r.ci && !showIds.has(r.staffId)).map(r => r.staffId),
                      ),
                    );
                    rows = Array.from(map.values()).filter(r => studioIds.has(r.staffId) && !showIds.has(r.staffId));
                  }
                  if (todayFilter === "dangDiShow") rows = rows.filter(r => r.ci && (r.ci.workType === "di_show" || r.ci.workType === "makeup_ngoai") && !r.co);
                  if (todayFilter === "chuaCheckOut") rows = rows.filter(r => r.ci && requiresManualCheckout(r.ci) && !r.co);
                  return (
                    <div className="px-4 pb-3 border-t border-border pt-2">
                      <p className="text-[11px] text-muted-foreground mb-1.5">{rows.length} kết quả:</p>
                      {rows.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Không có nhân sự nào.</p>
                      ) : (
                        <div className="space-y-1">
                          {rows.map(r => (
                            <div key={r.staffId} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-muted/30">
                              <Link href={`/staff-profile/${r.staffId}`} className="font-medium text-primary hover:underline flex items-center gap-1">
                                {r.staffName}
                                <ExternalLink className="w-3 h-3 opacity-50" />
                              </Link>
                              <span className="text-muted-foreground">
                                {r.ci?.localTime ? `Vào: ${r.ci.localTime}` : "—"}
                                {r.ci?.workType && ` · ${WORK_TYPE_LABELS[r.ci.workType as WorkType] ?? r.ci.workType}`}
                                {r.co?.localTime && ` · Ra: ${r.co.localTime}`}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {(todayFilter === null) && todaySummary.notCheckedIn.length > 0 && (
                  <div className="px-4 pb-3 border-t border-border pt-2">
                    <p className="text-[11px] text-muted-foreground mb-1.5">Studio chưa chấm vào ({todaySummary.notCheckedIn.length}):</p>
                    <div className="flex flex-wrap gap-1.5">
                      {todaySummary.notCheckedIn.map(s => (
                        <span key={s.id} className="px-2 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-700">{s.name}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Static QR Code card */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-2.5 border-b flex items-center gap-2">
                <QrCode className="w-4 h-4 text-violet-600" />
                <span className="font-semibold text-sm">Mã QR chấm công</span>
              </div>
              <div className="p-4 flex flex-col items-center gap-3">
                {qrImageUrl && <img src={qrImageUrl} alt="QR Code" className="rounded-xl shadow-md w-48 h-48" />}
                {!qrImageUrl && <div className="w-48 h-48 bg-muted rounded-xl animate-pulse" />}
                <p className="text-xs text-muted-foreground text-center max-w-xs">
                  Nhân viên quét mã này để chấm công.
                </p>
                <div className="flex gap-2 w-full">
                  <button onClick={handleDownloadQr} disabled={qrDownloading}
                    className="flex-1 px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted disabled:opacity-50 font-medium">
                    ⬇️ Tải QR
                  </button>
                  <button onClick={handleCopyQrLink}
                    className="flex-1 px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted font-medium">
                    📋 Copy link
                  </button>
                </div>
              </div>
            </div>
            {/* Task #508: Lịch team — mỗi ô ngày stack nhiều thanh NV (PRIMARY VIEW) */}
            <TeamCalendar
              month={month}
              staffList={staffList.map(s => ({ id: s.id, name: s.name }))}
              logsByStaff={(() => {
                const map = new Map<number, AdminLog[]>();
                for (const l of adminLogsAttendance) {
                  const arr = map.get(l.staffId) ?? [];
                  arr.push(l);
                  map.set(l.staffId, arr);
                }
                return map;
              })()}
              extras={teamExtras}
              onClickStaffDay={(staffId, staffName, date) => setDayDetail({ staffId, staffName, date })}
            />

            {/* Deep-dive: Visual calendar 1 NV (chọn dropdown) */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-2.5 border-b flex items-center gap-2 flex-wrap">
                <Calendar className="w-4 h-4 text-blue-600" />
                <span className="font-semibold text-sm">Xem chi tiết theo 1 nhân viên</span>
                <select
                  value={adminCalStaffId}
                  onChange={e => setAdminCalStaffId(e.target.value)}
                  className="ml-auto text-xs border border-border rounded px-2 py-1 bg-background"
                  data-testid="admin-cal-staff-select"
                >
                  <option value="">-- Chọn nhân viên --</option>
                  {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              {!adminCalStaffId ? (
                <div className="p-6 text-center text-xs text-muted-foreground">Chọn 1 nhân viên để xem lịch tháng theo trạng thái.</div>
              ) : !adminStaffSummary ? (
                <div className="p-6 text-center text-xs text-muted-foreground">Đang tải…</div>
              ) : (() => {
                const ds = buildMonthDayStatuses({
                  month,
                  logs: adminStaffSummary.logs ?? [],
                  shifts: adminStaffSummary.shifts,
                  defaultShiftStart: adminStaffSummary.checkInTo ?? "08:10",
                  lateRules: adminStaffSummary.lateRules ?? [],
                  approvedLeaves: adminStaffSummary.approvedLeaves ?? [],
                  overtimeByDate: adminStaffSummary.overtimeByDate ?? [],
                  showDayDates: adminStaffSummary.showDayDates ?? [],
                  showTimes: adminStaffSummary.showTimes ?? {},
                });
                const sName = staffList.find(s => String(s.id) === adminCalStaffId)?.name ?? `#${adminCalStaffId}`;
                return (
                  <div className="p-3 space-y-3">
                    <SummaryStrip days={ds} penaltyTotal={adminStaffSummary.totalPenalty} />
                    <VisualCalendar
                      month={month}
                      days={ds}
                      onClickDay={d => setDayDetail({ staffId: Number(adminCalStaffId), staffName: sName, date: d.date })}
                    />
                    <StatusLegend />
                  </div>
                );
              })()}
            </div>

            {/* View-mode toggle */}
            <div className="flex items-center gap-1">
              <button onClick={() => setAdminViewMode("table")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${adminViewMode === "table" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}>
                Bảng
              </button>
              <button onClick={() => setAdminViewMode("timeline")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${adminViewMode === "timeline" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}>
                Timeline
              </button>
            </div>

            {/* Timeline view */}
            {adminViewMode === "timeline" && (
              <AdminTimeline adminLogs={adminLogsAttendance} month={month} checkInTo={todaySummary?.checkInTo ?? "08:10"}
                canEdit={canEditAttendance}
                onWaiver={(args) => { setWaiverDialog(args); setWaiverReason(""); }}
                onOverride={(log) => { setOverrideDialog({ log }); setOverrideForm({ time: log.localTime ?? "", forceOnTime: false, reason: "" }); }}
                onClickDay={(d) => setDayDetail(d)} />
            )}

            {/* Lịch sử điều chỉnh (audit log) */}
            <AdminAuditPanel adminLogs={adminLogsAttendance} onOpenDay={(d) => setDayDetail(d)} />

            {/* Per-staff summary table */}
            {adminViewMode === "table" && (
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b">
                <span className="font-semibold text-sm flex items-center gap-2">
                  <Users className="w-4 h-4 text-blue-600" />
                  Tổng hợp tháng {month.slice(5)}/{month.slice(0, 4)}
                </span>
                {canEditAttendance && (
                  <button onClick={() => setShowManualForm(v => !v)}
                    className="flex items-center gap-1 text-xs text-primary hover:underline">
                    <Plus className="w-3.5 h-3.5" /> Chấm thủ công
                  </button>
                )}
              </div>

              {canEditAttendance && showManualForm && (
                <div className="p-4 bg-muted/20 border-b border-border space-y-3">
                  <h4 className="font-semibold text-sm">Chấm công thủ công</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Nhân viên *</label>
                      <select value={manualForm.staffId} onChange={e => setManualForm(f => ({ ...f, staffId: e.target.value }))}
                        className={inputCls}>
                        <option value="">-- Chọn --</option>
                        {staffList.map(s => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Loại *</label>
                      <select value={manualForm.type} onChange={e => setManualForm(f => ({ ...f, type: e.target.value }))}
                        className={inputCls}>
                        <option value="check_in">Vào</option>
                        <option value="check_out">Ra</option>
                      </select>
                    </div>
                  </div>
                  <input value={manualForm.notes} onChange={e => setManualForm(f => ({ ...f, notes: e.target.value }))}
                    className={inputCls} placeholder="Ghi chú..." />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => addManual.mutate({ staffId: parseInt(manualForm.staffId), type: manualForm.type, notes: manualForm.notes })}
                      disabled={!manualForm.staffId || addManual.isPending}>
                      {addManual.isPending ? "Đang lưu..." : "Lưu"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setShowManualForm(false)}>Hủy</Button>
                  </div>
                </div>
              )}

              {staffSummary.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">Chưa có dữ liệu chấm công tháng này</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="text-left px-4 py-2.5 font-semibold text-xs text-muted-foreground">Nhân viên</th>
                        <th className="text-center px-3 py-2.5 font-semibold text-xs text-muted-foreground">Ngày công</th>
                        <th className="text-center px-3 py-2.5 font-semibold text-xs text-muted-foreground">Đúng giờ</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-xs text-muted-foreground">Tổng phạt</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-xs text-muted-foreground">Tổng thưởng</th>
                        <th className="text-right px-3 py-2.5 font-semibold text-xs text-muted-foreground">Thực tính nội quy</th>
                        <th className="text-center px-3 py-2.5 font-semibold text-xs text-muted-foreground">Ngoài studio</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {staffSummary.map(s => {
                        const snap = s.closedSnapshot;
                        const money = monthIsClosed && snap
                          ? {
                              onTimeDays: snap.onTimeCount,
                              totalPenalty: snap.totalPenalty,
                              totalBonus: snap.totalBonus,
                              net: snap.netAmount,
                            }
                          : staffMoneyMap.get(s.id);
                        const workDays = monthIsClosed && snap ? snap.workDays : s.checkIns.length;
                        const offsite = monthIsClosed ? 0 : s.checkIns.filter(l => l.isOffsite).length;
                        return (
                          <tr key={s.id} className="hover:bg-muted/20 transition-colors">
                            <td className="px-4 py-2.5 font-medium">
                              <Link href={`/staff-profile/${s.id}`} className="text-primary hover:underline flex items-center gap-1">
                                {s.name}
                                <ExternalLink className="w-3 h-3 opacity-50" />
                              </Link>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <span className="font-bold text-blue-600">{workDays}</span>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <span className={`font-bold ${(money?.onTimeDays ?? 0) === workDays && workDays > 0 ? "text-green-600" : "text-amber-600"}`}>
                                {money?.onTimeDays ?? 0}/{workDays}
                              </span>
                              {monthIsClosed && snap && snap.lateCount > 0 && (
                                <span className="block text-[10px] text-red-600">{snap.lateCount} lần trễ</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right font-bold text-red-600 whitespace-nowrap">
                              <span className="inline-flex items-center justify-end">
                                {(money?.totalPenalty ?? 0) > 0 ? `−${vnd(money!.totalPenalty)}` : "0đ"}
                                {canEditAttendance && !monthIsClosed && (
                                  <MoneyEditPencil onClick={() => setMoneyEditCtx({ staffId: s.id, staffName: s.name, date: `${month}-01`, field: "penalty", label: "Tổng phạt tháng" })} />
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right font-bold text-green-600 whitespace-nowrap">
                              <span className="inline-flex items-center justify-end">
                                {(money?.totalBonus ?? 0) > 0 ? `+${vnd(money!.totalBonus)}` : "0đ"}
                                {canEditAttendance && !monthIsClosed && (
                                  <MoneyEditPencil onClick={() => setMoneyEditCtx({ staffId: s.id, staffName: s.name, date: `${month}-01`, field: "bonus", label: "Tổng thưởng tháng" })} />
                                )}
                              </span>
                            </td>
                            <td className={`px-3 py-2.5 text-right font-bold whitespace-nowrap ${(money?.net ?? 0) >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                              <span className="inline-flex items-center justify-end">
                                {(money?.net ?? 0) >= 0 ? "+" : "−"}{vnd(Math.abs(money?.net ?? 0))}
                                {canEditAttendance && !monthIsClosed && (
                                  <MoneyEditPencil onClick={() => setMoneyEditCtx({ staffId: s.id, staffName: s.name, date: `${month}-01`, field: "net", label: "Thực tính tháng" })} />
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              {offsite > 0
                                ? <span className="text-amber-600 font-medium">{offsite}</span>
                                : <span className="text-muted-foreground">0</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            )}

            {adminLogsLoading ? (
              <div className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Đang tải nhật ký chấm công…
              </div>
            ) : (
              <AttendanceJournalTable
                entries={journalEntries}
                isAdmin={isAdmin}
                adminLogsById={adminLogsById}
                defaultOpen
                onOverride={(log) => {
                  setOverrideDialog({ log });
                  setOverrideForm({ time: log.localTime ?? "", forceOnTime: false, reason: "" });
                }}
                onWaiver={(args) => {
                  setWaiverDialog(args);
                  setWaiverReason("");
                }}
                onMoneyEdit={setMoneyEditCtx}
                monthIsClosed={monthIsClosed}
              />
            )}
          </div>
        )}

        {/* ── RULES TAB ──────────────────────────────────────────────────── */}
        {tab === "rules" && (
          <div className="space-y-4">
            {!canEditAttendance && (
              <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
                Chế độ xem — quy tắc minh bạch cho toàn team. Chỉ quản trị viên mới chỉnh sửa.
              </p>
            )}
            {rulesLoading ? (
              <div className="flex items-center justify-center h-16 text-muted-foreground text-sm">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Đang tải...
              </div>
            ) : (
              <>
                {/* Main rule form */}
                <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <Clock className="w-4 h-4 text-blue-600" /> Quy tắc giờ vào chuẩn
                    </h3>
                    {canEditAttendance && (
                      !editingRules ? (
                        <Button size="sm" variant="outline" onClick={() => setEditingRules(true)}>Chỉnh sửa</Button>
                      ) : (
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => saveRules.mutate({ ...ruleForm, lateRules })}
                            disabled={saveRules.isPending}>
                            {saveRules.isPending ? "Đang lưu..." : "Lưu quy tắc"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => {
                            setEditingRules(false);
                            if (rules?.rule) {
                              setRuleForm({
                                name: (rules.rule.name as string) ?? "Mặc định",
                                checkInFrom: rules.rule.checkinStartTime,
                                checkInTo: rules.rule.checkinEndTime,
                                weeklyOnTimeBonus: String(rules.rule.weeklyBonusAmount),
                                overtimeRatePerHour: String(rules.rule.overtimeRatePerHour ?? 30000),
                              });
                            }
                            setLateRules(rules?.lateRules ?? []);
                          }}>Hủy</Button>
                        </div>
                      )
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Tên quy tắc</label>
                      {canEditAttendance && editingRules
                        ? <input value={ruleForm.name} onChange={e => setRuleForm(f => ({ ...f, name: e.target.value }))} className={inputCls} />
                        : <p className="text-sm font-medium py-1.5">{ruleForm.name}</p>}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Giờ vào hợp lệ từ</label>
                      {canEditAttendance && editingRules
                        ? <input type="time" value={ruleForm.checkInFrom} onChange={e => setRuleForm(f => ({ ...f, checkInFrom: e.target.value }))} className={inputCls} />
                        : <p className="text-sm font-medium py-1.5">{ruleForm.checkInFrom}</p>}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Giờ vào hợp lệ đến (muộn nhất)</label>
                      {canEditAttendance && editingRules
                        ? <input type="time" value={ruleForm.checkInTo} onChange={e => setRuleForm(f => ({ ...f, checkInTo: e.target.value }))} className={inputCls} />
                        : <p className="text-sm font-medium py-1.5">{ruleForm.checkInTo}</p>}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Bonus tuần chuyên cần (đ/tuần)</label>
                      {canEditAttendance && editingRules
                        ? <CurrencyInput value={ruleForm.weeklyOnTimeBonus} onChange={raw => setRuleForm(f => ({ ...f, weeklyOnTimeBonus: raw }))} className={inputCls} />
                        : <p className="text-sm font-bold text-green-600 py-1.5">{vnd(parseFloat(ruleForm.weeklyOnTimeBonus || "0"))}</p>}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Đơn giá tăng ca (đ/giờ)</label>
                      {canEditAttendance && editingRules
                        ? <CurrencyInput value={ruleForm.overtimeRatePerHour} onChange={raw => setRuleForm(f => ({ ...f, overtimeRatePerHour: raw }))} className={inputCls} />
                        : <p className="text-sm font-bold text-orange-600 py-1.5">{vnd(parseFloat(ruleForm.overtimeRatePerHour || "0"))}</p>}
                    </div>
                  </div>
                </div>

                {/* Late penalty rules */}
                <div className="rounded-2xl border border-border bg-card overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-red-500" /> Quy tắc phạt đi muộn
                    </h3>
                    {canEditAttendance && editingRules && (
                      <button
                        onClick={() => setLateRules(r => [...r, { lateFromTime: "08:00", lateToTime: null, penaltyAmount: null }])}
                        className="flex items-center gap-1 text-xs text-primary hover:underline">
                        <Plus className="w-3.5 h-3.5" /> Thêm dòng
                      </button>
                    )}
                  </div>
                  {lateRules.length === 0 ? (
                    <div className="text-center py-6 text-sm text-muted-foreground">
                      {editingRules ? 'Chưa có quy tắc phạt. Nhấn "+ Thêm dòng" để thêm.' : "Chưa có quy tắc phạt."}
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {lateRules.map((lr, i) => (
                        <div key={i} className="px-4 py-3 grid grid-cols-[1fr_1fr_1fr_auto] gap-3 items-center text-sm">
                          <div>
                            <label className="text-xs text-muted-foreground block mb-1">Muộn từ (giờ)</label>
                            {canEditAttendance && editingRules
                              ? <input type="time" value={lr.lateFromTime ?? "08:00"} onChange={e => {
                                  const copy = [...lateRules];
                                  copy[i] = { ...copy[i], lateFromTime: e.target.value };
                                  setLateRules(copy);
                                }} className={inputCls} />
                              : <span className="font-medium">{lr.lateFromTime ?? "08:00"}</span>}
                          </div>
                          <div>
                            <label className="text-xs text-muted-foreground block mb-1">Muộn đến (giờ, trống=∞)</label>
                            {canEditAttendance && editingRules
                              ? <input type="time" value={lr.lateToTime ?? ""}
                                  onChange={e => {
                                    const copy = [...lateRules];
                                    copy[i] = { ...copy[i], lateToTime: e.target.value || null };
                                    setLateRules(copy);
                                  }} className={inputCls} />
                              : <span className="font-medium">{lr.lateToTime ?? "∞"}</span>}
                          </div>
                          <div>
                            <label className="text-xs text-muted-foreground block mb-1">Phạt (đ, trống=không phạt)</label>
                            {canEditAttendance && editingRules
                              ? <CurrencyInput value={String(lr.penaltyAmount ?? "")}
                                  onChange={raw => {
                                    const copy = [...lateRules];
                                    copy[i] = { ...copy[i], penaltyAmount: raw ? parseFloat(raw) : null };
                                    setLateRules(copy);
                                  }} className={inputCls} placeholder="Không phạt" />
                              : <span className={`font-bold ${lr.penaltyAmount ? "text-red-600" : "text-muted-foreground"}`}>
                                  {lr.penaltyAmount ? `-${vnd(lr.penaltyAmount)}` : "Không phạt"}
                                </span>}
                          </div>
                          {canEditAttendance && editingRules && (
                            <button onClick={() => setLateRules(r => r.filter((_, j) => j !== i))}
                              className="p-1.5 text-destructive hover:bg-destructive/10 rounded-lg mt-4">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Save button at bottom when editing */}
                {canEditAttendance && editingRules && (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditingRules(false)}>Hủy</Button>
                    <Button size="sm" onClick={() => saveRules.mutate({ ...ruleForm, lateRules })}
                      disabled={saveRules.isPending}>
                      {saveRules.isPending ? "Đang lưu..." : "Lưu tất cả"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* QR Scanner overlay */}
      {showQr && (
        <QrScanner
          title={qrScannerTitle}
          onScan={handleQrScan}
          onClose={() => setShowQr(false)}
        />
      )}

      {/* Override dialog */}
      {overrideDialog && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-background rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm">Sửa giờ chấm công</span>
              <button onClick={() => setOverrideDialog(null)} className="p-1 rounded-lg hover:bg-muted"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-xs text-muted-foreground">
                Nhân viên: <span className="font-semibold text-foreground">{overrideDialog.log.staffName}</span>
                {" · "}{overrideDialog.log.type === "check_in" ? "Vào" : "Ra"}
                {" · "}Giờ thực: <span className="font-mono">{overrideDialog.log.localTime ?? "—"}</span>
              </div>
              <div>
                <label className="text-xs font-semibold block mb-1">Giờ mới (HH:MM, để trống = không sửa giờ)</label>
                <input type="time" value={overrideForm.time}
                  onChange={e => setOverrideForm(f => ({ ...f, time: e.target.value }))}
                  className={inputCls} />
              </div>
              {overrideDialog.log.type === "check_in" && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={overrideForm.forceOnTime}
                    onChange={e => setOverrideForm(f => ({ ...f, forceOnTime: e.target.checked }))} />
                  Tính là <span className="font-semibold text-green-700">đúng giờ</span> (gỡ trễ)
                </label>
              )}
              <div>
                <label className="text-xs font-semibold block mb-1">Lý do <span className="text-red-500">*</span></label>
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {QUICK_OVERRIDE_REASONS.map(r => (
                    <button key={r} onClick={() => setOverrideForm(f => ({ ...f, reason: r }))}
                      className="text-[10px] px-2 py-0.5 rounded bg-muted hover:bg-muted/70">{r}</button>
                  ))}
                </div>
                <textarea value={overrideForm.reason}
                  onChange={e => setOverrideForm(f => ({ ...f, reason: e.target.value }))}
                  rows={2} className={inputCls} placeholder="Tối thiểu 5 ký tự…" />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => setOverrideDialog(null)}>Hủy</Button>
                <Button size="sm"
                  disabled={overrideLog.isPending || overrideForm.reason.trim().length < 5 || (!overrideForm.time && !overrideForm.forceOnTime)}
                  onClick={() => overrideLog.mutate({
                    logId: overrideDialog.log.id,
                    overrideTime: overrideForm.time || undefined,
                    overrideIsLate: overrideDialog.log.type === "check_in" ? (overrideForm.forceOnTime ? 0 : null) : null,
                    reason: overrideForm.reason.trim(),
                  })}>
                  {overrideLog.isPending ? "Đang lưu..." : "Lưu"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Waiver dialog */}
      {dayDetail && (() => {
        // Chọn nguồn logs theo role: self → myAtt.logs; admin xem NV khác → adminLogs.
        const isSelf = attendanceSelfId === dayDetail.staffId;
        const dialogLogs: AdminLog[] = isSelf
          ? (myAtt?.logs ?? []).map(l => ({ ...l, staffId: dayDetail.staffId, staffName: dayDetail.staffName }))
          : adminLogsAttendance;
        // Resolve shiftStart per-day: ưu tiên shift override; fallback theo rule.
        const sStart = isSelf
          ? (myAtt?.shifts?.[dayDetail.date]?.startTime ?? myAtt?.checkInTo ?? "09:00")
          : resolveShiftStart(dayDetail.staffId, dayDetail.date, teamExtras?.shiftOverrides, teamExtras?.checkInTo ?? todaySummary?.checkInTo ?? "09:00");
        return (
          <DayDetailDialog
            staffId={dayDetail.staffId}
            staffName={dayDetail.staffName}
            date={dayDetail.date}
            logs={dialogLogs}
            shiftStart={sStart}
            canEdit={canEditAttendance}
            onClose={() => setDayDetail(null)}
            onOverride={(log) => { setOverrideDialog({ log }); setOverrideForm({ time: log.localTime ?? "", forceOnTime: false, reason: "" }); }}
            onWaiver={(args) => { setWaiverDialog(args); setWaiverReason(""); }}
          />
        );
      })()}


      {moneyEditCtx && (
        <AttendanceMoneyEditDialog
          ctx={moneyEditCtx}
          saving={moneyEdit.isPending}
          onClose={() => setMoneyEditCtx(null)}
          onSave={(data) => moneyEdit.mutate(data)}
        />
      )}

      {waiverDialog && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-background rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm">Gỡ phạt đi trễ</span>
              <button onClick={() => setWaiverDialog(null)} className="p-1 rounded-lg hover:bg-muted"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-xs text-muted-foreground">
                Nhân viên: <span className="font-semibold text-foreground">{waiverDialog.staffName}</span>
                {" · "}Ngày: <span className="font-mono">{waiverDialog.date}</span>
                {waiverDialog.time && <> · Giờ vào: <span className="font-mono text-red-600">{waiverDialog.time}</span></>}
                {waiverDialog.penalty > 0 && (
                  <> · Phạt: <span className="font-bold text-red-600">{vnd(waiverDialog.penalty)}</span></>
                )}
              </div>
              <p className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1.5">
                Hệ thống sẽ tạo 1 khoản <b>thưởng bù</b> bằng đúng số tiền phạt → kết quả: net = 0 cho ngày này.
              </p>
              <div>
                <label className="text-xs font-semibold block mb-1">Lý do <span className="text-red-500">*</span></label>
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {QUICK_OVERRIDE_REASONS.map(r => (
                    <button key={r} onClick={() => setWaiverReason(r)}
                      className="text-[10px] px-2 py-0.5 rounded bg-muted hover:bg-muted/70">{r}</button>
                  ))}
                </div>
                <textarea value={waiverReason} onChange={e => setWaiverReason(e.target.value)}
                  rows={2} className={inputCls} placeholder="Tối thiểu 5 ký tự…" />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => setWaiverDialog(null)}>Hủy</Button>
                <Button size="sm"
                  disabled={penaltyWaiver.isPending || waiverReason.trim().length < 5}
                  onClick={() => penaltyWaiver.mutate({ staffId: waiverDialog.staffId, date: waiverDialog.date, reason: waiverReason.trim() })}>
                  {penaltyWaiver.isPending ? "Đang xử lý..." : "Gỡ phạt"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── LỊCH SỬ CHỐT CÔNG ───────────────────────────────────────────── */}
      {tab === "closures" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-2.5 border-b flex items-center justify-between flex-wrap gap-2">
              <span className="font-semibold text-sm flex items-center gap-2">
                <History className="w-4 h-4 text-emerald-600" />
                Lịch sử chốt công
              </span>
              <span className="text-xs text-muted-foreground">
                Lọc tháng: {month.slice(5)}/{month.slice(0, 4)}
              </span>
            </div>
            {(() => {
              const rows = closureHistoryAll.filter(r => r.month === month);
              if (rows.length === 0) {
                return (
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    Chưa có bản chốt cho tháng này.
                    {canCloseMonth && (
                      <p className="mt-2">
                        Dùng nút <b>Chốt công tháng</b> ở trên để lưu snapshot.
                      </p>
                    )}
                  </div>
                );
              }
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Tháng</th>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Nhân viên</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Tổng phạt</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Tổng thưởng</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Tăng ca</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Thực tính</th>
                        <th className="text-center px-3 py-2 text-xs font-semibold text-muted-foreground">Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rows.map(r => (
                        <tr key={r.id} className="hover:bg-muted/20">
                          <td className="px-3 py-2 font-mono text-xs">{r.month.slice(5)}/{r.month.slice(0, 4)}</td>
                          <td className="px-3 py-2 font-medium">{r.staffName}</td>
                          <td className="px-3 py-2 text-right text-red-600 font-semibold">
                            {r.totalPenalty > 0 ? `−${vnd(r.totalPenalty)}` : "0đ"}
                          </td>
                          <td className="px-3 py-2 text-right text-green-600 font-semibold">
                            {r.totalBonus > 0 ? `+${vnd(r.totalBonus)}` : "0đ"}
                          </td>
                          <td className="px-3 py-2 text-right text-purple-700 font-medium">
                            {r.overtimeHours > 0 ? `${r.overtimeHours}h · ${vnd(r.overtimePay)}` : "—"}
                          </td>
                          <td className={`px-3 py-2 text-right font-bold ${r.netAmount >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                            {r.netAmount >= 0 ? "+" : "−"}{vnd(Math.abs(r.netAmount))}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                              Đã chốt
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>

          {closureHistoryAll.filter(r => r.month !== month).length > 0 && (
            <details className="rounded-xl border border-border bg-card px-4 py-2">
              <summary className="text-xs font-semibold cursor-pointer py-1">
                Các tháng đã chốt khác ({new Set(closureHistoryAll.map(r => r.month)).size} tháng)
              </summary>
              <div className="overflow-x-auto mt-2 max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left py-1">Tháng</th>
                      <th className="text-left py-1">NV</th>
                      <th className="text-right py-1">Thực tính</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closureHistoryAll
                      .filter(r => r.month !== month)
                      .slice(0, 100)
                      .map(r => (
                        <tr key={`${r.month}-${r.id}`} className="border-t border-border/50">
                          <td className="py-1">{r.month.slice(5)}/{r.month.slice(0, 4)}</td>
                          <td className="py-1">{r.staffName}</td>
                          <td className="py-1 text-right">{vnd(r.netAmount)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      {/* ── TĂNG CA TAB ─────────────────────────────────────────────────── */}
      {tab === "overtime" && (
        <div className="p-4 sm:p-6 space-y-4">
          {/* Chấm tăng ca — quét QR (cùng mã QR chấm công studio) */}
          <div className="rounded-2xl border-2 border-purple-300 bg-purple-50/60 dark:bg-purple-950/30 p-4 space-y-3">
            <h3 className="font-bold text-base flex items-center gap-2 text-purple-900 dark:text-purple-100">
              <Timer className="w-5 h-5" />
              Chấm tăng ca
            </h3>
            <p className="text-xs text-muted-foreground">
              {vnd(otRateDisplay)}/giờ · tối đa 5h/phiên · quét <b>cùng mã QR</b> chấm công tại studio.
            </p>
            {checkMsg && !checkMsg.ok && (
              <div className="flex items-center gap-2 text-sm p-2.5 rounded-lg bg-destructive/10 text-destructive">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {checkMsg.text}
              </div>
            )}
            {geoErr && !checkMsg && (
              <div className="flex items-center gap-2 text-destructive text-xs p-2 bg-destructive/10 rounded-lg">
                <AlertCircle className="w-4 h-4 flex-shrink-0" /> {geoErr}
              </div>
            )}
            {hasOtPending && (
              <p className="text-xs font-medium text-amber-800 bg-amber-100 dark:bg-amber-900/30 rounded-lg px-3 py-2">
                Đang có phiên tăng ca mở — quét QR để kết thúc.
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={beginOvertimeCheckInQr}
                disabled={hasOtPending || geoLoading || overtimeCheckin.isPending || showQr}
                className="flex flex-col items-center justify-center gap-2 min-h-[88px] p-5 rounded-2xl border-2 border-purple-500 bg-white dark:bg-card hover:bg-purple-100 font-bold text-purple-900 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.99]"
              >
                {(geoLoading && qrAction === "ot_checkin") || overtimeCheckin.isPending
                  ? <Loader2 className="w-8 h-8 animate-spin text-purple-600" />
                  : <><QrCode className="w-8 h-8 text-purple-600" /><LogIn className="w-6 h-6 text-purple-700" /></>}
                <span>Bắt đầu tăng ca</span>
                <span className="text-[10px] font-normal text-muted-foreground">Quét QR studio</span>
              </button>
              <button
                type="button"
                onClick={beginOvertimeCheckOutQr}
                disabled={!hasOtPending || geoLoading || overtimeCheckout.isPending || showQr}
                className="flex flex-col items-center justify-center gap-2 min-h-[88px] p-5 rounded-2xl border-2 border-purple-700 bg-purple-700 text-white hover:bg-purple-800 font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.99]"
              >
                {(geoLoading && qrAction === "ot_checkout") || overtimeCheckout.isPending
                  ? <Loader2 className="w-8 h-8 animate-spin" />
                  : <><QrCode className="w-8 h-8" /><LogOut className="w-6 h-6" /></>}
                <span>Kết thúc tăng ca</span>
                <span className="text-[10px] font-normal text-purple-200">Quét QR studio</span>
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4">
            <h3 className="font-semibold text-sm flex items-center gap-2 mb-2">
              <LogOut className="w-4 h-4 text-orange-600" />
              Quy tắc check-out hành chính
            </h3>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
              <li>Giờ làm hành chính kết thúc lúc <b>{checkoutRules.officialEnd}</b>.</li>
              <li>Check-out được phép từ <b>{checkoutRules.checkoutFrom}</b> đến <b>{checkoutRules.checkoutUntil}</b>.</li>
              <li>Sau <b>{checkoutRules.checkoutUntil}</b> chưa check-out → phạt <b>{vnd(checkoutRules.forgotPenalty)}</b> (ngày công vẫn tính, mặc định ra {checkoutRules.officialEnd}).</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-purple-200 bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <Timer className="w-4 h-4 text-purple-600" />
                  Phiên tăng ca — tháng {month}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {vnd(otRateDisplay)}/giờ · tối đa 5h/phiên · thiếu check-out hoặc quá 5h → 0đ
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Nhân viên</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Ngày</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Bắt đầu</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Kết thúc</th>
                    <th className="text-center px-3 py-2 text-xs font-semibold text-muted-foreground">Giờ hợp lệ</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-muted-foreground">Tiền TC</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Trạng thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {displayOtSessions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground text-sm">
                        Chưa có phiên tăng ca trong tháng này.
                      </td>
                    </tr>
                  ) : displayOtSessions.map((s, i) => (
                    <tr key={`${s.staffId}-${s.date}-${s.startTime}-${i}`} className="hover:bg-muted/20">
                      <td className="px-3 py-2 font-medium">{s.staffName ?? `#${s.staffId}`}</td>
                      <td className="px-3 py-2 font-mono text-xs">{new Date(s.date + "T12:00:00").toLocaleDateString("vi-VN")}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.startTime ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.endTime ?? "—"}</td>
                      <td className="px-3 py-2 text-center font-mono text-xs">
                        {s.status === "valid" ? `${s.hours.toFixed(1)}h` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-green-600 whitespace-nowrap">
                        {s.pay > 0 ? `+${vnd(s.pay)}` : "0đ"}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          s.status === "valid" ? "bg-purple-100 text-purple-800"
                          : s.status === "missing_checkout" ? "bg-amber-100 text-amber-800"
                          : "bg-red-100 text-red-800"
                        }`}>
                          {s.statusLabel}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {adminLogsLoading ? (
            <div className="rounded-2xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Đang tải nhật ký…
            </div>
          ) : (
            <AttendanceJournalTable
              entries={journalEntriesOvertimeTab}
              isAdmin={isAdmin}
              adminLogsById={adminLogsById}
              onOverride={(log) => {
                setOverrideDialog({ log });
                setOverrideForm({ time: log.localTime ?? "", forceOnTime: false, reason: "" });
              }}
              onWaiver={(args) => {
                setWaiverDialog(args);
                setWaiverReason("");
              }}
              defaultOpen
              onMoneyEdit={setMoneyEditCtx}
              monthIsClosed={monthIsClosed}
            />
          )}
        </div>
      )}

      {/* Shift create/edit dialog */}
      {shiftDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShiftDialog(null)}>
          <div className="bg-card rounded-2xl border border-border max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b border-border flex items-center justify-between">
              <h3 className="font-semibold">{shiftDialog.mode === "create" ? "Thêm ca làm" : "Sửa ca làm"}</h3>
              <button onClick={() => setShiftDialog(null)} className="p-1 rounded hover:bg-muted"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="text-xs font-medium">Ngày</label>
                <input type="date" value={shiftForm.date} onChange={e => setShiftForm(f => ({ ...f, date: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="text-xs font-medium">Tên ca</label>
                <input type="text" value={shiftForm.name} onChange={e => setShiftForm(f => ({ ...f, name: e.target.value }))} placeholder="VD: Ca trưa, Ca tối, Ca đặc biệt..." className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium">Giờ bắt đầu</label>
                  <input type="time" value={shiftForm.startTime} onChange={e => setShiftForm(f => ({ ...f, startTime: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className="text-xs font-medium">Giờ kết thúc</label>
                  <input type="time" value={shiftForm.endTime} onChange={e => setShiftForm(f => ({ ...f, endTime: e.target.value }))} className={inputCls} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium">Giờ chuẩn (tính lương)</label>
                  <input type="number" step="0.5" min="0" value={shiftForm.standardHours} onChange={e => setShiftForm(f => ({ ...f, standardHours: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className="text-xs font-medium">Nghỉ linh hoạt (giờ)</label>
                  <input type="number" step="0.5" min="0" value={shiftForm.flexibleBreakHours} onChange={e => setShiftForm(f => ({ ...f, flexibleBreakHours: e.target.value }))} className={inputCls} />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium">Áp dụng</label>
                <div className="flex gap-2 mt-1">
                  <button type="button" onClick={() => setShiftForm(f => ({ ...f, scope: "all" }))}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border ${shiftForm.scope === "all" ? "bg-blue-600 text-white border-blue-600" : "border-border bg-background"}`}>
                    Tất cả nhân viên
                  </button>
                  <button type="button" onClick={() => setShiftForm(f => ({ ...f, scope: "selected" }))}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border ${shiftForm.scope === "selected" ? "bg-blue-600 text-white border-blue-600" : "border-border bg-background"}`}>
                    Chọn nhân viên
                  </button>
                </div>
              </div>
              {shiftForm.scope === "selected" && (
                <div>
                  <label className="text-xs font-medium">Chọn nhân viên ({shiftForm.staffIds.length} đã chọn)</label>
                  <div className="border border-border rounded-lg p-2 max-h-40 overflow-y-auto space-y-1 mt-1">
                    {staffList.map(s => (
                      <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted px-2 py-1 rounded">
                        <input type="checkbox" checked={shiftForm.staffIds.includes(s.id)}
                          onChange={e => setShiftForm(f => ({ ...f, staffIds: e.target.checked ? [...f.staffIds, s.id] : f.staffIds.filter(x => x !== s.id) }))} />
                        {s.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs font-medium">Ghi chú</label>
                <input type="text" value={shiftForm.notes} onChange={e => setShiftForm(f => ({ ...f, notes: e.target.value }))} placeholder="(tuỳ chọn)" className={inputCls} />
              </div>
            </div>
            <div className="p-4 border-t border-border flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShiftDialog(null)}>Huỷ</Button>
              <Button size="sm" disabled={saveShift.isPending || !shiftForm.name.trim() || (shiftForm.scope === "selected" && shiftForm.staffIds.length === 0)} onClick={submitShift}>
                {saveShift.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <OffsiteCheckInDialog
        open={showOffsiteDialog}
        saving={offsiteSaving || checkin.isPending}
        onClose={() => { if (!offsiteSaving && !checkin.isPending) setShowOffsiteDialog(false); }}
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

// ─── Admin Timeline view ──────────────────────────────────────────────────────
function AdminTimeline({
  adminLogs, month, checkInTo, canEdit, onWaiver, onOverride, onClickDay,
}: {
  adminLogs: AdminLog[];
  month: string;
  checkInTo: string;
  canEdit: boolean;
  onWaiver: (a: { staffId: number; staffName: string; date: string; penalty: number; time: string }) => void;
  onOverride: (l: AdminLog) => void;
  onClickDay: (d: { staffId: number; staffName: string; date: string }) => void;
}) {
  // Group by staff -> date
  type Row = { staffId: number; staffName: string; date: string; ci?: AdminLog; co?: AdminLog };
  const rows: Row[] = (() => {
    const map = new Map<string, Row>();
    for (const l of adminLogs) {
      const date = l.localDate ?? l.createdAt.slice(0, 10);
      const key = `${l.staffId}|${date}`;
      if (!map.has(key)) map.set(key, { staffId: l.staffId, staffName: l.staffName ?? `#${l.staffId}`, date });
      const r = map.get(key)!;
      if (l.type === "check_in") r.ci = l;
      else r.co = l;
    }
    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date) || a.staffName.localeCompare(b.staffName));
  })();

  const HOUR_START = 6, HOUR_END = 22;
  const span = HOUR_END - HOUR_START;
  const toPct = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return Math.max(0, Math.min(100, ((h + m / 60 - HOUR_START) / span) * 100));
  };

  const hourTicks = Array.from({ length: span + 1 }, (_, i) => HOUR_START + i);

  if (rows.length === 0) {
    return <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">Chưa có dữ liệu chấm công tháng này</div>;
  }

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b font-semibold text-sm">
        Timeline tháng {month.slice(5)}/{month.slice(0, 4)} ({rows.length} dòng)
      </div>
      <div className="p-4 space-y-2 max-h-[600px] overflow-y-auto">
        {/* Hour scale */}
        <div className="relative h-5 text-[9px] text-muted-foreground ml-40 mr-2">
          {hourTicks.map(h => (
            <div key={h} className="absolute -translate-x-1/2" style={{ left: `${((h - HOUR_START) / span) * 100}%` }}>
              {String(h).padStart(2, "0")}h
            </div>
          ))}
        </div>
        {rows.map(r => {
          const ciTime = r.ci?.localTime;
          const coTime = r.co?.localTime;
          const isLate = !!(ciTime && ciTime > checkInTo) && r.ci?.override?.isLate !== 0;
          const noCheckout = ciTime && !coTime;
          let hours = 0;
          if (ciTime && coTime) {
            const [ch, cm] = ciTime.split(":").map(Number);
            const [oh, om] = coTime.split(":").map(Number);
            hours = (oh + om / 60) - (ch + cm / 60);
          }
          const shortHours = hours > 0 && hours < 8;
          const barColor = noCheckout ? "bg-gray-400" : shortHours ? "bg-red-500" : isLate ? "bg-orange-500" : "bg-green-500";
          const left = ciTime ? toPct(ciTime) : 0;
          const right = coTime ? toPct(coTime) : (ciTime ? toPct(ciTime) + 1 : 0);
          const width = Math.max(1, right - left);
          const [, mm, dd] = r.date.split("-");
          const wtLabel = r.ci?.workType ? ` · ${r.ci.workType}` : "";
          const hoursLabel = hours > 0 ? ` · ${hours.toFixed(1)}h` : "";
          const tooltip = `${r.staffName} · ${r.date}${wtLabel}\nVào: ${ciTime ?? "—"} → Ra: ${coTime ?? "chưa ra"}${hoursLabel}${isLate ? " · TRỄ" : ""}${noCheckout ? " · QUÊN RA" : ""}${shortHours ? " · THIẾU GIỜ" : ""}\nClick để xem chi tiết`;
          return (
            <div key={`${r.staffId}-${r.date}`} className="flex items-center gap-2 group hover:bg-muted/20 rounded px-1 py-0.5">
              <div className="w-40 shrink-0 text-xs">
                <div className="font-medium truncate">{r.staffName}</div>
                <div className="text-[10px] text-muted-foreground">{dd}/{mm} · {ciTime ?? "—"}→{coTime ?? "?"}{hoursLabel}</div>
              </div>
              <button
                type="button"
                onClick={() => onClickDay({ staffId: r.staffId, staffName: r.staffName, date: r.date })}
                title={tooltip}
                className="relative flex-1 h-6 bg-muted/30 rounded hover:bg-muted/50 cursor-pointer text-left">
                {hourTicks.map(h => (
                  <div key={h} className="absolute top-0 bottom-0 w-px bg-border/50" style={{ left: `${((h - HOUR_START) / span) * 100}%` }} />
                ))}
                {ciTime && (
                  <div
                    className={`absolute top-1 bottom-1 ${barColor} rounded pointer-events-none`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                )}
              </button>
              {canEdit && (
                <div className="w-24 shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {r.ci && (
                    <button onClick={(e) => { e.stopPropagation(); onOverride(r.ci!); }}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 hover:bg-violet-100 text-violet-700">Sửa</button>
                  )}
                  {isLate && (
                    <button onClick={(e) => { e.stopPropagation(); onWaiver({ staffId: r.staffId, staffName: r.staffName, date: r.date, penalty: 0, time: ciTime! }); }}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 hover:bg-amber-100 text-amber-700">Gỡ</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 pt-3 mt-2 border-t text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-green-500 rounded" /> Đủ giờ</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-orange-500 rounded" /> Đi trễ</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-red-500 rounded" /> Thiếu &lt;8h</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-gray-400 rounded" /> Quên check-out</span>
        </div>
      </div>
    </div>
  );
}

// ─── Admin Audit Panel — Lịch sử điều chỉnh (overrides) ─────────────────────
function AdminAuditPanel({
  adminLogs, onOpenDay,
}: {
  adminLogs: AdminLog[];
  onOpenDay: (d: { staffId: number; staffName: string; date: string }) => void;
}) {
  const overrides = (adminLogs ?? [])
    .filter(l => l.override)
    .sort((a, b) => (b.override!.createdAt ?? "").localeCompare(a.override!.createdAt ?? ""));
  const [expanded, setExpanded] = useState(false);
  if (overrides.length === 0) return null;
  const shown = expanded ? overrides : overrides.slice(0, 5);
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b flex items-center justify-between">
        <span className="font-semibold text-sm flex items-center gap-2">
          <History className="w-4 h-4 text-violet-600" /> Lịch sử điều chỉnh ({overrides.length})
        </span>
        {overrides.length > 5 && (
          <button onClick={() => setExpanded(v => !v)} className="text-xs text-primary hover:underline">
            {expanded ? "Thu gọn" : `Xem tất cả`}
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Thời điểm sửa</th>
              <th className="px-3 py-2 text-left font-semibold">Nhân viên</th>
              <th className="px-3 py-2 text-left font-semibold">Ngày · Loại log</th>
              <th className="px-3 py-2 text-left font-semibold">Thay đổi</th>
              <th className="px-3 py-2 text-left font-semibold">Lý do</th>
              <th className="px-3 py-2 text-left font-semibold">Người duyệt</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map(l => {
              const ov = l.override!;
              const when = ov.createdAt
                ? new Date(ov.createdAt).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })
                : "—";
              const changes: string[] = [];
              if (ov.time && ov.time !== l.localTime) changes.push(`Giờ: ${l.localTime ?? "—"} → ${ov.time}`);
              if (typeof ov.isLate === "number") changes.push(ov.isLate === 0 ? "Đánh dấu đúng giờ" : "Đánh dấu trễ");
              const dateStr = l.localDate ?? "";
              return (
                <tr key={`${l.id}-${ov.createdAt}`} className="hover:bg-muted/20 cursor-pointer"
                  onClick={() => onOpenDay({ staffId: l.staffId, staffName: l.staffName, date: dateStr })}>
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{when}</td>
                  <td className="px-3 py-2 font-medium">{l.staffName}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{dateStr} · {l.type === "check_in" ? "Vào" : "Ra"}</td>
                  <td className="px-3 py-2">
                    {changes.length === 0 ? <span className="text-muted-foreground">—</span>
                      : changes.map((c, i) => <div key={i} className="text-violet-700">{c}</div>)}
                  </td>
                  <td className="px-3 py-2 max-w-[240px] truncate" title={ov.reason ?? ""}>{ov.reason ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{ov.createdByName ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Day Detail Dialog (click bar → xem chi tiết 1 ngày) ────────────────────
function DayDetailDialog({
  staffId, staffName, date, logs, shiftStart, canEdit, onClose, onOverride, onWaiver,
}: {
  staffId: number;
  staffName: string;
  date: string;
  logs: AdminLog[];
  shiftStart: string;
  canEdit: boolean;
  onClose: () => void;
  onOverride: (l: AdminLog) => void;
  onWaiver: (a: { staffId: number; staffName: string; date: string; penalty: number; time: string }) => void;
}) {
  const dayLogs = (logs ?? [])
    .filter(l => l.staffId === staffId && (l.localDate ?? l.createdAt.slice(0, 10)) === date)
    .sort((a, b) => (a.localTime ?? "").localeCompare(b.localTime ?? ""));
  const ci = dayLogs.find(l => l.type === "check_in");
  const co = dayLogs.find(l => l.type === "check_out");
  let hours = 0;
  if (ci?.localTime && co?.localTime) {
    const [ch, cm] = ci.localTime.split(":").map(Number);
    const [oh, om] = co.localTime.split(":").map(Number);
    hours = (oh + om / 60) - (ch + cm / 60);
  }
  const isLate = !!(ci?.localTime && ci.localTime > shiftStart) && ci?.override?.isLate !== 0;
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-background rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <div className="font-semibold text-sm">{staffName}</div>
            <div className="text-[11px] text-muted-foreground">{date} {ci?.workType ? `· ${ci.workType}` : ""}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-blue-50 p-2">
              <div className="text-[10px] text-muted-foreground">Vào</div>
              <div className="font-bold text-blue-700">{ci?.localTime ?? "—"}</div>
            </div>
            <div className="rounded-lg bg-orange-50 p-2">
              <div className="text-[10px] text-muted-foreground">Ra</div>
              <div className="font-bold text-orange-700">{co?.localTime ?? "—"}</div>
            </div>
            <div className={`rounded-lg p-2 ${hours >= 8 ? "bg-green-50" : "bg-red-50"}`}>
              <div className="text-[10px] text-muted-foreground">Tổng giờ</div>
              <div className={`font-bold ${hours >= 8 ? "text-green-700" : "text-red-700"}`}>{hours > 0 ? `${hours.toFixed(1)}h` : "—"}</div>
            </div>
          </div>
          {isLate && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              ⚠ Đi trễ so với giờ chuẩn {shiftStart}
            </div>
          )}
          {ci?.checkinPhotoUrl && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
              <AttendanceSelfieThumb path={ci.checkinPhotoUrl} size="md" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-amber-900">Selfie xác thực (Show ngoài)</p>
                {ci.notes && <p className="text-[11px] text-muted-foreground mt-0.5">{ci.notes}</p>}
              </div>
            </div>
          )}
          {(ci?.lat != null || co?.lat != null) && (
            <div className="text-[11px] text-muted-foreground space-y-0.5">
              {ci?.lat != null && ci?.lng != null && (
                <p>📍 Vào: {Number(ci.lat).toFixed(5)}, {Number(ci.lng).toFixed(5)}
                  {ci.distanceM != null ? ` · ${Math.round(Number(ci.distanceM))}m` : ""}
                  {ci.isOffsite ? " (ngoài studio)" : " (studio)"}
                </p>
              )}
              {co?.lat != null && co?.lng != null && (
                <p>📍 Ra: {Number(co.lat).toFixed(5)}, {Number(co.lng).toFixed(5)}</p>
              )}
            </div>
          )}
          <div className="rounded-lg border border-border divide-y">
            {dayLogs.length === 0 && <div className="px-3 py-2 text-muted-foreground text-xs text-center">Không có log nào.</div>}
            {dayLogs.map(l => (
              <div key={l.id} className="px-3 py-2 flex items-center gap-2 text-xs">
                {l.type === "check_in" ? <LogIn className="w-3.5 h-3.5 text-blue-500" /> : <LogOut className="w-3.5 h-3.5 text-orange-500" />}
                <span className="font-medium w-10">{l.type === "check_in" ? "Vào" : "Ra"}</span>
                <span className="font-mono">{l.localTime ?? "—"}</span>
                {l.isOffsite ? <span className="text-amber-600">📍 Ngoài studio</span> : <span className="text-green-600">✓ Tại studio</span>}
                {l.override && <span className="text-violet-600 font-semibold" title={l.override.reason ?? ""}>SỬA</span>}
                {canEdit && (l.type === "check_in" || l.type === "check_out") && (
                  <button onClick={() => onOverride(l)}
                    className="ml-auto text-[10px] px-2 py-0.5 rounded bg-violet-50 hover:bg-violet-100 text-violet-700">Sửa giờ</button>
                )}
              </div>
            ))}
          </div>
          {canEdit && isLate && ci?.localTime && (
            <button onClick={() => onWaiver({ staffId, staffName, date, penalty: 0, time: ci.localTime! })}
              className="w-full text-xs px-3 py-2 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-800 font-semibold">
              Gỡ phạt đi trễ cho ngày này
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
