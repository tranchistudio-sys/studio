import { describe, it, expect } from "vitest";
import {
  PreviewGuardError,
  PREVIEW_ENV_FORCE,
  assertPreviewBasicAuthConfigured,
  assertPreviewDatabase,
  enforcePreviewSafety,
  isPreviewMode,
  neutralizeOutboundEnv,
  parseDatabaseUrl,
  parseDbAllowlist,
  type EnvLike,
} from "./preview-guard.js";

/** Env preview hợp lệ tối thiểu. */
function okEnv(extra: EnvLike = {}): EnvLike {
  return {
    PREVIEW_MODE: "1",
    DATABASE_URL: "postgresql://u:p@ep-preview-123.ap-southeast-1.aws.neon.tech/amazing_preview?sslmode=require",
    PREVIEW_DB_HOST_ALLOWLIST: "ep-preview-123.ap-southeast-1.aws.neon.tech/amazing_preview",
    PREVIEW_BASIC_AUTH_PASS: "mat-khau-du-dai",
    ...extra,
  };
}

const silent = { warn: () => {} };

describe("isPreviewMode — chỉ bật đúng khi PREVIEW_MODE=1", () => {
  it("không có biến / giá trị khác '1' → false (production tuyệt đối không dính)", () => {
    for (const v of [undefined, "", "0", "true", "yes", "preview", " 1"]) {
      expect(isPreviewMode({ PREVIEW_MODE: v })).toBe(false);
    }
  });

  it("PREVIEW_MODE=1 → true", () => {
    expect(isPreviewMode({ PREVIEW_MODE: "1" })).toBe(true);
  });
});

describe("enforcePreviewSafety — no-op hoàn toàn khi KHÔNG phải preview", () => {
  it("không đụng bất kỳ env nào của production", () => {
    const env: EnvLike = {
      DATABASE_URL: "postgresql://u:p@db-production.example.com/prod",
      FB_PAGE_ACCESS_TOKEN: "token-that-that",
      SKIP_STARTUP_MIGRATIONS: "1",
      ENABLE_AUTO_POST_FACEBOOK: "true",
    };
    const before = { ...env };
    expect(enforcePreviewSafety(env, silent)).toBeNull();
    expect(env).toEqual(before);
  });
});

describe("assertPreviewDatabase — fail-closed ở mọi nhánh", () => {
  it("thiếu DATABASE_URL → ném lỗi", () => {
    expect(() => assertPreviewDatabase(okEnv({ DATABASE_URL: undefined }))).toThrow(PreviewGuardError);
  });

  it("thiếu allowlist → ném lỗi (không có allowlist thì không chứng minh được là DB preview)", () => {
    expect(() => assertPreviewDatabase(okEnv({ PREVIEW_DB_HOST_ALLOWLIST: undefined }))).toThrow(
      /PREVIEW_DB_HOST_ALLOWLIST rỗng/,
    );
  });

  it("DATABASE_URL hỏng → ném lỗi", () => {
    expect(() => assertPreviewDatabase(okEnv({ DATABASE_URL: "khong-phai-url" }))).toThrow(PreviewGuardError);
  });

  it("host khác allowlist → ném lỗi (đây chính là chốt chặn nối nhầm production)", () => {
    const env = okEnv({
      DATABASE_URL: "postgresql://u:p@ep-production-999.us-east-2.aws.neon.tech/neondb",
    });
    expect(() => assertPreviewDatabase(env)).toThrow(/KHÔNG nằm trong PREVIEW_DB_HOST_ALLOWLIST/);
  });

  it("đúng host nhưng KHÁC tên database → vẫn ném lỗi", () => {
    const env = okEnv({
      DATABASE_URL: "postgresql://u:p@ep-preview-123.ap-southeast-1.aws.neon.tech/neondb",
    });
    expect(() => assertPreviewDatabase(env)).toThrow(PreviewGuardError);
  });

  it("KHÔNG hỗ trợ ký tự đại diện — '*.neon.tech' không khớp gì cả", () => {
    // Có chủ đích: DB production của Replit cũng nằm trên hạ tầng Neon.
    const env = okEnv({ PREVIEW_DB_HOST_ALLOWLIST: "*.neon.tech" });
    expect(() => assertPreviewDatabase(env)).toThrow(PreviewGuardError);
  });

  it("khớp tuyệt đối host + database → trả về thông tin đã xác thực", () => {
    expect(assertPreviewDatabase(okEnv())).toEqual({
      host: "ep-preview-123.ap-southeast-1.aws.neon.tech",
      database: "amazing_preview",
    });
  });

  it("mục allowlist chỉ có host (không kèm database) → chấp nhận mọi database trên host đó", () => {
    const env = okEnv({ PREVIEW_DB_HOST_ALLOWLIST: "ep-preview-123.ap-southeast-1.aws.neon.tech" });
    expect(assertPreviewDatabase(env).database).toBe("amazing_preview");
  });
});

