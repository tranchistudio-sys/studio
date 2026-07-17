// Test Studio Copilot — sự cố prod 13/07: "Không đọc được dữ liệu studio" khi hỏi
// "tháng này còn bao nhiêu đơn chưa thu". Mock @workspace/db theo convention repo.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { pool } from "@workspace/db";
import {
  classifyIntent,
  detectOverviewScope,
  getOverduePostProductionJobs,
  getUnpaidCustomers,
  getRevenueSummary,
  getTodayBookings,
  answerStudioCopilot,
  buildFollowUp,
} from "./studio-copilot";
import { _resetSchemaFlagsCache } from "./schema-compat";

const q = pool.query as ReturnType<typeof vi.fn>;

const PROD_QUESTION =
  "bạn ơi , thực sự tháng này , còn bao nhiêu đơn chưa thu ạ, tiền còn có thể thu dc là bao nhiêu";

// ─── Helper mock SNAPSHOT (chốt 17/07: nợ đọc qua allocator chung của Engine) ──
type MockRow = Record<string, unknown>;
function mockSnapshot(opts: {
  bookings?: MockRow[];
  payments?: MockRow[];
  extra?: (sql: string, params: unknown[]) => { rows: MockRow[] } | null;
}) {
  return async (sql: string, params: unknown[] = []) => {
    const s = String(sql);
    if (opts.extra) {
      const r = opts.extra(s, params);
      if (r) return r;
    }
    if (s.includes("LEFT JOIN customers c ON c.id = b.customer_id") && s.includes("b.parent_id")) {
      return { rows: opts.bookings ?? [] };
    }
    if (s.includes("FROM payments") && s.includes("payment_type, status")) {
      return { rows: opts.payments ?? [] };
    }
    return { rows: [] };
  };
}
function bkRow(over: MockRow): MockRow {
  return {
    id: 1, parent_id: null, is_parent_contract: false, status: "confirmed", deleted_at: null,
    total_amount: "0", discount_amount: "0", shoot_date: null, customer_id: null,
    order_code: null, service_label: null, service_category: null, package_type: null,
    customer_name: null, customer_phone: null, ...over,
  };
}
// Ca prod 13/07: 19 đơn chưa thu đủ, tổng nợ 42.798.994 — cùng 1 khách.
const DEBT_BOOKINGS: MockRow[] = [
  ...Array.from({ length: 18 }, (_, i) =>
    bkRow({ id: 100 + i, total_amount: "1000000", customer_id: 7, customer_name: "Khách A", customer_phone: "0900000001", shoot_date: "2026-07-10" })),
  bkRow({ id: 200, total_amount: "24798994", customer_id: 7, customer_name: "Khách A", customer_phone: "0900000001", shoot_date: "2026-07-11" }),
];
function debtMock(capture?: (sql: string, params: unknown[]) => { rows: MockRow[] } | null, occ = false) {
  return mockSnapshot({
    bookings: DEBT_BOOKINGS,
    payments: [],
    extra: (s, p) => {
      if (capture) {
        const r = capture(s, p);
        if (r) return r;
      }
      if (s.includes("to_regclass")) return { rows: occ ? [{ occ: true, dw: true, wt: true, lc: true }] : [] };
      if (s.includes("SELECT b.id FROM bookings b WHERE")) return { rows: DEBT_BOOKINGS.map(b => ({ id: b.id })) };
      return null;
    },
  });
}

