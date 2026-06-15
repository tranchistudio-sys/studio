import { pool } from "@workspace/db";

/**
 * Cài đặt Claude Sale — NGUỒN CẤU HÌNH DUY NHẤT cho cả Claude Sale Test lẫn
 * Facebook Messenger (cả hai đều gọi chung askClaudeForReply() trong claude-sale.ts).
 *
 * AN TOÀN: file này CHỈ đọc/ghi bảng cấu hình của riêng module chatbot.
 * KHÔNG đụng booking, lịch, tài chính, dữ liệu khách hàng hay logic CRM.
 *
 * getClaudeSaleSettings() nằm trên luồng trả lời SỐNG (Messenger) → TUYỆT ĐỐI
 * không bao giờ throw: mọi lỗi DB đều fallback về mặc định (giống sale-context.ts).
 */

// ─── Kiểu dữ liệu cấu hình ────────────────────────────────────────────────────

/** Một bước trong quy trình sale (admin sửa được phần dẫn dắt, không sửa rào giá). */
export type SaleStep = { title: string; content: string };

export type ClaudeSaleSettings = {
  // A. THÔNG TIN NHÂN VIÊN AI
  aiName: string;
  aiGender: "female" | "male";
  aiRole: string;

  // B. PHONG CÁCH GIAO TIẾP (bật/tắt)
  styleSelfEm: boolean;            // xưng "em"
  styleAddressByContext: boolean;  // gọi anh/chị theo ngữ cảnh
  styleNoQuyKhach: boolean;        // không dùng "quý khách"
  styleNoRepeatAnhChi: boolean;    // không lặp "anh/chị" liên tục
  styleNoRobot: boolean;           // không văn phong robot
  styleNoMarkdown: boolean;        // không markdown
  styleNoAsterisk: boolean;        // không dấu **
  styleNoLongBullets: boolean;     // không bullet dài dòng

  // C. TỐC ĐỘ TRẢ LỜI — delay (giây) theo độ dài tin KHÁCH gửi
  delayU10: number;       // < 10 ký tự
  delay10_20: number;     // 10–20 ký tự
  delay20_30: number;     // 20–30 ký tự
  delay30_40: number;     // 30–40 ký tự
  delayO40: number;       // > 40 ký tự
  delayRandom30: boolean;  // random ±30% cho giống người thật  // khách nhắn dài → tự tăng delay

  // D. MỨC ĐỘ SALE (1..5)
  saleLevel: 1 | 2 | 3 | 4 | 5;

  // E. GỬI ẢNH MẪU (bật/tắt) — sau này đọc ảnh thật từ CMS
  imgConcept: boolean;
  imgWedding: boolean;
  imgBeauty: boolean;
  imgPregnancy: boolean;
  imgFamily: boolean;
  imgDress: boolean;

  // F. GỬI LINK (bật/tắt)
  linkWebsite: boolean;
  linkFanpage: boolean;
  linkAlbum: boolean;
  linkPricing: boolean;

  // G. QUY TRÌNH SALE (7 bước — admin sửa nội dung dẫn dắt từng bước)
  saleSteps: SaleStep[];

  // H. KẾT NỐI CHATBOT
  connectClaudeTest: boolean;
  connectMessenger: boolean;
  connectZalo: boolean;            // luôn false — chưa hoạt động

  // J. ĐỌC LỊCH THÔNG MINH (CHỈ ĐỌC — không tạo/sửa/hủy booking)
  calendarEnabled: boolean;        // cho phép Claude đọc & phân tích lịch
  calBeautyBasicH: number;         // beauty cơ bản (giờ)
  calBeautyMultiMinH: number;      // beauty nhiều layout — tối thiểu
  calBeautyMultiMaxH: number;      // beauty nhiều layout — tối đa
  calBeautyVipH: number;           // beauty VIP
  calStudioBasicH: number;         // chụp cổng / album cơ bản
  calStudioMultiH: number;         // nhiều trang phục
  calStudioVipH: number;           // VIP
  calGapH: number;                 // giờ nghỉ giữa các show
  calWeekendCaution: boolean;      // T7/CN phải kiểm tra kỹ, không khẳng định
  calWindowDays: number;           // số ngày lịch sắp tới đưa cho Claude đọc
};

// ─── Mặc định ────────────────────────────────────────────────────────────────

