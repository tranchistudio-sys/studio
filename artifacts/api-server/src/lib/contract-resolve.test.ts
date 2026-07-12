import { describe, it, expect } from "vitest";
import {
  contractCandidateBookingIds,
  newestContractIdByBooking,
  pickContractIdForBooking,
} from "./contract-resolve.js";

// ── contractCandidateBookingIds ───────────────────────────────────────────────
describe("contractCandidateBookingIds", () => {
  it("đơn thường (không cha) → chỉ chính nó", () => {
    expect(contractCandidateBookingIds(332, null)).toEqual([332]);
    expect(contractCandidateBookingIds(332, undefined)).toEqual([332]);
  });

  it("đơn con → [con, cha] theo đúng thứ tự ưu tiên", () => {
    expect(contractCandidateBookingIds(500, 100)).toEqual([500, 100]);
  });

  it("chống trường hợp parentId trỏ về chính nó → không nhân đôi", () => {
    expect(contractCandidateBookingIds(77, 77)).toEqual([77]);
  });
});

// ── newestContractIdByBooking ─────────────────────────────────────────────────
describe("newestContractIdByBooking", () => {
  it("rows rỗng → map rỗng", () => {
    expect(newestContractIdByBooking([]).size).toBe(0);
  });

  it("giữ hợp đồng MỚI NHẤT cho mỗi bookingId (rows theo thứ tự mới→cũ)", () => {
    const map = newestContractIdByBooking([
      { id: 90, bookingId: 5 }, // mới nhất của booking 5
      { id: 42, bookingId: 5 }, // cũ hơn → bị bỏ qua
      { id: 91, bookingId: 6 },
    ]);
    expect(map.get(5)).toBe(90);
    expect(map.get(6)).toBe(91);
  });

  it("bỏ qua hợp đồng có bookingId null (không gắn đơn nào)", () => {
    const map = newestContractIdByBooking([
      { id: 10, bookingId: null },
      { id: 11, bookingId: 3 },
    ]);
    expect(map.has(3)).toBe(true);
    expect([...map.values()]).not.toContain(10);
  });
});

// ── pickContractIdForBooking ──────────────────────────────────────────────────
describe("pickContractIdForBooking", () => {
  it("Case 1 — khách mới, đơn đầu tiên: chưa có hợp đồng → null (caller phải tạo mới)", () => {
    expect(pickContractIdForBooking([332], new Map())).toBeNull();
  });

  it("Case 2 — khách cũ có 5 hợp đồng, đơn thứ 6 CHƯA có hợp đồng → null, KHÔNG mở hợp đồng cũ", () => {
    // Query find-or-create chỉ nạp hợp đồng theo bookingId của đơn thứ 6 (= 606),
    // nên map hoàn toàn không chứa 606 dù khách có hợp đồng ở các đơn 601..605.
    const candidates = contractCandidateBookingIds(606, null);
    const mapChiCuaDon6 = newestContractIdByBooking([]); // đơn 606 chưa có hợp đồng
    expect(pickContractIdForBooking(candidates, mapChiCuaDon6)).toBeNull();

    // Bảo hiểm bất biến: kể cả nếu map có sẵn hợp đồng của các đơn KHÁC (601..605) cùng khách,
    // đơn 606 vẫn KHÔNG được lấy nhầm — vì 606 không có trong map.
    const mapKhachCu = new Map<number, number>([
      [601, 41], [602, 42], [603, 43], [604, 44], [605, 45],
    ]);
    expect(pickContractIdForBooking([606], mapKhachCu)).toBeNull();
  });

  it("Case 3 — mở lại đơn cũ → đúng hợp đồng cũ của chính đơn đó", () => {
    const map = new Map<number, number>([[303, 43]]);
    expect(pickContractIdForBooking([303], map)).toBe(43);
  });

  it("Regression — khách cũ, mỗi đơn mở ĐÚNG hợp đồng của mình (A→A, B→B, C→C)", () => {
    const map = new Map<number, number>([[1, 101], [2, 102], [3, 103]]);
    expect(pickContractIdForBooking([1], map)).toBe(101);
    expect(pickContractIdForBooking([2], map)).toBe(102);
    expect(pickContractIdForBooking([3], map)).toBe(103);
  });

  it("Case 4a — đơn con có hợp đồng riêng → ưu tiên hợp đồng của chính đơn con", () => {
    const candidates = contractCandidateBookingIds(500, 100); // [500, 100]
    const map = new Map<number, number>([[500, 205], [100, 200]]);
    expect(pickContractIdForBooking(candidates, map)).toBe(205);
  });

  it("Case 4b — đơn con chưa có hợp đồng riêng, đơn cha có → mở hợp đồng của cha", () => {
    const candidates = contractCandidateBookingIds(500, 100); // [500, 100]
    const map = new Map<number, number>([[100, 200]]);
    expect(pickContractIdForBooking(candidates, map)).toBe(200);
  });

  it("Case 4c — cả cha lẫn con đều chưa có hợp đồng → null (caller tạo mới cho đơn con)", () => {
    const candidates = contractCandidateBookingIds(500, 100);
    expect(pickContractIdForBooking(candidates, new Map())).toBeNull();
  });
});
