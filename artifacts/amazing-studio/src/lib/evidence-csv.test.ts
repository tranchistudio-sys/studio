/**
 * Test file "Excel" của Bằng chứng số liệu: tổng Excel tự cộng == card total,
 * trạng thái KHỚP/LỆCH đúng, escape CSV an toàn. (Test #8 + #9 phía client
 * trong spec chủ studio 17/07.)
 */
import { describe, it, expect } from "vitest";
import {
  buildEvidenceCsv, evidenceCsvFilename, reconcile, sumFromRows,
  type EvidenceResponse, type EvidenceRow,
} from "./evidence-csv";

function mkRow(amount: number, over: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    date: "2026-02-06", code: "DH0001", name: "Khách A", kind: "Cọc",
    detail: null, status: "active", by: null, amount,
    bookingId: 1, paymentId: 1, expenseId: null, ...over,
  };
}

function mkData(over: Partial<EvidenceResponse> = {}): EvidenceResponse {
  return {
    metric: "collected",
    from: "2026-02-01",
    to: "2026-02-28",
    formula: "Đã thu = Σ phiếu thu hợp lệ trong kỳ",
    scopeNote: "scope test",
    notes: [],
    groups: [
      { key: "payments", label: "Phiếu thu", sign: 1, rows: [mkRow(5_000_000), mkRow(2_000_000)], subtotal: 7_000_000 },
    ],
    detailTotal: 7_000_000,
    cardTotal: 7_000_000,
    reconciliationDelta: 0,
    rowCount: 2,
    ...over,
  };
}

/**
 * Parse ngược file CSV ĐÚNG NHƯ EXCEL THẬT: Excel bỏ BOM rồi coi MỖI dòng vật lý
 * là một hàng sheet (hàng 1 = dòng đầu file) — vì vậy file KHÔNG được chứa dòng
 * `sep=` (Excel nuốt dòng đó làm mọi hàng dồn lên 1, vùng =SUM lệch 1 dòng).
 * Hàm này đánh số dòng theo đúng quy tắc đó, độc lập với cách builder đếm.
 */
function excelSelfSum(csv: string): { sumRange: number; declaredDetail: number; declaredCard: number; status: string } {
  expect(csv.startsWith("﻿")).toBe(true);          // BOM — tiếng Việt không vỡ
  const lines = csv.replace(/^﻿/, "").split("\r\n");
  expect(lines[0]!.startsWith("sep=")).toBe(false); // Excel row 1 phải là dòng tiêu đề thật
  const sumLine = lines.find(l => l.startsWith("TỔNG CHI TIẾT (Excel tự cộng)"))!;
  const m = sumLine.match(/=SUM\(K(\d+):K(\d+)\)/);
  let sumRange = 0;
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    for (let ln = a; ln <= b; ln++) {
      // dòng thứ ln (1-based) — cột K = ô thứ 11; parse CSV tôn trọng dấu ngoặc kép
      const cells = splitCsv(lines[ln - 1]);
      sumRange += Number(cells[10] ?? 0);
    }
  } else {
    sumRange = Number(splitCsv(sumLine)[10] ?? 0); // trường hợp không có dòng dữ liệu → literal 0
  }
  const detailLine = lines.find(l => l.startsWith("TỔNG CHI TIẾT (detailTotal)"))!;
  const cardLine = lines.find(l => l.startsWith("SỐ TRÊN Ô"))!;
  const statusLine = lines.find(l => l.startsWith("TRẠNG THÁI"))!;
  return {
    sumRange,
    declaredDetail: Number(splitCsv(detailLine)[10]),
    declaredCard: Number(splitCsv(cardLine)[10]),
    status: splitCsv(statusLine)[10] ?? "",
  };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

describe("reconcile — so chính xác từng đồng", () => {
  it("khớp tuyệt đối → match", () => {
    expect(reconcile(7_000_000, 7_000_000).match).toBe(true);
  });
  it("lệch đúng 1 đồng → KHÔNG match, delta = 1", () => {
    const r = reconcile(7_000_001, 7_000_000);
    expect(r.match).toBe(false);
    expect(r.delta).toBe(1);
  });
  it("nhiễu float (1e-9) → vẫn match (không phải làm tròn — dưới 1 đồng 1000 lần)", () => {
    expect(reconcile(7_000_000.000000001, 7_000_000).match).toBe(true);
  });
});

describe("sumFromRows — tự cộng từng dòng, áp dấu nhóm", () => {
  it("nhóm trừ (sign -1) được trừ khỏi tổng", () => {
    const groups = [
      { key: "a", label: "Thu", sign: 1 as const, rows: [mkRow(10)], subtotal: 10 },
      { key: "b", label: "Chi", sign: -1 as const, rows: [mkRow(3), mkRow(4)], subtotal: 7 },
    ];
    expect(sumFromRows(groups)).toBe(3);
  });
});

