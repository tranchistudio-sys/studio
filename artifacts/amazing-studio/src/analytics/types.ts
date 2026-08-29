export type AttributionTouch = {
  capturedAt: string;
  landingPage: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  fbclid?: string;
  gclid?: string;
};

export type Attribution = {
  firstTouch: AttributionTouch;
  lastTouch: AttributionTouch;
};

export type AnalyticsEvent = {
  name: "PageView" | "ViewContent" | "Contact" | "Lead" | "Schedule" | "Purchase";
  eventId?: string;
  params?: Record<string, unknown>;
};
