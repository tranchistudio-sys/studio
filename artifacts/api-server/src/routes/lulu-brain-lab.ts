import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import { callChat } from "../lib/ai-orchestrator";
import { DEFAULT_BRAIN_RULES } from "../lib/claude-sale";
import { simulateReply } from "../lib/sale-brain-runner";
import {
  ensureBrainLabTables, getActiveVersion, getVersion, listVersions, getOpenDraftVersion,
  createDraftVersion, updateDraftVersion, rejectVersion, rejectOtherDrafts, applyDraftVersion, rollbackToVersion,
  createChangeRequest, listChangeRequests, setChangeRequestStatus,
  listTestCases, getTestCase, createTestCase, deleteTestCase,
  saveTestResult, listTestResults, missingMarkers, recoverMissingMarkers,
  getActiveImageOverrides, appendImageOverrideToDraft,
  type BrainVersion,
  type ChangeRequestStatus,
} from "../lib/sale-brain-lab";
import {
  parseImageOverrides, type ImageOverride, type OverrideImage,
} from "../lib/sale-image-overrides";
import { browseImageStore } from "../lib/sale-image-store";

/**
 * Lulu Brain Lab — quản lý / sửa / test / lưu version cho "não Sale AI Lulu".
 *
 * QUYỀN (PHẦN 1):
 *  - Mọi nhân viên đăng nhập: báo lỗi, góp ý, tạo bản nháp (AI hoặc tay), sửa nháp, test bản nháp.
 *  - CHỈ admin/chủ studio: Áp dụng bản nháp + Khôi phục version (đổi bản chạy thật).
 *  - AI chỉ TẠO bản nháp, KHÔNG tự áp dụng, KHÔNG sửa code, KHÔNG deploy, KHÔNG đụng DB ngoài bảng Brain Lab.
 *
 * AN TOÀN: chỉ đụng 4 bảng lulu_brain_* + đọc context/cấu hình Lulu. KHÔNG đụng
 * booking/payment/calendar/attendance/CRM hay claude_sale_settings.
 */

const router: IRouter = Router();

type Caller = { id: number; name: string | null; isAdmin: boolean };

