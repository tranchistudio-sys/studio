import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chặn @workspace/db để import module KHÔNG nối DB thật (autopost-pool có top-level pool).
vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

import { normalizeVi, folderNameToContentType, classifyMime, readDriveEnv } from "./autopost-drive";

describe("normalizeVi", () => {
  it("bỏ dấu + thường hoá + đổi đ→d", () => {
    expect(normalizeVi("Áo Dài Cưới")).toBe("ao dai cuoi");
    expect(normalizeVi("Việt Phục")).toBe("viet phuc");
    expect(normalizeVi("  Bill Chốt Đơn ")).toBe("bill chot don");
  });
});

describe("folderNameToContentType — map 12 folder", () => {
  const cases: Array<[string, string]> = [
    ["Váy cưới", "vay_cuoi"],
    ["Áo dài cưới", "ao_dai_cuoi"],
    ["Việt phục", "viet_phuc"],
    ["Beauty", "beauty"],
    ["Chụp sản phẩm thật", "product_real"],
    ["Váy mới về", "new_arrival"],
    ["Album cưới", "album_cuoi"],
    ["Hậu trường", "hau_truong"],
    ["Makeup", "makeup"],
    ["Video Reel", "reels"],
    ["Feedback", "feedback"],
    ["Bill chốt đơn", "bill"],
  ];
  for (const [name, type] of cases) {
    it(`"${name}" → ${type}`, () => expect(folderNameToContentType(name)).toBe(type));
  }
  it("folder lạ → other", () => expect(folderNameToContentType("Linh tinh 123")).toBe("other"));
  it("không nhầm 'Váy mới về' thành váy cưới", () => expect(folderNameToContentType("Váy mới về 2026")).toBe("new_arrival"));
  it("khớp khi tên có hậu tố", () => expect(folderNameToContentType("Váy cưới - tháng 6")).toBe("vay_cuoi"));
});

describe("classifyMime", () => {
  it("ảnh", () => { expect(classifyMime("image/jpeg")).toBe("image"); expect(classifyMime("image/webp")).toBe("image"); });
  it("video", () => { expect(classifyMime("video/mp4")).toBe("video"); });
  it("khác → null", () => {
    expect(classifyMime("application/pdf")).toBeNull();
    expect(classifyMime("application/vnd.google-apps.folder")).toBeNull();
    expect(classifyMime(undefined)).toBeNull();
  });
});

describe("readDriveEnv", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  });
  afterEach(() => { process.env = { ...ORIGINAL }; });

  it("thiếu hết → liệt kê đủ 3 biến", () => {
    const { creds, missing } = readDriveEnv();
    expect(creds).toBeNull();
    expect(missing).toEqual([
      "GOOGLE_DRIVE_CLIENT_ID",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
    ]);
  });

  it("thiếu 1 biến → báo đúng biến thiếu", () => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = "id";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "secret";
    const { creds, missing } = readDriveEnv();
    expect(creds).toBeNull();
    expect(missing).toEqual(["GOOGLE_DRIVE_REFRESH_TOKEN"]);
  });

  it("đủ 3 biến → trả creds", () => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = "id";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = "refresh";
    const { creds, missing } = readDriveEnv();
    expect(missing).toEqual([]);
    expect(creds).toEqual({ clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
  });
});
