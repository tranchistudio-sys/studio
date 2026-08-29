import type { Attribution, AttributionTouch } from "./types";

const STORAGE_KEY = "amazingStudioAttribution_v1";
const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"] as const;

function read(): Attribution | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Attribution | null; }
  catch { return null; }
}

function touchFromLocation(): AttributionTouch {
  const query = new URLSearchParams(location.search);
  return {
    capturedAt: new Date().toISOString(),
    landingPage: `${location.pathname}${location.search}`,
    referrer: document.referrer || undefined,
    utmSource: query.get("utm_source") || undefined,
    utmMedium: query.get("utm_medium") || undefined,
    utmCampaign: query.get("utm_campaign") || undefined,
    utmContent: query.get("utm_content") || undefined,
    utmTerm: query.get("utm_term") || undefined,
    fbclid: query.get("fbclid") || undefined,
    gclid: query.get("gclid") || undefined,
  };
}

export function captureAttribution(): Attribution | null {
  if (typeof window === "undefined") return null;
  const existing = read();
  const next = touchFromLocation();
  const hasCampaign = CAMPAIGN_KEYS.some((key) => new URLSearchParams(location.search).has(key));
  const attribution: Attribution = existing
    ? { firstTouch: existing.firstTouch, lastTouch: hasCampaign ? next : existing.lastTouch }
    : { firstTouch: next, lastTouch: next };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(attribution)); } catch { /* storage may be disabled */ }
  return attribution;
}

export function getAttribution(): Attribution | null {
  return typeof window === "undefined" ? null : read();
}