async function requireStaff(req: Request, res: Response): Promise<Caller | null> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    return null;
  }
  const r = await pool.query(`SELECT id, name, role, roles FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
  const u = r.rows[0] as { id: number; name?: string; role?: string; roles?: unknown } | undefined;
  if (!u) {
    res.status(401).json({ error: "Tài khoản không hợp lệ" });
    return null;
  }
  const isAdmin = u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin"));
  return { id: u.id, name: u.name ?? null, isAdmin };
}

function requireAdmin(caller: Caller, res: Response): boolean {
  if (!caller.isAdmin) {
    res.status(403).json({ error: "Chỉ admin/chủ studio được áp dụng hoặc khôi phục bản não Lulu" });
    return false;
  }
  return true;
}

// ─── TAB 1: Não đang dùng ─────────────────────────────────────────────────────

router.get("/lulu-brain/active", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    await ensureBrainLabTables();
    const active = await getActiveVersion();
    res.json({ active, defaultRules: DEFAULT_BRAIN_RULES });
  } catch (err) {
    console.error("[BrainLab] active lỗi:", String(err).slice(0, 200));
    res.status(500).json({ error: "Không tải được não đang dùng" });
  }
});

// ─── Bản nháp đang mở (một bản nháp duy nhất để gom mọi sửa) ───────────────────
// FE tab "Sửa & Test Lulu" gọi cái này lúc mở để biết đang sửa/test version nào.
router.get("/lulu-brain/draft", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    const draft = await getOpenDraftVersion();
    res.json({ draft });
  } catch (err) {
    console.error("[BrainLab] draft lỗi:", String(err).slice(0, 200));
    res.status(500).json({ error: "Không tải được bản nháp đang mở" });
  }
});

// ─── TAB 5: Version History ───────────────────────────────────────────────────

router.get("/lulu-brain/versions", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    const versions = await listVersions(req.query.limit ? Number(req.query.limit) : 200);
    res.json({ versions });
  } catch (err) {
    console.error("[BrainLab] versions lỗi:", String(err).slice(0, 200));
    res.status(500).json({ error: "Không tải được danh sách version" });
  }
});

router.get("/lulu-brain/versions/:id", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  const v = await getVersion(Number(req.params.id));
  if (!v) return res.status(404).json({ error: "Không tìm thấy version" });
  res.json({ version: v });
});

router.get("/lulu-brain/versions/:id/results", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    const results = await listTestResults(Number(req.params.id));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err).slice(0, 200) });
  }
});

// ─── Tạo bản nháp ─────────────────────────────────────────────────────────────

// "Tạo bản nháp từ version này" (TAB 1 / Version History) — clone nội dung version nguồn thành nháp mới.
// MỘT BẢN NHÁP DUY NHẤT: nếu đã có nháp đang mở → trả về nháp đó (không đẻ thêm version rác).
router.post("/lulu-brain/versions/:id/draft-from", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const src = await getVersion(Number(req.params.id));
  if (!src) return res.status(404).json({ error: "Không tìm thấy version nguồn" });
  const { title, force } = (req.body ?? {}) as { title?: string; force?: boolean };
  try {
    // force=true: CỐ Ý tạo bản nháp MỚI từ bản đang chạy (hủy nháp cũ → rejected, giữ lịch sử).
    // không force: tái dùng nháp đang mở (gom 1 bản nháp, không đẻ version rác).
    if (!force) {
      const existing = await getOpenDraftVersion();
      if (existing) return res.json({ draft: existing, reusedExisting: true });
    }
    const draft = await createDraftVersion({
      title: (title && title.trim()) || `Nháp dựa trên Version ${src.versionNumber}`,
      description: `Tạo từ Version ${src.versionNumber}: ${src.title}`,
      promptContent: src.promptContent,
      rulesJson: src.rulesJson,
      basedOnVersionId: src.id,
      changeSummary: "Bản nháp khởi tạo từ nội dung version nguồn (chưa thay đổi gì).",
      createdBy: caller.id,
      createdByName: caller.name,
    });
    await rejectOtherDrafts(draft.id).catch(() => {});
    res.json({ draft });
  } catch (err) {
    console.error("[BrainLab] draft-from lỗi:", String(err).slice(0, 200));
    res.status(500).json({ error: "Không tạo được bản nháp" });
  }
});

// Tạo nháp thủ công (sửa tay từ đầu / dán nội dung).
router.post("/lulu-brain/drafts", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const b = (req.body ?? {}) as {
    title?: string; description?: string; promptContent?: string;
    basedOnVersionId?: number; changeSummary?: string;
  };
  if (!b.promptContent || !b.promptContent.trim()) {
    return res.status(400).json({ error: "Thiếu nội dung bộ luật (promptContent)" });
  }
  try {
    const draft = await createDraftVersion({
      title: (b.title && b.title.trim()) || "Bản nháp mới",
      description: b.description ?? "",
      promptContent: b.promptContent,
      basedOnVersionId: b.basedOnVersionId ?? null,
      changeSummary: b.changeSummary ?? null,
      createdBy: caller.id,
      createdByName: caller.name,
    });
    res.json({ draft });
  } catch (err) {
    res.status(500).json({ error: "Không tạo được bản nháp" });
  }
});

// Sửa tay bản nháp (PHẦN 5) — chỉ version đang là draft.
router.put("/lulu-brain/versions/:id", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const b = (req.body ?? {}) as { title?: string; description?: string; promptContent?: string; changeSummary?: string };
  const updated = await updateDraftVersion(Number(req.params.id), b);
  if (!updated) return res.status(400).json({ error: "Chỉ sửa được bản nháp (draft). Version đã áp dụng không sửa trực tiếp — hãy tạo bản nháp mới." });
  res.json({ version: updated });
});

// Hủy bản nháp.
router.post("/lulu-brain/versions/:id/reject", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const { note } = (req.body ?? {}) as { note?: string };
  const v = await rejectVersion(Number(req.params.id), note);
  if (!v) return res.status(400).json({ error: "Chỉ hủy được bản nháp (draft)" });
  res.json({ version: v });
});

// ─── TAB 2: Nhờ AI sửa Lulu (tạo bản nháp) ────────────────────────────────────

const AI_DRAFT_SYSTEM = `Bạn là kỹ sư prompt cho "não Sale AI Lulu" của Amazing Studio (studio chụp ảnh cưới/beauty/gia đình, cho thuê đồ).

"Bộ luật não Lulu" là một đoạn văn bản tiếng Việt gồm các luật: chọn đúng nhóm ảnh/link (beauty/cưới/cổng/thuê đồ/concept), hỏi nhu cầu trước khi báo giá, xử lý concept lạ, văn phong nói chuyện như nhân viên thật, và hướng dẫn gửi ảnh mẫu / ảnh bảng giá.

NHIỆM VỤ: dựa trên BỘ LUẬT HIỆN TẠI + GÓP Ý của người dùng, viết lại TOÀN BỘ bộ luật mới cho tốt hơn theo đúng góp ý.

RÀNG BUỘC BẮT BUỘC:
- PHẢI GIỮ ĐỦ 4 dấu hiệu kỹ thuật <<...>> và phần hướng dẫn dùng chúng: <<SAMPLE: nhóm>> (gửi ảnh mẫu), <<PRICE_IMAGE: MÃ>> (gửi ảnh bảng giá), <<NAME: tên>> (học tên khách), <<NEEDS_HUMAN: lý do>> (chuyển người thật). Đây là tín hiệu hệ thống — TUYỆT ĐỐI KHÔNG xoá, KHÔNG đổi cú pháp/tên marker. Nếu bản hiện tại có mục hướng dẫn nào (vd "GỬI ẢNH MẪU THẬT") thì bản mới PHẢI còn mục đó.
- KHÔNG rút gọn hay bỏ bớt bất kỳ MỤC luật nào (chọn nhóm ảnh, hỏi giá, concept lạ, gửi ảnh mẫu, gửi ảnh bảng giá) trừ khi góp ý yêu cầu rõ. Bản mới nên DÀI tương đương bản cũ.
- KHÔNG bịa giá, KHÔNG thêm chính sách giảm giá, KHÔNG hứa giữ lịch/đặt cọc (phần an toàn này do hệ thống tự lo, đừng nói ngược lại).
- Viết tiếng Việt tự nhiên, rõ ràng, giữ phong cách hướng dẫn từng luật như bản gốc.
- Chỉ thay đổi đúng điều người dùng góp ý; phần còn lại giữ gần như nguyên văn.

ĐẦU RA: KHÔNG dùng JSON, KHÔNG dùng dấu \`\`\`. Trả về ĐÚNG 3 phần theo định dạng sau (giữ nguyên 2 nhãn TITLE/CHANGES và dòng phân cách ===PROMPT===, KHÔNG thêm gì khác):
TITLE: <tên ngắn cho bản nháp>
CHANGES: <tóm tắt ngắn đã THÊM/BỎ/SỬA gì so với bản hiện tại, 1-4 ý, ngăn cách bằng "; ">
===PROMPT===
<toàn bộ bộ luật mới, viết bình thường nhiều dòng — đây là phần dài nhất>`;

/** Tách kết quả AI (định dạng TITLE/CHANGES/===PROMPT===) — bền với văn bản dài, không cần escape JSON. */
function parseDraftOutput(text: string): { title: string; changeSummary: string; promptContent: string } {
  const raw = (text ?? "").trim();
  const MARK = "===PROMPT===";
  const idx = raw.indexOf(MARK);
  let head = "";
  let body = raw;
  if (idx >= 0) {
    head = raw.slice(0, idx);
    body = raw.slice(idx + MARK.length);
  }
  // Bỏ rào ```...``` nếu model lỡ thêm.
  let promptContent = body.trim().replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
  const tm = head.match(/TITLE:\s*(.+)/i);
  const cm = head.match(/CHANGES:\s*([\s\S]+)/i);
  return {
    title: (tm?.[1] ?? "").trim(),
    changeSummary: (cm?.[1] ?? "").trim(),
    promptContent,
  };
}

/**
 * Gom tóm tắt thay đổi khi nhiều lần sửa dồn vào CÙNG một bản nháp:
 *  - Cảnh báo marker (nếu có) đưa lên đầu; bỏ cảnh báo marker CŨ (chỉ giữ trạng thái mới nhất).
 *  - Sửa mới đứng trước, sửa cũ phía sau; cắt an toàn (cột change_summary giới hạn 4000).
 */
function mergeChangeSummary(newSummary: string, oldSummary: string | null, markerWarning: string): string {
  const prev = (oldSummary ?? "")
    .split("\n")
    .filter((ln) => { const t = ln.trim(); return !t.startsWith("⚠") && !t.startsWith("🔧"); })
    .join("\n")
    .trim();
  const parts = [markerWarning, `• ${newSummary}`.trim(), prev].filter((s) => s && s.trim());
  let combined = parts.join("\n\n");
  if (combined.length > 3500) combined = `${combined.slice(0, 3500)}\n…(đã rút gọn các sửa đổi cũ)`;
  return combined;
}

router.post("/lulu-brain/ai-draft", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const b = (req.body ?? {}) as { instruction?: string; basedOnVersionId?: number; changeRequestId?: number };
  const instruction = (b.instruction ?? "").trim();
  if (!instruction) return res.status(400).json({ error: "Thiếu nội dung góp ý cho AI" });

  try {
    await ensureBrainLabTables();
    const active = await getActiveVersion();
    const openDraft = await getOpenDraftVersion();
    // Bộ luật NỀN để AI viết lại:
    //  - Đang có bản nháp mở → viết tiếp TRÊN nội dung nháp đó (gom mọi lỗi vào cùng version, không đẻ V7/V8).
    //  - Chưa có nháp + chỉ định basedOnVersionId → dùng version đó.
    //  - Còn lại → version đang chạy (active) → mặc định.
    let base: BrainVersion | null = openDraft ?? active;
    if (!openDraft && b.basedOnVersionId) {
      const chosen = await getVersion(b.basedOnVersionId);
      if (chosen) base = chosen;
    }
    const baseContent = base?.promptContent?.trim() || DEFAULT_BRAIN_RULES;
    const baseVersionLabel = base ? `Version ${base.versionNumber}` : "mặc định";

    const userMsg =
      `BỘ LUẬT HIỆN TẠI (${baseVersionLabel}):\n"""\n${baseContent}\n"""\n\n` +
      `GÓP Ý CỦA NGƯỜI DÙNG:\n"""\n${instruction}\n"""\n\n` +
      `Hãy viết lại toàn bộ bộ luật mới và trả về ĐÚNG 3 phần theo định dạng TITLE/CHANGES/===PROMPT=== như hướng dẫn (KHÔNG dùng JSON).`;

    const result = await callChat({
      system: AI_DRAFT_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: 4096,            // ~8K ký tự ≈ 3K token → 4096 đủ (repro xác nhận); 8192 từng gây lỗi
      timeoutMs: 150000,          // viết lại toàn bộ bộ luật mất 15-90s → vượt timeout mặc định 12s
      label: "brain-lab-draft",   // KHÔNG jsonMode (Claude bỏ qua; chỉ OpenAI dùng) — parse JSON ở dưới
    });
    if (!result.ok) {
      const detail = (result as { adminAlert?: string }).adminAlert ?? result.reason;
      console.error(`[BrainLab] ai-draft callChat FAIL: reason=${result.reason} detail=${detail}`);
      return res.status(502).json({ error: `AI không tạo được bản nháp: ${detail}`, reason: result.reason });
    }

    const parsed = parseDraftOutput(result.text);
    if (!parsed.promptContent || !parsed.promptContent.trim()) {
      console.error("[BrainLab] ai-draft parse rỗng. Raw head:", result.text.slice(0, 200));
      return res.status(502).json({ error: "AI không trả về nội dung bộ luật" });
    }

    // TỰ VÁ MARKER (chữa gốc "báo đỏ"): marker nào CÓ trong bản chạy thật (active) mà bản mới thiếu
    // → CHÈN LẠI nguyên khối hướng dẫn gốc (không còn chỉ cảnh báo/khoá). So với active để khớp lưới
    // chặn ở route apply → sau bước này bản nháp luôn đủ marker, nút Áp dụng không bị khoá oan.
    const referenceContent = active?.promptContent?.trim() || DEFAULT_BRAIN_RULES;
    const recovery = recoverMissingMarkers(parsed.promptContent, referenceContent);
    const finalContent = recovery.content;
    const recoveryNote = recovery.recovered.length
      ? `🔧 Tự khôi phục dấu hiệu kỹ thuật: ${recovery.recovered.join(", ")} (AI lỡ bỏ khi viết lại — hệ thống chèn lại khối gốc để không mất chức năng).`
      : "";
    const newSummary = (parsed.changeSummary && parsed.changeSummary.trim()) || "AI đã chỉnh bộ luật theo góp ý.";

    let draft: BrainVersion;
    if (openDraft) {
      // GOM vào bản nháp đang mở: cập nhật tại chỗ, GIỮ NGUYÊN số version (không đẻ version mới).
      const updated = await updateDraftVersion(openDraft.id, {
        promptContent: finalContent,
        changeSummary: mergeChangeSummary(newSummary, openDraft.changeSummary, recoveryNote),
      });
      draft = updated ?? openDraft;
    } else {
      // Chưa có nháp → tạo bản nháp mới từ nền, rồi dọn các nháp rác cũ về 'rejected' (giữ lịch sử).
      draft = await createDraftVersion({
        title: (parsed.title && parsed.title.trim()) || "Bản nháp do AI đề xuất",
        description: `AI tạo theo góp ý: "${instruction.slice(0, 300)}"`,
        promptContent: finalContent,
        basedOnVersionId: base?.id ?? null,
        changeSummary: [recoveryNote, `• ${newSummary}`].filter((s) => s && s.trim()).join("\n\n"),
        createdBy: caller.id,
        createdByName: caller.name ? `${caller.name} (qua AI)` : "AI",
      });
      await rejectOtherDrafts(draft.id).catch(() => {});
    }

    // Nếu xuất phát từ 1 báo lỗi/góp ý → đánh dấu đã có bản nháp.
    if (b.changeRequestId) {
      await setChangeRequestStatus(b.changeRequestId, "drafted", draft.id).catch(() => {});
    }

    res.json({ draft, providerUsed: result.providerUsed });
  } catch (err) {
    console.error("[BrainLab] ai-draft lỗi:", String(err).slice(0, 300));
    res.status(500).json({ error: `Tạo bản nháp lỗi: ${String(err).slice(0, 200)}` });
  }
});

