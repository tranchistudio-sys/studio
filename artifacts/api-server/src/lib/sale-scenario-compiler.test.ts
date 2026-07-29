import { describe, it, expect } from "vitest";
import { compileCard, validateEnsemble, scanGuidanceViolations } from "./sale-scenario-compiler";
import type { ScenarioCard } from "./sale-scenario-types";

// Compiler thuần — không DB → không cần mock.

const okCard = (over?: Partial<ScenarioCard>): ScenarioCard => ({
  name: "Thẻ test", description: "",
  triggers: ["hoi_gia"],
  conditions: { serviceIntent: "known", dateStatus: "not_decided", quoted: "any", firstContact: "any" },
  requiredSlots: ["service_intent"],
  primaryAction: "bao_gia_tham_khao",
  guidance: "Báo giá tham khảo đúng nhóm, nhẹ nhàng.",
  forbiddenExtra: ["hoi_lai_ngay"],
  knowledge: ["bang_gia"],
  closingLine: "Khi có ngày em xác nhận lại nha.",
  exitConditions: ["khách cho ngày"],
  nextScenarios: [],
  ...over,
});

describe("compileCard — chuẩn hoá + chặn thẻ hỏng", () => {
  it("thẻ hợp lệ → ok", () => {
    const r = compileCard(okCard());
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("thiếu tên → lỗi VN có gợi ý", () => {
    const r = compileCard(okCard({ name: "" }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain("tên");
    expect(r.errors[0].suggest).toBeTruthy();
  });

  it("trigger rỗng → chặn (Lulu không biết lúc nào dùng thẻ)", () => {
    const r = compileCard(okCard({ triggers: [] }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "triggers")).toBe(true);
  });

  it("trigger/forbidden/knowledge key lạ → bị lọc bỏ (không crash)", () => {
    const r = compileCard(okCard({
      triggers: ["hoi_gia", "hack_key" as never],
      forbiddenExtra: ["hoi_lai_ngay", "xxx" as never],
      knowledge: ["bang_gia", "yyy" as never],
    }));
    expect(r.card.triggers).toEqual(["hoi_gia"]);
    expect(r.card.forbiddenExtra).toEqual(["hoi_lai_ngay"]);
    expect(r.card.knowledge).toEqual(["bang_gia"]);
  });

  it("core forbidden (tu_giam_gia…) KHÔNG lưu vào extra — luôn tự áp từ code", () => {
    const r = compileCard(okCard({ forbiddenExtra: ["tu_giam_gia" as never, "hoi_lai_ngay"] }));
    expect(r.card.forbiddenExtra).toEqual(["hoi_lai_ngay"]);
  });

  it("HỎI NGÀY khi điều kiện 'đã nói chưa chốt ngày' → chặn + gợi ý sửa", () => {
    const r = compileCard(okCard({ primaryAction: "hoi_ngay" }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain("chưa chốt ngày");
    expect(r.errors[0].suggest).toContain("báo giá tham khảo");
  });

  it("HỎI NGÀY khi khách ĐÃ CHO ngày → chặn", () => {
    const r = compileCard(okCard({
      primaryAction: "hoi_ngay",
      conditions: { serviceIntent: "known", dateStatus: "known", quoted: "any", firstContact: "any" },
    }));
    expect(r.ok).toBe(false);
  });

  it("BÁO GIÁ CHÍNH THỨC mà chưa yêu cầu có ngày → chặn (không gửi giá thiếu căn cứ)", () => {
    const r = compileCard(okCard({ primaryAction: "bao_gia_chinh_thuc" }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain("ĐÃ CÓ ngày");
  });

  it("gửi giá/ảnh khi điều kiện CHƯA RÕ nhóm → chặn", () => {
    const r = compileCard(okCard({
      conditions: { serviceIntent: "unknown", dateStatus: "any", quoted: "any", firstContact: "any" },
      requiredSlots: [],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain("CHƯA RÕ nhóm");
  });

  it("mâu thuẫn action↔cấm (vừa hỏi ngày vừa cấm hỏi ngày) → chặn", () => {
    const r = compileCard(okCard({
      primaryAction: "hoi_ngay",
      conditions: { serviceIntent: "known", dateStatus: "unset", quoted: "any", firstContact: "any" },
      forbiddenExtra: ["hoi_lai_ngay"],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "forbiddenExtra")).toBe(true);
  });
});

describe("scanGuidanceViolations — quét lời dẫn vi phạm luật lõi", () => {
  it("tự giảm giá ('giảm 10% cho khách') → chặn với gợi ý VN", () => {
    const issues = scanGuidanceViolations("Nếu khách chê mắc thì giảm 10% cho khách");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain("tự giảm giá");
    expect(issues[0].suggest).toContain("quản lý");
  });

  it("con số tiền cứng trong thẻ ('gói này 3.500.000') → chặn", () => {
    const issues = scanGuidanceViolations("Báo khách gói này 3.500.000 nha");
    expect(issues.some((i) => i.message.includes("con số tiền"))).toBe(true);
  });

  it("tự chốt cọc ('xác nhận đã cọc') → chặn", () => {
    const issues = scanGuidanceViolations("Khách chuyển tiền thì xác nhận đã cọc luôn");
    expect(issues.some((i) => i.message.includes("cọc"))).toBe(true);
  });

  it("lời dẫn sạch → không vi phạm", () => {
    expect(scanGuidanceViolations("Báo giá tham khảo đúng nhóm, gợi ý xem ảnh mẫu, hẹn kiểm tra lịch.")).toHaveLength(0);
  });
});

describe("validateEnsemble — tham chiếu chuyển tiếp + vòng lặp", () => {
  it("next_scenario không tồn tại → chặn", () => {
    const r = validateEnsemble([
      { key: "a", card: okCard({ nextScenarios: [{ whenVn: "x", scenarioKey: "khong-ton-tai" }] }) },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain("không tồn tại");
  });

  it("tự chuyển sang chính nó → chặn", () => {
    const r = validateEnsemble([
      { key: "a", card: okCard({ nextScenarios: [{ whenVn: "x", scenarioKey: "a" }] }) },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain("chính nó");
  });

  it("vòng lặp KHÔNG có điều kiện thoát → chặn", () => {
    const r = validateEnsemble([
      { key: "a", card: okCard({ exitConditions: [], nextScenarios: [{ whenVn: "x", scenarioKey: "b" }] }) },
      { key: "b", card: okCard({ exitConditions: [], nextScenarios: [{ whenVn: "y", scenarioKey: "a" }] }) },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("vòng lặp"))).toBe(true);
  });

  it("vòng lặp CÓ điều kiện thoát → cho phép (flow sale quay lại là bình thường)", () => {
    const r = validateEnsemble([
      { key: "a", card: okCard({ exitConditions: ["khách chốt"], nextScenarios: [{ whenVn: "x", scenarioKey: "b" }] }) },
      { key: "b", card: okCard({ exitConditions: [], nextScenarios: [{ whenVn: "y", scenarioKey: "a" }] }) },
    ]);
    expect(r.ok).toBe(true);
  });
});
