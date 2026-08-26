import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import {
  evaluateWeddingGiftTrace,
  WEDDING_GIFT_PROGRAM_TEMPLATE,
  type WeddingGiftProgramConfig,
} from "./sale-wedding-gifts";

const ACTIVE_PROGRAM: WeddingGiftProgramConfig = {
  ...WEDDING_GIFT_PROGRAM_TEMPLATE,
  id: 1,
  enabled: true,
  startsAt: "2026-01-01T00:00:00.000Z",
  endsAt: "2026-12-31T23:59:59.000Z",
  source: "database",
};

const quoted = [{
  direction: "outgoing" as const,
  message: "Gói Basic 1.900.000 đồng, gói Premium 2.900.000 đồng.",
  aiDecision: "claude_price_sheet_replied",
}];

describe("wedding gift program", () => {
  it("does not count a price inquiry as a confirmed service", () => {
    const trace = evaluateWeddingGiftTrace({
      message: "Album studio giá bao nhiêu?",
      program: ACTIVE_PROGRAM,
      currentServiceKey: "album_studio",
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(trace.interestedWeddingServices).toContain("album_studio");
    expect(trace.confirmedWeddingServices).toHaveLength(0);
    expect(trace.eligibleServiceCount).toBe(0);
    expect(trace.action).toBe("wait_until_after_quote");
  });

  it("uses tier 2 and lets the customer choose one of two gifts", () => {
    const trace = evaluateWeddingGiftTrace({
      message: "Chị chốt album studio và chụp cổng.",
      prior: quoted,
      program: ACTIVE_PROGRAM,
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(trace.eligibleServiceCount).toBe(2);
    expect(trace.giftTier).toBe(2);
    expect(trace.chooseCount).toBe(1);
    expect(trace.giftOptions).toHaveLength(2);
    expect(trace.action).toBe("introduce_gift_tier");
  });

  it("uses the exact three-option tier for three confirmed services", () => {
    const trace = evaluateWeddingGiftTrace({
      message: "Chị chốt album studio, album ngoại cảnh và chụp tiệc cưới.",
      prior: quoted,
      program: ACTIVE_PROGRAM,
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(trace.giftTier).toBe(3);
    expect(trace.giftOptions).toHaveLength(3);
    expect(trace.chooseCount).toBe(1);
  });

  it("recalculates the tier when the customer removes a service", () => {
    const trace = evaluateWeddingGiftTrace({
      message: "Chị không lấy chụp cổng nữa.",
      prior: [
        ...quoted,
        { direction: "incoming", message: "Chị chốt album studio, album ngoại cảnh và chụp cổng." },
      ],
      program: ACTIVE_PROGRAM,
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(trace.confirmedWeddingServices).not.toContain("wedding_gate");
    expect(trace.eligibleServiceCount).toBe(2);
    expect(trace.giftTier).toBe(2);
  });

  it("never introduces wedding gifts for standalone beauty or maternity", () => {
    const beauty = evaluateWeddingGiftTrace({
      message: "Chị chốt chụp beauty sinh nhật.",
      prior: quoted,
      program: ACTIVE_PROGRAM,
      currentServiceKey: "beauty",
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    const maternity = evaluateWeddingGiftTrace({
      message: "Chị chốt chụp bầu.",
      prior: quoted,
      program: ACTIVE_PROGRAM,
      currentServiceKey: "maternity",
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(beauty.action).toBe("none");
    expect(maternity.action).toBe("none");
  });

  it("stays silent when disabled or expired", () => {
    const disabled = evaluateWeddingGiftTrace({
      message: "Chị chốt album studio và chụp cổng.",
      prior: quoted,
      program: WEDDING_GIFT_PROGRAM_TEMPLATE,
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    const expired = evaluateWeddingGiftTrace({
      message: "Chị chốt album studio và chụp cổng.",
      prior: quoted,
      program: { ...ACTIVE_PROGRAM, endsAt: "2026-07-01T00:00:00.000Z" },
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(disabled.action).toBe("none");
    expect(expired.action).toBe("none");
  });
});
