import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import type { Notification } from "@/hooks/use-notifications";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function notificationHref(n: Notification): string | null {
  const bidQuery = n.bookingId ? `?bookingId=${n.bookingId}` : "";
  if (n.targetModule === "calendar") return `/calendar${bidQuery}`;
  if (n.targetModule === "payments") return `/payments${bidQuery}`;
  if (n.targetModule === "photoshop-jobs") return `/photoshop-jobs${bidQuery}`;
  if (n.targetModule === "tasks") return `/tasks${bidQuery}`;
  return null;
}

export function showNotificationToast(n: Notification) {
  const href = notificationHref(n);
  const urgent = n.priority === "urgent" || n.priority === "high";
  const desc = (n.message ?? "").trim();
  toast({
    title: n.title,
    description: desc.length > 140 ? `${desc.slice(0, 137)}…` : desc || undefined,
    variant: urgent ? "destructive" : "default",
    action: href ? (
      <ToastAction
        altText="Mở"
        onClick={() => { window.location.href = `${BASE}${href}`; }}
      >
        Mở đơn →
      </ToastAction>
    ) : undefined,
  });
}
