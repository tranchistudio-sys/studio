import { describe, expect, it } from "vitest";
import { clampEvidenceIndex, evidenceUrlList, stepEvidenceIndex } from "./evidence-viewer";

describe("evidenceUrlList", () => {
  it("ưu tiên mảng urls khi có phần tử", () => {
    expect(evidenceUrlList(["a", "b"], "c")).toEqual(["a", "b"]);
  });
  it("fallback về ảnh đơn khi mảng rỗng/null", () => {
    expect(evidenceUrlList([], "c")).toEqual(["c"]);
    expect(evidenceUrlList(null, "c")).toEqual(["c"]);
    expect(evidenceUrlList(undefined, "c")).toEqual(["c"]);
  });
  it("lọc phần tử rỗng trong mảng", () => {
    expect(evidenceUrlList(["", "a", "  "], null)).toEqual(["a"]);
  });
  it("không có ảnh nào → mảng rỗng", () => {
    expect(evidenceUrlList([], null)).toEqual([]);
    expect(evidenceUrlList(undefined, "")).toEqual([]);
    expect(evidenceUrlList(["", "  "], "  ")).toEqual([]);
  });
});

describe("stepEvidenceIndex", () => {
  it("tiến/lùi bình thường trong danh sách", () => {
    expect(stepEvidenceIndex(0, 1, 3)).toBe(1);
    expect(stepEvidenceIndex(2, -1, 3)).toBe(1);
  });
  it("vòng lại đầu/cuối danh sách", () => {
    expect(stepEvidenceIndex(2, 1, 3)).toBe(0);
    expect(stepEvidenceIndex(0, -1, 3)).toBe(2);
  });
  it("1 ảnh thì đứng yên", () => {
    expect(stepEvidenceIndex(0, 1, 1)).toBe(0);
    expect(stepEvidenceIndex(0, -1, 1)).toBe(0);
  });
  it("count 0 không âm/không NaN", () => {
    expect(stepEvidenceIndex(0, 1, 0)).toBe(0);
    expect(stepEvidenceIndex(0, -1, 0)).toBe(0);
  });
});

describe("clampEvidenceIndex", () => {
  it("giữ index hợp lệ", () => {
    expect(clampEvidenceIndex(1, 3)).toBe(1);
  });
  it("kẹp index ngoài biên", () => {
    expect(clampEvidenceIndex(-1, 3)).toBe(0);
    expect(clampEvidenceIndex(5, 3)).toBe(2);
    expect(clampEvidenceIndex(0, 0)).toBe(0);
  });
});
