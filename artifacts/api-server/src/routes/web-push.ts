import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { pushSubscriptionsTable, staffTable } from "@workspace/db/schema";
import { eq, and, isNull, or } from "drizzle-orm";
import { verifyToken } from "./auth";
import webpush from "web-push";

const router = Router();

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@amazingstudio.vn";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log("[web-push] VAPID configured");
} else {
  console.warn("[web-push] VAPID keys not set — push disabled");
}

function resolveStaffId(req: Request): number | null {
  const sid = verifyToken(req.headers.authorization);
  return sid;
}

router.get("/push/vapid-key", (_req: Request, res: Response) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

router.post("/push/subscribe", async (req: Request, res: Response) => {
  const staffId = resolveStaffId(req);
  if (!staffId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { endpoint, p256dh, auth } = req.body;
  if (!endpoint || !p256dh || !auth) {
    res.status(400).json({ error: "Missing subscription data" });
    return;
  }

  try {
    const existing = await db.select({ id: pushSubscriptionsTable.id })
      .from(pushSubscriptionsTable)
      .where(eq(pushSubscriptionsTable.endpoint, endpoint))
      .limit(1);

    if (existing.length > 0) {
      await db.update(pushSubscriptionsTable)
        .set({ staffId, p256dh, auth })
        .where(eq(pushSubscriptionsTable.endpoint, endpoint));
    } else {
      await db.insert(pushSubscriptionsTable).values({ staffId, endpoint, p256dh, auth });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[web-push] subscribe error:", e);
    res.status(500).json({ error: "Failed to save subscription" });
  }
});

router.post("/push/unsubscribe", async (req: Request, res: Response) => {
  const staffId = resolveStaffId(req);
  if (!staffId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { endpoint } = req.body;
  if (!endpoint) { res.status(400).json({ error: "Missing endpoint" }); return; }

  try {
    await db.delete(pushSubscriptionsTable)
      .where(and(
        eq(pushSubscriptionsTable.endpoint, endpoint),
        eq(pushSubscriptionsTable.staffId, staffId),
      ));
    res.json({ ok: true });
  } catch (e) {
    console.error("[web-push] unsubscribe error:", e);
    res.status(500).json({ error: "Failed" });
  }
});

function getNotifUrl(targetModule?: string, targetId?: string): string {
  if (targetModule === "calendar") return `/calendar${targetId ? `?bookingId=${targetId}` : ""}`;
  if (targetModule === "payments") return "/payments";
  if (targetModule === "photoshop-jobs") return "/photoshop-jobs";
  if (targetModule === "tasks") return "/tasks";
  return "/";
}

export async function sendPushToStaff(opts: {
  staffId: number | null;
  title: string;
  message: string;
  targetModule?: string;
  targetId?: string;
  tag?: string;
}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;

  try {
    let subs: Array<{ id: number; staffId: number; endpoint: string; p256dh: string; auth: string }>;

    if (opts.staffId === null) {
      const adminRows = await db.select({ id: staffTable.id })
        .from(staffTable)
        .where(eq((staffTable as any).role, "admin"));
      const adminIds = adminRows.map(r => r.id);

      if (adminIds.length === 0) return;

      subs = await db.select()
        .from(pushSubscriptionsTable)
        .where(
          or(...adminIds.map(id => eq(pushSubscriptionsTable.staffId, id)))!
        );
    } else {
      subs = await db.select()
        .from(pushSubscriptionsTable)
        .where(eq(pushSubscriptionsTable.staffId, opts.staffId));
    }

    const url = getNotifUrl(opts.targetModule, opts.targetId);
    const payload = JSON.stringify({
      title: opts.title,
      body: opts.message,
      url,
      tag: opts.tag || `notif-${Date.now()}`,
    });

    const expiredEndpoints: number[] = [];

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: 60 * 60 }
          );
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            expiredEndpoints.push(sub.id);
          } else {
            console.error(`[web-push] send failed for sub ${sub.id}:`, err.statusCode || err.message);
          }
        }
      })
    );

    if (expiredEndpoints.length > 0) {
      await Promise.allSettled(
        expiredEndpoints.map(id =>
          db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.id, id))
        )
      );
    }
  } catch (e) {
    console.error("[web-push] sendPushToStaff error:", e);
  }
}

export default router;
