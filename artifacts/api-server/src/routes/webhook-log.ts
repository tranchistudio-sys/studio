import { currentTenantScope } from "../lib/tenant-scope";

export type WebhookEvent = {
  at: string;
  type: "verification" | "message" | "postback" | "other" | "error";
  summary: string;
  psid?: string;
};

const MAX_EVENTS = 50;
const tenantWebhookEvents = new Map<string, WebhookEvent[]>();

function currentEvents(): WebhookEvent[] {
  const tenantScope = currentTenantScope();
  let events = tenantWebhookEvents.get(tenantScope);
  if (!events) {
    events = [];
    tenantWebhookEvents.set(tenantScope, events);
  }
  return events;
}

// Compatibility facade for the existing inbox route. Array reads and JSON
// serialization resolve against the request's tenant rather than one process-
// global event list.
export const webhookEvents: WebhookEvent[] = new Proxy([] as WebhookEvent[], {
  get(_target, property) {
    const events = currentEvents();
    const value = Reflect.get(events, property, events);
    return typeof value === "function" ? value.bind(events) : value;
  },
  set(_target, property, value) {
    return Reflect.set(currentEvents(), property, value);
  },
  ownKeys() {
    return Reflect.ownKeys(currentEvents());
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(currentEvents(), property);
  },
});

export function logWebhookEvent(e: WebhookEvent) {
  const events = currentEvents();
  events.unshift(e);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}