beforeEach(() => {
  q.mockReset();
  q.mockImplementation(async () => ({ rows: [] }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. Intent routing ─────────────────────────────────────────────────────────

describe("classifyIntent — câu hỏi công nợ 'chưa thu / phải thu'", () => {
  it("câu prod gây sự cố phải về debt (trước fix: unknown → overview → crash)", () => {
    expect(classifyIntent(PROD_QUESTION)).toBe("debt");
  });

  it.each([
    ["còn phải thu bao nhiêu tiền?", "debt"],
    ["đơn nào chưa thu đủ?", "debt"],
    ["còn thu được bao nhiêu?", "debt"],
    ["tiền còn có thể thu là bao nhiêu", "debt"],
    ["khách nào chưa thanh toán?", "debt"],
    ["doanh thu chưa thu tháng này?", "debt"], // chủ đích: hỏi tiền CHƯA thu → debt
  ])("%s → %s", (question, intent) => {
    expect(classifyIntent(question)).toBe(intent);
  });

  it("không cướp câu revenue/xếp lịch", () => {
    expect(classifyIntent("tháng này đã thu được bao nhiêu?")).toBe("revenue");
    expect(classifyIntent("Doanh thu tháng này bao nhiêu?")).toBe("revenue");
    // "chưa thu xếp" là chuyện xếp lịch, không phải công nợ
    expect(classifyIntent("chưa thu xếp được lịch cho khách")).not.toBe("debt");
  });

  it("non-regression: 8 chip UI giữ nguyên intent", () => {
    expect(classifyIntent("Hôm nay có bao nhiêu show?")).toBe("schedule");
    expect(classifyIntent("Khách nào đang nợ tiền?")).toBe("debt");
    expect(classifyIntent("Đơn nào trễ hậu kỳ?")).toBe("post_production");
    expect(classifyIntent("Doanh thu tháng này bao nhiêu?")).toBe("revenue");
    expect(classifyIntent("Nhân viên nào đang nhiều việc nhất?")).toBe("staff");
    expect(classifyIntent("Gói dịch vụ nào bán tốt nhất tháng này?")).toBe("revenue");
    expect(classifyIntent("Ai đi trễ nhiều nhất tháng này?")).toBe("staff");
    expect(classifyIntent("Tuần này nên ưu tiên xử lý việc gì?")).toBe("analysis");
    expect(classifyIntent("hi")).toBe("greeting");
    expect(classifyIntent("tình hình hôm nay sao rồi")).toBe("overview");
  });

  it("detectOverviewScope: câu 'bao nhiêu' là câu cụ thể, không trả overview", () => {
    expect(detectOverviewScope("thang nay con bao nhieu don chua thu")).toBeNull();
    expect(detectOverviewScope("tinh hinh thang nay")).toBe("month");
    expect(detectOverviewScope("hom nay the nao")).toBe("today");
  });
});

// ─── 2. Query overdue hậu kỳ — an toàn với deadline TEXT bẩn ───────────────────

describe("getOverduePostProductionJobs — deadline text '' / 'YYYY-MM-DD HH:MM:SS'", () => {
  it("SQL phải guard bằng substring, không còn cast trần ::date (lỗi 22007)", async () => {
    let captured = "";
    q.mockImplementation(async (sql: string) => {
      captured = String(sql);
      return { rows: [] };
    });
    await getOverduePostProductionJobs();
    expect(captured).toContain(String.raw`substring(pj.customer_deadline from '^\d{4}-\d{2}-\d{2}')`);
    expect(captured).toContain(String.raw`substring(pj.deadline_system from '^\d{4}-\d{2}-\d{2}')`);
    expect(captured).not.toContain("pj.customer_deadline::date");
    expect(captured).not.toContain("pj.deadline_system::date");
    // "quá hạn" tính theo ngày VN, không theo session TZ của DB
    expect(captured).toContain("NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh'");
  });

  it("format dòng kết quả chịu được cả 2 dạng dữ liệu thật", async () => {
    q.mockImplementation(async () => ({
      rows: [
        {
          job_code: "JOB-1",
          order_code: "DH0001",
          customer_name: "Khách B",
          customer_deadline: "",
          deadline_system: "2026-07-10 00:00:00",
          status: "chua_nhan",
          staff_name: "Chưa giao",
        },
        {
          job_code: "JOB-2",
          order_code: "DH0002",
          customer_name: "Khách C",
          customer_deadline: "2026-07-05",
          deadline_system: "",
          status: "dang_lam",
          staff_name: "An",
        },
      ],
    }));
    const r = await getOverduePostProductionJobs();
    expect(r.count).toBe(2);
    expect(r.lines[0]).toBe("• [DH0001] Khách B — hạn 10/7/2026, Chưa giao (chua_nhan)");
    expect(r.lines[1]).toBe("• [DH0002] Khách C — hạn 5/7/2026, An (dang_lam)");
  });
});

// ─── 3. Công nợ — predicate countable chuẩn (PR #65, khớp dashboard/simple) ────

describe("getUnpaidCustomers — nợ từ snapshot allocator, loại thùng rác/hủy/báo giá tạm/đơn cha/con mồ côi", () => {
  it("đơn temp_quote/cancelled/deleted/cha tổng KHÔNG vào nợ (countable lọc trong allocator)", async () => {
    q.mockImplementation(mockSnapshot({
      bookings: [
        bkRow({ id: 1, total_amount: "5000000", customer_id: 7, customer_name: "Khách A", customer_phone: "0900000001" }),
        bkRow({ id: 2, total_amount: "9000000", customer_id: 7, status: "temp_quote" }),
        bkRow({ id: 3, total_amount: "8000000", customer_id: 7, status: "cancelled" }),
        bkRow({ id: 4, total_amount: "7000000", customer_id: 7, deleted_at: "2026-07-01" }),
        bkRow({ id: 5, total_amount: "0", customer_id: 7, is_parent_contract: true }),
      ],
      payments: [],
    }));
    const r = await getUnpaidCustomers();
    expect(r.totalDebt).toBe(5_000_000); // CHỈ đơn hợp lệ — không temp/hủy/xóa/cha
    expect(r.orderCount).toBe(1);
  });

  it("mapping: đếm khách, đếm đơn, tổng nợ (ca prod 19 đơn / 42.798.994)", async () => {
    q.mockImplementation(debtMock());
    const r = await getUnpaidCustomers();
    expect(r.count).toBe(1);
    expect(r.orderCount).toBe(19);
    expect(r.totalDebt).toBe(42798994);
    expect(r.lines[0]).toContain("Khách A (0900000001): còn nợ");
  });

  it("month-scope: query membership shoot_date đúng tham số kỳ", async () => {
    _resetSchemaFlagsCache();
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(debtMock((s, p) => {
      if (s.includes("SELECT b.id FROM bookings b WHERE")) {
        calls.push({ sql: s, params: p });
        return { rows: DEBT_BOOKINGS.map(b => ({ id: b.id })) };
      }
      return null;
    }));
    const r = await getUnpaidCustomers(15, { start: "2026-07-01", end: "2026-07-31", label: "tháng 7/2026" });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("b.shoot_date >= $1::date AND b.shoot_date <= $2::date");
    expect(calls[0].sql).toContain("deleted_at IS NULL"); // countable ① ở vế membership
    expect(calls[0].params).toEqual(["2026-07-01", "2026-07-31"]);
    expect(r.totalDebt).toBe(42798994);
  });

  it("month-scope KHÔNG có bảng occurrences (DB chưa migrate) → không thêm vế EXISTS", async () => {
    _resetSchemaFlagsCache();
    const sqls: string[] = [];
    q.mockImplementation(debtMock((s) => {
      sqls.push(s);
      return null;
    }, false));
    await getUnpaidCustomers(15, { start: "2026-07-01", end: "2026-07-31", label: "tháng 7/2026" });
    for (const sq of sqls.filter(x => x.includes("shoot_date >="))) {
      expect(sq).not.toContain("booking_occurrences");
    }
  });

  it("month-scope CÓ occurrences → membership shoot_date HOẶC ngày phụ (GĐ1b-1, chung Engine với màn Doanh thu)", async () => {
    _resetSchemaFlagsCache();
    const sqls: string[] = [];
    q.mockImplementation(debtMock((s) => {
      sqls.push(s);
      return null;
    }, true));
    await getUnpaidCustomers(15, { start: "2026-07-01", end: "2026-07-31", label: "tháng 7/2026" });
    const dataSqls = sqls.filter(x => x.includes("shoot_date >=") && !x.includes("to_regclass"));
    expect(dataSqls.length).toBeGreaterThanOrEqual(1);
    for (const sq of dataSqls) {
      expect(sq).toContain("EXISTS");
      expect(sq).toContain("booking_occurrences oc");
      expect(sq).toContain("oc.booking_id = b.id");
    }
  });
});

// ─── 4. E2E câu prod: debt month-scope, nói rõ phạm vi ─────────────────────────

describe("answerStudioCopilot — câu prod trả lời công nợ tháng, không crash", () => {
  it("trả số đơn chưa thu + tiền còn thu + phạm vi tính", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00+07:00"));
    _resetSchemaFlagsCache();
    q.mockImplementation(debtMock());
    const r = await answerStudioCopilot(PROD_QUESTION);
    expect(r.intent).toBe("debt");
    expect(r.fromData).toBe(true);
    expect(r.answer).toContain("tháng 7/2026");
    expect(r.answer).toContain("19 đơn chưa thu đủ");
    expect(r.answer).toContain("Phạm vi");
    expect(r.answer).not.toContain("Không đọc được dữ liệu studio");
  });
});

// ─── 5. Chống chết chùm: 1 tool hỏng không giết cả overview ────────────────────

describe("answerOverview resilience — query photoshop_jobs chết vẫn trả tổng quan", () => {
  it("hiện '(tạm không đọc được mục này)' thay vì message lỗi toàn cục", async () => {
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("photoshop_jobs")) {
        throw Object.assign(new Error('invalid input syntax for type date: ""'), {
          code: "22007",
        });
      }
      if (s.includes("FROM payments")) return { rows: [{ total: "1000000", cnt: "2" }] };
      if (s.includes("total_debt")) return { rows: [{ order_cnt: "1", total_debt: "500000" }] };
      if (s.includes("HAVING SUM"))
        return { rows: [{ name: "Khách A", phone: "0900000001", debt: "500000" }] };
      if (s.includes("COUNT(*) AS cnt FROM bookings")) return { rows: [{ cnt: "3" }] };
      return { rows: [] };
    });
    const r = await answerStudioCopilot("tình hình hôm nay thế nào");
    expect(r.intent).toBe("overview");
    expect(r.answer).toContain("Tổng quan");
    expect(r.answer).toContain("(tạm không đọc được mục này)");
    expect(r.answer).toContain("Một phần dữ liệu tạm không đọc được");
    expect(r.answer).not.toContain("Không đọc được dữ liệu studio");
  });
});

