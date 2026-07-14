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

describe("getUnpaidCustomers — loại thùng rác/hủy/báo giá tạm/đơn cha/con mồ côi", () => {
  it("cả 2 query đều dùng predicate countable chuẩn + COALESCE tiền", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      sqls.push(String(sql));
      return { rows: [] };
    });
    await getUnpaidCustomers();
    expect(sqls).toHaveLength(2);
    for (const s of sqls) {
      expect(s).toContain("deleted_at IS NULL");
      expect(s).toContain("'temp_quote'");
      expect(s).toContain("is_parent_contract = false");
      expect(s).toContain("parent_id IS NULL"); // orphan-check (NOT EXISTS cha chết)
      expect(s).toContain("COALESCE(b.discount_amount, 0)");
      expect(s).toContain("COALESCE(b.paid_amount, 0)");
    }
  });

  it("mapping rows: đếm khách, đếm đơn, tổng nợ", async () => {
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("total_debt")) return { rows: [{ order_cnt: "19", total_debt: "42798994" }] };
      return { rows: [{ name: "Khách A", phone: "0900000001", debt: "42798994" }] };
    });
    const r = await getUnpaidCustomers();
    expect(r.count).toBe(1);
    expect(r.orderCount).toBe(19);
    expect(r.totalDebt).toBe(42798994);
    expect(r.lines[0]).toContain("Khách A (0900000001): còn nợ");
  });

  it("month-scope: thêm filter shoot_date với đúng tham số", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push({ sql: String(sql), params });
      return { rows: [] };
    });
    await getUnpaidCustomers(15, { start: "2026-07-01", end: "2026-07-31", label: "tháng 7/2026" });
    // Bỏ query dò schema (to_regclass) — chỉ soi 2 query dữ liệu
    const dataCalls = calls.filter(c => !c.sql.includes("to_regclass"));
    expect(dataCalls[0].sql).toContain("b.shoot_date >= $2::date AND b.shoot_date <= $3::date");
    expect(dataCalls[0].params).toEqual([15, "2026-07-01", "2026-07-31"]);
    expect(dataCalls[1].sql).toContain("b.shoot_date >= $1::date AND b.shoot_date <= $2::date");
    expect(dataCalls[1].params).toEqual(["2026-07-01", "2026-07-31"]);
  });

  it("month-scope KHÔNG có bảng occurrences (DB chưa migrate) → không thêm vế EXISTS", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      sqls.push(String(sql));
      return { rows: [] }; // to_regclass rỗng → flags false
    });
    await getUnpaidCustomers(15, { start: "2026-07-01", end: "2026-07-31", label: "tháng 7/2026" });
    for (const sq of sqls.filter(x => x.includes("shoot_date >="))) {
      expect(sq).not.toContain("booking_occurrences");
    }
  });

  it("month-scope CÓ occurrences → membership shoot_date HOẶC ngày phụ (GĐ1b-1, chung Engine với màn Doanh thu)", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      const sx = String(sql);
      sqls.push(sx);
      if (sx.includes("to_regclass")) {
        return { rows: [{ occ: true, dw: true, wt: true, lc: true }] };
      }
      return { rows: [] };
    });
    await getUnpaidCustomers(15, { start: "2026-07-01", end: "2026-07-31", label: "tháng 7/2026" });
    const dataSqls = sqls.filter(x => x.includes("shoot_date >=") && !x.includes("to_regclass"));
    expect(dataSqls.length).toBe(2);
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
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("total_debt")) return { rows: [{ order_cnt: "19", total_debt: "42798994" }] };
      if (s.includes("HAVING SUM"))
        return { rows: [{ name: "Khách A", phone: "0900000001", debt: "42798994" }] };
      return { rows: [] };
    });
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

  it("getRevenueSummary tính tháng 8 (không phải tháng 7 theo UTC), ranh giới nửa mở", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ total: "0", cnt: "0" }] };
    });
    const r = await getRevenueSummary();
    expect(r.label).toBe("tháng 8/2026");
    expect(calls[0].params).toEqual(["2026-08-01", "2026-09-01"]);
    // paid_at naive-UTC: mốc VN phải quy đổi qua UTC + loại phiếu voided
    expect(calls[0].sql).toContain("AT TIME ZONE 'Asia/Ho_Chi_Minh' AT TIME ZONE 'UTC'");
    expect(calls[0].sql).toContain("!= 'voided'");
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
  q.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (s.includes("SUM(amount)")) return { rows: [{ total: "24699006" }] };
    // COUNT phiếu thu phải check TRƯỚC "FROM bookings": predicate cha-rỗng mới
    // chứa subquery "FROM bookings zp" ngay trong câu payments.
    if (s.includes("FROM payments")) return { rows: [{ cnt: "24" }] };
    if (s.includes("FROM bookings")) return { rows: [{ cnt: "40" }] };
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
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("total_debt")) return { rows: [{ order_cnt: "19", total_debt: "42798994" }] };
      if (s.includes("HAVING SUM"))
        return { rows: [{ name: "Khách A", phone: "0900000001", debt: "42798994" }] };
      return { rows: [] };
    });
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

describe("getRevenueSummary — khớp lớp lọc 'Đã thu' của /dashboard/simple", () => {
  it("SQL loại refund + phiếu thu trên đơn CHA rỗng (khoản phồng 2.000.000 đ)", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      sqls.push(String(sql));
      return { rows: [{ total: "0", cnt: "0" }] };
    });
    await getRevenueSummary();
    const paymentSqls = sqls.filter(s => s.includes("FROM payments"));
    expect(paymentSqls.length).toBe(2); // SUM tiền + COUNT phiếu
    for (const s of paymentSqls) {
      expect(s).toContain("payment_type != 'refund'");
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
