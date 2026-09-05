import { describe, expect, it } from "vitest";
import { computeFamilyPaymentSummary, type MoneyPaymentInput } from "./booking-money";

type Case = {
  code: string;
  total: number;
  discount?: number;
  parentPaid: number;
  childPayments?: number[];
  expectedPaid: number;
  expectedRemaining: number;
};

const historicalExceptions: Case[] = [
  { code: "DH0032", total: 11_600_000, parentPaid: 1_000_000, expectedPaid: 1_000_000, expectedRemaining: 10_600_000 },
  { code: "DH0036", total: 14_500_000, parentPaid: 2_000_000, expectedPaid: 2_000_000, expectedRemaining: 12_500_000 },
  { code: "DH0048", total: 10_400_000, parentPaid: 1_000_000, expectedPaid: 1_000_000, expectedRemaining: 9_400_000 },
  { code: "DH0051", total: 8_600_000, parentPaid: 1_300_000, expectedPaid: 1_300_000, expectedRemaining: 7_300_000 },
  { code: "DH0147", total: 18_300_000, parentPaid: 18_300_000, expectedPaid: 18_300_000, expectedRemaining: 0 },
  { code: "DH0153", total: 17_000_000, parentPaid: 1_000_000, expectedPaid: 1_000_000, expectedRemaining: 16_000_000 },
  { code: "DH0185", total: 21_700_000, parentPaid: 2_000_000, expectedPaid: 2_000_000, expectedRemaining: 19_700_000 },
  { code: "DH0201", total: 24_400_000, discount: 2_000_000, parentPaid: 2_000_000, expectedPaid: 2_000_000, expectedRemaining: 20_400_000 },
  { code: "BG0014", total: 10_600_000, parentPaid: 1_000_000, expectedPaid: 1_000_000, expectedRemaining: 9_600_000 },
  { code: "DH0262", total: 0, parentPaid: 2_000_000, expectedPaid: 2_000_000, expectedRemaining: 0 },
  { code: "BG0022", total: 0, parentPaid: 3_000_000, expectedPaid: 3_000_000, expectedRemaining: 0 },
  { code: "DH0270", total: 0, parentPaid: 1_700_000, expectedPaid: 1_700_000, expectedRemaining: 0 },
  { code: "DH0019", total: 6_500_000, parentPaid: 6_500_000, childPayments: [5_500_000], expectedPaid: 12_000_000, expectedRemaining: 0 },
  { code: "DH0054", total: 6_500_000, parentPaid: 6_500_000, childPayments: [500_000, 500_000], expectedPaid: 7_500_000, expectedRemaining: 0 },
  { code: "DH0078", total: 9_900_000, parentPaid: 9_900_000, childPayments: [500_000, 500_000, 500_000], expectedPaid: 11_400_000, expectedRemaining: 0 },
];

describe("15 hợp đồng production từng lệch — regression fixtures read-only", () => {
  it.each(historicalExceptions)("$code trả đúng tiền cả gia đình", (fixture) => {
    const rootId = 1;
    const childPayments = fixture.childPayments ?? [];
    const ids = new Set([rootId, ...childPayments.map((_, index) => index + 2)]);
    const payments: MoneyPaymentInput[] = [
      { id: 1, bookingId: rootId, amount: fixture.parentPaid, paymentType: "payment", status: "active" },
      ...childPayments.map((amount, index) => ({
        id: index + 2,
        bookingId: index + 2,
        amount,
        paymentType: "payment",
        status: "active",
      })),
    ];
    const result = computeFamilyPaymentSummary(
      { totalAmount: fixture.total, discountAmount: fixture.discount ?? 0 },
      ids,
      payments,
    );
    expect(result.paid).toBe(fixture.expectedPaid);
    expect(result.remaining).toBe(fixture.expectedRemaining);
  });

  it("không động tới DH0155: hai payment id khác nhau vẫn là hai phiếu độc lập", () => {
    const result = computeFamilyPaymentSummary(
      { totalAmount: 9_950_000 },
      new Set([1]),
      [
        { id: 308, bookingId: 1, amount: 5_850_000, paymentType: "payment", status: "active" },
        { id: 309, bookingId: 1, amount: 5_850_000, paymentType: "payment", status: "active" },
      ],
    );
    expect(result.paid).toBe(11_700_000);
  });
});
