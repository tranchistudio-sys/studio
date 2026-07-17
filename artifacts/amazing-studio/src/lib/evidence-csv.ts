/**
 * evidence-csv.ts — logic THUẦN cho modal "Bằng chứng số liệu" (màn Doanh thu & Lợi nhuận).
 *
 * Tách thuần để test không cần render React (FE project chỉ có vitest logic, không jsdom):
 *  - types mirror response của /api/revenue/v2/evidence
 *  - reconcile(): so khớp chi tiết ↔ số trên ô CHÍNH XÁC TỪNG ĐỒNG (không làm tròn,
 *    không "khoảng" — chỉ hấp thụ nhiễu float < 0.001đ, mọi lệch thật ≥ 1đ đều hiện)
 *  - buildEvidenceCsv(): file "Excel" (CSV UTF-8 BOM, KHÔNG dòng `sep=` — Excel thật
 *    nuốt dòng đó làm lệch vùng =SUM và vỡ BOM tiếng Việt) có công thức =SUM để
 *    Excel TỰ CỘNG LẠI — người dùng mở file là kiểm tra được phép cộng.
 */

export const EVIDENCE_METRICS = [
  "collected",
  "remaining",
  "cost",
  "realProfit",
  "contractValue",
  "expectedCost",
  "expectedProfit",
  // Đợt 2: các ô còn lại màn Doanh thu (mirror EVIDENCE_METRICS của backend)
  "grossProfit",
  "operatingProfit",
  "netProfit",
  "staffCast",
  "directCost",
  "operatingExpenses",
  "depreciation",
  "interest",
  "depreciationInterest",
  "cashSpent",
  "cashNet",
] as const;
export type EvidenceMetric = (typeof EVIDENCE_METRICS)[number];

export type EvidenceRow = {
  date: string | null;
  code: string | null;
  name: string | null;
  kind: string | null;
  detail: string | null;
  status: string | null;
  by: string | null;
  amount: number;
  bookingId: number | null;
  paymentId: number | null;
  expenseId: number | null;
};

export type EvidenceGroup = {
  key: string;
  label: string;
  sign: 1 | -1;
  rows: EvidenceRow[];
  subtotal: number;
};

export type EvidenceResponse = {
  metric: EvidenceMetric;
  from: string;
  to: string;
  formula: string;
  scopeNote: string;
  notes: string[];
  groups: EvidenceGroup[];
  detailTotal: number;
  cardTotal: number;
  reconciliationDelta: number;
  rowCount: number;
};

/**
 * So khớp chính xác từng ĐỒNG. EPS = 0.001đ chỉ để hấp thụ nhiễu dấu phẩy động
 * của phép cộng (1e-9…), nhỏ hơn 1 đồng 1000 lần — KHÔNG phải làm tròn:
 * lệch thật nhỏ nhất có thể xảy ra với tiền VND là 1đ và luôn bị bắt.
 */
const EPS = 0.001;

export function reconcile(detailTotal: number, cardTotal: number): {
  delta: number;
  match: boolean;
} {
  const delta = detailTotal - cardTotal;
  return { delta, match: Math.abs(delta) < EPS };
}

/** Cộng lại từ TỪNG DÒNG (không tin subtotal server) — dùng cho badge khớp/lệch. */
export function sumFromRows(groups: EvidenceGroup[]): number {
  let s = 0;
  for (const g of groups) {
    for (const r of g.rows) s += g.sign * r.amount;
  }
  return s;
}

