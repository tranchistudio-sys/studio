import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import {
  splitIntoChunks,
  loadQaRows,
  matchQaRow,
  loadSaleScripts,
  askChatGptForReply,
  getOpenAiKey,
  loadScriptSettings,
} from "./ai-engine";
import { subscribeTestSession } from "../lib/test-sse";

const router: IRouter = Router();

// ─── Auth Helpers ────────────────────────────────────────────────────────────

async function getCaller(req: import("express").Request) {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return null;
  const r = await pool.query(`SELECT id, role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = r.rows[0] as { id: number; role?: string; roles?: string[] } | undefined;
  return caller ?? null;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type TestMessageRow = {
  id: string;
  session_id: string;
  role: "user" | "bot";
  text: string;
  type: string | null;
  decision: string | null;
  current_step: number | null;
  debug_json: unknown;
  created_at: string;
};

type TestSessionRow = {
  id: string;
  name: string;
  customer_name: string;
  script_id: number | null;
  current_script_id: number | null;
  current_sale_step: number | null;
  script_updated_at: string | null;
  last_customer_message_at: string | null;
  follow_up_count: number;
  last_follow_up_at: string | null;
  last_follow_up_step: number | null;
  last_follow_up_slot_index: number | null;
  message_count: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function toTestMessage(row: TestMessageRow) {
  // Extract per-message debug metadata (source/score for chip display)
  let source: string | undefined;
  let score: number | undefined;
  if (row.debug_json && typeof row.debug_json === "object") {
    const d = row.debug_json as Record<string, unknown>;
    if (d.source) source = String(d.source);
    if (d.score != null) score = Number(d.score);
  }
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    type: row.type ?? "text",
    decision: row.decision ?? undefined,
    currentStep: row.current_step ?? undefined,
    source,
    score,
    createdAt: typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString(),
  };
}

function toSessionSummary(s: TestSessionRow) {
  return {
    id: s.id,
    name: s.name,
    customerName: s.customer_name,
    scriptId: s.script_id,
    currentScriptId: s.current_script_id,
    currentSaleStep: s.current_sale_step,
    scriptUpdatedAt: s.script_updated_at,
    messageCount: s.message_count,
    lastMessagePreview: s.last_message_preview,
    lastMessageAt: s.last_message_at,
    createdAt: typeof s.created_at === "string" ? s.created_at : new Date(s.created_at).toISOString(),
  };
}

async function bumpSessionAfterMessage(
  sessionId: string,
  preview: string,
  role: "user" | "bot",
  messageAt: string,
) {
  const label = role === "user" ? "Bạn: " : "Bot: ";
  const text = label + preview.slice(0, 80) + (preview.length > 80 ? "…" : "");
  await pool.query(
    `UPDATE ai_test_sessions
     SET message_count = message_count + 1,
         last_message_preview = $1,
         last_message_at = $2,
         updated_at = now()
     WHERE id = $3`,
    [text, messageAt, sessionId],
  );
}

// ─── POST /ai-test/sessions ──────────────────────────────────────────────────

router.post("/ai-test/sessions", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const { customerName, scriptId, name } = req.body as {
    customerName?: string;
    scriptId?: number | null;
    name?: string;
  };

  const id = genId();
  const sessionName = name?.trim() || `Cuộc test ${new Date().toLocaleString("vi-VN")}`;
  const custName = customerName?.trim() || "Khách Test";

  // Look up script updated_at for version tracking
  let scriptUpdatedAt: string | null = null;
  if (scriptId) {
    try {
      const sr = await pool.query(
        `SELECT updated_at FROM ai_service_scripts WHERE id = $1 LIMIT 1`,
        [scriptId],
      );
      scriptUpdatedAt = sr.rows[0]?.updated_at ? new Date(sr.rows[0].updated_at).toISOString() : null;
    } catch { /* ignore */ }
  }

  await pool.query(
    `INSERT INTO ai_test_sessions
       (id, name, customer_name, script_id, current_script_id, current_sale_step, script_updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5)`,
    [id, sessionName, custName, scriptId ?? null, scriptUpdatedAt],
  );

  const r = await pool.query<TestSessionRow>(`SELECT * FROM ai_test_sessions WHERE id = $1`, [id]);
  res.status(201).json(toSessionSummary(r.rows[0]));
});

// ─── GET /ai-test/sessions ───────────────────────────────────────────────────

router.get("/ai-test/sessions", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const r = await pool.query<TestSessionRow>(
    `SELECT * FROM ai_test_sessions ORDER BY updated_at DESC`,
  );
  res.json(r.rows.map(toSessionSummary));
});

// ─── DELETE /ai-test/sessions/:id ───────────────────────────────────────────

router.delete("/ai-test/sessions/:id", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const { id } = req.params;
  const r = await pool.query(`DELETE FROM ai_test_sessions WHERE id = $1 RETURNING id`, [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Không tìm thấy session" });
  res.json({ success: true });
});

// ─── GET /ai-test/sessions/:id/messages ─────────────────────────────────────

router.get("/ai-test/sessions/:id/messages", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const sr = await pool.query(`SELECT id FROM ai_test_sessions WHERE id = $1`, [req.params.id]);
  if (sr.rowCount === 0) return res.status(404).json({ error: "Không tìm thấy session" });

  const mr = await pool.query<TestMessageRow>(
    `SELECT * FROM ai_test_messages WHERE session_id = $1 ORDER BY created_at ASC`,
    [req.params.id],
  );
  res.json({ messages: mr.rows.map(toTestMessage) });
});

// ─── GET /ai-test/sessions/:id/debug ────────────────────────────────────────

router.get("/ai-test/sessions/:id/debug", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const sr = await pool.query<TestSessionRow>(`SELECT * FROM ai_test_sessions WHERE id = $1`, [req.params.id]);
  if (sr.rowCount === 0) return res.status(404).json({ error: "Không tìm thấy session" });
  const session = sr.rows[0];

  type FollowUpSlot = { delayHours: number; delayMinutes?: number; messages: string[] };

  // Compute nextFollowUpAt
  let nextFollowUpAt: string | null = null;
  let slotMatchReason: string = "no_script";
  let slotMatched = false;

  if (session.current_script_id && session.last_customer_message_at) {
    try {
      const scr = await pool.query(
        `SELECT step_follow_up_slots FROM ai_service_scripts WHERE id = $1 LIMIT 1`,
        [session.current_script_id],
      );
      const slots = scr.rows[0]?.step_follow_up_slots as Record<string, FollowUpSlot[]> | null;
      const stepKey = session.current_sale_step != null ? String(session.current_sale_step) : null;
      const slotsForStep: FollowUpSlot[] | null = stepKey && slots ? (slots[stepKey] ?? null) : null;

      if (!slotsForStep || slotsForStep.length === 0) {
        slotMatchReason = "no_slots_configured";
      } else {
        const nextSlot = slotsForStep[session.follow_up_count];
        if (!nextSlot) {
          slotMatchReason = "all_slots_sent";
        } else {
          const baseTime = new Date(session.last_customer_message_at).getTime();
          // Use delayHours + delayMinutes for accurate ms calculation
          const requiredMinutes = (nextSlot.delayHours ?? 0) * 60 + (nextSlot.delayMinutes ?? 0);
          const delayMs = requiredMinutes * 60 * 1000;
          const fireAt = new Date(baseTime + delayMs);
          nextFollowUpAt = fireAt.toISOString();
          const now = Date.now();
          if (now >= fireAt.getTime()) {
            slotMatched = true;
            slotMatchReason = `ready_to_send (${requiredMinutes}min delay)`;
          } else {
            const secLeft = Math.ceil((fireAt.getTime() - now) / 1000);
            slotMatchReason = `waiting_${secLeft}s (required ${requiredMinutes}min delay)`;
          }
        }
      }
    } catch (e) {
      slotMatchReason = `error: ${String(e).slice(0, 60)}`;
    }
  } else if (!session.current_script_id) {
    slotMatchReason = "no_script";
  } else {
    slotMatchReason = "no_customer_message_yet";
  }

  res.json({
    sessionId: session.id,
    currentStep: session.current_sale_step,
    scriptId: session.current_script_id,
    scriptUpdatedAt: session.script_updated_at,
    lastCustomerMessageAt: session.last_customer_message_at,
    nextFollowUpAt,
    lastFollowUpAt: session.last_follow_up_at,
    lastFollowUpStep: session.last_follow_up_step,
    lastFollowUpSlotIndex: session.last_follow_up_slot_index,
    followUpCount: session.follow_up_count,
    slotMatched,
    slotMatchReason,
  });
});

// ─── GET /ai-test/sessions/:id/events (SSE) ─────────────────────────────────

router.get("/ai-test/sessions/:id/events", async (req, res) => {
  const tokenFromQuery = req.query.token ? `Bearer ${req.query.token}` : undefined;
  const callerId = verifyToken(req.headers.authorization ?? tokenFromQuery);
  if (!callerId) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const sessionId = req.params.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`);

  const unsubscribe = subscribeTestSession(sessionId, res);

  const keepAlive = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
    } catch {
      clearInterval(keepAlive);
    }
  }, 25000);

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
});

