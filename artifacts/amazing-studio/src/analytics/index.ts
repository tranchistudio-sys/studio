import { captureAttribution, getAttribution } from "./attribution";
import { dispatch } from "./providers";
import type { AnalyticsEvent } from "./types";

let lastPageView: string | null = null;
const emit = (name: AnalyticsEvent["name"], params?: Record<string, unknown>, eventId?: string) => {
  try { dispatch({ name, params, eventId }); }
  catch { /* analytics must never block customer navigation or business UI */ }
};

export function shouldTrackPageView(path: string) {
  if (lastPageView === path) return false;
  lastPageView = path;
  return true;
}

export function resetPageViewTrackingForTests() { lastPageView = null; }

export const analytics = {
  captureAttribution,
  getAttribution,
  pageView(path: string) {
    if (!shouldTrackPageView(path)) return;
    emit("PageView", { page_path: path, page_title: document.title });
  },
  viewContent(params: Record<string, unknown>) { emit("ViewContent", params); },
  contact(method: "messenger" | "zalo" | "phone" | "email") { emit("Contact", { contact_method: method }); },
  lead(params: Record<string, unknown>, eventId: string) { emit("Lead", params, eventId); },
  schedule(params: Record<string, unknown>, eventId: string) { emit("Schedule", params, eventId); },
  purchase(value: number, paymentId: string | number, eventId = `purchase_${paymentId}`) {
    emit("Purchase", { value, currency: "VND", payment_id: String(paymentId) }, eventId);
  },
};

export type { Attribution } from "./types";
