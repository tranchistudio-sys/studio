export type WebhookEvent = {
  at: string;
  type: "verification" | "message" | "postback" | "other" | "error";
  summary: string;
  psid?: string;
};

const MAX_EVENTS = 50;
export const webhookEvents: WebhookEvent[] = [];

export function logWebhookEvent(e: WebhookEvent) {
  webhookEvents.unshift(e);
  if (webhookEvents.length > MAX_EVENTS) webhookEvents.length = MAX_EVENTS;
}