export const DEFAULT_SALE_STEPS: SaleStep[] = [
  { title: "Chào hỏi", content: "Khách mới vào / chưa rõ nhu cầu: chào ngắn gọn, tự giới thiệu tên + Amazing Studio, hỏi đang quan tâm dịch vụ nào (cưới, beauty, gia đình…). Mỗi câu một bubble, cách nhau một dòng trống." },
  { title: "Khai thác nhu cầu", content: "Khi khách nói rõ nhu cầu (cưới / beauty / gia đình / thuê váy / chụp tiệc): phản hồi ngắn ghi nhận rồi hỏi đúng 1 câu về phong cách/gu, gợi ý vài lựa chọn ngay trong câu." },
  { title: "Gửi ảnh mẫu / concept", content: "Sau khi biết gu, gửi link bộ ảnh / concept thật phù hợp (chỉ từ dữ liệu có sẵn), rồi hỏi khách có thích kiểu này không. Chưa ưng thì gửi concept khác." },
  { title: "Báo giá", content: "Khi khách hỏi giá: KHÔNG hỏi ngược, gửi ngay các gói liên quan (tên + giá ngắn gọn). Muốn xem chi tiết thì gửi nguyên thành phần gói từ dữ liệu, không tóm tắt, không bịa." },
  { title: "Xử lý phản đối", content: "Khách phân vân/chê giá/so sánh: đồng cảm, nêu giá trị (chất lượng, ekip, quà tặng), gửi thêm bằng chứng (ảnh thật, link). Khách xin giảm → nói để em hỏi quản lý giúp, không tự giảm." },
  { title: "Xin số điện thoại", content: "Khi khách đã quan tâm / có ý định: xin tên + số điện thoại để nhân viên giữ lịch và tư vấn kỹ. KHÔNG tự đặt lịch, KHÔNG hứa chắc còn lịch ngày cụ thể." },
  { title: "Hẹn nhân viên", content: "Sau khi có SĐT / khách cần hỗ trợ sâu: hẹn nhân viên sẽ liên hệ lại tư vấn & kiểm tra lịch. Việc chốt cọc / khiếu nại → mời để lại số điện thoại, sẽ có người hỗ trợ." },
];

export function defaultClaudeSaleSettings(): ClaudeSaleSettings {
  return {
    aiName: "Hoa",
    aiGender: "female",
    aiRole: "Nhân viên tư vấn Amazing Studio",

    styleSelfEm: true,
    styleAddressByContext: true,
    styleNoQuyKhach: true,
    styleNoRepeatAnhChi: true,
    styleNoRobot: true,
    styleNoMarkdown: true,
    styleNoAsterisk: true,
    styleNoLongBullets: true,

    delayU10: 2,
    delay10_20: 4,
    delay20_30: 6,
    delay30_40: 8,
    delayO40: 11,
    delayRandom30: true,

    saleLevel: 3,

    imgConcept: true,
    imgWedding: true,
    imgBeauty: true,
    imgPregnancy: true,
    imgFamily: true,
    imgDress: true,

    linkWebsite: true,
    linkFanpage: true,
    linkAlbum: true,
    linkPricing: true,

    saleSteps: DEFAULT_SALE_STEPS.map((s) => ({ ...s })),

    connectClaudeTest: true,
    connectMessenger: true,
    connectZalo: false,

    calendarEnabled: true,
    calBeautyBasicH: 3,
    calBeautyMultiMinH: 4,
    calBeautyMultiMaxH: 5,
    calBeautyVipH: 6,
    calStudioBasicH: 3,
    calStudioMultiH: 5,
    calStudioVipH: 6,
    calGapH: 1,
    calWeekendCaution: true,
    calWindowDays: 21,
  };
}

// ─── Chuẩn hóa (an toàn với dữ liệu cũ / thiếu field) ─────────────────────────

