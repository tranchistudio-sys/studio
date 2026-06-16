import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import { defaultAiSettings, normalizeAiSettings } from "./ai-engine";

const router: IRouter = Router();

const STEP_LABELS: Record<number, string> = {
  1: "Chào hỏi",
  2: "Khai thác nhu cầu",
  3: "Gợi ý gói phù hợp",
  4: "Báo giá + quyền lợi",
  5: "Chốt mềm",
  6: "Xử lý từ chối",
  7: "Follow-up tự động",
};

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  next();
}

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const r = await pool.query(
    `SELECT id, role, roles FROM staff WHERE id = $1`,
    [callerId],
  );
  const caller = r.rows[0] as { id: number; role?: string; roles?: string[] } | undefined;
  if (!caller) return res.status(401).json({ error: "Tài khoản không hợp lệ" });
  const isAdmin =
    caller.role === "admin" ||
    (Array.isArray(caller.roles) && caller.roles.includes("admin"));
  if (!isAdmin) return res.status(403).json({ error: "Chỉ admin mới có quyền thực hiện thao tác này" });
  next();
}

async function requireStaff(req: Request, res: Response, next: NextFunction) {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const r = await pool.query(
    `SELECT id FROM staff WHERE id = $1 AND is_active = 1`,
    [callerId],
  );
  if (r.rows.length === 0) return res.status(401).json({ error: "Tài khoản không hợp lệ" });
  next();
}

async function getScriptWithSteps(id: number) {
  const scriptRes = await pool.query(
    `SELECT * FROM ai_service_scripts WHERE id = $1`,
    [id],
  );
  if (scriptRes.rows.length === 0) return null;
  const stepsRes = await pool.query(
    `SELECT * FROM ai_script_steps WHERE script_id = $1 ORDER BY step ASC`,
    [id],
  );
  return { ...scriptRes.rows[0], steps: stepsRes.rows };
}

