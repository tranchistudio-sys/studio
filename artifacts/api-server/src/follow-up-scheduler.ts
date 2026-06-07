import { pool } from "@workspace/db";

const DEFAULT_FOLLOW_UP_MSG = "Dạ bạn ơi, mình có thể hỗ trợ thêm gì không ạ? Amazing Studio luôn sẵn sàng giúp bạn ạ 😊";

type FollowUpSlot = { delayHours: number; delayMinutes?: number; messages: string[] };

async function getPageAccessToken(): Promise<string | null> {
  try {
    const r = await pool.query(
      `SELECT value FROM settings WHERE key = 'fb_page_access_token' LIMIT 1`,
    );
    return r.rows[0]?.value ?? process.env.FB_PAGE_ACCESS_TOKEN ?? null;
  } catch {
    return null;
  }
}

async function getAutoReplyEnabled(): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT value FROM settings WHERE key = 'fb_auto_reply_enabled' LIMIT 1`,
    );
    const v = r.rows[0]?.value ?? "";
    return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
  } catch {
    return false;
  }
}

async function sendFbMessage(psid: string, text: string, token: string): Promise<boolean> {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v22.0/me/messages?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: psid },
          message: { text },
          messaging_type: "MESSAGE_TAG",
          tag: "CONFIRMED_EVENT_UPDATE",
        }),
      },
    );
    return r.ok;
  } catch {
    return false;
  }
}

function pickRandom<T>(arr: T[]): T | null {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

type Candidate = {
  psid: string;
  last_customer_message_at: Date;
  follow_up_count: number;
  last_follow_up_at: Date | null;
  last_follow_up_slot_index: number | null;
};

export async function runFollowUpCheck(): Promise<void> {
  const pageToken = await getPageAccessToken();
  const autoReplyEnabled = await getAutoReplyEnabled();

  if (!pageToken || !autoReplyEnabled) {
    return;
  }

  const now = new Date();
  // Fetch candidates silent for at least 1 minute (actual slot timing enforced per-slot below)
  const h1 = new Date(now.getTime() - 1 * 60 * 1000);

  try {
    const candidates = await pool.query<Candidate>(
      `SELECT psid, last_customer_message_at, follow_up_count, last_follow_up_at, last_follow_up_slot_index
       FROM ai_follow_up_logs
       WHERE last_customer_message_at < $1
         AND is_opted_out = false`,
      [h1.toISOString()],
    );

    for (const row of candidates.rows) {
      try {
        await processCandidate(row, pageToken, now);
      } catch (err) {
        console.error(`[FollowUp] Lỗi xử lý psid=${row.psid}:`, err);
      }
    }
  } catch (err) {
    console.error("[FollowUp] Lỗi query candidates:", err);
  }
}

async function processCandidate(
  row: Candidate,
  pageToken: string,
  now: Date,
): Promise<void> {
  const elapsed = now.getTime() - new Date(row.last_customer_message_at).getTime();
  const elapsedMs = elapsed;
  const elapsedH = elapsed / 3600000;

  // Anti-duplicate slot guard: if last_follow_up_slot_index matches follow_up_count, already sent this slot
  if (row.last_follow_up_slot_index !== null && row.last_follow_up_slot_index === row.follow_up_count) {
    console.log(`[FollowUp] skip psid=${row.psid} reason=slot_already_sent slot=${row.follow_up_count}`);
    return;
  }

  const checkAfter = row.last_customer_message_at;

  // Kiểm tra có tin nhắn thủ công (không phải auto follow-up) từ Studio sau checkAfter không
  const outboundCheck = await pool.query(
    `SELECT 1 FROM fb_inbox_messages
     WHERE facebook_user_id = $1
       AND direction = 'outgoing'
       AND created_at > $2
       AND (ai_decision IS NULL OR ai_decision NOT LIKE 'auto_follow_up%')
     LIMIT 1`,
    [row.psid, checkAfter],
  );
  if (outboundCheck.rows.length > 0) return;

  // Kiểm tra đã chốt đơn chưa (customer_id IS NOT NULL)
  const leadCheck = await pool.query(
    `SELECT customer_id, current_script_id, current_sale_step FROM crm_leads WHERE facebook_user_id = $1 LIMIT 1`,
    [row.psid],
  );
  const lead = leadCheck.rows[0] as {
    customer_id: number | null;
    current_script_id: number | null;
    current_sale_step: number | null;
  } | undefined;
  if (lead?.customer_id) return;
  if (lead?.current_script_id == null) return;

  const scriptId = lead.current_script_id;
  const saleStep = lead.current_sale_step ?? null;
  const followUpCount = row.follow_up_count;

  // Fetch slots for this script+step
  let slotsForStep: FollowUpSlot[] | null = null;
  try {
    const scr = await pool.query(
      `SELECT step_follow_up_slots FROM ai_service_scripts WHERE id = $1 LIMIT 1`,
      [scriptId],
    );
    const slots = scr.rows[0]?.step_follow_up_slots as Record<string, FollowUpSlot[]> | null;
    const stepKey = saleStep != null ? String(saleStep) : null;
    slotsForStep = stepKey && slots ? (slots[stepKey] ?? null) : null;
  } catch {
    console.log(`[FollowUp] skip psid=${row.psid} reason=script_fetch_error`);
    return;
  }

  // If no slots configured for step, fall back to legacy 3-follow-up logic
  if (!slotsForStep || slotsForStep.length === 0) {
    await processLegacyCandidate(row, pageToken, now, scriptId, saleStep, elapsedH);
    return;
  }

  // Check if all slots sent
  const slot = slotsForStep[followUpCount];
  if (!slot) {
    console.log(`[FollowUp] skip psid=${row.psid} reason=all_slots_sent followUpCount=${followUpCount} totalSlots=${slotsForStep.length}`);
    return;
  }

  // Check timing: elapsed >= delayHours * 60 + delayMinutes (total minutes)
  const elapsedMinutes = elapsedMs / 60000;
  const requiredMinutes = (slot.delayHours ?? 0) * 60 + (slot.delayMinutes ?? 0);

  if (elapsedMinutes < requiredMinutes) {
    const remainMs = requiredMinutes * 60000 - elapsedMs;
    console.log(
      `[FollowUp] skip psid=${row.psid} reason=not_time_yet slot=${followUpCount} ` +
      `required=${requiredMinutes}min elapsed=${elapsedMinutes.toFixed(2)}min remainSec=${Math.ceil(remainMs / 1000)}`,
    );
    return;
  }

  // Pick a random message from the slot pool — skip (like test scheduler) if pool is empty
  const validMsgs = (slot.messages ?? []).filter(Boolean);
  const chosen = pickRandom(validMsgs);
  if (!chosen) {
    console.log(`[FollowUp] skip psid=${row.psid} reason=empty_message_pool slot=${followUpCount}`);
    return;
  }

  await sendSlotFollowUp(row, pageToken, chosen, saleStep, followUpCount, requiredMinutes, elapsedMinutes);
}

async function sendSlotFollowUp(
  row: Candidate,
  pageToken: string,
  content: string,
  saleStep: number | null,
  followUpCount: number,
  requiredMinutes: number,
  elapsedMinutes: number,
): Promise<void> {
  const psid = row.psid;
  const origLastFollowUpSlotIndex = row.last_follow_up_slot_index; // preserved for rollback
  const origLastFollowUpAt = row.last_follow_up_at ? new Date(row.last_follow_up_at).toISOString() : null; // preserved for rollback
  const expectedLastCustomerMsgAt = new Date(row.last_customer_message_at).toISOString();
  const now = new Date().toISOString();
  const decision = `auto_follow_up_step${saleStep ?? 0}_slot${followUpCount}`;

  // ── Step 1: Claim the slot in DB BEFORE sending FB message ──────────────────
  // This prevents duplicate sends when multiple scheduler workers race.
  // Guard: follow_up_count + slot_index + ms-truncated timestamp to avoid sending
  // if a customer replied after our scheduler read.
  // Note: date_trunc('milliseconds',...) on the DB side handles microsecond→ms precision
  // loss that occurs when Postgres timestamps are round-tripped through JS Date objects.
  const client = await pool.connect();
  let claimed = false;
  try {
    await client.query("BEGIN");

    const updateResult = await client.query(
      `UPDATE ai_follow_up_logs
       SET follow_up_count           = $1,
           last_follow_up_at         = $2,
           last_follow_up_slot_index = $3
       WHERE psid = $4
         AND follow_up_count = $5
         AND (last_follow_up_slot_index IS NULL OR last_follow_up_slot_index < $3)
         AND date_trunc('milliseconds', last_customer_message_at) = date_trunc('milliseconds', $6::timestamptz)`,
      [
        followUpCount + 1,
        now,
        followUpCount,
        psid,
        followUpCount,
        expectedLastCustomerMsgAt,
      ],
    );

    if ((updateResult.rowCount ?? 0) === 0) {
      // State changed between read and this claim — diagnose reason
      const freshR = await client.query<{ last_customer_message_at: string | null; follow_up_count: number }>(
        `SELECT last_customer_message_at, follow_up_count FROM ai_follow_up_logs WHERE psid = $1`,
        [psid],
      );
      const fresh = freshR.rows[0];
      const freshMsAt = fresh?.last_customer_message_at
        ? new Date(fresh.last_customer_message_at).getTime()
        : null;
      const origMsAt = new Date(expectedLastCustomerMsgAt).getTime();
      if (freshMsAt !== null && freshMsAt !== origMsAt) {
        console.log(`[FollowUp] skip psid=${psid} reason=customer_replied_after slot=${followUpCount}`);
      } else {
        console.warn(`[FollowUp] skip psid=${psid} reason=concurrent_update slot=${followUpCount} followUpCount=${fresh?.follow_up_count}`);
      }
      await client.query("ROLLBACK");
      return;
    }

    await client.query("COMMIT");
    claimed = true;
  } catch (err) {
    if (!claimed) await client.query("ROLLBACK").catch(() => {});
    console.error(`[FollowUp] Lỗi claim transaction psid=${psid}:`, err);
    return;
  } finally {
    client.release();
  }

  // ── Step 2: Send FB message (slot is now claimed — no other worker will send) ─
  const ok = await sendFbMessage(psid, content, pageToken);
  if (!ok) {
    // Slot is claimed but FB send failed (transient error). Roll back the claim
    // so the scheduler can retry on the next cycle.
    // Restore original last_follow_up_slot_index (pre-claim) for diagnostic accuracy.
    try {
      await pool.query(
        `UPDATE ai_follow_up_logs
         SET follow_up_count           = $1,
             last_follow_up_at         = $2,
             last_follow_up_slot_index = $3
         WHERE psid = $4 AND follow_up_count = $5`,
        [followUpCount, origLastFollowUpAt, origLastFollowUpSlotIndex ?? null, psid, followUpCount + 1],
      );
    } catch (rollbackErr) {
      console.error(`[FollowUp] Lỗi rollback claim psid=${psid}:`, rollbackErr);
    }
    console.warn(`[FollowUp] ✗ psid=${psid} gửi FB thất bại (step=${saleStep}, slot=${followUpCount}) — claim đã hoàn tác để thử lại`);
    return;
  }

  // ── Step 3: Record the message in inbox history ──────────────────────────────
  try {
    await pool.query(
      `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision)
       VALUES ($1, 'outgoing', $2, 'sent', $3)`,
      [psid, content, decision],
    );
  } catch (err) {
    console.error(`[FollowUp] Lỗi ghi fb_inbox_messages psid=${psid}:`, err);
  }

  console.log(
    `[FollowUp] ✓ psid=${psid} follow_up #${followUpCount + 1} gửi thành công ` +
    `(step=${saleStep}, slot_idx=${followUpCount}, required=${requiredMinutes}min elapsed=${elapsedMinutes.toFixed(2)}min)`,
  );
}

