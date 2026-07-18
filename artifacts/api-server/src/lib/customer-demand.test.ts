import { describe, it, expect, vi } from "vitest";
// customer-demand.ts import pool ở top-level (cho computeCustomerDemand) — mock theo
// convention repo để test classifier THUẦN không cần DATABASE_URL.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import { classifyServiceGroupDemand } from "./customer-demand";

describe("classifyServiceGroupDemand — nhóm dịch vụ THẬT trong DB", () => {
  const cases: Array<[string, ("wedding" | "beauty")[]]> = [
    // ── Cưới ──
    ["ALBUM NGOẠI CẢNH", ["wedding"]],
    ["ALBUM TẠI STUDIO", ["wedding"]],
    ["CHỤP CỔNG TẠI STUDIO", ["wedding"]],
    ["CHỤP TIỆC CƯỚI", ["wedding"]],
    ["COMBO Trang Phục cưới - CÓ MAKEUP", ["wedding"]],
    ["COMBO Trang Phục cưới - Không MAKEUP", ["wedding"]],
    ["QUAY PHIM", ["wedding"]],
    // ── Beauty ──
    ["BEAUTY / THỜI TRANG", ["beauty"]],
    ["CHỤP GIA ĐÌNH", ["beauty"]],
    // ── Trung tính: KHÔNG đoán bừa (an toàn hơn gắn sai) ──
    ["Cho thuê Trang Phục lẻ", []],
    ["COMBO CÓ MAKEUP", []],
    ["COMBO KHÔNG MAKEUP", []],
    ["IN ẢNH", []],
    ["MAKEUP LẺ", []],
  ];

  it.each(cases)("%s → %j", (name, expected) => {
    expect(classifyServiceGroupDemand(name).sort()).toEqual([...expected].sort());
  });
});

describe("classifyServiceGroupDemand — biên", () => {
  it("null/rỗng → không nhu cầu", () => {
    expect(classifyServiceGroupDemand(null)).toEqual([]);
    expect(classifyServiceGroupDemand(undefined)).toEqual([]);
    expect(classifyServiceGroupDemand("   ")).toEqual([]);
  });

  it("'bau' KHÔNG dính nhầm 'album' (word-boundary)", () => {
    expect(classifyServiceGroupDemand("ALBUM TẠI STUDIO")).toEqual(["wedding"]);
    expect(classifyServiceGroupDemand("Chụp bầu")).toEqual(["beauty"]);
  });

  it("nhóm có cả hai từ khóa → cả 2 badge, thứ tự ổn định [wedding, beauty]", () => {
    expect(classifyServiceGroupDemand("Combo cưới + beauty")).toEqual(["wedding", "beauty"]);
    expect(classifyServiceGroupDemand("Beauty kèm quay phim cưới")).toEqual(["wedding", "beauty"]);
  });

  it("không phân biệt hoa thường / có dấu", () => {
    expect(classifyServiceGroupDemand("chụp tiệc cưới")).toEqual(["wedding"]);
    expect(classifyServiceGroupDemand("Nàng Thơ")).toEqual(["beauty"]);
    expect(classifyServiceGroupDemand("Profile cá nhân")).toEqual(["beauty"]);
  });
});
