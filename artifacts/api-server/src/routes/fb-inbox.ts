import { Router, type IRouter } from "express";
import type { Request } from "express";
import { db, pool } from "@workspace/db";
import { crmLeadsTable, customersTable, settingsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { verifyToken } from "./auth";
import { webhookEvents } from "./webhook-log";
import {
  splitIntoChunks,
  naturalDelayMs,
  loadQaRows,
  matchQaRow,
  buildStudioContext,
  askChatGptForReply,
  loadScriptSettings,
  resolveImagePath,
  type AiSaleReply,
  type AiSettings,
} from "./ai-engine";
import { askClaudeForReply, type ClaudeHistoryItem } from "../lib/claude-sale";
import { getSaleContext, resolvePriceImagesByCodes, wantsNewConcept, getPhotoIdeasBlock } from "../lib/sale-context";
import { classifyCustomerImageIntent, buildImageRoutingBlock, type CustomerImageIntent } from "../lib/sale-vision";
import { selectSampleImages, extractRecentSampleUrls, toPublicImageUrl, SAMPLES_EXHAUSTED_NOTE, type SampleImage } from "../lib/sale-samples";
import { getActivePlaybook } from "../lib/sale-playbook";
import { getActiveBrainRules } from "../lib/sale-brain-lab";
import { getClaudeSaleSettings, computeReplyDelayMs } from "../lib/sale-settings";
import { getScheduleContext } from "../lib/sale-calendar";
import { getMasterEnabled } from "../lib/sale-master";
import {
  markPhoneCaptured, markAppointmentIntent, markNeedsHuman, setProfileSyncStatus,
  detectPhone, detectAppointmentIntent, detectEscalation,
} from "../lib/sale-lead-flags";
import {
  HOLD_MESSAGE, imageEscalationReason, upsertOpenHumanReview, markHoldSent,
} from "../lib/sale-human-review";
import { emitNotification } from "./notifications";
import multer from "multer";
import { randomUUID } from "crypto";
import { objectStorageClient, ObjectStorageService } from "../lib/objectStorage";
import { getPublicBaseUrl } from "../lib/publicUrl";

const router: IRouter = Router();

type FbConfig = {
  pageAccessToken: string | null;
  verifyToken: string | null;
  autoReplyEnabled: boolean;
  openaiApiKey: string | null;
};

async function ensureFbInboxTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fb_inbox_messages (
      id SERIAL PRIMARY KEY,
      facebook_user_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
      message TEXT NOT NULL,
      sent_status TEXT NOT NULL DEFAULT 'received',
      ai_decision TEXT,
      mid TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fb_inbox_user_created
    ON fb_inbox_messages (facebook_user_id, created_at DESC)
  `);
  await pool.query(`
    ALTER TABLE fb_inbox_messages ADD COLUMN IF NOT EXISTS mid TEXT
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_inbox_mid
    ON fb_inbox_messages (mid)
    WHERE mid IS NOT NULL
  `);
  await pool.query(`
    ALTER TABLE fb_inbox_messages ADD COLUMN IF NOT EXISTS sent_by TEXT
  `);
}
ensureFbInboxTable().catch((err) => console.error("ensureFbInboxTable error:", err));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const _objectStorageService = new ObjectStorageService();

async function uploadImageToGcs(buffer: Buffer, mimeType: string, ext: string): Promise<string> {
  const privateDir = _objectStorageService.getPrivateObjectDir();
  const entityId = `fb-inbox-images/${randomUUID()}.${ext}`;
  const fullGcsPath = `${privateDir.replace(/\/$/, "")}/${entityId}`;

  const parts = fullGcsPath.replace(/^\//, "").split("/");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");

  const bucket = objectStorageClient.bucket(bucketName);
  const gcsFile = bucket.file(objectName);
  await gcsFile.save(buffer, { contentType: mimeType, resumable: false });

  const objectPath = `/objects/${entityId}`;
  return `${getPublicBaseUrl()}/api/storage${objectPath}`;
}

function toBool(v: string | null | undefined): boolean {
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

async function getConfig(): Promise<FbConfig> {
  const rows = await db
    .select()
    .from(settingsTable)
    .where(
      inArray(settingsTable.key, [
        "fb_page_access_token",
        "fb_verify_token",
        "fb_auto_reply_enabled",
        "openai_api_key",
      ]),
    );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    pageAccessToken: map.get("fb_page_access_token") ?? process.env.FB_PAGE_ACCESS_TOKEN ?? null,
    verifyToken: map.get("fb_verify_token") ?? process.env.FB_VERIFY_TOKEN ?? null,
    autoReplyEnabled: toBool(map.get("fb_auto_reply_enabled") ?? process.env.FB_AUTO_REPLY_ENABLED),
    openaiApiKey: map.get("openai_api_key") ?? process.env.OPENAI_API_KEY ?? null,
  };
}

async function getCaller(req: Request) {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return null;
  const r = await pool.query(`SELECT id, name, role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = r.rows[0] as { id: number; name?: string; role?: string; roles?: string[] } | undefined;
  if (!caller) return null;
  return caller;
}

function isAdmin(caller: { role?: string; roles?: string[] } | null): boolean {
  if (!caller) return false;
  return caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTypingOn(psid: string, token: string): Promise<void> {
  try {
    await fetch(`https://graph.facebook.com/v22.0/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: psid }, sender_action: "typing_on" }),
    });
  } catch (err) {
    console.debug(`[AI] psid=${psid} typing_on failed (non-critical):`, String(err).slice(0, 80));
  }
}

async function sendChunksWithTyping(
  psid: string,
  token: string,
  chunks: string[],
  aiDecision: string,
  settings?: AiSettings,
  /** Nếu set: bubble ĐẦU chờ đúng số ms này (delay theo độ dài tin khách); các bubble sau gõ nhanh tự nhiên. */
  firstDelayMs?: number,
): Promise<boolean> {
  if (settings?.logDecisions) console.log(`[AI] psid=${psid} chunks=${chunks.length} decision=${aiDecision}`);
  let allSent = true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const delayMs = firstDelayMs != null
      ? (i === 0 ? firstDelayMs : Math.min(2500, 600 + chunk.length * 15))
      : naturalDelayMs(chunk, settings);
    if (settings?.logDecisions) console.log(`[AI] psid=${psid} chunk[${i}]="${chunk.slice(0, 60)}" delay=${delayMs}ms`);
    if (settings?.typingIndicator !== false) await sendTypingOn(psid, token);
    await sleep(delayMs);
    try {
      const chunkMid = await sendFacebookMessage(psid, chunk, token);
      await pool.query(
        `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision, mid)
         VALUES ($1, 'outgoing', $2, 'sent', $3, $4)
         ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
        [psid, chunk, aiDecision, chunkMid ?? null],
      );
      if (settings?.logDecisions) console.log(`[AI] psid=${psid} chunk[${i}] ✓ sent mid=${chunkMid}`);
    } catch (err) {
      allSent = false;
      await pool.query(
        `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision)
         VALUES ($1, 'outgoing', $2, 'failed', $3)`,
        [psid, chunk, `${aiDecision}_failed:${String(err)}`],
      );
      console.error(`[AI] psid=${psid} chunk[${i}] ✗ failed:`, err);
    }
  }
  return allSent;
}

async function sendFacebookMessage(psid: string, text: string, pageAccessToken: string): Promise<string | null> {
  const r = await fetch(`https://graph.facebook.com/v22.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: psid },
      message: { text },
      messaging_type: "RESPONSE",
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Facebook send failed: ${r.status} ${errText}`);
  }
  try {
    const data = await r.json() as { message_id?: string };
    return data.message_id ?? null;
  } catch { return null; }
}

/**
 * Gửi 1 tin nhân viên NHẬP TAY ra Messenger — NGUYÊN VĂN, không qua AI (điểm 2).
 * Log vào fb_inbox_messages (manual_sent + sent_by). Throw nếu Facebook lỗi (caller tự bắt).
 * Dùng chung cho route gửi của module Human Review. KHÔNG tự đổi ai_mode (caller quyết định).
 */
export async function sendManualReply(
  psid: string,
  text: string,
  sentByName: string | null,
): Promise<{ ok: boolean; fbMid: string | null }> {
  const cfg = await getConfig();
  if (!cfg.pageAccessToken) throw new Error("Chưa cấu hình Facebook Page Access Token");
  const msg = text.trim();
  const fbMid = await sendFacebookMessage(psid, msg, cfg.pageAccessToken);
  await pool.query(
    `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision, mid, sent_by)
     VALUES ($1, 'outgoing', $2, 'sent', 'manual_sent', $3, $4)
     ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
    [psid, msg, fbMid ?? null, sentByName],
  );
  return { ok: true, fbMid: fbMid ?? null };
}

async function sendFacebookImageAttachment(psid: string, imageUrl: string, pageAccessToken: string): Promise<{ ok: boolean; mid?: string }> {
  try {
    const r = await fetch(`https://graph.facebook.com/v22.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        message: {
          attachment: {
            type: "image",
            payload: { url: imageUrl, is_reusable: true },
          },
        },
        messaging_type: "RESPONSE",
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error(`[AI] psid=${psid} image send failed: ${r.status} ${errText.slice(0, 200)}`);
      return { ok: false };
    }
    const data = await r.json() as { message_id?: string };
    return { ok: true, mid: data.message_id };
  } catch (err) {
    console.error(`[AI] psid=${psid} image send exception:`, String(err).slice(0, 100));
    return { ok: false };
  }
}

