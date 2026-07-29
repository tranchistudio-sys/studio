import type { SaleAction, SaleStage } from "./sale-workflow";

/**
 * Lulu Sale Scenario Manager — KIỂU DỮ LIỆU + DANH MỤC nhãn tiếng Việt.
 *
 * Nguyên tắc (chốt với chủ studio 29/07):
 *  - Chủ studio sửa thẻ bằng TIẾNG VIỆT đời thường (chip/chọn), KHÔNG thấy JSON/enum/regex.
 *  - Thẻ chỉ được BỔ SUNG giới hạn (thêm cấm/kiến thức/lời dẫn) — KHÔNG nới lỏng Core Rules.
 *  - Scenario Manager là TẦNG DỮ LIỆU đặt TRÊN Workflow V1: Router/Validator vẫn quyết cuối.
 *  - Module này THUẦN (không DB/AI/IO) → unit-test 100%.
 */

// ─── Trigger: "KHI KHÁCH..." (map 1-1 sang MessageSignals của sale-workflow) ──

export type TriggerKey =
  | "hoi_gia"          // hỏi giá
  | "xin_bang_gia"     // xin gửi bảng giá
  | "xin_xem_mau"      // muốn xem ảnh mẫu/concept
  | "chao_hoi"         // chỉ chào hỏi
  | "tin_cut"          // ack cụt / "còn đó không"
  | "hoi_chi_tiet_goi" // gói gồm những gì
  | "hoi_dia_chi_gio"  // địa chỉ / giờ làm
  | "hoi_coc_thanh_toan" // cọc / thanh toán
  | "doi_gap_nguoi"    // đòi gặp người thật
  | "cho_sdt"          // để lại số điện thoại
  | "muon_giu_lich"    // muốn giữ lịch / kiểm tra lịch
  | "chot_goi"         // chốt mua gói
  | "che_gia_xin_giam" // chê giá / xin giảm (escalation giá)
  // ── V2 (Sales Brain — 12 loại khách chưa chốt) ──
  | "hoi_chong_gia_dinh" // "để chị hỏi chồng/gia đình" (ASK_PARTNER)
  | "xin_suy_nghi"       // "để chị suy nghĩ thêm" (NEED_TIME)
  | "dang_ban"           // "đang bận, tí nói" (BUSY)
  | "tham_khao_them"     // "để tham khảo thêm vài chỗ" (JUST_BROWSING)
  | "khong_tin_anh_that" // "ảnh thật hay ảnh mẫu đó" (NOT_TRUST_YET)
  | "chua_biet_gu"       // "chưa biết chụp kiểu gì" (STYLE_UNCERTAIN)
  | "xin_giam_them"      // "bớt được không em" (DISCOUNT_REQUEST)
  | "hoi_ngan_sach"      // "tầm bao nhiêu thì đủ" (BUDGET_CONCERN)
  | "so_sanh_ben_khac"   // "bên kia rẻ hơn" (COMPARE_COMPETITOR)
  | "bat_ky";          // tin bất kỳ (thẻ nền)

export const TRIGGER_LABELS: Record<TriggerKey, string> = {
  hoi_gia: "hỏi giá",
  xin_bang_gia: "xin bảng giá",
  xin_xem_mau: "muốn xem ảnh mẫu / concept",
  chao_hoi: "chào hỏi / mở lời",
  tin_cut: "nhắn tin cụt (ok, dạ…) / hỏi còn đó không",
  hoi_chi_tiet_goi: "hỏi gói gồm những gì",
  hoi_dia_chi_gio: "hỏi địa chỉ / giờ làm",
  hoi_coc_thanh_toan: "hỏi cọc / thanh toán",
  doi_gap_nguoi: "muốn gặp người thật",
  cho_sdt: "để lại số điện thoại",
  muon_giu_lich: "muốn giữ lịch / kiểm tra lịch",
  chot_goi: "chốt chọn gói",
  che_gia_xin_giam: "chê giá cao / xin giảm giá",
  hoi_chong_gia_dinh: "cần hỏi chồng / gia đình",
  xin_suy_nghi: "xin thời gian suy nghĩ",
  dang_ban: "đang bận, hẹn nói sau",
  tham_khao_them: "chỉ tham khảo thêm",
  khong_tin_anh_that: "lo ảnh không như hình",
  chua_biet_gu: "chưa biết gu / kiểu chụp",
  xin_giam_them: "hỏi bớt / giảm được không",
  hoi_ngan_sach: "lo ngân sách / hỏi gói rẻ",
  so_sanh_ben_khac: "so sánh bên khác rẻ hơn",
  bat_ky: "bất kỳ tin nào (thẻ nền)",
};

// ─── Điều kiện trạng thái (đọc từ Thread State) — nhãn VN trên UI ─────────────

