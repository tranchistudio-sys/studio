import { describe, it, expect } from "vitest";
import { isStudioLocationQuestion, buildStudioContactBlock, STUDIO_ADDRESS } from "./sale-studio-facts";

describe("isStudioLocationQuestion — nhận diện câu hỏi địa chỉ/vị trí studio", () => {
  it("Case A: 'ĐỊA CHỈ TIỆM Ở ĐÂU NHI' → true", () => {
    expect(isStudioLocationQuestion("ĐỊA CHỈ TIỆM Ở ĐÂU NHI")).toBe(true);
  });

  it("Case B: 'EM Ở ĐÂU A' → true", () => {
    expect(isStudioLocationQuestion("EM Ở ĐÂU A")).toBe(true);
  });

  it("các cách hỏi địa chỉ khác (có/không dấu) → true", () => {
    const yes = [
      "địa chỉ tiệm ở đâu", "em ở đâu", "studio ở đâu", "tiệm mình ở đâu",
      "cho anh địa chỉ", "shop ở đâu", "cho xin địa chỉ với", "chỉ đường giúp em",
      "dia chi o dau", "quán ở đâu vậy", "cho cái google map", "địa điểm chụp ở đâu",
    ];
    for (const q of yes) expect(isStudioLocationQuestion(q)).toBe(true);
  });

  it("KHÔNG phải hỏi địa chỉ → false (tránh dương tính giả: 'có đâu', 'vào đâu'…)", () => {
    const no = [
      "chụp cưới bao nhiêu", "có đâu mà giảm", "vào đâu để xem giá",
      "ngày nào trống", "anh thích tone nhẹ nhàng", "",
    ];
    for (const q of no) expect(isStudioLocationQuestion(q)).toBe(false);
  });
});

describe("buildStudioContactBlock — fact địa chỉ cố định + luật trả lời trực tiếp", () => {
  it("chứa đúng địa chỉ chốt của studio", () => {
    expect(buildStudioContactBlock()).toContain(STUDIO_ADDRESS);
    expect(STUDIO_ADDRESS).toContain("Cách Mạng Tháng 8");
    expect(STUDIO_ADDRESS).toContain("Tây Ninh");
  });

  it("ép trả lời trực tiếp; cấm 'chưa có thông tin' / hỏi lại dịch vụ / chuyển người thật", () => {
    const b = buildStudioContactBlock();
    expect(b).toContain("TRẢ LỜI TRỰC TIẾP");
    expect(b).toContain("KHÔNG được nói \"chưa có thông tin\"");
    expect(b).toContain("KHÔNG hỏi lại khách cần chụp dịch vụ gì");
    expect(b).toContain("KHÔNG chuyển người thật");
  });

  it("nhận địa chỉ tuỳ biến nếu truyền vào; rỗng/space → fallback hằng số", () => {
    expect(buildStudioContactBlock("123 Đường Test")).toContain("123 Đường Test");
    expect(buildStudioContactBlock("   ")).toContain(STUDIO_ADDRESS);
  });
});