// ─── POST /ai-test/sessions/:id/message ─────────────────────────────────────

router.post("/ai-test/sessions/:id/message", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const sr = await pool.query<TestSessionRow>(`SELECT * FROM ai_test_sessions WHERE id = $1`, [req.params.id]);
  if (sr.rowCount === 0) return res.status(404).json({ error: "Không tìm thấy session" });
  const session = sr.rows[0];

  const { text, saveUnknown } = req.body as { text?: string; saveUnknown?: boolean };
  if (!text?.trim()) return res.status(400).json({ error: "Thiếu nội dung tin nhắn" });

  const apiKey = await getOpenAiKey();
  if (!apiKey) return res.status(400).json({ error: "Chưa cấu hình OpenAI API key trong hệ thống" });

  const settings = await loadScriptSettings(session.current_script_id);

  // Insert user message first
  const userMsgId = genId();
  const userMsgAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO ai_test_messages (id, session_id, role, text, type, created_at) VALUES ($1, $2, 'user', $3, 'text', $4)`,
    [userMsgId, session.id, text.trim(), userMsgAt],
  );

  // Reset follow-up state — customer replied
  await pool.query(
    `UPDATE ai_test_sessions
     SET last_customer_message_at = $1,
         follow_up_count          = 0,
         last_follow_up_at        = NULL,
         last_follow_up_step      = NULL,
         last_follow_up_slot_index = NULL,
         updated_at               = now()
     WHERE id = $2`,
    [userMsgAt, session.id],
  );
  await bumpSessionAfterMessage(session.id, text.trim(), "user", userMsgAt);

  // Load history for GPT
  const histR = await pool.query<TestMessageRow>(
    `SELECT * FROM ai_test_messages WHERE session_id = $1 ORDER BY created_at ASC`,
    [session.id],
  );
  const allHistory = histR.rows.map(toTestMessage);
  const history = allHistory
    .filter((m) => m.role === "user" || m.role === "bot")
    .slice(-20)
    .map((m) => ({ direction: (m.role === "user" ? "incoming" : "outgoing") as "incoming" | "outgoing", message: m.text }));

  let decision = "gpt";
  let scriptId: number | null = session.current_script_id;
  let step: number | null = session.current_sale_step;
  let rawGptResponse: string | null = null;
  let chunks: string[] = [];
  let qaMatch: { matched: boolean; rowId: number | null; score: number } = { matched: false, rowId: null, score: 0 };
  let isOutOfScope = false;
  let shouldHandoff = false;
  const botMessages: string[] = [];
  const botImageUrls: string[] = [];
  let sendPriceImages = false;
  let sendPriceTextAfterImage = true;
  let bestScore = 0;

  const shouldSaveUnknown = saveUnknown !== undefined ? saveUnknown : settings.saveUnknownQuestions;

  try {
    if (!settings.forceGptOnly) {
      const qaRows = await loadQaRows();
      const { row: bestRow, score: _bestScore } = matchQaRow(text.trim(), qaRows);
      bestScore = _bestScore;

      if (bestRow && bestRow.answer?.trim()) {
        decision = `qa_matched:${bestRow.id}`;
        qaMatch = { matched: true, rowId: bestRow.id, score: bestScore };
        chunks = splitIntoChunks(bestRow.answer.trim(), settings);
        botMessages.push(...chunks);
      }
    }

    if (botMessages.length === 0 && !settings.forceQaOnly) {
      const scripts = await loadSaleScripts();
      const scriptForSession = session.script_id
        ? scripts.find((s) => s.id === session.script_id) ?? null
        : null;

      const ai = await askChatGptForReply({
        apiKey,
        customerMessage: text.trim(),
        customerName: session.customer_name,
        history: history.slice(0, -1),
        currentScriptId: scriptForSession ? scriptForSession.id : session.current_script_id,
        currentSaleStep: session.current_sale_step,
        settings,
      });

      rawGptResponse = JSON.stringify({
        scriptId: ai.scriptId,
        step: ai.step,
        messages: ai.messages,
        reason: ai.reason,
        isOutOfScope: ai.isOutOfScope,
        shouldHandoff: ai.shouldHandoff,
        usedFallback: ai.usedFallback,
      });

      isOutOfScope = ai.isOutOfScope;
      shouldHandoff = ai.shouldHandoff;

      if (ai.isOutOfScope || ai.shouldHandoff || ai.messages.length === 0) {
        decision = "unknown_question";
        const msgs = settings.fallbackMessages.length > 0 ? settings.fallbackMessages : [
          "Dạ bạn chờ em xíu nha, em kiểm tra lại cho mình ạ",
        ];
        const waitMsg = msgs[Math.floor(Math.random() * msgs.length)];
        chunks = [waitMsg];
        botMessages.push(waitMsg);

        if (shouldSaveUnknown && text.trim()) {
          try {
            await pool.query(
              `INSERT INTO ai_unknown_questions (script_id, step, question_text, psid, status)
               VALUES ($1, $2, $3, $4, 'pending')`,
              [ai.scriptId ?? null, ai.step ?? null, text.trim(), `test_session_${session.id}`],
            );
          } catch (err) {
            console.error("[AI-Test] lưu unknown_question lỗi:", err);
          }
        }
      } else {
        decision = ai.usedFallback ? "gpt_fallback" : `auto_replied_step${ai.step ?? 0}`;
        sendPriceImages = ai.sendPriceImages ?? false;
        sendPriceTextAfterImage = ai.sendPriceTextAfterImage ?? true;
        if (sendPriceImages && ai.priceImages.length > 0) {
          botImageUrls.push(...ai.priceImages);
        }
        for (const msg of ai.messages) {
          if (!msg.trim()) continue;
          chunks.push(...splitIntoChunks(msg, settings));
        }
        if (!sendPriceImages || sendPriceTextAfterImage) {
          botMessages.push(...chunks);
        }
        scriptId = ai.scriptId ?? scriptId;
        step = ai.step ?? step;
      }
    } else if (botMessages.length === 0 && settings.forceQaOnly) {
      decision = "force_qa_no_match";
      const msgs = settings.fallbackMessages.length > 0 ? settings.fallbackMessages : [
        "Dạ bạn chờ em xíu nha, em kiểm tra lại cho mình ạ",
      ];
      const waitMsg = msgs[Math.floor(Math.random() * msgs.length)];
      chunks = [waitMsg];
      botMessages.push(waitMsg);
    }
  } catch (err) {
    console.error("[AI-Test] error:", err);
    decision = `ai_error:${String(err).slice(0, 100)}`;
    const errMsgs = settings.gptErrorMessages.length > 0 ? settings.gptErrorMessages : [
      "Dạ bạn chờ em xíu nha, em kiểm tra lại cho mình ạ",
    ];
    const fallbackMsg = errMsgs[Math.floor(Math.random() * errMsgs.length)];
    chunks = [fallbackMsg];
    botMessages.push(fallbackMsg);
  }

  if (settings.logDecisions) {
    console.log(`[AI-Test] input="${text.trim().slice(0, 80)}" qaMatched=${qaMatch.matched} bestScore=${bestScore.toFixed(2)} decision=${decision}`);
  }

  // Update session script/step
  if (scriptId !== session.current_script_id || step !== session.current_sale_step) {
    await pool.query(
      `UPDATE ai_test_sessions SET current_script_id = $1, current_sale_step = $2, updated_at = now() WHERE id = $3`,
      [scriptId, step, session.id],
    );
  }

  // Per-message debug metadata for chip display (source/score for UI chip)
  const msgDebugJson = JSON.stringify({
    source: qaMatch.matched ? "qa" : "gpt",
    score: Math.round(bestScore * 100) / 100,
    matchedRowId: qaMatch.matched ? qaMatch.rowId : null,
  });

  // Insert bot image messages
  for (const imgUrl of botImageUrls) {
    const msgId = genId();
    const msgAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO ai_test_messages (id, session_id, role, text, type, decision, current_step, debug_json, created_at)
       VALUES ($1, $2, 'bot', $3, 'image', $4, $5, $6, $7)`,
      [msgId, session.id, imgUrl, decision, step, msgDebugJson, msgAt],
    );
    await bumpSessionAfterMessage(session.id, imgUrl, "bot", msgAt);
  }

  // Insert bot text messages
  for (const txt of botMessages) {
    const msgId = genId();
    const msgAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO ai_test_messages (id, session_id, role, text, type, decision, current_step, debug_json, created_at)
       VALUES ($1, $2, 'bot', $3, 'text', $4, $5, $6, $7)`,
      [msgId, session.id, txt, decision, step, msgDebugJson, msgAt],
    );
    await bumpSessionAfterMessage(session.id, txt, "bot", msgAt);
  }

  // Fetch all messages for response
  const finalR = await pool.query<TestMessageRow>(
    `SELECT * FROM ai_test_messages WHERE session_id = $1 ORDER BY created_at ASC`,
    [session.id],
  );

  const scriptName = scriptId
    ? (await loadSaleScripts().catch(() => [])).find((s) => s.id === scriptId)?.name ?? null
    : null;

  res.json({
    messages: finalR.rows.map(toTestMessage),
    debug: {
      decision,
      scriptId,
      scriptName,
      step,
      rawGptResponse,
      chunks,
      qaMatch,
      isOutOfScope,
      shouldHandoff,
      sendPriceImages,
      sendPriceTextAfterImage,
      priceImageCount: botImageUrls.length,
    },
  });
});

// ─── POST /ai-test/sessions/:id/reset ───────────────────────────────────────

router.post("/ai-test/sessions/:id/reset", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const sr = await pool.query<TestSessionRow>(`SELECT * FROM ai_test_sessions WHERE id = $1`, [req.params.id]);
  if (sr.rowCount === 0) return res.status(404).json({ error: "Không tìm thấy session" });
  const session = sr.rows[0];

  const { customerName, scriptId } = req.body as { customerName?: string; scriptId?: number | null };
  const newScriptId = scriptId !== undefined ? (scriptId ?? null) : session.script_id;
  const newCustomerName = customerName?.trim() || session.customer_name;

  // Resolve script_updated_at: clear when script removed, fetch when script changes
  let scriptUpdatedAt: string | null = session.script_updated_at;
  if (scriptId !== undefined && scriptId !== session.script_id) {
    if (scriptId == null) {
      scriptUpdatedAt = null; // script removed — clear version metadata
    } else {
      try {
        const scr = await pool.query(`SELECT updated_at FROM ai_service_scripts WHERE id = $1`, [scriptId]);
        scriptUpdatedAt = scr.rows[0]?.updated_at ? new Date(scr.rows[0].updated_at).toISOString() : null;
      } catch { /* ignore */ }
    }
  }

  // Delete all messages
  await pool.query(`DELETE FROM ai_test_messages WHERE session_id = $1`, [session.id]);

  // Reset session state
  await pool.query(
    `UPDATE ai_test_sessions
     SET customer_name             = $1,
         script_id                 = $2,
         current_script_id         = $2,
         current_sale_step         = NULL,
         script_updated_at         = $3,
         last_customer_message_at  = NULL,
         follow_up_count           = 0,
         last_follow_up_at         = NULL,
         last_follow_up_step       = NULL,
         last_follow_up_slot_index = NULL,
         message_count             = 0,
         last_message_preview      = NULL,
         last_message_at           = NULL,
         updated_at                = now()
     WHERE id = $4`,
    [newCustomerName, newScriptId, scriptUpdatedAt, session.id],
  );

  const updated = await pool.query<TestSessionRow>(`SELECT * FROM ai_test_sessions WHERE id = $1`, [session.id]);
  res.json({ success: true, session: toSessionSummary(updated.rows[0]) });
});

// ─── PATCH /ai-test/sessions/:id ────────────────────────────────────────────

router.patch("/ai-test/sessions/:id", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const sr = await pool.query<TestSessionRow>(`SELECT * FROM ai_test_sessions WHERE id = $1`, [req.params.id]);
  if (sr.rowCount === 0) return res.status(404).json({ error: "Không tìm thấy session" });
  const session = sr.rows[0];

  const { customerName, scriptId, name } = req.body as { customerName?: string; scriptId?: number | null; name?: string };
  const newName = name?.trim() || session.name;
  const newCustomerName = customerName?.trim() || session.customer_name;
  const newScriptId = scriptId !== undefined ? (scriptId ?? null) : session.script_id;

  // Resolve script_updated_at when script changes
  let scriptUpdatedAt: string | null = session.script_updated_at;
  if (scriptId !== undefined && scriptId !== session.script_id) {
    if (scriptId == null) {
      scriptUpdatedAt = null; // script removed
    } else {
      try {
        const scr = await pool.query(`SELECT updated_at FROM ai_service_scripts WHERE id = $1`, [scriptId]);
        scriptUpdatedAt = scr.rows[0]?.updated_at ? new Date(scr.rows[0].updated_at).toISOString() : null;
      } catch { /* ignore */ }
    }
  }

  await pool.query(
    `UPDATE ai_test_sessions SET name = $1, customer_name = $2, script_id = $3, current_script_id = $3, script_updated_at = $4, updated_at = now() WHERE id = $5`,
    [newName, newCustomerName, newScriptId, scriptUpdatedAt, session.id],
  );

  const updated = await pool.query<TestSessionRow>(`SELECT * FROM ai_test_sessions WHERE id = $1`, [session.id]);
  res.json(toSessionSummary(updated.rows[0]));
});

// ─── GET /ai-test/sessions/:id/export ───────────────────────────────────────

router.get("/ai-test/sessions/:id/export", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const sr = await pool.query<TestSessionRow>(`SELECT * FROM ai_test_sessions WHERE id = $1`, [req.params.id]);
  if (sr.rowCount === 0) return res.status(404).json({ error: "Không tìm thấy session" });
  const session = sr.rows[0];

  const mr = await pool.query<TestMessageRow>(
    `SELECT * FROM ai_test_messages WHERE session_id = $1 ORDER BY created_at ASC`,
    [req.params.id],
  );

  let scriptName: string | null = null;
  if (session.script_id) {
    try {
      const scr = await pool.query(`SELECT name FROM ai_service_scripts WHERE id = $1 LIMIT 1`, [session.script_id]);
      scriptName = scr.rows[0]?.name ?? null;
    } catch { /* ignore */ }
  }

  const format = (req.query.format as string | undefined) ?? "json";

  const messages = mr.rows.map(toTestMessage);

  // ── Decision summary aggregates (shared for CSV and JSON) ─────────────────
  const _botMessages = messages.filter((m) => m.role === "bot");
  const aggregates = {
    totalMessages: messages.length,
    qaCount: _botMessages.filter(
      (m) => m.type !== "follow_up_auto" && (m.source === "qa" || (m.decision ?? "").startsWith("qa_matched")),
    ).length,
    gptCount: _botMessages.filter(
      (m) => m.type !== "follow_up_auto" && m.source !== "qa" && !(m.decision ?? "").startsWith("qa_matched"),
    ).length,
    followUpCount: messages.filter((m) => m.type === "follow_up_auto").length,
    stepsReached: [...new Set(
      _botMessages
        .filter((m) => m.type !== "follow_up_auto" && m.currentStep != null)
        .map((m) => m.currentStep as number),
    )].sort((a, b) => a - b),
  };

  if (format === "csv") {
    const escape = (v: unknown): string => {
      let s = v == null ? "" : String(v);
      // Neutralize CSV formula injection: prefix dangerous-leading chars with a tab
      if (/^[=+\-@\t\r]/.test(s)) s = `\t${s}`;
      if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\t")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const { qaCount, gptCount, followUpCount, stepsReached } = aggregates;

    const headerRow = ["Thời gian", "Vai trò", "Loại", "Nội dung", "Quyết định", "Bước sale", "Slot follow-up"].join(",");
    const rows = messages.map((m) => {
      const role = m.role === "user" ? "Khách" : "Bot";
      const type = m.type === "follow_up_auto" ? "Follow-up tự động" : m.type === "image" ? "Ảnh" : "Văn bản";
      let decisionDisplay = m.decision ?? "";
      if (m.type === "follow_up_auto" && m.decision) {
        const match = m.decision.match(/step(\d+)_slot(\d+)/);
        if (match) decisionDisplay = `Follow-up Bước ${match[1]} Slot ${Number(match[2]) + 1}`;
      }
      let slotDisplay = "";
      if (m.type === "follow_up_auto" && m.decision) {
        const match = m.decision.match(/slot(\d+)/);
        if (match) slotDisplay = `Slot ${Number(match[1]) + 1}`;
      }
      return [
        escape(new Date(m.createdAt).toLocaleString("vi-VN")),
        escape(role),
        escape(type),
        escape(m.text),
        escape(decisionDisplay),
        escape(m.currentStep != null ? `Bước ${m.currentStep}` : ""),
        escape(slotDisplay),
      ].join(",");
    });

    const scriptVersion = session.script_updated_at
      ? ` (v.${new Date(session.script_updated_at).toLocaleDateString("vi-VN")})`
      : "";

    const metaRows = [
      `# Phiên test: ${session.name}`,
      `# Khách: ${session.customer_name}`,
      `# Kịch bản: ${scriptName ?? "(Không có)"}${scriptVersion}`,
      `# Thời gian tạo: ${new Date(session.created_at).toLocaleString("vi-VN")}`,
      `# --- Tóm tắt quyết định ---`,
      `# Tổng tin nhắn: ${messages.length}`,
      `# Bot trả lời QA matching: ${qaCount}`,
      `# Bot trả lời GPT: ${gptCount}`,
      `# Follow-up tự động: ${followUpCount}`,
      `# Các bước sale đã đạt: ${stepsReached.length > 0 ? stepsReached.map((s) => `Bước ${s}`).join(", ") : "(chưa có)"}`,
      "",
    ];

    const csv = "\uFEFF" + metaRows.join("\n") + headerRow + "\n" + rows.join("\n");
    const filename = `test-session-${session.id}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(csv);
  }

  res.json({
    session: {
      id: session.id,
      name: session.name,
      customerName: session.customer_name,
      scriptId: session.script_id,
      scriptName,
      scriptUpdatedAt: session.script_updated_at,
      currentSaleStep: session.current_sale_step,
      createdAt: session.created_at,
      messageCount: messages.length,
    },
    aggregates,
    messages,
  });
});

// ─── GET /ai-test/sessions/export-all ───────────────────────────────────────

router.get("/ai-test/sessions/export-all", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const sessionsResult = await pool.query<TestSessionRow>(
    `SELECT * FROM ai_test_sessions ORDER BY updated_at DESC`,
  );
  const sessions = sessionsResult.rows;

  if (sessions.length === 0) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tat-ca-phien-test.csv"`);
    return res.send("\uFEFF# Không có phiên test nào\n");
  }

  // Resolve script names for all sessions in one query
  const scriptIds = [...new Set(sessions.map((s) => s.script_id).filter(Boolean))] as number[];
  const scriptNames: Record<number, string> = {};
  if (scriptIds.length > 0) {
    try {
      const scr = await pool.query(
        `SELECT id, name FROM ai_service_scripts WHERE id = ANY($1)`,
        [scriptIds],
      );
      for (const row of scr.rows) scriptNames[row.id as number] = row.name as string;
    } catch { /* ignore */ }
  }

  const escape = (v: unknown): string => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `\t${s}`;
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\t")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const headerRow = [
    "Phiên",
    "Khách",
    "Kịch bản",
    "Thời gian",
    "Vai trò",
    "Loại",
    "Nội dung",
    "Quyết định",
    "Bước sale",
    "Slot follow-up",
  ].join(",");

  // Fetch all messages for all sessions in a single query to avoid N+1
  const sessionIds = sessions.map((s) => s.id);
  const allMessagesResult = await pool.query<TestMessageRow>(
    `SELECT * FROM ai_test_messages WHERE session_id = ANY($1) ORDER BY session_id, created_at ASC`,
    [sessionIds],
  );
  const messagesBySession = new Map<string, TestMessage[]>();
  for (const row of allMessagesResult.rows) {
    const m = toTestMessage(row);
    const list = messagesBySession.get(row.session_id) ?? [];
    list.push(m);
    messagesBySession.set(row.session_id, list);
  }

  const csvLines: string[] = [];
  csvLines.push(`# Xuất tất cả phiên test — ${new Date().toLocaleString("vi-VN")}`);
  csvLines.push(`# Tổng số phiên: ${sessions.length}`);
  csvLines.push("");
  csvLines.push(headerRow);

  for (const session of sessions) {
    const scriptName = session.script_id ? (scriptNames[session.script_id] ?? `Script #${session.script_id}`) : "(Không có)";
    const scriptVersion = session.script_updated_at
      ? ` (v.${new Date(session.script_updated_at).toLocaleDateString("vi-VN")})`
      : "";

    // Separator row for each session
    csvLines.push(
      [
        escape(`=== ${session.name} ===`),
        escape(session.customer_name),
        escape(`${scriptName}${scriptVersion}`),
        escape(new Date(session.created_at).toLocaleString("vi-VN")),
        "---", "---", "---", "---", "---", "---",
      ].join(","),
    );

    const messages = messagesBySession.get(session.id) ?? [];

    for (const m of messages) {
      const role = m.role === "user" ? "Khách" : "Bot";
      const type = m.type === "follow_up_auto" ? "Follow-up tự động" : m.type === "image" ? "Ảnh" : "Văn bản";
      let decisionDisplay = m.decision ?? "";
      if (m.type === "follow_up_auto" && m.decision) {
        const match = m.decision.match(/step(\d+)_slot(\d+)/);
        if (match) decisionDisplay = `Follow-up Bước ${match[1]} Slot ${Number(match[2]) + 1}`;
      }
      let slotDisplay = "";
      if (m.type === "follow_up_auto" && m.decision) {
        const match = m.decision.match(/slot(\d+)/);
        if (match) slotDisplay = `Slot ${Number(match[1]) + 1}`;
      }
      csvLines.push(
        [
          escape(session.name),
          escape(session.customer_name),
          escape(`${scriptName}${scriptVersion}`),
          escape(new Date(m.createdAt).toLocaleString("vi-VN")),
          escape(role),
          escape(type),
          escape(m.text),
          escape(decisionDisplay),
          escape(m.currentStep != null ? `Bước ${m.currentStep}` : ""),
          escape(slotDisplay),
        ].join(","),
      );
    }
  }

  const csv = "\uFEFF" + csvLines.join("\n");
  const filename = `tat-ca-phien-test-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(csv);
});

// ─── GET /ai-test/scripts (danh sách script để chọn) ────────────────────────

router.get("/ai-test/scripts", async (req, res) => {
  const caller = await getCaller(req);
  if (caller === null) return res.status(403).json({ error: "Vui lòng đăng nhập để dùng phòng test AI" });

  const scripts = await loadSaleScripts();
  res.json(scripts.map((s) => ({ id: s.id, name: s.name })));
});

export default router;
