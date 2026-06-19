import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./ai-orchestrator", () => ({ callChat: vi.fn() }));

import { callChat } from "./ai-orchestrator";
import {
  buildImageRoutingBlock,
  classifyCustomerImageIntent,
  fetchImageAsBase64,
  SERVICE_INTENTS,
  type CustomerImageIntent,
} from "./sale-vision";

const mockCall = callChat as unknown as ReturnType<typeof vi.fn>;

const base: CustomerImageIntent = {
  image_type: "", service_intent: "unknown", confidence: 0, visual_description: "x",
  outfit: "", mood: "", location_type: "", required_items: [], can_studio_do: true,
  should_use_photo_ideas: false, recommended_data_source: "",
};

function stubFetchOk() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/jpeg" : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  })));
}

beforeEach(() => { mockCall.mockReset(); vi.unstubAllGlobals(); });

describe("sale-vision", () => {
  it("đủ 9 nhóm service_intent", () => {
    expect(SERVICE_INTENTS.length).toBe(9);
    for (const k of ["beauty", "wedding_album", "wedding_gate", "wedding_party", "rental_outfit", "maternity", "family", "new_concept_idea", "unknown"]) {
      expect(SERVICE_INTENTS).toContain(k);
    }
  });

  it("fetchImageAsBase64 từ chối URL rỗng/sai scheme", async () => {
    expect(await fetchImageAsBase64("")).toBeNull();
    expect(await fetchImageAsBase64("ftp://x/a.jpg")).toBeNull();
  });

  it("routing beauty: ưu tiên beauty, KHÔNG gửi album cưới", () => {
    const b = buildImageRoutingBlock({ ...base, service_intent: "beauty", confidence: 0.9 });
    expect(b).toContain("Beauty");
    expect(b).toContain("KHÔNG gửi album cưới");
  });

  it("routing wedding_album: KHÔNG gửi beauty cá nhân", () => {
    const b = buildImageRoutingBlock({ ...base, service_intent: "wedding_album", confidence: 0.9 });
    expect(b).toContain("ẢNH CƯỚI");
    expect(b).toContain("KHÔNG gửi beauty");
  });

  it("routing rental_outfit: điều hướng Cho thuê trang phục", () => {
    const b = buildImageRoutingBlock({ ...base, service_intent: "rental_outfit", confidence: 0.9 });
    expect(b).toContain("Cho thuê trang phục");
  });

  it("routing new_concept_idea: phải nói cần kiểm tra đạo cụ", () => {
    const b = buildImageRoutingBlock({ ...base, service_intent: "new_concept_idea", confidence: 0.8, should_use_photo_ideas: true });
    expect(b).toContain("đạo cụ");
    expect(b).toContain("hướng tương tự");
  });

  it("routing unknown / độ chắc thấp → HỎI LẠI, chưa gửi link", () => {
    expect(buildImageRoutingBlock({ ...base, service_intent: "unknown", confidence: 0 })).toContain("HỎI LẠI");
    // beauty nhưng confidence thấp → vẫn xử lý như unknown (hỏi lại)
    expect(buildImageRoutingBlock({ ...base, service_intent: "beauty", confidence: 0.2 })).toContain("HỎI LẠI");
  });

  it("classify: enum lạ → unknown, confidence bị kẹp về [0,1]", async () => {
    stubFetchOk();
    mockCall.mockResolvedValue({ ok: true, text: JSON.stringify({ service_intent: "xxx", confidence: 9, visual_description: "abc" }) });
    const r = await classifyCustomerImageIntent({ imageUrl: "https://x/i.jpg", messageText: "bộ này được không" });
    expect(r.service_intent).toBe("unknown");
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
  });

  it("classify: JSON bọc ```json``` + enum hợp lệ → giữ nguyên", async () => {
    stubFetchOk();
    mockCall.mockResolvedValue({ ok: true, text: '```json\n{"service_intent":"beauty","confidence":0.92,"can_studio_do":true}\n```' });
    const r = await classifyCustomerImageIntent({ imageUrl: "https://x/i.jpg" });
    expect(r.service_intent).toBe("beauty");
    expect(r.confidence).toBeCloseTo(0.92);
  });

  it("classify: tải ảnh lỗi → unknown (không throw, không gọi AI)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })));
    const r = await classifyCustomerImageIntent({ imageUrl: "https://x/bad.jpg" });
    expect(r.service_intent).toBe("unknown");
    expect(mockCall).not.toHaveBeenCalled();
  });
});
