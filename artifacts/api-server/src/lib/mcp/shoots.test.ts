import { describe, it, expect, vi } from "vitest";

const query = vi.fn();
vi.mock("@workspace/db", () => ({ db: {}, pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../schema-compat.js", () => ({ getSchemaFlags: vi.fn(async () => ({ occurrences: false })) }));

import { listShoots } from "./shoots.js";

describe("listShoots — validate ngày + cap range (chặn query quá rộng / injection)", () => {
  it("sai định dạng ngày → bad_request, KHÔNG query DB", async () => {
    query.mockReset();
    await expect(listShoots("2026/07/23", "2026-07-24")).rejects.toThrow(/bad_request/);
    await expect(listShoots("hôm nay", "mai")).rejects.toThrow(/bad_request/);
    expect(query).not.toHaveBeenCalled();
  });

  it("from > to → bad_request", async () => {
    await expect(listShoots("2026-07-25", "2026-07-20")).rejects.toThrow(/bad_request/);
  });

  it("khoảng > 92 ngày → bad_request", async () => {
    await expect(listShoots("2026-01-01", "2026-12-31")).rejects.toThrow(/bad_request/);
  });

  it("ngày hợp lệ → chạy query, trả shape whitelist + count", async () => {
    query.mockReset();
    query.mockResolvedValueOnce({
      rows: [{
        id: 312, order_code: "DH0233", service_label: "Chụp cưới", package_type: null,
        shoot_date: "2026-07-23", shoot_time: "08:00:00", location: "Tây Ninh",
        status: "confirmed", customer_name: "Chị Hoa",
      }],
    });
    const r = await listShoots("2026-07-23", "2026-07-23");
    expect(r.count).toBe(1);
    expect(r.shoots[0]).toEqual({
      bookingId: 312, orderCode: "DH0233", customerName: "Chị Hoa",
      date: "2026-07-23", time: "08:00", location: "Tây Ninh",
      serviceLabel: "Chụp cưới", status: "confirmed", additionalDay: false,
    });
    // KHÔNG lộ field ngoài whitelist (không có password/customer_id thô/raw row)
    expect(Object.keys(r.shoots[0]).sort()).toEqual(
      ["additionalDay", "bookingId", "customerName", "date", "location", "orderCode", "serviceLabel", "status", "time"],
    );
  });
});
