import { describe, it, expect, afterEach } from "vitest";
import {
  isLuluNotifyEnabled, hourBucket, dayBucket,
  botOffKey, newLeadKey, phoneKey, apptKey, escKey, errorKey,
} from "./sale-notify";

const D1 = new Date("2026-07-28T09:15:30.000Z");
const D2 = new Date("2026-07-28T09:59:59.000Z"); // cùng giờ
const D3 = new Date("2026-07-28T10:00:01.000Z"); // giờ khác, cùng ngày
const D4 = new Date("2026-07-29T09:15:30.000Z"); // ngày khác

afterEach(() => { delete process.env.LULU_NOTIFY_ENABLED; });

describe("sale-notify — cờ + khóa dedupe chống spam", () => {
  it("cờ mặc định TẮT", () => {
    expect(isLuluNotifyEnabled()).toBe(false);
    process.env.LULU_NOTIFY_ENABLED = "true";
    expect(isLuluNotifyEnabled()).toBe(true);
  });

  it("bucket giờ/ngày deterministic", () => {
    expect(hourBucket(D1)).toBe("2026-07-28T09");
    expect(dayBucket(D1)).toBe("2026-07-28");
  });

  it("botOff: cùng giờ = CÙNG key (khách nhắn 10 tin → 1 noti); sang giờ mới = key mới", () => {
    expect(botOffKey("p1", D1)).toBe(botOffKey("p1", D2));
    expect(botOffKey("p1", D1)).not.toBe(botOffKey("p1", D3));
    expect(botOffKey("p1", D1)).not.toBe(botOffKey("p2", D1)); // khác khách = khác key
  });

  it("newLead: TRỌN ĐỜI theo khách (không có thành phần thời gian)", () => {
    expect(newLeadKey("p1")).toBe(newLeadKey("p1"));
    expect(newLeadKey("p1")).not.toContain("2026");
  });

  it("phone/appt/esc: 1 khóa/khách/NGÀY", () => {
    expect(phoneKey("p1", D1)).toBe(phoneKey("p1", D3));
    expect(phoneKey("p1", D1)).not.toBe(phoneKey("p1", D4));
    expect(apptKey("p1", D1)).toBe(apptKey("p1", D3));
    expect(escKey("p1", D1)).toBe(escKey("p1", D3));
  });

  it("error: 1 khóa/GIỜ toàn hệ (chống bão noti khi sập diện rộng)", () => {
    expect(errorKey(D1)).toBe(errorKey(D2));
    expect(errorKey(D1)).not.toBe(errorKey(D3));
  });

  it("mọi key có prefix lulu_ và không đụng nhau giữa các loại", () => {
    const keys = [botOffKey("p", D1), newLeadKey("p"), phoneKey("p", D1), apptKey("p", D1), escKey("p", D1), errorKey(D1)];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.startsWith("lulu_")).toBe(true);
  });
});