// ─── 6. Múi giờ VN: "hôm nay/tháng này" không lệch khi server chạy UTC ─────────

describe("timezone VN — 01:30 sáng 01/08 VN (= 18:30 31/07 UTC)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T18:30:00Z"));
  });

  it("getRevenueSummary tính tháng 8 (không phải tháng 7 theo UTC), cửa sổ đọc từ Engine", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ v: "0" }] };
    });
    const r = await getRevenueSummary();
    expect(r.label).toBe("tháng 8/2026");
    // GĐ1e-2: đã thu đọc qua Financial Engine (engineCashIn) — cửa sổ [đầu tháng,
    // cuối tháng] theo NGÀY VN, nửa mở phải (paid_at < ngày+1). KHỚP Tổng quan tài chính.
    const collectedCall = calls.find(c => c.sql.includes("SUM(amount"))!;
    expect(collectedCall.params).toEqual(["2026-08-01", "2026-08-31"]);
    expect(collectedCall.sql).toContain("paid_at < ($2::date + INTERVAL '1 day')");
    expect(collectedCall.sql).toContain("!= 'voided'");
  });

  it("getTodayBookings lấy ngày VN 2026-08-01", async () => {
    const params: unknown[][] = [];
    q.mockImplementation(async (_sql: string, p: unknown[]) => {
      params.push(p);
      return { rows: [] };
    });
    await getTodayBookings();
    expect(params[0]).toEqual(["2026-08-01"]);
  });
});

