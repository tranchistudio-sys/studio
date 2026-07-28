import { describe, it, expect } from "vitest";
import { detectDateSlot, botAsksDate } from "./sale-slots";

// Mốc "hôm nay" cố định để test suy năm ổn định: 28/07/2026.
const NOW = new Date(2026, 6, 28, 10, 0, 0);

describe("detectDateSlot — khách CHƯA CHỐT ngày", () => {
  it("cụm MẠNH tự nhắc ngày → not_decided kể cả khi bot chưa hỏi", () => {
    for (const msg of ["Chưa biết ngày.", "chua biet ngay nha em", "Không cần ngày đâu, cho mình xin giá trước"]) {
      const r = detectDateSlot(msg, { botAskedDate: false, now: NOW });
      expect(r?.status, msg).toBe("not_decided");
    }
  });

  it("cụm YẾU chỉ tính khi bot ĐÃ hỏi ngày (khách đang trả lời câu hỏi ngày)", () => {
    for (const msg of ["Mình chỉ tham khảo thôi", "Chưa chốt.", "Để mình xem lại.", "chưa quyết nữa"]) {
      expect(detectDateSlot(msg, { botAskedDate: true, now: NOW })?.status, msg).toBe("not_decided");
      expect(detectDateSlot(msg, { botAskedDate: false, now: NOW }), `${msg} (bot chưa hỏi)`).toBeNull();
    }
  });

  it("câu thường không dính ngày → null (không dương tính giả)", () => {
    for (const msg of ["Chụp cưới giá bao nhiêu?", "cho xem mẫu beauty", "gói này gồm gì vậy em"]) {
      expect(detectDateSlot(msg, { botAskedDate: true, now: NOW }), msg).toBeNull();
    }
  });
});

describe("detectDateSlot — khách CHO ngày", () => {
  it("dd/mm suy năm: mốc chưa qua → năm nay, đã qua → năm sau", () => {
    expect(detectDateSlot("20/12 nha em", { botAskedDate: false, now: NOW })).toMatchObject({
      status: "known",
      eventDate: "2026-12-20",
    });
    expect(detectDateSlot("bên mình 3/2 á", { botAskedDate: false, now: NOW })).toMatchObject({
      status: "known",
      eventDate: "2027-02-03",
    });
  });

  it("dd/mm/yyyy dùng đúng năm khách nói", () => {
    expect(detectDateSlot("mình định 15/11/2026", { botAskedDate: false, now: NOW })?.eventDate).toBe("2026-11-15");
  });

  it("'ngày 5 tháng 9' → ngày đầy đủ", () => {
    expect(detectDateSlot("ngày 5 tháng 9 đó em", { botAskedDate: false, now: NOW })?.eventDate).toBe("2026-09-05");
  });

  it("'cuối tháng 12' → known nhưng chỉ có mốc chữ", () => {
    const r = detectDateSlot("chắc cuối tháng 12", { botAskedDate: false, now: NOW });
    expect(r?.status).toBe("known");
    expect(r?.eventDate).toBeNull();
    expect(r?.dateText).toBe("cuối tháng 12");
  });

  it("'tháng 12' trần → known mốc tháng; '2 tháng nữa' KHÔNG phải mốc", () => {
    expect(detectDateSlot("chắc tháng 12 em ơi", { botAskedDate: false, now: NOW })?.dateText).toBe("tháng 12");
    expect(detectDateSlot("khoảng 2 tháng nữa mới chụp", { botAskedDate: false, now: NOW })).toBeNull();
  });

  it("ngày cụ thể THẮNG cụm chưa chốt trong cùng tin", () => {
    const r = detectDateSlot("chưa chốt hẳn nha, chắc khoảng 20/12", { botAskedDate: true, now: NOW });
    expect(r?.status).toBe("known");
    expect(r?.eventDate).toBe("2026-12-20");
  });
});

describe("detectDateSlot — chống nhầm số thường thành ngày", () => {
  it("giá tiền '1/2 triệu' không phải ngày", () => {
    expect(detectDateSlot("giảm 1/2 triệu được không", { botAskedDate: false, now: NOW })).toBeNull();
  });

  it("khoảng số '2-3 triệu' / '2-3 người' không phải ngày (dấu '-' cần ngữ cảnh ngày)", () => {
    expect(detectDateSlot("tầm 2-3 triệu thôi em", { botAskedDate: false, now: NOW })).toBeNull();
    expect(detectDateSlot("nhà mình đi 2-3 người", { botAskedDate: false, now: NOW })).toBeNull();
    // Có chữ "ngày" → 20-12 được hiểu là ngày.
    expect(detectDateSlot("ngày 20-12 nha", { botAskedDate: false, now: NOW })?.eventDate).toBe("2026-12-20");
  });

  it("số điện thoại / tin ảnh không bị parse", () => {
    expect(detectDateSlot("0909123456", { botAskedDate: true, now: NOW })).toBeNull();
    expect(detectDateSlot("[image:https://x/y.jpg]", { botAskedDate: true, now: NOW })).toBeNull();
  });
});

describe("botAsksDate — nhận diện bot hỏi ngày", () => {
  it("các kiểu hỏi ngày phổ biến → true", () => {
    for (const msg of [
      "Anh dự định chụp khi nào ạ?",
      "Mình chốt ngày chưa ạ?",
      "Anh định ngày nào chụp để em xem lịch nha",
      "Dạ mình dự định tổ chức khi nào ạ?",
    ]) {
      expect(botAsksDate(msg), msg).toBe(true);
    }
  });

  it("câu không hỏi ngày → false", () => {
    for (const msg of [
      "Dạ ngày đó bên em còn lịch nha",
      "Anh thích tone nhẹ nhàng hay sang trọng ạ?",
      "Em gửi bảng giá mình xem nha",
      "Khi nào cần em hỗ trợ cứ nhắn nha",
    ]) {
      expect(botAsksDate(msg), msg).toBe(false);
    }
  });
});
