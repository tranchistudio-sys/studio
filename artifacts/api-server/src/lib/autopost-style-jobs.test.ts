import { describe, it, expect, vi } from "vitest";
// Module có import side-effect lúc load (pool DB + AI client) → mock để test helper thuần.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn() } }));
vi.mock("./autopost-style", () => ({ ocrImageToText: vi.fn() }));
import {
  isValidStatus,
  canRetry,
  nextStatusAfterRun,
  summarizeError,
  combineContent,
  jobRowToDto,
  STYLE_JOB_STATUSES,
} from "./autopost-style-jobs";

describe("isValidStatus", () => {
  it("nhận đúng 4 trạng thái hợp lệ", () => {
    for (const s of STYLE_JOB_STATUSES) expect(isValidStatus(s)).toBe(true);
    expect(STYLE_JOB_STATUSES).toEqual(["pending", "processing", "done", "failed"]);
  });
  it("từ chối giá trị lạ / non-string", () => {
    expect(isValidStatus("bogus")).toBe(false);
    expect(isValidStatus("")).toBe(false);
    expect(isValidStatus(null)).toBe(false);
    expect(isValidStatus(3)).toBe(false);
  });
});

describe("canRetry", () => {
  it("CHỈ job failed mới retry được", () => {
    expect(canRetry("failed")).toBe(true);
    expect(canRetry("pending")).toBe(false);
    expect(canRetry("processing")).toBe(false);
    expect(canRetry("done")).toBe(false);
    expect(canRetry(undefined)).toBe(false);
  });
});

describe("nextStatusAfterRun", () => {
  it("ok → done, lỗi → failed", () => {
    expect(nextStatusAfterRun(true)).toBe("done");
    expect(nextStatusAfterRun(false)).toBe("failed");
  });
});

describe("summarizeError", () => {
  it("rút Error.message, gộp khoảng trắng, cắt ngắn", () => {
    expect(summarizeError(new Error("OCR  thất\n bại"))).toBe("OCR thất bại");
    expect(summarizeError("chuỗi lỗi")).toBe("chuỗi lỗi");
    expect(summarizeError(null)).toBe("Lỗi không rõ");
    expect(summarizeError(new Error("x".repeat(500))).length).toBe(200);
  });
});

describe("combineContent", () => {
  it("gộp text dán + các text OCR, bỏ phần rỗng", () => {
    expect(combineContent("Dán", ["A", "B"])).toBe("Dán\n\nA\n\nB");
    expect(combineContent("", ["", "Chỉ OCR"])).toBe("Chỉ OCR");
    expect(combineContent(null, [])).toBe("");
    expect(combineContent("  chỉ dán  ", [])).toBe("chỉ dán");
  });
});

describe("jobRowToDto", () => {
  it("map row snake_case → DTO camelCase, KHÔNG lộ base64 ảnh", () => {
    const dto = jobRowToDto({
      id: "12", status: "done", title: "Bài hay", content_type: "vay_cuoi", tone: "thân thiện",
      priority: "5", style_topic_label: "Váy cưới",
      images_base64: [{ dataBase64: "AAAA", mediaType: "image/jpeg" }],
      image_urls: ["/uploads/x"], result_sample_id: "88", error: null, attempts: "1",
      created_at: "2026-06-26T00:00:00Z", updated_at: "2026-06-26T00:01:00Z",
    });
    expect(dto).toMatchObject({
      id: 12, status: "done", title: "Bài hay", contentType: "vay_cuoi", tone: "thân thiện",
      priority: 5, styleTopicLabel: "Váy cưới", imageCount: 1, resultSampleId: 88, attempts: 1, error: null,
    });
    // DTO không có trường base64
    expect((dto as Record<string, unknown>).images_base64).toBeUndefined();
    expect((dto as Record<string, unknown>).dataBase64).toBeUndefined();
  });
  it("imageCount lấy theo image_urls khi base64 đã bị clear (job done)", () => {
    const dto = jobRowToDto({ id: 1, status: "done", title: "x", images_base64: [], image_urls: ["/a", "/b"] });
    expect(dto.imageCount).toBe(2);
  });
  it("xử lý jsonb dạng chuỗi", () => {
    const dto = jobRowToDto({ id: 1, status: "pending", title: "x", images_base64: '[{"dataBase64":"Y"}]', image_urls: "[]" });
    expect(dto.imageCount).toBe(1);
  });
});
