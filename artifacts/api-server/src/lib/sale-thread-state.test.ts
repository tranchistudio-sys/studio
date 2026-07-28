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
