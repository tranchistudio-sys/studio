import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chặn @workspace/db để import module KHÔNG cần DATABASE_URL và KHÔNG nối DB thật.
// pool.query mặc định trả rows:[] -> các helper rơi về fallback env.
vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// resolvePublicUrl: mô phỏng hành vi thật — luôn trả URL TUYỆT ĐỐI (để HEAD-check
// trong publishToPage chạy được). Đường dẫn tương đối được gắn origin test.
vi.mock("./autopost-images", () => ({
  resolvePublicUrl: (u: string) =>
    /^https?:\/\//i.test(u) ? u : `https://test.local/${u.replace(/^\//, "")}`,
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

const isHead = (c: unknown[]) => (c[1] as { method?: string } | undefined)?.method === "HEAD";

// fetch mock: HEAD (precheck ảnh) luôn OK + content-type ảnh; POST do postImpl xử lý.
function headOkThenPost(
  postImpl: (url: string, opts?: RequestInit) => Promise<unknown>,
) {
  return vi.fn((url: unknown, opts?: RequestInit) => {
    if (opts?.method === "HEAD") {
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => "image/jpeg" } });
    }
    return postImpl(String(url), opts);
  });
}

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

  it("single image: HEAD-checks then posts to /<pageId>/photos once", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    const fetchMock = headOkThenPost(() =>
      Promise.resolve({ ok: true, json: async () => ({ post_id: "123_456" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishToPage({ message: "hi", imageUrls: ["a.jpg"] });

    expect(result.postId).toBe("123_456");
    expect(result.dryRun).toBe(false);
    const headCalls = fetchMock.mock.calls.filter(isHead);
    const postCalls = fetchMock.mock.calls.filter((c) => !isHead(c));
    expect(headCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
    expect(String(postCalls[0][0])).toContain("/123/photos");
  });

  it("multi image (3): uploads 3 then posts to /<pageId>/feed", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    let n = 0;
    const fetchMock = headOkThenPost((url) => {
      if (url.includes("/feed")) return Promise.resolve({ ok: true, json: async () => ({ id: "123_999" }) });
      n += 1;
      return Promise.resolve({ ok: true, json: async () => ({ id: "m" + n }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishToPage({
      message: "hi",
      imageUrls: ["a.jpg", "b.jpg", "c.jpg"],
    });

    expect(result.postId).toBe("123_999");
    const postCalls = fetchMock.mock.calls.filter((c) => !isHead(c));
    expect(postCalls).toHaveLength(4); // 3 upload + 1 feed
    expect(String(postCalls[postCalls.length - 1][0])).toContain("/123/feed");
  });

  it("multi image: uploads each as unpublished (published=false) then attaches all to /feed", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    const fetchMock = headOkThenPost((url, opts) => {
      if (url.includes("/feed")) {
        const body = String((opts?.body as URLSearchParams | undefined)?.toString() ?? "");
        // 3 ảnh -> attached_media[0..2] đều có mặt trong body feed.
        expect(body).toContain("attached_media%5B0%5D");
        expect(body).toContain("attached_media%5B2%5D");
        return Promise.resolve({ ok: true, json: async () => ({ id: "123_999" }) });
      }
      const body = String((opts?.body as URLSearchParams | undefined)?.toString() ?? "");
      expect(body).toContain("published=false"); // upload phải là unpublished
      return Promise.resolve({ ok: true, json: async () => ({ id: "m" }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishToPage({ message: "hi", imageUrls: ["a.jpg", "b.jpg", "c.jpg"] });

    expect(result.postId).toBe("123_999");
    const postCalls = fetchMock.mock.calls.filter((c) => !isHead(c));
    expect(postCalls).toHaveLength(4); // 3 upload + 1 feed
    expect(String(postCalls[0][0])).toContain("/v25.0/"); // dùng Graph API v25.0
  });

  it("caps a large album at 50 photos (52 -> 50 uploads + 1 feed)", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    let uploads = 0;
    const fetchMock = headOkThenPost((url) => {
      if (url.includes("/feed")) return Promise.resolve({ ok: true, json: async () => ({ id: "123_cap" }) });
      uploads += 1;
      return Promise.resolve({ ok: true, json: async () => ({ id: "m" + uploads }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const imageUrls = Array.from({ length: 52 }, (_, i) => `img${i}.jpg`);
    const result = await publishToPage({ message: "hi", imageUrls });

    expect(result.postId).toBe("123_cap");
    expect(uploads).toBe(50); // chỉ upload 50 ảnh đầu
    const postCalls = fetchMock.mock.calls.filter((c) => !isHead(c));
    expect(postCalls).toHaveLength(51); // 50 upload + 1 feed
  });

  it("multi image: a single failing HEAD-check aborts with its URL and posts NOTHING", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    const fetchMock = vi.fn((url: unknown, opts?: RequestInit) => {
      if (opts?.method === "HEAD") {
        // Ảnh thứ 2 (b.jpg) hỏng → toàn bộ bài bị huỷ, không đăng nửa chừng.
        const ok = !String(url).includes("b.jpg");
        return Promise.resolve({ ok, status: ok ? 200 : 404, headers: { get: () => (ok ? "image/jpeg" : null) } });
      }
      return Promise.resolve({ ok: true, json: async () => ({ id: "should-not-happen" }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publishToPage({ message: "hi", imageUrls: ["a.jpg", "b.jpg", "c.jpg"] }),
    ).rejects.toThrow(/b\.jpg/);
    // KHÔNG có POST nào (không upload, không feed) → không đăng nửa chừng.
    expect(fetchMock.mock.calls.filter((c) => !isHead(c))).toHaveLength(0);
  });

  it("throws when Facebook returns a non-ok response", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    const fetchMock = headOkThenPost(() =>
      Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "bad" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publishToPage({ message: "hi", imageUrls: ["a.jpg"] }),
    ).rejects.toThrow(/FB photos 400/);
  });

  it("throws a clear error (and skips POST) when image is not publicly reachable", async () => {
    process.env.AUTOPOST_DRY_RUN = "false";
    const fetchMock = vi.fn((_url: unknown, opts?: RequestInit) => {
      if (opts?.method === "HEAD") return Promise.resolve({ ok: false, status: 404, headers: { get: () => null } });
      return Promise.resolve({ ok: true, json: async () => ({ post_id: "x" }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publishToPage({ message: "hi", imageUrls: ["a.jpg"] }),
    ).rejects.toThrow(/HTTP 404/);
    expect(fetchMock.mock.calls.filter((c) => !isHead(c))).toHaveLength(0);
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
