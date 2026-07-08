import { describe, expect, it } from "vitest";
import {
  normalizeSearchText,
  normalizePhone,
  normalizeOrderCode,
  tokenize,
  scoreSearchResult,
} from "./search-normalize";

describe("normalizeSearchText — bỏ dấu + lowercase", () => {
  it("bỏ dấu tiếng Việt", () => {
    expect(normalizeSearchText("Phan Thanh Trúc")).toBe("phan thanh truc");
    expect(normalizeSearchText("Lý Phước Trung")).toBe("ly phuoc trung");
    expect(normalizeSearchText("Đặng Thị Thanh Xuân")).toBe("dang thi thanh xuan");
  });
  it("gộp khoảng trắng thừa + trim", () => {
    expect(normalizeSearchText("  Phan   Thanh  ")).toBe("phan thanh");
  });
  it("chuỗi rỗng/null", () => {
    expect(normalizeSearchText("")).toBe("");
    expect(normalizeSearchText(null)).toBe("");
  });
});

describe("normalizePhone — chỉ giữ số", () => {
  it("bỏ khoảng trắng/dấu chấm", () => {
    expect(normalizePhone("035 314.4916")).toBe("0353144916");
    expect(normalizePhone("(035) 314-4916")).toBe("0353144916");
  });
});

describe("normalizeOrderCode — quy về cùng dạng", () => {
  it("184 / DH184 / DH0184 cùng gốc số", () => {
    expect(normalizeOrderCode("DH0184")).toBe("DH184");
    expect(normalizeOrderCode("dh184")).toBe("DH184");
    expect(normalizeOrderCode("184")).toBe("184");
    expect(normalizeOrderCode("DH0184 ")).toBe("DH184");
  });
  it("mã con giữ hậu tố, KHÔNG đụng mã khác (DH0184-2 ≠ DH1842)", () => {
    expect(normalizeOrderCode("DH0184-2")).toBe("DH184-2");
    expect(normalizeOrderCode("DH1842")).toBe("DH1842");
    expect(normalizeOrderCode("DH0184-2")).not.toBe(normalizeOrderCode("DH1842"));
  });
});

describe("tokenize", () => {
  it("tách + bỏ dấu", () => {
    expect(tokenize("thanh trúc")).toEqual(["thanh", "truc"]);
    expect(tokenize("  phuoc  trung ")).toEqual(["phuoc", "trung"]);
  });
});

describe("scoreSearchResult — các case chủ yêu cầu", () => {
  const truc = { customerName: "Phan Thanh Trúc", customerPhone: "0353144916", orderCode: "DH0184" };
  const trung = { customerName: "Lý Phước Trung", customerPhone: "0987654321", orderCode: "DH0200" };

  it('"thanh truc" (không dấu) ra Phan Thanh Trúc', () => {
    expect(scoreSearchResult("thanh truc", truc)).toBeGreaterThan(0);
  });
  it('"Thanh Trúc" (có dấu) ra', () => {
    expect(scoreSearchResult("Thanh Trúc", truc)).toBeGreaterThan(0);
  });
  it('"truc" ra Phan Thanh Trúc', () => {
    expect(scoreSearchResult("truc", truc)).toBeGreaterThan(0);
  });
  it('"Phan Thanh Trúc" full name ra, điểm cao nhất', () => {
    expect(scoreSearchResult("Phan Thanh Trúc", truc)).toBe(100);
  });
  it('"trung" ra Lý Phước Trung', () => {
    expect(scoreSearchResult("trung", trung)).toBeGreaterThan(0);
  });
  it('"phuoc trung" ra Lý Phước Trung', () => {
    expect(scoreSearchResult("phuoc trung", trung)).toBeGreaterThan(0);
  });
  it("SĐT đầy đủ ra", () => {
    expect(scoreSearchResult("0353144916", truc)).toBeGreaterThan(0);
  });
  it("4 số cuối ra", () => {
    expect(scoreSearchResult("4916", truc)).toBeGreaterThan(0);
  });
  it("SĐT có khoảng trắng/dấu chấm ra", () => {
    expect(scoreSearchResult("035 314.4916", truc)).toBeGreaterThan(0);
  });
  it('mã đơn "DH0184" ra', () => {
    expect(scoreSearchResult("DH0184", truc)).toBeGreaterThan(0);
  });
  it('gõ "184" gợi ý DH0184', () => {
    expect(scoreSearchResult("184", truc)).toBeGreaterThan(0);
  });
  it("không liên quan → 0", () => {
    expect(scoreSearchResult("xyz khong co", truc)).toBe(0);
  });
  it("khớp chính xác tên xếp trên khớp một phần", () => {
    const exact = scoreSearchResult("phan thanh truc", truc);
    const partial = scoreSearchResult("truc", truc);
    expect(exact).toBeGreaterThan(partial);
  });
  it('gõ "184" xếp đơn DH0184 TRÊN khách có SĐT chứa "184" (fix review #2)', () => {
    const dh0184 = { orderCode: "DH0184", customerName: "Ai Do", customerPhone: "0900000000" };
    const phoneHas184 = { orderCode: "DH0500", customerName: "Ai Khac", customerPhone: "0918412345" };
    expect(scoreSearchResult("184", dh0184)).toBeGreaterThan(scoreSearchResult("184", phoneHas184));
  });
});
