import { describe, it, expect, vi, afterEach } from "vitest";
// sale-thread-lock import pool từ @workspace/db → mock theo convention repo.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn() } }));
import { isSuperseded, threadDebounceMs, isThreadLockEnabled, withThreadLock } from "./sale-thread-lock";
import { pool } from "@workspace/db";

afterEach(() => {
  delete process.env.LULU_THREAD_LOCK_ENABLED;
  delete process.env.LULU_DEBOUNCE_MS;
});

describe("isSuperseded (tin mới nhất thắng)", () => {
  it("tin mới hơn tồn tại → nhường; là tin mới nhất → trả lời", () => {
    expect(isSuperseded(10, 12)).toBe(true);
    expect(isSuperseded(12, 12)).toBe(false);
    expect(isSuperseded(12, 10)).toBe(false);
  });
  it("thiếu dữ kiện (id null do lỗi DB) → KHÔNG nhường (fail-open, giữ hành vi cũ)", () => {
    expect(isSuperseded(null, 12)).toBe(false);
    expect(isSuperseded(10, null)).toBe(false);
  });
});

describe("cấu hình", () => {
  it("flag mặc định TẮT; bật bằng 1/true/yes", () => {
    expect(isThreadLockEnabled()).toBe(false);
    process.env.LULU_THREAD_LOCK_ENABLED = "1";
    expect(isThreadLockEnabled()).toBe(true);
  });
  it("debounce mặc định 6000ms, clamp 0..20000, chống giá trị rác", () => {
    expect(threadDebounceMs()).toBe(6000);
    process.env.LULU_DEBOUNCE_MS = "99999";
    expect(threadDebounceMs()).toBe(20000);
    process.env.LULU_DEBOUNCE_MS = "-5";
    expect(threadDebounceMs()).toBe(0);
    process.env.LULU_DEBOUNCE_MS = "abc";
    expect(threadDebounceMs()).toBe(6000);
  });
});

describe("withThreadLock — failure modes (mock connection)", () => {
  function mockClient(behavior: { lockFails?: boolean; unlockFails?: boolean }) {
    const calls: string[] = [];
    return {
      calls,
      released: [] as unknown[],
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (behavior.lockFails && sql.includes("pg_advisory_lock(")) throw new Error("statement timeout");
        if (behavior.unlockFails && sql.includes("pg_advisory_unlock")) throw new Error("conn dead");
        return { rows: [] };
      }),
      release(arg?: unknown) { this.released.push(arg); },
    };
  }

  it("lấy khóa OK → chạy fn, unlock, release thường", async () => {
    const client = mockClient({});
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
    const r = await withThreadLock("psid1", async () => 42);
    expect(r).toEqual({ ran: true, result: 42 });
    expect(client.calls.some((s) => s.includes("pg_advisory_lock("))).toBe(true);
    expect(client.calls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.released).toEqual([undefined]);
  });

  it("chờ khóa quá hạn (statement timeout) → ran:false, KHÔNG chạy fn", async () => {
    const client = mockClient({ lockFails: true });
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
    const fn = vi.fn();
    const r = await withThreadLock("psid1", fn as unknown as () => Promise<void>);
    expect(r.ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("unlock lỗi → HỦY connection (release(true)) để Postgres tự nhả khóa theo session", async () => {
    const client = mockClient({ unlockFails: true });
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
    const r = await withThreadLock("psid1", async () => "ok");
    expect(r).toEqual({ ran: true, result: "ok" });
    expect(client.released).toEqual([true]);
  });

  it("pool.connect lỗi (DB down) → ran:false, không throw ra webhook", async () => {
    (pool.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no db"));
    const r = await withThreadLock("psid1", async () => "x");
    expect(r.ran).toBe(false);
  });

  it("fn ném lỗi → khóa VẪN được nhả rồi lỗi mới nổi lên", async () => {
    const client = mockClient({});
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
    await expect(withThreadLock("psid1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(client.calls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
  });
});