// ─── 7. Formatter tự nhiên (fallback không AI) — không markdown, không đổi số ──

function mockRevenueMonth() {
  // GĐ1e-2: getRevenueSummary đọc từ Financial Engine — 3 query đều trả cột `v`.
  q.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (s.includes("SUM(amount")) return { rows: [{ v: "24699006" }] }; // engineCashIn: đã thu
    // COUNT phiếu thu (FROM payments) phải check TRƯỚC "FROM bookings b": câu
    // payments chứa subquery cha-rỗng "FROM bookings zp" (không phải "bookings b").
    if (s.includes("FROM payments")) return { rows: [{ v: "24" }] }; // paymentCount
    if (s.includes("FROM bookings b")) return { rows: [{ v: "40" }] }; // bookingCount
    return { rows: [] };
  });
}

describe("deterministic formatter — câu văn tự nhiên ngay cả khi KHÔNG có AI", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00+07:00"));
  });

  it("revenue: đúng số từ DB, không dấu **, không câu sáo rỗng 'mục tiêu'", async () => {
    mockRevenueMonth();
    const r = await answerStudioCopilot("Doanh thu tháng này bao nhiêu?");
    expect(r.intent).toBe("revenue");
    // Số liệu giữ NGUYÊN như DB trả về
    expect(r.answer).toContain("24.699.006");
    expect(r.answer).toContain("40 đơn");
    expect(r.answer).toContain("24 phiếu thu");
    // Không phát markdown (frontend render plain text)
    expect(r.answer).not.toContain("**");
    expect(r.answer).not.toContain("##");
    // Không bịa fact ngoài dữ liệu (không có dữ liệu mục tiêu thì không nhắc mục tiêu)
    expect(r.answer).not.toContain("mục tiêu");
  });

  it("revenue: facts đúng schema cho composer, số y nguyên", async () => {
    mockRevenueMonth();
    const r = await answerStudioCopilot("Doanh thu tháng này bao nhiêu?");
    expect(r.facts?.intent).toBe("revenue");
    expect(r.facts?.period).toBe("2026-07");
    expect(r.facts?.scopeDescription).toContain("phiếu thu thực tế");
    expect(r.facts?.facts).toEqual({
      collectedAmount: 24699006,
      bookingCount: 40,
      paymentCount: 24,
    });
  });

  it("debt: không markdown, tổng nợ giữ nguyên, có nhận xét theo khách nợ lớn nhất", async () => {
    _resetSchemaFlagsCache();
    q.mockImplementation(debtMock());
    const r = await answerStudioCopilot("khách nào đang nợ tiền?");
    expect(r.intent).toBe("debt");
    expect(r.answer).toContain("42.798.994");
    expect(r.answer).not.toContain("**");
    // follow-up công nợ dựa trên dữ liệu thật (khách đứng đầu), khác câu của revenue
    expect(r.answer).toContain("Khách A");
  });

  it("overview: không còn dấu ** trong toàn bộ báo cáo", async () => {
    q.mockImplementation(async () => ({ rows: [] }));
    const r = await answerStudioCopilot("tình hình hôm nay thế nào");
    expect(r.intent).toBe("overview");
    expect(r.answer).toContain("Tổng quan");
    expect(r.answer).not.toContain("**");
  });
});