async function sendPriceImagesSequentially(
  psid: string,
  pageAccessToken: string,
  priceImages: string[],
  aiDecision: string,
  settings?: AiSettings,
): Promise<boolean> {
  const validImages = priceImages
    .filter((img) => typeof img === "string" && img.trim().length > 0)
    .map((img) => resolveImagePath(img))
    .filter((img) => img.length > 0);
  if (validImages.length === 0) return false;
  if (settings?.logDecisions) {
    console.log(`[AI] psid=${psid} sending ${validImages.length} price image(s) decision=${aiDecision}`);
  }
  let allSent = true;
  for (let i = 0; i < validImages.length; i++) {
    const imgUrl = validImages[i].trim();
    if (settings?.typingIndicator !== false) await sendTypingOn(psid, pageAccessToken);
    await sleep(settings?.minDelayMs ?? 800);
    const { ok, mid: imgMid } = await sendFacebookImageAttachment(psid, imgUrl, pageAccessToken);
    if (ok) {
      await pool.query(
        `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision, mid)
         VALUES ($1, 'outgoing', $2, 'sent', $3, $4)
         ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
        [psid, formatImageMessage(imgUrl), `${aiDecision}_img${i}`, imgMid ?? null],
      );
      if (settings?.logDecisions) console.log(`[AI] psid=${psid} image[${i}] ✓ sent mid=${imgMid}`);
    } else {
      allSent = false;
      await pool.query(
        `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision)
         VALUES ($1, 'outgoing', $2, 'failed', $3)`,
        [psid, formatImageMessage(imgUrl), `${aiDecision}_img${i}_failed`],
      );
    }
  }
  return allSent;
}

/**
 * Gửi 1–2 ẢNH MẪU THẬT (bộ ảnh/đồ thuê/concept) qua Messenger attachment — gửi
 * HÌNH trực tiếp thay vì link. Resolve URL công khai (toPublicImageUrl) cho cả
 * /uploads lẫn /objects. Trả số ảnh gửi thành công. KHÔNG throw.
 */
async function sendSampleImagesSequentially(
  psid: string,
  pageAccessToken: string,
  samples: SampleImage[],
  settings?: AiSettings,
): Promise<number> {
  let sent = 0;
  for (let i = 0; i < samples.length; i++) {
    const url = toPublicImageUrl(samples[i].imageUrl);
    if (!url) continue;
    if (settings?.typingIndicator !== false) await sendTypingOn(psid, pageAccessToken);
    await sleep(settings?.minDelayMs ?? 800);
    const { ok, mid } = await sendFacebookImageAttachment(psid, url, pageAccessToken);
    if (ok) {
      sent++;
      await pool.query(
        `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision, mid)
         VALUES ($1, 'outgoing', $2, 'sent', $3, $4)
         ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
        [psid, formatImageMessage(url), `claude_sample_img${i}`, mid ?? null],
      );
    } else {
      await pool.query(
        `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision)
         VALUES ($1, 'outgoing', $2, 'failed', $3)`,
        [psid, formatImageMessage(url), `claude_sample_img${i}_failed`],
      );
    }
  }
  return sent;
}

async function fetchFacebookProfile(psid: string, pageAccessToken: string): Promise<{ name: string | null; avatarUrl: string | null; errorMsg?: string }> {
  try {
    const url = `https://graph.facebook.com/v21.0/${psid}?fields=first_name,last_name,name,profile_pic&access_token=${encodeURIComponent(pageAccessToken)}`;
    const r = await fetch(url);
    const data = (await r.json()) as { first_name?: string; last_name?: string; name?: string; profile_pic?: string; error?: { message?: string; code?: number; type?: string } };
    if (!r.ok || data.error) {
      const errMsg = data.error?.message ?? `HTTP ${r.status}`;
      console.warn(`[FBProfile] ❌ psid=${psid}: ${errMsg} (code=${data.error?.code ?? "-"})`);
      return { name: null, avatarUrl: null, errorMsg: errMsg };
    }
    const fullName = `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim();
    const name = fullName || data.name || null;
    const avatarUrl = data.profile_pic || null;
    if (name) console.log(`[FBProfile] ✓ psid=${psid} → "${name}"`);
    return { name, avatarUrl };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[FBProfile] ❌ psid=${psid}: ${errMsg}`);
    return { name: null, avatarUrl: null, errorMsg: errMsg };
  }
}

export { ensureFbInboxTable };

export function formatImageMessage(imageUrl: string): string {
  return `[image:${imageUrl}]`;
}

export function parseImageMessage(message: string): string | null {
  const m = message.match(/^\[image:(.+)\]$/);
  return m ? m[1] : null;
}

export function resolveMessageTagLabel(
  direction: "incoming" | "outgoing",
  aiDecision: string | null,
  sentBy: string | null,
): string | null {
  if (direction !== "outgoing") return null;
  if (aiDecision?.startsWith("auto_replied")) return "AI";
  if (aiDecision === "page_sent") return sentBy ?? null;
  if (aiDecision === "manual_sent" || aiDecision === "manual_image") {
    return sentBy ? sentBy : "Nhân viên";
  }
  return sentBy ? sentBy : "Nhân viên";
}

