import { describe, expect, it } from "vitest";
import {
  RENTAL_LIST_STATE_VERSION,
  createRentalDetailNavigationState,
  isRentalListNavigationState,
  rentalListStorageKey,
  type RentalListNavigationState,
} from "./rental-navigation";

const validState: RentalListNavigationState = {
  version: RENTAL_LIST_STATE_VERSION,
  entryId: "entry-beauty",
  url: "/cho-thue-do?categoryId=22&q=buom&sort=price_asc",
  categoryId: 22,
  selectedCategoryId: 23,
  tier1Id: 22,
  tier2Id: null,
  tier3Id: null,
  selectedSizes: ["S"],
  selectedWeights: [],
  selectedColors: ["Tím"],
  selectedTags: ["NÀNG THƠ"],
  selectedOutfitTags: ["SIEU_MOI"],
  query: "buom",
  sortMode: "price_asc",
  visibleCount: 120,
  scrollY: 2400,
  categoryScrollLeft: 320,
  anchorProductId: 223,
  anchorProductSlug: "beaty-buom-tim-223",
  anchorProductCode: "NT-001",
  anchorViewportTop: 180,
};

describe("rental navigation state", () => {
  it("accepts a complete state only for its exact list URL", () => {
    expect(isRentalListNavigationState(validState, validState.url)).toBe(true);
    expect(
      isRentalListNavigationState(validState, "/cho-thue-do?categoryId=25"),
    ).toBe(false);
  });

  it("rejects incomplete or unsafe state", () => {
    expect(isRentalListNavigationState({ ...validState, entryId: "" })).toBe(
      false,
    );
    expect(
      isRentalListNavigationState({ ...validState, url: "/calendar" }),
    ).toBe(false);
    expect(
      isRentalListNavigationState({ ...validState, sortMode: "random" }),
    ).toBe(false);
  });

  it("isolates session fallback by URL and history entry", () => {
    expect(rentalListStorageKey(validState.url, "entry-a")).not.toBe(
      rentalListStorageKey(validState.url, "entry-b"),
    );
    expect(rentalListStorageKey(validState.url, "entry-a")).not.toBe(
      rentalListStorageKey("/cho-thue-do?categoryId=25", "entry-a"),
    );
  });

  it("passes the exact return URL and entry to the detail history entry", () => {
    expect(createRentalDetailNavigationState(validState)).toEqual({
      amazingRentalDetail: {
        returnUrl: validState.url,
        returnEntryId: validState.entryId,
      },
    });
  });
});