// ─── TAB 2 (mới): Phân tích screenshot/chữ → card "AI hiểu lỗi này là" ─────────
//
// BƯỚC 1 của luồng chat: nhận ảnh chụp màn hình chat Lulu + mô tả của nhân viên,
// AI ĐỌC ảnh (vision) rồi rút ra 6 trường để nhân viên XÁC NHẬN trước khi tạo nháp.
// KHÔNG tạo draft/change-request ở đây (đó là bước 2, do FE quyết khi user bấm nút).
// Ảnh chỉ dùng TẠM để phân tích — KHÔNG lưu (persist do nhánh "Chỉ lưu góp ý" lo).

const ANALYZE_SYSTEM = `Bạn là trợ lý phân tích lỗi cho "Sale AI Lulu" của Amazing Studio (studio chụp ảnh cưới/beauty/gia đình/mẹ bầu, cho thuê trang phục).
Nhân viên sẽ MÔ TẢ một lỗi của Lulu (bằng chữ) và/hoặc DÁN ẢNH chụp màn hình đoạn chat Messenger nơi Lulu trả lời chưa đúng (CÓ THỂ NHIỀU ẢNH — là các phần nối tiếp của cùng 1 cuộc trò chuyện, hãy đọc theo thứ tự và gộp lại thành một bối cảnh). Việc của bạn: ĐỌC ảnh + chữ, hiểu lỗi, rút ra thông tin để nhân viên XÁC NHẬN.

CHỈ trả về 1 object JSON, KHÔNG markdown, KHÔNG văn bản thừa. JSON gồm đúng các khóa:
- "readable": true nếu ĐỌC ĐƯỢC đủ rõ để hiểu lỗi (đọc được chữ trong ảnh HOẶC nhân viên đã mô tả rõ bằng chữ); false nếu ảnh mờ / không phải đoạn chat / không đủ thông tin.
- "confidence": số 0..1 — mức độ chắc chắn bạn hiểu ĐÚNG lỗi.
- "clarifyQuestion": nếu readable=false hoặc chưa chắc → 1 câu hỏi lại NGẮN, lịch sự, giọng nhân viên (vd "Em chưa đọc rõ nội dung trong ảnh, mình mô tả lỗi ngắn giúp em nha."). Nếu đã rõ thì để chuỗi rỗng "".
- "issueTitle": tiêu đề ngắn gọn của lỗi (vd "Lulu gửi ảnh cưới khi khách hỏi beauty").
- "exampleCustomerMessage": câu KHÁCH đã nhắn (trích từ ảnh nếu đọc được; rỗng nếu không có).
- "currentWrongBehavior": Lulu ĐANG làm SAI gì.
- "expectedBehavior": lần sau Lulu NÊN làm ĐÚNG thế nào.
- "affectedRules": mảng tên KHỐI LUẬT bị ảnh hưởng, chọn trong: "chọn đúng nhóm ảnh/link", "hỏi nhu cầu trước khi báo giá", "xử lý concept lạ", "văn phong nói chuyện", "gửi ảnh mẫu", "gửi ảnh bảng giá", "chuyển người thật". Rỗng nếu không chắc.
- "suggestedChangeSummary": 1-2 câu gợi ý nên sửa bộ luật theo hướng nào.

QUY TẮC:
- TUYỆT ĐỐI KHÔNG bịa. Ảnh mờ / không đọc được chữ / không phải đoạn chat → readable=false, confidence thấp, điền clarifyQuestion, các trường còn lại để rỗng.
- Chỉ có chữ mô tả (không ảnh) mà đủ rõ → readable=true, confidence theo mức rõ ràng.
- Giọng tiếng Việt tự nhiên, ngắn gọn.`;

