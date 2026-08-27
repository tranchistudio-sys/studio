import { describe, expect, it } from "vitest";
import { formatCommonSaleScript } from "./sale-common-script";

describe("formatCommonSaleScript", () => {
  it("ghép B1–B3 theo đúng nội dung admin đã lưu", () => {
    const result = formatCommonSaleScript([
      { step: 1, question: "Khách mới chào", answer: "Dạ em chào anh ạ." },
      { step: 2, question: "Khách chưa rõ nhu cầu", answer: "Anh đang quan tâm dịch vụ nào ạ?" },
      { step: 3, question: "Khách nói chụp cổng", answer: "Chuyển sang kịch bản chụp cổng." },
    ]);
    expect(result).toContain("BƯỚC CHUNG B1");
    expect(result).toContain("Anh đang quan tâm dịch vụ nào ạ?");
    expect(result).toContain("chuyển sang đúng kịch bản riêng");
    expect(result).toContain("không được dùng để tự tạo giá");
  });

  it("bỏ dòng rỗng và trả null khi không có nội dung hợp lệ", () => {
    expect(formatCommonSaleScript([
      { step: 1, question: " ", answer: null },
      { step: 4, question: "Không thuộc phần chung", answer: "Bỏ qua" },
    ])).toBeNull();
  });
});
