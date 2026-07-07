import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveRentalListScroll,
  readRentalListScroll,
  clearRentalListScroll,
} from "./rental-scroll-state";

const KEY = "amazing:rental:list-scroll-state";

// Môi trường vitest ở đây là node (không có jsdom) → stub window + sessionStorage.
let store: Map<string, string>;
function setWindow(pathname: string, search: string, scrollY: number) {
  (globalThis as unknown as { window: unknown }).window = {
    location: { pathname, search },
    scrollY,
  };
}

beforeEach(() => {
  store = new Map<string, string>();
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  setWindow("/cho-thue-do", "?categoryId=25", 1234);
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rental-scroll-state", () => {
  it("round-trips URL, scrollY, productId và timestamp", () => {
    saveRentalListScroll(777);
    const s = readRentalListScroll();
    expect(s).toEqual({
      listUrl: "/cho-thue-do?categoryId=25",
      scrollY: 1234,
      productId: 777,
      timestamp: 1_000_000,
    });
  });

  it("chụp đúng URL + scrollY hiện tại lúc lưu (đủ categoryId/sort/q)", () => {
    setWindow("/cho-thue-do", "?categoryId=30&sort=price_asc&q=vay", 5000);
    saveRentalListScroll(42);
    expect(readRentalListScroll()).toMatchObject({
      listUrl: "/cho-thue-do?categoryId=30&sort=price_asc&q=vay",
      scrollY: 5000,
      productId: 42,
    });
  });

  it("trả null khi chưa lưu gì", () => {
    expect(readRentalListScroll()).toBeNull();
  });

  it("trả null khi trạng thái quá cũ (>30 phút)", () => {
    saveRentalListScroll(1); // timestamp = 1_000_000
    vi.spyOn(Date, "now").mockReturnValue(1_000_000 + 30 * 60 * 1000 + 1);
    expect(readRentalListScroll()).toBeNull();
  });

  it("vẫn nhận trạng thái trong hạn (đúng 30 phút)", () => {
    saveRentalListScroll(1);
    vi.spyOn(Date, "now").mockReturnValue(1_000_000 + 30 * 60 * 1000);
    expect(readRentalListScroll()?.productId).toBe(1);
  });

  it("trả null khi JSON hỏng, không ném lỗi", () => {
    store.set(KEY, "{not json");
    expect(readRentalListScroll()).toBeNull();
  });

  it("trả null khi thiếu field bắt buộc", () => {
    store.set(KEY, JSON.stringify({ listUrl: "/cho-thue-do", scrollY: 1 }));
    expect(readRentalListScroll()).toBeNull();
  });

  it("clear() xoá trạng thái (one-shot)", () => {
    saveRentalListScroll(9);
    expect(readRentalListScroll()).not.toBeNull();
    clearRentalListScroll();
    expect(readRentalListScroll()).toBeNull();
  });
});
