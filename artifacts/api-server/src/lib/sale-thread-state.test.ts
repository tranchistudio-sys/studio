import { describe, it, expect, vi } from "vitest";
// sale-thread-state.ts import `pool` từ @workspace/db (throw "DATABASE_URL must be set"
// lúc import nếu thiếu env). Test chỉ dùng hàm THUẦN (merge + build block) → mock db,
// theo convention các unit test khác trong repo (xem attendance-mode.test.ts).
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import {
  mergeAskedQuestions,
  mergeQuotedPackages,
  mergeSentAssets,
  buildThreadStateBlock,
  simulateThreadStateFromHistory,
  type ThreadState,
} from "./sale-thread-state";

const AT = "2026-07-28T10:00:00.000Z";

function baseState(over: Partial<ThreadState> = {}): ThreadState {
  return {
    facebookUserId: "psid1",
    currentStage: "new",
    previousStage: null,
    serviceIntent: null,
    customerStatus: "lead",
    lastAction: null,
    slots: {},
    askedQuestions: [],
    quotedPackages: [],
    sentAssets: {},
    lastUserMessageAt: null,
    lastBotMessageAt: null,
    version: 0,
    ...over,
  };
}

describe("merge helpers (thuần)", () => {
  it("mergeAskedQuestions: thêm mới rồi tăng count, không nhân bản key", () => {
    const a1 = mergeAskedQuestions([], "ask_date", AT);
    expect(a1).toEqual([{ key: "ask_date", at: AT, count: 1 }]);
    const a2 = mergeAskedQuestions(a1, "ask_date", AT);
    expect(a2).toHaveLength(1);
    expect(a2[0].count).toBe(2);
  });

  it("mergeQuotedPackages: upper-case + dedupe, giữ gói cũ", () => {
    const q1 = mergeQuotedPackages([], ["st-luxury", "CG-BASIC"], AT);
    expect(q1.map((p) => p.code)).toEqual(["ST-LUXURY", "CG-BASIC"]);
    const q2 = mergeQuotedPackages(q1, ["ST-LUXURY", "NC-PRO"], AT);
    expect(q2.map((p) => p.code)).toEqual(["ST-LUXURY", "CG-BASIC", "NC-PRO"]);
  });

  it("mergeSentAssets: gộp URL + group id, dedupe", () => {
    const s1 = mergeSentAssets({}, ["/u/a.jpg"], [3]);
    const s2 = mergeSentAssets(s1, ["/u/a.jpg", "/u/b.jpg"], [3, 5]);
    expect(s2.sample_urls).toEqual(["/u/a.jpg", "/u/b.jpg"]);
    expect(s2.price_group_ids).toEqual([3, 5]);
  });
});

describe("buildThreadStateBlock", () => {
  it("null / state trống → chuỗi rỗng (không chèn gì vào prompt)", () => {
    expect(buildThreadStateBlock(null)).toBe("");
    expect(buildThreadStateBlock(baseState())).toBe("");
  });

  it("date not_decided → cấm hỏi lại ngày + hướng báo giá tham khảo", () => {
    const block = buildThreadStateBlock(baseState({ slots: { date_status: "not_decided" } }));
    expect(block).toContain("CHƯA CHỐT NGÀY");
    expect(block).toContain("KHÔNG hỏi lại ngày");
    expect(block).toContain("GIÁ THAM KHẢO");
  });

  it("date known → nhắc đúng mốc, cấm hỏi lại", () => {
    const block = buildThreadStateBlock(
      baseState({ slots: { date_status: "known", event_date: "2026-12-20", date_text: "20/12" } }),
    );
    expect(block).toContain("2026-12-20");
    expect(block).toContain("KHÔNG hỏi lại ngày");
  });

  it("đã hỏi ngày mà khách chưa trả lời → không lặp lại câu hỏi ngày", () => {
    const block = buildThreadStateBlock(
      baseState({ askedQuestions: [{ key: "ask_date", at: AT, count: 1 }] }),
    );
    expect(block).toContain("ĐÃ HỎI ngày");
    expect(block).toContain("KHÔNG lặp lại");
  });

  it("đã báo giá gói → liệt kê mã, không bung lại bảng giá", () => {
    const block = buildThreadStateBlock(
      baseState({ quotedPackages: [{ code: "ST-LUXURY", at: AT }, { code: "CG-BASIC", at: AT }] }),
    );
    expect(block).toContain("ST-LUXURY, CG-BASIC");
    expect(block).toContain("KHÔNG tự bung lại");
  });
});

// ─── 9 tình huống nghiệm thu (Bước 5) — replay qua ĐÚNG bộ extractor luồng thật ───

const NOW = new Date(2026, 6, 28, 10, 0, 0);
type H = { direction: "incoming" | "outgoing"; message: string };
const sim = (history: H[], quotedCodes: string[] = []) =>
  simulateThreadStateFromHistory(history, { quotedCodes, now: NOW });

