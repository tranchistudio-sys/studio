import { describe, expect, it } from "vitest";
import { bookingCalendarUrl, canOpenBookingCalendar } from "./open-calendar";

describe("bookingCalendarUrl", () => {
  it("tạo deep-link ?bookingId đúng", () => {
    expect(bookingCalendarUrl(42)).toBe("/calendar?bookingId=42");
  });
});

describe("canOpenBookingCalendar — chỉ hiện nút khi có bookingId hợp lệ", () => {
  it("bookingId hợp lệ → hiện", () => {
    expect(canOpenBookingCalendar(1)).toBe(true);
    expect(canOpenBookingCalendar(9999)).toBe(true);
  });
  it("không gắn booking (null/undefined) → KHÔNG hiện", () => {
    expect(canOpenBookingCalendar(null)).toBe(false);
    expect(canOpenBookingCalendar(undefined)).toBe(false);
  });
  it("id không hợp lệ (0/âm/không nguyên/NaN) → KHÔNG hiện", () => {
    expect(canOpenBookingCalendar(0)).toBe(false);
    expect(canOpenBookingCalendar(-5)).toBe(false);
    expect(canOpenBookingCalendar(1.5)).toBe(false);
    expect(canOpenBookingCalendar(NaN)).toBe(false);
  });
});
