import { describe, expect, it } from "vitest";
import { cascadeContractDateToServices } from "./booking-date-cascade";

describe("cascadeContractDateToServices", () => {
  it("dời dịch vụ đang ở ngày hợp đồng cũ", () => {
    expect(cascadeContractDateToServices(
      [{ shootDate: "2026-09-06", name: "Chụp cổng" }],
      "2026-09-06",
      "2026-09-07",
    )).toEqual([{ shootDate: "2026-09-07", name: "Chụp cổng" }]);
  });

  it("giữ nguyên dịch vụ có ngày riêng khác", () => {
    expect(cascadeContractDateToServices(
      [
        { shootDate: "2026-09-06", name: "Chụp cổng" },
        { shootDate: "2026-10-17", name: "Dịch vụ 2" },
      ],
      "2026-09-06",
      "2026-09-07",
    )).toEqual([
      { shootDate: "2026-09-07", name: "Chụp cổng" },
      { shootDate: "2026-10-17", name: "Dịch vụ 2" },
    ]);
  });

  it("gắn ngày mới cho dịch vụ đang kế thừa ngày hợp đồng", () => {
    expect(cascadeContractDateToServices(
      [{ shootDate: "", name: "Dịch vụ mới" }],
      "2026-09-06",
      "2026-09-07",
    )).toEqual([{ shootDate: "2026-09-07", name: "Dịch vụ mới" }]);
  });
});
