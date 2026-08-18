import { describe, it, expect } from "vitest";
import { SEED_SCENARIOS } from "./sale-scenario-seed";
import { compileCard, validateEnsemble } from "./sale-scenario-compiler";

// 12+ thẻ seed là NỀN cho chủ studio — bắt buộc sạch 100% trước khi vào DB.

describe("Seed 12 thẻ kịch bản mẫu", () => {
  it("đủ 12 tình huống bắt buộc (spec mục V)", () => {
    const keys = SEED_SCENARIOS.map((s) => s.key);
    for (const need of [
      "chao-hoi-moi", "chua-ro-dich-vu", "hoi-gia-chua-ngay", "hoi-gia-co-ngay",
      "xem-anh-mau", "hoi-chi-tiet-goi", "phan-van", "che-gia-cao",
      "xin-giam-gia", "chon-duoc-goi", "giu-lich-coc", "gap-nguoi-that",
    ]) {
      expect(keys, `thiếu thẻ '${need}'`).toContain(need);
    }
    expect(SEED_SCENARIOS.length).toBeGreaterThanOrEqual(12);
  });

  it("key duy nhất, không trùng", () => {
    const keys = SEED_SCENARIOS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  for (const s of SEED_SCENARIOS) {
    it(`thẻ '${s.key}' qua compiler sạch (không vi phạm luật lõi)`, () => {
      const r = compileCard(s.card);
      expect(r.errors, JSON.stringify(r.errors, null, 2)).toHaveLength(0);
      expect(r.card.name).toBeTruthy();
      expect(r.card.triggers.length).toBeGreaterThan(0);
      expect(r.card.guidance.length).toBeGreaterThan(20); // nội dung thật, không sơ sài
      expect(r.card.closingLine).toBeTruthy();
    });
  }

  it("cả bộ hợp lệ: mọi chuyển tiếp trỏ tới thẻ có thật, không vòng lặp kẹt", () => {
    const r = validateEnsemble(SEED_SCENARIOS.map((s) => ({ key: s.key, card: s.card })));
    expect(r.errors, JSON.stringify(r.errors, null, 2)).toHaveLength(0);
  });

  it("thẻ lõi an toàn được đánh dấu is_core (gặp người thật / xin giảm / giữ lịch-cọc)", () => {
    const coreKeys = SEED_SCENARIOS.filter((s) => s.isCore).map((s) => s.key);
    expect(coreKeys).toEqual(expect.arrayContaining(["gap-nguoi-that", "xin-giam-gia", "giu-lich-coc"]));
  });
});
