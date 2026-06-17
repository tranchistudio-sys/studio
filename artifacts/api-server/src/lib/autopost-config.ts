import { pool } from "@workspace/db";

/**
 * CẤU HÌNH AUTOPOST (toàn cục) — nguồn đọc/chuẩn hoá duy nhất cho phần nâng cấp.
 *
 * Lưu trong bảng singleton `autopost_settings` (id=1, cột `config` jsonb). Đây là
 * NƠI DUY NHẤT đọc/ghi các tùy chọn vận hành (dry-run, số bài/caption, auto-approve…),
 * tách hẳn khỏi `ai_provider_config` (bảng settings) và token Facebook.
 *
 * THIẾT KẾ AN TOÀN (giống ai-provider.ts):
 *  - Cache ngắn (10s) để không spam DB nhưng đổi gần như tức thì.
 *  - KHÔNG BAO GIỜ throw trên luồng đăng: lỗi DB → mặc định AN TOÀN.
 *  - resolveDryRun(): ENV THẮNG → DB → mặc định BẬT. Không có trường hợp mơ hồ
 *    nào dẫn tới đăng thật ngoài ý muốn (chỉ "false" tường minh mới tắt dry-run).
 *  - KHÔNG đụng / KHÔNG đọc token; KHÔNG log giá trị nhạy cảm.
 */

export type AutopostMode = "manual" | "semi" | "auto";

/** Cấu hình đã chuẩn hoá (luôn có default — dùng cho generate/auto-approve). */
export type AutopostConfig = {
  /** Dry-run lưu ở DB. null = admin CHƯA đặt (dùng mặc định an toàn = BẬT). */
  dryRun: boolean | null;
  /** Số bài tối đa sinh sẵn mỗi lần scheduler chạy (thay MAX_NEW_PER_TICK cứng). */
  postsPerTick: number;
  /** Gợi ý số bài/ngày mặc định khi tạo lịch/batch. */
  postsPerDay: number;
  /** Số caption AI sinh cho mỗi bài (1–6). */
  captionOptionsPerPost: number;
  /** Số ảnh tối đa đưa cho AI vision đọc khi viết caption (Phase 2). */
  maxVisionImagesPerPost: number;
  /** Bật tự duyệt sau X phút nếu admin không can thiệp. */
  autoApproveEnabled: boolean;
  /** Số phút chờ trước khi tự duyệt. */
  autoApproveAfterMinutes: number;
  /** Sau khi (tự) duyệt thì cho scheduler đăng theo giờ. */
  autoPublishAfterApproved: boolean;
  /** Bắt buộc admin duyệt tay — true thì KHÓA mọi auto-approve. */
  requireManualApproval: boolean;
};

export const AUTOPOST_CONFIG_DEFAULTS: AutopostConfig = {
  dryRun: null,
  postsPerTick: 5,
  postsPerDay: 7,
  captionOptionsPerPost: 3,
  maxVisionImagesPerPost: 3,
  autoApproveEnabled: false,
  autoApproveAfterMinutes: 30,
  autoPublishAfterApproved: false,
  requireManualApproval: true,
};

function clampInt(v: unknown, fb: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function asBool(v: unknown, fb: boolean): boolean {
  return typeof v === "boolean" ? v : fb;
}

/**
 * Chuẩn hoá phần config vận hành. KHÔNG xoá các key khác (tone, bannedWords,
 * defaultPageId, drive…) — chỉ đọc ra view đã có default cho phần nâng cấp.
 */
export function normalizeAutopostConfig(raw: unknown): AutopostConfig {
  const d = AUTOPOST_CONFIG_DEFAULTS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const s = raw as Record<string, unknown>;
  return {
    dryRun: typeof s.dryRun === "boolean" ? s.dryRun : null,
    postsPerTick: clampInt(s.postsPerTick, d.postsPerTick, 1, 50),
    postsPerDay: clampInt(s.postsPerDay, d.postsPerDay, 1, 50),
    captionOptionsPerPost: clampInt(s.captionOptionsPerPost, d.captionOptionsPerPost, 1, 6),
    maxVisionImagesPerPost: clampInt(s.maxVisionImagesPerPost, d.maxVisionImagesPerPost, 1, 10),
    autoApproveEnabled: asBool(s.autoApproveEnabled, d.autoApproveEnabled),
    autoApproveAfterMinutes: clampInt(s.autoApproveAfterMinutes, d.autoApproveAfterMinutes, 1, 1440),
    autoPublishAfterApproved: asBool(s.autoPublishAfterApproved, d.autoPublishAfterApproved),
    requireManualApproval: asBool(s.requireManualApproval, d.requireManualApproval),
  };
}

// ─── Đọc raw config (cache ngắn) ──────────────────────────────────────────────

let cache: { raw: Record<string, unknown>; at: number } | null = null;
const TTL_MS = 10 * 1000;

export function clearAutopostConfigCache(): void {
  cache = null;
}

/** Đọc RAW config jsonb (gồm cả tone/bannedWords/drive…). Không throw. */
export async function getAutopostConfigRaw(): Promise<Record<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.raw;
  try {
    const r = await pool.query(`SELECT config FROM autopost_settings WHERE id = 1`);
    let raw = r.rows[0]?.config as unknown;
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch { raw = {}; }
    }
    const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    cache = { raw: obj, at: Date.now() };
    return obj;
  } catch (err) {
    console.error("[AutoPost] getAutopostConfigRaw lỗi → dùng mặc định:", String(err).slice(0, 150));
    return {};
  }
}