export function normalizeClaudeSaleSettings(raw: unknown): ClaudeSaleSettings {
  const d = defaultClaudeSaleSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const s = raw as Record<string, unknown>;
  const str = (v: unknown, fb: string): string => (typeof v === "string" && v.trim() ? v : fb);
  const bool = (v: unknown, fb: boolean): boolean => (typeof v === "boolean" ? v : fb);
  const num = (v: unknown, fb: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
  };

  const gender = s.aiGender === "male" ? "male" : "female";
  const levelNum = Number(s.saleLevel);
  const saleLevel = ([1, 2, 3, 4, 5] as const).includes(levelNum as 1 | 2 | 3 | 4 | 5)
    ? (levelNum as ClaudeSaleSettings["saleLevel"])
    : d.saleLevel;

  // Quy trình: giữ tối đa 7 bước, mỗi bước có title + content; thiếu thì lấy mặc định.
  let saleSteps: SaleStep[];
  if (Array.isArray(s.saleSteps) && s.saleSteps.length > 0) {
    saleSteps = (s.saleSteps as unknown[]).slice(0, 7).map((step, i) => {
      const st = (step ?? {}) as Record<string, unknown>;
      return {
        title: str(st.title, DEFAULT_SALE_STEPS[i]?.title ?? `Bước ${i + 1}`),
        content: str(st.content, DEFAULT_SALE_STEPS[i]?.content ?? ""),
      };
    });
  } else {
    saleSteps = d.saleSteps;
  }

  return {
    aiName: str(s.aiName, d.aiName),
    aiGender: gender,
    aiRole: str(s.aiRole, d.aiRole),

    styleSelfEm: bool(s.styleSelfEm, d.styleSelfEm),
    styleAddressByContext: bool(s.styleAddressByContext, d.styleAddressByContext),
    styleNoQuyKhach: bool(s.styleNoQuyKhach, d.styleNoQuyKhach),
    styleNoRepeatAnhChi: bool(s.styleNoRepeatAnhChi, d.styleNoRepeatAnhChi),
    styleNoRobot: bool(s.styleNoRobot, d.styleNoRobot),
    styleNoMarkdown: bool(s.styleNoMarkdown, d.styleNoMarkdown),
    styleNoAsterisk: bool(s.styleNoAsterisk, d.styleNoAsterisk),
    styleNoLongBullets: bool(s.styleNoLongBullets, d.styleNoLongBullets),

    delayU10: num(s.delayU10, d.delayU10, 0, 120),
    delay10_20: num(s.delay10_20, d.delay10_20, 0, 120),
    delay20_30: num(s.delay20_30, d.delay20_30, 0, 120),
    delay30_40: num(s.delay30_40, d.delay30_40, 0, 120),
    delayO40: num(s.delayO40, d.delayO40, 0, 120),
    delayRandom30: bool(s.delayRandom30, d.delayRandom30),

    saleLevel,

    imgConcept: bool(s.imgConcept, d.imgConcept),
    imgWedding: bool(s.imgWedding, d.imgWedding),
    imgBeauty: bool(s.imgBeauty, d.imgBeauty),
    imgPregnancy: bool(s.imgPregnancy, d.imgPregnancy),
    imgFamily: bool(s.imgFamily, d.imgFamily),
    imgDress: bool(s.imgDress, d.imgDress),

    linkWebsite: bool(s.linkWebsite, d.linkWebsite),
    linkFanpage: bool(s.linkFanpage, d.linkFanpage),
    linkAlbum: bool(s.linkAlbum, d.linkAlbum),
    linkPricing: bool(s.linkPricing, d.linkPricing),

    saleSteps,

    connectClaudeTest: bool(s.connectClaudeTest, d.connectClaudeTest),
    connectMessenger: bool(s.connectMessenger, d.connectMessenger),
    connectZalo: false,

    calendarEnabled: bool(s.calendarEnabled, d.calendarEnabled),
    calBeautyBasicH: num(s.calBeautyBasicH, d.calBeautyBasicH, 1, 24),
    calBeautyMultiMinH: num(s.calBeautyMultiMinH, d.calBeautyMultiMinH, 1, 24),
    calBeautyMultiMaxH: num(s.calBeautyMultiMaxH, d.calBeautyMultiMaxH, 1, 24),
    calBeautyVipH: num(s.calBeautyVipH, d.calBeautyVipH, 1, 24),
    calStudioBasicH: num(s.calStudioBasicH, d.calStudioBasicH, 1, 24),
    calStudioMultiH: num(s.calStudioMultiH, d.calStudioMultiH, 1, 24),
    calStudioVipH: num(s.calStudioVipH, d.calStudioVipH, 1, 24),
    calGapH: num(s.calGapH, d.calGapH, 0, 8),
    calWeekendCaution: bool(s.calWeekendCaution, d.calWeekendCaution),
    calWindowDays: num(s.calWindowDays, d.calWindowDays, 1, 60),
  };
}

// ─── Bảng + đọc/ghi (singleton id=1) ──────────────────────────────────────────

