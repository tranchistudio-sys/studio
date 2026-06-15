import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chặn @workspace/db để import module KHÔNG cần DATABASE_URL và KHÔNG nối DB thật.
// pool.query mặc định trả rows:[] -> các helper rơi về fallback env.
vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// resolvePublicUrl passthrough: giữ nguyên url để khẳng định dễ kiểm tra.
vi.mock("./autopost-images", () => ({
  resolvePublicUrl: (u: string) => u,
}));

import { isDryRun, publishToPage, verifyPageToken } from "./facebook-page-publish";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.FB_PAGE_ACCESS_TOKEN = "tok";
  process.env.FB_PAGE_ID = "123";
  delete process.env.AUTOPOST_DRY_RUN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("isDryRun", () => {
  it("is true when AUTOPOST_DRY_RUN is unset", () => {
    delete process.env.AUTOPOST_DRY_RUN;
    expect(isDryRun()).toBe(true);
  });

  it('is true when AUTOPOST_DRY_RUN = "true"', () => {
    process.env.AUTOPOST_DRY_RUN = "true";
    expect(isDryRun()).toBe(true);
  });

  it('is false when AUTOPOST_DRY_RUN = "false"', () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    expect(isDryRun()).toBe(false);
  });

  it('is false when AUTOPOST_DRY_RUN = "FALSE" (case-insensitive)', () => {
    process.env.AUTOPOST_DRY_RUN = "FALSE";
    expect(isDryRun()).toBe(false);
  });
});

describe("publishToPage", () => {
  it("DRY-RUN by default: returns dryRun result and does NOT call fetch", async () => {
    delete process.env.AUTOPOST_DRY_RUN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishToPage({ message: "hi", imageUrls: ["a.jpg"] });

    expect(result.dryRun).toBe(true);
    expect(result.postId.startsWith("dryrun_")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("single image: posts to /<pageId>/photos once", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ post_id: "123_456" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishToPage({ message: "hi", imageUrls: ["a.jpg"] });

    expect(result.postId).toBe("123_456");
    expect(result.dryRun).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/123/photos");
  });

  it("multi image (3): uploads 3 then posts to /<pageId>/feed", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "m1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "m2" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "m3" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "123_999" }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishToPage({
      message: "hi",
      imageUrls: ["a.jpg", "b.jpg", "c.jpg"],
    });

    expect(result.postId).toBe("123_999");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3][0])).toContain("/123/feed");
  });

  it("throws when Facebook returns a non-ok response", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "bad" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publishToPage({ message: "hi", imageUrls: ["a.jpg"] }),
    ).rejects.toThrow();
  });

  it("throws when token is missing", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    process.env.FB_PAGE_ACCESS_TOKEN = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publishToPage({ message: "hi", imageUrls: ["a.jpg"] }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("verifyPageToken", () => {
  it("never throws — resolves to { ok:false } when fetch rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyPageToken();

    expect(result.ok).toBe(false);
    expect(result.canPost).toBe(false);
  });
});