describe("parseDbAllowlist / parseDatabaseUrl", () => {
  it("tách nhiều mục, bỏ khoảng trắng, chuyển thường", () => {
    expect(parseDbAllowlist(" HostA/DbA , hostb ,, ")).toEqual([
      { host: "hosta", database: "dba" },
      { host: "hostb", database: null },
    ]);
  });

  it("chuỗi rỗng/undefined → mảng rỗng", () => {
    expect(parseDbAllowlist(undefined)).toEqual([]);
    expect(parseDbAllowlist("  ")).toEqual([]);
  });

  it("lấy đúng host + database, bỏ qua query string", () => {
    expect(parseDatabaseUrl("postgres://a:b@Host.Example.com:5432/My_DB?sslmode=require")).toEqual({
      host: "host.example.com",
      database: "my_db",
    });
  });
});

describe("assertPreviewBasicAuthConfigured — preview không được để trần", () => {
  it("thiếu mật khẩu hoặc quá ngắn → ném lỗi", () => {
    expect(() => assertPreviewBasicAuthConfigured({})).toThrow(PreviewGuardError);
    expect(() => assertPreviewBasicAuthConfigured({ PREVIEW_BASIC_AUTH_PASS: "ngan" })).toThrow(PreviewGuardError);
  });

  it("mật khẩu đủ dài → không sao", () => {
    expect(() => assertPreviewBasicAuthConfigured({ PREVIEW_BASIC_AUTH_PASS: "12345678" })).not.toThrow();
  });
});

describe("neutralizeOutboundEnv — dọn sạch env gây side effect", () => {
  it("xoá hẳn token/key và ép các cờ về TẮT", () => {
    const env: EnvLike = {
      FB_PAGE_ACCESS_TOKEN: "token",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
      GOOGLE_DRIVE_REFRESH_TOKEN: "rt",
      GOOGLE_CLIENT_ID: "public-gis-client-id",
      VAPID_PRIVATE_KEY: "vp",
      PRIVATE_OBJECT_DIR: "/buckets/prod",
      TRUTH_API_BASE: "https://tranchistudio.com",
      ENABLE_AUTO_POST_FACEBOOK: "true",
      AUTOPOST_DRY_RUN: "false",
      ENABLE_AI_FOLLOWUP: "true",
    };
    const { removed } = neutralizeOutboundEnv(env);

    expect(removed).toEqual(
      expect.arrayContaining([
        "FB_PAGE_ACCESS_TOKEN",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_DRIVE_REFRESH_TOKEN",
        "VAPID_PRIVATE_KEY",
        "PRIVATE_OBJECT_DIR",
        "TRUTH_API_BASE",
      ]),
    );
    for (const key of removed) expect(env[key]).toBeUndefined();
    // GIS Web client ID là public và tách khỏi Drive OAuth; giữ lại để staging
    // có origin ổn định có thể test login mà không mở Drive credential.
    expect(env.GOOGLE_CLIENT_ID).toBe("public-gis-client-id");

    // AUTOPOST_DRY_RUN="true" khoá cứng chạy khô, ENV thắng cả cấu hình trong DB.
    expect(env.AUTOPOST_DRY_RUN).toBe("true");
    expect(env.ENABLE_AUTO_POST_FACEBOOK).toBe("false");
    expect(env.ENABLE_AI_FOLLOWUP).toBe("false");
    for (const [k, v] of Object.entries(PREVIEW_ENV_FORCE)) expect(env[k]).toBe(v);
  });
});

describe("enforcePreviewSafety — đường đi đầy đủ của preview hợp lệ", () => {
  it("DB hợp lệ → dọn env, mở DDL cho ĐÚNG DB preview đó", () => {
    const env = okEnv({
      FB_PAGE_ACCESS_TOKEN: "token-that",
      SKIP_STARTUP_MIGRATIONS: "1",
      NODE_ENV: "production",
    });
    const db = enforcePreviewSafety(env, silent);

    expect(db).toEqual({
      host: "ep-preview-123.ap-southeast-1.aws.neon.tech",
      database: "amazing_preview",
    });
    expect(env.FB_PAGE_ACCESS_TOKEN).toBeUndefined();
    // DDL chỉ được mở SAU khi DB đã xác thực là preview.
    expect(env.SKIP_STARTUP_MIGRATIONS).toBeUndefined();
    expect(env.ALLOW_STARTUP_DDL_IN_PRODUCTION).toBe("1");
  });

  it("DB SAI → ném lỗi và KHÔNG mở DDL, KHÔNG dọn env (chết trước khi kịp làm gì)", () => {
    const env = okEnv({
      DATABASE_URL: "postgresql://u:p@ep-production-999.us-east-2.aws.neon.tech/neondb",
      FB_PAGE_ACCESS_TOKEN: "token-that",
    });
    expect(() => enforcePreviewSafety(env, silent)).toThrow(PreviewGuardError);
    expect(env.ALLOW_STARTUP_DDL_IN_PRODUCTION).toBeUndefined();
  });

  it("thiếu mật khẩu Basic Auth → ném lỗi trước khi mở DDL", () => {
    const env = okEnv({ PREVIEW_BASIC_AUTH_PASS: undefined });
    expect(() => enforcePreviewSafety(env, silent)).toThrow(PreviewGuardError);
    expect(env.ALLOW_STARTUP_DDL_IN_PRODUCTION).toBeUndefined();
  });
});
