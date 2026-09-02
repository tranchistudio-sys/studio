import { describe, expect, it } from "vitest";
import { publicBrandingView } from "./use-public-branding";

describe("publicBrandingView", () => {
  it("never falls back to Amazing contact details for another tenant", () => {
    const view = publicBrandingView("cupid-wedding", {
      publicName: "Cupid Wedding",
      phone: null,
      address: null,
      logoUrl: null,
    });
    expect(view).toMatchObject({
      publicName: "Cupid Wedding",
      phone: null,
      phoneDisplay: null,
      address: null,
      email: null,
      isAmazingLegacy: false,
    });
  });

  it("preserves the legacy Amazing fallback only on the legacy slug", () => {
    const view = publicBrandingView("amazing-studio");
    expect(view.isAmazingLegacy).toBe(true);
    expect(view.phone).toBeTruthy();
    expect(view.address).toBeTruthy();
    expect(view.email).toBeTruthy();
  });
});
