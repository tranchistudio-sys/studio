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
  splitSnapshotSchedule,
  mergeSignedAndAddedDays,
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

describe("Ngày thực hiện phụ trên hợp đồng (ngày hiện ngay tại dòng dịch vụ)", () => {
  it("buildSignedSnapshot đóng băng occurrences theo TỪNG dịch vụ (v3)", () => {
    const live = makeLivePayload();
    live.services[0].occurrences = [{ date: "2026-08-02", time: "10:00", label: "Nhà trai" }];
    const snap = buildSignedSnapshot(live) as Record<string, unknown>;
    const snapSvc = (snap.services as Record<string, unknown>[])[0];
    expect(snapSvc.occurrences).toEqual([{ date: "2026-08-02", time: "10:00", label: "Nhà trai" }]);
  });

  it("bản ký CŨ (v2, không có key occurrences) không bị báo 'lệch bản ký' oan vì key mới", () => {
    const live = makeLivePayload();
    const snapV2 = buildSignedSnapshot(live) as Record<string, unknown>;
    // Giả lập snapshot đã lưu trước đây: gỡ key occurrences khỏi services.
    for (const s of snapV2.services as Record<string, unknown>[]) delete s.occurrences;
    live.services[0].occurrences = [{ date: "2026-08-02", time: "10:00", label: null }];
    // projectToShape chỉ so key CÓ trong snapshot đã lưu → occurrences không tính.
    expect(signedSnapshotChanged(snapV2, live)).toBe(false);
  });

  it("bản ĐÃ KÝ v3: ngày của BẢN KÝ giữ nguyên (không bị ngày live ghi đè/làm mất)", () => {
    const live = makeLivePayload();
    live.services[0].occurrences = [{ date: "2026-08-02", time: "10:00", label: "Nhà trai" }];
    live.schedule = [
      { date: "2026-08-01", time: "08:00", label: "Chụp cưới" },
      { date: "2026-08-02", time: "10:00", label: "Nhà trai" },
    ];
    const snap = buildSignedSnapshot(live) as Record<string, unknown>;
    // Sau ký: sửa lung tung ở bản live.
    live.services[0].occurrences = [{ date: "2026-12-31", time: "23:00", label: "ngày live" }];
    live.services[0].shootDate = "2026-08-15";
    const frozen = applySignedSnapshotForDisplay(live, snap);
    // Ngày CHÍNH + ngày phụ của bản ký: y nguyên, không nhãn bổ sung.
    expect(frozen.services[0].shootDate).toBe("2026-08-01");
    expect(frozen.services[0].occurrences[0]).toEqual({ date: "2026-08-02", time: "10:00", label: "Nhà trai" });
    // Ngày mới thêm sau khi ký: VẪN hiện (chủ 20/07) nhưng phải có nhãn.
    expect(frozen.services[0].occurrences[1]).toEqual({
      date: "2026-12-31", time: "23:00", label: "ngày live", addedAfterSign: true,
    });
  });

  it("REGRESSION: bản ký CŨ (v2) vẫn hiện đủ ngày — back-fill từ schedule đã đóng băng", () => {
    const live = makeLivePayload();
    const snapV2 = buildSignedSnapshot(live) as Record<string, unknown>;
    // Bản ký cũ: services KHÔNG có occurrences, ngày phụ chỉ nằm trong schedule.
    for (const s of snapV2.services as Record<string, unknown>[]) delete s.occurrences;
    snapV2.schedule = [
      { date: "2026-08-01", time: "08:00", label: "Chụp cưới" },
      { date: "2026-08-02", time: "10:00", label: "Nhà trai" },
    ];
    live.services[0].shootDate = "2026-08-15"; // lệch → render theo bản ký
    const frozen = applySignedSnapshotForDisplay(live, snapV2);
    // Trước đây chỗ này trả [] và ngày 2 chỉ hiện ở mục "Lịch thực hiện" (đã bỏ)
    // → khách mở hợp đồng đã ký sẽ KHÔNG thấy ngày 2 nữa. Phải back-fill.
    expect(frozen.services[0].occurrences).toEqual([{ date: "2026-08-02", time: "10:00", label: "Nhà trai" }]);
  });
});

