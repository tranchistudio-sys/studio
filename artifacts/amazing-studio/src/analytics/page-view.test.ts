import { beforeEach, describe, expect, it } from "vitest";
import { resetPageViewTrackingForTests, shouldTrackPageView } from "./index";

describe("SPA PageView de-duplication", () => {
  beforeEach(resetPageViewTrackingForTests);

  it("fires once on initial render even when the tracker rerenders", () => {
    expect(shouldTrackPageView("/bang-gia")).toBe(true);
    expect(shouldTrackPageView("/bang-gia")).toBe(false);
  });

  it("fires once per navigation and again when returning to a page", () => {
    expect(shouldTrackPageView("/bang-gia")).toBe(true);
    expect(shouldTrackPageView("/bo-anh")).toBe(true);
    expect(shouldTrackPageView("/bo-anh")).toBe(false);
    expect(shouldTrackPageView("/bang-gia")).toBe(true);
  });
});
