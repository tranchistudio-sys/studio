import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMediaType, hashImageUrl, fetchImageAsBase64, resolvePublicUrl } from "./autopost-images";

describe("normalizeMediaType", () => {
  it("passes through whitelisted image types", () => {
    expect(normalizeMediaType("image/jpeg", "x")).toBe("image/jpeg");
    expect(normalizeMediaType("image/png", "x")).toBe("image/png");
    expect(normalizeMediaType("image/gif", "x")).toBe("image/gif");
    expect(normalizeMediaType("image/webp", "x")).toBe("image/webp");
  });

  it("maps image/jpg -> image/jpeg", () => {
    expect(normalizeMediaType("image/jpg", "x")).toBe("image/jpeg");
  });

  it("strips charset suffix", () => {
    expect(normalizeMediaType("image/jpeg; charset=utf-8", "x")).toBe("image/jpeg");
  });

  it("infers from url extension when content-type is wrong", () => {
    expect(normalizeMediaType("text/html", "https://x.com/a.png")).toBe("image/png");
  });

  it("returns null for non-whitelisted + non-image extension", () => {
    expect(normalizeMediaType("application/octet-stream", "https://x.com/a.txt")).toBeNull();
  });
});

describe("resolvePublicUrl", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    // Mặc định: không có env public → rơi về domain production fallback.
    delete process.env.PUBLIC_APP_URL;
    delete process.env.REPLIT_DOMAINS;
    delete process.env.REPLIT_DEV_DOMAIN;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("maps /objects/<x> to /api/storage and prefixes the public origin", () => {
    expect(resolvePublicUrl("/objects/uploads/abc.webp")).toBe(
      "https://tranchistudio.com/api/storage/objects/uploads/abc.webp",
    );
  });

  it("maps /public-objects/<x> through /api/storage too", () => {
    expect(resolvePublicUrl("/public-objects/x.jpg")).toBe(
      "https://tranchistudio.com/api/storage/public-objects/x.jpg",
    );
  });

  it("keeps /uploads/... at the domain root (served statically)", () => {
    expect(resolvePublicUrl("/uploads/cms/x.jpg")).toBe("https://tranchistudio.com/uploads/cms/x.jpg");
  });

  it("adds a leading slash to bare relative paths", () => {
    expect(resolvePublicUrl("uploads/x.jpg")).toBe("https://tranchistudio.com/uploads/x.jpg");
  });

  it("prefers PUBLIC_APP_URL when set", () => {
    process.env.PUBLIC_APP_URL = "https://cdn.example.com/";
    expect(resolvePublicUrl("/objects/x")).toBe("https://cdn.example.com/api/storage/objects/x");
  });

  it("leaves a real absolute URL unchanged", () => {
    expect(resolvePublicUrl("https://other.cdn/a.png")).toBe("https://other.cdn/a.png");
  });

  it("rewrites a localhost absolute URL to the public origin", () => {
    expect(resolvePublicUrl("http://localhost:5173/objects/x")).toBe(
      "https://tranchistudio.com/api/storage/objects/x",
    );
  });

  it("returns empty string for empty input", () => {
    expect(resolvePublicUrl("")).toBe("");
  });
});

describe("hashImageUrl", () => {
  it("is deterministic", () => {
    expect(hashImageUrl("https://x.com/a.png")).toBe(hashImageUrl("https://x.com/a.png"));
  });

  it("differs for different urls", () => {
    expect(hashImageUrl("https://x.com/a.png")).not.toBe(hashImageUrl("https://x.com/b.png"));
  });
});

describe("fetchImageAsBase64", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(impl: () => Promise<Response> | Response) {
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  function makeRes(opts: {
    ok: boolean;
    contentType: string | null;
    body: ArrayBuffer;
  }): Response {
    return {
      ok: opts.ok,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? opts.contentType : null) },
      arrayBuffer: async () => opts.body,
    } as unknown as Response;
  }

  it("returns base64 for a small ok png", async () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    mockFetch(() => makeRes({ ok: true, contentType: "image/png", body: buf }));
    const out = await fetchImageAsBase64("https://x.com/a.png");
    expect(out).not.toBeNull();
    expect(out!.mediaType).toBe("image/png");
    expect(out!.dataBase64.length).toBeGreaterThan(0);
  });

  it("returns null when res.ok is false", async () => {
    mockFetch(() => makeRes({ ok: false, contentType: "image/png", body: new ArrayBuffer(4) }));
    expect(await fetchImageAsBase64("https://x.com/a.png")).toBeNull();
  });

  it("returns null when content-type is text/html and url ext is .txt", async () => {
    mockFetch(() => makeRes({ ok: true, contentType: "text/html", body: new ArrayBuffer(4) }));
    expect(await fetchImageAsBase64("https://x.com/a.txt")).toBeNull();
  });

  it("returns null for oversized (>5MB) images", async () => {
    const big = new ArrayBuffer(5 * 1024 * 1024 + 1);
    mockFetch(() => makeRes({ ok: true, contentType: "image/png", body: big }));
    expect(await fetchImageAsBase64("https://x.com/a.png")).toBeNull();
  });

  it("returns null (never throws) when fetch throws", async () => {
    mockFetch(() => {
      throw new Error("network down");
    });
    expect(await fetchImageAsBase64("https://x.com/a.png")).toBeNull();
  });

  it("returns null for empty url", async () => {
    mockFetch(() => makeRes({ ok: true, contentType: "image/png", body: new ArrayBuffer(4) }));
    expect(await fetchImageAsBase64("")).toBeNull();
  });
});