// ─── 8. Follow-up theo intent — mỗi loại câu hỏi một gợi ý riêng, có căn cứ ────

describe("buildFollowUp — không dùng một câu chung cho mọi intent", () => {
  it("revenue gợi ý đối chiếu phần chưa thu; debt nêu khách nợ lớn nhất — 2 câu KHÁC nhau", () => {
    const rev = buildFollowUp("revenue", { bookingCount: 40 });
    const debt = buildFollowUp("debt", { topDebtorName: "Khách A", topDebtorDebt: 42798994 });
    expect(rev).toMatch(/chưa thu/);
    expect(debt).toContain("Khách A");
    expect(debt).toContain("42.798.994");
    expect(rev).not.toBe(debt);
  });

  it("không có căn cứ dữ liệu → không gợi ý (null), tuyệt đối không câu chung chung", () => {
    expect(buildFollowUp("revenue", { bookingCount: 0 })).toBeNull();
    expect(buildFollowUp("debt", {})).toBeNull();
    expect(buildFollowUp("schedule", { count: 1 })).toBeNull();
    expect(buildFollowUp("post_production", { overdueCount: 0 })).toBeNull();
    expect(buildFollowUp("staff", { topStaffName: "An", topJobCount: 2 })).toBeNull();
    expect(buildFollowUp("pricing", {})).toBeNull();
  });

  it("schedule dày show / hậu kỳ trễ / nhân sự quá tải → có cảnh báo tương ứng", () => {
    expect(buildFollowUp("schedule", { count: 4 })).toMatch(/nhân sự/);
    expect(buildFollowUp("post_production", { overdueCount: 2 })).toMatch(/Tiến độ hậu kỳ/);
    expect(buildFollowUp("staff", { topStaffName: "An", topJobCount: 6 })).toContain("An");
  });
});

