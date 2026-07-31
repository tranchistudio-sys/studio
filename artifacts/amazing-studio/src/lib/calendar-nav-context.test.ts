import { describe, expect, it } from "vitest";
import { pickReturnDate, type ShowOrigin } from "./calendar-nav-context";

/**
 * Ca lỗi chủ báo: hợp đồng DH0290 gộp 3 dịch vụ
 *   Dịch vụ 1 (id 501) — 20/09/2026  ← ngày mà lịch BỊ nhảy về
 *   Dịch vụ 2 (id 502) — 19/10/2026
 *   Dịch vụ 3 (id 503) — 18/10/2026  ← show người dùng mở để sửa
 */
const DRAFTS = [
  { siblingId: 501, shootDate: "2026-09-20" },
  { siblingId: 502, shootDate: "2026-10-19" },
  { siblingId: 503, shootDate: "2026-10-18" },
];

const origin = (bookingId: number, dateISO: string): ShowOrigin => ({ bookingId, dateISO, view: "day" });

describe("pickReturnDate — hợp đồng nhiều dịch vụ", () => {
  it("sửa show 18/10 → về 18/10 (không nhảy về 20/09)", () => {
    expect(pickReturnDate({ origin: origin(503, "2026-10-18"), drafts: DRAFTS })).toBe("2026-10-18");
  });

  it("sửa show 19/10 → về 19/10 (không nhảy về 20/09)", () => {
    expect(pickReturnDate({ origin: origin(502, "2026-10-19"), drafts: DRAFTS })).toBe("2026-10-19");
  });

  it("đổi ngày show 18/10 → 22/10 → về ngày MỚI 22/10", () => {
    const moved = DRAFTS.map(d => d.siblingId === 503 ? { ...d, shootDate: "2026-10-22" } : d);
    expect(pickReturnDate({ origin: origin(503, "2026-10-18"), drafts: moved })).toBe("2026-10-22");
  });

  it("Dịch vụ 1 đổi ngày cũng KHÔNG kéo lịch theo nó", () => {
    const moved = DRAFTS.map(d => d.siblingId === 501 ? { ...d, shootDate: "2026-08-01" } : d);
    expect(pickReturnDate({ origin: origin(503, "2026-10-18"), drafts: moved })).toBe("2026-10-18");
  });

  it("đảo thứ tự dịch vụ vẫn ra đúng (bám id, không bám vị trí)", () => {
    expect(pickReturnDate({ origin: origin(503, "2026-10-18"), drafts: [...DRAFTS].reverse() })).toBe("2026-10-18");
  });

  it("dịch vụ đang sửa bị gỡ khỏi hợp đồng → giữ ngày đã mở show, KHÔNG lấy drafts[0]", () => {
    const removed = DRAFTS.filter(d => d.siblingId !== 503);
    expect(pickReturnDate({ origin: origin(503, "2026-10-18"), drafts: removed })).toBe("2026-10-18");
  });
});

describe("pickReturnDate — đơn 1 dịch vụ & ca biên", () => {
  it("đơn lẻ giữ nguyên ngày → ngày của chính nó", () => {
    expect(pickReturnDate({ origin: origin(900, "2026-10-18"), drafts: [{ shootDate: "2026-10-18" }] }))
      .toBe("2026-10-18");
  });

  it("đơn lẻ đổi ngày → ngày mới", () => {
    expect(pickReturnDate({ origin: origin(900, "2026-10-18"), drafts: [{ shootDate: "2026-10-22" }] }))
      .toBe("2026-10-22");
  });

  it("TẠO MỚI (không ngữ cảnh) → fallback của form", () => {
    expect(pickReturnDate({ origin: null, drafts: DRAFTS, fallback: "2026-11-05" })).toBe("2026-11-05");
  });

  it("không ngữ cảnh, không fallback → null (phía gọi tự quyết)", () => {
    expect(pickReturnDate({ origin: null, drafts: [] })).toBeNull();
  });

  it("ngày rác không lọt ra ngoài", () => {
    expect(pickReturnDate({ origin: origin(503, "2026-10-18"), drafts: [{ siblingId: 503, shootDate: "" }] }))
      .toBe("2026-10-18");
    expect(pickReturnDate({ origin: { bookingId: 1, dateISO: "18/10/2026", view: "day" }, drafts: [] })).toBeNull();
  });
});