export async function processIncomingFacebookMessage(
  psid: string,
  text: string,
  mid?: string | null,
  activePageId?: string | null,
  opts?: { alreadyInserted?: boolean; imageUrls?: string[] },
) {
  if (activePageId && psid === activePageId) {
    console.log(`[FBInbox] Guard: skip processIncomingFacebookMessage — psid=${psid} matches activePageId`);
    return;
  }

  await ensureFbInboxTable();

  // Ảnh đã được webhook lưu sẵn (alreadyInserted) → bỏ qua bước insert + check trùng mid.
  if (!opts?.alreadyInserted) {
    const insertResult = await pool.query(
      `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, mid)
       VALUES ($1, 'incoming', $2, 'received', $3)
       ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
      [psid, text, mid ?? null],
    );

    if (mid && insertResult.rowCount === 0) {
      console.log(`[FBInbox] Duplicate mid=${mid} for psid=${psid} — skipping`);
      return;
    }
  }

  const cfg = await getConfig();

  // Tạo lead nếu chưa có
  const [existingLead] = await db
    .select({ id: crmLeadsTable.id, name: crmLeadsTable.name, avatarUrl: crmLeadsTable.avatarUrl, aiPerThreadEnabled: crmLeadsTable.aiPerThreadEnabled })
    .from(crmLeadsTable)
    .where(eq(crmLeadsTable.facebookUserId, psid))
    .limit(1);

  if (!existingLead) {
    const profile = cfg.pageAccessToken
      ? await fetchFacebookProfile(psid, cfg.pageAccessToken)
      : { name: null, avatarUrl: null };
    await db
      .insert(crmLeadsTable)
      .values({
        name: profile.name || `Khách Facebook ${psid.slice(-6)}`,
        avatarUrl: profile.avatarUrl,
        source: "facebook",
        facebookUserId: psid,
        status: "new",
        channel: "inbox",
      })
      .onConflictDoNothing({ target: crmLeadsTable.facebookUserId });
  } else if (
    cfg.pageAccessToken &&
    (!existingLead.avatarUrl || existingLead.name.startsWith("Khách Facebook "))
  ) {
    // Auto-retry: tên/avatar chưa lấy được lúc trước → thử lại không chặn flow
    fetchFacebookProfile(psid, cfg.pageAccessToken).then(async (profile) => {
      if (!profile.name && !profile.avatarUrl) return;
      const patch: { name?: string; avatarUrl?: string } = {};
      if (profile.name && existingLead.name.startsWith("Khách Facebook ")) patch.name = profile.name;
      if (profile.avatarUrl && !existingLead.avatarUrl) patch.avatarUrl = profile.avatarUrl;
      if (Object.keys(patch).length > 0) {
        await db.update(crmLeadsTable).set(patch).where(eq(crmLeadsTable.facebookUserId, psid));
      }
    }).catch(() => { /* bỏ qua lỗi retry */ });
  }

  // Lấy thông tin lead đầy đủ (bao gồm current_script_id, current_sale_step qua raw SQL)
  const leadRaw = await pool.query(
    `SELECT id, name, ai_per_thread_enabled, ai_mode, current_script_id, current_sale_step
     FROM crm_leads WHERE facebook_user_id = $1 LIMIT 1`,
    [psid],
  );
  const lead = leadRaw.rows[0] as {
    id: number;
    name: string;
    ai_per_thread_enabled: boolean | null;
    ai_mode: string | null;
    current_script_id: number | null;
    current_sale_step: number | null;
  } | undefined;

  // Phát hiện từ chối rõ ràng → đánh dấu opted-out, không follow-up tiếp
  const REFUSAL_PATTERNS = [
    /không quan tâm/i, /thôi không/i, /không cần/i, /không muốn/i, /không có nhu cầu/i,
    /không cần nữa/i, /thôi rồi/i, /đừng nhắn/i, /bỏ qua/i, /không liên hệ/i,
    /stop/i, /unsubscribe/i, /opt.?out/i, /xóa tôi/i, /xóa số/i,
  ];
  const isRefusal = REFUSAL_PATTERNS.some((re) => re.test(text));

  // Cập nhật follow-up log: last_customer_message_at = now
  if (isRefusal) {
    await pool.query(
      `INSERT INTO ai_follow_up_logs (psid, last_customer_message_at, follow_up_count, is_opted_out, last_follow_up_slot_index)
       VALUES ($1, now(), 0, true, NULL)
       ON CONFLICT (psid) DO UPDATE SET last_customer_message_at = now(), is_opted_out = true`,
      [psid],
    );
    console.log(`[AI] psid=${psid} opted-out phát hiện qua từ chối: "${text.slice(0, 60)}"`);
  } else {
    // Khách gửi tin mới → reset chu kỳ follow-up (slot index + count đều reset về 0)
    await pool.query(
      `INSERT INTO ai_follow_up_logs (psid, last_customer_message_at, follow_up_count, last_follow_up_at, last_follow_up_slot_index)
       VALUES ($1, now(), 0, NULL, NULL)
       ON CONFLICT (psid) DO UPDATE SET
         last_customer_message_at = now(),
         follow_up_count = 0,
         last_follow_up_at = NULL,
         last_follow_up_slot_index = NULL`,
      [psid],
    );
  }

  const aiMode = lead?.ai_mode ?? "active";

  // Cờ AI tự ghi (Monitor) — cập nhật bất kể AI có trả lời hay không. Read-only với CRM.
  if (detectPhone(text)) markPhoneCaptured(psid).catch(() => {});
  if (detectAppointmentIntent(text)) markAppointmentIntent(psid).catch(() => {});

  // ══ BỘ NÃO SALE CLAUDE (Giai đoạn 1 — chỉ tư vấn) ════════════════════════════
  // CẦU DAO TỔNG (DB) thay cho biến môi trường: 1 công tắc cho cả Test & Messenger.
  // Khi TẮT: webhook vẫn nhận tin, vẫn lưu lead + lịch sử (ở trên) — chỉ KHÔNG trả lời.
  // Khi lead ở 'paused'/'takeover': nhân viên đang chăm → AI im.
  const masterOn = await getMasterEnabled();
  if (masterOn && aiMode === "active") {
    await handleClaudeSaleReply(psid, text, lead, cfg, opts?.imageUrls);
    return;
  }
  // MỌI trường hợp còn lại (master tắt HOẶC lead không 'active') → KHÔNG trả lời.
  // Tin & lead đã lưu ở trên; chỉ ghi lý do. Không rơi xuống bot ChatGPT cũ.
  await pool.query(
    `UPDATE fb_inbox_messages SET ai_decision = $1
     WHERE id = (SELECT id FROM fb_inbox_messages WHERE facebook_user_id = $2 AND direction = 'incoming' ORDER BY id DESC LIMIT 1)`,
    [!masterOn ? "claude_master_off" : aiMode === "takeover" ? "ai_disabled_takeover" : "ai_disabled_paused", psid],
  );
  return;
  // ══ HẾT CLAUDE — phía dưới là bot ChatGPT/OpenAI cũ (đang tắt qua công tắc) ═══

  // ── CÔNG TẮC TẠM TẮT BỘ NÃO CHATGPT/OpenAI CŨ ──────────────────────────────
  // Mặc định TẮT (false). Khi tắt: webhook vẫn nhận tin, tạo lead, lưu lịch sử,
  // nhưng KHÔNG tự động trả lời (cả QA-script lẫn ChatGPT) — nhường chỗ cho Claude.
  // Bật lại bộ não cũ: đặt LEGACY_FB_BOT_ENABLED=1 (hoặc true) trong .env.
  const legacyBotEnabled = toBool(process.env.LEGACY_FB_BOT_ENABLED);
  const aiShouldReply = legacyBotEnabled && cfg.autoReplyEnabled && aiMode === "active";

  if (!aiShouldReply || !cfg.openaiApiKey || !cfg.pageAccessToken) {
    const decision = !legacyBotEnabled
      ? "legacy_bot_disabled"
      : !aiShouldReply
      ? !cfg.autoReplyEnabled ? "ai_disabled_global" : aiMode === "takeover" ? "ai_disabled_takeover" : "ai_disabled_paused"
      : "missing_config";
    await pool.query(
      `UPDATE fb_inbox_messages SET ai_decision = $1
       WHERE id = (SELECT id FROM fb_inbox_messages WHERE facebook_user_id = $2 AND direction = 'incoming' ORDER BY id DESC LIMIT 1)`,
      [decision, psid],
    );
    return;
  }

  const historyRows = await pool.query(
    `SELECT direction, message FROM fb_inbox_messages WHERE facebook_user_id = $1 ORDER BY id DESC LIMIT 20`,
    [psid],
  );
  const history = (historyRows.rows as Array<{ direction: "incoming" | "outgoing"; message: string }>).reverse();

  // Load AI settings từ kịch bản hiện tại (nếu có)
  const aiSettings = await loadScriptSettings(lead?.current_script_id ?? null);

  // === QA PRE-MATCH: khớp câu hỏi từ bảng kịch bản trước khi gọi GPT ===
  if (!aiSettings.forceGptOnly) {
  try {
    const qaRows = await loadQaRows();
    const { row: bestRow, score: bestScore } = matchQaRow(text, qaRows);

    if (bestRow && bestRow.answer?.trim()) {
      if (aiSettings.logDecisions) console.log(`[AI] psid=${psid} qa_match row_id=${bestRow.id} score=${bestScore.toFixed(2)} → skip GPT`);
      const answer = bestRow.answer.trim();
      const matchedRowId = bestRow.id;
      const chunks = splitIntoChunks(answer, aiSettings);
      if (aiSettings.logDecisions) console.log(`[AI] psid=${psid} qa_match raw="${answer.slice(0, 100)}" chunks=${chunks.length}`);
      const qaSent = await sendChunksWithTyping(psid, cfg.pageAccessToken!, chunks, `qa_match:${matchedRowId}`, aiSettings);
      const incomingDecision = qaSent ? `qa_matched:${matchedRowId}` : `qa_match_partial_failed:${matchedRowId}`;
      await pool.query(
        `UPDATE fb_inbox_messages SET ai_decision = $1
         WHERE id = (SELECT id FROM fb_inbox_messages WHERE facebook_user_id = $2 AND direction = 'incoming' ORDER BY id DESC LIMIT 1)`,
        [incomingDecision, psid],
      );
      return;
    }
  } catch (qaErr) {
    console.error("[AI] qa pre-match error:", qaErr);
  }
  } // end if (!aiSettings.forceGptOnly)
  // === HẾT QA PRE-MATCH ===

  if (aiSettings.forceQaOnly) {
    // forceQaOnly nhưng không match QA → gửi fallback
    const msgs = aiSettings.fallbackMessages.length > 0 ? aiSettings.fallbackMessages : [
      "Dạ bạn chờ em xíu nha, em kiểm tra lại cho mình ạ",
    ];
    const waitMsg = msgs[Math.floor(Math.random() * msgs.length)];
    await sendFacebookMessage(psid, waitMsg, cfg.pageAccessToken!);
    await pool.query(
      `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision)
       VALUES ($1, 'outgoing', $2, 'sent', 'force_qa_no_match')`,
      [psid, waitMsg],
    );
    return;
  }

  let ai: AiSaleReply;
  try {
    ai = await askChatGptForReply({
      apiKey: cfg.openaiApiKey,
      customerMessage: text,
      customerName: lead?.name ?? `Khách ${psid.slice(-4)}`,
      history,
      currentScriptId: lead?.current_script_id ?? null,
      currentSaleStep: lead?.current_sale_step ?? null,
      settings: aiSettings,
    });
  } catch (err) {
    await pool.query(
      `UPDATE fb_inbox_messages SET ai_decision = $1
       WHERE id = (SELECT id FROM fb_inbox_messages WHERE facebook_user_id = $2 AND direction = 'incoming' ORDER BY id DESC LIMIT 1)`,
      [`ai_error:${String(err)}`, psid],
    );
    console.error(`[AI] psid=${psid} error:`, err);
    // Gửi tin nhắn fallback lỗi GPT cho khách — dùng gptErrorMessages nếu được cấu hình
    const errMsgs = aiSettings.gptErrorMessages?.length > 0
      ? aiSettings.gptErrorMessages
      : ["Dạ bạn chờ em xíu nha, em đang xem lại thông tin cho mình ạ "];
    const errMsg = errMsgs[Math.floor(Math.random() * errMsgs.length)];
    try {
      await sendFacebookMessage(psid, errMsg, cfg.pageAccessToken);
      await pool.query(
        `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision)
         VALUES ($1, 'outgoing', $2, 'sent', 'gpt_error_fallback')`,
        [psid, errMsg],
      );
    } catch (_sendErr) { /* bỏ qua nếu gửi fallback cũng fail */ }
    return;
  }

  if (aiSettings.logDecisions) console.log(`[AI] psid=${psid} scriptId=${ai.scriptId} service_group=${ai.serviceGroup ?? "null"} step=${ai.step} fallback=${ai.usedFallback} handoff=${ai.shouldHandoff} reason="${ai.reason}"`);

  if (ai.isOutOfScope || ai.shouldHandoff || ai.messages.length === 0) {
    // Gửi câu "chờ xíu" tự nhiên — không để lộ là AI, không bịa câu trả lời
    const WAIT_MESSAGES = aiSettings.fallbackMessages.length > 0 ? aiSettings.fallbackMessages : [
      "Dạ bạn chờ em xíu nha, em kiểm tra lại cho mình ạ",
      "Dạ để em xem lại thông tin chính xác rồi báo mình liền nha",
    ];
    const waitMsg = WAIT_MESSAGES[Math.floor(Math.random() * WAIT_MESSAGES.length)];

    // Gửi qua Facebook
    await sendFacebookMessage(psid, waitMsg, cfg.pageAccessToken);

    // Lưu tin gửi đi vào fb_inbox_messages
    await pool.query(
      `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision)
       VALUES ($1, 'outgoing', $2, 'sent', 'unknown_question')`,
      [psid, waitMsg],
    );

    // Cập nhật ai_decision cho tin đến
    await pool.query(
      `UPDATE fb_inbox_messages SET ai_decision = 'unknown_question'
       WHERE id = (SELECT id FROM fb_inbox_messages WHERE facebook_user_id = $1 AND direction = 'incoming' ORDER BY id DESC LIMIT 1)`,
      [psid],
    );

    // Lưu câu hỏi lạ vào DB — chỉ khi saveUnknownQuestions = true và question_text không rỗng
    const questionText = text.trim();
    if (aiSettings.saveUnknownQuestions && questionText) {
      await pool.query(
        `INSERT INTO ai_unknown_questions (script_id, step, question_text, psid, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [ai.scriptId ?? null, ai.step ?? null, questionText, psid],
      );
      if (aiSettings.logDecisions) console.log(`[AI] unknown_question saved: psid=${psid} step=${ai.step} q="${questionText.slice(0, 60)}"`);
    }

    return;
  }

  // Tách từng message thành chunks và gửi tuần tự với typing indicator
  const aiDecisionBase = `auto_replied_step${ai.step ?? 0}`;
  const allChunks: string[] = [];
  for (const msg of ai.messages) {
    if (!msg.trim()) continue;
    allChunks.push(...splitIntoChunks(msg, aiSettings));
  }

  // Gửi ảnh bảng giá trước nếu đủ điều kiện
  if (ai.sendPriceImages && ai.priceImages.length > 0) {
    if (aiSettings.logDecisions) {
      console.log(`[AI] psid=${psid} step=${ai.step} autoSendPriceImage=true validImages=${ai.priceImages.length}`);
    }
    const imagesSent = await sendPriceImagesSequentially(psid, cfg.pageAccessToken, ai.priceImages, `${aiDecisionBase}_priceImg`, aiSettings);
    // Nếu sendPriceTextAfterImage = false → dừng chỉ khi TẤT CẢ ảnh gửi thành công
    // Nếu có ảnh thất bại → fallback gửi text bình thường
    if (!ai.sendPriceTextAfterImage) {
      if (imagesSent) {
        if (aiSettings.logDecisions) console.log(`[AI] psid=${psid} sendPriceTextAfterImage=false + images ok → stopping after images`);
        if (ai.scriptId && ai.step) {
          if (ai.serviceGroup && ai.step >= 3) {
            await pool.query(
              `UPDATE crm_leads SET current_script_id = $1, current_sale_step = $2, service_group = $3 WHERE facebook_user_id = $4`,
              [ai.scriptId, ai.step, ai.serviceGroup, psid],
            );
          } else {
            await pool.query(
              `UPDATE crm_leads SET current_script_id = $1, current_sale_step = $2 WHERE facebook_user_id = $3`,
              [ai.scriptId, ai.step, psid],
            );
          }
        }
        return;
      }
      // Một hoặc tất cả ảnh thất bại → fallback gửi text
      console.log(`[AI] psid=${psid} image send failed → fallback to text chunks`);
    }
  }

  if (aiSettings.logDecisions) console.log(`[AI] psid=${psid} gpt total_chunks=${allChunks.length} from ${ai.messages.length} messages`);
  const allSent = await sendChunksWithTyping(psid, cfg.pageAccessToken, allChunks, aiDecisionBase, aiSettings);

  if (allSent && ai.scriptId && ai.step) {
    if (ai.serviceGroup && ai.step >= 3) {
      await pool.query(
        `UPDATE crm_leads SET current_script_id = $1, current_sale_step = $2, service_group = $3 WHERE facebook_user_id = $4`,
        [ai.scriptId, ai.step, ai.serviceGroup, psid],
      );
    } else {
      await pool.query(
        `UPDATE crm_leads SET current_script_id = $1, current_sale_step = $2 WHERE facebook_user_id = $3`,
        [ai.scriptId, ai.step, psid],
      );
    }
    await pool.query(
      `UPDATE ai_follow_up_logs SET current_sale_step = $1 WHERE psid = $2`,
      [ai.step, psid],
    );
  }
}

