import { computeFamilyPaymentSummary, isCollectedPayment, money } from "./booking-money";

export type CheckpointBookingInput = {
  id: number;
  parentId?: number | null;
  isParentContract?: boolean | null;
  status?: string | null;
  deletedAt?: unknown;
  shootDate?: string | Date | null;
  totalAmount: number | string | null | undefined;
  discountAmount?: number | string | null;
  occurrences?: readonly { shootDate?: string | Date | null }[];
};

export type CheckpointPaymentInput = {
  id?: number | null;
  bookingId?: number | null;
  amount?: number | string | null;
  paymentType?: string | null;
  status?: string | null;
  paidDate?: string | null;
  paidAt?: string | Date | null;
};

export type CollectionCheckpointState = "collected" | "due" | "final_due";
export type BookingCheckpointStates = Map<number, Map<string, CollectionCheckpointState>>;

const HCM_TIME_ZONE = "Asia/Ho_Chi_Minh";

/** Calendar date in Vietnam. Date-only values stay date-only (no UTC shift). */
export function vietnamDateKey(value: string | Date | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const isoDay = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/);
    if (isoDay && !trimmed.includes("T") && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) return isoDay[1];
    const viDay = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (viDay) return `${viDay[3]}-${viDay[2].padStart(2, "0")}-${viDay[1].padStart(2, "0")}`;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HCM_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function todayInVietnam(now: Date = new Date()): string {
  return vietnamDateKey(now)!;
}

function isLiveService(booking: CheckpointBookingInput): boolean {
  return booking.deletedAt == null
    && booking.status !== "cancelled"
    && booking.isParentContract !== true;
}

/**
 * Pure/read-only projection for Calendar payment dots. It never allocates, edits,
 * or creates a payment. Each valid receipt can close at most one due non-final
 * checkpoint. The final checkpoint is green only when family remaining is zero.
 */
export function deriveCollectionCheckpoints(
  bookings: readonly CheckpointBookingInput[],
  payments: readonly CheckpointPaymentInput[],
  todayKey: string,
): BookingCheckpointStates {
  const byId = new Map(bookings.map((booking) => [booking.id, booking]));
  const familyMembers = new Map<number, CheckpointBookingInput[]>();
  for (const booking of bookings) {
    const rootId = booking.parentId ?? booking.id;
    const members = familyMembers.get(rootId) ?? [];
    members.push(booking);
    familyMembers.set(rootId, members);
  }

  const output: BookingCheckpointStates = new Map();
  for (const [rootId, rawMembers] of familyMembers) {
    const root = byId.get(rootId);
    if (!root || root.deletedAt != null || root.status === "cancelled") continue;
    const services = rawMembers.filter(isLiveService);
    if (services.length === 0) continue;

    const checkpointMembers = new Map<string, Set<number>>();
    for (const service of services) {
      const dates = [service.shootDate, ...(service.occurrences ?? []).map((item) => item.shootDate)];
      for (const value of dates) {
        const date = vietnamDateKey(value);
        if (!date) continue;
        const ids = checkpointMembers.get(date) ?? new Set<number>();
        ids.add(service.id);
        checkpointMembers.set(date, ids);
      }
    }
    const checkpointDates = [...checkpointMembers.keys()].sort();
    if (checkpointDates.length === 0) continue;
    const finalDate = checkpointDates[checkpointDates.length - 1];
    const familyIds = new Set(rawMembers.map((member) => member.id));

    const seen = new Set<number>();
    const familyPayments = payments
      .filter((payment) => {
        if (payment.bookingId == null || !familyIds.has(Number(payment.bookingId))) return false;
        if (!isCollectedPayment(payment) || money(payment.amount) <= 0) return false;
        if (payment.id == null) return true;
        const id = Number(payment.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((payment) => ({ payment, date: vietnamDateKey(payment.paidDate ?? payment.paidAt) }))
      .filter((entry): entry is { payment: CheckpointPaymentInput; date: string } => entry.date != null)
      .sort((a, b) => a.date.localeCompare(b.date) || Number(a.payment.id ?? Number.MAX_SAFE_INTEGER) - Number(b.payment.id ?? Number.MAX_SAFE_INTEGER));

    const closed = new Set<string>();
    for (const { payment, date } of familyPayments) {
      // A receipt before the first service day is a deposit, not a checkpoint receipt.
      if (date < checkpointDates[0]) continue;
      const eligible = checkpointDates.filter((checkpoint) => checkpoint !== finalDate && checkpoint <= date && !closed.has(checkpoint));
      if (eligible.length === 0) continue;
      const direct = payment.bookingId == null
        ? undefined
        : eligible.find((checkpoint) => checkpointMembers.get(checkpoint)?.has(Number(payment.bookingId)));
      closed.add(direct ?? eligible[0]);
    }

    const summary = computeFamilyPaymentSummary(root, familyIds, familyPayments.map((entry) => entry.payment));
    for (const date of checkpointDates) {
      if (date > todayKey) continue;
      const state: CollectionCheckpointState = date === finalDate
        ? (summary.remaining <= 0 ? "collected" : "final_due")
        : (closed.has(date) ? "collected" : "due");
      for (const bookingId of checkpointMembers.get(date) ?? []) {
        const states = output.get(bookingId) ?? new Map<string, CollectionCheckpointState>();
        states.set(date, state);
        output.set(bookingId, states);
      }
    }
  }
  return output;
}

export function serializeCheckpointStates(states: BookingCheckpointStates): Record<number, Record<string, CollectionCheckpointState>> {
  const result: Record<number, Record<string, CollectionCheckpointState>> = {};
  for (const [bookingId, dates] of states) result[bookingId] = Object.fromEntries(dates);
  return result;
}
