import { describe, it, expect, vi } from "vitest";
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { getSeedTreeRows } from "./sale-scenario-tree";
import { SEED_SCENARIOS } from "./sale-scenario-seed";

const rows = getSeedTreeRows();
const scenarioKeys = new Set(SEED_SCENARIOS.map((s) => s.key));

describe("Cây kịch bản — skeleton seed", () => {
  it("có đủ 7 chặng ở gốc, đúng thứ tự", () => {
    const stages = rows.filter((r) => r.parentKey === null);
    expect(stages).toHaveLength(7);
    expect(stages.map((s) => s.title)).toEqual([
      "1. Chào hỏi", "2. Tìm hiểu nhu cầu", "3. Tư vấn & Concept",
      "4. Báo giá", "5. Xử lý phân vân", "6. Chốt sale", "7. Sau chốt / chuyển người",
    ]);
  });

  it("node_key duy nhất (không trùng)", () => {
    const keys = rows.map((r) => r.nodeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("mọi leaf trỏ tới scenario CÓ THẬT trong seed (không trỏ trượt)", () => {
    const leaves = rows.filter((r) => r.nodeType === "leaf");
    expect(leaves.length).toBeGreaterThan(10);
    for (const l of leaves) {
      expect(l.scenarioKey, `leaf ${l.nodeKey}`).toBeTruthy();
      expect(scenarioKeys.has(l.scenarioKey!), `leaf trỏ '${l.scenarioKey}' không tồn tại`).toBe(true);
    }
  });

  it("Album cưới có đủ 4 nhánh: Concept / Báo giá / Chốt / Không chốt", () => {
    const children = rows.filter((r) => r.parentKey === "s2-album");
    const titles = children.map((c) => c.title);
    expect(titles).toEqual(expect.arrayContaining(["Tư vấn & Concept", "Báo giá", "Chốt", "Không chốt"]));
    const pricing = children.find((c) => c.nodeType === "pricing");
    expect(pricing?.serviceKey).toBe("wedding_album"); // Báo giá gắn nguồn giá album cưới
  });

  it("mọi node pricing đều có service_key (nguồn giá), KHÔNG có số tiền hard-code", () => {
    const pricing = rows.filter((r) => r.nodeType === "pricing");
    expect(pricing.length).toBeGreaterThanOrEqual(5); // album/phóng sự/gia đình/cổng/beauty
    for (const p of pricing) {
      expect(p.serviceKey, `pricing ${p.nodeKey} thiếu service_key`).toBeTruthy();
      expect(p.scenarioKey).toBeNull();
    }
  });

  it("mọi parent_key (khác null) đều trỏ tới node có thật", () => {
    const keys = new Set(rows.map((r) => r.nodeKey));
    for (const r of rows) if (r.parentKey) expect(keys.has(r.parentKey), `parent '${r.parentKey}' của ${r.nodeKey}`).toBe(true);
  });
});
