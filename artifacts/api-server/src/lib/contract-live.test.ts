import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, pool: { query: vi.fn() } }));
vi.mock("@workspace/db/schema", () => ({ bookingsTable: {}, customersTable: {} }));

import { overlayContractRow, type ContractListRow, type LiveBookingInfo } from "./contract-live.js";

const row = (over: Partial<ContractListRow> = {}): ContractListRow => ({
  id: 1,
  bookingId: 10,
  status: "active",
  totalValue: "4500000",
  customerName: "Khách Cũ",
  customerPhone: "0900000000",
  ...over,
});

const booking = (over: Partial<LiveBookingInfo> = {}): LiveBookingInfo => ({
  id: 10,
  parentId: null,
  isParentContract: false,
  customerId: 7,
  totalAmount: "3000000",
  ...over,
});

describe("overlayContractRow — hợp đồng CHƯA KÝ đọc live từ booking", () => {
  it("chưa ký + có booking → totalValue/khách theo live (case thật HD0050: HĐ 4,5tr vs booking 3tr)", () => {
    const out = overlayContractRow(row(), booking(), 3_000_000, { name: "Khách Mới", phone: "0911111111" });
    expect(out.totalValue).toBe("3000000");
    expect(out.customerName).toBe("Khách Mới");
    expect(out.customerPhone).toBe("0911111111");
  });
  it("ĐÃ KÝ → giữ nguyên số bản ký, không overlay", () => {
    const out = overlayContractRow(row({ status: "signed" }), booking(), 3_000_000, { name: "Khách Mới", phone: null });
    expect(out.totalValue).toBe("4500000");
    expect(out.customerName).toBe("Khách Cũ");
  });
  it("hợp đồng rời (không gắn booking) → giữ nguyên", () => {
    const out = overlayContractRow(row({ bookingId: null }), undefined, null, undefined);
    expect(out.totalValue).toBe("4500000");
  });
  it("booking không load được → giữ nguyên (an toàn)", () => {
    const out = overlayContractRow(row(), undefined, null, undefined);
    expect(out.totalValue).toBe("4500000");
    expect(out.customerName).toBe("Khách Cũ");
  });
});
