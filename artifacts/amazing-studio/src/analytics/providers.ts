import type { AnalyticsEvent } from "./types";

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
    clarity?: (...args: unknown[]) => void;
    _fbq?: unknown;
  }
}

let initialized = false;
const debug = import.meta.env.VITE_ANALYTICS_DEBUG === "true";

function appendScript(src: string, id: string) {
  if (document.getElementById(id)) return;
  const script = document.createElement("script");
  script.id = id;
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

export function initializeProviders() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  const pixelId = import.meta.env.VITE_META_PIXEL_ID?.trim();
  if (pixelId) {
    const fbq = function (...args: unknown[]) { (fbq as any).callMethod ? (fbq as any).callMethod(...args) : (fbq as any).queue.push(args); } as any;
    fbq.queue = []; fbq.loaded = true; fbq.version = "2.0";
    window.fbq = fbq; window._fbq = fbq;
    appendScript("https://connect.facebook.net/en_US/fbevents.js", "meta-pixel-script");
    fbq("init", pixelId);
  }

  const gaId = import.meta.env.VITE_GA_MEASUREMENT_ID?.trim();
  if (gaId) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = (...args: unknown[]) => { window.dataLayer!.push(args); };
    window.gtag("js", new Date());
    window.gtag("config", gaId, { send_page_view: false });
    appendScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`, "ga4-script");
  }

  const gtmId = import.meta.env.VITE_GTM_ID?.trim();
  if (gtmId) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
    appendScript(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`, "gtm-script");
  }

  const clarityId = import.meta.env.VITE_CLARITY_PROJECT_ID?.trim();
  if (clarityId) {
    window.clarity = window.clarity || function (...args: unknown[]) { ((window.clarity as any).q ||= []).push(args); };
    appendScript(`https://www.clarity.ms/tag/${encodeURIComponent(clarityId)}`, "clarity-script");
  }
}

const gaNames: Record<AnalyticsEvent["name"], string> = {
  PageView: "page_view", ViewContent: "view_service", Contact: "contact",
  Lead: "generate_lead", Schedule: "schedule_booking", Purchase: "purchase",
};

export function dispatch(event: AnalyticsEvent) {
  initializeProviders();
  const params = { ...(event.params || {}), event_id: event.eventId };
  window.fbq?.("track", event.name, event.params || {}, event.eventId ? { eventID: event.eventId } : undefined);
  window.gtag?.("event", gaNames[event.name], params);
  window.dataLayer?.push({ event: `studio_${gaNames[event.name]}`, event_name: event.name, ...params });
  if (debug) console.info("[Analytics]", event.name, params);
}
