/**
 * Test fix bug DH0267: sửa tên khách trong form booking không ăn.
 * Đúng ca production: gõ tên mới → form gỡ liên kết → lúc lưu tìm lại ĐÚNG khách cũ
 * theo SĐT → phải nhận ra ý định ĐỔI TÊN và patch name (trước đây bỏ qua).
 * Phân biệt ý định qua matchedName: gõ-sửa-tên giữ tên gốc; nút "Xoá liên kết"
 * chủ động xóa rỗng → là ý định THAY KHÁCH, tuyệt đối không rename khách gốc.
 */
import { describe, it, expect } from "vitest";
import { refindCustomerPatch, noPhoneSavePlan } from "./customer-rename";

const EXISTING = { id: 42, name: "Tran lợi lội", avatar: null as string | null };
const MATCHED = "Tran lợi lội"; // tên gốc còn trong matchedNameRef (gõ-sửa-tên)

describe("refindCustomerPatch — ý định đổi tên khi refind đúng khách gốc", () => {
  it("CA PRODUCTION DH0267: sửa booking, refind ra đúng khách gốc, tên gõ khác → patch.name", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: EXISTING,
      matchedName: MATCHED, typedName: "Trần Lợi", avatar: null,
    });
    expect(p).toEqual({ name: "Trần Lợi" });
  });

  it("tên gõ giống tên hiện tại (kể cả thừa khoảng trắng) → không patch gì", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: EXISTING,
      matchedName: MATCHED, typedName: "  Tran lợi lội  ", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("bấm 'Xoá liên kết' chủ động (matchedName rỗng) rồi gõ tên mới → KHÔNG rename khách gốc", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: EXISTING,
      matchedName: "", typedName: "Người Hoàn Toàn Khác", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("refind ra khách KHÁC (đổi SĐT sang khách khác) → KHÔNG đổi tên khách người ta", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: { id: 99, name: "Chị Hoa", avatar: null },
      matchedName: MATCHED, typedName: "Trần Lợi", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("TẠO MỚI booking (isEdit=false) trùng SĐT khách cũ → không tự đổi tên khách cũ", () => {
    const p = refindCustomerPatch({
      isEdit: false, originalCustomerId: null, existing: EXISTING,
      matchedName: "", typedName: "Người Khác Cùng SĐT", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("booking đang sửa vốn CHƯA gắn khách (originalCustomerId null) → không rename", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: null, existing: EXISTING,
      matchedName: MATCHED, typedName: "Trần Lợi", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("tên gõ rỗng → không patch name", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: EXISTING,
      matchedName: MATCHED, typedName: "   ", avatar: null,
    });
    expect(p).toEqual({});
  });

  it("avatar: chỉ bổ sung khi khách chưa có (giữ hành vi cũ), gộp chung với rename", () => {
    const p = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: EXISTING,
      matchedName: MATCHED, typedName: "Trần Lợi", avatar: "data:image/x",
    });
    expect(p).toEqual({ name: "Trần Lợi", avatar: "data:image/x" });
    // khách ĐÃ có avatar → không ghi đè
    const p2 = refindCustomerPatch({
      isEdit: true, originalCustomerId: 42, existing: { ...EXISTING, avatar: "old.jpg" },
      matchedName: MATCHED, typedName: "Trần Lợi", avatar: "data:image/x",
    });
    expect(p2).toEqual({ name: "Trần Lợi" });
  });

  it("avatar backfill vẫn chạy khi KHÔNG có ý định rename (tạo mới trùng SĐT, khách thiếu avatar)", () => {
    const p = refindCustomerPatch({
      isEdit: false, originalCustomerId: null, existing: EXISTING,
      matchedName: "", typedName: "Người Khác Cùng SĐT", avatar: "data:image/x",
    });
    expect(p).toEqual({ avatar: "data:image/x" });
  });
});

describe("noPhoneSavePlan — lưu khi form KHÔNG có SĐT hợp lệ", () => {
  const BASE_IN = {
    isEdit: true, originalCustomerId: 42 as number | null,
    matchedName: MATCHED, typedName: "Trần Lợi",
    avatar: null as string | null, facebook: null as string | null, zalo: null as string | null,
  };

  it("sửa booking có khách gốc + gõ tên mới → rename tại chỗ, KHÔNG tạo khách trùng", () => {
    const plan = noPhoneSavePlan(BASE_IN);
    expect(plan).toEqual({ mode: "rename-in-place", customerId: 42, patch: { name: "Trần Lợi" } });
  });

  it("kèm facebook/zalo/avatar vừa nhập → vào chung patch (không bị rơi lặng lẽ)", () => {
    const plan = noPhoneSavePlan({ ...BASE_IN, avatar: "a.jpg", facebook: "fb.com/x", zalo: "0909" });
    expect(plan).toEqual({
      mode: "rename-in-place", customerId: 42,
      patch: { name: "Trần Lợi", avatar: "a.jpg", facebook: "fb.com/x", zalo: "0909" },
    });
  });

  it("tên không đổi + không có gì mới → giữ liên kết, patch null (không gọi PUT)", () => {
    const plan = noPhoneSavePlan({ ...BASE_IN, typedName: MATCHED });
    expect(plan).toEqual({ mode: "rename-in-place", customerId: 42, patch: null });
  });

  it("tên không đổi nhưng có zalo mới → patch chỉ zalo", () => {
    const plan = noPhoneSavePlan({ ...BASE_IN, typedName: MATCHED, zalo: "0909" });
    expect(plan).toEqual({ mode: "rename-in-place", customerId: 42, patch: { zalo: "0909" } });
  });

  it("bấm 'Xoá liên kết' (matchedName rỗng) → tạo khách MỚI như hành vi cũ, không rename khách gốc", () => {
    const plan = noPhoneSavePlan({ ...BASE_IN, matchedName: "" });
    expect(plan).toEqual({ mode: "create-new" });
  });

  it("tạo mới booking / booking chưa gắn khách / tên rỗng → tạo khách mới", () => {
    expect(noPhoneSavePlan({ ...BASE_IN, isEdit: false }).mode).toBe("create-new");
    expect(noPhoneSavePlan({ ...BASE_IN, originalCustomerId: null }).mode).toBe("create-new");
    expect(noPhoneSavePlan({ ...BASE_IN, typedName: "  " }).mode).toBe("create-new");
  });
});
