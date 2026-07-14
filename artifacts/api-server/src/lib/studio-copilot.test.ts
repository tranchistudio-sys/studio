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
} from "./studio-copilot";

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
    expect(calls[0].sql).toContain("b.shoot_date >= $2::date AND b.shoot_date <= $3::date");
    expect(calls[0].params).toEqual([15, "2026-07-01", "2026-07-31"]);
    expect(calls[1].sql).toContain("b.shoot_date >= $1::date AND b.shoot_date <= $2::date");
    expect(calls[1].params).toEqual(["2026-07-01", "2026-07-31"]);
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
