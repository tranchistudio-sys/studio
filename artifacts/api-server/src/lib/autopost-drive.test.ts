import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chặn @workspace/db để import module KHÔNG nối DB thật (autopost-pool có top-level pool).
vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

import {
  normalizeVi,
  folderNameToContentType,
  classifyMime,
  readDriveEnv,
  driveClientSource,
  extractFolderId,
} from "./autopost-drive";

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
    ["Ý tưởng chụp", "photo_idea"],
  ];
  for (const [name, type] of cases) {
    it(`"${name}" → ${type}`, () => expect(folderNameToContentType(name)).toBe(type));
  }
  it("folder lạ → other", () => expect(folderNameToContentType("Linh tinh 123")).toBe("other"));
  it("'Phụ kiện đạo cụ mới' → other (không có type riêng, không nhầm 'mới về')", () =>
    expect(folderNameToContentType("Phụ kiện đạo cụ mới")).toBe("other"));
  it("'Tiệc cưới' → other (không nhầm 'váy cưới')", () =>
    expect(folderNameToContentType("Tiệc cưới")).toBe("other"));
  it("không nhầm 'Váy mới về' thành váy cưới", () => expect(folderNameToContentType("Váy mới về 2026")).toBe("new_arrival"));
  it("khớp khi tên có hậu tố", () => expect(folderNameToContentType("Váy cưới - tháng 6")).toBe("vay_cuoi"));
});

describe("extractFolderId — tách ID từ link hoặc ID thuần", () => {
  it("link /folders/<id>", () =>
    expect(extractFolderId("https://drive.google.com/drive/folders/1AbC-dEf_123?usp=sharing")).toBe("1AbC-dEf_123"));
  it("link /drive/u/0/folders/<id>", () =>
    expect(extractFolderId("https://drive.google.com/drive/u/0/folders/1XyZ_987")).toBe("1XyZ_987"));
  it("link open?id=<id>", () =>
    expect(extractFolderId("https://drive.google.com/open?id=1QwErTy-456")).toBe("1QwErTy-456"));
  it("link /d/<id>", () =>
    expect(extractFolderId("https://drive.google.com/file/d/1ShArEd_77/view")).toBe("1ShArEd_77"));
  it("ID thuần giữ nguyên", () => expect(extractFolderId("1AbCdEf_GhIj")).toBe("1AbCdEf_GhIj"));
  it("ID thuần có khoảng trắng → lọc", () => expect(extractFolderId("  1AbCdEf  ")).toBe("1AbCdEf"));
  it("rỗng → rỗng", () => { expect(extractFolderId("")).toBe(""); expect(extractFolderId(null)).toBe(""); expect(extractFolderId(undefined)).toBe(""); });
  it("URL lạ không nhận diện → rỗng", () => expect(extractFolderId("https://example.com/no-id-here")).toBe(""));
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

describe("driveClientSource — fallback GOOGLE_DRIVE_* → GOOGLE_*", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  afterEach(() => { process.env = { ...ORIGINAL }; });

  it("không có gì → rỗng + nguồn null", () => {
    expect(driveClientSource()).toEqual({ clientId: "", clientSecret: "", idVar: null, secretVar: null });
  });

  it("chỉ có GOOGLE_CLIENT_ID/SECRET → fallback đọc được + báo đúng tên biến", () => {
    process.env.GOOGLE_CLIENT_ID = "gid";
    process.env.GOOGLE_CLIENT_SECRET = "gsecret";
    expect(driveClientSource()).toEqual({
      clientId: "gid", clientSecret: "gsecret",
      idVar: "GOOGLE_CLIENT_ID", secretVar: "GOOGLE_CLIENT_SECRET",
    });
  });

  it("GOOGLE_DRIVE_* được ưu tiên hơn GOOGLE_*", () => {
    process.env.GOOGLE_CLIENT_ID = "gid";
    process.env.GOOGLE_CLIENT_SECRET = "gsecret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "did";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "dsecret";
    expect(driveClientSource()).toEqual({
      clientId: "did", clientSecret: "dsecret",
      idVar: "GOOGLE_DRIVE_CLIENT_ID", secretVar: "GOOGLE_DRIVE_CLIENT_SECRET",
    });
  });
});

describe("readDriveEnv", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  afterEach(() => { process.env = { ...ORIGINAL }; });

  it("thiếu hết → liệt kê đủ 3 biến (kèm fallback)", () => {
    const { creds, missing } = readDriveEnv();
    expect(creds).toBeNull();
    expect(missing).toEqual([
      "GOOGLE_DRIVE_CLIENT_ID (hoặc GOOGLE_CLIENT_ID)",
      "GOOGLE_DRIVE_CLIENT_SECRET (hoặc GOOGLE_CLIENT_SECRET)",
      "GOOGLE_DRIVE_REFRESH_TOKEN",
    ]);
  });

  it("client từ fallback GOOGLE_* + thiếu refresh → chỉ thiếu refresh token", () => {
    process.env.GOOGLE_CLIENT_ID = "gid";
    process.env.GOOGLE_CLIENT_SECRET = "gsecret";
    const { creds, missing } = readDriveEnv();
    expect(creds).toBeNull();
    expect(missing).toEqual(["GOOGLE_DRIVE_REFRESH_TOKEN"]);
  });

  it("đủ 3 biến (GOOGLE_DRIVE_*) → trả creds", () => {
    process.env.GOOGLE_DRIVE_CLIENT_ID = "id";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = "refresh";
    const { creds, missing } = readDriveEnv();
    expect(missing).toEqual([]);
    expect(creds).toEqual({ clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
  });
});