describe("Ngày thêm SAU khi ký (sự cố BG0017 20/07)", () => {
  it("mergeSignedAndAddedDays: ngày live không có trong bản ký → thêm vào, gắn cờ", () => {
    const merged = mergeSignedAndAddedDays(
      [{ date: "2026-10-16", time: "08:00", label: null }],
      [
        { date: "2026-10-16", time: "08:00", label: null },
        { date: "2026-10-18", time: "08:00", label: "Ngày rước dâu" },
      ],
    );
    expect(merged).toEqual([
      { date: "2026-10-16", time: "08:00", label: null },
      { date: "2026-10-18", time: "08:00", label: "Ngày rước dâu", addedAfterSign: true },
    ]);
  });

  it("P1: chỉ DỜI GIỜ ngày đã ký → KHÔNG được đẻ ra ngày mới (nhận diện theo id hàng)", () => {
    const merged = mergeSignedAndAddedDays(
      [{ id: 7, date: "2026-10-18", time: "08:00", label: "Rước dâu" }],
      [{ id: 7, date: "2026-10-18", time: "14:00", label: "Rước dâu" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].time).toBe("08:00"); // hợp đồng giữ đúng giờ khách đã ký
  });

  it("P1: sửa NGÀY gõ nhầm của ngày đã ký (cùng id) cũng không đẻ ngày mới", () => {
    const merged = mergeSignedAndAddedDays(
      [{ id: 7, date: "2026-10-18", time: "08:00", label: null }],
      [{ id: 7, date: "2026-10-19", time: "08:00", label: null }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].date).toBe("2026-10-18");
  });

  it("P1: bản ký CŨ chưa lưu id → lùi về so theo NGÀY, đổi giờ vẫn không đẻ ngày ma", () => {
    const merged = mergeSignedAndAddedDays(
      [{ date: "2026-10-18", time: "08:00", label: null }],
      [{ id: 7, date: "2026-10-18", time: "14:00", label: null }],
    );
    expect(merged).toHaveLength(1);
  });

  it("id MỚI (studio thêm hẳn ngày khác) thì vẫn phải hiện + gắn cờ", () => {
    const merged = mergeSignedAndAddedDays(
      [{ id: 7, date: "2026-10-18", time: "08:00", label: "Rước dâu" }],
      [
        { id: 7, date: "2026-10-18", time: "08:00", label: "Rước dâu" },
        { id: 9, date: "2026-10-20", time: "07:00", label: "Tiệc" },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ date: "2026-10-20", addedAfterSign: true });
  });

  it("mergeSignedAndAddedDays: ngày CÓ trong bản ký thì không nhân đôi, không gắn cờ", () => {
    const merged = mergeSignedAndAddedDays(
      [{ date: "2026-10-18", time: "08:00", label: "Rước dâu" }],
      [{ date: "2026-10-18", time: "08:00", label: "Rước dâu" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].addedAfterSign).toBeUndefined();
  });

  it("mergeSignedAndAddedDays: ngày trong bản ký bị xoá ở live vẫn GIỮ (là cam kết đã ký)", () => {
    const merged = mergeSignedAndAddedDays([{ date: "2026-10-18", time: "08:00", label: null }], []);
    expect(merged).toEqual([{ date: "2026-10-18", time: "08:00", label: null }]);
  });

  it("BG0017: ký xong mới thêm ngày rước dâu → hợp đồng đã ký PHẢI hiện đủ 2 ngày", () => {
    const live = makeLivePayload();
    // Bản ký chụp lúc dịch vụ mới có 1 ngày.
    const snap = buildSignedSnapshot(live) as Record<string, unknown>;
    // Sau khi ký, studio thêm ngày phụ vào chính dịch vụ đó.
    live.services[0].occurrences = [{ date: "2026-08-04", time: "08:00", label: "Ngày rước dâu" }];
    live.services[0].location = "đổi chỗ khác"; // lệch → render theo bản ký

    const frozen = applySignedSnapshotForDisplay(live, snap);
    expect(frozen.services[0].shootDate).toBe("2026-08-01"); // ngày chính vẫn theo bản ký
    expect(frozen.services[0].occurrences).toEqual([
      { date: "2026-08-04", time: "08:00", label: "Ngày rước dâu", addedAfterSign: true },
    ]);
  });

  it("bản ký CŨ (v2) + thêm ngày sau khi ký → vừa back-fill vừa gắn cờ đúng ngày mới", () => {
    const live = makeLivePayload();
    const snapV2 = buildSignedSnapshot(live) as Record<string, unknown>;
    for (const s of snapV2.services as Record<string, unknown>[]) delete s.occurrences;
    snapV2.schedule = [
      { date: "2026-08-01", time: "08:00", label: "Chụp cưới" },
      { date: "2026-08-02", time: "10:00", label: "Nhà trai" }, // đã có lúc ký
    ];
    live.services[0].occurrences = [
      { date: "2026-08-02", time: "10:00", label: "Nhà trai" },
      { date: "2026-08-04", time: "08:00", label: "Rước dâu" }, // thêm sau khi ký
    ];
    live.services[0].shootDate = "2026-08-15";

    const frozen = applySignedSnapshotForDisplay(live, snapV2);
    expect(frozen.services[0].occurrences).toEqual([
      { date: "2026-08-02", time: "10:00", label: "Nhà trai" },
      { date: "2026-08-04", time: "08:00", label: "Rước dâu", addedAfterSign: true },
    ]);
  });
});

describe("splitSnapshotSchedule — chia lịch bản ký về từng dịch vụ", () => {
  it("1 dịch vụ: mọi mốc sau ngày chính là ngày phụ của nó", () => {
    const m = splitSnapshotSchedule(
      [
        { date: "2026-08-01", time: "08:00", label: null },
        { date: "2026-08-02", time: "10:00", label: "Nhà trai" },
        { date: "2026-08-03", time: null, label: null },
      ],
      [{ bookingId: 10, shootDate: "2026-08-01" }],
    );
    expect(m.get(10)).toEqual([
      { date: "2026-08-02", time: "10:00", label: "Nhà trai" },
      { date: "2026-08-03", time: null, label: null },
    ]);
  });

  it("nhiều dịch vụ: ngày phụ về ĐÚNG dịch vụ của nó", () => {
    const m = splitSnapshotSchedule(
      [
        { date: "2026-08-01", time: "08:00", label: null },
        { date: "2026-08-02", time: "10:00", label: "Nhà trai" },
        { date: "2026-09-05", time: "07:00", label: null },
        { date: "2026-09-06", time: "07:00", label: "Tiệc" },
      ],
      [
        { bookingId: 10, shootDate: "2026-08-01" },
        { bookingId: 11, shootDate: "2026-09-05" },
      ],
    );
    expect(m.get(10)).toEqual([{ date: "2026-08-02", time: "10:00", label: "Nhà trai" }]);
    expect(m.get(11)).toEqual([{ date: "2026-09-06", time: "07:00", label: "Tiệc" }]);
  });

  it("2 dịch vụ TRÙNG ngày chính: dò tiến, không cướp block của nhau", () => {
    const m = splitSnapshotSchedule(
      [
        { date: "2026-08-01", time: "08:00", label: null },
        { date: "2026-08-04", time: null, label: "phụ của DV1" },
        { date: "2026-08-01", time: "14:00", label: null },
      ],
      [
        { bookingId: 10, shootDate: "2026-08-01" },
        { bookingId: 11, shootDate: "2026-08-01" },
      ],
    );
    expect(m.get(10)).toEqual([{ date: "2026-08-04", time: null, label: "phụ của DV1" }]);
    expect(m.get(11)).toEqual([]);
  });

  it("lịch rỗng / dịch vụ không có ngày → không nổ, trả rỗng", () => {
    expect(splitSnapshotSchedule([], [{ bookingId: 10, shootDate: "2026-08-01" }]).size).toBe(0);
    const m = splitSnapshotSchedule(
      [{ date: "2026-08-01", time: null, label: null }],
      [{ bookingId: 10, shootDate: null }],
    );
    expect(m.get(10)).toBeUndefined();
  });
});
