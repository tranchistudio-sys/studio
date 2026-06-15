/**
 * Unit tests for syncPhotoshopEarning (photoshop-jobs.ts) — Task #493.
 *
 * Đơn giá hậu kỳ giờ lấy theo nguyên tắc cast-driven:
 *   (1) staff_cast_rates role=photoshop + packageId của booking
 *   (2) staff_rate_prices role=photoshop, taskKey=mac_dinh, rateType=per_photo
 *   (3) Fallback: group_id=17 (tiệc/phóng sự) → 1.000đ; else → 12.000đ
 *
 * Count = detailPhotosCount + partyPhotosCount.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { state, T } = vi.hoisted(() => {
  const T = {
    photoshopJobs:    { _t: "photoshopJobs" },
    staffJobEarnings: { _t: "staffJobEarnings" },
    staff:            { _t: "staff" },
    staffRatePrices:  { _t: "staffRatePrices" },
    staffCastRates:   { _t: "staffCastRates" },
  };

  const state = {
    jobs:        [] as any[],
    earnings:    [] as any[],
    staff:       [] as any[],
    staffRates:  [] as any[],
    castRates:   [] as any[],
    pkgInfo:     { service_package_id: null as number | null, items: null as unknown, group_id: null as number | null },
    updates:     [] as Array<{ id: number; values: Record<string, unknown> }>,
    inserts:     [] as any[],
  };

  return { state, T };
});

vi.mock("@workspace/db/schema", () => ({
  photoshopJobsTable:    T.photoshopJobs,
  bookingsTable:         {},
  bookingItemsTable:     {},
  paymentsTable:         {},
  staffJobEarningsTable: T.staffJobEarnings,
  staffRatePricesTable:  T.staffRatePrices,
  staffTable:            T.staff,
  staffCastRatesTable:   T.staffCastRates,
}));

vi.mock("drizzle-orm", () => {
  const eq  = (col: any, val: any) => ({ _type: "eq",  col, val });
  const and = (...args: any[])      => ({ _type: "and", args });
  return { eq, and, desc: vi.fn(), inArray: vi.fn(), sql: vi.fn() };
});

vi.mock("./auth", () => ({
  verifyToken:   vi.fn(),
  getCallerRole: vi.fn(),
}));

vi.mock("./notifications", () => ({ emitNotification: vi.fn() }));

vi.mock("@workspace/db", () => {
  function makeSelect() {
    let _table: any;
    const chain = {
      from(table: any) { _table = table; return chain; },
      where(_cond: any): Promise<any[]> {
        if (_table === T.photoshopJobs)    return Promise.resolve(state.jobs);
        if (_table === T.staffJobEarnings) return Promise.resolve(state.earnings);
        if (_table === T.staff)            return Promise.resolve(state.staff);
        if (_table === T.staffRatePrices)  return Promise.resolve(state.staffRates);
        if (_table === T.staffCastRates)   return Promise.resolve(state.castRates);
        return Promise.resolve([]);
      },
    };
    return chain;
  }

  function makeUpdate() {
    let _values: any;
    const chain = {
      set(v: any) { _values = v; return chain; },
      where(cond: any): Promise<void> {
        const id = cond?.val ?? null;
        state.updates.push({ id, values: _values });
        const earning = state.earnings.find(e => e.id === id);
        if (earning && _values?.status) earning.status = _values.status;
        return Promise.resolve();
      },
    };
    return chain;
  }

  function makeInsert() {
    return {
      values(v: any): Promise<void> {
        state.inserts.push(v);
        return Promise.resolve();
      },
    };
  }

  // pool.query → return pkgInfo for the booking lookup; empty for any other.
  const poolQuery = vi.fn(async (sql: string) => {
    if (/FROM\s+bookings/i.test(sql)) return { rows: [state.pkgInfo] };
    if (/FROM\s+service_packages/i.test(sql)) {
      return { rows: [{ group_id: state.pkgInfo.group_id }] };
    }
    return { rows: [] };
  });

  return {
    db: {
      select: makeSelect,
      update: (_table: any) => makeUpdate(),
      insert: (_table: any) => makeInsert(),
    },
    pool: { query: poolQuery },
  };
});

import { syncPhotoshopEarning } from "./photoshop-jobs.js";

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id:                1,
    status:            "xong_show",
    jobCode:           "PS-001",
    completedBy:       null,
    assignedStaffId:   10,
    bookingId:         99,
    detailPhotosCount: 5,
    partyPhotosCount:  0,
    detailPhotosRate:  null,
    partyPhotosRate:   null,
    shootDate:         "2025-04-01",
    completedAt:       null,
    ...overrides,
  };
}

function makeEarning(overrides: Record<string, unknown> = {}) {
  return {
    id:      1,
    staffId: 10,
    status:  "pending",
    notes:   "photoshop_job:1",
    ...overrides,
  };
}

beforeEach(() => {
  state.jobs       = [];
  state.earnings   = [];
  state.staff      = [];
  state.staffRates = [];
  state.castRates  = [];
  state.pkgInfo    = { service_package_id: null, items: null, group_id: null };
  state.updates    = [];
  state.inserts    = [];
});

// ── Forward ───────────────────────────────────────────────────────────────────
describe("forward (xong_show)", () => {
  it("inserts 1 earning using default 12 000đ when no cast/per-staff rate, gói thường", async () => {
    state.jobs    = [makeJob()];          // count=5
    state.staff   = [{ id: 10 }];
    state.pkgInfo = { service_package_id: 48, items: null, group_id: 10 };

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(1);
    const ins = state.inserts[0];
    expect(ins.staffId).toBe(10);
    expect(ins.bookingId).toBe(99);
    expect(ins.role).toBe("photoshop");
    expect(ins.status).toBe("pending");
    expect(ins.rate).toBe("60000");        // 5 × 12 000
    expect(ins.notes).toBe("photoshop_job:1");
  });

  it("uses completedBy over assignedStaffId when both are set", async () => {
    state.jobs    = [makeJob({ completedBy: 20, assignedStaffId: 10 })];
    state.staff   = [{ id: 20 }];
    state.pkgInfo = { service_package_id: 48, items: null, group_id: 10 };

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].staffId).toBe(20);
  });

  it("also triggers for hoan_thanh (backward-compat status)", async () => {
    state.jobs    = [makeJob({ status: "hoan_thanh" })];
    state.staff   = [{ id: 10 }];
    state.pkgInfo = { service_package_id: 48, items: null, group_id: 10 };

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(1);
  });

  it("count cộng cả party + detail", async () => {
    state.jobs    = [makeJob({ detailPhotosCount: 3, partyPhotosCount: 7 })];
    state.staff   = [{ id: 10 }];
    state.pkgInfo = { service_package_id: 48, items: null, group_id: 10 };

    await syncPhotoshopEarning(1);

    expect(state.inserts[0].rate).toBe("120000"); // (3+7) × 12 000
  });
});

// ── Idempotent ────────────────────────────────────────────────────────────────
describe("idempotent", () => {
  it("updates the existing earning rather than inserting a duplicate", async () => {
    state.jobs     = [makeJob()];
    state.staff    = [{ id: 10 }];
    state.earnings = [makeEarning()];
    state.pkgInfo  = { service_package_id: 48, items: null, group_id: 10 };

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].id).toBe(1);
    expect(state.updates[0].values.status).toBe("pending");
  });
});

// ── Revert ────────────────────────────────────────────────────────────────────
describe("revert (dang_pts / da_pts)", () => {
  it("voids the existing earning when status reverts to dang_pts", async () => {
    state.jobs     = [makeJob({ status: "dang_pts" })];
    state.earnings = [makeEarning()];

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].values.status).toBe("voided");
  });

  it("voids the existing earning when status is da_pts", async () => {
    state.jobs     = [makeJob({ status: "da_pts" })];
    state.earnings = [makeEarning()];

    await syncPhotoshopEarning(1);

    expect(state.updates[0].values.status).toBe("voided");
  });

  it("skips update when the earning is already voided", async () => {
    state.jobs     = [makeJob({ status: "dang_pts" })];
    state.earnings = [makeEarning({ status: "voided" })];

    await syncPhotoshopEarning(1);

    expect(state.updates).toHaveLength(0);
  });

  it("does not insert when reverting", async () => {
    state.jobs     = [makeJob({ status: "cho_duyet" })];
    state.earnings = [makeEarning()];

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(0);
  });
});

// ── Staff swap ────────────────────────────────────────────────────────────────
describe("completedBy change (staff swap)", () => {
  it("voids old staff earning and inserts new one for the new staff", async () => {
    state.jobs     = [makeJob({ completedBy: 20 })];
    state.staff    = [{ id: 20 }];
    state.earnings = [makeEarning({ staffId: 10, id: 55 })];
    state.pkgInfo  = { service_package_id: 48, items: null, group_id: 10 };

    await syncPhotoshopEarning(1);

    const voidOp = state.updates.find(u => u.id === 55);
    expect(voidOp).toBeDefined();
    expect(voidOp!.values.status).toBe("voided");

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].staffId).toBe(20);
  });
});

// ── Skip ──────────────────────────────────────────────────────────────────────
describe("skip", () => {
  it("does nothing when bookingId is null", async () => {
    state.jobs  = [makeJob({ bookingId: null })];
    state.staff = [{ id: 10 }];

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(0);
  });

  it("does nothing when total count = 0 (both detail + party = 0)", async () => {
    state.jobs  = [makeJob({ detailPhotosCount: 0, partyPhotosCount: 0 })];
    state.staff = [{ id: 10 }];

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(0);
  });

  it("does nothing when both counts are null", async () => {
    state.jobs  = [makeJob({ detailPhotosCount: null, partyPhotosCount: null })];
    state.staff = [{ id: 10 }];

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(0);
  });

  it("returns early when job does not exist", async () => {
    state.jobs = [];

    await syncPhotoshopEarning(999);

    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("voids stale earnings when bookingId is null", async () => {
    state.jobs     = [makeJob({ bookingId: null })];
    state.staff    = [{ id: 10 }];
    state.earnings = [makeEarning()];

    await syncPhotoshopEarning(1);

    expect(state.inserts).toHaveLength(0);
    expect(state.updates[0].values.status).toBe("voided");
  });
});

// ── Rate priority (Task #493): cast > per-staff per_photo > fallback group ────
describe("rate priority (cast-driven)", () => {
  it("(1) staff_cast_rates theo packageId thắng tất cả", async () => {
    state.jobs       = [makeJob({ detailPhotosCount: 4 })];
    state.staff      = [{ id: 10 }];
    state.pkgInfo    = { service_package_id: 64, items: null, group_id: 17 };
    state.castRates  = [{ staffId: 10, role: "photoshop", packageId: 64, amount: "20000" }];
    state.staffRates = [{ staffId: 10, role: "photoshop", taskKey: "mac_dinh", rateType: "per_photo", rate: "5000" }];

    await syncPhotoshopEarning(1);

    expect(state.inserts[0].rate).toBe("80000"); // 4 × 20 000 (cast)
  });

  it("(2) Không có cast → dùng staff_rate_prices per_photo", async () => {
    state.jobs       = [makeJob({ detailPhotosCount: 3 })];
    state.staff      = [{ id: 10 }];
    state.pkgInfo    = { service_package_id: 48, items: null, group_id: 10 };
    state.castRates  = [];
    state.staffRates = [{ staffId: 10, role: "photoshop", taskKey: "mac_dinh", rateType: "per_photo", rate: "15000" }];

    await syncPhotoshopEarning(1);

    expect(state.inserts[0].rate).toBe("45000"); // 3 × 15 000
  });

  it("(3a) Không cast + không per-staff → group 17 → 1.000đ", async () => {
    state.jobs       = [makeJob({ detailPhotosCount: 5, partyPhotosCount: 0 })];
    state.staff      = [{ id: 10 }];
    state.pkgInfo    = { service_package_id: 64, items: null, group_id: 17 };
    state.castRates  = [];
    state.staffRates = [];

    await syncPhotoshopEarning(1);

    expect(state.inserts[0].rate).toBe("5000");  // 5 × 1 000
  });

  it("(3b) Không cast + không per-staff → gói thường (group != 17) → 12.000đ", async () => {
    state.jobs       = [makeJob({ detailPhotosCount: 2 })];
    state.staff      = [{ id: 10 }];
    state.pkgInfo    = { service_package_id: 48, items: null, group_id: 10 };
    state.castRates  = [];
    state.staffRates = [];

    await syncPhotoshopEarning(1);

    expect(state.inserts[0].rate).toBe("24000"); // 2 × 12 000
  });

  it("Ignore staff_rate_prices khi rateType != per_photo → fallback group", async () => {
    state.jobs       = [makeJob({ detailPhotosCount: 2 })];
    state.staff      = [{ id: 10 }];
    state.pkgInfo    = { service_package_id: 64, items: null, group_id: 17 };
    state.castRates  = [];
    state.staffRates = [{ staffId: 10, role: "photoshop", taskKey: "mac_dinh", rateType: "per_job", rate: "50000" }];

    await syncPhotoshopEarning(1);

    expect(state.inserts[0].rate).toBe("2000");  // 2 × 1 000 (group 17 fallback)
  });

  it("Derive packageId từ items[].serviceKey khi bookings.service_package_id null", async () => {
    state.jobs       = [makeJob({ detailPhotosCount: 4 })];
    state.staff      = [{ id: 10 }];
    state.pkgInfo    = { service_package_id: null, items: [{ serviceKey: "pkg-64" }], group_id: 17 };
    state.castRates  = [{ staffId: 10, role: "photoshop", packageId: 64, amount: "25000" }];

    await syncPhotoshopEarning(1);

    expect(state.inserts[0].rate).toBe("100000"); // 4 × 25 000 (cast theo derived packageId)
  });
});