let createdTable = false;
export async function ensureClaudeSaleSettingsTable(): Promise<void> {
  if (createdTable) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS claude_sale_settings (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      config      JSONB NOT NULL,
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by  INTEGER,
      CONSTRAINT claude_sale_settings_singleton CHECK (id = 1)
    )
  `);
  createdTable = true;
}

let cache: { value: ClaudeSaleSettings; at: number } | null = null;
const TTL_MS = 30 * 1000;

export function clearClaudeSaleSettingsCache(): void {
  cache = null;
}

/**
 * Cấu hình hiện tại (mặc định nếu chưa lưu). KHÔNG bao giờ throw — lỗi DB → mặc định.
 */
export async function getClaudeSaleSettings(): Promise<ClaudeSaleSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    await ensureClaudeSaleSettingsTable();
    const r = await pool.query(`SELECT config FROM claude_sale_settings WHERE id = 1`);
    const value = r.rows.length > 0
      ? normalizeClaudeSaleSettings(r.rows[0].config)
      : defaultClaudeSaleSettings();
    cache = { value, at: Date.now() };
    return value;
  } catch (err) {
    console.error("[ClaudeSale] getClaudeSaleSettings — dùng mặc định:", String(err).slice(0, 200));
    return defaultClaudeSaleSettings();
  }
}

export async function saveClaudeSaleSettings(
  settings: ClaudeSaleSettings,
  updatedBy?: number | null,
): Promise<ClaudeSaleSettings> {
  await ensureClaudeSaleSettingsTable();
  const normalized = normalizeClaudeSaleSettings(settings);
  await pool.query(
    `INSERT INTO claude_sale_settings (id, config, updated_at, updated_by)
     VALUES (1, $1, NOW(), $2)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(normalized), updatedBy ?? null],
  );
  clearClaudeSaleSettingsCache();
  return normalized;
}

// ─── Tốc độ trả lời: delay (ms) theo độ dài tin KHÁCH ─────────────────────────

/**
 * Tính delay trước khi AI trả lời, dựa trên SỐ KÝ TỰ tin khách gửi + cấu hình.
 * Áp dụng cho cả Claude Sale Test lẫn chatbot Fanpage. Đọc 100% từ settings.
 *   < 10 / 10–20 / 20–30 / 30–40 / > 40 ký tự → giây tương ứng.
 *   delayRandom30: ngẫu nhiên ±30% (vd 10s → 7–13s) cho giống người thật.
 */
export function computeReplyDelayMs(customerMessage: string, s: ClaudeSaleSettings): number {
  const len = (customerMessage ?? "").trim().length;
  let seconds: number;
  if (len < 10) seconds = s.delayU10;
  else if (len < 20) seconds = s.delay10_20;
  else if (len < 30) seconds = s.delay20_30;
  else if (len < 40) seconds = s.delay30_40;
  else seconds = s.delayO40;
  let ms = Math.max(0, seconds) * 1000;
  if (s.delayRandom30) ms = ms * (0.7 + Math.random() * 0.6); // ±30%
  return Math.round(ms);
}

// ─── Dựng khối prompt từ cấu hình ─────────────────────────────────────────────

const GENDER_LABEL: Record<ClaudeSaleSettings["aiGender"], string> = {
  female: "Nữ",
  male: "Nam",
};

const SALE_LEVEL_GUIDE: Record<number, string> = {
  1: "MỨC 1 — Chỉ trả lời đúng câu khách hỏi, không hỏi thêm, không chủ động dẫn dắt.",
  2: "MỨC 2 — Trả lời câu hỏi rồi hỏi thêm 1 câu để hiểu nhu cầu.",
  3: "MỨC 3 — Chủ động tư vấn: vừa trả lời vừa gợi ý gói/concept phù hợp và dẫn khách sang bước kế.",
  4: "MỨC 4 — Chủ động tư vấn và chủ động xin số điện thoại khi khách đã quan tâm.",
  5: "MỨC 5 — Bán chủ động tối đa: dẫn khách đi hết quy trình, chủ động xin SĐT và hẹn nhân viên để chốt lịch (vẫn không tự đặt booking).",
};

/**
 * Khối prompt persona/phong cách/quy trình dựng từ cấu hình.
 * KHÔNG chứa rào an toàn giá & dữ liệu — phần đó do claude-sale.ts chèn cố định sau.
 */