router.get("/ai-scripts", requireStaff, async (_req, res) => {
  try {
    const scripts = await pool.query(
      `SELECT s.*, COUNT(st.id) FILTER (WHERE st.content IS NOT NULL AND st.content != '') AS filled_steps
       FROM ai_service_scripts s
       LEFT JOIN ai_script_steps st ON st.script_id = s.id
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
    );
    res.json(scripts.rows);
  } catch (err) {
    console.error("GET /ai-scripts error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

function validateConversationExamplesStrict(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return "conversationExamples phải là mảng";
  for (let i = 0; i < value.length; i++) {
    const ex = value[i];
    if (!Array.isArray(ex)) return `Hội thoại mẫu ${i + 1} phải là mảng messages`;
    if (ex.length < 2) return `Hội thoại mẫu ${i + 1} cần ít nhất 2 messages`;
    for (let j = 0; j < ex.length; j++) {
      const msg = ex[j];
      if (!msg || typeof msg !== "object") return `Message ${j + 1} trong hội thoại ${i + 1} không hợp lệ`;
      const role = (msg as { role?: unknown }).role;
      const content = (msg as { content?: unknown }).content;
      if (role !== "user" && role !== "assistant") return `Role của message ${j + 1} trong hội thoại ${i + 1} phải là "user" hoặc "assistant"`;
      if (typeof content !== "string" || !content.trim()) return `Nội dung message ${j + 1} trong hội thoại ${i + 1} không được rỗng`;
    }
  }
  return null;
}

function normalizeConversationExamples(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const valid: unknown[][] = [];
  for (const ex of value) {
    if (!Array.isArray(ex) || ex.length < 2) continue;
    const msgs: { role: string; content: string }[] = [];
    for (const msg of ex) {
      if (!msg || typeof msg !== "object") continue;
      const role = (msg as { role?: unknown }).role;
      const content = (msg as { content?: unknown }).content;
      if (role !== "user" && role !== "assistant") continue;
      if (typeof content !== "string" || !content.trim()) continue;
      msgs.push({ role: role as string, content: content.trim() });
    }
    if (msgs.length >= 2) valid.push(msgs);
  }
  return valid.length > 0 ? valid : null;
}

function normalizeStepFollowUpMessages(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const step = Number(key);
    if (!Number.isInteger(step) || step < 1 || step > 7) continue;
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed) out[String(step)] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : null;
}

type FollowUpSlot = { delayHours: number; messages: string[] };

function normalizeStepFollowUpSlots(value: unknown): Record<string, FollowUpSlot[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, FollowUpSlot[]> = {};
  for (const [key, slotArr] of Object.entries(value as Record<string, unknown>)) {
    const step = Number(key);
    if (!Number.isInteger(step) || step < 1 || step > 7) continue;
    if (!Array.isArray(slotArr)) continue;
    const slots: FollowUpSlot[] = [];
    for (const s of slotArr) {
      if (!s || typeof s !== "object") continue;
      const delayHours = Number((s as Record<string, unknown>).delayHours);
      if (isNaN(delayHours) || delayHours < 0) continue;
      const msgs = (s as Record<string, unknown>).messages;
      const messages = (Array.isArray(msgs) ? msgs : []).map(String).map(m => m.trim()).filter(Boolean);
      if (messages.length === 0) continue; // Reject slots with no non-empty messages
      slots.push({ delayHours: Math.round(delayHours * 60) / 60, messages });
    }
    if (slots.length > 0) out[String(step)] = slots;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ── Unknown Questions ─────────────────────────────────────────────────────────

router.get("/ai-scripts/unknown-questions/count", requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS pending FROM ai_unknown_questions WHERE status = 'pending'`,
    );
    res.json({ pending: r.rows[0].pending ?? 0 });
  } catch (err) {
    console.error("GET /ai-scripts/unknown-questions/count error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.get("/ai-scripts/unknown-questions", requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, script_id, step, question_text, suggested_answer, psid, status, created_at
       FROM ai_unknown_questions
       ORDER BY created_at DESC`,
    );
    const pending = r.rows.filter((row: { status: string }) => row.status === "pending").length;
    res.json({ rows: r.rows, pending });
  } catch (err) {
    console.error("GET /ai-scripts/unknown-questions error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.patch("/ai-scripts/unknown-questions/:id", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
    const { suggestedAnswer } = req.body as { suggestedAnswer?: string };
    const answer = (suggestedAnswer ?? "").trim();

    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE ai_unknown_questions
       SET suggested_answer = $1, status = 'answered'
       WHERE id = $2 RETURNING *`,
      [answer || null, id],
    );

    if (updated.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Không tìm thấy câu hỏi" });
    }

    const q = updated.rows[0] as {
      script_id: number | null;
      step: number | null;
      question_text: string;
    };

    // Nếu có answer và script_id → tự động thêm vào qa_rows để AI dùng lần sau
    if (answer && q.script_id) {
      const safeStep = q.step && q.step >= 1 && q.step <= 7 ? q.step : 1;
      const maxSort = await client.query(
        `SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM ai_script_qa_rows WHERE script_id = $1`,
        [q.script_id],
      );
      const nextSort = (maxSort.rows[0].max_sort ?? -1) + 1;
      await client.query(
        `INSERT INTO ai_script_qa_rows (script_id, step, question, answer, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [q.script_id, safeStep, q.question_text, answer, nextSort],
      );
      console.log(`[unknown-q] Promoted id=${id} to qa_rows script=${q.script_id} step=${safeStep}`);
    }

    await client.query("COMMIT");
    res.json({ ok: true, row: updated.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("PATCH /ai-scripts/unknown-questions/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  } finally {
    client.release();
  }
});

// ── Shared Q&A rows (script_id IS NULL, step 1–3) ────────────────────────────

router.get("/ai-scripts/shared-qa-rows", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, step, question, answer, sort_order
       FROM ai_script_qa_rows
       WHERE script_id IS NULL AND step BETWEEN 1 AND 3
       ORDER BY sort_order ASC, id ASC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /ai-scripts/shared-qa-rows error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.post("/ai-scripts/shared-qa-rows/bulk", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const rows = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: "Body phải là mảng" });

    await client.query("BEGIN");
    await client.query(`DELETE FROM ai_script_qa_rows WHERE script_id IS NULL`);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as { step?: unknown; question?: unknown; answer?: unknown; sort_order?: unknown };
      const step = parseInt(String(row.step ?? "1"));
      const safeStep = isNaN(step) || step < 1 || step > 3 ? 1 : step;
      await client.query(
        `INSERT INTO ai_script_qa_rows (script_id, step, question, answer, sort_order)
         VALUES (NULL, $1, $2, $3, $4)`,
        [
          safeStep,
          row.question ? String(row.question) : null,
          row.answer ? String(row.answer) : null,
          row.sort_order !== undefined ? Number(row.sort_order) : i,
        ],
      );
    }

    await client.query("COMMIT");
    const result = await pool.query(
      `SELECT id, step, question, answer, sort_order
       FROM ai_script_qa_rows WHERE script_id IS NULL
       ORDER BY sort_order ASC, id ASC`,
    );
    res.json(result.rows);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /ai-scripts/shared-qa-rows/bulk error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  } finally {
    client.release();
  }
});

// ── Per-script routes (parameterized — must be AFTER static routes above) ─────

router.get("/ai-scripts/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
    const script = await getScriptWithSteps(id);
    if (!script) return res.status(404).json({ error: "Không tìm thấy kịch bản" });
    res.json(script);
  } catch (err) {
    console.error("GET /ai-scripts/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.post("/ai-scripts", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, priceContent, priceImages, aiRules, conversationExamples, followUpMessage, stepFollowUpMessages, stepFollowUpSlots, isActive, steps, serviceGroup } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Tên dịch vụ là bắt buộc" });
    }
    const convExError = validateConversationExamplesStrict(conversationExamples);
    if (convExError) return res.status(400).json({ error: convExError });
    await client.query("BEGIN");
    const scriptRes = await client.query(
      `INSERT INTO ai_service_scripts (name, price_content, price_images, ai_rules, conversation_examples, follow_up_message, step_follow_up_messages, step_follow_up_slots, is_active, service_group)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        String(name).trim(),
        priceContent ?? null,
        priceImages ?? null,
        aiRules ?? null,
        (() => { const ce = normalizeConversationExamples(conversationExamples); return ce ? JSON.stringify(ce) : null; })(),
        followUpMessage ?? null,
        normalizeStepFollowUpMessages(stepFollowUpMessages),
        (() => { const s = normalizeStepFollowUpSlots(stepFollowUpSlots); return s ? JSON.stringify(s) : null; })(),
        isActive !== false,
        serviceGroup ? String(serviceGroup).trim() : null,
      ],
    );
    const script = scriptRes.rows[0];

    if (Array.isArray(steps)) {
      for (const s of steps) {
        const step = parseInt(s.step);
        if (isNaN(step) || step < 1 || step > 7) continue;
        await client.query(
          `INSERT INTO ai_script_steps (script_id, step, step_label, content, variants_json)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (script_id, step) DO UPDATE
             SET step_label    = EXCLUDED.step_label,
                 content       = EXCLUDED.content,
                 variants_json = EXCLUDED.variants_json,
                 updated_at    = now()`,
          [
            script.id,
            step,
            s.stepLabel ?? STEP_LABELS[step] ?? `Bước ${step}`,
            s.content ?? null,
            s.variantsJson ?? null,
          ],
        );
      }
    }
    await client.query("COMMIT");
    const full = await getScriptWithSteps(script.id);
    res.status(201).json(full);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /ai-scripts error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  } finally {
    client.release();
  }
});

