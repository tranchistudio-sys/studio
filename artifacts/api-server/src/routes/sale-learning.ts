import { Router, type IRouter, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import { resolveModel } from "../lib/claude-sale";
import { ensureSalePlaybookTable, clearPlaybookCache } from "../lib/sale-playbook";

/**
 * Sale Learning — học phong cách tư vấn từ chat Facebook thật, CÓ KIỂM DUYỆT.
 * Giai đoạn 1: thủ công. Admin: Quét → Tạo nháp → Sửa/Duyệt → Áp dụng.
 * Playbook chỉ học GIỌNG/CÁCH DẪN; KHÔNG học giá (giá luôn từ sale-context.ts).
 */

const router: IRouter = Router();

// Mở Sale Learning cho MỌI nhân viên đã đăng nhập (quyết định của chủ studio).
// Vẫn yêu cầu đăng nhập + tài khoản hợp lệ; KHÔNG còn bắt buộc vai trò admin.
async function requireAdmin(req: Request, res: Response): Promise<{ id: number; name: string } | null> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    return null;
  }
  const r = await pool.query(`SELECT name FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
  const u = r.rows[0] as { name?: string } | undefined;
  if (!u) {
    res.status(401).json({ error: "Tài khoản không hợp lệ" });
    return null;
  }
  return { id: callerId, name: u?.name ?? `#${callerId}` };
}

// ── Lọc & dọn dữ liệu học ────────────────────────────────────────────────────
const DENY_KEYWORDS = ["đối tác", "nội bộ", "ctv", "cộng tác viên", "giá vốn", "wholesale", "sỉ", "internal"];
function isDenied(text: string): boolean {
  const h = (text || "").toLowerCase();
  return DENY_KEYWORDS.some((k) => h.includes(k));
}
function redact(text: string): string {
  return (text || "")
    .replace(/\[image:[^\]]*\]/gi, "[ảnh]")
    .replace(/(?:\+?84|0)\d{8,10}/g, "[SĐT]")
    .replace(/\s+/g, " ")
    .trim();
}

