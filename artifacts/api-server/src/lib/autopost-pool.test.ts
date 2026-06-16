import { describe, expect, it, vi } from "vitest";

// Chặn @workspace/db để KHÔNG kết nối DB thật khi import module (top-level new Pool).
// Test này chỉ kiểm tra các pure helper — không gọi hàm DB nào.
vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn() },
}));

import {
  parseExtraImages,
  collectImages,
  inferDressContentType,
  inferGalleryContentType,
  buildPublicLink,
  mapDressRow,
  markMissing,
} from "./autopost-pool";
import { pool } from "@workspace/db";

describe("markMissing", () => {
  it("does NOT disable anything when keepIds is empty (avoids mass-disable on transient empty source)", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockClear();
    await markMissing("dresses", []);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("runs exactly one UPDATE when there are ids to keep", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockClear();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
    await markMissing("dresses", ["1", "2"]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("parseExtraImages", () => {
  it("parses a valid JSON array string", () => {
    expect(parseExtraImages('["a","b"]')).toEqual(["a", "b"]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseExtraImages("[bad")).toEqual([]);
  });

  it("returns [] for null", () => {
    expect(parseExtraImages(null)).toEqual([]);
  });
});

describe("collectImages", () => {
  it("dedupes and drops empties, preserving order", () => {
    expect(collectImages("a", '["a","b","","b","c"]')).toEqual(["a", "b", "c"]);
  });

  it("accepts an array for extra images", () => {
    expect(collectImages("a", ["b", "  ", "a"])).toEqual(["a", "b"]);
  });
});

describe("inferDressContentType", () => {
  it("ao_dai_cuoi", () => {
    expect(inferDressContentType("Áo dài cưới", "Đồ ngày cưới")).toBe("ao_dai_cuoi");
  });
  it("viet_phuc", () => {
    expect(inferDressContentType("Việt phục", "Đồ beauty")).toBe("viet_phuc");
  });
  it("beauty", () => {
    expect(inferDressContentType("Cổ phục", "Đồ beauty")).toBe("beauty");
  });
  it("vay_cuoi default", () => {
    expect(inferDressContentType("Váy đuôi cá", "Đồ chụp hình cưới")).toBe("vay_cuoi");
  });
});

describe("inferGalleryContentType", () => {
  it("album_cuoi", () => {
    expect(inferGalleryContentType("Cưới")).toBe("album_cuoi");
  });
  it("beauty", () => {
    expect(inferGalleryContentType("Beauty")).toBe("beauty");
  });
});

describe("buildPublicLink", () => {
  it("dress link", () => {
    expect(buildPublicLink("dress", "sp-1", "https://x.com")).toBe("https://x.com/san-pham/sp-1");
  });
  it("photo_idea -> null", () => {
    expect(buildPublicLink("photo_idea", "pi-1", "https://x.com")).toBeNull();
  });
  it("empty base -> null", () => {
    expect(buildPublicLink("dress", "sp-1", "")).toBeNull();
  });
});

describe("mapDressRow", () => {
  it("maps a full row: 3 images, price, salePrice null when sale 0, link + contentType, eligible", () => {
    const row = {
      id: 1,
      name: "Váy A",
      code: "A1",
      color: "trắng",
      size: "M",
      categoryId: 10,
      rentalPrice: "2000000",
      salePrice: "0",
      sellPrice: "0",
      outfitTag: "hot",
      rentalStatus: "available",
      coverImageUrl: "https://x.com/cover.jpg",
      extraImages: '["https://x.com/e1.jpg","https://x.com/e2.jpg"]',
      slug: "vay-a",
      categoryName: "Áo dài cưới",
      parentName: "Đồ cưới",
    };
    const item = mapDressRow(row, "https://x.com");
    expect(item.images).toHaveLength(3);
    expect(item.price).toBe(2000000);
    expect(item.salePrice).toBeNull();
    expect(item.publicLink).toBe("https://x.com/san-pham/vay-a");
    expect(item.contentType).toBe("ao_dai_cuoi");
    expect(item.isEligible).toBe(true);
  });

  it("salePrice set when 0 < sale < rental", () => {
    const row = {
      id: 2,
      name: "Váy B",
      rentalPrice: "2000000",
      salePrice: "1500000",
      coverImageUrl: "https://x.com/cover.jpg",
      extraImages: null,
      slug: "vay-b",
      categoryName: "Váy cưới",
      parentName: null,
    };
    const item = mapDressRow(row, "https://x.com");
    expect(item.salePrice).toBe(1500000);
  });

  it("isEligible false when no image", () => {
    const row = {
      id: 3,
      name: "Váy C",
      rentalPrice: "0",
      salePrice: "0",
      coverImageUrl: null,
      extraImages: null,
      slug: "vay-c",
      categoryName: null,
      parentName: null,
    };
    const item = mapDressRow(row, "https://x.com");
    expect(item.images).toHaveLength(0);
    expect(item.isEligible).toBe(false);
  });
});
