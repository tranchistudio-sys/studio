import {
  type ScenarioCard, type TriggerKey, type ForbiddenKey, type KnowledgeKey, type ActionKey,
  TRIGGER_LABELS, FORBIDDEN_LABELS, KNOWLEDGE_LABELS, ACTION_LABELS, CORE_FORBIDDEN_KEYS,
} from "./sale-scenario-types";

/**
 * "Compiler" thẻ kịch bản — KIỂM TRA + CHUẨN HOÁ trước khi lưu/áp dụng.
 *
 * Vai trò an toàn (chốt với chủ studio):
 *  - Thẻ vi phạm Core Rules → KHÔNG cho áp dụng, giải thích TIẾNG VIỆT + gợi ý sửa cụ thể.
 *  - Core Rules nằm trong CODE (Router/Validator) — thẻ không bao giờ tắt được; compiler chỉ
 *    chặn sớm để chủ không lưu nhầm nội dung vô hiệu.
 *  - Thuần (không DB/AI) → unit-test 100%.
 */

export type CardIssue = { field: string; message: string; suggest?: string };
export type CompileResult = { ok: boolean; errors: CardIssue[]; warnings: CardIssue[]; card: ScenarioCard };

const VALID_TRIGGERS = new Set(Object.keys(TRIGGER_LABELS));
const VALID_FORBIDDEN = new Set(Object.keys(FORBIDDEN_LABELS));
const VALID_KNOWLEDGE = new Set(Object.keys(KNOWLEDGE_LABELS));
const VALID_ACTIONS = new Set(Object.keys(ACTION_LABELS));
const VALID_SLOTS = new Set(["service_intent", "event_date"]);

function normStrArr(v: unknown, valid?: Set<string>): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x ?? "").trim()).filter((x) => x && (!valid || valid.has(x))))];
}

// ─── Quét nội dung tự do (guidance/closing) tìm vi phạm Core Rules ────────────
// Deterministic regex — không gọi AI chấm AI. Check trên text đã bỏ dấu.

