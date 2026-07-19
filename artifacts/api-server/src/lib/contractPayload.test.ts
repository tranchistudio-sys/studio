import { describe, it, expect, vi } from "vitest";

// Chỉ test hàm THUẦN — mock db để import module không mở kết nối.
vi.mock("@workspace/db", () => ({ db: {}, pool: { query: vi.fn() } }));
vi.mock("@workspace/db/schema", () => ({
  contractsTable: {},
  customersTable: {},
  bookingsTable: {},
  bookingOccurrencesTable: {},
  paymentsTable: {},
  servicePackagesTable: {},
  staffTable: {},
}));
vi.mock("./schema-compat", () => ({ getSchemaFlags: vi.fn(async () => ({ occurrences: true })) }));

import {
  buildSignedSnapshot,
  projectToShape,
  signedSnapshotChanged,
  applySignedSnapshotForDisplay,
  type ContractPayload,
} from "./contractPayload.js";

function makeLivePayload(): ContractPayload {
  return {
    contract: {
      id: 1,
      contractCode: "HD0001",
      title: "Gói cưới A",
      content: "Điều khoản",
      status: "signed",
      createdAt: "2026-07-01T00:00:00.000Z",
      signedAt: "2026-07-02",
      expiresAt: null,
      totalValue: 5_000_000,
    },
    studio: { name: "Amazing Studio", desc: "", address: "", phone: "" },
    customer: { name: "Chị Hoa", phone: "0900000001" },
    services: [
      {
        bookingId: 10,
        orderCode: "DH0010",
        serviceLabel: "Chụp cưới",
        shootDate: "2026-08-01",
        shootTime: "08:00",
        location: "Tây Ninh",
        totalAmount: 5_000_000,
        surcharges: [],
        items: [
          {
            name: "Gói cưới A",
            description: "Mô tả gói đầy đủ",
            price: 5_000_000,
            deductions: [],
            surcharges: [],
            photoName: "Tú",
            makeupName: null,
          },
        ],
        occurrences: [],
      },
    ],
    schedule: [{ date: "2026-08-01", time: "08:00", label: "Chụp cưới" }],
    money: { totalAmount: 5_000_000, discountAmount: 0, paidAmount: 2_000_000, remainingAmount: 3_000_000 },
    payments: [],
    signatures: {
      customer: { imageUrl: "data:image/png;base64,x", name: "Chị Hoa", phone: "0900000001", signedAt: "2026-07-02" },
      studio: { imageUrl: null, signedAt: null, signedByName: null },
    },
    signState: "signed",
    resignRequested: false,
    internal: null,
  };
}

describe("projectToShape — so sánh legacy-safe theo key của snapshot ĐÃ LƯU", () => {
  it("bỏ key mới (customer/schedule/description) khi snapshot cũ không có", () => {
    const fresh = { a: 1, b: 2, nested: { x: 1, y: 2 } };
    const shape = { a: 0, nested: { x: 9 } };
    expect(projectToShape(fresh, shape)).toEqual({ a: 1, nested: { x: 1 } });
  });
  it("mảng: chiếu từng phần tử theo template, lệch số lượng vẫn giữ để diff bắt được", () => {
    const fresh = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    const shape = [{ a: 0 }];
    expect(projectToShape(fresh, shape)).toEqual([{ a: 1 }, { a: 3 }]);
  });
});

describe("signedSnapshotChanged", () => {
  it("snapshot v1 (thiếu field mới) + booking KHÔNG đổi → false (không báo láo)", () => {
    const live = makeLivePayload();
    const full = buildSignedSnapshot(live) as Record<string, unknown>;
    // Giả lập snapshot v1: không có customer/schedule, items không có description.
    const v1 = {
      title: full.title,
      content: full.content,
      totalValue: full.totalValue,
      totalAmount: full.totalAmount,
      discountAmount: full.discountAmount,
      services: (full.services as Record<string, unknown>[]).map((s) => ({
        bookingId: s.bookingId,
        shootDate: s.shootDate,
        shootTime: s.shootTime,
        serviceLabel: s.serviceLabel,
        totalAmount: s.totalAmount,
        surcharges: s.surcharges,
        items: (s.items as Record<string, unknown>[]).map((i) => ({
          name: i.name,
          price: i.price,
          deductions: i.deductions,
          surcharges: i.surcharges,
        })),
      })),
    };
    expect(signedSnapshotChanged(v1, live)).toBe(false);
  });
  it("đổi tổng tiền sau ký → true", () => {
    const live = makeLivePayload();
    const snap = buildSignedSnapshot(live);
    live.money.totalAmount = 6_000_000;
    live.services[0].totalAmount = 6_000_000;
    expect(signedSnapshotChanged(snap, live)).toBe(true);
  });
  it("đổi ngày chụp sau ký → true", () => {
    const live = makeLivePayload();
    const snap = buildSignedSnapshot(live);
    live.services[0].shootDate = "2026-08-15";
    expect(signedSnapshotChanged(snap, live)).toBe(true);
  });
  it("chỉ đóng thêm tiền (paidAmount) → false (không phải sửa hợp đồng)", () => {
    const live = makeLivePayload();
    const snap = buildSignedSnapshot(live);
    live.money.paidAmount = 4_000_000;
    live.money.remainingAmount = 1_000_000;
    expect(signedSnapshotChanged(snap, live)).toBe(false);
  });
});

