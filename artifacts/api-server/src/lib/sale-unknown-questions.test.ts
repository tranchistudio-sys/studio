import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { pool } from "@workspace/db";
import { isNoiseForCapture, captureUnknownQuestion } from "./sale-unknown-questions";

const mockQuery = pool.query as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => mockQuery.mockReset());

describe("isNoiseForCapture — bỏ chào hỏi/ack/ảnh/quá ngắn", () => {
  it("bỏ rỗng, ảnh/sticker, ack ngắn", () => {
    expect(isNoiseForCapture("")).toBe(true);
    expect(isNoiseForCapture("[image:https://x/y.jpg]")).toBe(true);
    expect(isNoiseForCapture("ok ạ")).toBe(true);
  });
  it("bỏ câu <2 từ nội dung", () => {
    expect(isNoiseForCapture("giá?")).toBe(true);
  });
  it("GIỮ câu hỏi thật", () => {
    expect(isNoiseForCapture("Bên em có in formex chống nước không?")).toBe(false);
  });
});

describe("captureUnknownQuestion", () => {
  it("noise → không ghi", async () => {
    const r = await captureUnknownQuestion({ customerText: "ok em" });
    expect(r.captured).toBe(false);
    if (!r.captured) expect(r.reason).toBe("noise");
  });

  it("câu mới → INSERT, created=true", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/^\s*CREATE|ALTER|INDEX/i.test(sql)) return { rows: [] };
      if (/SELECT id, occurrence_count/i.test(sql)) return { rows: [] };           // chưa có
      if (/INSERT INTO lulu_unknown_questions/i.test(sql)) return { rows: [{ id: 7, occurrence_count: 1 }] };
      return { rows: [] };
    });
    const r = await captureUnknownQuestion({ customerText: "Bên em có in formex chống nước không?", serviceKey: "wedding_gate" });
    expect(r.captured).toBe(true);
    if (r.captured) { expect(r.created).toBe(true); expect(r.id).toBe(7); expect(r.occurrenceCount).toBe(1); }
  });

  it("câu trùng nghĩa → UPDATE đếm, created=false", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT id, occurrence_count/i.test(sql)) return { rows: [{ id: 3, occurrence_count: 5, customer_text: "in formex chống nước không", sample_variants: [] }] };
      return { rows: [] };
    });
    const r = await captureUnknownQuestion({ customerText: "Bên mình in formex chống nước hả?", serviceKey: "wedding_gate" });
    expect(r.captured).toBe(true);
    if (r.captured) { expect(r.created).toBe(false); expect(r.id).toBe(3); expect(r.occurrenceCount).toBe(6); }
  });

  it("lỗi DB (SELECT) → fail-safe: KHÔNG ném, trả captured:false", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT id, occurrence_count/i.test(sql)) throw new Error("db down");
      return { rows: [] }; // CREATE/index/… ok
    });
    await expect(
      captureUnknownQuestion({ customerText: "câu hỏi thật sự dài đủ token", serviceKey: "x" }),
    ).resolves.toMatchObject({ captured: false });
  });
});