router.put("/ai-scripts/:id", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
    const { name, priceContent, priceImages, aiRules, conversationExamples, followUpMessage, stepFollowUpMessages, stepFollowUpSlots, isActive, steps, serviceGroup } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Tên dịch vụ là bắt buộc" });
    }
    const convExError = validateConversationExamplesStrict(conversationExamples);
    if (convExError) return res.status(400).json({ error: convExError });
    await client.query("BEGIN");
    const scriptRes = await client.query(
      `UPDATE ai_service_scripts
       SET name = $1, price_content = $2, price_images = $3, ai_rules = $4, conversation_examples = $5, follow_up_message = $6, step_follow_up_messages = $7, step_follow_up_slots = $8, is_active = $9, service_group = $10, updated_at = now()
       WHERE id = $11 RETURNING *`,
      [String(name).trim(), priceContent ?? null, priceImages ?? null, aiRules ?? null, (() => { const ce = normalizeConversationExamples(conversationExamples); return ce ? JSON.stringify(ce) : null; })(), followUpMessage ?? null, normalizeStepFollowUpMessages(stepFollowUpMessages), (() => { const s = normalizeStepFollowUpSlots(stepFollowUpSlots); return s ? JSON.stringify(s) : null; })(), isActive !== false, serviceGroup ? String(serviceGroup).trim() : null, id],
    );
    if (scriptRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Không tìm thấy kịch bản" });
    }

    if (Array.isArray(steps)) {
      for (const s of steps) {
        const step = parseInt(s.step);
        if (isNaN(step) || step < 1 || step > 7) continue;
        await client.query(
          `INSERT INTO ai_script_steps (script_id, step, step_label, content, variants_json)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (script_id, step) DO UPDATE
             SET step_label    = EXCLUDED.step_label,
                 content       = EXCLUDED.content,
                 variants_json = EXCLUDED.variants_json,
                 updated_at    = now()`,
          [
            id,
            step,
            s.stepLabel ?? STEP_LABELS[step] ?? `Bước ${step}`,
            s.content ?? null,
            s.variantsJson ?? null,
          ],
        );
      }
    }
    await client.query("COMMIT");
    const full = await getScriptWithSteps(id);
    res.json(full);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("PUT /ai-scripts/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  } finally {
    client.release();
  }
});

