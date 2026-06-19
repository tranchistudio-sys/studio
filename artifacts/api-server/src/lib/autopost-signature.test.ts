import { describe, it, expect, vi } from "vitest";

// Chỉ test hàm THUẦN (append/strip) — không cần DB → mock @workspace/db để khỏi đòi DATABASE_URL.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn() } }));

import { appendSignature, stripSignature, DEFAULT_SIGNATURE_CONTENT } from "./autopost-signature";

const SIG = DEFAULT_SIGNATURE_CONTENT;
const NAME = "𝐀𝐌𝐀𝐙𝐈𝐍𝐆 𝐒𝐓𝐔𝐃𝐈𝐎";
const occurrences = (s: string, sub: string) => s.split(sub).length - 1;

describe("appendSignature / stripSignature — chữ ký cuối bài", () => {
  it("gắn chữ ký 1 lần vào caption thường (body + chữ ký)", () => {
    const out = appendSignature("Bộ ảnh cưới đẹp lung linh", SIG);
    expect(out.startsWith("Bộ ảnh cưới đẹp lung linh")).toBe(true);
    expect(out.includes(NAME)).toBe(true);
    expect(occurrences(out, NAME)).toBe(1);
    // số điện thoại MỚI phải có trong chữ ký
    expect(out.includes("⓿➌➒➋.➑➊➐.⓿➐➒")).toBe(true);
  });

  it('"Tạo lại" nhiều lần KHÔNG nhân đôi chữ ký', () => {
    const once = appendSignature("Caption A", SIG);
    const twice = appendSignature(once, SIG);
    const thrice = appendSignature(twice, SIG);
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
    expect(occurrences(thrice, NAME)).toBe(1);
  });

  it("thay chữ ký CŨ bằng chữ ký MỚI nhất ở cuối bài", () => {
    const oldSig = "━━━\nCHỮ KÝ CŨ - 0392827079\n━━━";
    const withOld = appendSignature("Nội dung bài", oldSig);
    const withNew = appendSignature(withOld, SIG);
    expect(withNew.includes("CHỮ KÝ CŨ")).toBe(false);
    expect(withNew.includes("0392827079")).toBe(false); // số cũ biến mất
    expect(withNew.includes(NAME)).toBe(true);
    expect(withNew.startsWith("Nội dung bài")).toBe(true);
  });

  it("chữ ký rỗng → giữ nguyên body (đại diện trường hợp toggle tắt)", () => {
    expect(appendSignature("Chỉ nội dung AI viết", "")).toBe("Chỉ nội dung AI viết");
  });

  it("stripSignature gỡ đúng phần chữ ký, giữ body", () => {
    const withSig = appendSignature("Thân bài viết", SIG);
    expect(stripSignature(withSig)).toBe("Thân bài viết");
  });

  it("KHÔNG cắt nhầm caption không có dải ━", () => {
    const body = "Dòng 1\nDòng 2 - caption bình thường có dấu - gạch ngang";
    expect(stripSignature(body)).toBe(body);
  });
});