const FALLBACK_CLARIFY = "Em chưa đọc rõ nội dung trong ảnh, mình mô tả lỗi ngắn giúp em nha.";

export type ScreenshotAnalysis = {
  readable: boolean;
  confidence: number;
  clarifyQuestion: string;
  issueTitle: string;
  exampleCustomerMessage: string;
  currentWrongBehavior: string;
  expectedBehavior: string;
  affectedRules: string[];
  suggestedChangeSummary: string;
};

function clampAnalysis(raw: unknown): ScreenshotAnalysis {
  const r = (raw ?? {}) as Record<string, unknown>;
  const conf = Number(r.confidence);
  const rules = Array.isArray(r.affectedRules)
    ? r.affectedRules.filter((x) => typeof x === "string" && x.trim()).map((s) => String(s).trim().slice(0, 80))
    : [];
  return {
    readable: Boolean(r.readable),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    clarifyQuestion: String(r.clarifyQuestion ?? "").slice(0, 400),
    issueTitle: String(r.issueTitle ?? "").slice(0, 300),
    exampleCustomerMessage: String(r.exampleCustomerMessage ?? "").slice(0, 1000),
    currentWrongBehavior: String(r.currentWrongBehavior ?? "").slice(0, 1000),
    expectedBehavior: String(r.expectedBehavior ?? "").slice(0, 1000),
    affectedRules: rules.slice(0, 8),
    suggestedChangeSummary: String(r.suggestedChangeSummary ?? "").slice(0, 1000),
  };
}