/**
 * Xử lý trả lời tự động bằng Claude (Giai đoạn 1).
 * - Lưu/đánh dấu ai_decision rõ ràng cho từng nhánh.
 * - Lỗi Claude/API → ai_decision="claude_error", KHÔNG crash, KHÔNG gửi tin.
 * - Không tạo booking, không sửa/xóa lead, không đụng dữ liệu (chỉ đọc).
 */
async function handleClaudeSaleReply(
  psid: string,
  text: string,
  lead: { name?: string } | undefined,
  cfg: FbConfig,
  imageUrls?: string[],
): Promise<void> {
  const markIncoming = async (decision: string) => {
    await pool.query(
      `UPDATE fb_inbox_messages SET ai_decision = $1
       WHERE id = (SELECT id FROM fb_inbox_messages WHERE facebook_user_id = $2 AND direction = 'incoming' ORDER BY id DESC LIMIT 1)`,
      [decision, psid],
    );
  };

  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    console.warn(`[Claude] psid=${psid} ANTHROPIC_API_KEY chưa cấu hình — bỏ qua trả lời`);
    await markIncoming("claude_no_key");
    return;
  }
  if (!cfg.pageAccessToken) {
    await markIncoming("claude_no_page_token");
    return;
  }

  // Lịch sử hội thoại (tin khách hiện tại đã nằm cuối danh sách này)
  const historyRows = await pool.query(
    `SELECT direction, message FROM fb_inbox_messages WHERE facebook_user_id = $1 ORDER BY id DESC LIMIT 20`,
    [psid],
  );
  const history = (historyRows.rows as ClaudeHistoryItem[]).reverse();

  // Nạp cấu hình Claude Sale (dùng chung với Test) + lịch (read-only) nếu bật.
  const settings = await getClaudeSaleSettings();
  let scheduleContext = "";
  if (settings.calendarEnabled) {
    try { scheduleContext = await getScheduleContext(settings.calWindowDays); } catch { /* bỏ qua */ }
  }

  let reply;
  let visionIntent: CustomerImageIntent | null = null;
  try {
    let context = await getSaleContext();
    // "Ý tưởng chụp ảnh" là NGUỒN PHỤ: chỉ nạp khi khách thật sự muốn concept mới/lạ.
    if (wantsNewConcept(text)) {
      const ideas = await getPhotoIdeasBlock();
      if (ideas) context += `\n\n${ideas}`;
    }
    // ẢNH KHÁCH GỬI → AI Vision phân loại nhu cầu → lấy ĐÚNG nguồn dữ liệu (không lẫn nhóm).
    if (imageUrls && imageUrls.length > 0) {
      const caption = parseImageMessage(text) ? "" : text; // text dạng [image:..] → không có caption
      const convo = history
        .filter((h) => !h.message.startsWith("[image:"))
        .slice(-6)
        .map((h) => `${h.direction === "incoming" ? "Khách" : "Em"}: ${h.message}`)
        .join("\n");
      const intent = await classifyCustomerImageIntent({ imageUrl: imageUrls[0], messageText: caption, conversationContext: convo });
      visionIntent = intent;
      context += `\n\n${buildImageRoutingBlock(intent)}`;
      // Concept lạ → mới được dùng "Ý tưởng chụp ảnh" làm gợi ý phụ.
      if (intent.service_intent === "new_concept_idea" || intent.should_use_photo_ideas) {
        const ideas = await getPhotoIdeasBlock();
        if (ideas) context += `\n\n${ideas}`;
      }
      console.log(`[Vision] psid=${psid} ảnh → intent=${intent.service_intent} (conf=${intent.confidence})`);
    }
    const styleGuide = await getActivePlaybook();
    const brainRules = await getActiveBrainRules();
    reply = await askClaudeForReply({
      apiKey,
      model: process.env.ANTHROPIC_MODEL?.trim() || undefined,
      customerMessage: text,
      customerName: lead?.name,
      history,
      context,
      styleGuide,
      settings,
      scheduleContext,
      brainRules,
    });
  } catch (err) {
    console.error(`[Claude] psid=${psid} lỗi gọi Claude:`, err);
    await markIncoming("claude_error");
    return;
  }

  // Tên khách Claude vừa học được → lưu lead NẾU tên hiện tại vẫn là placeholder
  // (KHÔNG ghi đè tên admin/đã có tên thật).
  if (reply.learnedName && isPlaceholderLeadName(lead?.name)) {
    await pool.query(`UPDATE crm_leads SET name = $1 WHERE facebook_user_id = $2`, [reply.learnedName, psid]);
    console.log(`[Claude] psid=${psid} lưu tên khách tự khai: "${reply.learnedName}"`);
  }

  // Escalation: từ marker của Claude HOẶC từ khóa (chuyển khoản/đặt cọc/gặp người/deal/hủy lịch)
  // HOẶC ảnh không chắc nhu cầu (confidence thấp / studio chưa chắc làm được).
  const escalationReason =
    reply.escalation
    || detectEscalation(text)
    || imageEscalationReason(visionIntent, settings.lowConfidenceThreshold);

  // ── HUMAN REVIEW GATE ──────────────────────────────────────────────────────
  // Khi bật & có escalation: KHÔNG gửi nội dung chính / ảnh mẫu / bảng giá. Chỉ gửi 1 câu giữ
  // khách, tạo/cập nhật "báo đỏ" cho nhân viên thật, rồi chuyển thread cho người (takeover).
  if (settings.humanReviewEnabled && escalationReason) {
    const hr = await upsertOpenHumanReview({
      facebookUserId: psid,
      channel: "messenger",
      customerName: lead?.name ?? null,
      customerQuestion: text,
      customerImages: imageUrls && imageUrls.length > 0 ? imageUrls : null,
      detectedIntent: visionIntent?.service_intent ?? reply.sampleIntents?.[0] ?? null,
      confidence: typeof visionIntent?.confidence === "number" ? visionIntent.confidence : null,
      reasonForEscalation: escalationReason,
      aiSuggestedReply: settings.allowAiSuggestedReply
        ? (reply.messages.filter((m) => m.trim()).join("\n\n") || reply.raw || null)
        : null,
    });
    // Gửi câu giữ khách 1 lần / escalation (điểm 4 — không lặp).
    if (hr.created || !hr.holdAlreadySent) {
      const holdMs = Math.max(0, settings.holdMessageAfterSeconds) * 1000;
      try {
        await sendChunksWithTyping(psid, cfg.pageAccessToken, [HOLD_MESSAGE], "claude_hold_message", undefined, holdMs);
      } catch (e) {
        console.error(`[Claude] psid=${psid} gửi hold message lỗi:`, String(e).slice(0, 120));
      }
      await markHoldSent(hr.id);
    }
    await markIncoming(`claude_escalated_hold`);
    // Tạm dừng bot (takeover) + cờ + báo đỏ. Nếu tắt autoPause thì chỉ ghi cờ, không đổi ai_mode.
    if (settings.autoPauseThreadWhenEscalated) {
      await escalateToHuman(psid, lead?.name, escalationReason);
    } else {
      await markNeedsHuman(psid, escalationReason);
    }
    console.log(`[Claude] psid=${psid} HUMAN REVIEW (hr=${hr.id}, created=${hr.created}): ${escalationReason}`);
    return;
  }

  // ẢNH MẪU THẬT: gửi HÌNH trực tiếp TRƯỚC text (yêu cầu: ảnh mẫu → text ngắn → link).
  // Đặt TRƯỚC guard "chunks rỗng" để tin chỉ-có-marker (<<SAMPLE>>) vẫn gửi được ảnh.
  // Marker <<SAMPLE>> của Claude hoặc tự suy nhóm từ ảnh/tin khách. Lỗi/không có ảnh → bỏ qua, vẫn gửi text.
  let samplesExhausted = false;
  try {
    const contextText = history
      .filter((h) => !h.message.startsWith("[image:"))
      .slice(-4)
      .map((h) => h.message)
      .join("\n");
    // Tin nhắn gần nhất của bot (để xét khách "đồng ý" sau khi bot mời gửi mẫu).
    const lastBotText = [...history].reverse().find((h) => h.direction === "outgoing")?.message ?? null;
    const sel = await selectSampleImages({
      sampleRequested: reply.sampleRequested,
      sampleIntents: reply.sampleIntents,
      messageText: text,
      contextText,
      lastBotText,
      visionIntent,
      settings,
      excludeUrls: extractRecentSampleUrls(history),
      maxTotal: 2,
    });
    if (sel.images.length > 0) {
      const nSent = await sendSampleImagesSequentially(psid, cfg.pageAccessToken, sel.images);
      console.log(`[Claude] psid=${psid} gửi ${nSent}/${sel.images.length} ảnh mẫu (nhóm: ${sel.resolvedIntents.join(",")})`);
    }
    samplesExhausted = sel.exhausted;
  } catch (e) {
    console.error(`[Claude] psid=${psid} gửi ảnh mẫu lỗi:`, String(e).slice(0, 160));
  }

  const chunks = reply.messages.filter((m) => m.trim().length > 0);
  // Hết mẫu mới → ghép câu nhắn khéo VÀO chunks để đi qua sendChunksWithTyping (được LOG vào DB
  // + có typing, đồng bộ với mọi tin khác) thay vì gửi rời không log.
  if (samplesExhausted) chunks.push(SAMPLES_EXHAUSTED_NOTE);
  if (chunks.length === 0) {
    console.warn(`[Claude] psid=${psid} Claude trả về rỗng`);
    await markIncoming(escalationReason ? "claude_escalated_empty" : "claude_empty");
    if (escalationReason) await escalateToHuman(psid, lead?.name, escalationReason);
    return;
  }

  // BẢNG GIÁ: gửi HÌNH bảng giá TRƯỚC text (yêu cầu: hình giá trước, lời giải thích bên dưới).
  // Claude xác định gói (<<PRICE_IMAGE: MÃ>>) → nhóm có ai_image_url & public_for_customer=true → attachment.
  // Lỗi attachment thì fallback gửi LINK ảnh public.
  if (reply.priceImageCodes?.length) {
    try {
      const hits = await resolvePriceImagesByCodes(reply.priceImageCodes);
      if (hits.length > 0) {
        const objectPaths = hits.map((h) => h.objectPath);
        const imgsSent = await sendPriceImagesSequentially(psid, cfg.pageAccessToken, objectPaths, "claude_price_img");
        if (imgsSent) {
          console.log(`[Claude] psid=${psid} đã gửi ${hits.length} ảnh bảng giá nhóm: ${hits.map((h) => h.groupName).join(", ")}`);
        } else {
          // Fallback: gửi LINK ảnh public dạng text để khách vẫn xem được.
          const links = objectPaths.map((p) => resolveImagePath(p)).filter(Boolean).join("\n");
          if (links) {
            try { await sendFacebookMessage(psid, `Dạ em gửi bảng giá để mình xem nha 😊\n${links}`, cfg.pageAccessToken); } catch { /* bỏ qua */ }
            console.log(`[Claude] psid=${psid} ảnh attachment lỗi → đã fallback gửi link ảnh bảng giá`);
          }
        }
      }
    } catch (e) {
      console.error(`[Claude] psid=${psid} gửi ảnh bảng giá nhóm lỗi:`, String(e).slice(0, 160));
    }
  }

  // Tốc độ trả lời: delay theo độ dài tin KHÁCH (cấu hình + random ±30%). Áp dụng cho bubble đầu.
  const replyDelayMs = computeReplyDelayMs(text, settings);
  const allSent = await sendChunksWithTyping(psid, cfg.pageAccessToken, chunks, "claude_replied", undefined, replyDelayMs);
  await markIncoming(allSent ? (escalationReason ? "claude_replied_escalated" : "claude_replied") : "claude_partial_failed");
  console.log(`[Claude] psid=${psid} đã gửi ${chunks.length} tin (allSent=${allSent})`);

  // Sau khi đã gửi câu chuyển tiếp lịch sự → chuyển nhân viên thật tiếp quản.
  if (escalationReason) await escalateToHuman(psid, lead?.name, escalationReason);
}

