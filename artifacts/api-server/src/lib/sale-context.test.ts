import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn() } }));

import { packageExclusionReason, safePackageDescription } from "./sale-context";

describe("safePackageDescription", () => {
  it("hides benefits when a Basic package contains a Premium description", () => {
    expect(safePackageDescription(
      "Chụp cổng Basic",
      "GÓI PREMIUM: dành cho cặp đôi muốn bộ ảnh chỉn chu. Bao gồm 2 sare.",
    )).toBe("");
  });

  it("keeps benefits when the tier matches", () => {
    expect(safePackageDescription(
      "Chụp cổng Premium",
      "GÓI PREMIUM: bao gồm 2 sare và 2 áo vest.",
    )).toContain("2 sare");
  });

  it("keeps descriptions that do not declare a tier", () => {
    expect(safePackageDescription("Chụp gia đình", "Bao gồm 10 ảnh chỉnh."))
      .toBe("Bao gồm 10 ảnh chỉnh.");
  });
});

describe("packageExclusionReason", () => {
  const base = {
    id: 1, group_id: 12, group_name: "CHỤP CỔNG TẠI STUDIO",
    pkg_name: "", price: "0", code: "", description: "",
  };

  it("keeps the valid retail 1.9m gate package even without a code", () => {
    expect(packageExclusionReason({
      ...base,
      id: 89,
      pkg_name: "GÓI CHỤP CỔNG IN LỤA 1Tr9 Tiết Kiệm",
      price: "1900000",
    })).toBeNull();
  });

  it("excludes the 1.2m partner package using business evidence", () => {
    expect(packageExclusionReason({
      ...base,
      id: 87,
      pkg_name: "L CHỤP 1 CỔNG - GIÁ HỖ TRỢ ĐỐI TÁC",
      price: "1200000",
      description: "Dành riêng cho khách từ đối tác",
    })).toContain("denylist");
  });
});
