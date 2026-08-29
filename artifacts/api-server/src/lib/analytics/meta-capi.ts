import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { analyticsEventsTable, bookingsTable, customersTable, paymentsTable } from "@workspace/db/schema";

type AttributionTouch = { fbclid?: string; landingPage?: string };
type Attribution = { firstTouch?: AttributionTouch; lastTouch?: AttributionTouch };

const sha256 = (value: string) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
const normalizePhone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  return digits.startsWith("0") ? `84${digits.slice(1)}` : digits;
};

function fbcFrom(attribution: Attribution | null): string | undefined {
  const fbclid = attribution?.lastTouch?.fbclid || attribution?.firstTouch?.fbclid;
  return fbclid ? `fb.1.${Math.floor(Date.now() / 1000)}.${fbclid}` : undefined;
}

function absoluteSourceUrl(value?: string) {
  const base = process.env.PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!value) return base;
  try { return new URL(value, base || "https://tranchistudio.com").toString(); }
  catch { return base; }
}

export function metaCapiConfigured() {
  return Boolean(process.env.META_PIXEL_ID?.trim() && process.env.META_CAPI_ACCESS_TOKEN?.trim());
}

async function sendEvent(input: {
  eventName: "Schedule" | "Purchase" | "Lead";
  eventId: string;
  sourceType: string;
  sourceId: string;
  sourceUrl?: string;
  userData: Record<string, unknown>;
  customData: Record<string, unknown>;
}) {
  if (!metaCapiConfigured()) return { disabled: true } as const;
  const eventKey = `meta_capi:${input.eventName}:${input.sourceType}:${input.sourceId}`;
  const inserted = await db.insert(analyticsEventsTable).values({
    eventKey, eventName: input.eventName, eventId: input.eventId,
    sourceType: input.sourceType, sourceId: input.sourceId,
    status: "sending", payload: { customData: input.customData },
  }).onConflictDoNothing({ target: analyticsEventsTable.eventKey }).returning({ id: analyticsEventsTable.id });
  let recordId = inserted[0]?.id;
  if (!recordId) {
    const [existing] = await db.select({ id: analyticsEventsTable.id, status: analyticsEventsTable.status })
      .from(analyticsEventsTable).where(eq(analyticsEventsTable.eventKey, eventKey));
    if (!existing || existing.status !== "failed") return { duplicate: true } as const;
    const [claimed] = await db.update(analyticsEventsTable)
      .set({ status: "sending", updatedAt: new Date() })
      .where(and(eq(analyticsEventsTable.id, existing.id), eq(analyticsEventsTable.status, "failed")))
      .returning({ id: analyticsEventsTable.id });
    if (!claimed) return { duplicate: true } as const;
    recordId = claimed.id;
  }

  const pixelId = process.env.META_PIXEL_ID!.trim();
  const version = (process.env.META_GRAPH_API_VERSION || "v23.0").trim();
  const body: Record<string, unknown> = {
    data: [{
      event_name: input.eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: input.eventId,
      action_source: "website",
      event_source_url: absoluteSourceUrl(input.sourceUrl),
      user_data: input.userData,
      custom_data: input.customData,
    }],
  };
  if (process.env.META_CAPI_TEST_EVENT_CODE?.trim()) body.test_event_code = process.env.META_CAPI_TEST_EVENT_CODE.trim();

  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${pixelId}/events?access_token=${encodeURIComponent(process.env.META_CAPI_ACCESS_TOKEN!.trim())}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Meta CAPI HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    await db.update(analyticsEventsTable).set({ status: "sent", attempts: 1, sentAt: new Date(), updatedAt: new Date() }).where(eq(analyticsEventsTable.id, recordId));
    return { sent: true } as const;
  } catch (error) {
    await db.update(analyticsEventsTable).set({ status: "failed", attempts: 1, lastError: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error", updatedAt: new Date() }).where(eq(analyticsEventsTable.id, recordId));
    throw error;
  }
}

export async function sendPurchaseForPayment(paymentId: number) {
  const [row] = await db.select({
    paymentId: paymentsTable.id, amount: paymentsTable.amount, status: paymentsTable.status,
    bookingId: bookingsTable.id, attribution: bookingsTable.attribution,
    phone: customersTable.phone, email: customersTable.email,
  }).from(paymentsTable)
    .innerJoin(bookingsTable, eq(paymentsTable.bookingId, bookingsTable.id))
    .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
    .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "active")));
  if (!row?.attribution) return { unattributed: true } as const;
  const attribution = row.attribution as Attribution;
  const userData: Record<string, unknown> = {};
  if (row.phone) userData.ph = [sha256(normalizePhone(row.phone))];
  if (row.email) userData.em = [sha256(row.email)];
  const fbc = fbcFrom(attribution); if (fbc) userData.fbc = fbc;
  return sendEvent({
    eventName: "Purchase", eventId: `purchase_${row.paymentId}`,
    sourceType: "payment", sourceId: String(row.paymentId),
    sourceUrl: attribution.lastTouch?.landingPage || attribution.firstTouch?.landingPage,
    userData, customData: { value: Number(row.amount), currency: "VND", payment_id: String(row.paymentId), booking_id: String(row.bookingId) },
  });
}

export function queuePurchaseForPayment(paymentId: number) {
  void sendPurchaseForPayment(paymentId).catch((error) => {
    console.warn("[analytics] Purchase CAPI delivery failed", { paymentId, error: error instanceof Error ? error.message : "unknown" });
  });
}

export async function sendScheduleForBooking(bookingId: number) {
  const [row] = await db.select({
    bookingId: bookingsTable.id, shootDate: bookingsTable.shootDate,
    service: bookingsTable.serviceLabel, packageType: bookingsTable.packageType,
    attribution: bookingsTable.attribution, phone: customersTable.phone, email: customersTable.email,
  }).from(bookingsTable)
    .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
    .where(eq(bookingsTable.id, bookingId));
  if (!row?.attribution) return { unattributed: true } as const;
  const attribution = row.attribution as Attribution;
  const userData: Record<string, unknown> = {};
  if (row.phone) userData.ph = [sha256(normalizePhone(row.phone))];
  if (row.email) userData.em = [sha256(row.email)];
  const fbc = fbcFrom(attribution); if (fbc) userData.fbc = fbc;
  return sendEvent({
    eventName: "Schedule", eventId: `schedule_${row.bookingId}`,
    sourceType: "booking", sourceId: String(row.bookingId),
    sourceUrl: attribution.lastTouch?.landingPage || attribution.firstTouch?.landingPage,
    userData, customData: { booking_id: String(row.bookingId), booking_date: row.shootDate, service: row.service || row.packageType },
  });
}

export function queueScheduleForBooking(bookingId: number) {
  void sendScheduleForBooking(bookingId).catch((error) => {
    console.warn("[analytics] Schedule CAPI delivery failed", { bookingId, error: error instanceof Error ? error.message : "unknown" });
  });
}
