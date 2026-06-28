import { describe, it, expect, vi } from "vitest";

// Mock DB để import module không cần DATABASE_URL (matchResponseOverride là logic thuần).
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { matchResponseOverride, type ImageOverride } from "./sale-image-overrides";

function taught(customerQuestion: string, editedText: string): ImageOverride {
  return {
    id: "ov_test",
    customerQuestion,
    intent: null,
    tone: null,
    wrongImages: [],
    correctImages: [],
    editedText,
    responseMode: "exact_reply",
    hasImageInput: false,
    createdAt: "2026-06-28T00:00:00Z",
    createdByName: "admin",
  };
}

// Case C (theo yêu cầu): sau khi "dạy" một câu (override đã lưu), hỏi LẠI ĐÚNG câu đó
// phải lấy được bài dạy. Đây là happy-path của cơ chế dạy→nhớ (lưu DB + khớp câu y hệt).
describe("matchResponseOverride — Case C: dạy xong hỏi lại lấy được bài dạy", () => {
  const addr = "Số 80, Hẻm 71, Đường Cách Mạng Tháng 8, Hiệp Ninh, TP. Tây Ninh";
  const ov = taught("địa chỉ tiệm ở đâu nhi", addr);

  it("hỏi lại ĐÚNG câu đã dạy → khớp override, trả về đúng câu đã dạy", () => {
    const m = matchResponseOverride("địa chỉ tiệm ở đâu nhi", "", [ov], { hasImage: false });
    expect(m).not.toBeNull();
    expect(m?.editedText).toBe(addr);
  });

  it("override dạng TEXT (hasImageInput=false) KHÔNG bị lọc khi lượt không có ảnh", () => {
    const m = matchResponseOverride("ĐỊA CHỈ TIỆM Ở ĐÂU NHI", "", [ov], { hasImage: false });
    expect(m?.editedText).toBe(addr);
  });
});