function normalizeVi(text: string): string {
  return (text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

// Tự giảm giá / tự tạo ưu đãi trong lời dẫn ("giảm 10%", "bớt cho khách 200k", "tặng riêng...").
const SELF_DISCOUNT_TEXT_RE =
  /(giam\s*\d+\s*(%|phan tram|k\b|tr\b)|bot (cho|them)|giam (cho|them|ngay|luon)|khuyen mai rieng|uu dai rieng|tang rieng|tu giam|giam gia cho khach)/;
// Con số tiền cụ thể trong lời dẫn — giá phải lấy từ bảng giá, không hard-code vào thẻ.
const MONEY_IN_TEXT_RE = /(\d{1,3}([.,]\d{3}){2,3}|\d+\s*(trieu|tr\b)|\d{2,4}\s*k\b)/;
// Tự chốt cọc / xác nhận thanh toán trong lời dẫn.
const SELF_DEPOSIT_TEXT_RE = /(xac nhan (da )?(coc|thanh toan|chuyen khoan)|chot coc|nhan coc|so tai khoan|stk\b)/;

export function scanGuidanceViolations(text: string): CardIssue[] {
  // Bỏ các mệnh đề PHỦ ĐỊNH ("KHÔNG tự giảm giá", "tuyệt đối không báo số tài khoản"…)
  // trước khi quét — đó là lời DẶN CẤM đúng ý luật lõi, không phải yêu cầu vi phạm.
  const t = normalizeVi(text ?? "").replace(/(tuyet doi )?(khong|dung|cam)\b[^.;,\n]*/g, " ");
  const issues: CardIssue[] = [];
  if (SELF_DISCOUNT_TEXT_RE.test(t)) {
    issues.push({
      field: "guidance",
      message: "Nội dung yêu cầu Lulu tự giảm giá / tự tạo ưu đãi — hệ thống không cho phép Lulu tự quyết giá.",
      suggest: "Dùng giá trong bảng giá, hoặc viết: 'nói để em hỏi quản lý giúp mình' rồi chuyển nhân viên xác nhận.",
    });
  }
  if (MONEY_IN_TEXT_RE.test(t)) {
    issues.push({
      field: "guidance",
      message: "Nội dung chứa con số tiền cụ thể — giá phải lấy tự động từ bảng giá, không ghi cứng vào thẻ (giá đổi sẽ bị sai).",
      suggest: "Bỏ con số tiền; tick 'bảng giá đúng nhóm' ở phần CẦN BIẾT để hệ thống tự nạp giá đúng.",
    });
  }
  if (SELF_DEPOSIT_TEXT_RE.test(t)) {
    issues.push({
      field: "guidance",
      message: "Nội dung yêu cầu Lulu tự chốt / xác nhận tiền cọc — việc tiền bạc luôn phải do nhân viên thật xác nhận.",
      suggest: "Đổi thành: xin ngày + số điện thoại rồi hẹn nhân viên liên hệ xác nhận giữ chỗ.",
    });
  }
  return issues;
}

// ─── Kiểm tra & chuẩn hoá 1 thẻ ───────────────────────────────────────────────

export function compileCard(raw: unknown): CompileResult {
  const errors: CardIssue[] = [];
  const warnings: CardIssue[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;

  const name = String(r.name ?? "").trim().slice(0, 150);
  if (!name) errors.push({ field: "name", message: "Thẻ chưa có tên tình huống.", suggest: "Đặt tên ngắn gọn, vd: 'Khách hỏi giá nhưng chưa biết ngày'." });

  const triggers = normStrArr(r.triggers, VALID_TRIGGERS) as TriggerKey[];
  if (triggers.length === 0) {
    errors.push({
      field: "triggers",
      message: "Thẻ chưa chọn 'KHI KHÁCH...' nào — Lulu sẽ không biết lúc nào dùng thẻ này.",
      suggest: "Chọn ít nhất 1 tình huống khách, vd 'hỏi giá' hoặc 'muốn xem ảnh mẫu'.",
    });
  }

  const condRaw = (r.conditions ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allow: T[], dft: T): T =>
    allow.includes(String(v ?? "") as T) ? (String(v) as T) : dft;
  const conditions = {
    serviceIntent: pick(condRaw.serviceIntent, ["known", "unknown", "any"], "any"),
    dateStatus: pick(condRaw.dateStatus, ["known", "not_decided", "unset", "any"], "any"),
    quoted: pick(condRaw.quoted, ["yes", "no", "any"], "any"),
    firstContact: pick(condRaw.firstContact, ["yes", "no", "any"], "any"),
  } as ScenarioCard["conditions"];

  const requiredSlots = normStrArr(r.requiredSlots, VALID_SLOTS) as ScenarioCard["requiredSlots"];
  const primaryAction = (VALID_ACTIONS.has(String(r.primaryAction ?? "")) ? String(r.primaryAction) : "theo_he_thong") as ActionKey;
  const guidance = String(r.guidance ?? "").trim().slice(0, 4000);
  const closingLine = String(r.closingLine ?? "").trim().slice(0, 500);
  const description = String(r.description ?? "").trim().slice(0, 1000);
  const forbiddenExtra = normStrArr(r.forbiddenExtra, VALID_FORBIDDEN).filter(
    (k) => !CORE_FORBIDDEN_KEYS.includes(k as ForbiddenKey), // core không lưu vào extra — luôn tự áp
  ) as ForbiddenKey[];
  const knowledge = normStrArr(r.knowledge, VALID_KNOWLEDGE) as KnowledgeKey[];
  const exitConditions = (Array.isArray(r.exitConditions) ? r.exitConditions : [])
    .map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12);
  const nextScenarios = (Array.isArray(r.nextScenarios) ? r.nextScenarios : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { whenVn: String(o.whenVn ?? "").trim().slice(0, 200), scenarioKey: String(o.scenarioKey ?? "").trim() };
    })
    .filter((x) => x.scenarioKey)
    .slice(0, 10);

  // ── Mâu thuẫn Core Rules (chặn cứng, giải thích VN) ──
  if (primaryAction === "hoi_ngay" && conditions.dateStatus === "not_decided") {
    errors.push({
      field: "primaryAction",
      message: "Thẻ bảo Lulu HỎI NGÀY trong khi điều kiện là khách ĐÃ NÓI chưa chốt ngày — luật an toàn cấm hỏi lại ngày lúc này.",
      suggest: "Đổi hành động chính sang 'báo giá tham khảo', hoặc bỏ điều kiện 'đã nói chưa chốt ngày'.",
    });
  }
  if (primaryAction === "hoi_ngay" && conditions.dateStatus === "known") {
    errors.push({
      field: "primaryAction",
      message: "Thẻ bảo Lulu HỎI NGÀY trong khi khách ĐÃ CHO ngày — hỏi lại sẽ làm khách khó chịu, luật an toàn không cho phép.",
      suggest: "Đổi hành động chính, hoặc đổi điều kiện ngày.",
    });
  }
  if (primaryAction === "bao_gia_chinh_thuc" && conditions.dateStatus !== "known") {
    errors.push({
      field: "primaryAction",
      message: "'Báo giá chính thức' cần khách ĐÃ CÓ ngày (đủ dữ liệu). Thẻ này chưa yêu cầu điều đó — dễ báo giá thiếu căn cứ.",
      suggest: "Đặt điều kiện 'đã có ngày chụp', hoặc đổi sang 'báo giá tham khảo'.",
    });
  }
  if ((primaryAction === "bao_gia_tham_khao" || primaryAction === "bao_gia_chinh_thuc" || primaryAction === "gui_bang_gia" || primaryAction === "gui_anh_mau")
      && conditions.serviceIntent === "unknown") {
    errors.push({
      field: "primaryAction",
      message: `Thẻ bảo Lulu '${ACTION_LABELS[primaryAction]}' trong khi điều kiện là CHƯA RÕ nhóm dịch vụ — gửi giá/ảnh khi chưa rõ nhóm là gửi bừa.`,
      suggest: "Đổi điều kiện thành 'đã rõ nhóm dịch vụ', hoặc đổi hành động thành 'hỏi khách cần dịch vụ gì'.",
    });
  }
  const conflictForbidden: Array<[ActionKey, ForbiddenKey]> = [
    ["hoi_ngay", "hoi_lai_ngay"], ["moi_giu_lich", "ep_giu_lich"],
    ["hoi_sdt", "hoi_sdt_som"], ["gui_bang_gia", "gui_lai_bang_gia"],
  ];
  for (const [a, f] of conflictForbidden) {
    if (primaryAction === a && forbiddenExtra.includes(f)) {
      errors.push({
        field: "forbiddenExtra",
        message: `Thẻ vừa bảo Lulu '${ACTION_LABELS[a]}' vừa cấm '${FORBIDDEN_LABELS[f]}' — mâu thuẫn, Lulu không làm được.`,
        suggest: "Bỏ một trong hai: đổi hành động chính hoặc bỏ điều cấm tương ứng.",
      });
    }
  }

  // Quét MỌI kênh text tự do sẽ vào prompt (tên + mô tả + lời dẫn + câu kết) tìm vi phạm
  // (giảm giá tự tạo, giá cứng, tự chốt cọc) — buildScenarioGuidanceBlock chèn cả `name`
  // vào prompt nên name cũng phải qua lưới quét (chặn prompt-injection qua ai-draft).
  for (const issue of scanGuidanceViolations(`${name}\n${description}\n${guidance}\n${closingLine}`)) errors.push(issue);

  const card: ScenarioCard = {
    name, description, triggers, conditions, requiredSlots, primaryAction,
    guidance, forbiddenExtra, knowledge, closingLine, exitConditions, nextScenarios,
  };
  return { ok: errors.length === 0, errors, warnings, card };
}

// ─── Kiểm tra CẢ BỘ thẻ (tham chiếu chuyển tiếp + vòng lặp không lối thoát) ───

export type EnsembleIssue = CardIssue & { scenarioKey: string };

export function validateEnsemble(
  cards: Array<{ key: string; card: ScenarioCard }>,
): { ok: boolean; errors: EnsembleIssue[]; warnings: EnsembleIssue[] } {
  const errors: EnsembleIssue[] = [];
  const warnings: EnsembleIssue[] = [];
  const keys = new Set(cards.map((c) => c.key));

  for (const { key, card } of cards) {
    for (const n of card.nextScenarios ?? []) {
      if (!keys.has(n.scenarioKey)) {
        errors.push({
          scenarioKey: key, field: "nextScenarios",
          message: `Thẻ '${card.name}' chuyển tiếp sang kịch bản '${n.scenarioKey}' nhưng kịch bản đó không tồn tại.`,
          suggest: "Chọn lại kịch bản chuyển tiếp trong danh sách, hoặc xoá dòng chuyển tiếp này.",
        });
      }
      if (n.scenarioKey === key) {
        errors.push({
          scenarioKey: key, field: "nextScenarios",
          message: `Thẻ '${card.name}' tự chuyển tiếp sang chính nó — vòng lặp không có lối thoát.`,
          suggest: "Chọn kịch bản khác hoặc xoá dòng chuyển tiếp này.",
        });
      }
    }
  }

  // Vòng lặp giữa các thẻ mà KHÔNG thẻ nào trong vòng có điều kiện thoát → chặn.
  const byKey = new Map(cards.map((c) => [c.key, c.card]));
  const visiting = new Set<string>(); const done = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const dfs = (k: string) => {
    if (done.has(k)) return;
    if (visiting.has(k)) {
      const i = stack.indexOf(k);
      if (i >= 0) cycles.push(stack.slice(i));
      return;
    }
    visiting.add(k); stack.push(k);
    for (const n of byKey.get(k)?.nextScenarios ?? []) if (byKey.has(n.scenarioKey)) dfs(n.scenarioKey);
    stack.pop(); visiting.delete(k); done.add(k);
  };
  for (const { key } of cards) dfs(key);
  for (const cyc of cycles) {
    const noExit = cyc.every((k) => (byKey.get(k)?.exitConditions ?? []).length === 0);
    const names = cyc.map((k) => byKey.get(k)?.name ?? k).join(" → ");
    if (noExit) {
      errors.push({
        scenarioKey: cyc[0], field: "nextScenarios",
        message: `Các thẻ tạo thành vòng lặp (${names}) mà không thẻ nào có ĐIỀU KIỆN THOÁT — khách sẽ bị dẫn lòng vòng.`,
        suggest: "Thêm điều kiện thoát cho ít nhất 1 thẻ trong vòng, hoặc bỏ bớt chuyển tiếp.",
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
