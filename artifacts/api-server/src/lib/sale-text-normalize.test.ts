import { describe, it, expect } from "vitest";
import { normalizeVi, tokens, tokenSetKey, tokenOverlapRatio } from "./sale-text-normalize";

describe("normalizeVi", () => {
  it("bỏ dấu + lowercase + đ→d", () => {
    expect(normalizeVi("Album Cưới ĐẸP")).toBe("album cuoi dep");
  });
});

describe("tokens", () => {
  it("bỏ từ đệm + ký tự lạ, giữ từ ≥2 ký tự (lưu ý 'ảnh'→'anh' trùng stopword nên bị loại)", () => {
    expect(tokens("Dạ em có giao ảnh cổng không?")).toEqual(["giao", "cong"]);
  });
  it("bỏ token toàn số dài (SĐT) nhưng giữ số ngắn", () => {
    expect(tokens("gọi 0909123456 chụp 20/12")).toEqual(["goi", "chup", "20", "12"]);
  });
});

describe("tokenSetKey — khoá gom trùng nghĩa", () => {
  it("cùng bộ từ khác thứ tự/khác dấu → CÙNG khoá", () => {
    const a = tokenSetKey("Có giao ảnh cổng không?");
    const b = tokenSetKey("Ảnh cổng có giao tận nhà không ạ?");
    // b có thêm 'tan','nha' nên khác; nhưng cùng lõi giao/anh/cong
    expect(tokenSetKey("giao ảnh cổng")).toBe(tokenSetKey("cổng ảnh giao"));
    expect(a).toContain("cong");
    expect(b).toContain("giao");
  });
  it("câu rỗng/toàn từ đệm → khoá rỗng", () => {
    expect(tokenSetKey("dạ em ạ")).toBe("");
    expect(tokenSetKey("👍")).toBe("");
  });
});

describe("tokenOverlapRatio", () => {
  it("trùng hoàn toàn = 1, không trùng = 0", () => {
    expect(tokenOverlapRatio("giao ảnh cổng", "cổng giao ảnh")).toBe(1);
    expect(tokenOverlapRatio("giao ảnh cổng", "báo giá album")).toBe(0);
  });
});
