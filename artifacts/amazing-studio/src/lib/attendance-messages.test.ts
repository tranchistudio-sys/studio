import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  MESSAGE_POOLS,
  pickMessage,
  totalMessageCount,
  getAttendanceMessage,
  type AttendanceMessageKey,
} from "./attendance-messages";

describe("attendance-messages pool", () => {
  it("has 20-30 total lines", () => {
    const n = totalMessageCount();
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(30);
  });

  it("each key has at least 3 lines", () => {
    const keys = Object.keys(MESSAGE_POOLS) as AttendanceMessageKey[];
    for (const key of keys) {
      expect(MESSAGE_POOLS[key].length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("pickMessage", () => {
  const storage: Record<string, string> = {};

  beforeEach(() => {
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => {
        storage[k] = v;
      },
      removeItem: (k: string) => {
        delete storage[k];
      },
    });
    for (const k of Object.keys(storage)) delete storage[k];
  });

  it("does not return the same index twice in a row when pool has 2+ items", () => {
    const key: AttendanceMessageKey = "on_time";
    const pool = MESSAGE_POOLS[key];
    expect(pool.length).toBeGreaterThan(1);

    const first = pickMessage(key);
    const idx1 = pool.indexOf(first);
    expect(idx1).toBeGreaterThanOrEqual(0);

    const second = pickMessage(key);
    const idx2 = pool.indexOf(second);
    expect(idx2).not.toBe(idx1);
  });
});

describe("getAttendanceMessage", () => {
  it("interpolates overtime_end placeholders", () => {
    const m = getAttendanceMessage({
      messageKey: "overtime_end",
      localTime: "21:30",
      overtimeHours: 2.5,
      overtimeAmount: 75000,
    });
    expect(m.title).toBe("Kết thúc tăng ca");
    expect(m.statusLine).toContain("2.5");
    expect(m.statusLine).toContain("75");
  });
});
