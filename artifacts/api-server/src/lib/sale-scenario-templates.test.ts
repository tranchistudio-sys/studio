import { describe, it, expect } from "vitest";
import { SERVICE_TEMPLATES, GREETING_TEMPLATES } from "./sale-scenario-templates";
import { SERVICE_STEPS, GREETING_SITUATIONS, scriptHasHardcodedPrice } from "./sale-scenario-steps";

/**
 * Template kịch bản mặc định — LUẬT AN TOÀN (Part 3/9):
 * FACT (giá/tên gói/nội dung/ưu đãi) LUÔN dùng token, KHÔNG số cứng. Không tự giảm giá.
 */
describe("sale-scenario-templates", () => {
  const allRows = [
    ...Object.entries(SERVICE_TEMPLATES),
    ...Object.entries(GREETING_TEMPLATES),
  ].flatMap(([key, rows]) => rows.map((r) => ({ key, ...r })));

  it("KHÔNG dòng nào chứa số tiền cứng — phải dùng token", () => {
    for (const r of allRows) {
      expect(scriptHasHardcodedPrice(r.idealResponse), `${r.key}: ${r.idealResponse.slice(0, 60)}`).toBe(false);
      expect(scriptHasHardcodedPrice(r.customerText), `${r.key} (khách): ${r.customerText.slice(0, 60)}`).toBe(false);
    }
  });

  it("BÁO GIÁ dùng {{PRICE}} + {{PACKAGE_NAME}} + {{PACKAGE_CONTENT}} + {{PROMOTION}}", () => {
    const hoiGia = (SERVICE_TEMPLATES["hoi-gia"] ?? []).map((r) => r.idealResponse).join(" ");
    expect(hoiGia).toContain("{{PRICE}}");
    expect(hoiGia).toContain("{{PACKAGE_NAME}}");
    expect((SERVICE_TEMPLATES["goi-gom-gi"] ?? []).map((r) => r.idealResponse).join(" ")).toContain("{{PACKAGE_CONTENT}}");
    expect((SERVICE_TEMPLATES["hoi-uu-dai"] ?? []).map((r) => r.idealResponse).join(" ")).toContain("{{PROMOTION}}");
  });

  it("CG-LUXURY: báo giá KHÔNG chứa 5.900.000 — dùng {{PRICE}} (giá lấy realtime)", () => {
    const bao = [...(SERVICE_TEMPLATES["hoi-gia"] ?? []), ...(SERVICE_TEMPLATES["goi-gom-gi"] ?? [])]
      .map((r) => r.idealResponse).join(" ");
    expect(bao).not.toContain("5.900.000");
    expect(bao).not.toContain("5900000");
    expect(bao).toContain("{{PRICE}}");
  });

  it("XIN GIẢM: chuyển người phụ trách, TUYỆT ĐỐI không tự giảm", () => {
    const xg = (SERVICE_TEMPLATES["xin-giam"] ?? []).map((r) => r.idealResponse).join(" ").toLowerCase();
    expect(xg).toContain("chuyển");
    expect(xg).not.toMatch(/em giảm|giảm cho mình|bớt cho/);
  });

  it("mọi TÌNH HUỐNG trong cây đều có template (không sót key)", () => {
    const missing: string[] = [];
    for (const step of SERVICE_STEPS) {
      for (const s of step.situations) {
        if (!(SERVICE_TEMPLATES[s.key]?.length)) missing.push(`${step.key}/${s.key}`);
      }
    }
    for (const s of GREETING_SITUATIONS) {
      if (!(GREETING_TEMPLATES[s.key]?.length)) missing.push(`greeting/${s.key}`);
    }
    expect(missing).toEqual([]);
  });

  it("không có customerText TRÙNG NHAU giữa các tình huống (chống thư viện rác)", () => {
    const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").trim();
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const r of allRows) {
      const n = norm(r.customerText);
      if (!n) continue;
      const prev = seen.get(n);
      if (prev && prev !== r.key) dups.push(`"${r.customerText.slice(0, 40)}" ở cả ${prev} và ${r.key}`);
      else seen.set(n, r.key);
    }
    expect(dups).toEqual([]);
  });

  it("mỗi tình huống có ≥2 biến thể (coverage sâu, không phải 1 câu demo)", () => {
    const thin: string[] = [];
    for (const [k, rows] of Object.entries(SERVICE_TEMPLATES)) if (rows.length < 2) thin.push(`service/${k}(${rows.length})`);
    for (const [k, rows] of Object.entries(GREETING_TEMPLATES)) if (rows.length < 2) thin.push(`greeting/${k}(${rows.length})`);
    expect(thin).toEqual([]);
  });
});
