import { beforeEach, describe, expect, it, vi } from "vitest";

// MOCK hai module phụ thuộc để KHÔNG chạm API/network/DB thật.
vi.mock("./ai-orchestrator", () => ({ callChat: vi.fn() }));
vi.mock("./autopost-images", () => ({
  fetchImageAsBase64: vi.fn(),
  resolvePublicUrl: (u: string) => u,
}));

import { callChat } from "./ai-orchestrator";
import { fetchImageAsBase64 } from "./autopost-images";
import {
  DEFAULT_BANNED_WORDS,
  formatVnd,
  parseMoneyToken,
  priceGuard,
  bannedWordsGuard,
  parseCaptions,
  generateCaptions,
  type CaptionItem,
} from "./autopost-caption";

const mockCallChat = vi.mocked(callChat);
const mockFetchImage = vi.mocked(fetchImageAsBase64);

function makeItem(overrides: Partial<CaptionItem> = {}): CaptionItem {
  return {
    contentType: "dress",
    title: "Váy cưới Lệ Thủy",
    images: ["https://x.com/a.jpg"],
    price: 1500000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("formatVnd", () => {
  it("groups thousands and appends đ", () => {
    expect(formatVnd(1500000)).toBe("1.500.000đ");
  });
  it("returns empty string for 0 / null", () => {
    expect(formatVnd(0)).toBe("");
    expect(formatVnd(null)).toBe("");
    expect(formatVnd(undefined)).toBe("");
    expect(formatVnd(NaN)).toBe("");
  });
});

describe("parseMoneyToken", () => {
  it("parses grouped digits", () => {
    expect(parseMoneyToken("1.500.000")).toBe(1500000);
  });
  it("parses k suffix", () => {
    expect(parseMoneyToken("1500k")).toBe(1500000);
  });
  it("parses tr / triệu suffix with decimal tail", () => {
    expect(parseMoneyToken("1tr5")).toBe(1500000);
    expect(parseMoneyToken("1.5 triệu")).toBe(1500000);
  });
  it("returns null for non-money", () => {
    expect(parseMoneyToken("abc")).toBeNull();
  });
});

describe("priceGuard", () => {
  it("does not flag a matching price and leaves text unchanged", () => {
    const item = makeItem({ price: 1500000 });
    const caption = "Thuê chỉ 1.500.000đ thôi nhé!";
    const out = priceGuard(caption, item);
    expect(out.suspicious).toBe(false);
    expect(out.text).toBe(caption);
  });

  it("flags a non-matching price and prefixes warning", () => {
    const item = makeItem({ price: 1500000 });
    const out = priceGuard("Giá sốc 9.999.000đ", item);
    expect(out.suspicious).toBe(true);
    expect(out.text.startsWith("⚠️[KIỂM TRA GIÁ]")).toBe(true);
  });

  it("flags ANY money token when item has no price", () => {
    const item = makeItem({ price: null, salePrice: null });
    const out = priceGuard("Chỉ 500k nha", item);
    expect(out.suspicious).toBe(true);
  });

  it("does not flag plain small numbers like years or '2-4 câu'", () => {
    const item = makeItem({ price: 1500000 });
    const out = priceGuard("Bộ sưu tập 2024, viết 2-4 câu là đẹp", item);
    expect(out.suspicious).toBe(false);
  });

  it("does not flag the 'NtrM' shorthand (1tr5) that matches the real price", () => {
    const out = priceGuard("Chỉ 1tr5", { ...makeItem(), price: 1500000 });
    expect(out.suspicious).toBe(false);
  });

  it("still flags an 'NtrM' shorthand that does NOT match the real price", () => {
    const out = priceGuard("Chỉ 9tr5", { ...makeItem(), price: 1500000 });
    expect(out.suspicious).toBe(true);
  });
});

describe("bannedWordsGuard", () => {
  it("returns banned phrases found", () => {
    expect(bannedWordsGuard("Đợt này giảm sốc lắm", DEFAULT_BANNED_WORDS)).toEqual(["giảm sốc"]);
  });
  it("returns empty for clean caption", () => {
    expect(bannedWordsGuard("Một caption sạch sẽ dễ thương", DEFAULT_BANNED_WORDS)).toEqual([]);
  });
});

describe("parseCaptions", () => {
  it("parses plain JSON", () => {
    const out = parseCaptions('{"captions":["a","b"],"recommendedIndex":1}');
    expect(out).not.toBeNull();
    expect(out!.captions).toEqual(["a", "b"]);
    expect(out!.recommendedIndex).toBe(1);
  });

  it("parses JSON wrapped in ```json fences", () => {
    const out = parseCaptions('```json\n{"captions":["x"],"recommendedIndex":0}\n```');
    expect(out).not.toBeNull();
    expect(out!.captions).toEqual(["x"]);
  });

  it("parses JSON with trailing prose", () => {
    const out = parseCaptions('Đây là kết quả: {"captions":["y","z"],"recommendedIndex":0} Chúc bạn vui!');
    expect(out).not.toBeNull();
    expect(out!.captions).toEqual(["y", "z"]);
  });

  it("returns null on garbage", () => {
    expect(parseCaptions("không có json gì cả")).toBeNull();
    expect(parseCaptions("")).toBeNull();
  });
});

describe("generateCaptions", () => {
  it("happy path with vision", async () => {
    mockFetchImage.mockResolvedValue({ mediaType: "image/jpeg", dataBase64: "AAA" });
    mockCallChat.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ captions: ["a", "b", "c"], recommendedIndex: 1 }),
      providerUsed: "claude",
    } as never);

    const res = await generateCaptions(makeItem());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.captions).toHaveLength(3);
      expect(res.recommendedIndex).toBe(1);
      expect(res.usedVision).toBe(true);
      expect(res.provider).toBe("claude");
    }
  });

  it("falls back to metadata-only when first (vision) attempt fails", async () => {
    mockFetchImage.mockResolvedValue({ mediaType: "image/jpeg", dataBase64: "AAA" });
    mockCallChat
      .mockResolvedValueOnce({ ok: false, reason: "all_failed", adminAlert: "x" } as never)
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({ captions: ["m1", "m2", "m3"], recommendedIndex: 0 }),
        providerUsed: "claude",
      } as never);

    const res = await generateCaptions(makeItem());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.usedVision).toBe(false);
      expect(res.captions).toHaveLength(3);
    }
    expect(mockCallChat).toHaveBeenCalledTimes(2);
    // Lần gọi thứ hai KHÔNG kèm ảnh.
    const secondCallArg = mockCallChat.mock.calls[1][0];
    expect(secondCallArg.messages[0].images).toBeUndefined();
  });

  it("returns ok:false (never throws) when both attempts fail", async () => {
    mockFetchImage.mockResolvedValue(null);
    mockCallChat.mockResolvedValue({ ok: false, reason: "all_failed", adminAlert: "x" } as never);

    const res = await generateCaptions(makeItem());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(typeof res.reason).toBe("string");
    }
  });

  it("applies price guard so a wrong price flags suspiciousPrice", async () => {
    mockFetchImage.mockResolvedValue(null);
    mockCallChat.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ captions: ["Giá chỉ 9.999.000đ thôi"], recommendedIndex: 0 }),
      providerUsed: "claude",
    } as never);

    const res = await generateCaptions(makeItem({ price: 1500000 }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.captions[0].flags.suspiciousPrice).toBe(true);
    }
  });
});
