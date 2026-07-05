import { describe, it, expect } from "vitest";
import { reflowDescriptionLines, firstDescriptionLine, parseDescriptionBlocks } from "./package-description";

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

describe("parseDescriptionBlocks", () => {
  it("phân block gói LUXURY thật: tiêu đề đậm, đoạn văn nối liền, bullet giữ nguyên chữ", () => {
    const luxury =
      "GÓI LUXURY\n\nGÓI: PHIÊN BẢN CAO CẤP\nNHẤT, NƠI MỌI CHI TIẾT ĐỀU\nĐƯỢC ĐẦU TƯ TỈ MỈ\n\nBAO GỒM:\n• 2 SARE + 2 ÁO VEST\n• 1 PHOTO MASTER\n• MAKE UP MASTER\n\nSẢN PHẨM:\n• 2 HÌNH CỔNG 60X90CM\nMICA GƯƠNG CAO CẤP\n• 10 HÌNH KHUNG 15X21CM\nÉP GỖ CAO CẤP (CÓ KHUNG)\n• TẶNG TOÀN BỘ FILE GỐC";
    expect(parseDescriptionBlocks(luxury)).toEqual([
      { type: "text", text: "GÓI LUXURY" },
      { type: "text", text: "GÓI: PHIÊN BẢN CAO CẤP NHẤT, NƠI MỌI CHI TIẾT ĐỀU ĐƯỢC ĐẦU TƯ TỈ MỈ" },
      { type: "heading", text: "BAO GỒM:" },
      { type: "bullet", text: "• 2 SARE + 2 ÁO VEST" },
      { type: "bullet", text: "• 1 PHOTO MASTER" },
      { type: "bullet", text: "• MAKE UP MASTER" },
      { type: "heading", text: "SẢN PHẨM:" },
      { type: "bullet", text: "• 2 HÌNH CỔNG 60X90CM MICA GƯƠNG CAO CẤP" },
      { type: "bullet", text: "• 10 HÌNH KHUNG 15X21CM ÉP GỖ CAO CẤP (CÓ KHUNG)" },
      { type: "bullet", text: "• TẶNG TOÀN BỘ FILE GỐC" },
    ]);
  });

  it("không đổi một ký tự nào — ghép lại đủ nguyên văn từng từ", () => {
    const src = "GÓI SILVER\n\nBAO GỒM:\n• 1 LẦN TRANG ĐIỂM\nTẠI STUDIO\n\n6tr";
    const joined = parseDescriptionBlocks(src).map(b => b.text).join(" ");
    const original = src.split(/\s+/).filter(Boolean).join(" ");
    expect(joined.split(/\s+/).filter(Boolean).join(" ")).toBe(original);
  });

  it("handles empty / null", () => {
    expect(parseDescriptionBlocks("")).toEqual([]);
    expect(parseDescriptionBlocks(null)).toEqual([]);
    expect(parseDescriptionBlocks(undefined)).toEqual([]);
  });
});
