import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { notificationsTable, staffTable } from "@workspace/db/schema";
import { eq, and, desc, sql, isNull, or } from "drizzle-orm";
import { verifyToken } from "./auth";
import { sendPushToStaff } from "./web-push";

const router = Router();

type DeadlineDigestItem = {
  orderCode: string;
  customerName: string;
  ptsName: string;
  lateLabel: string;
};

function formatDeadlineTitle(orderCode: string | null | undefined, customerName: string, lateLabel: string): string {
  const code = String(orderCode ?? "").trim();
  const customer = String(customerName ?? "").trim() || "Không rõ";
  return code ? `${code} · ${lateLabel} · ${customer}` : `${lateLabel} · ${customer}`;
}

function formatDeadlineDigestLine(items: DeadlineDigestItem[], max = 4): string {
  const shown = items.slice(0, max).map(it => {
    const code = it.orderCode || "—";
    return `${code} ${it.customerName} (${it.lateLabel})`;
  });
  const extra = items.length > max ? ` · +${items.length - max} đơn` : "";
  return shown.join(" · ") + extra;
}



type SSEClient = { res: Response; staffId: number; isAdmin: boolean };
const clients: SSEClient[] = [];

export function emitNotification(notification: {
  staffId: number | null;
  senderStaffId?: number | null;
  type: string;
  priority?: string;
  title: string;
  message: string;
  targetModule?: string;
  targetId?: string;
  bookingId?: number;
  dedupeKey?: string;
}) {
  (async () => {
    try {
      // Atomic dedupe via INSERT ... ON CONFLICT DO NOTHING on dedupe_key.
      // Race-safe across concurrent emitters (e.g. multiple deadline checker instances).
      const insertSql = sql`
        INSERT INTO notifications (recipient_staff_id, sender_staff_id, type, priority, title, body, link_type, link_id, booking_id, dedupe_key)
        VALUES (
          ${notification.staffId},
          ${notification.senderStaffId ?? null},
          ${notification.type},
          ${notification.priority || "normal"},
          ${notification.title},
          ${notification.message},
          ${notification.targetModule || ""},
          ${notification.targetId ? parseInt(notification.targetId) || null : null},
          ${notification.bookingId || null},
          ${notification.dedupeKey || null}
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id, recipient_staff_id, sender_staff_id, type, priority, title, body, link_type, link_id, booking_id, is_read, dedupe_key, created_at
      `;
      const result = await db.execute(insertSql) as any;
      const rows: any[] = result.rows ?? result;
      if (!rows || rows.length === 0) return; // dedupe collision: skip emission
      const r = rows[0];

      // Lookup sender name (best-effort) so client can show "Bởi: <name>"
      let senderName: string | null = null;
      if (r.sender_staff_id) {
        try {
          const [s] = await db.select({ name: staffTable.name }).from(staffTable).where(eq(staffTable.id, r.sender_staff_id));
          senderName = s?.name ?? null;
        } catch { /* ignore */ }
      }

      const inserted = {
        id: r.id,
        recipientStaffId: r.recipient_staff_id,
        senderStaffId: r.sender_staff_id,
        senderName,
        type: r.type,
        priority: r.priority,
        title: r.title,
        body: r.body,
        linkType: r.link_type,
        linkId: r.link_id,
        bookingId: r.booking_id,
        isRead: r.is_read,
        dedupeKey: r.dedupe_key,
        createdAt: r.created_at,
      };

      const payload = JSON.stringify({
        ...inserted,
        message: inserted.body,
        targetModule: inserted.linkType,
        targetId: inserted.linkId ? String(inserted.linkId) : null,
        staffId: inserted.recipientStaffId,
      });
      // Prune dead clients on write failure to prevent memory leak
      const dead: SSEClient[] = [];
      for (const client of clients) {
        const isTarget = notification.staffId === null || client.isAdmin || client.staffId === notification.staffId;
        if (!isTarget) continue;
        try {
          const ok = client.res.write(`data: ${payload}\n\n`);
          if (!ok || client.res.writableEnded || client.res.destroyed) dead.push(client);
        } catch {
          dead.push(client);
        }
      }
      for (const d of dead) {
        const idx = clients.indexOf(d);
        if (idx >= 0) clients.splice(idx, 1);
        try { d.res.end(); } catch {}
      }

      sendPushToStaff({
        staffId: notification.staffId,
        title: notification.title,
        message: notification.message,
        targetModule: notification.targetModule,
        targetId: notification.targetId,
        tag: notification.dedupeKey || `notif-${inserted.id}`,
      });
    } catch (e) {
      console.error("[notifications] emit error:", e);
    }
  })();
}

