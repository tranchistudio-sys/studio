import { Router } from "express";
import { db } from "@workspace/db";
import {
  messageRoomsTable, internalMessagesTable, photoshopJobsTable
} from "@workspace/db/schema";
import { eq, desc, and } from "drizzle-orm";

const router = Router();

// ─── Notifications: routes đã được dời sang routes/notifications.ts (auth + sender JOIN). ──

// ─── Message Rooms ─────────────────────────────────────────────────────────────
router.get("/message-rooms", async (req, res) => {
  try {
    const rooms = await db.select().from(messageRoomsTable).where(eq(messageRoomsTable.isActive, true)).orderBy(desc(messageRoomsTable.createdAt));
    res.json(rooms);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/message-rooms", async (req, res) => {
  try {
    const { name, type, linkType, linkId, createdByStaffId } = req.body;
    const [room] = await db.insert(messageRoomsTable).values({
      name: name || "Phòng mới",
      type: type || "group",
      linkType: linkType || "",
      linkId: linkId ?? null,
      createdByStaffId: createdByStaffId ?? null,
    }).returning();
    res.status(201).json(room);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── Messages ──────────────────────────────────────────────────────────────────
router.get("/message-rooms/:roomId/messages", async (req, res) => {
  try {
    const messages = await db.select().from(internalMessagesTable)
      .where(eq(internalMessagesTable.roomId, +req.params.roomId))
      .orderBy(internalMessagesTable.createdAt)
      .limit(100);
    res.json(messages);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/message-rooms/:roomId/messages", async (req, res) => {
  try {
    const { senderStaffId, senderName, content, isSystem } = req.body;
    const [msg] = await db.insert(internalMessagesTable).values({
      roomId: +req.params.roomId,
      senderStaffId: senderStaffId ?? null,
      senderName: senderName || "Ẩn danh",
      content: content || "",
      isSystem: !!isSystem,
    }).returning();
    res.status(201).json(msg);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── Deadline alerts (from photoshop_jobs) ─────────────────────────────────────
router.get("/deadline-alerts", async (req, res) => {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const in5Days = new Date(today.getTime() + 5 * 86400000).toISOString().split("T")[0];

    const jobs = await db.select().from(photoshopJobsTable)
      .where(and(eq(photoshopJobsTable.isActive, true)))
      .orderBy(photoshopJobsTable.customerDeadline);

    const alerts = jobs
      .filter(j => j.status !== "hoan_thanh" && j.customerDeadline)
      .map(j => {
        const deadline = j.customerDeadline!;
        const diff = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000);
        let urgency = "normal";
        if (diff < 0) urgency = "overdue";
        else if (diff === 0) urgency = "today";
        else if (diff <= 2) urgency = "urgent";
        else if (diff <= 5) urgency = "soon";
        return { ...j, daysLeft: diff, urgency };
      })
      .filter(j => j.urgency !== "normal")
      .sort((a, b) => a.daysLeft - b.daysLeft);

    res.json(alerts);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