/** Tên lead còn là placeholder (chưa có tên thật) → được phép ghi đè bằng tên mới. */
function isPlaceholderLeadName(name?: string | null): boolean {
  if (!name?.trim()) return true;
  return name.startsWith("Khách Facebook ") || /^Khách\s/i.test(name) || /^FB\s/i.test(name);
}

/**
 * Escalation → NEEDS_HUMAN_CONFIRMATION: chuyển lead sang 'takeover' (AI im),
 * ghi cờ cần-tiếp-quản, và báo nhân viên thật qua notification. KHÔNG đụng booking.
 */
async function escalateToHuman(psid: string, leadName: string | undefined, reason: string): Promise<void> {
  try {
    await pool.query(`UPDATE crm_leads SET ai_mode = 'takeover' WHERE facebook_user_id = $1`, [psid]);
  } catch (err) {
    console.error(`[Claude] psid=${psid} set takeover lỗi:`, String(err).slice(0, 120));
  }
  await markNeedsHuman(psid, reason);
  const who = leadName && !isPlaceholderLeadName(leadName) ? leadName : `khách FB …${psid.slice(-4)}`;
  emitNotification({
    staffId: null, // broadcast cho admin/nhân viên đang trực
    type: "claude_sale_escalation",
    priority: "high",
    title: "Claude Sale cần người tiếp quản",
    message: `${who}: ${reason}. AI đã tạm dừng ở hội thoại này, cần nhân viên xác nhận/xử lý.`,
    targetModule: "facebook-inbox-ai",
  });
  console.log(`[Claude] psid=${psid} ESCALATE → takeover + notify: ${reason}`);
}

function maskToken(t: string | null): string | null {
  if (!t || t.length < 8) return t ? "****" : null;
  return t.slice(0, 4) + "****" + t.slice(-4);
}

router.get("/fb-ai/config", async (req, res) => {
  const caller = await getCaller(req);
  if (!isAdmin(caller)) return res.status(403).json({ error: "Chỉ admin mới xem cấu hình" });
  const cfg = await getConfig();
  res.json({
    hasPageAccessToken: !!cfg.pageAccessToken,
    hasOpenAiKey: !!cfg.openaiApiKey,
    hasVerifyToken: !!cfg.verifyToken,
    autoReplyEnabled: cfg.autoReplyEnabled,
    pageAccessTokenHint: maskToken(cfg.pageAccessToken),
    openAiKeyHint: maskToken(cfg.openaiApiKey),
    verifyTokenHint: maskToken(cfg.verifyToken),
  });
});

router.put("/fb-ai/config", async (req, res) => {
  const caller = await getCaller(req);
  if (!isAdmin(caller)) return res.status(403).json({ error: "Chỉ admin mới sửa cấu hình" });

  const {
    pageAccessToken,
    verifyToken,
    openaiApiKey,
    autoReplyEnabled,
  } = req.body as {
    pageAccessToken?: string;
    verifyToken?: string;
    openaiApiKey?: string;
    autoReplyEnabled?: boolean;
  };

  const updates: Array<[string, string]> = [];
  if (pageAccessToken !== undefined) updates.push(["fb_page_access_token", pageAccessToken.trim()]);
  if (verifyToken !== undefined) updates.push(["fb_verify_token", verifyToken.trim()]);
  if (openaiApiKey !== undefined) updates.push(["openai_api_key", openaiApiKey.trim()]);
  if (autoReplyEnabled !== undefined) updates.push(["fb_auto_reply_enabled", autoReplyEnabled ? "true" : "false"]);

  for (const [key, value] of updates) {
    await db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value },
      });
  }
  res.json({ success: true });
});

// GET /fb-ai/status — trạng thái AI cho mọi user đã đăng nhập (không cần admin)
router.get("/fb-ai/status", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const cfg = await getConfig();
  // CẦU DAO TỔNG (DB) là nguồn sự thật DUY NHẤT cho Claude Sale. hasConfig = sẵn sàng
  // chạy Claude (có Page token + ANTHROPIC_API_KEY). autoReplyEnabled giữ tên cũ để
  // tương thích UI, nhưng nay = trạng thái cầu dao tổng.
  const masterEnabled = await getMasterEnabled();
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY ?? "").trim();
  res.json({ autoReplyEnabled: masterEnabled, masterEnabled, hasConfig: !!cfg.pageAccessToken && hasApiKey });
});

// GET /fb-ai/webhook-log — xem 50 sự kiện webhook gần nhất (chỉ admin)
router.get("/fb-ai/webhook-log", async (req, res) => {
  const caller = await getCaller(req);
  if (!isAdmin(caller)) return res.status(403).json({ error: "Không có quyền" });
  res.json({ events: webhookEvents, total: webhookEvents.length });
});