export type CondTri = "yes" | "no" | "any";

export type ScenarioConditions = {
  /** Nhóm dịch vụ đã rõ chưa. */
  serviceIntent: "known" | "unknown" | "any";
  /** Trạng thái ngày chụp. */
  dateStatus: "known" | "not_decided" | "unset" | "any";
  /** Đã từng báo giá gói nào chưa. */
  quoted: CondTri;
  /** Có phải tin đầu tiên của khách không. */
  firstContact: CondTri;
};

export const CONDITION_LABELS = {
  serviceIntent: {
    known: "đã rõ nhóm dịch vụ",
    unknown: "chưa rõ nhóm dịch vụ",
    any: "nhóm dịch vụ: không bắt buộc",
  },
  dateStatus: {
    known: "đã có ngày chụp",
    not_decided: "đã nói CHƯA chốt ngày",
    unset: "chưa nhắc tới ngày",
    any: "ngày chụp: không bắt buộc",
  },
  quoted: { yes: "đã được báo giá", no: "chưa được báo giá", any: "báo giá: không bắt buộc" },
  firstContact: { yes: "là tin nhắn đầu tiên", no: "không phải tin đầu", any: "tin đầu: không bắt buộc" },
} as const;

// ─── "LULU LÀM GÌ CHÍNH" — nhãn VN → SaleAction (14 action hiện có) ───────────

export type ActionKey =
  | "theo_he_thong"      // để hệ thống tự chọn (engine)
  | "chao_hoi" | "hoi_nhu_cau" | "dao_sau_gu" | "hoi_ngay" | "bao_gia_tham_khao"
  | "bao_gia_chinh_thuc" | "gui_bang_gia" | "gui_anh_mau" | "tra_loi_cau_hoi"
  | "xu_ly_ban_khoan" | "moi_giu_lich" | "hoi_sdt" | "chuyen_nguoi_that" | "dap_nhe_cho";

export const ACTION_KEY_TO_SALE_ACTION: Record<ActionKey, SaleAction | null> = {
  theo_he_thong: null,
  chao_hoi: "GREET",
  hoi_nhu_cau: "ASK_SERVICE",
  dao_sau_gu: "IDENTIFY_SERVICE",
  hoi_ngay: "ASK_DATE",
  bao_gia_tham_khao: "QUOTE_REFERENCE",
  bao_gia_chinh_thuc: "QUOTE_EXACT",
  gui_bang_gia: "SEND_PRICE",
  gui_anh_mau: "SEND_SAMPLE",
  tra_loi_cau_hoi: "ANSWER_FAQ",
  xu_ly_ban_khoan: "HANDLE_OBJECTION",
  moi_giu_lich: "ASK_FOR_BOOKING",
  hoi_sdt: "ASK_PHONE",
  chuyen_nguoi_that: "ESCALATE_HUMAN",
  dap_nhe_cho: "WAIT",
};

export const ACTION_LABELS: Record<ActionKey, string> = {
  theo_he_thong: "để hệ thống tự chọn",
  chao_hoi: "chào hỏi, mở chuyện",
  hoi_nhu_cau: "hỏi khách cần dịch vụ gì",
  dao_sau_gu: "đào sâu gu / loại dịch vụ",
  hoi_ngay: "hỏi ngày chụp (đúng luật)",
  bao_gia_tham_khao: "báo giá tham khảo",
  bao_gia_chinh_thuc: "báo giá chính thức",
  gui_bang_gia: "gửi ảnh bảng giá",
  gui_anh_mau: "gửi ảnh mẫu",
  tra_loi_cau_hoi: "trả lời câu hỏi (FAQ)",
  xu_ly_ban_khoan: "xử lý băn khoăn / chê giá",
  moi_giu_lich: "mời giữ lịch",
  hoi_sdt: "xin số điện thoại",
  chuyen_nguoi_that: "chuyển người thật",
  dap_nhe_cho: "đáp nhẹ, chờ khách",
};

// ─── "ĐỪNG BAO GIỜ..." — cấm BỔ SUNG (union với Core Rules, không thay thế) ───

export type ForbiddenKey =
  // Chủ studio thêm/bớt được:
  | "hoi_lai_ngay" | "ep_giu_lich" | "hoi_sdt_som" | "gui_lai_bang_gia" | "spam_anh"
  | "hoi_don_nhieu_cau" | "noi_xau_ben_khac"
  // 🔒 CORE — luôn bật, UI chỉ hiển thị khoá, KHÔNG gỡ được:
  | "tu_giam_gia" | "bia_gia" | "bia_khuyen_mai" | "tu_chot_coc" | "lo_noi_bo" | "ban_tiep_khi_chuyen_nguoi";

