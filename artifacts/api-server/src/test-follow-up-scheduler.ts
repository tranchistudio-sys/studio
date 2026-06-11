import { pool } from "@workspace/db";
import { emitTestSessionEvent } from "./lib/test-sse";

type FollowUpSlot = { delayHours: number; delayMinutes?: number; messages: string[] };

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pickRandom<T>(arr: T[]): T | null {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

type TestSessionCandidate = {
  id: string;
  current_script_id: number | null;
  current_sale_step: number | null;
  last_customer_message_at: Date;
  follow_up_count: number;
  last_follow_up_slot_index: number | null;
};

async function runTestFollowUpCheck(): Promise<void> {
  const now = new Date();

  // Fetch sessions that have a customer message and a script assigned.
  // No minimum silence filter here — each slot defines its own delay.
  let candidates: TestSessionCandidate[];
  try {
    const r = await pool.query<TestSessionCandidate>(
      `SELECT id, current_script_id, current_sale_step, last_customer_message_at, follow_up_count, last_follow_up_slot_index
       FROM ai_test_sessions
       WHERE last_customer_message_at IS NOT NULL
         AND current_script_id IS NOT NULL`,
    );
    candidates = r.rows;
  } catch (err) {
    console.error("[TestFollowUp] Lỗi query sessions:", err);
    return;
  }

  for (const session of candidates) {
    try {
      await processTestSession(session, now);
    } catch (err) {
      console.error(`[TestFollowUp] Lỗi xử lý session=${session.id}:`, err);
    }
  }
}

async function processTestSession(
  session: TestSessionCandidate,
  now: Date,
): Promise<void> {
  const scriptId = session.current_script_id!;
  const saleStep = session.current_sale_step;
  const followUpCount = session.follow_up_count;
  const sessionId = session.id;

  // Fetch step_follow_up_slots for this script
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
    console.log(`[TestFollowUp] skip session=${sessionId} reason=script_fetch_error`);
    return;
  }

  if (!slotsForStep || slotsForStep.length === 0) {
    // Only log if followUpCount is 0 (first check) to avoid spam
    if (followUpCount === 0) {
      console.log(`[TestFollowUp] skip session=${sessionId} reason=no_slots_for_step step=${saleStep}`);
    }
    return;
  }

  // Get the slot at current follow_up_count index
  const slot = slotsForStep[followUpCount];
  if (!slot) {
    console.log(`[TestFollowUp] skip session=${sessionId} reason=all_slots_sent followUpCount=${followUpCount} totalSlots=${slotsForStep.length}`);
    return;
  }

  // Anti-duplicate guard (in-memory, before DB): if last_follow_up_slot_index equals followUpCount, already sent this slot
  if (session.last_follow_up_slot_index !== null && session.last_follow_up_slot_index === followUpCount) {
    console.log(`[TestFollowUp] skip session=${sessionId} reason=slot_already_sent slot=${followUpCount} last_slot_index=${session.last_follow_up_slot_index}`);
    return;
  }

  // Check timing: elapsed >= delayHours * 60 + delayMinutes (total minutes)
  const elapsedMs = now.getTime() - new Date(session.last_customer_message_at).getTime();
  const elapsedMinutes = elapsedMs / 60000;
  const requiredMinutes = (slot.delayHours ?? 0) * 60 + (slot.delayMinutes ?? 0);

  if (elapsedMinutes < requiredMinutes) {
    const remainMs = requiredMinutes * 60000 - elapsedMs;
    console.log(
      `[TestFollowUp] skip session=${sessionId} reason=not_time_yet slot=${followUpCount} ` +
      `required=${requiredMinutes}min elapsed=${elapsedMinutes.toFixed(2)}min remainSec=${Math.ceil(remainMs / 1000)}`,
    );
    return;
  }

  // Pick a random message from the slot pool
  const validMsgs = (slot.messages ?? []).filter(Boolean);
  const chosen = pickRandom(validMsgs);
  if (!chosen) {
    console.log(`[TestFollowUp] skip session=${sessionId} reason=empty_message_pool slot=${followUpCount}`);
    return;
  }

  const msgId = genId();
  const msgAt = now.toISOString();
  const decision = `auto_follow_up_step${saleStep ?? 0}_slot${followUpCount}`;
  const debugJson = {
    slotIndex: followUpCount,
    delayHours: slot.delayHours ?? 0,
    delayMinutes: slot.delayMinutes ?? 0,
    requiredMinutes,
    elapsedMinutes: Math.round(elapsedMinutes * 100) / 100,
    messagesPool: validMsgs,
    chosen,
  };

  // Atomic send via DB transaction:
  // Inside one transaction: conditional UPDATE (3-clause guard) + message INSERT
  // If the UPDATE doesn't match, ROLLBACK — no message is ever orphaned
  const expectedLastCustomerMsgAt = new Date(session.last_customer_message_at).toISOString();

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");

    const updateResult = await client.query(
      `UPDATE ai_test_sessions
       SET follow_up_count           = $1,
           last_follow_up_at         = $2,
           last_follow_up_step       = $3,
           last_follow_up_slot_index = $4,
           message_count             = message_count + 1,
           last_message_at           = $2,
           last_message_preview      = $5,
           updated_at                = now()
       WHERE id = $6
         AND follow_up_count = $7
         AND (last_follow_up_slot_index IS NULL OR last_follow_up_slot_index < $4)
         AND last_customer_message_at = $8`,
      // Guard 1: expected count  Guard 2: slot not yet sent  Guard 3: customer hasn't replied
      [
        followUpCount + 1,
        msgAt,
        saleStep,
        followUpCount,
        `Bot: ${chosen.slice(0, 80)}${chosen.length > 80 ? "…" : ""}`,
        sessionId,
        followUpCount,
        expectedLastCustomerMsgAt,
      ],
    );

    if ((updateResult.rowCount ?? 0) === 0) {
      // Session changed between read and update — determine reason before rolling back
      const freshR = await client.query<{ last_customer_message_at: string | null; follow_up_count: number }>(
        `SELECT last_customer_message_at, follow_up_count FROM ai_test_sessions WHERE id = $1`,
        [sessionId],
      );
      const fresh = freshR.rows[0];
      if (fresh && fresh.last_customer_message_at !== expectedLastCustomerMsgAt) {
        console.log(`[TestFollowUp] skip session=${sessionId} reason=customer_replied_after slot=${followUpCount}`);
      } else {
        console.warn(`[TestFollowUp] skip session=${sessionId} reason=concurrent_update slot=${followUpCount} followUpCount=${fresh?.follow_up_count}`);
      }
      await client.query("ROLLBACK");
      return;
    }

    // Session claimed — insert follow-up message in same transaction
    await client.query(
      `INSERT INTO ai_test_messages (id, session_id, role, text, type, decision, current_step, debug_json, created_at)
       VALUES ($1, $2, 'bot', $3, 'follow_up_auto', $4, $5, $6, $7)`,
      [msgId, sessionId, chosen, decision, saleStep, JSON.stringify(debugJson), msgAt],
    );

    await client.query("COMMIT");
    committed = true;
  } catch (err) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    console.error(`[TestFollowUp] Lỗi transaction session=${sessionId}:`, err);
    return;
  } finally {
    client.release();
  }

  console.log(
    `[TestFollowUp] ✓ session=${sessionId} follow_up #${followUpCount + 1} ` +
    `step=${saleStep} slot=${followUpCount} required=${requiredMinutes}min elapsed=${elapsedMinutes.toFixed(2)}min`,
  );

  // Push SSE event to any listening browser clients immediately
  emitTestSessionEvent(sessionId, {
    type: "follow_up",
    sessionId,
    message: {
      id: msgId,
      role: "bot",
      text: chosen,
      type: "follow_up_auto",
      decision,
      currentStep: saleStep,
      createdAt: msgAt,
    },
  });
}

export function startTestFollowUpScheduler(): void {
  const enabled = (process.env.ENABLE_AI_TEST_FOLLOWUP ?? "").toLowerCase();
  if (enabled !== "true" && enabled !== "1" && enabled !== "yes") {
    console.log("[TestFollowUp] Scheduler tắt (ENABLE_AI_TEST_FOLLOWUP không được bật)");
    return;
  }

  const rawSec = parseInt(process.env.AI_TEST_FOLLOWUP_INTERVAL_SEC ?? "", 10);
  const intervalSec = isNaN(rawSec) || rawSec < 10 ? 30 : rawSec; // NaN-safe; min 10s
  const intervalMs = intervalSec * 1000;

  console.log(`[TestFollowUp] Scheduler khởi động — poll mỗi ${intervalSec}s`);

  const run = () => {
    runTestFollowUpCheck().catch((err) => console.error("[TestFollowUp] Lỗi scheduler:", err));
  };

  // Small delay before first run
  setTimeout(() => {
    run();
    setInterval(run, intervalMs);
  }, 5000);
}
