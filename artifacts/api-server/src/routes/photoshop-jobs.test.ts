import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn() },
}));
vi.mock("@workspace/db/schema", () => ({
  photoshopJobsTable: {},
  bookingsTable: {},
  bookingItemsTable: {},
  paymentsTable: {},
}));
vi.mock("./auth", () => ({
  verifyToken: vi.fn(),
}));

import {
  normalizeViet,
  daysForService,
  addDaysToStr,
  calcSystemDeadline,
} from "./photoshop-jobs.js";

// ── normalizeViet ─────────────────────────────────────────────────────────────

describe("normalizeViet", () => {
  it("strips diacritics and lowercases", () => {
    expect(normalizeViet("Ngoại Cảnh")).toBe("ngoai canh");
  });
  it("handles album with diacritics", () => {
    expect(normalizeViet("Album Cưới")).toBe("album cuoi");
  });
  it("returns empty string unchanged", () => {
    expect(normalizeViet("")).toBe("");
  });
  it("handles plain ascii", () => {
    expect(normalizeViet("Chup Thuong")).toBe("chup thuong");
  });
});

// ── daysForService ────────────────────────────────────────────────────────────

describe("daysForService", () => {
  it("returns 15 for album (exact)", () => {
    expect(daysForService("Album")).toBe(15);
  });
  it("returns 15 for album lowercase", () => {
    expect(daysForService("album cưới")).toBe(15);
  });
  it("returns 15 for ngoại cảnh (diacritics)", () => {
    expect(daysForService("Ngoại Cảnh")).toBe(15);
  });
  it("returns 15 for ngoai canh (no diacritics)", () => {
    expect(daysForService("ngoai canh")).toBe(15);
  });
  it("returns 15 when service name contains album as substring", () => {
    expect(daysForService("Gói Album Cưới Cao Cấp")).toBe(15);
  });
  it("returns 10 for standard chụp thường", () => {
    expect(daysForService("Chụp Thường")).toBe(10);
  });
  it("returns 10 for null", () => {
    expect(daysForService(null)).toBe(10);
  });
  it("returns 10 for undefined", () => {
    expect(daysForService(undefined)).toBe(10);
  });
  it("returns 10 for empty string", () => {
    expect(daysForService("")).toBe(10);
  });
});

// ── addDaysToStr ──────────────────────────────────────────────────────────────

describe("addDaysToStr", () => {
  it("adds 10 days correctly", () => {
    expect(addDaysToStr("2025-01-01", 10)).toBe("2025-01-11");
  });
  it("adds 15 days crossing month boundary", () => {
    expect(addDaysToStr("2025-01-25", 15)).toBe("2025-02-09");
  });
  it("adds 10 days crossing year boundary", () => {
    expect(addDaysToStr("2024-12-28", 10)).toBe("2025-01-07");
  });
  it("handles leap year February", () => {
    expect(addDaysToStr("2024-02-20", 10)).toBe("2024-03-01");
  });
  it("handles non-leap year February", () => {
    expect(addDaysToStr("2025-02-20", 10)).toBe("2025-03-02");
  });
  it("is NOT subject to UTC drift (uses local date constructor)", () => {
    const result = addDaysToStr("2025-03-15", 0);
    expect(result).toBe("2025-03-15");
  });
});

// ── calcSystemDeadline ────────────────────────────────────────────────────────

describe("calcSystemDeadline", () => {
  it("returns null for null shootDate", () => {
    expect(calcSystemDeadline(null, "Album")).toBeNull();
  });
  it("returns null for empty shootDate", () => {
    expect(calcSystemDeadline("", "Chụp Thường")).toBeNull();
  });
  it("returns null for non-date string", () => {
    expect(calcSystemDeadline("not-a-date", "Album")).toBeNull();
  });
  it("computes +15 days for album from shoot_date", () => {
    expect(calcSystemDeadline("2025-04-01", "Album Cưới")).toBe("2025-04-16");
  });
  it("computes +15 days for ngoại cảnh (diacritics)", () => {
    expect(calcSystemDeadline("2025-04-01", "Ngoại Cảnh")).toBe("2025-04-16");
  });
  it("computes +15 days for ngoai canh (no diacritics)", () => {
    expect(calcSystemDeadline("2025-04-01", "ngoai canh")).toBe("2025-04-16");
  });
  it("computes +10 days for standard service", () => {
    expect(calcSystemDeadline("2025-04-01", "Chụp Thường")).toBe("2025-04-11");
  });
  it("computes +10 days for null service", () => {
    expect(calcSystemDeadline("2025-04-01", null)).toBe("2025-04-11");
  });

  // Shoot-date visibility boundary: shoot_date today → job visible; shoot_date tomorrow → not
  it("uses shoot_date (not received_file_date) as deadline base", () => {
    const shootDate = "2025-06-10";
    const deadline = calcSystemDeadline(shootDate, "Album");
    expect(deadline).toBe("2025-06-25");
  });

  it("month-boundary: shoot_date near end of month computes correctly", () => {
    expect(calcSystemDeadline("2025-01-28", "Ngoại Cảnh")).toBe("2025-02-12");
  });

  it("year-boundary: shoot_date near end of year computes correctly", () => {
    expect(calcSystemDeadline("2024-12-25", "Album")).toBe("2025-01-09");
  });
});
