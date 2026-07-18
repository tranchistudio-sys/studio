import { describe, it, expect } from "vitest";
import {
  normalizePhoneE164, splitName, matchesDemandFilter, demandGroupLabel,
  buildMetaExport, metaRowsToCsv, metaExportFilename, META_CSV_COLUMNS,
  type MetaExportInput,
} from "./meta-export";

// Helper dựng input khách nhanh gọn.
function cust(p: Partial<MetaExportInput>): MetaExportInput {
  return {
    id: p.id ?? 1, name: p.name ?? "Test",
    phone: p.phone ?? "0392817079", value: p.value ?? 0,
    countableBookings: p.countableBookings ?? 0, demandGroups: p.demandGroups ?? [],
  };
}

// ── TEST 1: Chuẩn hoá đầy đủ các dạng số Việt Nam ───────────────────────────────
describe("1) normalizePhoneE164 — mọi dạng SĐT VN → +84", () => {
  it.each([
    ["0392817079", "+84392817079"],
    ["84392817079", "+84392817079"],
    ["+84392817079", "+84392817079"],
    ["+84 39 281.70-79", "+84392817079"],
    ["039-281-7079", "+84392817079"],
    ["  0392817079  ", "+84392817079"],
    ["392817079", "+84392817079"],       // nhập thiếu 0
    ["0902345678", "+84902345678"],
    ["0782345678", "+84782345678"],
    ["0582345678", "+84582345678"],
  ])("%s → %s", (input, expected) => {
    expect(normalizePhoneE164(input)).toBe(expected);
  });
});

// ── TEST 2: Loại số thiếu/sai ───────────────────────────────────────────────────
describe("2) normalizePhoneE164 — số thiếu/sai → null (không xuất)", () => {
  it.each([
    [null], [undefined], [""], ["   "], ["0"], ["000"], ["chưa có"], ["abc"],
    ["12345"],            // quá ngắn
    ["0123456789"],       // đầu số 1 không phải di động
    ["0292817079"],       // đầu 2 không phải di động (cố định)
    ["03928170799999"],   // quá dài
    ["0276382200"],       // cố định Tây Ninh (10 số, national 10) → loại
  ])("%s → null", (input) => {
    expect(normalizePhoneE164(input as string)).toBeNull();
  });
});

// ── TEST 3: Loại trùng sau chuẩn hoá ────────────────────────────────────────────
describe("3) buildMetaExport — gộp trùng theo SĐT đã chuẩn hoá", () => {
  it("3 khách cùng số ở 3 dạng khác nhau → 1 dòng, giữ value lớn nhất", () => {
    const input = [
      cust({ id: 1, phone: "0392817079", value: 1_000_000 }),
      cust({ id: 2, phone: "84392817079", value: 5_000_000 }),
      cust({ id: 3, phone: "+84 39 281 7079", value: 2_000_000 }),
    ];
    const { rows, stats } = buildMetaExport(input, { audience: "all" });
    expect(rows).toHaveLength(1);
    expect(stats.duplicatesMerged).toBe(2);
    expect(rows[0].phone).toBe("+84392817079");
    expect(rows[0].value).toBe(5_000_000);       // giữ bản value lớn nhất
    expect(rows[0].customerId).toBe("2");        // id (PK) duy nhất, KHÔNG dùng customCode
  });
});

// ── TEST 4: Bộ lọc Cưới/Beauty/Cả hai đúng ──────────────────────────────────────
describe("4) matchesDemandFilter — Cưới/Beauty/Cả hai", () => {
  const W = ["wedding"] as const, B = ["beauty"] as const, WB = ["wedding", "beauty"] as const, N = [] as const;
  it("filter rỗng → mọi khách", () => {
    for (const g of [W, B, WB, N]) expect(matchesDemandFilter([...g], "")).toBe(true);
  });
  it("wedding → chỉ khách có Cưới (kể cả cả hai)", () => {
    expect(matchesDemandFilter([...W], "wedding")).toBe(true);
    expect(matchesDemandFilter([...WB], "wedding")).toBe(true);
    expect(matchesDemandFilter([...B], "wedding")).toBe(false);
    expect(matchesDemandFilter([...N], "wedding")).toBe(false);
  });
  it("beauty → chỉ khách có Beauty (kể cả cả hai)", () => {
    expect(matchesDemandFilter([...B], "beauty")).toBe(true);
    expect(matchesDemandFilter([...WB], "beauty")).toBe(true);
    expect(matchesDemandFilter([...W], "beauty")).toBe(false);
  });
  it("both → chỉ khách có CẢ HAI", () => {
    expect(matchesDemandFilter([...WB], "both")).toBe(true);
    expect(matchesDemandFilter([...W], "both")).toBe(false);
    expect(matchesDemandFilter([...B], "both")).toBe(false);
  });
});