/** Parse JSON-substring chịu lỗi (giống sale-vision). Fail → fallback "đọc không rõ". */
function parseAnalysis(text: string): ScreenshotAnalysis {
  const fallback: ScreenshotAnalysis = {
    readable: false, confidence: 0, clarifyQuestion: FALLBACK_CLARIFY,
    issueTitle: "", exampleCustomerMessage: "", currentWrongBehavior: "",
    expectedBehavior: "", affectedRules: [], suggestedChangeSummary: "",
  };
  const jsonText = (text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  try {
    const a = clampAnalysis(JSON.parse(jsonText.slice(start, end + 1)));
    // AI bảo readable nhưng không có câu hỏi lại mà cũng chẳng hiểu được gì → coi như chưa rõ.
    if (a.readable && !a.issueTitle && !a.currentWrongBehavior) {
      return { ...a, readable: false, clarifyQuestion: a.clarifyQuestion || FALLBACK_CLARIFY };
    }
    return a;
  } catch {
    return fallback;
  }
}

const ANALYZE_MEDIA_WHITELIST = ["image/jpeg", "image/png", "image/webp"];
const ANALYZE_MAX_BASE64 = 8 * 1024 * 1024; // ~6MB ảnh; FE đã nén webp nên chỉ là lưới chặn.
const ANALYZE_MAX_IMAGES = 6;               // đoạn chat dài → cho gửi nhiều tấm (chặn để khỏi quá nặng/đắt).

router.post("/lulu-brain/analyze-screenshot", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const b = (req.body ?? {}) as {
    text?: string; imageBase64?: string; imageMediaType?: string;
    images?: Array<{ imageBase64?: string; dataBase64?: string; imageMediaType?: string; mediaType?: string }>;
  };
  const text = (b.text ?? "").trim();

  // Gom ảnh: ưu tiên mảng images[] (NHIỀU tấm cho đoạn chat dài), fallback ảnh đơn imageBase64 (tương thích cũ).
  const rawList = Array.isArray(b.images) && b.images.length
    ? b.images.map((x) => ({ data: x.imageBase64 ?? x.dataBase64 ?? "", mediaType: x.imageMediaType ?? x.mediaType ?? "" }))
    : (b.imageBase64 ? [{ data: b.imageBase64, mediaType: b.imageMediaType ?? "" }] : []);

  if (!text && rawList.length === 0) return res.status(400).json({ error: "Nhập mô tả lỗi hoặc dán ảnh đoạn chat giúp em nha." });
  if (rawList.length > ANALYZE_MAX_IMAGES) return res.status(400).json({ error: `Tối đa ${ANALYZE_MAX_IMAGES} ảnh mỗi lần — mình gộp hoặc gửi bớt giúp em nha.` });

  // Validate + tách base64 từng ảnh (chấp nhận cả data URL lẫn base64 thuần).
  const images: Array<{ mediaType: string; dataBase64: string }> = [];
  for (const it of rawList) {
    const mediaType = (it.mediaType || "image/jpeg").trim().toLowerCase();
    if (!ANALYZE_MEDIA_WHITELIST.includes(mediaType)) return res.status(400).json({ error: "Ảnh chỉ nhận jpg, png hoặc webp." });
    const dataBase64 = (it.data ?? "").replace(/^data:[^;]+;base64,/, "").trim();
    if (!dataBase64) return res.status(400).json({ error: "Có ảnh không hợp lệ." });
    if (dataBase64.length > ANALYZE_MAX_BASE64) return res.status(400).json({ error: "Có ảnh quá lớn — mình chụp gọn hoặc gửi ảnh nhẹ hơn nha." });
    images.push({ mediaType, dataBase64 });
  }
  const hasImage = images.length > 0;

  if (!(process.env.ANTHROPIC_API_KEY ?? "").trim()) {
    return res.status(400).json({ error: "Chưa cấu hình ANTHROPIC_API_KEY trong .env" });
  }

  try {
    const userMsg = text
      ? `Nhân viên mô tả lỗi: "${text}".${hasImage ? ` Kèm ${images.length} ảnh chụp màn hình đoạn chat ở trên (có thể là nhiều phần nối tiếp của cùng 1 cuộc trò chuyện — đọc theo thứ tự).` : ""}\nHãy phân tích và trả về JSON theo đúng cấu trúc.`
      : `Đây là ${images.length} ảnh chụp màn hình đoạn chat Lulu trả lời chưa đúng (có thể là nhiều phần nối tiếp của cùng 1 cuộc trò chuyện — đọc theo thứ tự, tổng hợp lại). Hãy đọc, phân tích và trả về JSON theo đúng cấu trúc.`;

    const result = await callChat({
      system: ANALYZE_SYSTEM,
      messages: [{ role: "user", content: userMsg, ...(hasImage ? { images } : {}) }],
      maxTokens: 900,
      timeoutMs: 45000,           // vision đọc ảnh ~5-30s
      jsonMode: true,             // OpenAI fallback dùng; Claude bỏ qua → parse JSON-substring bên dưới
      label: "brain-lab-analyze",
    });
    if (!result.ok) {
      const detail = (result as { adminAlert?: string }).adminAlert ?? result.reason;
      console.error(`[BrainLab] analyze callChat FAIL: reason=${result.reason} detail=${detail}`);
      // Không chặn UX: trả nhánh "đọc không rõ" để FE hỏi lại thay vì báo lỗi đỏ.
      return res.json({ analysis: parseAnalysis(""), providerUsed: null });
    }
    res.json({ analysis: parseAnalysis(result.text), providerUsed: result.providerUsed });
  } catch (err) {
    console.error("[BrainLab] analyze-screenshot lỗi:", String(err).slice(0, 300));
    res.json({ analysis: parseAnalysis(""), providerUsed: null });
  }
});

