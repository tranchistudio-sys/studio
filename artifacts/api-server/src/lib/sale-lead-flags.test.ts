import { describe, it, expect, vi } from "vitest";

// Mock DB để import module không cần DATABASE_URL (detectEscalation là hàm thuần).
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { detectEscalation } from "./sale-lead-flags";

describe("detectEscalation — chuyển người thật khi cần (backup, không phụ thuộc AI)", () => {
  it("phàn nàn / không hài lòng → escalate (luật mới)", () => {
    expect(detectEscalation("dịch vụ bên em tệ quá")).not.toBeNull();
    expect(detectEscalation("anh thất vọng về bên em")).not.toBeNull();
    expect(detectEscalation("anh muốn khiếu nại")).not.toBeNull();
    expect(detectEscalation("em làm vậy là không hài lòng nha")).not.toBeNull();
    expect(detectEscalation("bên em lừa đảo à")).not.toBeNull();
    expect(detectEscalation("dịch vụ tệ")).not.toBeNull();
    // không dấu vẫn bắt được
    expect(detectEscalation("dich vu qua te")).not.toBeNull();
  });

  it("bức xúc / tức giận → escalate (luật mới)", () => {
    expect(detectEscalation("anh bức xúc quá")).not.toBeNull();
    expect(detectEscalation("anh tức giận lắm rồi")).not.toBeNull();
    expect(detectEscalation("đừng làm anh nổi giận")).not.toBeNull();
    expect(detectEscalation("buc xuc that su")).not.toBeNull();
  });

  it("xin giảm giá / so sánh giá → escalate (giữ nguyên)", () => {
    expect(detectEscalation("giảm thêm chút được không")).not.toBeNull();
    expect(detectEscalation("bên kia rẻ hơn")).not.toBeNull();
  });

  it("hủy / dời lịch / hoàn cọc → escalate (giữ nguyên)", () => {
    expect(detectEscalation("anh muốn hủy lịch")).not.toBeNull();
    expect(detectEscalation("cho anh dời lịch nha")).not.toBeNull();
    expect(detectEscalation("hoàn cọc giúp anh")).not.toBeNull();
  });

  it("đặt cọc / chuyển khoản → escalate (giữ nguyên)", () => {
    expect(detectEscalation("anh muốn đặt cọc giữ lịch")).not.toBeNull();
    expect(detectEscalation("cho xin số tài khoản")).not.toBeNull();
  });

  it("câu tư vấn bình thường → KHÔNG escalate (tránh dương tính giả)", () => {
    expect(detectEscalation("chụp cổng bao nhiêu vậy em")).toBeNull();
    expect(detectEscalation("anh thích tone nhẹ nhàng")).toBeNull();
    expect(detectEscalation("cho anh xem mẫu cưới với")).toBeNull();
    // 'team'/'test' KHÔNG được kích hoạt luật phàn nàn (cụm 'te' lọt vào 'team')
    expect(detectEscalation("dịch vụ team chụp của mình ổn không")).toBeNull();
    expect(detectEscalation("ảnh này quá team luôn")).toBeNull();
  });
});