export function buildSettingsPromptBlock(s: ClaudeSaleSettings): string {
  const name = s.aiName.trim() || "Hoa";
  const role = s.aiRole.trim() || "Nhân viên tư vấn Amazing Studio";
  const genderText = GENDER_LABEL[s.aiGender];

  const styleLines: string[] = [];
  if (s.styleSelfEm) styleLines.push(`Xưng "em", tên ${name}.`);
  if (s.styleAddressByContext) styleLines.push(`Gọi khách "anh" HOẶC "chị" theo ngữ cảnh (chọn 1, KHÔNG viết "anh/chị"; chưa rõ thì "anh", lộ ra nữ thì "chị").`);
  if (s.styleNoRepeatAnhChi) styleLines.push(`KHÔNG lặp lại "anh/chị" liên tục trong cùng một câu hay nhiều câu liền nhau.`);
  if (s.styleNoQuyKhach) styleLines.push(`KHÔNG dùng "quý khách".`);
  if (s.styleNoRobot) styleLines.push(`KHÔNG văn phong robot/sáo rỗng: tránh "Xin chào anh/chị", "Em sẵn sàng hỗ trợ", "Rất vui được hỗ trợ", "Dạ vâng ạ". Nhắn tự nhiên như người thật.`);
  if (s.styleNoMarkdown) styleLines.push(`KHÔNG dùng markdown (##, __).`);
  if (s.styleNoAsterisk) styleLines.push(`KHÔNG dùng dấu ** để in đậm.`);
  if (s.styleNoLongBullets) styleLines.push(`KHÔNG gạch đầu dòng dài dòng ("-", "•"); viết câu ngắn tự nhiên.`);
  styleLines.push(`Không bao giờ tự nhận là AI/bot/ChatGPT. Mỗi tin 1–3 câu, tách nhiều bubble bằng MỘT DÒNG TRỐNG, mỗi lượt chỉ hỏi 1 câu quan trọng nhất. Emoji nhẹ (😊) được phép.`);

  const stepsText = s.saleSteps
    .map((st, i) => `B${i + 1}. ${st.title.toUpperCase()}: ${st.content.trim()}`)
    .join("\n");

  // Gợi ý ảnh & link được phép gửi (tham chiếu cho Bước gửi ảnh/điều hướng).
  const allowedImgs = [
    s.imgConcept && "ảnh concept",
    s.imgWedding && "ảnh cưới",
    s.imgBeauty && "ảnh beauty",
    s.imgPregnancy && "ảnh bầu",
    s.imgFamily && "ảnh gia đình",
    s.imgDress && "ảnh váy cưới",
  ].filter(Boolean) as string[];
  const allowedLinks = [
    s.linkWebsite && "website",
    s.linkFanpage && "fanpage",
    s.linkAlbum && "album mẫu",
    s.linkPricing && "bảng giá",
  ].filter(Boolean) as string[];

  const sendBlock = [
    allowedImgs.length
      ? `Khi phù hợp (Bước gửi ảnh), được gửi: ${allowedImgs.join(", ")} — chỉ dùng ảnh/concept CÓ trong dữ liệu, không bịa.`
      : `Hiện KHÔNG gửi ảnh mẫu (tất cả đang tắt).`,
    allowedLinks.length
      ? `Được gửi link: ${allowedLinks.join(", ")} (lấy từ phần LINK trong dữ liệu bên dưới).`
      : `Hiện KHÔNG gửi link.`,
  ].join("\n");

  return `Bạn là ${name.toUpperCase()} — ${role} (chụp ảnh cưới, beauty/thời trang, chụp tiệc cưới, chụp gia đình, cho thuê trang phục cưới). Giới tính: ${genderText}. Bạn đang nhắn tin với khách qua Facebook. Khách PHẢI thấy như đang chat với nhân viên THẬT.

XƯNG HÔ & VĂN PHONG:
${styleLines.map((l) => `- ${l}`).join("\n")}

MỨC ĐỘ CHỦ ĐỘNG BÁN HÀNG:
- ${SALE_LEVEL_GUIDE[s.saleLevel] ?? SALE_LEVEL_GUIDE[3]}

QUY TRÌNH SALE — nhận biết khách đang ở bước nào và dẫn sang bước kế (tùy mức độ chủ động ở trên):
${stepsText}

GỬI ẢNH & LINK:
${sendBlock}`;
}

/** Sentinel Claude chèn khi cần nhân viên thật tiếp quản. Code sẽ tách ra trước khi gửi khách. */
export const NEEDS_HUMAN_MARKER_RE = /<<\s*NEEDS_HUMAN\s*:?\s*([^>]*?)\s*>>/i;

/** Sentinel Claude chèn khi học được tên khách. Code tách ra + lưu lead (nếu tên đang là placeholder). */
export const NAME_MARKER_RE = /<<\s*NAME\s*:?\s*([^>]*?)\s*>>/i;