function csvEscape(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Ô TEXT từ dữ liệu người dùng (tên khách, nội dung phiếu…): chặn CSV formula
 * injection — giá trị bắt đầu bằng = + - @ hoặc tab sẽ bị Excel chạy như công thức,
 * nên chèn dấu nháy đơn phía trước để Excel hiểu là chữ thuần.
 */
function csvText(v: string | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return csvEscape(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Format số cho Excel: giữ nguyên giá trị, không tách nghìn (Excel tự hiểu là số). */
function csvNum(n: number): string {
  // Tiền VND là số nguyên; chỉ khi dữ liệu gốc có lẻ (nợ chia pro-rata) mới có thập phân.
  return Number.isInteger(n) ? String(n) : String(round2(n));
}

export type EvidenceCsvOptions = {
  metricLabel: string;
  /** Số ĐANG hiển thị trên ô — đối chiếu độc lập với cardTotal server trả về. */
  cardTotalOnTile: number;
  rangeLabel?: string;
};

/**
 * Sinh nội dung file CSV (mở bằng Excel). Cột "Số tiền (áp dấu)" là cột được
 * Excel tự cộng bằng công thức =SUM(...) — mở file ra là thấy Excel cộng lại
 * đúng/không, khỏi tin phần mềm.
 *
 * Nhất quán làm tròn: giá trị ghi vào cột K và dòng "TỔNG CHI TIẾT" đều lấy từ
 * CÙNG một dãy số đã làm tròn hiển thị (0,01đ) — Excel =SUM cột K luôn ra đúng
 * dòng TỔNG CHI TIẾT. Nếu việc làm tròn hiển thị tạo chênh với số gốc server
 * (chỉ xảy ra khi có khoản nợ pro-rata lẻ), file ghi RÕ phần chênh đó ra một
 * dòng riêng — không che.
 */
export function buildEvidenceCsv(data: EvidenceResponse, opts: EvidenceCsvOptions): string {
  const lines: string[] = [];
  const push = (cells: Array<string | number | null>) => {
    lines.push(cells.map(csvEscape).join(","));
  };
  const pushRaw = (raw: string) => lines.push(raw);

  // KHÔNG dùng dòng `sep=,`: Excel nuốt dòng đó (mọi dòng dồn lên 1 → vùng =SUM
  // lệch đúng 1 dòng) và bỏ luôn BOM (tiếng Việt vỡ). Đã kiểm chứng trên Excel 16.
  push(["BẰNG CHỨNG SỐ LIỆU", opts.metricLabel]);
  push(["Kỳ lọc", opts.rangeLabel ?? `${data.from} → ${data.to}`]);
  push(["Từ ngày", data.from]);
  push(["Đến ngày", data.to]);
  push(["Công thức", data.formula]);
  if (data.scopeNote) push(["Ghi chú phạm vi", data.scopeNote]);
  for (const n of data.notes ?? []) push(["Lưu ý", n]);
  pushRaw("");

  const COLS = ["Nhóm", "Dấu", "Ngày", "Mã", "Tên/Khách", "Loại khoản", "Nội dung", "Trạng thái", "Người tạo/thu", "Số tiền", "Số tiền (áp dấu)"];
  push(COLS);
  const firstDataLine = lines.length + 1; // 1-based line number của dòng dữ liệu đầu

  // detailShown = tổng các giá trị ĐÚNG NHƯ ĐÃ GHI vào cột K — thứ Excel sẽ cộng.
  let detailShown = 0;
  for (const g of data.groups) {
    for (const r of g.rows) {
      const signed = round2(g.sign * r.amount);
      detailShown = round2(detailShown + signed);
      lines.push([
        csvEscape(g.label),
        csvEscape(g.sign === 1 ? "(+)" : "(−)"),
        csvText(r.date), csvText(r.code), csvText(r.name), csvText(r.kind),
        csvText(r.detail), csvText(r.status), csvText(r.by),
        csvNum(round2(r.amount)),
        csvNum(signed),
      ].join(","));
    }
  }
  const lastDataLine = lines.length; // dòng dữ liệu cuối (nếu có)
  const hasRows = lastDataLine >= firstDataLine;

  pushRaw("");
  // Cột "Số tiền (áp dấu)" là cột thứ 11 = K.
  const sumFormula = hasRows ? `=SUM(K${firstDataLine}:K${lastDataLine})` : "0";
  const { delta, match } = reconcile(data.detailTotal, opts.cardTotalOnTile);
  const roundingGap = round2(detailShown - data.detailTotal);

  push(["TỔNG CHI TIẾT (Excel tự cộng)", null, null, null, null, null, null, null, null, null, sumFormula]);
  push(["TỔNG CHI TIẾT (detailTotal)", null, null, null, null, null, null, null, null, null, csvNum(detailShown)]);
  if (Math.abs(roundingGap) >= 0.005) {
    push(["— trong đó chênh do làm tròn hiển thị 0,01đ (nợ pro-rata lẻ)", null, null, null, null, null, null, null, null, null, csvNum(roundingGap)]);
    push(["— số gốc server (chưa làm tròn)", null, null, null, null, null, null, null, null, null, String(data.detailTotal)]);
  }
  push(["SỐ TRÊN Ô (cardTotal)", null, null, null, null, null, null, null, null, null, csvNum(opts.cardTotalOnTile)]);
  push(["SERVER TÍNH LẠI (cardTotal server)", null, null, null, null, null, null, null, null, null, csvNum(data.cardTotal)]);
  push(["CHÊNH LỆCH (reconciliationDelta)", null, null, null, null, null, null, null, null, null, csvNum(delta)]);
  push(["TRẠNG THÁI", null, null, null, null, null, null, null, null, null,
    match ? "KHỚP CHÍNH XÁC" : `LỆCH ${csvNum(delta)} đồng`]);

  // BOM (﻿) để Excel đọc đúng UTF-8 tiếng Việt.
  return "﻿" + lines.join("\r\n");
}

export function evidenceCsvFilename(metric: EvidenceMetric, from: string, to: string): string {
  return `bang-chung-${metric}-${from}_${to}.csv`;
}
