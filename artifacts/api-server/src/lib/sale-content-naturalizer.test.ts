import { describe, it, expect } from "vitest";
import { extractPackageHighlights, naturalizePackageContent, checkDatabaseVoice } from "./sale-content-naturalizer";

// Mô tả THẬT của CG-BASIC trong DB preview (kèm cả lỗi nhập liệu "GÓI PREMIUM" đầu dòng).
const RAW_DESC = `GÓI PREMIUM : DÀNH CHO CẶP ĐÔI MUỐN BỘ ẢNH CHỈN CHU, SANG TRỌNG HƠN.

BAO GỒM:
• 2 SARE + 2 ÁO VEST
• 1 PHOTO CHUYÊN VIÊN
• MAKE UP CHUYÊN VIÊN

SẢN PHẨM:
• 2 HÌNH CỔNG 60X90CM MICA GƯƠNG CAO CẤP
• 10 HÌNH NHỎ 13X18CM (CHƯA KHUNG)
• TẶNG TOÀN BỘ FILE GỐC

Cọc 20% khi đặt lịch
Thanh toán 60% trong ngày chụp`;

describe("naturalizePackageContent — FACT giữ nguyên, giọng người thật", () => {
  it("bỏ header CRM (BAO GỒM/SẢN PHẨM), tagline, dòng cọc/thanh toán", () => {
    const items = extractPackageHighlights(RAW_DESC);
    const joined = items.join(" | ");
    expect(joined).not.toMatch(/BAO GỒM|SẢN PHẨM|DÀNH CHO|Cọc|Thanh toán|GÓI PREMIUM/i);
    expect(items.length).toBeGreaterThanOrEqual(4);
  });

  it("hạ chữ IN HOA về thường nhưng GIỮ NGUYÊN nội dung fact", () => {
    const s = naturalizePackageContent(RAW_DESC);
    expect(s).toContain("2 sare + 2 áo vest");
    expect(s).not.toMatch(/[A-ZĐ]{6,}/); // không còn cụm hoa dài
    // fact đầy đủ vẫn nằm trong highlights (dùng khi khách hỏi chi tiết)
    expect(extractPackageHighlights(RAW_DESC).join(" ")).toContain("file gốc");
  });

  it("nói VỪA ĐỦ — mặc định tối đa 4 ý, nối 'và' tự nhiên", () => {
    const s = naturalizePackageContent(RAW_DESC, 3);
    expect(s.split(",").length).toBeLessThanOrEqual(3);
    expect(s).toContain(" và ");
    expect(s.length).toBeLessThan(200);
  });

  it("mô tả rỗng → chuỗi rỗng (caller tự quyết)", () => {
    expect(naturalizePackageContent("")).toBe("");
    expect(naturalizePackageContent(null)).toBe("");
  });
});

describe("checkDatabaseVoice — detector giọng catalogue", () => {
  it("bắt header CRM + bullet dump", () => {
    expect(checkDatabaseVoice("Dạ gói gồm BAO GỒM:\n• A\n• B").ok).toBe(false);
    expect(checkDatabaseVoice("Gói này:\n• 2 sare\n• 1 photo\n• makeup").ok).toBe(false);
  });
  it("bắt chuỗi IN HOA dài kiểu CRM", () => {
    expect(checkDatabaseVoice("Dạ gói gồm 2 HÌNH CỔNG 60X90CM MICA GƯƠNG CAO CẤP ạ").ok).toBe(false);
  });
  it("cho qua câu sale tự nhiên có giá + token", () => {
    expect(checkDatabaseVoice("Dạ gói Premium bên em hiện là 3.900.000đ nha chị.\nGói đã có trang phục, makeup và phần chụp chính rồi ạ.").ok).toBe(true);
    expect(checkDatabaseVoice("Dạ gói {{PACKAGE_NAME}} hiện là {{PRICE}} ạ.").ok).toBe(true);
  });
  it("bắt câu trả lời dài bất thường", () => {
    expect(checkDatabaseVoice("Dạ " + "chi tiết lắm nè ".repeat(60)).ok).toBe(false);
  });
});