export const CORE_FORBIDDEN_KEYS: ForbiddenKey[] = [
  "tu_giam_gia", "bia_gia", "bia_khuyen_mai", "tu_chot_coc", "lo_noi_bo", "ban_tiep_khi_chuyen_nguoi",
];

export const FORBIDDEN_LABELS: Record<ForbiddenKey, string> = {
  hoi_lai_ngay: "hỏi lại ngày chụp",
  ep_giu_lich: "ép giữ lịch / dồn khách",
  hoi_sdt_som: "xin số điện thoại quá sớm",
  gui_lai_bang_gia: "gửi lại bảng giá đã gửi",
  spam_anh: "gửi quá nhiều ảnh một lượt",
  hoi_don_nhieu_cau: "hỏi dồn nhiều câu",
  noi_xau_ben_khac: "nói xấu bên khác",
  tu_giam_gia: "tự giảm giá (khoá an toàn)",
  bia_gia: "bịa giá ngoài bảng giá (khoá an toàn)",
  bia_khuyen_mai: "bịa khuyến mãi (khoá an toàn)",
  tu_chot_coc: "tự xác nhận tiền cọc (khoá an toàn)",
  lo_noi_bo: "lộ ghi chú nội bộ (khoá an toàn)",
  ban_tiep_khi_chuyen_nguoi: "bán tiếp khi phải chuyển người (khoá an toàn)",
};

/** Cấm bổ sung → hiệu ứng máy: action bị loại / câu hỏi bị cấm thêm. */
export const FORBIDDEN_EFFECTS: Record<ForbiddenKey, { actions?: SaleAction[]; questions?: string[] }> = {
  hoi_lai_ngay: { actions: ["ASK_DATE"], questions: ["ask_date"] },
  ep_giu_lich: { actions: ["ASK_FOR_BOOKING"] },
  hoi_sdt_som: { actions: ["ASK_PHONE"], questions: ["ask_phone"] },
  gui_lai_bang_gia: { actions: ["SEND_PRICE"] },
  spam_anh: { actions: [] },       // nhắc trong guidance; hệ thống sẵn chống gửi lại ảnh
  hoi_don_nhieu_cau: { actions: [] }, // validator too_many_questions đã chặn cứng
  noi_xau_ben_khac: { actions: [] },
  // Core: hiệu lực nằm ở Validator/Router (self_discount, price_mismatch, leak_internal,
  // escalate_but_selling, BOOKING_INTENT luôn bàn giao người) — ghi ở đây để trace/giải thích.
  tu_giam_gia: { questions: ["self_discount"] },
  bia_gia: {},
  bia_khuyen_mai: { questions: ["self_discount"] },
  tu_chot_coc: {},
  lo_noi_bo: {},
  ban_tiep_khi_chuyen_nguoi: {},
};

// ─── "CẦN BIẾT..." — loại kiến thức (không cho nhập query kỹ thuật) ───────────

export type KnowledgeKey =
  | "bang_gia" | "anh_mau" | "chi_tiet_goi" | "dat_lich" | "dia_chi_gio"
  | "danh_muc_dich_vu" | "diem_manh";

export const KNOWLEDGE_LABELS: Record<KnowledgeKey, string> = {
  bang_gia: "bảng giá đúng nhóm",
  anh_mau: "ảnh mẫu đúng nhóm",
  chi_tiet_goi: "thành phần chi tiết gói",
  dat_lich: "thông tin đặt lịch",
  dia_chi_gio: "địa chỉ & giờ làm",
  danh_muc_dich_vu: "danh mục dịch vụ",
  diem_manh: "điểm mạnh / giá trị studio",
};

/** Map loại kiến thức → khoá knowledgeNeeded của Router (đúng convention sẵn có). */
export function knowledgeKeysToNeeded(keys: KnowledgeKey[], intent: string | null): string[] {
  const i = intent ?? "all";
  const out: string[] = [];
  for (const k of keys ?? []) {
    if (k === "bang_gia") out.push(`pricing:${i}`);
    else if (k === "anh_mau") out.push(`gallery:${i}`);
    else if (k === "chi_tiet_goi") out.push(`pricing:${i}`, "faq:package_detail");
    else if (k === "dat_lich") out.push("booking");
    else if (k === "dia_chi_gio") out.push("faq:address", "faq:hours");
    else if (k === "danh_muc_dich_vu") out.push("services:menu");
    else if (k === "diem_manh") out.push("value_points");
  }
  return [...new Set(out)];
}

// ─── Thẻ kịch bản (nguồn sự thật: card = máy đọc được + hiển thị VN từ catalog) ─

