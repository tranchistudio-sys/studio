import { describe, it, expect, vi } from "vitest";
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { planFollowUpFromState } from "./sale-followup-plan";
import type { ThreadState } from "./sale-thread-state";

const st = (patch: Partial<ThreadState>): ThreadState => ({
  facebookUserId: "t", currentStage: "new", previousStage: null, serviceIntent: null,
  customerStatus: "lead", lastAction: null, slots: {}, askedQuestions: [],
  quotedPackages: [], sentAssets: {}, lastUserMessageAt: null, lastBotMessageAt: null,
  version: 0, ...patch,
});

describe("planFollowUpFromState — follow-up CÓ LÝ DO", () => {
  it("không state / khách LOST / đã là customer → null (tôn trọng tuyệt đối)", () => {
    expect(planFollowUpFromState(null)).toBeNull();
    expect(planFollowUpFromState(st({ customerStatus: "lost" }))).toBeNull();
    expect(planFollowUpFromState(st({ slots: { lost_reason: "chot ben khac" } }))).toBeNull();
    expect(planFollowUpFromState(st({ customerStatus: "customer" }))).toBeNull();
  });

  it("đang chờ hỏi chồng → gửi tóm tắt, KHÔNG hỏi kết quả", () => {
    const p = planFollowUpFromState(st({ serviceIntent: "wedding_album", slots: { decision_maker: "partner" } }), "Chị Hoa");
    expect(p?.reasonType).toBe("ask_partner");
    expect(p?.draft).not.toMatch(/nói sao|kết quả|chốt chưa/);
    expect(p?.draft).toContain("tóm tắt");
  });

  it("từng chê giá → bằng chứng giá trị mới, cấm 'chốt chưa'", () => {
    const p = planFollowUpFromState(st({
      serviceIntent: "wedding_album",
      quotedPackages: [{ code: "ST-BASIC", at: "x" }],
      slots: { objections: [{ type: "PRICE_OBJECTION", quote: "mắc quá em", at: "x" }] },
    }));
    expect(p?.reasonType).toBe("price_objection");
    expect(p?.reasonVn).toContain("chê giá");
    expect(p?.draft).not.toMatch(/chốt chưa|suy nghĩ sao/);
  });

  it("có mốc ngày → nhắc mốc nhẹ, không hứa chắc lịch", () => {
    const p = planFollowUpFromState(st({
      serviceIntent: "wedding_gate",
      slots: { date_status: "known", date_text: "cuối tháng 12" },
    }));
    expect(p?.reasonType).toBe("has_event_date");
    expect(p?.draft).toContain("cuối tháng 12");
    expect(p?.draft).not.toMatch(/chắc chắn còn/);
  });

  it("đã báo giá + im lặng → gửi ảnh đúng gu, không hỏi chốt", () => {
    const p = planFollowUpFromState(st({
      serviceIntent: "beauty",
      quotedPackages: [{ code: "BT-1", at: "x" }],
      slots: { style: "Hàn Quốc" },
    }));
    expect(p?.reasonType).toBe("after_quote");
    expect(p?.draft).toContain("Hàn Quốc");
  });

  it("chỉ có nhu cầu → hỏi thăm + giá trị (general_care)", () => {
    const p = planFollowUpFromState(st({ serviceIntent: "family" }));
    expect(p?.reasonType).toBe("general_care");
  });

  it("không đủ căn cứ (không intent, không quote) → null để hệ cũ xử", () => {
    expect(planFollowUpFromState(st({}))).toBeNull();
  });
});