/**
 * Sentinel Claude chèn khi BÁO GIÁ một gói → hệ thống tự gửi ảnh bảng giá NHÓM của gói đó.
 * Nội dung trong ngoặc là MÃ GÓI (vd ST-LUXURY); nhiều mã cách nhau dấu phẩy.
 * Code tách ra trước khi gửi khách (khách KHÔNG thấy). Khớp toàn cục để lấy nhiều marker.
 */
export const PRICE_IMAGE_MARKER_RE = /<<\s*(?:PRICE_IMAGE|SEND_IMAGE|IMG)\s*:?\s*([^>]*?)\s*>>/i;

/**
 * Quy tắc ĐỌC LỊCH THÔNG MINH (read-only) + escalation. Trả "" nếu tắt tính năng.
 * Số giờ lấy từ cấu hình; phần phrasing & escalation là CỐ ĐỊNH (an toàn).
 */
export function buildCalendarRulesBlock(s: ClaudeSaleSettings): string {
  if (!s.calendarEnabled) return "";
  return `QUY TẮC ĐỌC LỊCH (CHỈ ĐỌC — TUYỆT ĐỐI KHÔNG tạo/sửa/hủy/giữ/khóa booking. Chỉ được đọc, phân tích, đề xuất, và báo nhân viên thật khi cần):

THỜI LƯỢNG ƯỚC TÍNH (để phán đoán đụng giờ):
- Beauty/studio cơ bản: ${s.calBeautyBasicH} giờ. Beauty nhiều layout: ${s.calBeautyMultiMinH}–${s.calBeautyMultiMaxH} giờ. Beauty VIP: ${s.calBeautyVipH} giờ.
- Chụp cổng/album cơ bản: ${s.calStudioBasicH} giờ. Gói nhiều trang phục: ${s.calStudioMultiH} giờ. Gói VIP: ${s.calStudioVipH} giờ.
- Ưu tiên chừa ${s.calGapH} giờ nghỉ giữa các show. Nếu một khung đã có show, đừng đề xuất các giờ trùng/sát; gợi ý khung sau khi show kết thúc + nghỉ.

TIỆC CƯỚI: ưu tiên cao, có thể sáng/chiều/tối, KHÔNG áp dụng quy tắc nghỉ giữa ca. Nếu còn ekip có thể nhận; không chắc thì chuyển nhân viên xác nhận.

NGÀY TRONG TUẦN (Thứ 2→Thứ 6): nếu lịch trống, được phép nói: "Dạ ngày đó hiện tại còn lịch nha 😊".

CUỐI TUẦN (Thứ 7, Chủ nhật): phải kiểm tra kỹ hơn (thường có tiệc cưới / show ngoại cảnh / show lớn). KHÔNG được khẳng định chắc chắn — phải nói: "Dạ để em kiểm tra kỹ lịch ekip ngày đó rồi báo mình ngay nha 😊" và chuyển nhân viên.

KHI LỊCH BỊ ĐỤNG / KHÔNG CHẮC: KHÔNG tự xác nhận. Trả lời: "Để em kiểm tra kỹ lịch ekip rồi báo mình ngay nha 😊" và chuyển nhân viên.

KHI KHÁCH MUỐN ĐẶT LỊCH và em thấy còn trống: chỉ được nói mức "Dạ hiện tại em thấy lịch đang còn trống nha." TUYỆT ĐỐI KHÔNG nói "Em đã giữ lịch cho anh/chị." Không tạo/giữ/khóa lịch.

KHI KHÁCH MUỐN CHUYỂN KHOẢN / ĐẶT CỌC: KHÔNG xác nhận đơn. Trả lời: "Dạ chị đợi em một chút nha, em báo nhân viên xác nhận và gửi thông tin chính xác cho mình ngay ạ." rồi chuyển nhân viên.

ESCALATION — khi gặp BẤT KỲ tình huống sau, hãy trả lời khách bằng câu chuyển tiếp phù hợp ở trên, RỒI ở DÒNG CUỐI thêm đúng dấu hiệu nội bộ: <<NEEDS_HUMAN: lý do ngắn>> (khách KHÔNG thấy dòng này, hệ thống sẽ tách ra và gọi nhân viên thật):
- Khách muốn chuyển khoản / đặt cọc.
- Lịch bị chồng chéo hoặc em không chắc lịch.
- Cuối tuần có quá nhiều show / cần xác nhận ekip.
- Khách yêu cầu gặp người thật.`;
}
