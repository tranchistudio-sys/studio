import { describe, it, expect } from "vitest";
import {
  emptyCard, displayCard, summarizeWhen, summarizeNever, verdictInfo, moveItem, statusLabel,
  type ScenarioRecord, type ScenarioLabels, type ScenarioCard,
} from "./scenario-card";

const labels: ScenarioLabels = {
  triggers: { hoi_gia: "hỏi giá", xin_xem_mau: "muốn xem ảnh mẫu", bat_ky: "bất kỳ tin nào" },
  conditions: {
    serviceIntent: { known: "đã rõ nhóm dịch vụ", unknown: "chưa rõ nhóm dịch vụ", any: "-" },
    dateStatus: { known: "đã có ngày", not_decided: "đã nói CHƯA chốt ngày", unset: "chưa nhắc ngày", any: "-" },
    quoted: { yes: "đã được báo giá", no: "chưa được báo giá", any: "-" },
    firstContact: { yes: "là tin đầu", no: "không phải tin đầu", any: "-" },
  },
  actions: {}, forbidden: { hoi_lai_ngay: "hỏi lại ngày chụp", ep_giu_lich: "ép giữ lịch" },
  knowledge: {}, loserReasons: {}, coreForbidden: [],
};

const card = (over?: Partial<ScenarioCard>): ScenarioCard => ({
  ...emptyCard(), name: "Test", triggers: ["hoi_gia"],
  conditions: { serviceIntent: "known", dateStatus: "not_decided", quoted: "any", firstContact: "any" },
  forbiddenExtra: ["hoi_lai_ngay"], ...over,
});

const rec = (over?: Partial<ScenarioRecord>): ScenarioRecord => ({
  id: 1, scenarioKey: "t", sortOrder: 10, status: "active", enabled: true, isCore: false,
  version: 1, card: card(), draftCard: null, runCount: 0, lastRunAt: null, lastTestResult: null,
  createdByName: null, updatedByName: null, createdAt: "", updatedAt: "", ...over,
});

describe("scenario-card helpers", () => {
  it("summarizeWhen ghép trigger + điều kiện thành tiếng Việt", () => {
    const s = summarizeWhen(card(), labels);
    expect(s).toContain("hỏi giá");
    expect(s).toContain("đã rõ nhóm dịch vụ");
    expect(s).toContain("CHƯA chốt ngày");
  });

  it("summarizeWhen thẻ nền bat_ky không điều kiện → 'bất kỳ tin nào'", () => {
    const c = card({ triggers: ["bat_ky"], conditions: { serviceIntent: "any", dateStatus: "any", quoted: "any", firstContact: "any" } });
    expect(summarizeWhen(c, labels)).toBe("bất kỳ tin nào");
  });

  it("summarizeNever chỉ liệt kê cấm bổ sung", () => {
    expect(summarizeNever(card(), labels)).toBe("hỏi lại ngày chụp");
    expect(summarizeNever(card({ forbiddenExtra: [] }), labels)).toBe("");
  });

  it("verdictInfo map PASS/WARN/BLOCK sang nhãn VN", () => {
    expect(verdictInfo("PASS")).toEqual({ label: "Đạt", tone: "ok" });
    expect(verdictInfo("WARN")).toEqual({ label: "Cảnh báo", tone: "warn" });
    expect(verdictInfo("BLOCK")).toEqual({ label: "Bị chặn", tone: "block" });
    expect(verdictInfo(null).tone).toBe("none");
  });

  it("moveItem đổi vị trí, không mutate mảng gốc, index sai → giữ nguyên", () => {
    const a = ["a", "b", "c"];
    expect(moveItem(a, 0, 2)).toEqual(["b", "c", "a"]);
    expect(a).toEqual(["a", "b", "c"]);
    expect(moveItem(a, -1, 2)).toBe(a);
    expect(moveItem(a, 0, 9)).toBe(a);
  });

  it("statusLabel: active / có nháp / lưu trữ", () => {
    expect(statusLabel(rec()).label).toBe("Đang dùng");
    expect(statusLabel(rec({ draftCard: card() })).label).toBe("Có bản nháp");
    expect(statusLabel(rec({ status: "archived" })).label).toBe("Đã lưu trữ");
    expect(statusLabel(rec({ status: "draft", card: null })).label).toBe("Bản nháp");
  });

  it("displayCard ưu tiên bản nháp", () => {
    const d = card({ name: "Nháp" });
    expect(displayCard(rec({ draftCard: d }))?.name).toBe("Nháp");
    expect(displayCard(rec())?.name).toBe("Test");
  });
});