// ─── TAB 4: Test chatbot (bản nháp + so sánh với bản đang chạy) ────────────────

router.post("/lulu-brain/test", async (req, res) => {
  // Bọc TOÀN BỘ trong try/catch: trước đây requireStaff/getVersion nằm ngoài try → lỗi DB tạm thời
  // (vd lúc server vừa restart) thoát ra thành "Lỗi 500" trống. Giờ mọi lỗi → 502 kèm lời nhắn thử lại.
  try {
    if (!(await requireStaff(req, res))) return;
    const b = (req.body ?? {}) as {
      message?: string;
      messages?: Array<{ direction?: string; text?: string }>;
      imageBase64?: string; imageMediaType?: string;
      draftVersionId?: number;
      compareWithActive?: boolean;
    };
    const message = (b.message ?? "").trim();
    const hasImage = !!(b.imageBase64 ?? "").trim();
    if (!message && !hasImage) return res.status(400).json({ error: "Thiếu nội dung tin nhắn hoặc ảnh" });
    if (!(process.env.ANTHROPIC_API_KEY ?? "").trim()) {
      return res.status(400).json({ error: "Chưa cấu hình ANTHROPIC_API_KEY trong .env" });
    }

    const prior = Array.isArray(b.messages)
      ? b.messages.filter((m) => m && typeof m.text === "string" && m.text.trim())
          .map((m) => ({ direction: m.direction === "outgoing" ? "outgoing" as const : "incoming" as const, message: String(m.text).trim() }))
      : [];

    // Bộ luật + override ẢNH của bản nháp cần test (override lấy từ rulesJson của chính nháp đó).
    let draftRules: string | null = null;
    let draftVersionId: number | null = null;
    let draftOverrides: ImageOverride[] = [];
    if (b.draftVersionId) {
      const d = await getVersion(b.draftVersionId);
      if (!d) return res.status(404).json({ error: "Không tìm thấy bản nháp để test" });
      draftRules = d.promptContent;
      draftVersionId = d.id;
      draftOverrides = parseImageOverrides(d.rulesJson);
    }
    console.log(`[BrainLab] testVersion versionId=${draftVersionId ?? "active"} isDraft=${draftRules != null} compareWithActive=${b.compareWithActive !== false}`);
    // Override của bản ĐANG CHẠY THẬT (để cột so sánh "Đang chạy" cũng đúng với thực tế).
    const activeOverrides = b.compareWithActive !== false ? await getActiveImageOverrides() : [];

    const common = { message, prior, imageBase64: b.imageBase64, imageMediaType: b.imageMediaType };
    // Chạy song song: bản nháp (nếu có) + bản đang chạy thật (để so sánh — TAB 4).
    const [draft, active] = await Promise.all([
      draftRules != null ? simulateReply({ ...common, brainRules: draftRules, imageOverrides: draftOverrides }) : Promise.resolve(null),
      b.compareWithActive !== false ? simulateReply({ ...common, brainRules: null, imageOverrides: activeOverrides }) : Promise.resolve(null),
    ]);
    res.json({ draft, active, draftVersionId });
  } catch (err) {
    console.error("[BrainLab] test lỗi:", String(err).slice(0, 300));
    if (!res.headersSent) res.status(502).json({ error: `Test bị lỗi tạm thời, mình thử gửi lại nha. (${String((err as Error)?.message ?? err).slice(0, 150)})` });
  }
});

