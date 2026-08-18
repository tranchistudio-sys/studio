import { describe, it, expect, vi } from "vitest";

/**
 * Giá canonical (Sales Brain V1 mục 6) — test A–E:
 * mock sale-context.auditPackages trả gói giả → sale-pricing chỉ gọi resolveDiscount (nguồn thật).
 * Đổi giá / bật-tắt promo / hết hạn → getEffectivePrice tự phản ánh, KHÔNG cần sửa scenario.
 */

// sale-context (qua importActual) import @workspace/db ở top-level → mock db để không đòi DATABASE_URL.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
// pkgDiscountCfg/groupDiscountCfg là hàm thuần — giữ NGUYÊN (importActual); chỉ thay auditPackages.
vi.mock("./sale-context", async (importActual) => {
  const actual = await importActual<typeof import("./sale-context")>();
  return { ...actual, auditPackages: vi.fn() };
});

import { auditPackages } from "./sale-context";
import { getEffectivePrice, getServicePricePreview, validPricesFor } from "./sale-pricing";

const mockAudit = auditPackages as unknown as ReturnType<typeof vi.fn>;

// Gói giả: 1 nhóm "Album cưới" (khớp keyword wedding_album), 1 gói AL-BASIC.
function setCatalog(opts: { price: number; discEnabled?: boolean; discType?: string; discValue?: number; start?: string | null; end?: string | null }) {
  mockAudit.mockResolvedValue({
    total: 1, excluded: [],
    kept: [{
      id: 1, group_id: 1, group_name: "Album cưới", pkg_name: "Gói cơ bản", price: String(opts.price), code: "AL-BASIC",
      p_d_enabled: opts.discEnabled ?? false, p_d_type: opts.discType ?? null, p_d_value: opts.discValue != null ? String(opts.discValue) : null,
      p_d_start: opts.start ?? null, p_d_end: opts.end ?? null, p_d_name: "Ưu đãi hè", p_d_desc: null,
      g_d_enabled: false, g_d_type: null, g_d_value: null, g_d_start: null, g_d_end: null, g_d_name: null, g_d_desc: null,
      kept: true, reason: "",
    }],
  });
}

const NOW = new Date(2026, 6, 15, 10, 0, 0);

describe("getEffectivePrice / getServicePricePreview — nguồn giá sống", () => {
  it("A. ĐỔI GIÁ trong dữ liệu → giá mới phản ánh ngay (không cần sửa scenario)", async () => {
    setCatalog({ price: 3900000 });
    let p = await getEffectivePrice("wedding_album", "AL-BASIC", NOW);
    expect(p?.effectivePrice).toBe(3900000);
    setCatalog({ price: 4500000 }); // admin đổi giá
    p = await getEffectivePrice("wedding_album", "AL-BASIC", NOW);
    expect(p?.effectivePrice).toBe(4500000);
    expect(p?.basePrice).toBe(4500000);
  });

  it("B. BẬT KHUYẾN MÃI (giảm 20% đang hiệu lực) → dùng giá khuyến mãi", async () => {
    setCatalog({ price: 5000000, discEnabled: true, discType: "percent", discValue: 20, start: "2026-07-01", end: "2026-07-31" });
    const p = await getEffectivePrice("wedding_album", "AL-BASIC", NOW);
    expect(p?.promoActive).toBe(true);
    expect(p?.effectivePrice).toBe(4000000); // 5tr - 20%
    expect(p?.basePrice).toBe(5000000);
    expect(p?.promoEnd).toContain("2026-07-31");
  });

  it("C. HẾT HẠN khuyến mãi → tự quay lại giá thường", async () => {
    setCatalog({ price: 5000000, discEnabled: true, discType: "percent", discValue: 20, start: "2026-06-01", end: "2026-06-30" });
    const p = await getEffectivePrice("wedding_album", "AL-BASIC", NOW); // NOW = 15/07 > 30/06
    expect(p?.promoActive).toBe(false);
    expect(p?.effectivePrice).toBe(5000000);
  });

  it("C2. CHƯA tới ngày bắt đầu (scheduled) → cũng dùng giá thường", async () => {
    setCatalog({ price: 5000000, discEnabled: true, discType: "percent", discValue: 20, start: "2026-08-01", end: "2026-08-31" });
    const p = await getEffectivePrice("wedding_album", "AL-BASIC", NOW); // NOW < 01/08
    expect(p?.promoActive).toBe(false);
    expect(p?.effectivePrice).toBe(5000000);
  });

  it("E. validPricesFor chứa giá gốc + giá KM + mức giảm — số ngoài tập = validator BLOCK", async () => {
    setCatalog({ price: 5000000, discEnabled: true, discType: "fixed", discValue: 500000, start: null, end: null });
    const set = await validPricesFor("wedding_album", NOW);
    expect(set.has(5000000)).toBe(true);   // giá gốc
    expect(set.has(4500000)).toBe(true);   // giá sau giảm
    expect(set.has(500000)).toBe(true);    // mức giảm (Lulu được nói "giảm 500k")
    expect(set.has(3333333)).toBe(false);  // giá bịa → không hợp lệ → validator sẽ chặn
  });

  it("service_key không khớp keyword nào → trả TẤT CẢ nhóm (admin tự chọn nguồn)", async () => {
    setCatalog({ price: 1000000 });
    const groups = await getServicePricePreview("khong_ton_tai", { now: NOW });
    expect(groups.length).toBeGreaterThan(0);
  });

  it("fail-soft: auditPackages throw → trả rỗng, KHÔNG ném", async () => {
    mockAudit.mockRejectedValueOnce(new Error("db down"));
    expect(await getServicePricePreview("wedding_album", { now: NOW })).toEqual([]);
  });
});