// ── TEST 5: Loại temp_quote/cancelled/deleted/draft (cơ chế: đơn không-countable) ─
// Đơn temp_quote/cancelled/deleted/draft KHÔNG được engine tính countable → khách chỉ
// có loại đơn này sẽ có countableBookings=0 & value=0, nên bị loại khỏi audience
// "chỉ khách có đơn hợp lệ" (và không đóng góp value). (Quy tắc countable enforced ở
// SQL revenueCountableSql — đã test riêng; ở đây kiểm cơ chế audience dùng số đó.)
describe("5) audience 'with_orders' loại khách không có đơn hợp lệ", () => {
  it("khách countableBookings=0 (chỉ temp_quote/hủy/nháp) bị loại", () => {
    const input = [
      cust({ id: 1, phone: "0392817079", countableBookings: 2, value: 3_000_000 }),
      cust({ id: 2, phone: "0902345678", countableBookings: 0, value: 0 }),
    ];
    const all = buildMetaExport(input, { audience: "all" });
    expect(all.rows).toHaveLength(2);
    const withOrders = buildMetaExport(input, { audience: "with_orders" });
    expect(withOrders.rows.map((r) => r.customerId)).toEqual(["1"]);
    expect(withOrders.stats.excludedByAudience).toBe(1);
  });
  it("audience 'min_value' loại khách dưới ngưỡng", () => {
    const input = [
      cust({ id: 1, phone: "0392817079", value: 10_000_000 }),
      cust({ id: 2, phone: "0902345678", value: 1_000_000 }),
    ];
    const r = buildMetaExport(input, { audience: "min_value", minValue: 5_000_000 });
    expect(r.rows.map((x) => x.customerId)).toEqual(["1"]);
  });
});

// ── TEST 6: CSV mở đúng Excel, không lỗi dấu tiếng Việt ──────────────────────────
describe("6) metaRowsToCsv — UTF-8 BOM + CRLF + tiếng Việt nguyên vẹn", () => {
  it("có BOM, xuống dòng CRLF, giữ dấu tiếng Việt", () => {
    const input = [cust({ id: 1, name: "Nguyễn Thanh Thảo", phone: "0392817079", value: 1234567, demandGroups: ["wedding"] })];
    const { rows } = buildMetaExport(input, { audience: "all" });
    const csv = metaRowsToCsv(rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff);        // BOM
    expect(csv).toContain("\r\n");                  // CRLF
    expect(csv).toContain("Thảo");                  // dấu tiếng Việt còn nguyên
    expect(csv).toContain("Nguyễn Thanh");
  });
});

// ── TEST 7: Không xuất dữ liệu nội bộ ngoài danh sách cột ────────────────────────
describe("7) CSV chỉ đúng 9 cột, không rò dữ liệu nội bộ", () => {
  it("header đúng thứ tự cột yêu cầu; mỗi dòng đúng 9 trường; không có nợ/ghi chú/địa chỉ", () => {
    expect([...META_CSV_COLUMNS]).toEqual(["phone", "fn", "ln", "ct", "st", "country", "value", "customer_id", "demand_group"]);
    const input = [cust({ id: 42, name: "Test Khach", phone: "0392817079", value: 5_000_000, demandGroups: ["beauty"] })];
    const csv = metaRowsToCsv(buildMetaExport(input, { audience: "all" }).rows);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("phone,fn,ln,ct,st,country,value,customer_id,demand_group");
    expect(lines[1].split(",")).toHaveLength(9);
    expect(lines[1]).toContain(",42,");         // customer_id = id numeric duy nhất
    // Không được xuất khái niệm nội bộ:
    for (const forbidden of ["notes", "debt", "công nợ", "address", "địa chỉ", "internal"]) {
      expect(csv.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
  it("chặn CSV formula-injection ở tên khách", () => {
    const input = [cust({ id: 1, name: "=CMD()|danger", phone: "0392817079" })];
    const csv = metaRowsToCsv(buildMetaExport(input, { audience: "all" }).rows);
    expect(csv).toContain("'=CMD()|danger"); // tiền tố ' để Excel coi là chữ
  });
});

// ── Phụ trợ: splitName, demandGroupLabel, filename ──────────────────────────────
describe("splitName — tách hợp lý, không mất tên", () => {
  it.each([
    ["Nguyễn Thanh Thảo", { fn: "Thảo", ln: "Nguyễn Thanh" }],
    ["chang chang", { fn: "chang", ln: "chang" }],
    ["Thảo", { fn: "Thảo", ln: "" }],
    ["Nguyen hanh dung - đối tac", { fn: "Nguyen hanh dung - đối tac", ln: "" }], // có '-' → không tách
    ["Áo cưới 123", { fn: "Áo cưới 123", ln: "" }],                                // có số → không tách
    ["", { fn: "", ln: "" }],
  ])("%s", (input, expected) => {
    expect(splitName(input)).toEqual(expected);
  });
});

describe("demandGroupLabel", () => {
  it.each([
    [["wedding"], "Wedding"],
    [["beauty"], "Beauty"],
    [["wedding", "beauty"], "Wedding|Beauty"],
    [[], ""],
  ] as const)("%j → %s", (g, label) => {
    expect(demandGroupLabel([...g])).toBe(label);
  });
});

describe("metaExportFilename", () => {
  it("theo ngày, đúng format", () => {
    expect(metaExportFilename("2026-07-18")).toBe("amazing-studio-meta-customers-2026-07-18.csv");
    expect(metaExportFilename(new Date("2026-07-18T10:00:00Z"))).toBe("amazing-studio-meta-customers-2026-07-18.csv");
  });
});