export type ScenarioCard = {
  name: string;
  description: string;
  /** KHI KHÁCH... — chọn từ TRIGGER_LABELS. */
  triggers: TriggerKey[];
  conditions: ScenarioConditions;
  /** Dữ liệu bắt buộc phải có mới vào thẻ (thiếu → thẻ không match). */
  requiredSlots: Array<"service_intent" | "event_date">;
  /** LULU LÀM GÌ CHÍNH (theo_he_thong = engine tự chọn). */
  primaryAction: ActionKey;
  /** LULU NÊN... (lời dẫn tự do, tiếng Việt — đưa vào prompt như HƯỚNG DẪN, không ép đọc y nguyên). */
  guidance: string;
  /** ĐỪNG BAO GIỜ... (bổ sung — core luôn tự áp). */
  forbiddenExtra: ForbiddenKey[];
  /** CẦN BIẾT... */
  knowledge: KnowledgeKey[];
  /** CÂU KẾT GỢI Ý. */
  closingLine: string;
  /** ĐIỀU KIỆN THOÁT (hiển thị cho người vận hành — không dùng để match). */
  exitConditions: string[];
  /** CHUYỂN SANG KỊCH BẢN... */
  nextScenarios: Array<{ whenVn: string; scenarioKey: string }>;
};

/** Bản ghi scenario đầy đủ (DB row đã map). */
export type ScenarioRecord = {
  id: number;
  scenarioKey: string;
  sortOrder: number;                 // ưu tiên: nhỏ = cao (kéo thả trên UI)
  status: "draft" | "active" | "archived";
  enabled: boolean;
  isCore: boolean;                   // thẻ lõi: không archive được
  version: number;
  card: ScenarioCard;                // nội dung ACTIVE đang chạy
  draftCard: ScenarioCard | null;    // bản nháp đang sửa (null = không có nháp)
  runCount: number;
  lastRunAt: string | null;
  lastTestResult: string | null;
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Định nghĩa scenario cho Resolver (đã "compile" từ card ACTIVE). */
export type ScenarioDef = {
  key: string;
  name: string;
  priority: number;
  enabled: boolean;
  triggers: TriggerKey[];
  conditions: ScenarioConditions;
  requiredSlots: Array<"service_intent" | "event_date">;
  primaryAction: import("./sale-workflow").SaleAction | null;
  forbiddenExtra: ForbiddenKey[];
  knowledge: KnowledgeKey[];
  guidance: string;
  closingLine: string;
  nextScenarios: Array<{ whenVn: string; scenarioKey: string }>;
};

export function cardToDef(key: string, card: ScenarioCard, priority: number, enabled: boolean): ScenarioDef {
  // Card từ DB (JSONB) có thể bẩn/thiếu field (sửa tay SQL, drift) — default MỌI field
  // để resolver không bao giờ crash vì dữ liệu (fail-open là hợp đồng số 1).
  const c = (card?.conditions ?? {}) as Partial<ScenarioConditions>;
  return {
    key,
    name: card?.name ?? key,
    priority,
    enabled,
    triggers: card?.triggers ?? [],
    conditions: {
      serviceIntent: c.serviceIntent ?? "any",
      dateStatus: c.dateStatus ?? "any",
      quoted: c.quoted ?? "any",
      firstContact: c.firstContact ?? "any",
    },
    requiredSlots: card?.requiredSlots ?? [],
    primaryAction: ACTION_KEY_TO_SALE_ACTION[card?.primaryAction as ActionKey] ?? null,
    forbiddenExtra: card?.forbiddenExtra ?? [],
    knowledge: card?.knowledge ?? [],
    guidance: card?.guidance ?? "",
    closingLine: card?.closingLine ?? "",
    nextScenarios: card?.nextScenarios ?? [],
  };
}

// ─── Feature flags (mặc định TẮT — an toàn tuyệt đối) ─────────────────────────

const on = (v: string | undefined) => /^(1|true|yes)$/i.test((v ?? "").trim());

/** Bật trang quản lý + API CRUD (không đụng luồng trả lời). */
export function isScenarioManagerEnabled(): boolean {
  return on(process.env.LULU_SCENARIO_MANAGER_ENABLED);
}
/** Shadow: resolver chạy song song CHỈ GHI TRACE, không đổi câu trả lời. */
export function isScenarioShadowEnabled(): boolean {
  return on(process.env.LULU_SCENARIO_SHADOW_ENABLED);
}
/** Enforce pilot: thẻ thật sự lái prompt — CHỈ cho PSID trong allowlist. */
export function isScenarioEnforceEnabledFor(psid: string): boolean {
  if (!on(process.env.LULU_SCENARIO_ENFORCE_ENABLED)) return false;
  const raw = (process.env.LULU_SCENARIO_PSIDS ?? "").trim();
  if (!raw) return false; // enforce BẮT BUỘC có allowlist — không bao giờ mở toàn bộ
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(psid);
}
