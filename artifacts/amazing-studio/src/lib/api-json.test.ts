import { describe, it, expect } from "vitest";
import { readApiJson } from "./api-json";

const ok = (status = 200) => ({ ok: true, status });
const bad = (status: number) => ({ ok: false, status });

describe("readApiJson", () => {
  it("REGRESSION: 204 body rỗng = THÀNH CÔNG, không được coi là lỗi", () => {
    // Xoá phiếu thu trả 204 rỗng. Kiểu cũ JSON.parse("") văng lỗi → xoá xong mà
    // UI báo 'Lỗi server (204)' và danh sách không làm mới.
    expect(readApiJson(ok(204), "")).toBeNull();
    expect(readApiJson(ok(200), "   ")).toBeNull();
  });

  it("body JSON hợp lệ → trả nguyên dữ liệu", () => {
    expect(readApiJson(ok(), '{"ok":true,"ids":[1,2]}')).toEqual({ ok: true, ids: [1, 2] });
  });

  it("lỗi có body JSON → ưu tiên câu lỗi server gửi", () => {
    expect(() => readApiJson(bad(400), '{"error":"Thiếu số tiền"}')).toThrow("Thiếu số tiền");
  });

  it("401 → câu nhắc đăng nhập lại (không im lặng)", () => {
    expect(() => readApiJson(bad(401), "")).toThrow(/hết hạn/);
    expect(() => readApiJson(bad(401), "khong-phai-json")).toThrow(/hết hạn/);
  });

  it("403 → câu báo thiếu quyền", () => {
    expect(() => readApiJson(bad(403), "")).toThrow(/không có quyền/);
  });

  it("404 body không phải JSON → nhắc restart server (giữ nguyên hành vi cũ)", () => {
    expect(() => readApiJson(bad(404), "<html>Cannot GET</html>")).toThrow(/API chưa sẵn sàng/);
  });

  it("500 trả HTML → báo theo mã, không ném rác HTML ra UI", () => {
    expect(() => readApiJson(bad(500), "<html>Internal Error</html>")).toThrow("Lỗi server (500)");
  });

  it("thành công nhưng body không phải JSON → vẫn báo lỗi (không nuốt im)", () => {
    expect(() => readApiJson(ok(200), "not-json")).toThrow(/Lỗi server \(200\)/);
  });
});
