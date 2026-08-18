import { pool } from "@workspace/db";
import { detectDateSlot, botAsksDate, type DateStatus } from "./sale-slots";
import { detectServiceIntentFromText } from "./sale-samples";
import { currentTenantScope } from "./tenant-scope";

/**
 * sale-thread-state.ts — TRÍ NHỚ CÓ CẤU TRÚC theo từng khách (Đợt 2 — nền móng).
 *
 * Bảng lulu_thread_state lưu những gì hội thoại ĐÃ BIẾT (slot ngày, nhu cầu, câu đã hỏi,
 * gói đã báo giá, ảnh đã gửi) để Lulu không hỏi lại / không bung lại thứ đã đưa — thay vì
 * bắt model tự suy từ 20 tin history mỗi lượt.
 *
 * AN TOÀN:
 *  - Bảng RIÊNG, khóa theo facebook_user_id (cùng khóa với crm_leads/claude_sale_lead_flags,
 *    KHÔNG ràng buộc FK). KHÔNG đụng booking/payment/CRM.
 *  - KHÔNG có cờ bot_enabled/escalation ở đây — nguồn sự thật vẫn là crm_leads.ai_mode +
 *    claude_sale_lead_flags (tránh 2 nguồn sự thật, xem sale-human-review.ts).
 *  - FAIL-OPEN: mọi hàm KHÔNG bao giờ throw. Lỗi DB → null/bỏ qua, bot chạy tiếp y như khi
 *    chưa có trí nhớ (khác master switch là fail-closed).
 *  - Toàn bộ gate sau cờ LULU_STATE_ENABLED (mặc định TẮT) — bật ở Deployment env sau khi test.
 *  - DDL: CREATE TABLE IF NOT EXISTS tại đây + được migrations.ts ensure lúc startup + khai báo
 *    drizzle schema (lib/db/src/schema/lulu-brain.ts) — đúng quy trình chống DROP-drift PR #132.
 */

export function isLuluStateEnabled(): boolean {
  return /^(1|true|yes)$/i.test((process.env.LULU_STATE_ENABLED ?? "").trim());
}

/**
 * PHẠM VI THỬ NGHIỆM NHỎ: khi LULU_STATE_PSIDS có giá trị (danh sách psid cách nhau
 * dấu phẩy), trí nhớ CHỈ bật cho đúng các thread đó — pilot trên vài khách trước khi
 * mở toàn bộ. Để trống = áp dụng mọi thread (khi LULU_STATE_ENABLED bật).
 */
export function isLuluStateEnabledFor(psid: string): boolean {
  if (!isLuluStateEnabled()) return false;
  const raw = (process.env.LULU_STATE_PSIDS ?? "").trim();
  if (!raw) return true;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(psid);
}

// ─── Kiểu dữ liệu ─────────────────────────────────────────────────────────────

export type ThreadSlots = {
  date_status?: DateStatus;
  /** YYYY-MM-DD khi khách cho ngày đầy đủ. */
  event_date?: string | null;
  /** Nguyên văn mốc thời gian khách nói (vd "cuối tháng 12"). */
  date_text?: string | null;
};

export type AskedQuestion = { key: string; at: string; count: number };
export type QuotedPackage = { code: string; at: string };
export type SentAssets = { sample_urls?: string[]; price_group_ids?: number[] };

export type ThreadState = {
  facebookUserId: string;
  currentStage: string;
  previousStage: string | null;
  serviceIntent: string | null;
  customerStatus: string;
  lastAction: string | null;
  slots: ThreadSlots;
  askedQuestions: AskedQuestion[];
  quotedPackages: QuotedPackage[];
  sentAssets: SentAssets;
  lastUserMessageAt: string | null;
  lastBotMessageAt: string | null;
  version: number;
};

// Giới hạn kích thước JSONB (chống phình vô hạn ở hội thoại rất dài).
const MAX_ASKED = 50;
const MAX_QUOTED = 30;
const MAX_SAMPLE_URLS = 100;

// ─── Bảng (lazy + được migrations.ts gọi lúc startup) ─────────────────────────