// GET /fb-ai/page-info — lấy thông tin fanpage đang được kết nối (dùng token lưu trong DB)
router.get("/fb-ai/page-info", async (req, res) => {
  const caller = await getCaller(req);
  if (!isAdmin(caller)) return res.status(403).json({ error: "Không có quyền" });
  const cfg = await getConfig();
  if (!cfg.pageAccessToken) return res.status(400).json({ error: "Chưa cấu hình Page Access Token" });
  try {
    const r = await fetch(`https://graph.facebook.com/me?fields=id,name,fan_count,picture&access_token=${encodeURIComponent(cfg.pageAccessToken)}`);
    const data = await r.json() as Record<string, unknown>;
    if (!r.ok) return res.status(400).json({ error: (data as { error?: { message?: string } }).error?.message ?? "Lỗi Facebook API" });
    res.json({ pageId: data.id, pageName: data.name, fanCount: data.fan_count, picture: (data.picture as { data?: { url?: string } })?.data?.url ?? null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /fb-ai/subscribe-webhook — đăng ký webhook cho fanpage (dùng token lưu trong DB)
router.post("/fb-ai/subscribe-webhook", async (req, res) => {
  const caller = await getCaller(req);
  if (!isAdmin(caller)) return res.status(403).json({ error: "Không có quyền" });
  const cfg = await getConfig();
  if (!cfg.pageAccessToken) return res.status(400).json({ error: "Chưa cấu hình Page Access Token" });
  try {
    // Lấy page ID
    const meRes = await fetch(`https://graph.facebook.com/me?fields=id,name&access_token=${encodeURIComponent(cfg.pageAccessToken)}`);
    const meData = await meRes.json() as { id?: string; name?: string; error?: { message?: string } };
    if (!meRes.ok || !meData.id) return res.status(400).json({ error: meData.error?.message ?? "Không lấy được Page ID" });
    // Đăng ký webhook subscriptions
    const subRes = await fetch(
      `https://graph.facebook.com/${meData.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads&access_token=${encodeURIComponent(cfg.pageAccessToken)}`,
      { method: "POST" },
    );
    const subData = await subRes.json() as { success?: boolean; error?: { message?: string } };
    if (!subRes.ok || !subData.success) return res.status(400).json({ error: subData.error?.message ?? "Đăng ký webhook thất bại" });

    // Lưu page ID active vào DB để lọc webhook
    await db
      .insert(settingsTable)
      .values({ key: "fb_active_page_id", value: meData.id! })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: meData.id! } });
    await db
      .insert(settingsTable)
      .values({ key: "fb_active_page_name", value: meData.name ?? "" })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: meData.name ?? "" } });

    res.json({ success: true, pageId: meData.id, pageName: meData.name });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /fb-ai/sync-profiles — đồng bộ lại tên/avatar (mọi user đã đăng nhập dùng được)
router.post("/fb-ai/sync-profiles", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });

  const cfg = await getConfig();
  if (!cfg.pageAccessToken) return res.status(400).json({ error: "Chưa cấu hình Page Access Token" });

  const leads = await db
    .select({
      id: crmLeadsTable.id,
      facebookUserId: crmLeadsTable.facebookUserId,
      name: crmLeadsTable.name,
      avatarUrl: crmLeadsTable.avatarUrl,
    })
    .from(crmLeadsTable)
    .where(eq(crmLeadsTable.source, "facebook"));

  let scanned = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const lead of leads) {
    const psid = lead.facebookUserId?.trim();
    if (!psid) continue;
    scanned += 1;

    const profile = await fetchFacebookProfile(psid, cfg.pageAccessToken);
    const nextName = profile.name;
    const nextAvatar = profile.avatarUrl;

    if (!nextName && !nextAvatar) {
      failed += 1;
      await setProfileSyncStatus(psid, profile.errorMsg ? "failed" : "unavailable");
      if (profile.errorMsg && !errors.includes(profile.errorMsg)) {
        errors.push(profile.errorMsg);
      }
      continue;
    }

    // BẢO VỆ tên admin đã sửa: chỉ cập nhật tên khi tên hiện tại còn là placeholder.
    const canSetName = !!nextName && isPlaceholderLeadName(lead.name);
    await db
      .update(crmLeadsTable)
      .set({
        ...(canSetName ? { name: nextName! } : {}),
        ...(nextAvatar ? { avatarUrl: nextAvatar } : {}),
      })
      .where(eq(crmLeadsTable.id, lead.id));
    await setProfileSyncStatus(psid, "synced");
    updated += 1;
  }

  if (failed > 0) {
    console.warn(`[SyncProfiles] ${failed}/${scanned} thất bại. Lỗi: ${errors.join(" | ")}`);
  }
  res.json({ success: true, scanned, updated, failed, errors });
});

// POST /fb-inbox/threads/:psid/sync-profile — đồng bộ tên/avatar 1 hội thoại (nút "Đồng bộ tên").
// Bảo vệ tên admin đã sửa; không crash; ghi profile_sync_status.
router.post("/fb-inbox/threads/:psid/sync-profile", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const cfg = await getConfig();
  if (!cfg.pageAccessToken) return res.status(400).json({ error: "Chưa cấu hình Page Access Token" });
  const psid = req.params.psid;

  const [lead] = await db
    .select({ id: crmLeadsTable.id, name: crmLeadsTable.name, avatarUrl: crmLeadsTable.avatarUrl })
    .from(crmLeadsTable)
    .where(eq(crmLeadsTable.facebookUserId, psid))
    .limit(1);
  if (!lead) return res.status(404).json({ error: "Không tìm thấy hội thoại" });

  const profile = await fetchFacebookProfile(psid, cfg.pageAccessToken);
  if (!profile.name && !profile.avatarUrl) {
    const status = profile.errorMsg ? "failed" : "unavailable";
    await setProfileSyncStatus(psid, status);
    return res.json({ success: false, status, error: profile.errorMsg ?? "Facebook không trả về tên/avatar", name: lead.name, avatarUrl: lead.avatarUrl });
  }
  const canSetName = !!profile.name && isPlaceholderLeadName(lead.name);
  await db
    .update(crmLeadsTable)
    .set({
      ...(canSetName ? { name: profile.name! } : {}),
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
    })
    .where(eq(crmLeadsTable.id, lead.id));
  await setProfileSyncStatus(psid, "synced");
  res.json({
    success: true,
    status: "synced",
    name: canSetName ? profile.name : lead.name,
    avatarUrl: profile.avatarUrl ?? lead.avatarUrl,
    nameKept: !canSetName && !!profile.name, // tên admin được giữ nguyên
  });
});

router.get("/fb-inbox/staff-senders", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const r = await pool.query(
    `SELECT DISTINCT sent_by FROM fb_inbox_messages WHERE direction = 'outgoing' AND sent_by IS NOT NULL AND sent_by <> '' ORDER BY sent_by ASC`,
  );
  res.json((r.rows as Array<{ sent_by: string }>).map((row) => row.sent_by));
});

router.get("/fb-inbox/threads", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });

  const sentBy = typeof req.query.sentBy === "string" && req.query.sentBy.trim() ? req.query.sentBy.trim() : null;

  let q;
  if (sentBy) {
    q = await pool.query(
      `
      SELECT
        m.facebook_user_id,
        MAX(m.created_at) AS last_at,
        (ARRAY_AGG(m.message ORDER BY m.created_at DESC))[1] AS last_message,
        (ARRAY_AGG(m.direction ORDER BY m.created_at DESC))[1] AS last_direction,
        (ARRAY_AGG(m.ai_decision ORDER BY m.created_at DESC))[1] AS last_ai_decision
      FROM fb_inbox_messages m
      WHERE m.facebook_user_id IN (
        SELECT DISTINCT facebook_user_id FROM fb_inbox_messages
        WHERE direction = 'outgoing' AND sent_by = $1
      )
      GROUP BY m.facebook_user_id
      ORDER BY MAX(m.created_at) DESC
      LIMIT 200
      `,
      [sentBy],
    );
  } else {
    q = await pool.query(`
      SELECT
        m.facebook_user_id,
        MAX(m.created_at) AS last_at,
        (ARRAY_AGG(m.message ORDER BY m.created_at DESC))[1] AS last_message,
        (ARRAY_AGG(m.direction ORDER BY m.created_at DESC))[1] AS last_direction,
        (ARRAY_AGG(m.ai_decision ORDER BY m.created_at DESC))[1] AS last_ai_decision
      FROM fb_inbox_messages m
      GROUP BY m.facebook_user_id
      ORDER BY MAX(m.created_at) DESC
      LIMIT 200
    `);
  }

  const psids = (q.rows as Array<{ facebook_user_id: string }>).map((r) => r.facebook_user_id);
  let leadsByPsid = new Map<string, {
    id: number; name: string; phone: string | null; status: string | null;
    avatarUrl: string | null; aiPerThreadEnabled: boolean | null; aiMode: string;
    customerId: number | null; notes: string | null;
    currentScriptId: number | null; currentSaleStep: number | null; scriptName: string | null;
    profileSyncStatus: string | null; needsHuman: boolean;
  }>();
  if (psids.length > 0) {
    const placeholders = psids.map((_, i) => `$${i + 1}`).join(", ");
    const leadsRaw = await pool.query(
      `SELECT l.id, l.facebook_user_id, l.name, l.phone, l.status, l.avatar_url,
              l.ai_per_thread_enabled, l.ai_mode, l.customer_id, l.notes,
              l.current_script_id, l.current_sale_step,
              s.name AS script_name,
              f.profile_sync_status, COALESCE(f.needs_human, false) AS needs_human
       FROM crm_leads l
       LEFT JOIN ai_service_scripts s ON s.id = l.current_script_id
       LEFT JOIN claude_sale_lead_flags f ON f.facebook_user_id = l.facebook_user_id
       WHERE l.facebook_user_id IN (${placeholders})`,
      psids,
    );
    leadsByPsid = new Map(
      (leadsRaw.rows as Array<{
        id: number; facebook_user_id: string; name: string; phone: string | null;
        status: string | null; avatar_url: string | null; ai_per_thread_enabled: boolean | null;
        ai_mode: string | null; customer_id: number | null; notes: string | null;
        current_script_id: number | null; current_sale_step: number | null; script_name: string | null;
        profile_sync_status: string | null; needs_human: boolean | null;
      }>)
        .filter((x) => !!x.facebook_user_id)
        .map((x) => [x.facebook_user_id, {
          id: x.id,
          name: x.name,
          phone: x.phone,
          status: x.status,
          avatarUrl: x.avatar_url ?? null,
          aiPerThreadEnabled: x.ai_per_thread_enabled ?? null,
          aiMode: x.ai_mode ?? "active",
          customerId: x.customer_id ?? null,
          notes: x.notes ?? null,
          currentScriptId: x.current_script_id ?? null,
          currentSaleStep: x.current_sale_step ?? null,
          scriptName: x.script_name ?? null,
          profileSyncStatus: x.profile_sync_status ?? null,
          needsHuman: !!x.needs_human,
        }]),
    );
  }

  res.json(
    (q.rows as Array<{
      facebook_user_id: string;
      last_at: string;
      last_message: string;
      last_direction: "incoming" | "outgoing";
      last_ai_decision: string | null;
    }>).map((r) => ({
      psid: r.facebook_user_id,
      lastAt: r.last_at,
      lastMessage: r.last_message,
      lastDirection: r.last_direction,
      lastAiDecision: r.last_ai_decision,
      lead: leadsByPsid.get(r.facebook_user_id) ?? null,
    })),
  );
});

