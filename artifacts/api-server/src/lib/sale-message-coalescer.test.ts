import { describe, expect, it, vi } from "vitest";
import { createKeyedDebouncedQueue } from "./sale-message-coalescer";

describe("createKeyedDebouncedQueue", () => {
  it("coalesces rapid messages for one customer", async () => {
    vi.useFakeTimers();
    const calls: Array<{ key: string; items: string[] }> = [];
    const queue = createKeyedDebouncedQueue<string>(400, async (key, items) => {
      calls.push({ key, items });
    });
    const p1 = queue.enqueue("psid-1", "chụp cổng");
    const p2 = queue.enqueue("psid-1", "giá bao nhiêu");
    expect(queue.pendingCount("psid-1")).toBe(2);
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([p1, p2]);
    expect(calls).toEqual([{ key: "psid-1", items: ["chụp cổng", "giá bao nhiêu"] }]);
    vi.useRealTimers();
  });

  it("keeps different customers independent", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = createKeyedDebouncedQueue<string>(100, async (key) => { calls.push(key); });
    const a = queue.enqueue("a", "one");
    const b = queue.enqueue("b", "two");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([a, b]);
    expect(calls.sort()).toEqual(["a", "b"]);
    vi.useRealTimers();
  });

  it("serializes a later batch while the first is still running", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const queue = createKeyedDebouncedQueue<string>(50, async (_key, items) => {
      order.push(`start:${items[0]}`);
      if (items[0] === "first") await firstGate;
      order.push(`end:${items[0]}`);
    });
    const first = queue.enqueue("same", "first");
    await vi.advanceTimersByTimeAsync(50);
    const second = queue.enqueue("same", "second");
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(["start:first"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    vi.useRealTimers();
  });
});
