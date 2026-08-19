/**
 * preview-guard.ts — chốt an toàn cho bản PREVIEW theo Pull Request (Fly.io review app).
 *
 * ─── BẤT BIẾN SỐ 1 ────────────────────────────────────────────────────────────
 * MỌI thứ trong file này CHỈ chạy khi env `PREVIEW_MODE=1`.
 * Production (Replit) KHÔNG đặt biến đó → toàn bộ file là no-op tuyệt đối,
 * không đổi một hành vi nào của prod. Đây là điều kiện để PR này an toàn.
 *
 * ─── PREVIEW LÀM 3 VIỆC, ĐÚNG THỨ TỰ ──────────────────────────────────────────
 * 1. FAIL-FAST nếu DATABASE_URL không nằm trong allowlist DB preview.
 *    Fail-closed: thiếu DATABASE_URL / thiếu allowlist / URL hỏng / host-db không
 *    khớp → NÉM LỖI, process chết. Không có "đoán bừa rồi chạy tiếp".
 *    ⇒ Một bản preview KHÔNG THỂ nối trúng database production.
 * 2. Vô hiệu hoá mọi env gây SIDE EFFECT RA NGOÀI hoặc TỐN TIỀN: Facebook,
 *    Google Drive, web-push, AutoPost, các API AI trả phí, và TRUTH_API_* (biến
 *    này có thể trỏ thẳng vào API production).
 *    LƯU Ý: token Facebook + key OpenAI CÒN ĐƯỢC ĐỌC TỪ BẢNG `settings` TRONG DB,
 *    nên chặn env là CHƯA ĐỦ → xem thêm `preview-net-guard.ts` (chặn tầng mạng)
 *    và `scripts/seed-preview-db.mjs` (xoá sạch secret trong DB preview).
 * 3. CHỈ SAU KHI (1) đã xác thực DB là preview, mới cho phép DDL khởi động chạy
 *    trên chính DB preview đó — để schema của nhánh PR khớp với dữ liệu test.
 *    Production vẫn giữ SKIP_STARTUP_MIGRATIONS=1 như cũ, không liên quan.
 */

export class PreviewGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewGuardError";
  }
}

export type EnvLike = Record<string, string | undefined>;

/** Preview bật khi và chỉ khi PREVIEW_MODE=1. */
export function isPreviewMode(env: EnvLike = process.env): boolean {
  return env.PREVIEW_MODE === "1";
}

/**
 * Env bị XOÁ HẲN trong preview: có mặt là có thể gây side effect thật ra ngoài
 * (gửi tin nhắn, đăng bài, ghi Drive, đẩy push) hoặc tốn tiền (API AI trả phí),
 * hoặc trỏ ngược về hệ thống production.
 */
export const PREVIEW_ENV_KILL_LIST: readonly string[] = [
  // ── Facebook ───────────────────────────────────────────────────────────────
  "FB_PAGE_ACCESS_TOKEN",
  "FB_PAGE_ID",
  "FB_VERIFY_TOKEN",
  "FACEBOOK_VERIFY_TOKEN",
  "FB_APP_SECRET",
  "FACEBOOK_APP_SECRET",
  // ── AI trả phí ─────────────────────────────────────────────────────────────
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "SHOPAIKEY_API_KEY",
  "SHOPAIKEY_BASE_URL",
  "LULU_TEST_PROVIDER",
  // ── Google Drive + secret OAuth ─────────────────────────────────────────────
  // GOOGLE_CLIENT_ID là public client id dành cho GIS login, được phép giữ lại.
  // Preview vẫn chỉ xác minh Google thật khi origin ổn định được đăng ký và
  // PREVIEW_NET_ALLOW cho phép đúng host lấy public cert; xem docs/google-auth.md.
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_FOLDER_ID",
  // ── Web push (đẩy thông báo ra điện thoại thật của nhân viên) ──────────────
  "VAPID_PRIVATE_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_EMAIL",
  // ── Object storage đám mây: ép preview ghi xuống đĩa local trong container ──
  "PRIVATE_OBJECT_DIR",
  "PUBLIC_OBJECT_SEARCH_PATHS",
  "DEFAULT_OBJECT_STORAGE_BUCKET_ID",
  "FORCE_GCS_OBJECT_STORAGE",
  // ── Có thể trỏ thẳng vào API/production ────────────────────────────────────
  "TRUTH_API_BASE",
  "TRUTH_API_TOKEN",
];

