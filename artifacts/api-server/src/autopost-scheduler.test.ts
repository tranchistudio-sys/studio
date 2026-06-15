import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Chặn các phụ thuộc nặng (DB/network/AI) để test thuần logic scheduler. ──
vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn() },
}));
vi.mock("./lib/facebook-page-publish", () => ({
  publishToPage: vi.fn(),
  isDryRun: () => true,
}));
vi.mock("./lib/autopost-caption", () => ({
  generateCaptions: vi.fn(),
}));
vi.mock("./routes/notifications", () => ({
  emitNotification: vi.fn(),
}));

import { pool } from "@workspace/db";
import { publishToPage } from "./lib/facebook-page-publish";
import { emitNotification } from "./routes/notifications";
import { computeSlotDateUtc, publishDuePosts } from "./autopost-scheduler";

const q = pool.query as ReturnType<typeof vi.fn>;
const publishMock = publishToPage as ReturnType<typeof vi.fn>;
const notifyMock = emitNotification as ReturnType<typeof vi.fn>;

const ONE_POST = {
  id: 1,
  page_id: "P",
  images: ["a.jpg"],
  caption_final: "Xin chào Amazing Studio",
  content_pool_id: 7,
  image_hash: "ih",
  caption_hash: "ch",
};

/**
 * Bộ định tuyến mock pool.query theo nội dung SQL. `claimRowCount` cho phép mô
 * phỏng atomic-claim thành công (1) hay thất bại/đã bị chiếm (0).
 */
function routePool(opts: {
  due?: unknown[];
  dedupeHit?: boolean;
  claimRowCounts?: number[]; // lần lượt rowCount cho mỗi UPDATE 'posting'
}) {
  const due = opts.due ?? [];
  const claims = [...(opts.claimRowCounts ?? [])];
  q.mockImplementation((sql: string) => {
    const s = String(sql);
    if (s.includes("scheduled_at <= now()")) return Promise.resolve({ rows: due });
    if (s.includes("SET status = 'posting'")) {
      const rc = claims.length ? claims.shift()! : 1;
      return Promise.resolve({ rowCount: rc, rows: rc ? [{ id: 1 }] : [] });
    }
    if (s.includes("SELECT 1 FROM autopost_posts") && s.includes("status = 'posted'")) {
      return Promise.resolve({ rows: opts.dedupeHit ? [{ "?column?": 1 }] : [] });
    }
    // posted UPDATE, failed UPDATE, skipped UPDATE, pool times_posted UPDATE, …
    return Promise.resolve({ rowCount: 1, rows: [] });
  });
}

beforeEach(() => {
  q.mockReset();
  publishMock.mockReset();
  notifyMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeSlotDateUtc (giờ VN, UTC+7)", () => {
  it("20:00 VN hôm nay → 13:00 UTC cùng ngày", () => {
    const nowMs = Date.UTC(2026, 5, 15, 1, 0, 0); // 08:00 VN, 2026-06-15
    const when = computeSlotDateUtc("20:00", 0, nowMs);
    expect(when).not.toBeNull();
    expect(when!.getUTCHours()).toBe(13);
    expect(when!.getUTCMinutes()).toBe(0);
    expect(when!.getUTCDate()).toBe(15);
  });

  it("dayOffset=1 → ngày hôm sau", () => {
    const nowMs = Date.UTC(2026, 5, 15, 1, 0, 0);
    const when = computeSlotDateUtc("09:30", 1, nowMs);
    expect(when!.getUTCDate()).toBe(16);
    expect(when!.getUTCHours()).toBe(2); // 09:30 VN = 02:30 UTC
    expect(when!.getUTCMinutes()).toBe(30);
  });

  it("post_time không hợp lệ → null", () => {
    expect(computeSlotDateUtc("99:99", 0, Date.now())).toBeNull();
    expect(computeSlotDateUtc("abc", 0, Date.now())).toBeNull();
    expect(computeSlotDateUtc("", 0, Date.now())).toBeNull();
  });
});

describe("publishDuePosts", () => {
  it("(a) bài tới giờ → posted + lưu id/link + tăng times_posted của pool", async () => {
    routePool({ due: [ONE_POST] });
    publishMock.mockResolvedValue({ postId: "fb_123", permalink: "https://fb/fb_123", dryRun: true });

    const res = await publishDuePosts();

    expect(res.posted).toBe(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock.mock.calls[0][0]).toMatchObject({
      pageId: "P",
      message: "Xin chào Amazing Studio",
      imageUrls: ["a.jpg"],
    });
    const sqls = q.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("SET status = 'posted'"))).toBe(true);
    expect(sqls.some((s) => s.includes("times_posted = times_posted + 1"))).toBe(true);
  });

  it("(b) publish ném lỗi → failed + emitNotification(autopost_failed)", async () => {
    routePool({ due: [ONE_POST] });
    publishMock.mockRejectedValue(new Error("Graph API 400 boom"));

    const res = await publishDuePosts();

    expect(res.failed).toBe(1);
    expect(res.posted).toBe(0);
    const sqls = q.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("SET status = 'failed'"))).toBe(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).toMatchObject({ type: "autopost_failed" });
  });

  it("(c) bài chưa duyệt KHÔNG bị đăng: query chỉ lấy approved/scheduled, claim guard chặn", async () => {
    // SQL lấy bài tới giờ phải giới hạn status hợp lệ, KHÔNG đụng pending_review.
    routePool({ due: [ONE_POST], claimRowCounts: [0] }); // claim thất bại (state đã đổi)
    publishMock.mockResolvedValue({ postId: "x", permalink: null, dryRun: true });

    const res = await publishDuePosts();

    expect(res.posted).toBe(0);
    expect(publishMock).not.toHaveBeenCalled();
    const dueSql = q.mock.calls.map((c) => String(c[0])).find((s) => s.includes("scheduled_at <= now()"))!;
    expect(dueSql).toContain("status IN ('approved','scheduled')");
    expect(dueSql).not.toContain("pending_review");
  });

  it("(d) atomic claim: 2 lần chạy liên tiếp chỉ đăng đúng 1 lần", async () => {
    // due luôn trả cùng bài; claim thành công lần đầu, thất bại lần sau (worker khác).
    routePool({ due: [ONE_POST], claimRowCounts: [1, 0] });
    publishMock.mockResolvedValue({ postId: "fb_1", permalink: null, dryRun: true });

    await publishDuePosts();
    await publishDuePosts();

    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it("(e) dedupe: trùng ảnh/caption đã đăng → skip, KHÔNG gọi publish", async () => {
    routePool({ due: [ONE_POST], dedupeHit: true });
    publishMock.mockResolvedValue({ postId: "x", permalink: null, dryRun: true });

    const res = await publishDuePosts();

    expect(res.skipped).toBe(1);
    expect(publishMock).not.toHaveBeenCalled();
    const sqls = q.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("SET status = 'skipped'"))).toBe(true);
  });
});