const createdTables = new Set<string>();
export async function ensureThreadStateTable(): Promise<void> {
  const tenantScope = currentTenantScope();
  if (createdTables.has(tenantScope)) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_thread_state (
      id                    SERIAL PRIMARY KEY,
      facebook_user_id      TEXT NOT NULL,
      page_id               TEXT,
      customer_id           INTEGER,
      current_stage         TEXT NOT NULL DEFAULT 'new',
      previous_stage        TEXT,
      service_intent        TEXT,
      customer_status       TEXT NOT NULL DEFAULT 'lead',
      last_action           TEXT,
      slots                 JSONB NOT NULL DEFAULT '{}',
      asked_questions       JSONB NOT NULL DEFAULT '[]',
      quoted_packages       JSONB NOT NULL DEFAULT '[]',
      sent_assets           JSONB NOT NULL DEFAULT '{}',
      last_user_message_at  TIMESTAMP,
      last_bot_message_at   TIMESTAMP,
      version               INTEGER NOT NULL DEFAULT 0,
      created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  // KHÔNG nuốt lỗi CREATE INDEX: unique index là điều kiện sống của mọi câu
  // ON CONFLICT (facebook_user_id) bên dưới. Index fail → throw ra caller (mọi caller
  // đều fail-open) và createdTable KHÔNG được set → lần gọi sau tự thử lại.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lulu_thread_state_user ON lulu_thread_state (facebook_user_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_lulu_thread_state_updated ON lulu_thread_state (updated_at DESC)`,
  );
  createdTables.add(tenantScope);
}

// ─── Đọc ──────────────────────────────────────────────────────────────────────

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function asObject<T extends object>(v: unknown): T {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : ({} as T);
}

/** State hiện tại của thread (null nếu chưa có / lỗi DB / tắt cờ). KHÔNG bao giờ throw. */
export async function getThreadState(psid: string): Promise<ThreadState | null> {
  try {
    await ensureThreadStateTable();
    const r = await pool.query(
      `SELECT facebook_user_id, current_stage, previous_stage, service_intent, customer_status,
              last_action, slots, asked_questions, quoted_packages, sent_assets,
              last_user_message_at, last_bot_message_at, version
         FROM lulu_thread_state WHERE facebook_user_id = $1 LIMIT 1`,
      [psid],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      facebookUserId: row.facebook_user_id,
      currentStage: row.current_stage,
      previousStage: row.previous_stage,
      serviceIntent: row.service_intent,
      customerStatus: row.customer_status,
      lastAction: row.last_action,
      slots: asObject<ThreadSlots>(row.slots),
      askedQuestions: asArray<AskedQuestion>(row.asked_questions),
      quotedPackages: asArray<QuotedPackage>(row.quoted_packages),
      sentAssets: asObject<SentAssets>(row.sent_assets),
      lastUserMessageAt: row.last_user_message_at ? String(row.last_user_message_at) : null,
      lastBotMessageAt: row.last_bot_message_at ? String(row.last_bot_message_at) : null,
      version: Number(row.version) || 0,
    };
  } catch (err) {
    console.error("[LuluState] getThreadState lỗi (fail-open):", String(err).slice(0, 160));
    return null;
  }
}

// ─── Ghi khi KHÁCH nhắn (chạy TRƯỚC khi build prompt để lượt này đọc được) ────

/**
 * Cập nhật state từ tin khách: slot ngày (detectDateSlot — cần biết bot đã hỏi ngày chưa),
 * nhu cầu dịch vụ (detectServiceIntentFromText, chỉ ghi khi có tín hiệu rõ), mốc thời gian.
 * Một câu UPSERT duy nhất, merge JSONB bằng `||` — atomic, không read-modify-write.
 * KHÔNG bao giờ throw.
 */
