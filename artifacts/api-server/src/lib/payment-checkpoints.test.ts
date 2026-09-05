import { describe, expect, it } from "vitest";
import { deriveCollectionCheckpoints, serializeCheckpointStates, vietnamDateKey } from "./payment-checkpoints";

const TODAY = "2026-09-10";
const root = (totalAmount = 1_000) => ({ id: 1, isParentContract: true, totalAmount, discountAmount: 0, status: "confirmed", shootDate: "2026-09-01" });
const service = (id: number, shootDate: string, extra: Record<string, unknown> = {}) => ({ id, parentId: 1, totalAmount: 0, status: "confirmed", shootDate, ...extra });
const payment = (id: number, paidDate: string, amount = 100, bookingId = 1, status = "active") => ({ id, bookingId, amount, paidDate, paymentType: "payment", status });
const states = (bookings: any[], payments: any[], today = TODAY) => serializeCheckpointStates(deriveCollectionCheckpoints(bookings, payments, today));

describe("deriveCollectionCheckpoints", () => {
  it("does not show a future checkpoint", () => expect(states([root(), service(2, "2026-09-11")], [])).toEqual({}));
  it("marks a due or overdue unpaid checkpoint red", () => {
    expect(states([root(), service(2, "2026-09-10")], [])[2]["2026-09-10"]).toBe("final_due");
    expect(states([root(), service(2, "2026-09-01")], [])[2]["2026-09-01"]).toBe("final_due");
  });
  it("closes one middle checkpoint with one positive receipt", () => {
    const result = states([root(), service(2, "2026-09-01"), service(3, "2026-09-05"), service(4, "2026-09-10")], [payment(1, "2026-09-05")]);
    expect(result[2]["2026-09-01"]).toBe("collected");
    expect(result[3]["2026-09-05"]).toBe("due");
  });
  it("ignores zero and voided receipts", () => {
    const bookings = [root(), service(2, "2026-09-01"), service(3, "2026-09-10")];
    expect(states(bookings, [payment(1, "2026-09-01", 0)])[2]["2026-09-01"]).toBe("due");
    expect(states(bookings, [payment(1, "2026-09-01", 100, 1, "voided")])[2]["2026-09-01"]).toBe("due");
  });
  it("does not use a deposit paid before the first service", () => {
    const result = states([root(), service(2, "2026-09-05"), service(3, "2026-09-10")], [{ ...payment(1, "2026-09-04"), paymentType: "deposit" }]);
    expect(result[2]["2026-09-05"]).toBe("due");
  });
  it("uses one receipt for only one checkpoint", () => {
    const result = states([root(), service(2, "2026-09-01"), service(3, "2026-09-02"), service(4, "2026-09-10")], [payment(1, "2026-09-03")]);
    expect(result[2]["2026-09-01"]).toBe("collected");
    expect(result[3]["2026-09-02"]).toBe("due");
  });
  it("gives all services on the same day the same checkpoint state", () => {
    const result = states([root(), service(2, "2026-09-01"), service(3, "2026-09-01"), service(4, "2026-09-10")], [payment(1, "2026-09-01")]);
    expect(result[2]["2026-09-01"]).toBe("collected");
    expect(result[3]["2026-09-01"]).toBe("collected");
  });
  it("keeps final checkpoint due until the whole family is fully paid", () => {
    const bookings = [root(), service(2, "2026-09-10")];
    expect(states(bookings, [payment(1, "2026-09-10", 900)])[2]["2026-09-10"]).toBe("final_due");
    expect(states(bookings, [payment(1, "2026-09-10", 1_000)])[2]["2026-09-10"]).toBe("collected");
    expect(states(bookings, [payment(1, "2026-09-10", 1_100)])[2]["2026-09-10"]).toBe("collected");
  });
  it("treats a one-day contract as the final checkpoint", () => {
    const bookings = [root(), service(2, "2026-09-10")];
    expect(states(bookings, [payment(1, "2026-09-10", 100)])[2]["2026-09-10"]).toBe("final_due");
  });
  it("recognizes parent and child receipts, dedupes by payment id", () => {
    const bookings = [root(200), service(2, "2026-09-01"), service(3, "2026-09-10")];
    const p = payment(1, "2026-09-01", 100, 2);
    const result = states(bookings, [p, p, payment(2, "2026-09-10", 100, 1)]);
    expect(result[2]["2026-09-01"]).toBe("collected");
    expect(result[3]["2026-09-10"]).toBe("collected");
  });
  it("omits deleted/cancelled services and their dates", () => {
    const result = states([root(), service(2, "2026-09-01", { deletedAt: new Date() }), service(3, "2026-09-02", { status: "cancelled" }), service(4, "2026-09-10")], []);
    expect(result[2]).toBeUndefined();
    expect(result[3]).toBeUndefined();
    expect(result[4]["2026-09-10"]).toBe("final_due");
  });
  it("includes occurrence days and directly linked receipts first", () => {
    const bookings = [root(), service(2, "2026-09-01", { occurrences: [{ shootDate: "2026-09-03" }] }), service(3, "2026-09-10")];
    const result = states(bookings, [payment(1, "2026-09-03", 100, 2)]);
    expect(result[2]["2026-09-01"]).toBe("collected");
    expect(result[2]["2026-09-03"]).toBe("due");
  });
  it("uses Asia/Ho_Chi_Minh for timestamp boundaries", () => {
    expect(vietnamDateKey("2026-09-04T17:30:00.000Z")).toBe("2026-09-05");
    expect(vietnamDateKey("2026-09-05")).toBe("2026-09-05");
  });
  it("is pure and does not mutate inputs", () => {
    const bookings = Object.freeze([Object.freeze(root()), Object.freeze(service(2, "2026-09-10"))]);
    const payments = Object.freeze([Object.freeze(payment(1, "2026-09-10", 1_000))]);
    expect(() => states(bookings as any, payments as any)).not.toThrow();
  });
});
