import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn() } }));

import { pool } from "@workspace/db";
import {
  buildPriceSheetReply,
  isPriceSheetRequest,
  resolvePriceSheetRequest,
  resolveServiceKeyFromConversation,
  validatePriceSheetData,
} from "./sale-price-sheet";

const gateGroup = {
  id: 12,
  name: "CHỤP CỔNG TẠI STUDIO",
  ai_image_url: "/objects/uploads/gate-price-sheet" as string | null,
  public_for_customer: true,
  discount_enabled: false,
  discount_type: "percent",
  discount_value: null,
  discount_start_date: null,
  discount_end_date: null,
  discount_name: null,
  discount_description: null,
};

const gatePackages = [
  {
    id: 87, group_id: 12, group_name: gateGroup.name,
    pkg_name: "L CHỤP 1 CỔNG - GIÁ HỖ TRỢ ĐỐI TÁC", price: "1200000", code: "",
    description: "Dành riêng cho khách từ đối tác",
  },
  {
    id: 89, group_id: 12, group_name: gateGroup.name,
    pkg_name: "GÓI CHỤP CỔNG IN LỤA 1Tr9 Tiết Kiệm", price: "1900000", code: "",
    description: "Bao gồm 1 tấm cổng 60x90cm, 5 hình bàn, 1 sare, 1 vest và 1 lần makeup.",
  },
  {
    id: 47, group_id: 12, group_name: gateGroup.name,
    pkg_name: "Chụp cổng Basic", price: "2900000", code: "CG-BASIC", description: "",
  },
];

function mockCatalog(groups = [gateGroup], packages = gatePackages) {
  (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
    .mockImplementation(async (sql: string) => {
      if (sql.includes("FROM service_groups WHERE")) return { rows: groups };
      if (sql.includes("FROM service_groups g JOIN service_packages")) return { rows: packages };
      return { rows: [] };
    });
}

beforeEach(() => vi.clearAllMocks());

describe("price-sheet request classifier", () => {
  it("separates price-sheet requests from portfolio sample requests", () => {
    expect(isPriceSheetRequest("Chụp cổng bao nhiêu?")).toBe(true);
    expect(isPriceSheetRequest("Có hình bảng giá không?")).toBe(true);
    expect(isPriceSheetRequest("Có hình mẫu không ạ?" )).toBe(false);
    expect(isPriceSheetRequest("Chụp cùng gia đình")).toBe(false);
    expect(isPriceSheetRequest("Báo giá đi")).toBe(true);
    expect(isPriceSheetRequest("Cho mình xin giá")).toBe(true);
  });

  it("remembers the service from prior turns", () => {
    expect(resolveServiceKeyFromConversation("Có hình bảng giá không?", [
      { direction: "incoming", message: "Chụp cổng bao nhiêu?" },
      { direction: "outgoing", message: "Nhóm chụp cổng có nhiều gói." },
    ])).toEqual({ key: "wedding_gate", ambiguous: false });
  });
});

describe("price-sheet resolver", () => {
  it("selects the group price sheet, keeps 1.9m and excludes the 1.2m partner package", async () => {
    mockCatalog();
    const result = await resolvePriceSheetRequest({ message: "Chụp cổng bao nhiêu?" });

    expect(result.trace?.validator.passed).toBe(true);
    expect(result.assetUrl).toBe(gateGroup.ai_image_url);
    expect(result.trace?.includedPackages.map((pkg) => pkg.id)).toContain(89);
    expect(result.trace?.excludedPackages.map((pkg) => pkg.id)).toContain(87);
    expect(result.trace?.includedPackages.map((pkg) => pkg.price)).not.toContain(1200000);
    expect(result.trace?.actionOrder).toEqual(["send_price_sheet", "send_text"]);

    const reply = buildPriceSheetReply(result).join(" ");
    expect(reply).toContain("1.900.000đ");
    expect(reply).not.toContain("1.200.000đ");
  });

  it("blocks beauty pricing when the group has no official price-sheet image", async () => {
    mockCatalog([{
      ...gateGroup,
      id: 18,
      name: "BEAUTY / THỜI TRANG",
      ai_image_url: null,
    }], [{
      ...gatePackages[1],
      id: 68,
      group_id: 18,
      group_name: "BEAUTY / THỜI TRANG",
      pkg_name: "Chụp beauty chuyên viên",
      code: "BT-CHUYEN-VIEN",
      price: "1400000",
    }]);

    const result = await resolvePriceSheetRequest({ message: "Cho em bảng giá beauty" });
    expect(result.trace?.validator.passed).toBe(false);
    expect(result.trace?.validator.reasons).toContain("price_sheet_missing");
    expect(result.trace?.actionOrder).toEqual(["block", "escalate"]);
  });

  it("asks one clarification question before sending an unspecified price sheet", async () => {
    const result = await resolvePriceSheetRequest({ message: "Cho mình xem bảng giá" });
    expect(result.needsClarification).toBe(true);
    expect(result.assetUrl).toBeNull();
    expect(result.trace?.actionOrder).toEqual(["ask_clarification"]);
  });
  it("formats verified retail packages as readable paragraphs instead of raw descriptions", async () => {
    mockCatalog([gateGroup], [
      { ...gatePackages[1], description: "BAO GOM:: 1 tam cong 60x90cm, 5 hinh ban; 1 sare, 1 vest va makeup tai studio." },
      { id: 48, group_id: 12, group_name: gateGroup.name, pkg_name: "GOI PREMIUM GOI PREMIUM", code: "CG-PREMIUM", price: "3900000", description: "BAO GOM:: Photo Master; Makeup Master; San pham cao cap." },
    ]);
    const result = await resolvePriceSheetRequest({ message: "Cho minh bang gia chup cong" });
    const reply = buildPriceSheetReply(result).join("\n");

    expect(reply).toContain("\n\n");
    expect(reply).toContain("1.900.000");
    expect(reply).toContain("3.900.000");
    expect(reply).not.toMatch(/bao\s+gom\s*:/i);
    expect(reply).not.toContain("GOI PREMIUM GOI PREMIUM");
    expect(reply.split("?")).toHaveLength(2);
  });

  it("uses sentence case for benefits that were stored as all caps", async () => {
    mockCatalog([gateGroup], [
      {
        ...gatePackages[1],
        description: "GOI PREMIUM: DANH CHO CAP DOI MUON BO ANH CHIN CHU; 2 SARE + 2 AO VEST",
      },
    ]);
    const result = await resolvePriceSheetRequest({ message: "Cho minh bang gia chup cong" });
    const reply = buildPriceSheetReply(result).join("\n");

    expect(reply).toContain("Danh cho cap doi muon bo anh chin chu");
    expect(reply).toContain("2 sare + 2 ao vest");
    expect(reply).not.toContain("Danh Cho Cap Doi Muon Bo Anh Chin Chu");
  });
});

describe("price-sheet validator", () => {
  it("blocks portfolio assets and group mismatches", () => {
    const result = validatePriceSheetData({
      groupId: 12,
      assetGroupId: 18,
      assetUrl: "/objects/wrong",
      publicForCustomer: true,
      resourceType: "portfolio_sample",
      packageGroupIds: [12],
    });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("resource_type_mismatch");
    expect(result.reasons).toContain("price_sheet_group_mismatch");
  });
});