describe("simulateThreadStateFromHistory — 9 tình huống nghiệm thu", () => {
  it("1. Khách chưa biết ngày → not_decided, block cấm hỏi lại ngày", () => {
    const s = sim([
      { direction: "outgoing", message: "Anh dự định chụp khi nào ạ?" },
      { direction: "incoming", message: "chưa biết ngày em ơi" },
    ]);
    expect(s.slots.date_status).toBe("not_decided");
    expect(buildThreadStateBlock(s)).toContain("KHÔNG hỏi lại ngày");
  });

  it("2. Khách chỉ tham khảo giá (sau khi bot hỏi ngày) → not_decided + hướng báo giá tham khảo", () => {
    const s = sim([
      { direction: "outgoing", message: "Mình định chụp ngày nào ạ?" },
      { direction: "incoming", message: "em chỉ tham khảo giá trước thôi" },
    ]);
    expect(s.slots.date_status).toBe("not_decided");
    expect(buildThreadStateBlock(s)).toContain("GIÁ THAM KHẢO");
  });

  it("3. Khách đã cho ngày → known + block dùng đúng mốc", () => {
    const s = sim([{ direction: "incoming", message: "bên mình chụp 20/12 nha" }]);
    expect(s.slots.date_status).toBe("known");
    expect(s.slots.event_date).toBe("2026-12-20");
    expect(buildThreadStateBlock(s)).toContain("2026-12-20");
  });

  it("4. Bị hỏi ngày một lần chưa trả lời → block 'ĐÃ HỎI ngày', không lặp lại", () => {
    const s = sim([
      { direction: "outgoing", message: "Anh dự định chụp khi nào ạ?" },
      { direction: "incoming", message: "cho em xem thêm mẫu beauty đi" },
    ]);
    expect(s.askedQuestions).toEqual([{ key: "ask_date", at: "(mô phỏng)", count: 1 }]);
    expect(s.slots.date_status).toBeUndefined();
    expect(buildThreadStateBlock(s)).toContain("ĐÃ HỎI ngày");
  });

  it("5. Khách đổi dịch vụ → intent theo tin MỚI nhất của khách", () => {
    const s = sim([
      { direction: "incoming", message: "em muốn chụp album cưới" },
      { direction: "outgoing", message: "Dạ mình thích tone nào ạ?" },
      { direction: "incoming", message: "à mà cho hỏi thuê váy cưới luôn" },
    ]);
    expect(s.serviceIntent).toBe("rental_outfit");
  });

  it("6. Khách hỏi thêm sau khi ĐÃ nhận bảng giá → block 'ĐÃ BÁO GIÁ', không bung lại", () => {
    const s = sim(
      [
        { direction: "incoming", message: "chụp cổng giá sao em" },
        { direction: "outgoing", message: "Dạ em gửi bảng giá mình xem nha" },
        { direction: "incoming", message: "gói đó gồm những gì vậy" },
      ],
      ["CG-BASIC"],
    );
    expect(s.quotedPackages.map((p) => p.code)).toEqual(["CG-BASIC"]);
    expect(buildThreadStateBlock(s)).toContain("ĐÃ BÁO GIÁ các gói: CG-BASIC");
  });

  it("7. Khách đã nhận ảnh mẫu → sent_assets ghi đủ URL", () => {
    const s = sim([
      { direction: "incoming", message: "cho xem mẫu chụp cổng đi em" },
      { direction: "outgoing", message: "[image:https://cdn/x/a.jpg]" },
      { direction: "outgoing", message: "[image:https://cdn/x/b.jpg]" },
      { direction: "outgoing", message: "Dạ em gửi 2 mẫu gần mood nhất nha" },
    ]);
    expect(s.sentAssets.sample_urls).toEqual(["https://cdn/x/a.jpg", "https://cdn/x/b.jpg"]);
  });

  it("8. 'nhà em 2-3 người' KHÔNG thành ngày (kể cả sau khi bot hỏi ngày)", () => {
    const s = sim([
      { direction: "outgoing", message: "Anh dự định chụp khi nào ạ?" },
      { direction: "incoming", message: "nhà em 2-3 người thôi" },
    ]);
    expect(s.slots.date_status).toBeUndefined();
  });

  it("9. 'bé 3 tháng 10 ngày' KHÔNG thành ngày chụp", () => {
    const s = sim([{ direction: "incoming", message: "bé nhà em được 3 tháng 10 ngày, chụp gói nào" }]);
    expect(s.slots.date_status).toBeUndefined();
    // Intent bảo thủ: câu này chưa đủ tín hiệu nhóm ("bé" không nằm trong FAMILY_RE) → null,
    // Lulu sẽ hỏi lại nhu cầu — đúng hướng an toàn, không đoán bừa.
    expect(s.serviceIntent).toBeNull();
  });
});
