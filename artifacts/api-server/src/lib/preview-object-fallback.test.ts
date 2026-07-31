import { describe, it, expect } from "vitest";
import {
  buildFallbackUrl,
  eligibleObjectId,
  fallbackBase,
  previewFetchMissingObject,
} from "./preview-object-fallback.js";

const UUID = "f0e2226d-bb9b-4ecd-a53c-c2be90d3192c";

describe("eligibleObjectId — chỉ nhận /objects/uploads/<uuid>", () => {
  it("path hợp lệ → trả uuid", () => {
    expect(eligibleObjectId(`/objects/uploads/${UUID}`)).toBe(UUID);
  });

  it("mọi path khác → null (không proxy tuỳ tiện)", () => {
    for (const p of [
      "/objects/uploads/../../../etc/passwd",
      "/objects/uploads/khong-phai-uuid",
      `/public-objects/uploads/${UUID}`,
      `/objects/uploads/${UUID}/extra`,
      "/api/customers",
      "",
    ]) {
      expect(eligibleObjectId(p)).toBeNull();
    }
  });
});

describe("fallbackBase — nguồn ảnh công khai", () => {
  it("mặc định là website studio, bỏ / cuối", () => {
    expect(fallbackBase({})).toBe("https://tranchistudio.com");
    expect(fallbackBase({ PREVIEW_OBJECT_FALLBACK_BASE: "https://tranchistudio.com//" })).toBe(
      "https://tranchistudio.com",
    );
  });

  it("đặt rỗng tường minh = tắt tính năng", () => {
    expect(fallbackBase({ PREVIEW_OBJECT_FALLBACK_BASE: "" })).toBeNull();
    expect(fallbackBase({ PREVIEW_OBJECT_FALLBACK_BASE: "  " })).toBeNull();
  });

  it("chỉ chấp nhận https", () => {
    expect(fallbackBase({ PREVIEW_OBJECT_FALLBACK_BASE: "http://tranchistudio.com" })).toBeNull();
    expect(fallbackBase({ PREVIEW_OBJECT_FALLBACK_BASE: "ftp://x" })).toBeNull();
  });
});

describe("buildFallbackUrl", () => {
  it("ghép đúng route ảnh công khai của production", () => {
    expect(buildFallbackUrl(`/objects/uploads/${UUID}`, {})).toBe(
      `https://tranchistudio.com/api/storage/objects/uploads/${UUID}`,
    );
  });

  it("path không hợp lệ hoặc base bị tắt → null", () => {
    expect(buildFallbackUrl("/objects/uploads/xxx", {})).toBeNull();
    expect(buildFallbackUrl(`/objects/uploads/${UUID}`, { PREVIEW_OBJECT_FALLBACK_BASE: "" })).toBeNull();
  });
});

describe("previewFetchMissingObject — production tuyệt đối không chạy", () => {
  it("không có PREVIEW_MODE=1 → null ngay, không fetch gì", async () => {
    expect(await previewFetchMissingObject(`/objects/uploads/${UUID}`, {})).toBeNull();
    expect(await previewFetchMissingObject(`/objects/uploads/${UUID}`, { PREVIEW_MODE: "0" })).toBeNull();
  });
});
