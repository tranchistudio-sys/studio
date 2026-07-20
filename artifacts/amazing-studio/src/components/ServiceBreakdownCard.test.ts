import { describe, it, expect } from "vitest";
import { renderServiceBreakdownCardHTML } from "./ServiceBreakdownCard";
import { serviceDayTextLines } from "@/lib/service-days";

const money = (n: number) => `${n.toLocaleString("vi-VN")}đ`;

const base = { basePrice: 9_000_000, finalAmount: 9_500_000, formatVND: money, title: "DỊCH VỤ 2: COMBO MAKEUP GOLD" };

describe("renderServiceBreakdownCardHTML — dòng ngày dưới tên dịch vụ (hợp đồng in)", () => {
  it("1 ngày → đúng 1 dòng ngày, y như trước", () => {
    const html = renderServiceBreakdownCardHTML({ ...base, subtitle: "📅 15/10/2026 • 08:00" });
    expect(html).toContain("📅 15/10/2026 • 08:00");
    expect(html.match(/margin-top:2px/g) ?? []).toHaveLength(1);
  });

  it("dịch vụ NHIỀU NGÀY → hiện ĐỦ ngày, mỗi ngày một dòng (bug chủ báo 20/07)", () => {
    const lines = serviceDayTextLines({
      shootDate: "2026-10-15",
      shootTime: "08:00:00",
      occurrences: [{ shootDate: "2026-10-18", shootTime: "08:00:00", label: null }],
    });
    const html = renderServiceBreakdownCardHTML({ ...base, subtitle: lines });
    expect(html).toContain("📅 Ngày 1/2: 15/10/2026 • 08:00");
    expect(html).toContain("📅 Ngày 2/2: 18/10/2026 • 08:00");
    expect(html.match(/margin-top:2px/g) ?? []).toHaveLength(2);
  });

  it("không có ngày → không sinh dòng rỗng", () => {
    expect(renderServiceBreakdownCardHTML({ ...base, subtitle: [] })).not.toContain("margin-top:2px");
    expect(renderServiceBreakdownCardHTML({ ...base, subtitle: null })).not.toContain("margin-top:2px");
    expect(renderServiceBreakdownCardHTML({ ...base, subtitle: ["  "] })).not.toContain("margin-top:2px");
  });

  it("nhãn ngày vẫn được escape (không cho chèn HTML vào hợp đồng)", () => {
    const html = renderServiceBreakdownCardHTML({ ...base, subtitle: ["📅 18/10/2026 — <b>x</b>"] });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});