/** Đọc config đã CHUẨN HOÁ (có default). Không throw. */
export async function getAutopostConfig(): Promise<AutopostConfig> {
  return normalizeAutopostConfig(await getAutopostConfigRaw());
}

// ─── DRY-RUN: ENV thắng → DB → mặc định BẬT ───────────────────────────────────

/** Trạng thái ENV AUTOPOST_DRY_RUN: forced=true nếu ENV được set tường minh. */
export function dryRunEnvState(): { forced: boolean; value: boolean | null } {
  const raw = process.env.AUTOPOST_DRY_RUN;
  if (raw == null || raw.trim() === "") return { forced: false, value: null };
  // Chỉ đúng chuỗi "false" (mọi hoa/thường) mới TẮT dry-run.
  return { forced: true, value: raw.trim().toLowerCase() !== "false" };
}

/**
 * Quyết định CÓ đang dry-run không (đây là HÀM DUY NHẤT luồng đăng nên gọi).
 * Thứ tự: ENV (nếu set) → DB (autopost_settings.config.dryRun) → mặc định TRUE.
 * Bất kỳ trường hợp mơ hồ / lỗi nào → TRUE (an toàn, KHÔNG đăng thật).
 */
export async function resolveDryRun(): Promise<boolean> {
  const env = dryRunEnvState();
  if (env.forced) return env.value as boolean;
  try {
    const raw = await getAutopostConfigRaw();
    if (typeof raw.dryRun === "boolean") return raw.dryRun;
  } catch {
    /* an toàn: rơi xuống mặc định */
  }
  return true;
}

/** Mô tả trạng thái dry-run cho UI (nguồn quyết định + có đổi được trên UI không). */
export async function describeDryRun(): Promise<{
  dryRun: boolean;
  source: "env" | "db" | "default";
  envForced: boolean;
  canToggle: boolean;
}> {
  const env = dryRunEnvState();
  if (env.forced) {
    return { dryRun: env.value as boolean, source: "env", envForced: true, canToggle: false };
  }
  try {
    const raw = await getAutopostConfigRaw();
    if (typeof raw.dryRun === "boolean") {
      return { dryRun: raw.dryRun, source: "db", envForced: false, canToggle: true };
    }
  } catch {
    /* ignore */
  }
  return { dryRun: true, source: "default", envForced: false, canToggle: true };
}

/**
 * Gộp (merge) một vài key vào config jsonb mà KHÔNG đụng các key khác
 * (dùng toán tử jsonb `||`, giữ nguyên tone/bannedWords/drive.refreshToken…).
 * Trả về config raw mới. Dùng cho toggle dry-run + lưu cấu hình lẻ.
 */
export async function patchAutopostConfig(
  patch: Record<string, unknown>,
  updatedBy: number | null,
): Promise<Record<string, unknown>> {
  const r = await pool.query(
    `INSERT INTO autopost_settings (id, config, updated_at, updated_by)
     VALUES (1, $1::jsonb, now(), $2)
     ON CONFLICT (id) DO UPDATE
       SET config = autopost_settings.config || EXCLUDED.config,
           updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING config`,
    [JSON.stringify(patch), updatedBy],
  );
  clearAutopostConfigCache();
  const saved = (r.rows[0] as { config?: unknown } | undefined)?.config;
  return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
}