async function resolveAuth(req: Request): Promise<{ staffId: number; isAdmin: boolean } | null> {
  let header = req.headers.authorization;
  if (!header) {
    const tokenQ = req.query.token as string | undefined;
    if (tokenQ) header = `Bearer ${tokenQ}`;
  }
  const sid = verifyToken(header);
  if (!sid) return null;
  const rows = await db.select().from(staffTable).where(eq(staffTable.id, sid));
  const user = rows[0];
  if (!user || (user as any).isActive === false) return null;
  const isAdmin = (user as any).role === "admin" || (Array.isArray((user as any).roles) && (user as any).roles.includes("admin"));
  return { staffId: sid, isAdmin };
}

router.get("/notifications/stream", async (req: Request, res: Response) => {
  const auth = await resolveAuth(req);
  if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");

  const client: SSEClient = { res, staffId: auth.staffId, isAdmin: auth.isAdmin };
  clients.push(client);

  const keepAlive = setInterval(() => { res.write(":\n\n"); }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    const idx = clients.indexOf(client);
    if (idx >= 0) clients.splice(idx, 1);
  });
});

router.get("/notifications", async (req: Request, res: Response) => {
  const auth = await resolveAuth(req);
  if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);

  const whereClause = auth.isAdmin
    ? undefined
    : or(eq(notificationsTable.recipientStaffId, auth.staffId), isNull(notificationsTable.recipientStaffId));

  // LEFT JOIN staff để lấy tên người thực hiện (sender)
  const senderAlias = sql<string | null>`(SELECT name FROM ${staffTable} WHERE id = ${notificationsTable.senderStaffId})`;
  const rows = await db.select({
    n: notificationsTable,
    senderName: senderAlias,
  }).from(notificationsTable)
    .where(whereClause)
    .orderBy(desc(notificationsTable.createdAt))
    .limit(limit);

  res.json(rows.map(({ n: r, senderName }) => ({
    ...r,
    message: r.body,
    targetModule: r.linkType,
    targetId: r.linkId ? String(r.linkId) : null,
    staffId: r.recipientStaffId,
    senderName,
  })));
});

router.get("/notifications/unread-count", async (req: Request, res: Response) => {
  const auth = await resolveAuth(req);
  if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const whereClause = auth.isAdmin
    ? eq(notificationsTable.isRead, false)
    : and(
        eq(notificationsTable.isRead, false),
        or(eq(notificationsTable.recipientStaffId, auth.staffId), isNull(notificationsTable.recipientStaffId))
      );

  const [result] = await db.select({ count: sql<number>`count(*)::int` })
    .from(notificationsTable)
    .where(whereClause);

  res.json({ count: result?.count ?? 0 });
});

