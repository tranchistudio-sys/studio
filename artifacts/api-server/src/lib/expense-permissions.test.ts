import { describe, expect, it } from "vitest";
import {
  PERSONAL_COST_CLASS,
  ALLOWED_COST_CLASSES,
  isAllowedCostClass,
  isPersonalClass,
  resolveCostClass,
  effectiveCostClass,
  isAdminRole,
  canUsePersonalClass,
  canViewExpense,
  filterExpensesForCaller,
  matchesCostClass,
  countsTowardTotals,
  type ExpenseLike,
} from "./expense-permissions";

// Dữ liệu mẫu
const ADMIN = { isAdmin: true, callerId: 1 };
const STAFF = { isAdmin: false, callerId: 7 };

const personalExp: ExpenseLike = { createdByStaffId: null, costClass: "personal", bookingId: null };
const ownOperatingExp: ExpenseLike = { createdByStaffId: 7, costClass: "operating", bookingId: null };
const otherOperatingExp: ExpenseLike = { createdByStaffId: 99, costClass: "operating", bookingId: null };
const directExp: ExpenseLike = { createdByStaffId: 7, costClass: "direct", bookingId: 42 };

describe("hằng số & nhận diện loại", () => {
  it("personal nằm trong danh sách hợp lệ, giữ đủ 5 loại cũ", () => {
    expect(PERSONAL_COST_CLASS).toBe("personal");
    expect([...ALLOWED_COST_CLASSES]).toEqual([
      "direct", "operating", "depreciation", "interest", "loan_principal", "personal",
    ]);
  });
  it("isAllowedCostClass / isPersonalClass", () => {
    expect(isAllowedCostClass("personal")).toBe(true);
    expect(isAllowedCostClass("operating")).toBe(true);
    expect(isAllowedCostClass("bogus")).toBe(false);
    expect(isAllowedCostClass(123)).toBe(false);
    expect(isPersonalClass("personal")).toBe(true);
    expect(isPersonalClass("operating")).toBe(false);
    expect(isPersonalClass(null)).toBe(false);
  });
});

describe("resolveCostClass", () => {
  it("giữ nguyên giá trị hợp lệ (gồm personal)", () => {
    expect(resolveCostClass("personal", false)).toBe("personal");
    expect(resolveCostClass("depreciation", true)).toBe("depreciation");
  });
  it("giá trị rác → suy mặc định theo booking", () => {
    expect(resolveCostClass("xyz", true)).toBe("direct");
    expect(resolveCostClass(undefined, false)).toBe("operating");
  });
  it("effectiveCostClass suy fallback cho phiếu cũ thiếu cột", () => {
    expect(effectiveCostClass({ costClass: null, bookingId: 5 })).toBe("direct");
    expect(effectiveCostClass({ costClass: null, bookingId: null })).toBe("operating");
    expect(effectiveCostClass({ costClass: "personal" })).toBe("personal");
  });
});

describe("isAdminRole", () => {
  it("admin qua role hoặc roles[]", () => {
    expect(isAdminRole("admin", [])).toBe(true);
    expect(isAdminRole("assistant", ["sale", "admin"])).toBe(true);
  });
  it("không admin", () => {
    expect(isAdminRole("assistant", ["sale"])).toBe(false);
    expect(isAdminRole(null, null)).toBe(false);
  });
});

describe("quyền tạo/dùng loại Cá nhân", () => {
  it("admin được dùng personal, nhân viên thì không", () => {
    expect(canUsePersonalClass(true)).toBe(true);   // admin tạo được phiếu Cá nhân
    expect(canUsePersonalClass(false)).toBe(false); // nhân viên KHÔNG tạo được
  });
});

describe("canViewExpense — xem dòng / chi tiết", () => {
  it("admin xem được tất cả, gồm cả Cá nhân", () => {
    expect(canViewExpense(personalExp, ADMIN)).toBe(true);
    expect(canViewExpense(otherOperatingExp, ADMIN)).toBe(true);
  });
  it("nhân viên KHÔNG xem được phiếu Cá nhân (kể cả gọi API trực tiếp)", () => {
    expect(canViewExpense(personalExp, STAFF)).toBe(false);
    // dù phiếu personal lỡ bị gán createdByStaffId = chính nhân viên đó → vẫn chặn
    expect(canViewExpense({ createdByStaffId: 7, costClass: "personal" }, STAFF)).toBe(false);
  });
  it("nhân viên chỉ xem phiếu của chính mình (không phải personal)", () => {
    expect(canViewExpense(ownOperatingExp, STAFF)).toBe(true);
    expect(canViewExpense(directExp, STAFF)).toBe(true);
    expect(canViewExpense(otherOperatingExp, STAFF)).toBe(false);
  });
});

describe("filterExpensesForCaller — danh sách", () => {
  const rows = [personalExp, ownOperatingExp, otherOperatingExp, directExp];
  it("admin thấy toàn bộ", () => {
    expect(filterExpensesForCaller(rows, ADMIN)).toHaveLength(4);
  });
  it("nhân viên KHÔNG thấy dòng Cá nhân, chỉ thấy phiếu của mình", () => {
    const seen = filterExpensesForCaller(rows, STAFF);
    expect(seen).toEqual([ownOperatingExp, directExp]);
    expect(seen.some(e => e.costClass === "personal")).toBe(false);
  });
});

describe("matchesCostClass + filter Cá nhân", () => {
  it("admin lọc được nhóm Cá nhân", () => {
    const rows = [personalExp, ownOperatingExp];
    const visible = filterExpensesForCaller(rows, ADMIN);
    const onlyPersonal = visible.filter(e => matchesCostClass(e, "personal"));
    expect(onlyPersonal).toEqual([personalExp]);
  });
  it("nhân viên filter personal → rỗng (không lộ dữ liệu)", () => {
    const rows = [personalExp, ownOperatingExp, otherOperatingExp];
    // backend: loại quyền trước rồi mới khớp filter
    const visible = filterExpensesForCaller(rows, STAFF);
    const onlyPersonal = visible.filter(e => matchesCostClass(e, "personal"));
    expect(onlyPersonal).toEqual([]);
  });
  it("matchesCostClass suy mặc định cho phiếu thiếu cột", () => {
    expect(matchesCostClass({ costClass: null, bookingId: 1 }, "direct")).toBe(true);
    expect(matchesCostClass({ costClass: null, bookingId: null }, "operating")).toBe(true);
  });
});

describe("countsTowardTotals — tổng chi / lợi nhuận", () => {
  it("Cá nhân VẪN tính vào tổng (chỉ ẩn dòng, không loại khỏi tổng)", () => {
    expect(countsTowardTotals("personal")).toBe(true);
    expect(countsTowardTotals("operating")).toBe(true);
    expect(countsTowardTotals("direct")).toBe(true);
  });
  it("chỉ loan_principal bị loại khỏi P&L", () => {
    expect(countsTowardTotals("loan_principal")).toBe(false);
  });
});