describe("applySignedSnapshotForDisplay — đóng băng bản ĐÃ KÝ", () => {
  it("booking đổi giá + ngày sau ký → hiển thị theo BẢN KÝ, tiền đã trả vẫn live", () => {
    const live = makeLivePayload();
    const snap = buildSignedSnapshot(live) as Record<string, unknown>;
    // Booking bị sửa sau ký: giá 6tr, ngày dời 15/08, khách đổi tên.
    live.money.totalAmount = 6_000_000;
    live.services[0].totalAmount = 6_000_000;
    live.services[0].shootDate = "2026-08-15";
    live.customer = { name: "Khách Khác", phone: "0999999999" };
    live.money.paidAmount = 2_500_000; // đóng thêm 500k sau ký — hợp lệ

    const frozen = applySignedSnapshotForDisplay(live, snap);
    expect(frozen.money.totalAmount).toBe(5_000_000);
    expect(frozen.services[0].shootDate).toBe("2026-08-01");
    expect(frozen.customer.name).toBe("Chị Hoa");
    expect(frozen.money.paidAmount).toBe(2_500_000);
    expect(frozen.money.remainingAmount).toBe(2_500_000); // 5tr − 0 − 2,5tr
  });
  it("snapshot v1 thiếu description/location → mượn từ live để bản in không mất mô tả gói", () => {
    const live = makeLivePayload();
    const snapV1 = {
      title: "Gói cưới A",
      totalAmount: 5_000_000,
      discountAmount: 0,
      services: [
        {
          bookingId: 10,
          shootDate: "2026-08-01",
          shootTime: "08:00",
          serviceLabel: "Chụp cưới",
          totalAmount: 5_000_000,
          surcharges: [],
          items: [{ name: "Gói cưới A", price: 5_000_000, deductions: [], surcharges: [] }],
        },
      ],
    } as Record<string, unknown>;
    const frozen = applySignedSnapshotForDisplay(live, snapV1);
    expect(frozen.services[0].items[0].description).toBe("Mô tả gói đầy đủ");
    expect(frozen.services[0].location).toBe("Tây Ninh");
    // v1 không có customer → giữ live
    expect(frozen.customer.name).toBe("Chị Hoa");
  });
});

describe("Ngày thực hiện phụ trên hợp đồng (chip Ngày 1/Ngày 2… đầu trang)", () => {
  it("buildSignedSnapshot KHÔNG nhét occurrences vào services (lịch đã đóng băng qua field schedule)", () => {
    const live = makeLivePayload();
    live.services[0].occurrences = [{ date: "2026-08-02", time: "10:00", label: "Nhà trai" }];
    const snap = buildSignedSnapshot(live) as Record<string, unknown>;
    const snapSvc = (snap.services as Record<string, unknown>[])[0];
    expect("occurrences" in snapSvc).toBe(false);
  });
  it("thêm ngày phụ SAU khi ký không tự báo 'lệch bản ký' qua key mới (chỉ schedule mới là nguồn so)", () => {
    const live = makeLivePayload();
    const snap = buildSignedSnapshot(live) as Record<string, unknown>;
    // Sau ký: thêm ngày phụ → occurrences đổi nhưng snapshot không có key đó;
    // schedule TRONG SNAPSHOT so theo giá trị đã lưu — ở đây giữ nguyên schedule
    // để chứng minh riêng key occurrences không gây báo lệch.
    live.services[0].occurrences = [{ date: "2026-08-02", time: "10:00", label: null }];
    expect(signedSnapshotChanged(snap, live)).toBe(false);
  });
  it("bản ĐÃ KÝ render từ snapshot → occurrences = [] (chip chỉ ngày chính bản ký, không trộn ngày live)", () => {
    const live = makeLivePayload();
    const snap = buildSignedSnapshot(live) as Record<string, unknown>;
    live.services[0].occurrences = [{ date: "2026-08-02", time: "10:00", label: null }];
    live.services[0].shootDate = "2026-08-15"; // lệch để kích hoạt render theo bản ký
    const frozen = applySignedSnapshotForDisplay(live, snap);
    expect(frozen.services[0].occurrences).toEqual([]);
    expect(frozen.services[0].shootDate).toBe("2026-08-01");
  });
});