router.patch("/ai-scripts/:id/settings", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: "ID không hợp lệ" });

    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Body phải là object" });
    }

    // Fetch current settings and merge with new values
    const current = await pool.query(
      `SELECT ai_settings FROM ai_service_scripts WHERE id = $1`,
      [id],
    );
    if (current.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy kịch bản" });

    const existing = current.rows[0].ai_settings ?? {};
    const merged = normalizeAiSettings({ ...defaultAiSettings(), ...existing, ...body });

    const updated = await pool.query(
      `UPDATE ai_service_scripts SET ai_settings = $1, updated_at = now() WHERE id = $2 RETURNING ai_settings`,
      [JSON.stringify(merged), id],
    );

    res.json({ ok: true, ai_settings: updated.rows[0].ai_settings });
  } catch (err) {
    console.error("PATCH /ai-scripts/:id/settings error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.delete("/ai-scripts/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
    const r = await pool.query(
      `DELETE FROM ai_service_scripts WHERE id = $1 RETURNING id`,
      [id],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy kịch bản" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /ai-scripts/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.get("/ai-scripts/:id/qa-rows", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
    const result = await pool.query(
      `SELECT id, script_id, step, question, answer, sort_order
       FROM ai_script_qa_rows
       WHERE script_id = $1
       ORDER BY sort_order ASC, id ASC`,
      [id],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /ai-scripts/:id/qa-rows error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

router.post("/ai-scripts/:id/qa-rows/bulk", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });

    const scriptCheck = await pool.query(`SELECT id FROM ai_service_scripts WHERE id = $1`, [id]);
    if (scriptCheck.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy kịch bản" });

    const rows = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: "Body phải là mảng" });

    await client.query("BEGIN");
    await client.query(`DELETE FROM ai_script_qa_rows WHERE script_id = $1`, [id]);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as { step?: unknown; question?: unknown; answer?: unknown; sort_order?: unknown };
      const step = parseInt(String(row.step ?? "4"));
      const safeStep = isNaN(step) || step < 4 || step > 7 ? 4 : step;
      await client.query(
        `INSERT INTO ai_script_qa_rows (script_id, step, question, answer, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          safeStep,
          row.question ? String(row.question) : null,
          row.answer ? String(row.answer) : null,
          row.sort_order !== undefined ? Number(row.sort_order) : i,
        ],
      );
    }

    await client.query("COMMIT");
    const result = await pool.query(
      `SELECT id, script_id, step, question, answer, sort_order
       FROM ai_script_qa_rows WHERE script_id = $1 ORDER BY sort_order ASC, id ASC`,
      [id],
    );
    res.json(result.rows);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /ai-scripts/:id/qa-rows/bulk error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  } finally {
    client.release();
  }
});

export default router;
