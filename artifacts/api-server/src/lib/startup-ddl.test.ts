import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// startup-ddl.ts import `pool` từ @workspace/db (throw nếu thiếu DATABASE_URL lúc
// import) → mock db theo convention unit test trong repo. Chỉ test hàm THUẦN
// skipStartupDdl (đọc env), không đụng DB thật.
vi.mock("@workspace/db", () => ({ pool: { connect: vi.fn(), query: vi.fn(async () => ({ rows: [] })) } }));
import { skipStartupDdl } from "./startup-ddl";

const ENV_KEYS = ["SKIP_STARTUP_MIGRATIONS", "NODE_ENV", "ALLOW_STARTUP_DDL_IN_PRODUCTION"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("skipStartupDdl — guard DDL lúc khởi động (fail-closed sự cố 24/07/2026)", () => {
  it("dev (không env nào) → CHẠY DDL (không skip)", () => {
    expect(skipStartupDdl()).toBe(false);
  });

  it("SKIP_STARTUP_MIGRATIONS=1 → skip ở mọi môi trường", () => {
    process.env.SKIP_STARTUP_MIGRATIONS = "1";
    expect(skipStartupDdl()).toBe(true);
    process.env.NODE_ENV = "production";
    expect(skipStartupDdl()).toBe(true);
  });

  it("NODE_ENV=production KHÔNG có env nào khác → FAIL-CLOSED: skip DDL", () => {
    process.env.NODE_ENV = "production";
    expect(skipStartupDdl()).toBe(true);
  });

  it("NODE_ENV=production + ALLOW_STARTUP_DDL_IN_PRODUCTION=1 → cho chạy DDL (opt-in tường minh)", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_STARTUP_DDL_IN_PRODUCTION = "1";
    expect(skipStartupDdl()).toBe(false);
  });

  it("SKIP_STARTUP_MIGRATIONS=1 thắng ALLOW_STARTUP_DDL_IN_PRODUCTION=1", () => {
    process.env.NODE_ENV = "production";
    process.env.SKIP_STARTUP_MIGRATIONS = "1";
    process.env.ALLOW_STARTUP_DDL_IN_PRODUCTION = "1";
    expect(skipStartupDdl()).toBe(true);
  });

  it("NODE_ENV=development → không bị fail-closed production", () => {
    process.env.NODE_ENV = "development";
    expect(skipStartupDdl()).toBe(false);
  });
});