// Chọn các hội thoại đủ tiêu chuẩn để học (khách hỏi thật + NV người trả lời + nhiều lượt)
async function selectQualifyingConversations(limit: number) {
  const r = await pool.query(
    `WITH conv AS (
       SELECT m.facebook_user_id AS psid,
         count(*) AS total,
         count(*) FILTER (WHERE direction='incoming') AS incoming,
         count(*) FILTER (WHERE direction='outgoing' AND (ai_decision IN ('page_sent','manual_sent','manual_image') OR sent_by IS NOT NULL)) AS human_out,
         bool_or(lower(message) ~ '(giá|bao nhiêu|bảng giá)') AS asked_price,
         bool_or(lower(message) ~ '(lịch|ngày|khi nào|tháng)') AS asked_schedule,
         bool_or(lower(message) ~ '(concept|album|váy|phong cách|mẫu)') AS asked_concept
       FROM fb_inbox_messages m
       WHERE m.facebook_user_id NOT LIKE 'TEST\\_%'
       GROUP BY m.facebook_user_id
     )
     SELECT c.psid, c.total, c.incoming, c.human_out, c.asked_price, c.asked_schedule, c.asked_concept,
            l.name, (l.phone IS NOT NULL AND l.phone <> '') AS has_phone, l.status AS lead_status
     FROM conv c
     LEFT JOIN crm_leads l ON l.facebook_user_id = c.psid
     WHERE c.incoming >= 1 AND c.human_out >= 1 AND c.total >= 4
     ORDER BY (l.phone IS NOT NULL) DESC, c.asked_price DESC, c.asked_concept DESC, c.total DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows as Array<{
    psid: string; total: number; incoming: number; human_out: number;
    asked_price: boolean; asked_schedule: boolean; asked_concept: boolean;
    name: string | null; has_phone: boolean; lead_status: string | null;
  }>;
}

// Lấy transcript đã dọn của 1 hội thoại (chỉ tin khách + NV người, bỏ tin bot/quá ngắn/cấm)
async function buildTranscript(psid: string, maxMsgs = 30): Promise<string> {
  const r = await pool.query(
    `SELECT direction, message, ai_decision, sent_by FROM fb_inbox_messages
     WHERE facebook_user_id = $1 ORDER BY id ASC LIMIT 200`,
    [psid],
  );
  const lines: string[] = [];
  for (const row of r.rows as Array<{ direction: string; message: string; ai_decision: string | null; sent_by: string | null }>) {
    if (lines.length >= maxMsgs) break;
    const msg = redact(row.message);
    if (!msg || msg.length < 2) continue;
    if (isDenied(row.message)) continue; // bỏ tin có giá đối tác/nội bộ/CTV
    if (row.direction === "incoming") {
      lines.push(`Khách: ${msg}`);
    } else {
      // chỉ lấy tin NV người gửi (bỏ tin do bot/QA tự trả lời)
      const human = (row.ai_decision && ["page_sent", "manual_sent", "manual_image"].includes(row.ai_decision)) || !!row.sent_by;
      if (!human) continue;
      lines.push(`NV: ${msg}`);
    }
  }
  return lines.join("\n");
}

const PLAYBOOK_SECTIONS = [
  "Cách chào khách tự nhiên",
  "Cách hỏi nhu cầu",
  "Cách hỏi gu khách",
  "Cách gửi bảng giá",
  "Cách dẫn khách xem ảnh mẫu",
  "Cách xin ngày chụp",
  "Cách xin số điện thoại",
  "Cách xử lý khách hỏi giảm giá",
  "Cách xử lý khách im lặng",
  "Cách xử lý khách phân vân",
  "Cách chốt lịch tư vấn",
];

// ── POST /scan : quét & thống kê hội thoại đủ tiêu chuẩn ─────────────────────
router.post("/sale-learning/scan", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const rows = await selectQualifyingConversations(200);
    const sample = rows.slice(0, 12).map((r) => ({
      name: r.name || `Khách ${r.psid.slice(-4)}`,
      messages: Number(r.total),
      hasPhone: r.has_phone,
      askedPrice: r.asked_price,
      askedConcept: r.asked_concept,
      askedSchedule: r.asked_schedule,
    }));
    res.json({
      qualifying: rows.length,
      withPhone: rows.filter((r) => r.has_phone).length,
      askedPrice: rows.filter((r) => r.asked_price).length,
      askedConcept: rows.filter((r) => r.asked_concept).length,
      totalMessages: rows.reduce((s, r) => s + Number(r.total), 0),
      sample,
    });
  } catch (err) {
    console.error("[SaleLearning] scan lỗi:", err);
    res.status(500).json({ error: "Quét hội thoại lỗi: " + String(err).slice(0, 200) });
  }
});

// ── POST /generate : tạo bản nháp playbook bằng Claude ───────────────────────
router.post("/sale-learning/generate", async (req, res) => {
  const caller = await requireAdmin(req, res);
  if (!caller) return;
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) return res.status(400).json({ error: "Chưa cấu hình ANTHROPIC_API_KEY" });

  try {
    await ensureSalePlaybookTable();
    const maxConvos = Math.min(Number(req.body?.maxConversations) || 25, 40);
    const rows = await selectQualifyingConversations(maxConvos);
    if (rows.length === 0) {
      return res.status(400).json({ error: "Không có hội thoại đủ tiêu chuẩn để học" });
    }

    // Gom transcript (giới hạn tổng độ dài để kiểm soát token)
    const transcripts: string[] = [];
    let totalChars = 0;
    let used = 0;
    for (const r of rows) {
      const t = await buildTranscript(r.psid);
      if (!t || t.length < 40) continue;
      if (totalChars + t.length > 30000) break;
      transcripts.push(`--- Hội thoại ${used + 1} ---\n${t}`);
      totalChars += t.length;
      used++;
    }
    if (used === 0) return res.status(400).json({ error: "Không trích được transcript hợp lệ" });

    const model = resolveModel();
    const client = new Anthropic({ apiKey });
    const system = `Bạn là chuyên gia huấn luyện sale. Dưới đây là các đoạn chat THẬT giữa khách và nhân viên studio ảnh cưới Amazing Studio (đã ẩn số điện thoại). Hãy ĐÚC KẾT thành một SALE PLAYBOOK để dạy phong cách tư vấn cho nhân viên mới (tên Hoa).

QUAN TRỌNG:
- CHỈ học GIỌNG ĐIỆU, CÁCH DẪN KHÁCH, CÁCH XỬ LÝ TÌNH HUỐNG, CÁCH CHỐT. TUYỆT ĐỐI KHÔNG ghi con số giá cụ thể nào vào playbook (giá lấy từ hệ thống khác).
- Viết tiếng Việt, văn phong tự nhiên như sale Facebook. KHÔNG markdown, KHÔNG dấu **, KHÔNG gạch đầu dòng. Mỗi mục vài câu ngắn + 1-2 câu mẫu nên nói (rút từ cách NV thật nói).
- Trình bày đúng ${PLAYBOOK_SECTIONS.length} mục theo thứ tự, mỗi mục bắt đầu bằng tiêu đề mục trên 1 dòng riêng:
${PLAYBOOK_SECTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

    const userContent = `Đây là ${used} đoạn hội thoại thật:\n\n${transcripts.join("\n\n")}\n\nHãy viết Sale Playbook theo đúng ${PLAYBOOK_SECTIONS.length} mục ở trên.`;

    const resp = await client.messages.create({
      model,
      max_tokens: 3500,
      system,
      messages: [{ role: "user", content: userContent }],
    });
    const content = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!content) return res.status(502).json({ error: "Claude không trả về nội dung playbook" });

    const title = `Playbook nháp ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const ins = await pool.query(
      `INSERT INTO sale_playbooks (title, status, content, conversations_used, source_summary, created_by, created_by_name)
       VALUES ($1, 'draft', $2, $3, $4, $5, $6) RETURNING *`,
      [title, content, used, `Học từ ${used} hội thoại Facebook (đã lọc tin test/rác/giá đối tác)`, caller.id, caller.name],
    );
    res.json({ playbook: ins.rows[0], conversationsUsed: used });
  } catch (err) {
    console.error("[SaleLearning] generate lỗi:", err);
    res.status(502).json({ error: "Tạo playbook lỗi: " + String(err).slice(0, 250) });
  }
});

// ── GET danh sách / chi tiết ─────────────────────────────────────────────────
router.get("/sale-learning/playbooks", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  await ensureSalePlaybookTable();
  const r = await pool.query(
    `SELECT id, title, status, conversations_used, source_summary, created_by_name, approved_by_name,
            created_at, updated_at, approved_at, activated_at, (content_original IS NOT NULL) AS edited
     FROM sale_playbooks ORDER BY id DESC`,
  );
  res.json({ playbooks: r.rows });
});

router.get("/sale-learning/playbooks/:id", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  await ensureSalePlaybookTable();
  const r = await pool.query(`SELECT * FROM sale_playbooks WHERE id = $1`, [Number(req.params.id)]);
  if (!r.rows.length) return res.status(404).json({ error: "Không tìm thấy playbook" });
  res.json({ playbook: r.rows[0] });
});

// ── PUT sửa nội dung/tiêu đề (lưu bản gốc lần sửa đầu) ────────────────────────
router.put("/sale-learning/playbooks/:id", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  await ensureSalePlaybookTable();
  const id = Number(req.params.id);
  const { content, title } = req.body as { content?: string; title?: string };
  const cur = await pool.query(`SELECT content, content_original, status FROM sale_playbooks WHERE id = $1`, [id]);
  if (!cur.rows.length) return res.status(404).json({ error: "Không tìm thấy playbook" });
  if (cur.rows[0].status === "active") return res.status(400).json({ error: "Không sửa bản đang active. Hãy tạo bản mới hoặc bỏ active trước." });
  // Lần sửa đầu: lưu lại content gốc để truy vết trước/sau
  const keepOriginal = cur.rows[0].content_original == null ? cur.rows[0].content : cur.rows[0].content_original;
  const r = await pool.query(
    `UPDATE sale_playbooks SET content = COALESCE($1, content), title = COALESCE($2, title),
            content_original = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
    [content ?? null, title ?? null, keepOriginal, id],
  );
  res.json({ playbook: r.rows[0] });
});