export async function applyIncomingMessage(psid: string, text: string): Promise<void> {
  try {
    await ensureThreadStateTable();
    const prior = await getThreadState(psid);
    const botAskedDate = (prior?.askedQuestions ?? []).some((q) => q.key === "ask_date");

    const slotPatch: ThreadSlots = {};
    const dateSlot = detectDateSlot(text, { botAskedDate });
    if (dateSlot) {
      slotPatch.date_status = dateSlot.status;
      slotPatch.event_date = dateSlot.eventDate;
      slotPatch.date_text = dateSlot.dateText;
    }

    // Nhu cầu: "khách chủ động nói" thắng giá trị cũ; unknown/new_concept_idea không ghi đè.
    // Tin ảnh "[image:URL]" bỏ qua — URL CDN chứa token ngẫu nhiên ("gym", "bau"...) có thể
    // match nhầm regex intent và đè intent thật (cùng guard với detectDateSlot).
    const intent = text.trim().startsWith("[image:") ? "unknown" : detectServiceIntentFromText(text);
    const intentPatch = intent !== "unknown" && intent !== "new_concept_idea" ? intent : null;

    await pool.query(
      `INSERT INTO lulu_thread_state (facebook_user_id, service_intent, slots, last_user_message_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (facebook_user_id) DO UPDATE SET
         service_intent = COALESCE(EXCLUDED.service_intent, lulu_thread_state.service_intent),
         slots = lulu_thread_state.slots || EXCLUDED.slots,
         last_user_message_at = NOW(),
         version = lulu_thread_state.version + 1,
         updated_at = NOW()`,
      [psid, intentPatch, JSON.stringify(slotPatch)],
    );

    // LOG QUYẾT ĐỊNH (yêu cầu vận hành): trạng thái TRƯỚC + dữ liệu MỚI phát hiện + SAU.
    // 1 dòng/tin khách, chỉ chạy khi bật cờ — soi được trên log Replit.
    const before = { date: prior?.slots.date_status ?? "unknown", intent: prior?.serviceIntent ?? null, botAskedDate };
    const after = {
      date: slotPatch.date_status ?? before.date,
      intent: intentPatch ?? before.intent,
    };
    console.log(
      `[LuluState][in] psid=${psid} before=${JSON.stringify(before)} detected=${JSON.stringify({ slots: slotPatch, intent: intentPatch })} after=${JSON.stringify(after)}`,
    );
  } catch (err) {
    console.error("[LuluState] applyIncomingMessage lỗi (fail-open):", String(err).slice(0, 160));
  }
}

// ─── Ghi sau khi BOT trả lời ──────────────────────────────────────────────────

/** Merge thuần (export để test): tăng count nếu key đã có, thêm mới nếu chưa; cap MAX_ASKED. */
export function mergeAskedQuestions(prev: AskedQuestion[], key: string, atIso: string): AskedQuestion[] {
  const idx = prev.findIndex((q) => q.key === key);
  if (idx >= 0) {
    const next = prev.slice();
    next[idx] = { key, at: atIso, count: (Number(prev[idx].count) || 0) + 1 };
    return next;
  }
  return [...prev, { key, at: atIso, count: 1 }].slice(-MAX_ASKED);
}

/** Merge thuần (export để test): thêm mã gói CHƯA có (upper-case, dedupe); cap MAX_QUOTED. */
export function mergeQuotedPackages(prev: QuotedPackage[], codes: string[], atIso: string): QuotedPackage[] {
  const seen = new Set(prev.map((p) => p.code));
  const next = prev.slice();
  for (const raw of codes ?? []) {
    const code = (raw ?? "").trim().toUpperCase();
    if (code && !seen.has(code)) {
      seen.add(code);
      next.push({ code, at: atIso });
    }
  }
  return next.slice(-MAX_QUOTED);
}

/** Merge thuần (export để test): gộp URL ảnh mẫu + id nhóm giá đã gửi, dedupe + cap. */
export function mergeSentAssets(prev: SentAssets, sampleUrls: string[], priceGroupIds: number[]): SentAssets {
  const urls = [...(prev.sample_urls ?? [])];
  for (const u of sampleUrls ?? []) if (u && !urls.includes(u)) urls.push(u);
  const gids = [...(prev.price_group_ids ?? [])];
  for (const g of priceGroupIds ?? []) if (Number.isFinite(g) && !gids.includes(g)) gids.push(g);
  return { sample_urls: urls.slice(-MAX_SAMPLE_URLS), price_group_ids: gids };
}

export type BotReplyInfo = {
  /** Nhãn hành động lượt này (vd "reply" | "quote" | "reply_escalated") — để soi Monitor/debug. */
  action: string;
  /** true nếu text bot gửi có câu hỏi ngày (botAsksDate) → ghi asked_questions.ask_date. */
  askedDate: boolean;
  /** Mã gói từ marker <<PRICE_IMAGE>> (trước đây bị vứt sau khi gửi ảnh). */
  quotedCodes: string[];
  /** URL ảnh mẫu ĐÃ gửi thành công lượt này. */
  sampleUrls: string[];
  /** id nhóm giá đã gửi ảnh bảng giá. */
  priceGroupIds: number[];
};