// Lưu kết quả test (Pass/Fail + ghi chú) — TAB 4.
router.post("/lulu-brain/test-result", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const b = (req.body ?? {}) as {
    brainVersionId?: number; testCaseId?: number; actualReply?: string;
    detectedIntent?: string; sampleImages?: string[]; passed?: boolean; failReason?: string;
  };
  if (!b.brainVersionId) return res.status(400).json({ error: "Thiếu brainVersionId" });
  try {
    const result = await saveTestResult({
      brainVersionId: b.brainVersionId,
      testCaseId: b.testCaseId ?? null,
      actualReply: b.actualReply ?? "",
      detectedIntent: b.detectedIntent ?? null,
      sampleImages: b.sampleImages ?? [],
      passed: b.passed ?? null,
      failReason: b.failReason ?? null,
      createdBy: caller.id,
    });
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: String(err).slice(0, 200) });
  }
});

// ─── PHẦN 7: Áp dụng bản nháp (CHỈ ADMIN) ─────────────────────────────────────

router.post("/lulu-brain/versions/:id/apply", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireAdmin(caller, res)) return;
  const out = await applyDraftVersion(Number(req.params.id), caller.id, caller.name);
  if (!out.ok) return res.status(400).json({ error: out.error, missingMarkers: out.missingMarkers });
  console.log(`[BrainLab] APPLY version id=${req.params.id} by=${caller.name ?? caller.id}`);
  res.json({ version: out.version });
});

// ─── PHẦN 8: Khôi phục version (CHỈ ADMIN) ────────────────────────────────────

router.post("/lulu-brain/versions/:id/rollback", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireAdmin(caller, res)) return;
  const { note } = (req.body ?? {}) as { note?: string };
  const out = await rollbackToVersion(Number(req.params.id), caller.id, caller.name, note);
  if (!out.ok) return res.status(400).json({ error: out.error });
  console.log(`[BrainLab] ROLLBACK to version id=${req.params.id} by=${caller.name ?? caller.id}`);
  res.json({ version: out.version });
});

// ─── Change Request (báo lỗi / góp ý) ─────────────────────────────────────────

router.get("/lulu-brain/change-requests", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  try {
    const items = await listChangeRequests((req.query.status as ChangeRequestStatus | "all") || "all");
    // RIÊNG TƯ ẢNH KHÁCH: screenshot có thể chứa tên/SĐT khách → CHỈ admin xem được thumbnail.
    const safe = caller.isAdmin ? items : items.map((it) => ({ ...it, screenshotUrl: null }));
    res.json({ items: safe });
  } catch (err) {
    res.status(500).json({ error: String(err).slice(0, 200) });
  }
});

router.post("/lulu-brain/change-requests", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const b = (req.body ?? {}) as {
    issueTitle?: string; issueDescription?: string; exampleCustomerMessage?: string;
    expectedBehavior?: string; currentWrongBehavior?: string; screenshotUrl?: string;
  };
  if (!b.issueTitle || !b.issueTitle.trim()) return res.status(400).json({ error: "Thiếu tiêu đề lỗi/góp ý" });
  try {
    const item = await createChangeRequest({
      requesterId: caller.id, requesterName: caller.name,
      issueTitle: b.issueTitle, issueDescription: b.issueDescription ?? "",
      exampleCustomerMessage: b.exampleCustomerMessage ?? null,
      expectedBehavior: b.expectedBehavior ?? null,
      currentWrongBehavior: b.currentWrongBehavior ?? null,
      screenshotUrl: b.screenshotUrl ?? null,
    });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: String(err).slice(0, 200) });
  }
});

router.patch("/lulu-brain/change-requests/:id", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const { status, linkedVersionId } = (req.body ?? {}) as { status?: ChangeRequestStatus; linkedVersionId?: number };
  if (!status) return res.status(400).json({ error: "Thiếu status" });
  const item = await setChangeRequestStatus(Number(req.params.id), status, linkedVersionId ?? null);
  if (!item) return res.status(404).json({ error: "Không tìm thấy" });
  res.json({ item });
});

// ─── PHẦN 6: Test cases ───────────────────────────────────────────────────────

router.get("/lulu-brain/test-cases", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    const cases = await listTestCases();
    res.json({ cases });
  } catch (err) {
    res.status(500).json({ error: String(err).slice(0, 200) });
  }
});

router.get("/lulu-brain/test-cases/:id", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  const c = await getTestCase(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Không tìm thấy test case" });
  res.json({ case: c });
});

router.post("/lulu-brain/test-cases", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const b = (req.body ?? {}) as {
    title?: string; customerMessage?: string; expectedIntent?: string; expectedBehavior?: string;
    mustNotDo?: string; serviceGroupExpected?: string; isRequired?: boolean;
    priorContext?: Array<{ direction: "incoming" | "outgoing"; text: string }>;
  };
  if (!b.title || !b.customerMessage) return res.status(400).json({ error: "Thiếu tiêu đề hoặc câu khách" });
  try {
    const created = await createTestCase({
      title: b.title, customerMessage: b.customerMessage,
      expectedIntent: b.expectedIntent ?? null, expectedBehavior: b.expectedBehavior ?? null,
      mustNotDo: b.mustNotDo ?? null, serviceGroupExpected: b.serviceGroupExpected ?? null,
      isRequired: b.isRequired ?? true, priorContext: b.priorContext ?? [],
    });
    res.json({ case: created });
  } catch (err) {
    res.status(500).json({ error: String(err).slice(0, 200) });
  }
});

router.delete("/lulu-brain/test-cases/:id", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  if (!requireAdmin(caller, res)) return;
  const ok = await deleteTestCase(Number(req.params.id));
  res.json({ success: ok });
});