/**
 * Env bị ÉP GIÁ TRỊ trong preview (không xoá vì code đọc theo kiểu "chuỗi bật/tắt").
 * AUTOPOST_DRY_RUN="true" khoá cứng chế độ chạy khô: ENV thắng cả cấu hình trong DB
 * (xem `lib/facebook-page-publish.ts` → resolveDryRun) nên dù DB preview có bật
 * dryRun=false thì cũng KHÔNG đăng bài thật.
 */
export const PREVIEW_ENV_FORCE: Readonly<Record<string, string>> = {
  LEGACY_FB_BOT_ENABLED: "false",
  CLAUDE_FB_BOT_ENABLED: "false",
  FB_AUTO_REPLY_ENABLED: "false",
  ENABLE_AUTO_POST_FACEBOOK: "false",
  AUTOPOST_DRY_RUN: "true",
  ENABLE_AI_FOLLOWUP: "false",
  ENABLE_AI_TEST_FOLLOWUP: "false",
  ENABLE_AI_HOLD_FOLLOWUP: "false",
  LEGACY_OPENAI_ENABLED: "false",
  LEGACY_GEMINI_ENABLED: "false",
};

/** Một mục allowlist: chỉ host, hoặc host kèm tên database. */
export type DbAllowEntry = { host: string; database: string | null };

/**
 * Đọc allowlist từ chuỗi ngăn cách bởi dấu phẩy.
 * Dạng hợp lệ: `host` hoặc `host/tên_database`.
 *
 * KHÔNG hỗ trợ ký tự đại diện (`*.neon.tech`) — CÓ CHỦ ĐÍCH: database production
 * của Replit cũng nằm trên hạ tầng Neon, một wildcard kiểu đó sẽ vô tình cho phép
 * nối vào chính production. Chỉ khớp TUYỆT ĐỐI.
 */
export function parseDbAllowlist(raw: string | undefined): DbAllowEntry[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const [host, database] = item.split("/", 2);
      return {
        host: (host ?? "").trim().toLowerCase(),
        database: database?.trim() ? database.trim().toLowerCase() : null,
      };
    })
    .filter((e) => e.host.length > 0);
}