// ── Legacy fallback: fixed 24/48/72h timing without slot config ───────────────
async function processLegacyCandidate(
  row: Candidate,
  pageToken: string,
  now: Date,
  scriptId: number,
  saleStep: number | null,
  elapsedH: number,
): Promise<void> {
  const followUpCount = row.follow_up_count;
  const LEGACY_DELAY_HOURS: Record<number, number> = { 0: 24, 1: 48, 2: 72 };
  const requiredH = LEGACY_DELAY_HOURS[followUpCount] ?? 72;

  if (elapsedH < requiredH) return;
  if (followUpCount >= 3) return;

  // Resolve legacy content
  let content = DEFAULT_FOLLOW_UP_MSG;
  try {
    const scriptR = await pool.query(
      `SELECT follow_up_message, step_follow_up_messages FROM ai_service_scripts WHERE id = $1 LIMIT 1`,
      [scriptId],
    );
    const srow = scriptR.rows[0] as {
      follow_up_message?: string | null;
      step_follow_up_messages?: Record<string, string> | null;
    } | undefined;
    if (srow) {
      const stepKey = saleStep ? String(saleStep) : null;
      // Fallback chain: step-specific → global follow_up_message → step7 content → default
      const stepSpecificMsg = stepKey && srow.step_follow_up_messages
        ? (srow.step_follow_up_messages as Record<string, string>)[stepKey]?.trim()
        : null;
      if (stepSpecificMsg) {
        content = stepSpecificMsg;
      } else if (srow.follow_up_message?.trim()) {
        content = srow.follow_up_message.trim();
      } else {
        const stepR = await pool.query(
          `SELECT content FROM ai_script_steps WHERE script_id = $1 AND step = 7 LIMIT 1`,
          [scriptId],
        );
        const step7 = (stepR.rows[0] as { content?: string } | undefined)?.content?.trim();
        if (step7) content = step7;
      }
    }
  } catch { /* use default */ }

  // Atomic claim before FB send (mirrors slot mode for consistent anti-race behavior)
  const psid = row.psid;
  const expectedLastCustomerMsgAt = new Date(row.last_customer_message_at).toISOString();
  const origLastFollowUpAt = row.last_follow_up_at ? new Date(row.last_follow_up_at).toISOString() : null;
  const nowStr = now.toISOString();

  const client = await pool.connect();
  let claimed = false;
  try {
    await client.query("BEGIN");
    const claimResult = await client.query(
      `UPDATE ai_follow_up_logs
       SET follow_up_count = $1, last_follow_up_at = $2
       WHERE psid = $3
         AND follow_up_count = $4
         AND date_trunc('milliseconds', last_customer_message_at) = date_trunc('milliseconds', $5::timestamptz)`,
      [followUpCount + 1, nowStr, psid, followUpCount, expectedLastCustomerMsgAt],
    );
    if ((claimResult.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      console.log(`[FollowUp/Legacy] skip psid=${psid} reason=concurrent_update followUpCount=${followUpCount}`);
      return;
    }
    await client.query("COMMIT");
    claimed = true;
  } catch (err) {
    if (!claimed) await client.query("ROLLBACK").catch(() => {});
    console.error(`[FollowUp/Legacy] Lỗi claim psid=${psid}:`, err);
    return;
  } finally {
    client.release();
  }

  const ok = await sendFbMessage(psid, content, pageToken);
  if (!ok) {
    // Rollback claim on send failure so next cycle can retry
    try {
      await pool.query(
        `UPDATE ai_follow_up_logs SET follow_up_count = $1, last_follow_up_at = $2 WHERE psid = $3 AND follow_up_count = $4`,
        [followUpCount, origLastFollowUpAt, psid, followUpCount + 1],
      );
    } catch (rollbackErr) {
      console.error(`[FollowUp/Legacy] Lỗi rollback claim psid=${psid}:`, rollbackErr);
    }
    console.warn(`[FollowUp/Legacy] ✗ psid=${psid} gửi thất bại — claim đã hoàn tác`);
    return;
  }

  try {
    await pool.query(
      `INSERT INTO fb_inbox_messages (facebook_user_id, direction, message, sent_status, ai_decision)
       VALUES ($1, 'outgoing', $2, 'sent', 'auto_follow_up')`,
      [psid, content],
    );
  } catch (err) {
    console.error(`[FollowUp/Legacy] Lỗi ghi fb_inbox_messages psid=${psid}:`, err);
  }

  console.log(
    `[FollowUp/Legacy] ✓ psid=${psid} follow_up #${followUpCount + 1} gửi thành công (step=${saleStep}, legacyDelayH=${requiredH})`,
  );
}

export function startFollowUpScheduler(): void {
  const enabled = (process.env.ENABLE_AI_FOLLOWUP ?? "").toLowerCase();
  if (enabled !== "true" && enabled !== "1" && enabled !== "yes") {
    console.log("[FollowUp] Scheduler tắt (ENABLE_AI_FOLLOWUP không được bật) — set ENABLE_AI_FOLLOWUP=true để kích hoạt");
    return;
  }

  const rawSec = parseInt(process.env.AI_FOLLOWUP_INTERVAL_SEC ?? "", 10);
  const intervalSec = isNaN(rawSec) || rawSec < 60 ? 20 * 60 : rawSec; // default 20 min; min 60s
  const intervalMs = intervalSec * 1000;

  console.log(`[FollowUp] Scheduler khởi động — poll mỗi ${Math.round(intervalSec / 60)}min`);

  const run = () => {
    runFollowUpCheck().catch((err) => console.error("[FollowUp] Lỗi scheduler:", err));
  };

  setTimeout(() => {
    run();
    setInterval(run, intervalMs);
  }, 30 * 1000);
}