// ─── KHO ẢNH + "Admin dạy Lulu chọn ảnh" ─────────────────────────────────────

/** GET /lulu-brain/image-store — duyệt/tìm/lọc kho ảnh (album/đồ thuê/ý tưởng/bảng giá) để admin chọn ảnh đúng. */
router.get("/lulu-brain/image-store", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    const q = req.query as Record<string, string | undefined>;
    const validKinds = ["album", "rental", "idea", "price"] as const;
    const kinds = q.kinds
      ? (q.kinds.split(",").map((s) => s.trim()).filter((s): s is (typeof validKinds)[number] => (validKinds as readonly string[]).includes(s)))
      : undefined;
    const result = await browseImageStore({
      intent: q.intent ?? null,
      tone: q.tone ?? null,
      album: q.album ?? null,
      tag: q.tag ?? null,
      q: q.q ?? null,
      albumId: q.albumId ? Number(q.albumId) : null,
      kinds: kinds && kinds.length ? kinds : undefined,
      limit: q.limit ? Number(q.limit) : 120,
    });
    res.json(result);
  } catch (err) {
    console.error("[BrainLab] image-store lỗi:", String(err).slice(0, 200));
    res.status(500).json({
      error: "Không tải được kho ảnh",
      debug: { reason: "api_error", message: `API lỗi: ${String(err).slice(0, 160)}` },
    });
  }
});

const MAX_CORRECT_IMAGES = 4;

/**
 * POST /lulu-brain/image-feedback — admin lưu "ảnh đúng" cho 1 tình huống vào BẢN NHÁP.
 * Chưa có nháp → tự tạo từ bản đang chạy (gom 1 bản nháp, giống ai-draft). KHÔNG đụng bản chạy thật.
 */
router.post("/lulu-brain/image-feedback", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const b = (req.body ?? {}) as {
    customerQuestion?: string; intent?: string | null; tone?: string | null;
    wrongImages?: string[]; correctImages?: OverrideImage[]; editedText?: string | null;
    responseMode?: string | null;
  };
  const correctImages = (Array.isArray(b.correctImages) ? b.correctImages : [])
    .filter((im) => im && typeof im.imageUrl === "string" && im.imageUrl.trim())
    .slice(0, MAX_CORRECT_IMAGES)
    .map((im) => ({
      imageUrl: String(im.imageUrl).trim(),
      title: String(im.title ?? "").trim() || "Ảnh mẫu",
      detailUrl: im.detailUrl ? String(im.detailUrl).trim() : undefined,
      sourceType: String(im.sourceType ?? "gallery"),
      serviceIntent: im.serviceIntent ? String(im.serviceIntent) : undefined,
    }));
  const fbEditedText = b.editedText != null && String(b.editedText).trim() ? String(b.editedText).trim() : null;
  const rmIn = b.responseMode != null ? String(b.responseMode) : null;
  const fbResponseMode: ImageOverride["responseMode"] =
    (rmIn === "exact_reply" || rmIn === "learn_from_this") && fbEditedText ? rmIn : null;
  // Cho lưu nếu CÓ ảnh đúng HOẶC có ghim text (câu sửa tay + chế độ dùng câu). Không có gì để dạy → 400.
  if (correctImages.length === 0 && !fbResponseMode) {
    return res.status(400).json({ error: "Hãy chọn ít nhất 1 ảnh đúng, hoặc sửa lời Lulu bằng tay rồi chọn cách Lulu dùng câu đó." });
  }

  try {
    await ensureBrainLabTables();
    // Bảo đảm có bản nháp đang mở (gom mọi feedback vào 1 nháp).
    let draft = await getOpenDraftVersion();
    if (!draft) {
      const active = await getActiveVersion();
      if (!active) return res.status(400).json({ error: "Chưa có bản đang chạy để tạo bản nháp." });
      draft = await createDraftVersion({
        title: `Nháp dạy ảnh (từ Version ${active.versionNumber})`,
        description: "Tự tạo khi admin lưu feedback ảnh đầu tiên.",
        promptContent: active.promptContent,
        rulesJson: active.rulesJson,
        basedOnVersionId: active.id,
        changeSummary: "Bản nháp khởi tạo để dạy Lulu chọn ảnh đúng.",
        createdBy: caller.id,
        createdByName: caller.name,
      });
      await rejectOtherDrafts(draft.id).catch(() => {});
    }

    const override: ImageOverride = {
      id: `ov_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      customerQuestion: String(b.customerQuestion ?? "").slice(0, 1000),
      intent: b.intent != null && String(b.intent).trim() ? String(b.intent).trim() : null,
      tone: b.tone != null && String(b.tone).trim() ? String(b.tone).trim() : null,
      wrongImages: Array.isArray(b.wrongImages) ? b.wrongImages.map((u) => String(u)).filter(Boolean).slice(0, 8) : [],
      correctImages,
      editedText: fbEditedText,
      responseMode: fbResponseMode,
      createdAt: new Date().toISOString(),
      createdByName: caller.name,
    };

    const r = await appendImageOverrideToDraft(draft.id, override);
    if (!r.version) return res.status(400).json({ error: "Không lưu được vào bản nháp (chỉ lưu được vào bản nháp draft)." });
    res.json({ draft: r.version, totalOverrides: r.total, override });
  } catch (err) {
    console.error("[BrainLab] image-feedback lỗi:", String(err).slice(0, 300));
    res.status(500).json({ error: `Lưu feedback ảnh lỗi: ${String(err).slice(0, 200)}` });
  }
});

export default router;