// ─── 9. Finance — cùng công thức màn "Tổng quan tài chính" (sự cố 14/07) ───────

describe("classifyIntent — finance (tài chính/lợi nhuận/hòa vốn/chi phí)", () => {
  it.each([
    ["tổng quan tài chính", "finance"],
    ["tổng quan tài chính á", "finance"],
    ["lợi nhuận tháng này bao nhiêu?", "finance"],
    ["tháng này lời lỗ thế nào?", "finance"],
    ["chi phí tháng này hết bao nhiêu?", "finance"],
    ["studio đạt hòa vốn chưa?", "finance"],
  ])("%s → %s", (question, intent) => {
    expect(classifyIntent(question)).toBe(intent);
  });

  it("không cướp câu doanh thu / công nợ / tổng quan vận hành", () => {
    expect(classifyIntent("Doanh thu tháng này bao nhiêu?")).toBe("revenue");
    expect(classifyIntent("Khách nào đang nợ tiền?")).toBe("debt");
    expect(classifyIntent("tình hình hôm nay sao rồi")).toBe("overview");
  });
});

describe("getRevenueSummary — khớp lớp lọc 'Đã thu' của Engine/Dashboard", () => {
  it("SQL loại refund + phiếu thu trên đơn CHA rỗng (khoản phồng 2.000.000 đ)", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      sqls.push(String(sql));
      return { rows: [{ v: "0" }] };
    });
    await getRevenueSummary();
    // GĐ1e-2: cùng lớp lọc collectedPaymentCond của Financial Engine (engineCashIn).
    const paymentSqls = sqls.filter(s => s.includes("FROM payments"));
    expect(paymentSqls.length).toBe(2); // SUM tiền (engineCashIn) + COUNT phiếu
    for (const s of paymentSqls) {
      expect(s).toContain("!= 'refund'");
      expect(s).toContain("!= 'voided'");
      expect(s).toContain("is_parent_contract = true"); // predicate cha rỗng
    }
  });
});

describe("answerFinance — số y hệt màn Tổng quan tài chính", () => {
  it("đủ đã thu / đã chi (trực tiếp + cố định) / lợi nhuận / hòa vốn, không **", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00+07:00"));
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("FROM payments")) return { rows: [{ total: "34198006", v: "34198006" }] };
      if (s.includes("FROM expenses")) return { rows: [{ total: "15310000", v: "15310000" }] };
      if (s.includes("FROM fixed_costs")) return { rows: [{ total: "37100000", v: "37100000" }] };
      if (s.includes("GREATEST")) return { rows: [{ total: "409927995", v: "409927995" }] };
      return { rows: [] };
    });
    const r = await answerStudioCopilot("tổng quan tài chính");
    expect(r.intent).toBe("finance");
    expect(r.fromData).toBe(true);
    // Số y hệt /dashboard/simple — không tự chế công thức
    expect(r.answer).toContain("34.198.006");
    expect(r.answer).toContain("52.410.000");
    expect(r.answer).toContain("15.310.000");
    expect(r.answer).toContain("37.100.000");
    expect(r.answer).toContain("18.211.994");
    expect(r.answer).toContain("hòa vốn");
    expect(r.answer).not.toContain("**");
    // Facts cho composer: đủ chi phí/lợi nhuận, không thiếu như sự cố
    expect(r.facts?.intent).toBe("finance");
    expect(r.facts?.facts).toMatchObject({
      collectedAmount: 34198006,
      totalSpent: 52410000,
      realProfit: -18211994,
      breakevenStatus: "under",
    });
  });
});