router.patch("/notifications/:id/read", async (req: Request, res: Response) => {
  const auth = await resolveAuth(req);
  if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = parseInt(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const ownerCheck = auth.isAdmin
    ? eq(notificationsTable.id, id)
    : and(
        eq(notificationsTable.id, id),
        or(eq(notificationsTable.recipientStaffId, auth.staffId), isNull(notificationsTable.recipientStaffId))
      );

  const updated = await db.update(notificationsTable).set({ isRead: true }).where(ownerCheck).returning({ id: notificationsTable.id });
  if (updated.length === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

router.post("/notifications/mark-all-read", async (req: Request, res: Response) => {
  const auth = await resolveAuth(req);
  if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const whereClause = auth.isAdmin
    ? eq(notificationsTable.isRead, false)
    : and(
        eq(notificationsTable.isRead, false),
        or(eq(notificationsTable.recipientStaffId, auth.staffId), isNull(notificationsTable.recipientStaffId))
      );

  await db.update(notificationsTable).set({ isRead: true }).where(whereClause);
  res.json({ ok: true });
});

export function startDeadlineChecker() {
  const CHECK_INTERVAL = 60 * 60 * 1000;

  async function check() {
    try {
      const overdueJobs = await db.execute(sql`
        SELECT pj.id, pj.booking_id, pj.assigned_staff_id, pj.deadline_system, pj.status,
               pj.customer_name, s.name AS assigned_staff_name,
               b.order_code AS order_code
        FROM photoshop_jobs pj
        LEFT JOIN staff s ON s.id = pj.assigned_staff_id
        LEFT JOIN bookings b ON b.id = pj.booking_id
        WHERE pj.status NOT IN ('xong_show', 'hoan_thanh', 'completed', 'cancelled')
          AND pj.is_active = true
          AND pj.deadline_system IS NOT NULL
          AND pj.deadline_system != ''
          AND pj.deadline_system::date <= (NOW() + INTERVAL '24 hours')::date
      `);

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const adminOverdue: DeadlineDigestItem[] = [];
      const adminDueSoon: DeadlineDigestItem[] = [];

      for (const job of (overdueJobs as any).rows || []) {
        const deadline = new Date(job.deadline_system);
        const diffHours = (now.getTime() - deadline.getTime()) / (1000 * 60 * 60);
        const customerName = String(job.customer_name ?? "").trim() || "Không rõ";
        const ptsName = job.assigned_staff_name
          ? String(job.assigned_staff_name).trim()
          : "Chưa giao PTS";
        const orderCode = String(job.order_code ?? "").trim();

        let priority = "normal";
        let title = "";
        let messageStaff = "";
        let lateLabel = "";
        let digestBucket: DeadlineDigestItem[] | null = null;

        if (diffHours > 48) {
          priority = "urgent";
          const days = Math.floor(diffHours / 24);
          lateLabel = `Trễ ${days} ngày`;
          title = formatDeadlineTitle(orderCode, customerName, lateLabel);
          messageStaff = `PTS: ${ptsName} · Khách ${customerName} · Quá hạn ${days} ngày. Mở đơn xử lý gấp.`;
          digestBucket = adminOverdue;
        } else if (diffHours > 0) {
          priority = "high";
          const hrs = Math.floor(diffHours);
          lateLabel = `Trễ ${hrs} giờ`;
          title = formatDeadlineTitle(orderCode, customerName, lateLabel);
          messageStaff = `PTS: ${ptsName} · Khách ${customerName} · Quá hạn ${hrs} giờ. Mở đơn xử lý sớm.`;
          digestBucket = adminOverdue;
        } else {
          priority = "warning";
          const hrsLeft = Math.abs(Math.floor(diffHours));
          lateLabel = hrsLeft >= 24
            ? `Còn ${Math.floor(hrsLeft / 24)} ngày`
            : `Còn ${hrsLeft} giờ`;
          title = formatDeadlineTitle(orderCode, customerName, lateLabel);
          messageStaff = `PTS: ${ptsName} · Khách ${customerName} · ${lateLabel} tới deadline. Chuẩn bị bàn giao nhé!`;
          digestBucket = adminDueSoon;
        }

        digestBucket?.push({ orderCode, customerName, ptsName, lateLabel });

        if (job.assigned_staff_id) {
          emitNotification({
            staffId: job.assigned_staff_id,
            type: "photoshop_deadline",
            priority,
            title,
            message: messageStaff,
            targetModule: "photoshop-jobs",
            targetId: String(job.id),
            bookingId: job.booking_id,
            dedupeKey: `deadline_${job.id}_${todayStr}`,
          });
        }
      }

      if (adminOverdue.length > 0) {
        emitNotification({
          staffId: null,
          type: "photoshop_deadline_digest",
          priority: "urgent",
          title: `${adminOverdue.length} đơn hậu kỳ quá hạn`,
          message: `${formatDeadlineDigestLine(adminOverdue)}. Mở Tiến độ Hậu kỳ để xử lý.`,
          targetModule: "photoshop-jobs",
          dedupeKey: `deadline_digest_overdue_${todayStr}`,
        });
      }

      if (adminDueSoon.length > 0) {
        emitNotification({
          staffId: null,
          type: "photoshop_deadline_digest",
          priority: "warning",
          title: `${adminDueSoon.length} đơn sắp đến deadline`,
          message: `${formatDeadlineDigestLine(adminDueSoon)}. Mở Tiến độ Hậu kỳ để theo dõi.`,
          targetModule: "photoshop-jobs",
          dedupeKey: `deadline_digest_soon_${todayStr}`,
        });
      }
    } catch (e) {
      console.error("[deadline-checker] error:", e);
    }
  }

  setTimeout(check, 15000);
  setInterval(check, CHECK_INTERVAL);
}

// ─── Bước 4: Reminder chuẩn bị đồ cho Combo ngày cưới ────────────────────────
// Quét bookings thuộc nhóm "Combo ngày cưới" (service_packages.service_type
// LIKE 'combo_%') có shoot_date trong vòng N ngày tới và đẩy 1 notification
// cho admin: "Chuẩn bị váy, vest, áo dài, phụ kiện…".
// - N mặc định = 3 ngày. Nếu sau này service_packages có cột cấu hình riêng
//   (vd: wedding_prep_lead_days) thì có thể override; hiện tại fallback 3.
// - dedupeKey theo (booking_id, shoot_date) → mỗi booking chỉ nhắc 1 lần
//   khi bước vào cửa sổ N ngày.
// - Không gửi push/email (chỉ in-app), không sửa deadline hậu kỳ ảnh.
export function startWeddingPrepReminder() {
  const CHECK_INTERVAL = 60 * 60 * 1000; // 1h
  const DEFAULT_LEAD_DAYS = 3;

  async function check() {
    try {
      const upcoming = await db.execute(sql`
        SELECT
          b.id              AS booking_id,
          b.shoot_date      AS shoot_date,
          b.order_code      AS order_code,
          c.name            AS customer_name,
          sp.service_type   AS service_type,
          sp.name           AS package_name
        FROM bookings b
        JOIN customers c ON c.id = b.customer_id
        LEFT JOIN service_packages sp ON sp.id = b.service_package_id
        WHERE b.status NOT IN ('cancelled','temp_quote')
          AND COALESCE(b.is_parent_contract, false) = false
          AND sp.service_type LIKE 'combo_%'
          AND b.shoot_date IS NOT NULL
          AND b.shoot_date::date >= NOW()::date
          AND b.shoot_date::date <= (NOW() + INTERVAL '${sql.raw(String(DEFAULT_LEAD_DAYS))} days')::date
      `);

      for (const row of (upcoming as any).rows || []) {
        const customerName = row.customer_name || "khách";
        const shootDateIso = String(row.shoot_date).slice(0, 10);
        const [yyyy, mm, dd] = shootDateIso.split("-");
        const shootDateVi = (yyyy && mm && dd) ? `${dd}/${mm}/${yyyy}` : shootDateIso;
        const orderCode = row.order_code ? ` (${row.order_code})` : "";

        emitNotification({
          staffId: null, // admin
          type: "wedding_prep_reminder",
          priority: "warning",
          title: row.order_code
            ? `${String(row.order_code).trim()} · Chuẩn bị đồ cưới · ${customerName}`
            : `Chuẩn bị đồ cưới · ${customerName}`,
          message: `Ngày ${shootDateVi}: chuẩn bị váy, vest, áo dài, phụ kiện cho khách ${customerName}${orderCode}. Mở lịch chụp.`,
          targetModule: "calendar",
          targetId: String(row.booking_id),
          bookingId: row.booking_id,
          dedupeKey: `wedding_prep_${row.booking_id}_${shootDateIso}`,
        });
      }
    } catch (e) {
      console.error("[wedding-prep-reminder] error:", e);
    }
  }

  setTimeout(check, 20000);
  setInterval(check, CHECK_INTERVAL);
}

export default router;
