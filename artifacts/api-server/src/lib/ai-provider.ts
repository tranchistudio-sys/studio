import { pool } from "@workspace/db";

/**
 * CẤU HÌNH AI PROVIDER — nguồn duy nhất quyết định thứ tự gọi AI cho TOÀN hệ thống
 * (Claude Sale Test, Facebook Messenger, Website advisor, Studio Copilot).
 *
 * Chuỗi mặc định: Claude (chính) → OpenAI (dự phòng 1) → [Gemini dành sẵn] → Nhân viên thật.
 *
 * THIẾT KẾ AN TOÀN (giống sale-master.ts):
 *  - Lưu ở bảng key-value `settings` dưới key 'ai_provider_config' (JSON).
 *  - Đọc cache ngắn (15s) để không spam DB nhưng vẫn đổi gần như tức thì.
 *  - Lỗi DB / chưa có row → fallback về biến môi trường, mặc định 'claude'.
 *  - KHÔNG bao giờ throw — nằm trên luồng trả lời sống.
 *
 * BẢO MẬT: file này KHÔNG log API key, không lưu key (key luôn đọc từ env/secrets).
 */

export type AiProviderName = "claude" | "openai" | "gemini";

export const ALL_PROVIDERS: AiProviderName[] = ["claude", "openai", "gemini"];

export type AiProviderConfig = {
  /** Provider gọi đầu tiên. */
  primary: AiProviderName;
  /** Dự phòng 1 (null = không có). */
  fallback1: AiProviderName | null;
  /** Dự phòng 2 (null = không có). Gemini để dành ở đây khi có key. */
  fallback2: AiProviderName | null;
  /** Bật fallback tự động. false = chỉ dùng primary, lỗi là báo nhân viên ngay. */
  autoFallback: boolean;
  /** Timeout mỗi provider (ms). */
  timeoutMs: number;
  /** Số lần thử lại mỗi provider khi gặp lỗi TẠM THỜI (timeout/5xx/rate-limit). */
  retries: number;
};

const KEY = "ai_provider_config";

function coerceProvider(v: unknown, fb: AiProviderName | null): AiProviderName | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "none" || s === "") return fb === undefined ? null : fb;
  return (ALL_PROVIDERS as string[]).includes(s) ? (s as AiProviderName) : fb;
}

export function defaultAiProviderConfig(): AiProviderConfig {
  const envPrimary = coerceProvider(process.env.AI_PROVIDER, "claude") ?? "claude";
  // Gemini chưa được bật mặc định (chưa có code adapter chạy thật). Chuỗi: Claude → OpenAI.
  return {
    primary: envPrimary,
    fallback1: "openai",
    fallback2: null,
    autoFallback: true,
    timeoutMs: 12000,
    retries: 1,
  };
}

export function normalizeAiProviderConfig(raw: unknown): AiProviderConfig {
  const d = defaultAiProviderConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const s = raw as Record<string, unknown>;
  const num = (v: unknown, fb: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
  };
  return {
    primary: coerceProvider(s.primary, d.primary) ?? d.primary,
    fallback1: coerceProvider(s.fallback1, d.fallback1),
    fallback2: coerceProvider(s.fallback2, d.fallback2),
    autoFallback: typeof s.autoFallback === "boolean" ? s.autoFallback : d.autoFallback,
    timeoutMs: num(s.timeoutMs, d.timeoutMs, 2000, 60000),
    retries: num(s.retries, d.retries, 0, 3),
  };
}

/**
 * Chuỗi provider thực tế sẽ thử, theo thứ tự, đã loại trùng & loại null.
 * autoFallback=false → chỉ primary.
 */
export function resolveProviderChain(cfg: AiProviderConfig): AiProviderName[] {
  if (!cfg.autoFallback) return [cfg.primary];
  const chain = [cfg.primary, cfg.fallback1, cfg.fallback2].filter(
    (p): p is AiProviderName => p != null,
  );
  return Array.from(new Set(chain));
}

// ─── Đọc/ghi cấu hình (cache ngắn) ───────────────────────────────────────────

let cache: { value: AiProviderConfig; at: number } | null = null;
const TTL_MS = 15 * 1000;

export function clearAiProviderConfigCache(): void {
  cache = null;
}

export async function getAiProviderConfig(): Promise<AiProviderConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = $1 LIMIT 1`, [KEY]);
    let value: AiProviderConfig;
    if (r.rows.length === 0) {
      value = defaultAiProviderConfig();
    } else {
      const raw = r.rows[0].value;
      // value có thể là JSON string (cột text) → parse an toàn.
      let parsed: unknown = raw;
      if (typeof raw === "string") {
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
      }
      value = normalizeAiProviderConfig(parsed);
    }
    cache = { value, at: Date.now() };
    return value;
  } catch (err) {
    console.error("[AI] getAiProviderConfig lỗi → dùng mặc định:", String(err).slice(0, 150));
    return defaultAiProviderConfig();
  }
}

export async function setAiProviderConfig(cfg: AiProviderConfig): Promise<AiProviderConfig> {
  const normalized = normalizeAiProviderConfig(cfg);
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [KEY, JSON.stringify(normalized)],
  );
  clearAiProviderConfigCache();
  return normalized;
}

// ─── Đọc API key theo provider (từ env/secrets, KHÔNG hardcode, KHÔNG log) ────

/**
 * Trả về API key cho provider, hoặc null nếu CHƯA cấu hình.
 * - claude  : ANTHROPIC_API_KEY
 * - openai  : DB settings.openai_api_key → AI_INTEGRATIONS_OPENAI_API_KEY → OPENAI_API_KEY
 * - gemini  : GEMINI_API_KEY
 */
export async function resolveApiKey(p: AiProviderName): Promise<string | null> {
  if (p === "claude") return (process.env.ANTHROPIC_API_KEY ?? "").trim() || null;
  if (p === "gemini") return (process.env.GEMINI_API_KEY ?? "").trim() || null;
  // openai
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'openai_api_key' LIMIT 1`);
    const dbKey = r.rows[0]?.value ? String(r.rows[0].value).trim() : "";
    if (dbKey) return dbKey;
  } catch { /* bỏ qua, dùng env */ }
  return (process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim() || null;
}

/** Nhãn hiển thị cho log / báo cáo. */
export const PROVIDER_LABEL: Record<AiProviderName, string> = {
  claude: "Claude",
  openai: "OpenAI/GPT",
  gemini: "Gemini",
};

/** Câu trả lời khi TẤT CẢ provider đều lỗi (không bao giờ im lặng với khách). */
export const ALL_FAILED_CUSTOMER_MESSAGE = "Dạ em báo nhân viên hỗ trợ mình ngay nha 😊";
