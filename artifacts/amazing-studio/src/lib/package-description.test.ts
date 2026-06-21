import { describe, it, expect } from "vitest";
import { reflowDescriptionLines, firstDescriptionLine } from "./package-description";

describe("reflowDescriptionLines", () => {
  it("rejoins hard-wrapped continuation lines into their bullet (real SILVER data)", () => {
    const silver =
      "GÓI SILVER\n\n• 1 LẦN TRANG ĐIỂM\nTẠI STUDIO\n• 1 SARE - 1 VEST\n• 1 ÁO DÀI CÔ DÂU\n• TẶNG 1 BÓ HOA\nTƯƠI CẦM TAY\n• 6 ÁO MÂM QUẢ NỮ\n• 6 NƠ QUÀ NAM\n• THÊM 6 ÁO DÀI\nBƯNG QUẢ NAM\n500K\n\n6tr\n";
    expect(reflowDescriptionLines(silver)).toEqual([
      "GÓI SILVER",
      "• 1 LẦN TRANG ĐIỂM TẠI STUDIO",
      "• 1 SARE - 1 VEST",
      "• 1 ÁO DÀI CÔ DÂU",
      "• TẶNG 1 BÓ HOA TƯƠI CẦM TAY",
      "• 6 ÁO MÂM QUẢ NỮ",
      "• 6 NƠ QUÀ NAM",
      "• THÊM 6 ÁO DÀI BƯNG QUẢ NAM 500K",
      "6tr",
    ]);
  });

  it("handles GOLD wrap pattern (break after a mid-phrase word)", () => {
    const gold =
      "GÓI GOLD\n\n• 2 LẦN TRANG ĐIỂM TẠI\nSTUDIO\n• 2 SARE - 2 VEST\n• 1 ÁO DÀI CÔ DÂU\n• TẶNG 1 BÓ HOA TƯƠI\nCẦM TAY\n• 6 ÁO MÂM QUẢ NỮ\n• 6 NƠ QUÀ NAM\n• THÊM 6 ÁO DÀI BƯNG\nQUẢ NAM 500K";
    expect(reflowDescriptionLines(gold)).toEqual([
      "GÓI GOLD",
      "• 2 LẦN TRANG ĐIỂM TẠI STUDIO",
      "• 2 SARE - 2 VEST",
      "• 1 ÁO DÀI CÔ DÂU",
      "• TẶNG 1 BÓ HOA TƯƠI CẦM TAY",
      "• 6 ÁO MÂM QUẢ NỮ",
      "• 6 NƠ QUÀ NAM",
      "• THÊM 6 ÁO DÀI BƯNG QUẢ NAM 500K",
    ]);
  });

  it("leaves a well-formed description unchanged (no spurious merging)", () => {
    const clean = "• A\n• B\n• C";
    expect(reflowDescriptionLines(clean)).toEqual(["• A", "• B", "• C"]);
  });

  it("respects a blank line as an intentional separator", () => {
    const d = "• Mục 1\n\nGhi chú riêng";
    expect(reflowDescriptionLines(d)).toEqual(["• Mục 1", "Ghi chú riêng"]);
  });

  it("keeps plain multi-line text (no bullets) line by line", () => {
    const d = "Dòng 1\nDòng 2\nDòng 3";
    expect(reflowDescriptionLines(d)).toEqual(["Dòng 1", "Dòng 2", "Dòng 3"]);
  });

  it("handles empty / null", () => {
    expect(reflowDescriptionLines("")).toEqual([]);
    expect(reflowDescriptionLines(null)).toEqual([]);
    expect(reflowDescriptionLines(undefined)).toEqual([]);
  });

  it("firstDescriptionLine returns the first reflowed line", () => {
    expect(firstDescriptionLine("GÓI SILVER\n• A\nB")).toBe("GÓI SILVER");
    expect(firstDescriptionLine("")).toBe("");
  });
});