/**
 * Ghi lại "bot vừa làm gì" vào state. Read-merge-write với guard version (1 lần thử lại) —
 * đủ an toàn vì mỗi thread chỉ một luồng trả lời tại một thời điểm; race hiếm chỉ làm mất
 * một lần đếm, không hỏng dữ liệu. KHÔNG bao giờ throw.
 */
export async function recordBotReply(psid: string, info: BotReplyInfo): Promise<void> {
  try {
    await ensureThreadStateTable();
    for (let attempt = 0; attempt < 2; attempt++) {
      let state = await getThreadState(psid);
      if (!state) {
        // Thread cũ chưa có record (khách nhắn trước khi bật cờ) → tạo dòng nền rồi đọc lại.
        await pool.query(
          `INSERT INTO lulu_thread_state (facebook_user_id) VALUES ($1)
           ON CONFLICT (facebook_user_id) DO NOTHING`,
          [psid],
        );
        state = await getThreadState(psid);
        if (!state) return;
      }
      const nowIso = new Date().toISOString();
      const asked = info.askedDate
        ? mergeAskedQuestions(state.askedQuestions, "ask_date", nowIso)
        : state.askedQuestions;
      const quoted = mergeQuotedPackages(state.quotedPackages, info.quotedCodes, nowIso);
      const assets = mergeSentAssets(state.sentAssets, info.sampleUrls, info.priceGroupIds);

      const r = await pool.query(
        `UPDATE lulu_thread_state SET
           asked_questions = $2::jsonb,
           quoted_packages = $3::jsonb,
           sent_assets = $4::jsonb,
           last_action = $5,
           last_bot_message_at = NOW(),
           version = version + 1,
           updated_at = NOW()
         WHERE facebook_user_id = $1 AND version = $6`,
        [psid, JSON.stringify(asked), JSON.stringify(quoted), JSON.stringify(assets), info.action, state.version],
      );
      if ((r.rowCount ?? 0) > 0) {
        // LOG QUYẾT ĐỊNH: hành động đã chọn + trạng thái SAU lượt bot.
        console.log(
          `[LuluState][out] psid=${psid} action=${info.action} askedDate=${info.askedDate} quoted=${JSON.stringify(quoted.map((q) => q.code))} samplesSent=${info.sampleUrls.length} askCount=${asked.find((q) => q.key === "ask_date")?.count ?? 0}`,
        );
        return;
      }
      // version lệch (hiếm) → đọc lại merge lại đúng 1 lần.
    }
    console.warn(`[LuluState] recordBotReply psid=${psid} bỏ qua sau 2 lần version lệch`);
  } catch (err) {
    console.error("[LuluState] recordBotReply lỗi (fail-open):", String(err).slice(0, 160));
  }
}

// ─── MÔ PHỎNG state từ lịch sử (cho sân test Brain Lab — thuần, KHÔNG DB) ─────

const SIM_AT = "(mô phỏng)";

/**
 * Dựng ThreadState bằng cách REPLAY lịch sử hội thoại qua đúng bộ extractor của luồng
 * thật (detectDateSlot / botAsksDate / detectServiceIntentFromText) — để sân test
 * Claude Sale Test / Brain Lab kiểm chứng hành vi trí nhớ TRƯỚC khi bật cờ prod,
 * mà không ghi/đọc bảng lulu_thread_state (không đụng dữ liệu khách thật).
 *
 * Giới hạn mô phỏng: quoted_packages không tái tạo được từ text history (mã gói không
 * nằm trong lời thoại) → truyền qua opts.quotedCodes (FE tích lũy từ các response trước).
 */