// ── Duyệt / Từ chối ──────────────────────────────────────────────────────────
router.post("/sale-learning/playbooks/:id/approve", async (req, res) => {
  const caller = await requireAdmin(req, res);
  if (!caller) return;
  const r = await pool.query(
    `UPDATE sale_playbooks SET status='approved', approved_by=$1, approved_by_name=$2, approved_at=NOW(), updated_at=NOW()
     WHERE id=$3 AND status IN ('draft','approved') RETURNING *`,
    [caller.id, caller.name, Number(req.params.id)],
  );
  if (!r.rows.length) return res.status(400).json({ error: "Không duyệt được (đã rejected/active hoặc không tồn tại)" });
  res.json({ playbook: r.rows[0] });
});

router.post("/sale-learning/playbooks/:id/reject", async (req, res) => {
  const caller = await requireAdmin(req, res);
  if (!caller) return;
  const r = await pool.query(
    `UPDATE sale_playbooks SET status='rejected', updated_at=NOW() WHERE id=$1 RETURNING *`,
    [Number(req.params.id)],
  );
  if (!r.rows.length) return res.status(404).json({ error: "Không tìm thấy playbook" });
  clearPlaybookCache();
  res.json({ playbook: r.rows[0] });
});

// ── Áp dụng cho Claude Sale (active) — chỉ 1 bản active ──────────────────────
router.post("/sale-learning/playbooks/:id/activate", async (req, res) => {
  const caller = await requireAdmin(req, res);
  if (!caller) return;
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(`SELECT status FROM sale_playbooks WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Không tìm thấy playbook" }); }
    if (cur.rows[0].status === "rejected") { await client.query("ROLLBACK"); return res.status(400).json({ error: "Bản đã bị từ chối, không thể áp dụng" }); }
    // Hạ các bản active khác xuống approved
    await client.query(`UPDATE sale_playbooks SET status='approved', updated_at=NOW() WHERE status='active' AND id<>$1`, [id]);
    const r = await client.query(
      `UPDATE sale_playbooks SET status='active', activated_at=NOW(), updated_at=NOW(),
              approved_by=COALESCE(approved_by,$1), approved_by_name=COALESCE(approved_by_name,$2),
              approved_at=COALESCE(approved_at,NOW()) WHERE id=$3 RETURNING *`,
      [caller.id, caller.name, id],
    );
    await client.query("COMMIT");
    clearPlaybookCache();
    res.json({ playbook: r.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[SaleLearning] activate lỗi:", err);
    res.status(500).json({ error: "Áp dụng lỗi: " + String(err).slice(0, 200) });
  } finally {
    client.release();
  }
});

export default router;
