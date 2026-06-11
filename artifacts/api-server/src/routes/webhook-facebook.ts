import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { crmLeadsTable, settingsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { processIncomingFacebookMessage, ensureFbInboxTable } from "./fb-inbox";
import { logWebhookEvent as logEvent } from "./webhook-log";

const router: IRouter = Router();

function ts(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

// Cache: tránh gọi Facebook API lặp lại cho PSID đã thất bại
// Key: psid, Value: { result, failedAt (ms) }
const profileCache = new Map<string, { name: string; avatarUrl: string | null }>();
const profileFailCache = new Map<string, number>(); // psid → timestamp của lần fail
const FAIL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 phút

async function getPageAccessToken(): Promise<string | null> {
  const envToken = process.env.FB_PAGE_ACCESS_TOKEN ?? null;
  if (envToken) return envToken;
  try {
    const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, "fb_page_access_token")).limit(1);
    return rows[0]?.value ?? null;
  } catch { return null; }
}

async function fetchFacebookProfile(psid: string, pageAccessToken: string): Promise<{ name: string; avatarUrl: string | null }> {
  const fallback = { name: "Khách Facebook " + psid.slice(-4), avatarUrl: null };

  // Trả về từ cache nếu đã thành công
  const cached = profileCache.get(psid);
  if (cached) return cached;

  // Bỏ qua nếu đã fail gần đây (tránh spam API)
  const failedAt = profileFailCache.get(psid);
  if (failedAt && Date.now() - failedAt < FAIL_CACHE_TTL_MS) {
    return fallback;
  }

  try {
    const url = `https://graph.facebook.com/v19.0/${psid}?fields=name,first_name,last_name,profile_pic&access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await fetch(url);
    const data = await res.json() as {
      name?: string; first_name?: string; last_name?: string; profile_pic?: string;
      error?: { message?: string; code?: number };
    };
    if (!res.ok || data.error) {
      console.warn(`[FBProfile] ❌ psid=${psid}: ${data.error?.message ?? res.status} (sẽ bỏ qua 30 phút)`);
      profileFailCache.set(psid, Date.now());
      return fallback;
    }
    const fullName = (`${data.first_name ?? ""} ${data.last_name ?? ""}`).trim();
    const displayName = fullName || data.name || "";
    const avatarUrl = data.profile_pic ?? null;
    const result = { name: displayName || fallback.name, avatarUrl };
    if (displayName) {
      profileCache.set(psid, result); // cache thành công
    }
    console.log(`[FBProfile] ✓ psid=${psid} → name="${displayName}"`);
    return result;
  } catch (err) {
    profileFailCache.set(psid, Date.now());
    return fallback;
  }
}

router.get("/webhook/facebook", async (req, res) => {
  const mode = req.query["hub.mode"];
  const challenge = req.query["hub.challenge"];
  const token = req.query["hub.verify_token"];
  let verifyToken = process.env.FB_VERIFY_TOKEN || process.env.FACEBOOK_VERIFY_TOKEN || null;
  if (!verifyToken) {
    try {
      const rows = await db
        .select()
        .from(settingsTable)
        .where(inArray(settingsTable.key, ["fb_verify_token"]))
        .limit(1);
      verifyToken = rows[0]?.value ?? null;
    } catch {}
  }

  if (mode === "subscribe" && (!verifyToken || token === verifyToken)) {
    logEvent({ at: new Date().toISOString(), type: "verification", summary: `✅ Verification OK — challenge returned` });
    console.log(`[Webhook][${ts()}] ✅ Verification challenge OK`);
    return res.status(200).send(challenge);
  }

  logEvent({ at: new Date().toISOString(), type: "error", summary: `❌ Verification FAILED — token mismatch (got: ${token}, expected: ${verifyToken ?? "(not set)"})` });
  console.warn(`[Webhook][${ts()}] ❌ Verification FAILED — token mismatch`);
  return res.sendStatus(403);
});

router.post("/webhook/facebook", async (req, res) => {
  res.status(200).send("OK");

  try {
    const body = req.body;
    console.log(`[Webhook][${ts()}] POST received — object=${body?.object ?? "unknown"}, entries=${Array.isArray(body?.entry) ? body.entry.length : 0}`);
    logEvent({ at: new Date().toISOString(), type: "other", summary: `📩 POST received — object=${body?.object ?? "?"}`, raw: body });

    if (body?.object !== "page") {
      logEvent({ at: new Date().toISOString(), type: "other", summary: `⚠️ Non-page object: ${body?.object}` });
      return;
    }

    // Lấy page ID active từ DB để lọc (chỉ xử lý fanpage đang được cấu hình)
    let activePageId: string | null = null;
    try {
      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, "fb_active_page_id")).limit(1);
      activePageId = rows[0]?.value ?? null;
    } catch { /* bỏ qua nếu lỗi */ }
    if (!activePageId) {
      console.warn(`[CRM][${ts()}] activePageId not configured — cannot detect page-sent messages; all events treated as incoming`);
    }

    const entries: unknown[] = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const entryPageId = (entry as Record<string, unknown>).id as string | undefined;

      const messaging: unknown[] = Array.isArray((entry as Record<string, unknown>).messaging)
        ? ((entry as Record<string, unknown>).messaging as unknown[])
        : [];

      for (const event of messaging) {
        const e = event as Record<string, unknown>;
        const sender = e.sender as Record<string, unknown> | undefined;
        const recipient = e.recipient as Record<string, unknown> | undefined;
        const msg = e.message as Record<string, unknown> | undefined;
        const recipientPageId = recipient?.id as string | undefined;
        const eventPageId = entryPageId || recipientPageId;

        // Lọc cứng theo fanpage active:
        // - Nếu đã cấu hình activePageId thì mọi event không map được page hoặc lệch page đều bị bỏ qua.
        if (activePageId && eventPageId !== activePageId) {
          logEvent({
            at: new Date().toISOString(),
            type: "other",
            summary: `🚫 Bỏ qua event page=${eventPageId ?? "unknown"} (active=${activePageId})`,
          });
          console.log(
            `[Webhook][${ts()}] 🚫 Bỏ qua event page=${eventPageId ?? "unknown"} (active=${activePageId}, entry=${entryPageId ?? "unknown"}, recipient=${recipientPageId ?? "unknown"})`,
          );
          continue;
        }

        const senderId: string | undefined = sender?.id as string | undefined;
        const text: string | undefined = msg?.text as string | undefined;
        const mid: string | undefined = msg?.mid as string | undefined;

        // Phân biệt tin Page gửi ra (outgoing) vs tin khách gửi vào (incoming)
        // is_echo: cờ FB gắn cho mọi message echo (không phụ thuộc activePageId)
        const isEcho: boolean = msg?.is_echo === true;
        const isPageMessage = isEcho || (!!activePageId && senderId === activePageId);

        // Xử lý attachment ảnh từ khách (khi không có text)
        if (!text && !isPageMessage && senderId) {
          const rawAttachments = msg?.attachments;
          const imageAttachments = Array.isArray(rawAttachments)
            ? (rawAttachments as Array<Record<string, unknown>>).filter((a) => a.type === "image")
            : [];

          if (imageAttachments.length > 0) {
            const psid = senderId;
            for (let attIdx = 0; attIdx < imageAttachments.length; attIdx++) {
              const att = imageAttachments[attIdx];
              const payload = att.payload as Record<string, unknown> | undefined;
              const imgUrl = (payload?.url ?? payload?.sticker_id ?? "") as string;
              if (!imgUrl) continue;
              const imgMessage = `[image:${imgUrl}]`;
              const attMid = mid ? `${mid}#${attIdx}` : null;
              try {
                await ensureFbInboxTable();
                await pool.query(
                  `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, mid)
                   VALUES ($1, 'incoming', $2, 'received', $3)
                   ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
                  [psid, imgMessage, attMid],
                );
              } catch (err) {
                console.error("[CRM] Insert customer image error:", err);
              }
            }
            // Cập nhật CRM lead lastMessage = "[Ảnh]"
            const existingImgLead = await db
              .select({ id: crmLeadsTable.id })
              .from(crmLeadsTable)
              .where(eq(crmLeadsTable.facebookUserId, psid))
              .limit(1);
            if (existingImgLead.length > 0) {
              await db.update(crmLeadsTable)
                .set({ lastMessage: "[Ảnh]", lastMessageAt: new Date() })
                .where(eq(crmLeadsTable.facebookUserId, psid));
            }
            logEvent({ at: new Date().toISOString(), type: "message", summary: `🖼️ [${psid}] ${imageAttachments.length} ảnh`, psid });
            continue;
          }

          // Không phải ảnh → skip như cũ
          const msgType = msg ? (msg.attachments ? "attachment" : "no-text") : "no-msg";
          logEvent({ at: new Date().toISOString(), type: "other", summary: `⚠️ Skip — ${msgType} (sender=${senderId})`, psid: senderId });
          console.log(`[CRM][${ts()}] Skip non-text/non-image message (sender=${senderId})`);
          continue;
        }

        if (isPageMessage) {
          // Tin do Page/nhân viên gửi ra qua Facebook Inbox (text hoặc ảnh)
          const customerPsid = recipient?.id as string | undefined;
          if (!customerPsid) {
            console.log(`[CRM][${ts()}] Skip page-sent message — no recipient.id`);
            continue;
          }

          // Xử lý ảnh echo từ Page (khi Page gửi ảnh từ FB Inbox)
          if (!text) {
            const rawAtts = msg?.attachments;
            const imgAtts = Array.isArray(rawAtts)
              ? (rawAtts as Array<Record<string, unknown>>).filter((a) => a.type === "image")
              : [];
            if (imgAtts.length === 0) { continue; }
            await ensureFbInboxTable();
            let anyInserted = false;
            for (let attIdx = 0; attIdx < imgAtts.length; attIdx++) {
              const att = imgAtts[attIdx];
              const payload = att.payload as Record<string, unknown> | undefined;
              const imgUrl = (payload?.url ?? "") as string;
              if (!imgUrl) continue;
              const attMid = mid ? `${mid}#${attIdx}` : null;
              try {
                const r = await pool.query(
                  `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision, mid)
                   VALUES ($1, 'outgoing', $2, 'sent', 'page_image', $3)
                   ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
                  [customerPsid, `[image:${imgUrl}]`, attMid],
                );
                if ((r.rowCount ?? 0) > 0) anyInserted = true;
              } catch (err) { console.error("[CRM] Insert page image error:", err); }
            }
            if (anyInserted) {
              await db.update(crmLeadsTable).set({ lastMessage: "[Ảnh]", lastMessageAt: new Date() })
                .where(eq(crmLeadsTable.facebookUserId, customerPsid));
            }
            logEvent({ at: new Date().toISOString(), type: "message", summary: `🖼️ [Page→${customerPsid}] ảnh`, psid: customerPsid });
            continue;
          }

          logEvent({ at: new Date().toISOString(), type: "message", summary: `📤 [Page→${customerPsid}] "${text.slice(0, 60)}"`, psid: customerPsid });
          console.log(`[CRM][${ts()}] Page outgoing → psid=${customerPsid}: ${text.slice(0, 50)}`);

          // Đảm bảo bảng tồn tại trước khi insert (tránh race condition lúc khởi động)
          await ensureFbInboxTable();

          // Lưu tin outgoing vào thread của khách (idempotent qua mid)
          let outgoingInserted = false;
          try {
            const outgoingResult = await pool.query(
              `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision, mid)
               VALUES ($1, 'outgoing', $2, 'sent', 'page_sent', $3)
               ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
              [customerPsid, text, mid ?? null],
            );
            outgoingInserted = !mid || (outgoingResult.rowCount ?? 0) > 0;
          } catch (err) {
            console.error("[CRM] Insert page outgoing error:", err);
          }

          if (mid && !outgoingInserted) {
            console.log(`[CRM][${ts()}] Duplicate page outgoing mid=${mid} — skipping lead update`);
            continue;
          }

          // Cập nhật last_message trên CRM lead nếu đã tồn tại (không tạo lead mới)
          const existingLead = await db
            .select({ id: crmLeadsTable.id })
            .from(crmLeadsTable)
            .where(eq(crmLeadsTable.facebookUserId, customerPsid))
            .limit(1);
          if (existingLead.length > 0) {
            await db
              .update(crmLeadsTable)
              .set({ lastMessage: text, lastMessageAt: new Date() })
              .where(eq(crmLeadsTable.facebookUserId, customerPsid));
          }
          continue;
        }

        if (!senderId || !text) {
          const msgType = msg ? (msg.attachments ? "attachment" : "no-text") : "no-msg";
          logEvent({ at: new Date().toISOString(), type: "other", summary: `⚠️ Skip — ${msgType} (sender=${senderId ?? "?"}), event keys: ${Object.keys(e).join(",")}`, psid: senderId });
          console.log(`[CRM][${ts()}] Skip non-text message (sender=${senderId ?? "unknown"})`);
          continue;
        }

        // Tin khách gửi vào (incoming)
        const psid = senderId;
        logEvent({ at: new Date().toISOString(), type: "message", summary: `💬 [${psid}] "${text.slice(0, 60)}"`, psid });

        const existing = await db
          .select()
          .from(crmLeadsTable)
          .where(eq(crmLeadsTable.facebookUserId, psid))
          .limit(1);

        if (existing.length > 0) {
          const lead = existing[0];
          const updateData: Record<string, unknown> = { lastMessage: text, lastMessageAt: new Date() };
          if (!lead.avatarUrl || lead.name.startsWith("Khách Facebook ")) {
            const token = await getPageAccessToken();
            if (token) {
              const profile = await fetchFacebookProfile(psid, token);
              if (lead.name.startsWith("Khách Facebook ")) updateData.name = profile.name;
              if (!lead.avatarUrl && profile.avatarUrl) updateData.avatarUrl = profile.avatarUrl;
            }
          }
          await db.update(crmLeadsTable).set(updateData).where(eq(crmLeadsTable.facebookUserId, psid));
          console.log(`[CRM][${ts()}] Updated lead #${lead.id} (psid=${psid}): ${text.slice(0, 50)}`);
        } else {
          const token = await getPageAccessToken();
          const profile = token
            ? await fetchFacebookProfile(psid, token)
            : { name: "Khách Facebook " + psid.slice(-4), avatarUrl: null };
          const [newLead] = await db
            .insert(crmLeadsTable)
            .values({
              name: profile.name,
              avatarUrl: profile.avatarUrl,
              phone: null,
              facebookUserId: psid,
              lastMessage: text,
              lastMessageAt: new Date(),
              source: "facebook",
              type: "unknown",
              channel: "inbox",
              status: "new",
            })
            .returning();
          console.log(`[CRM][${ts()}] Created lead #${newLead.id} "${profile.name}" (psid=${psid}): ${text.slice(0, 50)}`);
        }

        processIncomingFacebookMessage(psid, text, mid, activePageId).catch((err) => {
          console.error("[CRM] processIncomingFacebookMessage error:", err);
        });
      }
    }
  } catch (err) {
    console.error("[CRM] Webhook processing error:", err);
  }
});

export default router;