router.get("/fb-inbox/threads/:psid/messages", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  const r = await pool.query(
    `
    SELECT id, direction, message, sent_status, ai_decision, sent_by, created_at
    FROM fb_inbox_messages
    WHERE facebook_user_id = $1
    ORDER BY created_at ASC
    LIMIT 500
    `,
    [psid],
  );
  res.json(r.rows);
});

router.post("/fb-inbox/threads/:psid/suggest", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  const cfg = await getConfig();
  if (!cfg.openaiApiKey) return res.status(400).json({ error: "Chưa cấu hình OpenAI API key" });

  const historyRows = await pool.query(
    `SELECT direction, message FROM fb_inbox_messages WHERE facebook_user_id = $1 ORDER BY id DESC LIMIT 30`,
    [psid],
  );
  const latestIncoming = (historyRows.rows as Array<{ direction: "incoming" | "outgoing"; message: string }>).find(
    (m) => m.direction === "incoming",
  );
  if (!latestIncoming) return res.status(400).json({ error: "Chưa có tin nhắn từ khách để gợi ý" });

  const leadRows = await db.select().from(crmLeadsTable).where(eq(crmLeadsTable.facebookUserId, psid)).limit(1);
  const lead = leadRows[0];
  const ai = await askChatGptForReply({
    apiKey: cfg.openaiApiKey,
    customerMessage: latestIncoming.message,
    customerName: lead?.name ?? `Khách ${psid.slice(-4)}`,
    history: (historyRows.rows as Array<{ direction: "incoming" | "outgoing"; message: string }>).reverse(),
    currentScriptId: lead?.current_script_id ?? null,
    currentSaleStep: lead?.current_sale_step ?? null,
    settings: await loadScriptSettings(lead?.current_script_id ?? null),
  });
  res.json(ai);
});

router.post("/fb-inbox/threads/:psid/send", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  const { text } = req.body as { text?: string };
  if (!text || !text.trim()) return res.status(400).json({ error: "Thiếu nội dung gửi" });

  const cfg = await getConfig();
  if (!cfg.pageAccessToken) return res.status(400).json({ error: "Chưa cấu hình Facebook Page Access Token" });

  const msg = text.trim();
  const sentBy = caller.name ?? null;
  try {
    const fbMid = await sendFacebookMessage(psid, msg, cfg.pageAccessToken);
    await pool.query(
      `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision, mid, sent_by)
       VALUES ($1, 'outgoing', $2, 'sent', 'manual_sent', $3, $4)
       ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
      [psid, msg, fbMid ?? null, sentBy],
    );
    await pool.query(
      `UPDATE crm_leads SET ai_mode = 'takeover' WHERE facebook_user_id = $1`,
      [psid],
    );
    res.json({ success: true });
  } catch (err) {
    const errStr = String(err);
    let fbError = errStr;
    try {
      const m = errStr.match(/Facebook send failed: \d+ (.+)/);
      if (m) {
        const parsed = JSON.parse(m[1]) as { error?: { message?: string } };
        if (parsed?.error?.message) fbError = parsed.error.message;
      }
    } catch { /* giữ errStr */ }
    console.error(`[Inbox] send failed psid=${psid}: ${errStr}`);
    res.status(500).json({ error: "Gửi Facebook thất bại", fbError, detail: errStr });
  }
});

router.post("/fb-inbox/threads/:psid/send-image", upload.single("image"), async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  const file = req.file;
  if (!file) return res.status(400).json({ error: "Chưa chọn ảnh" });

  const cfg = await getConfig();
  if (!cfg.pageAccessToken) return res.status(400).json({ error: "Chưa cấu hình Facebook Page Access Token" });

  const mimeType = file.mimetype || "image/jpeg";
  const extMap: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
  const ext = extMap[mimeType] ?? "jpg";

  let publicUrl: string;
  try {
    publicUrl = await uploadImageToGcs(file.buffer, mimeType, ext);
  } catch (err) {
    console.error(`[Inbox] GCS upload failed psid=${psid}:`, err);
    return res.status(500).json({ error: "Upload ảnh thất bại", detail: String(err) });
  }

  const sentByImage = caller.name ?? null;
  try {
    const { ok, mid: fbMid } = await sendFacebookImageAttachment(psid, publicUrl, cfg.pageAccessToken);
    if (!ok) {
      return res.status(500).json({ error: "Gửi ảnh lên Facebook thất bại", fbError: "sendFacebookImageAttachment returned false" });
    }
    await pool.query(
      `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision, mid, sent_by)
       VALUES ($1, 'outgoing', $2, 'sent', 'manual_image', $3, $4)
       ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
      [psid, formatImageMessage(publicUrl), fbMid ?? null, sentByImage],
    );
    await pool.query(
      `UPDATE crm_leads SET ai_mode = 'takeover' WHERE facebook_user_id = $1`,
      [psid],
    );
    res.json({ success: true, imageUrl: publicUrl });
  } catch (err) {
    const errStr = String(err);
    let fbError = errStr;
    try {
      const m = errStr.match(/Facebook send failed: \d+ (.+)/);
      if (m) {
        const parsed = JSON.parse(m[1]) as { error?: { message?: string } };
        if (parsed?.error?.message) fbError = parsed.error.message;
      }
    } catch { /* giữ errStr */ }
    console.error(`[Inbox] send image failed psid=${psid}: ${errStr}`);
    res.status(500).json({ error: "Gửi ảnh lên Facebook thất bại", fbError, detail: errStr });
  }
});

router.get("/fb-ai/service-context", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const ctx = await buildStudioContext();
  res.json({ context: ctx });
});

