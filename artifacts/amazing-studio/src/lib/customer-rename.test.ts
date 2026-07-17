/**
 * Test fix bug DH0267: sửa tên khách trong form booking không ăn.
 * Đúng ca production: gõ tên mới → form gỡ liên kết → lúc lưu tìm lại ĐÚNG khách cũ
 * theo SĐT → phải nhận ra ý định ĐỔI TÊN và patch name (trước đây bỏ qua).
 */
import { describe, it, expect } from "vitest";
import { refindCustomerPatch } from "./customer-rename";

const EXISTING = { id: 42, name: "Tran lợi lội", avatar: null as string | null };

describe("refindCustomerPatch — ý định đổi tên khi refind đúng khách gốc", () => {
  it("CA PRODUCTION DH0267: sửa booking, refind ra đúng khách gốc, tên gõ khác → patch.name", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: EXISTING,
      typedName: "Trần Lợi", avatar: null,
    });
    expect(p).toEqual({ name: "Trần Lợi" });
  });

  it("tên gõ giống tên hiện tại (kể cả thừa khoảng trắng) → không patch gì", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: EXISTING,
      typedName: "  Tran lợi lội  ", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("refind ra khách KHÁC (đổi SĐT sang khách khác) → KHÔNG đổi tên khách người ta", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: { id: 99, name: "Chị Hoa", avatar: null },
      typedName: "Trần Lợi", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("TẠO MỚI booking (isEdit=false) trùng SĐT khách cũ → không tự đổi tên khách cũ", () => {
    const p = refindCustomerPatch({
      isEdit: false, originalCustomerId: null, existing: EXISTING,
      typedName: "Người Khác Cùng SĐT", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("booking đang sửa vốn CHƯA gắn khách (originalCustomerId null) → không rename", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: null, existing: EXISTING,
      typedName: "Trần Lợi", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("tên gõ rỗng → không patch name", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: EXISTING,
      typedName: "   ", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("avatar: chỉ bổ sung khi khách chưa có (giữ hành vi cũ), gộp chung với rename", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: EXISTING,
      typedName: "Trần Lợi", avatar: "data:image/x",
    });
    expect(p).toEqual({ name: "Trần Lợi", avatar: "data:image/x" });
    // khách ĐÃ có avatar → không ghi đè
    const p2 = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: { ...EXISTING, avatar: "old.jpg" },
      typedName: "Trần Lợi", avatar: "data:image/x",
    });
    expect(p2).toEqual({ name: "Trần Lợi" });
  });
});