describe("buildEvidenceCsv — Excel tự cộng lại đúng", () => {
  it("tổng vùng =SUM == detailTotal == cardTotal; trạng thái KHỚP", () => {
    const csv = buildEvidenceCsv(mkData(), { metricLabel: "Đã thu", cardTotalOnTile: 7_000_000 });
    // TUYỆT ĐỐI không có dòng sep= — Excel nuốt nó là lệch vùng =SUM + vỡ BOM tiếng Việt.
    expect(csv).not.toContain("sep=");
    const r = excelSelfSum(csv);
    expect(r.sumRange).toBe(7_000_000);
    expect(r.declaredDetail).toBe(7_000_000);
    expect(r.declaredCard).toBe(7_000_000);
    expect(r.status).toBe("KHỚP CHÍNH XÁC");
  });

  it("card trên ô lệch 1 đồng → trạng thái LỆCH, không che", () => {
    const csv = buildEvidenceCsv(mkData(), { metricLabel: "Đã thu", cardTotalOnTile: 7_000_001 });
    const r = excelSelfSum(csv);
    expect(r.status).toContain("LỆCH");
    expect(r.status).toContain("-1");
  });

  it("nhóm trừ: cột áp dấu ra số âm, =SUM ra đúng hiệu", () => {
    const data = mkData({
      metric: "realProfit",
      groups: [
        { key: "payments", label: "Thu", sign: 1, rows: [mkRow(10_000_000)], subtotal: 10_000_000 },
        { key: "cast", label: "Chi cast", sign: -1, rows: [mkRow(4_000_000, { kind: "Cast" })], subtotal: 4_000_000 },
      ],
      detailTotal: 6_000_000,
      cardTotal: 6_000_000,
    });
    const csv = buildEvidenceCsv(data, { metricLabel: "Lợi nhuận thực", cardTotalOnTile: 6_000_000 });
    const r = excelSelfSum(csv);
    expect(r.sumRange).toBe(6_000_000);
    expect(r.status).toBe("KHỚP CHÍNH XÁC");
  });

  it("escape: tên chứa dấu phẩy/ngoặc kép không phá cột", () => {
    const data = mkData({
      groups: [{
        key: "payments", label: "Phiếu thu", sign: 1,
        rows: [mkRow(1_000, { name: 'Khách "VIP", Hà Nội', detail: "ghi chú, có phẩy" })],
        subtotal: 1_000,
      }],
      detailTotal: 1_000, cardTotal: 1_000,
    });
    const csv = buildEvidenceCsv(data, { metricLabel: "Đã thu", cardTotalOnTile: 1_000 });
    const r = excelSelfSum(csv);
    expect(r.sumRange).toBe(1_000);
  });

  it("không có dòng nào → tổng 0, không sinh =SUM sai vùng", () => {
    const data = mkData({ groups: [{ key: "payments", label: "Phiếu thu", sign: 1, rows: [], subtotal: 0 }], detailTotal: 0, cardTotal: 0, rowCount: 0 });
    const csv = buildEvidenceCsv(data, { metricLabel: "Đã thu", cardTotalOnTile: 0 });
    const r = excelSelfSum(csv);
    expect(r.sumRange).toBe(0);
    expect(r.status).toBe("KHỚP CHÍNH XÁC");
  });

  it("tên file an toàn", () => {
    expect(evidenceCsvFilename("collected", "2026-02-01", "2026-02-28")).toBe("bang-chung-collected-2026-02-01_2026-02-28.csv");
  });

  it("nợ pro-rata LẺ (3 con chia 1M): Excel cộng cột K == dòng TỔNG CHI TIẾT, phần chênh làm tròn ghi rõ", () => {
    // Gia đình 3 con net 3M/3M/3M, phiếu 1M ở cha → mỗi con nợ 2.666.666,666…đ
    const debt = 3_000_000 - 1_000_000 / 3;
    const data = mkData({
      metric: "remaining",
      groups: [{
        key: "receivables", label: "Đơn còn nợ", sign: 1,
        rows: [mkRow(debt), mkRow(debt, { code: "DH0002" }), mkRow(debt, { code: "DH0003" })],
        subtotal: debt * 3,
      }],
      detailTotal: debt * 3,
      cardTotal: 8_000_000,
    });
    const csv = buildEvidenceCsv(data, { metricLabel: "Còn nợ", cardTotalOnTile: 8_000_000 });
    const r = excelSelfSum(csv);
    // Bất biến CỐT LÕI của file: Excel tự cộng cột K phải RA ĐÚNG dòng TỔNG CHI TIẾT
    // (từng ô đã làm tròn 0,01đ nhất quán — không còn cảnh Excel ra số khác dòng tổng).
    expect(Math.abs(r.sumRange - r.declaredDetail)).toBeLessThan(0.001);
    // Chênh làm tròn hiển thị (3 × 2/3 xu) được ghi RÕ ra dòng riêng — không che.
    expect(csv).toContain("chênh do làm tròn hiển thị");
    // App vẫn so bằng số CHƯA làm tròn → trạng thái là KHỚP với ô 8M.
    expect(r.status).toBe("KHỚP CHÍNH XÁC");
  });

  it("formula injection: tên/nội dung bắt đầu bằng = + - @ bị vô hiệu bằng dấu nháy", () => {
    const data = mkData({
      groups: [{
        key: "payments", label: "Phiếu thu", sign: 1,
        rows: [mkRow(1_000, { name: "=HYPERLINK(\"http://x\",\"bấm\")", detail: "@SUM(1,2)", kind: "+lạ", status: "-1" })],
        subtotal: 1_000,
      }],
      detailTotal: 1_000, cardTotal: 1_000,
    });
    const csv = buildEvidenceCsv(data, { metricLabel: "Đã thu", cardTotalOnTile: 1_000 });
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    const dataLine = lines.find(l => l.includes("HYPERLINK"))!;
    const cells = splitCsv(dataLine);
    // Mọi ô text độc hại phải bắt đầu bằng dấu nháy đơn (Excel hiểu là chữ, không chạy).
    expect(cells[4]!.startsWith("'=")).toBe(true);
    expect(cells[6]!.startsWith("'@")).toBe(true);
    expect(cells[5]!.startsWith("'+")).toBe(true);
    expect(cells[7]!.startsWith("'-")).toBe(true);
    // Cột số vẫn là số thuần, =SUM vẫn đúng.
    expect(excelSelfSum(csv).sumRange).toBe(1_000);
  });
});
