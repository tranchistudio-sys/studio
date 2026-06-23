import { describe, expect, it } from "vitest";
import {
  isValidStatus,
  sha1,
  poolRowToCaptionItem,
  clampImages,
  DEFAULT_POST_IMAGES,
  resolveSlotImageCount,
} from "./autopost-route-helpers";

describe("isValidStatus", () => {
  it("accepts known statuses", () => {
    expect(isValidStatus("approved")).toBe(true);
    expect(isValidStatus("pending_review")).toBe(true);
    expect(isValidStatus("posted")).toBe(true);
  });
  it("rejects unknown / non-string", () => {
    expect(isValidStatus("bogus")).toBe(false);
    expect(isValidStatus("")).toBe(false);
    expect(isValidStatus(123)).toBe(false);
    expect(isValidStatus(null)).toBe(false);
  });
});

describe("sha1", () => {
  it("is deterministic", () => {
    expect(sha1("hello")).toBe(sha1("hello"));
  });
  it("differs for different input", () => {
    expect(sha1("hello")).not.toBe(sha1("world"));
  });
  it("handles empty/falsy as hash of empty string", () => {
    expect(sha1("")).toBe(sha1(undefined as unknown as string));
  });
});

describe("poolRowToCaptionItem", () => {
  it("maps a snake_case row", () => {
    const row = {
      content_type: "vay_cuoi",
      title: "Váy A",
      images: '["https://x/1.jpg","https://x/2.jpg"]',
      price: "1500000",
      sale_price: "1200000",
      golden_hour_percent: "20",
      golden_hour_name: "Giờ vàng",
      category: "Váy cưới",
      badge: "HOT",
      public_link: "https://site/san-pham/vay-a",
    };
    const item = poolRowToCaptionItem(row);
    expect(item.contentType).toBe("vay_cuoi");
    expect(item.title).toBe("Váy A");
    expect(item.images).toEqual(["https://x/1.jpg", "https://x/2.jpg"]);
    expect(item.price).toBe(1500000);
    expect(item.salePrice).toBe(1200000);
    expect(item.goldenHourPercent).toBe(20);
    expect(item.goldenHourName).toBe("Giờ vàng");
    expect(item.category).toBe("Váy cưới");
    expect(item.badge).toBe("HOT");
    expect(item.publicLink).toBe("https://site/san-pham/vay-a");
  });

  it("maps a camelCase row with images already an array", () => {
    const row = {
      contentType: "album_cuoi",
      title: "Album B",
      images: ["a.jpg", "b.jpg"],
      price: 0,
      salePrice: null,
      goldenHourPercent: null,
      goldenHourName: null,
      category: null,
      badge: null,
      publicLink: "https://site/bo-anh/album-b",
    };
    const item = poolRowToCaptionItem(row);
    expect(item.contentType).toBe("album_cuoi");
    expect(item.images).toEqual(["a.jpg", "b.jpg"]);
    expect(item.publicLink).toBe("https://site/bo-anh/album-b");
  });

  it("defaults missing fields to null / []", () => {
    const item = poolRowToCaptionItem({});
    expect(item.contentType).toBe("");
    expect(item.title).toBe("");
    expect(item.images).toEqual([]);
    expect(item.price).toBeNull();
    expect(item.salePrice).toBeNull();
    expect(item.goldenHourPercent).toBeNull();
    expect(item.goldenHourName).toBeNull();
    expect(item.category).toBeNull();
    expect(item.badge).toBeNull();
    expect(item.publicLink).toBeNull();
  });

  it("returns [] for unparseable images and does not throw", () => {
    expect(poolRowToCaptionItem({ images: "not json" }).images).toEqual([]);
    expect(poolRowToCaptionItem(null).images).toEqual([]);
  });
});

describe("clampImages", () => {
  it("filters empties and keeps first N", () => {
    expect(clampImages(["a", "", "b"], 2)).toEqual(["a", "b"]);
  });
  it("clamps to a single image", () => {
    expect(clampImages(["a", "b", "c"], 1)).toEqual(["a"]);
  });
  it("returns [] for empty input", () => {
    expect(clampImages([], 1)).toEqual([]);
  });
  it("treats count<1 as 1", () => {
    expect(clampImages(["a", "b"], 0)).toEqual(["a"]);
  });

  it("keeps all 7 images of an album when using the default cap", () => {
    const seven = Array.from({ length: 7 }, (_, i) => `img${i}.jpg`);
    expect(clampImages(seven, DEFAULT_POST_IMAGES)).toEqual(seven); // 7 <= 10 → giữ đủ
  });

  it("caps a large album at the default (10) image budget", () => {
    const many = Array.from({ length: 31 }, (_, i) => `img${i}.jpg`);
    expect(clampImages(many, DEFAULT_POST_IMAGES)).toHaveLength(10);
  });
});

describe("DEFAULT_POST_IMAGES", () => {
  it("is 10 (2–10 ảnh/bài, không spam 50)", () => {
    expect(DEFAULT_POST_IMAGES).toBe(10);
  });
});

describe("resolveSlotImageCount", () => {
  it("respects an explicit cap >= 2", () => {
    expect(resolveSlotImageCount(3)).toBe(3);
    expect(resolveSlotImageCount(10)).toBe(10);
  });
  it("treats the buggy old default (1), 0, null/undefined as DEFAULT_POST_IMAGES", () => {
    expect(resolveSlotImageCount(1)).toBe(DEFAULT_POST_IMAGES);
    expect(resolveSlotImageCount(0)).toBe(DEFAULT_POST_IMAGES);
    expect(resolveSlotImageCount(null)).toBe(DEFAULT_POST_IMAGES);
    expect(resolveSlotImageCount(undefined)).toBe(DEFAULT_POST_IMAGES);
  });
  it("handles non-numeric input as DEFAULT_POST_IMAGES (never NaN)", () => {
    expect(resolveSlotImageCount("abc")).toBe(DEFAULT_POST_IMAGES);
  });
});
