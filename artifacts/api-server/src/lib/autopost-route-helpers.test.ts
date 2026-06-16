import { describe, expect, it } from "vitest";
import {
  isValidStatus,
  sha1,
  poolRowToCaptionItem,
  clampImages,
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
});