// PUT /fb-ai/threads/:psid/ai-mode — đặt chế độ AI thread (active|paused|takeover)
router.put("/fb-ai/threads/:psid/ai-mode", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  const { aiMode } = req.body as { aiMode?: string };
  if (!aiMode || !["active", "paused", "takeover"].includes(aiMode)) {
    return res.status(400).json({ error: "aiMode phải là active, paused hoặc takeover" });
  }
  try {
    const result = await pool.query(
      `UPDATE crm_leads SET ai_mode = $1 WHERE facebook_user_id = $2 RETURNING id`,
      [aiMode, psid],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Không tìm thấy lead với PSID này" });
    res.json({ success: true, aiMode });
  } catch (err) {
    console.error("PUT /fb-ai/threads/:psid/ai-mode error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// PATCH /fb-inbox/threads/:psid/ai-toggle — bật/tắt AI riêng từng thread
router.patch("/fb-inbox/threads/:psid/ai-toggle", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  const { enabled } = req.body as { enabled: boolean | null };
  if (enabled !== true && enabled !== false && enabled !== null) {
    return res.status(400).json({ error: "enabled phải là true, false hoặc null" });
  }
  try {
    const leadRows = await db
      .select({ id: crmLeadsTable.id })
      .from(crmLeadsTable)
      .where(eq(crmLeadsTable.facebookUserId, psid))
      .limit(1);
    if (!leadRows[0]) return res.status(404).json({ error: "Không tìm thấy lead với PSID này" });
    await db
      .update(crmLeadsTable)
      .set({ aiPerThreadEnabled: enabled })
      .where(eq(crmLeadsTable.id, leadRows[0].id));
    res.json({ success: true, aiPerThreadEnabled: enabled });
  } catch (err) {
    console.error("PATCH /fb-inbox/threads/:psid/ai-toggle error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// POST /fb-inbox/threads/:psid/create-customer — tạo khách hàng từ PSID Facebook
router.post("/fb-inbox/threads/:psid/create-customer", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  const { phone, zalo } = req.body as { phone?: string; zalo?: string };

  try {
    const leadRows = await db
      .select()
      .from(crmLeadsTable)
      .where(eq(crmLeadsTable.facebookUserId, psid))
      .limit(1);
    const lead = leadRows[0];
    if (!lead) return res.status(404).json({ error: "Không tìm thấy lead với PSID này" });

    const existingByFbId = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(eq(customersTable.facebookUserId, psid))
      .limit(1);
    if (existingByFbId[0]) return res.status(400).json({ error: "Khách hàng Facebook này đã được tạo trước đó" });

    const phoneValue = phone?.trim() || null;
    if (phoneValue) {
      const existingByPhone = await db
        .select({ id: customersTable.id })
        .from(customersTable)
        .where(eq(customersTable.phone, phoneValue))
        .limit(1);
      if (existingByPhone[0]) return res.status(400).json({ error: "Số điện thoại này đã tồn tại trong hệ thống" });
    }

    const [customer] = await db
      .insert(customersTable)
      .values({
        name: lead.name,
        phone: phoneValue,
        zalo: zalo?.trim() || null,
        avatar: lead.avatarUrl || null,
        facebook: lead.facebookUserId ? `https://www.facebook.com/${lead.facebookUserId}` : null,
        facebookUserId: psid,
        source: "facebook",
        notes: lead.notes || lead.message || null,
      })
      .returning();

    await db
      .update(crmLeadsTable)
      .set({ status: "chatting", customerId: customer.id })
      .where(eq(crmLeadsTable.id, lead.id));

    res.status(201).json({ ...customer, leadId: lead.id, customerId: customer.id });
  } catch (err) {
    console.error("POST /fb-inbox/threads/:psid/create-customer error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// === FOLLOW-UP ENDPOINTS ===

// GET /fb-inbox/threads/:psid/follow-up — trạng thái follow-up của lead
router.get("/fb-inbox/threads/:psid/follow-up", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  try {
    const r = await pool.query(
      `SELECT follow_up_count, last_follow_up_at, is_opted_out
       FROM ai_follow_up_logs WHERE psid = $1 LIMIT 1`,
      [psid],
    );
    if (!r.rows.length) return res.json({ count: 0, lastAt: null, optedOut: false, inQueue: false });
    const row = r.rows[0] as { follow_up_count: number; last_follow_up_at: string | null; is_opted_out: boolean };
    const followUpCount = row.follow_up_count ?? 0;

    // Determine max slots from configured script for this lead
    let maxSlots = 3;
    try {
      const leadR2 = await pool.query(
        `SELECT l.current_script_id, l.current_sale_step, s.step_follow_up_slots
         FROM crm_leads l
         LEFT JOIN ai_service_scripts s ON s.id = l.current_script_id
         WHERE l.facebook_user_id = $1 LIMIT 1`,
        [psid],
      );
      const lr = leadR2.rows[0] as {
        current_script_id: number | null;
        current_sale_step: number | null;
        step_follow_up_slots: Record<string, { delayHours: number; messages: string[] }[]> | null;
      } | undefined;
      if (lr?.step_follow_up_slots && lr.current_sale_step) {
        const stepSlots = lr.step_follow_up_slots[String(lr.current_sale_step)];
        if (Array.isArray(stepSlots) && stepSlots.length > 0) maxSlots = stepSlots.length;
      }
    } catch { /* use default */ }

    res.json({
      count: followUpCount,
      lastAt: row.last_follow_up_at ?? null,
      optedOut: !!row.is_opted_out,
      inQueue: !row.is_opted_out && followUpCount < maxSlots,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /fb-inbox/threads/:psid/follow-up/debug — debug slot timing cho production inbox session
router.get("/fb-inbox/threads/:psid/follow-up/debug", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;

  try {
    type FollowUpSlot = { delayHours: number; delayMinutes?: number; messages: string[] };

    // Fetch follow-up log row
    const logR = await pool.query(
      `SELECT follow_up_count, last_follow_up_at, last_follow_up_slot_index, last_customer_message_at, is_opted_out
       FROM ai_follow_up_logs WHERE psid = $1 LIMIT 1`,
      [psid],
    );
    const logRow = logR.rows[0] as {
      follow_up_count: number;
      last_follow_up_at: string | null;
      last_follow_up_slot_index: number | null;
      last_customer_message_at: string | null;
      is_opted_out: boolean;
    } | undefined;

    // Fetch lead info
    const leadR = await pool.query(
      `SELECT current_script_id, current_sale_step, customer_id FROM crm_leads WHERE facebook_user_id = $1 LIMIT 1`,
      [psid],
    );
    const lead = leadR.rows[0] as {
      current_script_id: number | null;
      current_sale_step: number | null;
      customer_id: number | null;
    } | undefined;

    const followUpCount = logRow?.follow_up_count ?? 0;
    const lastCustomerMessageAt = logRow?.last_customer_message_at ?? null;
    const scriptId = lead?.current_script_id ?? null;
    const saleStep = lead?.current_sale_step ?? null;

    let nextFollowUpAt: string | null = null;
    let slotMatchReason: string = "no_script";
    let slotMatched = false;
    let schedulerEnabled = false;

    // Check ENV flag
    const envFlag = (process.env.ENABLE_AI_FOLLOWUP ?? "").toLowerCase();
    schedulerEnabled = envFlag === "true" || envFlag === "1" || envFlag === "yes";

    if (lead?.customer_id) {
      slotMatchReason = "already_converted";
    } else if (logRow?.is_opted_out) {
      slotMatchReason = "opted_out";
    } else if (!scriptId) {
      slotMatchReason = "no_script";
    } else if (!lastCustomerMessageAt) {
      slotMatchReason = "no_customer_message_yet";
    } else {
      try {
        const scr = await pool.query(
          `SELECT step_follow_up_slots FROM ai_service_scripts WHERE id = $1 LIMIT 1`,
          [scriptId],
        );
        const slots = scr.rows[0]?.step_follow_up_slots as Record<string, FollowUpSlot[]> | null;
        const stepKey = saleStep != null ? String(saleStep) : null;
        const slotsForStep: FollowUpSlot[] | null = stepKey && slots ? (slots[stepKey] ?? null) : null;

        if (!slotsForStep || slotsForStep.length === 0) {
          slotMatchReason = "no_slots_configured (legacy mode)";
        } else if (logRow?.last_follow_up_slot_index !== null && logRow?.last_follow_up_slot_index === followUpCount) {
          slotMatchReason = `slot_already_sent (slot=${followUpCount})`;
        } else {
          const nextSlot = slotsForStep[followUpCount];
          if (!nextSlot) {
            slotMatchReason = "all_slots_sent";
          } else {
            const baseTime = new Date(lastCustomerMessageAt).getTime();
            const requiredMinutes = (nextSlot.delayHours ?? 0) * 60 + (nextSlot.delayMinutes ?? 0);
            const delayMs = requiredMinutes * 60 * 1000;
            const fireAt = new Date(baseTime + delayMs);
            nextFollowUpAt = fireAt.toISOString();
            const nowMs = Date.now();
            if (nowMs >= fireAt.getTime()) {
              slotMatched = true;
              slotMatchReason = `ready_to_send (${requiredMinutes}min delay)`;
            } else {
              const secLeft = Math.ceil((fireAt.getTime() - nowMs) / 1000);
              slotMatchReason = `waiting_${secLeft}s (required ${requiredMinutes}min delay)`;
            }
          }
        }
      } catch (e) {
        slotMatchReason = `error: ${String(e).slice(0, 60)}`;
      }
    }

    res.json({
      psid,
      scriptId,
      currentStep: saleStep,
      lastCustomerMessageAt,
      nextFollowUpAt,
      lastFollowUpAt: logRow?.last_follow_up_at ?? null,
      lastFollowUpSlotIndex: logRow?.last_follow_up_slot_index ?? null,
      followUpCount,
      optedOut: !!logRow?.is_opted_out,
      schedulerEnabled,
      slotMatched,
      slotMatchReason,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /fb-inbox/threads/:psid/follow-up/trigger — gửi follow-up thủ công ngay lập tức
router.post("/fb-inbox/threads/:psid/follow-up/trigger", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  const cfg = await getConfig();
  if (!cfg.pageAccessToken) return res.status(400).json({ error: "Chưa cấu hình Page Access Token" });

  try {
    const leadR = await pool.query(
      `SELECT current_script_id, current_sale_step FROM crm_leads WHERE facebook_user_id = $1 LIMIT 1`,
      [psid],
    );
    const lead = leadR.rows[0] as { current_script_id: number | null; current_sale_step: number | null } | undefined;

    let content = "Dạ bạn ơi, mình có thể hỗ trợ thêm gì không ạ? Amazing Studio luôn sẵn sàng giúp bạn ạ 😊";
    if (lead?.current_script_id) {
      type FollowUpSlot = { delayHours: number; messages: string[] };
      const msgR = await pool.query(
        `SELECT follow_up_message, step_follow_up_messages, step_follow_up_slots
         FROM ai_service_scripts s WHERE id = $1 LIMIT 1`,
        [lead.current_script_id],
      );
      const row = msgR.rows[0] as {
        follow_up_message: string | null;
        step_follow_up_messages: Record<string, string> | null;
        step_follow_up_slots: Record<string, FollowUpSlot[]> | null;
      } | undefined;
      const step = lead?.current_sale_step ? String(lead.current_sale_step) : null;

      // Ưu tiên step_follow_up_slots — random từ slot đầu tiên
      const slotsForStep: FollowUpSlot[] | null =
        step && row?.step_follow_up_slots && typeof row.step_follow_up_slots === "object"
          ? (row.step_follow_up_slots as Record<string, FollowUpSlot[]>)[step] ?? null
          : null;

      if (slotsForStep && slotsForStep.length > 0) {
        // Use follow_up_count as slot index for consistency with auto-scheduler
        const logR = await pool.query(
          `SELECT follow_up_count FROM ai_follow_up_logs WHERE psid = $1 LIMIT 1`,
          [psid],
        );
        const slotIndex = (logR.rows[0]?.follow_up_count as number | undefined) ?? 0;
        const slot = slotsForStep[Math.min(slotIndex, slotsForStep.length - 1)];
        const msgs = slot?.messages?.filter(Boolean) ?? [];
        if (msgs.length > 0) {
          content = msgs[Math.floor(Math.random() * msgs.length)];
        }
      } else {
        const stepMsg = row?.step_follow_up_messages && step
          ? row.step_follow_up_messages[step]
          : null;
        if (stepMsg?.trim()) content = stepMsg.trim();
        else if (row?.follow_up_message?.trim()) content = row.follow_up_message.trim();
      }
    }

    await sendFacebookMessage(psid, content, cfg.pageAccessToken);

    await pool.query(
      `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision)
       VALUES ($1, 'outgoing', $2, 'sent', 'auto_follow_up_manual')`,
      [psid, content],
    );

    await pool.query(
      `INSERT INTO ai_follow_up_logs (psid, follow_up_count, last_follow_up_at, last_follow_up_slot_index)
       VALUES ($1, 1, now(), 0)
       ON CONFLICT (psid) DO UPDATE
         SET last_follow_up_slot_index = ai_follow_up_logs.follow_up_count,
             follow_up_count           = ai_follow_up_logs.follow_up_count + 1,
             last_follow_up_at         = now()`,
      [psid],
    );

    res.json({ success: true, message: content });
  } catch (err) {
    console.error("POST follow-up/trigger error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// PATCH /fb-inbox/threads/:psid/follow-up/opt-out — bật/tắt opt-out follow-up cho lead
router.patch("/fb-inbox/threads/:psid/follow-up/opt-out", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const { psid } = req.params;
  const { optedOut } = req.body as { optedOut: boolean };
  try {
    await pool.query(
      `INSERT INTO ai_follow_up_logs (psid, is_opted_out, follow_up_count)
       VALUES ($1, $2, 0)
       ON CONFLICT (psid) DO UPDATE SET is_opted_out = $2`,
      [psid, !!optedOut],
    );
    res.json({ success: true, optedOut: !!optedOut });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
