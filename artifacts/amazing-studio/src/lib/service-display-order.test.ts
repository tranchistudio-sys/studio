import { describe, expect, it } from "vitest";
import {
  serviceDisplayOrdinal,
  sortServicesByEventDate,
} from "./service-display-order";

type Service = {
  id: number;
  orderCode: string;
  serviceLabel: string | null;
  shootDate: string | null;
  shootTime: string | null;
};

const dh0290: Service[] = [
  {
    id: 1,
    orderCode: "DH0290-1",
    serviceLabel: "Dịch vụ 1",
    shootDate: "2026-09-20",
    shootTime: "07:00",
  },
  {
    id: 2,
    orderCode: "DH0290-2",
    serviceLabel: "Dịch vụ 2",
    shootDate: "2026-08-10",
    shootTime: "08:00",
  },
  {
    id: 3,
    orderCode: "DH0290-3",
    serviceLabel: "Dịch vụ 3",
    shootDate: "2026-10-18",
    shootTime: "08:00",
  },
  {
    id: 4,
    orderCode: "DH0290-4",
    serviceLabel: "Dịch vụ 4",
    shootDate: "2026-10-18",
    shootTime: "09:00",
  },
  {
    id: 5,
    orderCode: "DH0290-5",
    serviceLabel: "Dịch vụ 5",
    shootDate: "2026-10-19",
    shootTime: "08:00",
  },
];

describe("sortServicesByEventDate", () => {
  it("xếp DH0290 theo ngày giờ thực hiện, không theo ngày chốt hay đuôi mã", () => {
    expect(sortServicesByEventDate(dh0290).map((s) => s.orderCode)).toEqual([
      "DH0290-2",
      "DH0290-1",
      "DH0290-3",
      "DH0290-4",
      "DH0290-5",
    ]);
  });

  it("cùng ngày thì giờ sớm hơn đứng trước", () => {
    const result = sortServicesByEventDate([
      { ...dh0290[3], shootTime: "14:00" },
      { ...dh0290[2], shootTime: "08:30" },
    ]);
    expect(result.map((s) => s.shootTime)).toEqual(["08:30", "14:00"]);
  });

  it("đẩy dịch vụ thiếu hoặc sai ngày xuống cuối và giữ thứ tự ổn định", () => {
    const result = sortServicesByEventDate([
      { ...dh0290[0], id: 10, shootDate: null },
      { ...dh0290[1], id: 20, shootDate: "không-hợp-lệ" },
      dh0290[2],
    ]);
    expect(result.map((s) => s.id)).toEqual([3, 10, 20]);
  });

  it("không thay đổi mảng hoặc dữ liệu gốc", () => {
    const original = dh0290.map((s) => ({ ...s }));
    const sorted = sortServicesByEventDate(dh0290);
    expect(sorted).not.toBe(dh0290);
    expect(dh0290).toEqual(original);
  });

  it("giữ nguyên số dịch vụ từ label hoặc mã sau khi đổi vị trí", () => {
    const sorted = sortServicesByEventDate(dh0290);
    expect(sorted.map((s, index) => serviceDisplayOrdinal(s, index))).toEqual([
      2, 1, 3, 4, 5,
    ]);
    expect(
      serviceDisplayOrdinal({ serviceLabel: null, orderCode: "DH0290-7" }, 0),
    ).toBe(7);
  });
});