export function simulateThreadStateFromHistory(
  history: Array<{ direction: "incoming" | "outgoing"; message: string }>,
  opts?: { quotedCodes?: string[]; now?: Date },
): ThreadState {
  const state: ThreadState = {
    facebookUserId: "(test)",
    currentStage: "new",
    previousStage: null,
    serviceIntent: null,
    customerStatus: "lead",
    lastAction: null,
    slots: {},
    askedQuestions: [],
    quotedPackages: [],
    sentAssets: {},
    lastUserMessageAt: null,
    lastBotMessageAt: null,
    version: 0,
  };
  let askCount = 0;
  const sampleUrls: string[] = [];

  for (const h of history ?? []) {
    const msg = (h?.message ?? "").trim();
    if (!msg) continue;
    if (h.direction === "outgoing") {
      const img = /^\[image:(.+?)\]$/.exec(msg);
      if (img) {
        if (img[1] && !sampleUrls.includes(img[1])) sampleUrls.push(img[1]);
        continue;
      }
      if (botAsksDate(msg)) askCount++;
      state.lastBotMessageAt = SIM_AT;
    } else {
      if (!msg.startsWith("[image:")) {
        const slot = detectDateSlot(msg, { botAskedDate: askCount > 0, now: opts?.now });
        if (slot) {
          state.slots = { ...state.slots, date_status: slot.status, event_date: slot.eventDate, date_text: slot.dateText };
        }
        const intent = detectServiceIntentFromText(msg);
        if (intent !== "unknown" && intent !== "new_concept_idea") state.serviceIntent = intent;
      }
      state.lastUserMessageAt = SIM_AT;
    }
  }

  if (askCount > 0) state.askedQuestions = [{ key: "ask_date", at: SIM_AT, count: askCount }];
  state.quotedPackages = mergeQuotedPackages([], opts?.quotedCodes ?? [], SIM_AT);
  state.sentAssets = { sample_urls: sampleUrls };
  return state;
}

// ─── Khối "TRẠNG THÁI KHÁCH" chèn vào context (thuần — test được) ─────────────

/**
 * Dựng khối văn bản trạng thái từ state để chèn vào context của Lulu. "" nếu chưa có gì
 * đáng nói. Đây là LƯỚI NHẮC từ dữ liệu thật (không phải câu dặn tĩnh): chỉ xuất hiện
 * đúng dòng ứng với trạng thái đang có.
 */
export function buildThreadStateBlock(state: ThreadState | null): string {
  if (!state) return "";
  const lines: string[] = [];

  const ds = state.slots.date_status;
  if (ds === "not_decided") {
    lines.push(
      `- NGÀY CHỤP: khách ĐÃ NÓI RÕ là CHƯA CHỐT NGÀY / đang tham khảo. TUYỆT ĐỐI KHÔNG hỏi lại ngày. Cứ tư vấn & báo GIÁ THAM KHẢO bình thường, chốt bằng 1 câu kiểu "khi mình có ngày cụ thể em kiểm tra lịch & xác nhận lại chính xác cho mình nha". CHỈ nói lại chuyện ngày khi CHÍNH KHÁCH nhắc tới ngày, hoặc khách muốn giữ lịch/đặt cọc.`,
    );
  } else if (ds === "known") {
    const when = state.slots.event_date || state.slots.date_text || "";
    if (when) {
      lines.push(
        `- NGÀY CHỤP: khách ĐÃ CHO mốc thời gian: ${when}. TUYỆT ĐỐI KHÔNG hỏi lại ngày — dùng đúng mốc này khi tư vấn/đề cập lịch.`,
      );
    }
  } else {
    // Chưa biết ngày nhưng bot ĐÃ HỎI mà khách chưa trả lời → đừng lặp lại liền.
    const askedDate = state.askedQuestions.find((q) => q.key === "ask_date");
    if (askedDate) {
      lines.push(
        `- NGÀY CHỤP: em ĐÃ HỎI ngày (${askedDate.count} lần) mà khách chưa trả lời — KHÔNG lặp lại câu hỏi ngày lượt này; đi tiếp bước khác (gu/mẫu/giá).`,
      );
    }
  }

  if (state.quotedPackages.length > 0) {
    const codes = state.quotedPackages.map((p) => p.code).join(", ");
    lines.push(
      `- ĐÃ BÁO GIÁ các gói: ${codes}. KHÔNG tự bung lại nguyên bảng giá các gói này; chỉ nhắc lại/so sánh khi khách hỏi.`,
    );
  }

  if (lines.length === 0) return "";
  return `TRẠNG THÁI KHÁCH (hệ thống GHI NHỚ từ hội thoại — em PHẢI tuân theo, ưu tiên cao):
${lines.join("\n")}`;
}