/** Tách host + tên database từ DATABASE_URL. Ném PreviewGuardError nếu URL hỏng. */
export function parseDatabaseUrl(url: string | undefined): { host: string; database: string } {
  if (!url || !url.trim()) {
    throw new PreviewGuardError(
      "PREVIEW_MODE=1 nhưng KHÔNG có DATABASE_URL. Preview bắt buộc phải có database riêng.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new PreviewGuardError("DATABASE_URL không phải URL hợp lệ — từ chối khởi động preview.");
  }
  const host = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")).toLowerCase();
  if (!host) {
    throw new PreviewGuardError("DATABASE_URL thiếu hostname — từ chối khởi động preview.");
  }
  return { host, database };
}

/**
 * FAIL-FAST: DATABASE_URL phải nằm trong allowlist preview.
 * Fail-closed ở mọi nhánh: thiếu allowlist cũng là lỗi (không có allowlist thì
 * không có gì chứng minh DB này là DB preview).
 *
 * @returns host + database đã xác thực (để log, KHÔNG chứa mật khẩu).
 */
export function assertPreviewDatabase(env: EnvLike = process.env): { host: string; database: string } {
  const allowlist = parseDbAllowlist(env.PREVIEW_DB_HOST_ALLOWLIST);
  if (allowlist.length === 0) {
    throw new PreviewGuardError(
      "PREVIEW_MODE=1 nhưng PREVIEW_DB_HOST_ALLOWLIST rỗng. Fail-closed: từ chối khởi động. " +
        "Đặt allowlist dạng 'host' hoặc 'host/tên_database' (ngăn cách bởi dấu phẩy).",
    );
  }

  const { host, database } = parseDatabaseUrl(env.DATABASE_URL);
  const matched = allowlist.some(
    (e) => e.host === host && (e.database === null || e.database === database),
  );
  if (!matched) {
    throw new PreviewGuardError(
      `DATABASE_URL trỏ tới '${host}/${database}' — KHÔNG nằm trong PREVIEW_DB_HOST_ALLOWLIST. ` +
        "Từ chối khởi động để tuyệt đối không có nguy cơ preview đụng vào database production.",
    );
  }
  return { host, database };
}

/** Mật khẩu Basic Auth là bắt buộc: preview công khai trên Internet, không được để trần. */
export function assertPreviewBasicAuthConfigured(env: EnvLike = process.env): void {
  const pass = env.PREVIEW_BASIC_AUTH_PASS;
  if (!pass || pass.length < 8) {
    throw new PreviewGuardError(
      "PREVIEW_MODE=1 nhưng thiếu PREVIEW_BASIC_AUTH_PASS (tối thiểu 8 ký tự). " +
        "Preview có dữ liệu khách (đã che) và chạy trên URL công khai → bắt buộc có mật khẩu.",
    );
  }
}

/** Dọn env gây side effect. Trả về danh sách đã xử lý để in log minh bạch. */
export function neutralizeOutboundEnv(env: EnvLike = process.env): {
  removed: string[];
  forced: string[];
} {
  const removed: string[] = [];
  for (const key of PREVIEW_ENV_KILL_LIST) {
    if (env[key] !== undefined) {
      delete env[key];
      removed.push(key);
    }
  }
  const forced: string[] = [];
  for (const [key, value] of Object.entries(PREVIEW_ENV_FORCE)) {
    if (env[key] !== value) forced.push(key);
    env[key] = value;
  }
  return { removed, forced };
}

/**
 * Toàn bộ chốt an toàn preview, chạy ở dòng đầu tiên của tiến trình
 * (xem `src/preview-boot.ts`). Ném PreviewGuardError nếu có bất kỳ điều gì sai.
 */
export function enforcePreviewSafety(
  env: EnvLike = process.env,
  log: Pick<Console, "warn"> = console,
): { host: string; database: string } | null {
  if (!isPreviewMode(env)) return null;

  // (1) DB phải là DB preview — kiểm TRƯỚC mọi thứ khác.
  const db = assertPreviewDatabase(env);

  // (2) Preview công khai → bắt buộc có mật khẩu.
  assertPreviewBasicAuthConfigured(env);

  // (3) Dọn env side effect.
  const { removed, forced } = neutralizeOutboundEnv(env);

  // (4) DB đã được xác thực là preview → cho phép DDL khởi động để schema của
  //     nhánh PR tự áp lên DB preview. KHÔNG BAO GIỜ chạm tới production: nhánh
  //     này chỉ tới được sau khi (1) pass.
  delete env.SKIP_STARTUP_MIGRATIONS;
  env.ALLOW_STARTUP_DDL_IN_PRODUCTION = "1";

  log.warn(
    `[preview-guard] PREVIEW_MODE=1 — DB '${db.host}/${db.database}' hợp lệ. ` +
      `Đã xoá ${removed.length} env side-effect, ép ${forced.length} cờ về TẮT. ` +
      "DDL khởi động được phép chạy TRÊN DB PREVIEW NÀY.",
  );
  return db;
}
