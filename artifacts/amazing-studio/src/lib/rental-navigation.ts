export const RENTAL_LIST_STATE_VERSION = 2 as const;

export type RentalListSortMode =
  | "newest"
  | "oldest"
  | "price_asc"
  | "price_desc"
  | "name_asc";

export interface RentalListNavigationState {
  version: typeof RENTAL_LIST_STATE_VERSION;
  entryId: string;
  url: string;
  categoryId: number | null;
  selectedCategoryId: number | null;
  tier1Id: number | null;
  tier2Id: number | null;
  tier3Id: number | null;
  selectedSizes: string[];
  selectedWeights: string[];
  selectedColors: string[];
  selectedTags: string[];
  selectedOutfitTags: string[];
  query: string;
  sortMode: RentalListSortMode;
  visibleCount: number;
  scrollY: number;
  categoryScrollLeft: number;
  anchorProductId: number | null;
  anchorProductSlug: string | null;
  anchorProductCode: string | null;
  anchorViewportTop: number | null;
}

export interface RentalDetailNavigationState {
  returnUrl: string;
  returnEntryId: string;
}

interface RentalHistoryState {
  amazingRentalList?: RentalListNavigationState;
  amazingRentalDetail?: RentalDetailNavigationState;
  [key: string]: unknown;
}

const STORAGE_PREFIX = "amazing-studio:rental-list:v2:";
const SORT_MODES = new Set<RentalListSortMode>([
  "newest",
  "oldest",
  "price_asc",
  "price_desc",
  "name_asc",
]);

function isNullableNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function isRentalListNavigationState(
  value: unknown,
  expectedUrl?: string,
): value is RentalListNavigationState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<RentalListNavigationState>;
  return (
    state.version === RENTAL_LIST_STATE_VERSION &&
    typeof state.entryId === "string" &&
    state.entryId.length > 0 &&
    typeof state.url === "string" &&
    state.url.startsWith("/cho-thue-do") &&
    (expectedUrl === undefined || state.url === expectedUrl) &&
    isNullableNumber(state.categoryId) &&
    isNullableNumber(state.selectedCategoryId) &&
    isNullableNumber(state.tier1Id) &&
    isNullableNumber(state.tier2Id) &&
    isNullableNumber(state.tier3Id) &&
    isStringArray(state.selectedSizes) &&
    isStringArray(state.selectedWeights) &&
    isStringArray(state.selectedColors) &&
    isStringArray(state.selectedTags) &&
    isStringArray(state.selectedOutfitTags) &&
    typeof state.query === "string" &&
    typeof state.sortMode === "string" &&
    SORT_MODES.has(state.sortMode as RentalListSortMode) &&
    typeof state.visibleCount === "number" &&
    state.visibleCount > 0 &&
    typeof state.scrollY === "number" &&
    state.scrollY >= 0 &&
    typeof state.categoryScrollLeft === "number" &&
    state.categoryScrollLeft >= 0 &&
    isNullableNumber(state.anchorProductId) &&
    (state.anchorProductSlug === null ||
      typeof state.anchorProductSlug === "string") &&
    (state.anchorProductCode === null ||
      typeof state.anchorProductCode === "string") &&
    isNullableNumber(state.anchorViewportTop)
  );
}

export function rentalListStorageKey(url: string, entryId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(url)}:${entryId}`;
}

export function createRentalHistoryEntryId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function historyObject(): RentalHistoryState {
  const current = window.history.state;
  return current && typeof current === "object" ? current : {};
}

export function readRentalListNavigationState(
  expectedUrl: string,
): RentalListNavigationState | null {
  const fromHistory = historyObject().amazingRentalList;
  if (!isRentalListNavigationState(fromHistory, expectedUrl)) return null;

  try {
    const stored = sessionStorage.getItem(
      rentalListStorageKey(fromHistory.url, fromHistory.entryId),
    );
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (isRentalListNavigationState(parsed, expectedUrl)) return parsed;
    }
  } catch {
    // history.state remains the authoritative fallback.
  }
  return fromHistory;
}

export function writeRentalListNavigationState(
  state: RentalListNavigationState,
): void {
  const next: RentalHistoryState = {
    ...historyObject(),
    amazingRentalList: state,
  };
  window.history.replaceState(next, "", state.url);
  try {
    sessionStorage.setItem(
      rentalListStorageKey(state.url, state.entryId),
      JSON.stringify(state),
    );
  } catch {
    // Private browsing/storage limits must not break navigation.
  }
}

export function createRentalDetailNavigationState(
  listState: RentalListNavigationState,
): RentalHistoryState {
  return {
    amazingRentalDetail: {
      returnUrl: listState.url,
      returnEntryId: listState.entryId,
    },
  };
}

export function readRentalDetailNavigationState(): RentalDetailNavigationState | null {
  const value = historyObject().amazingRentalDetail;
  if (!value || typeof value !== "object") return null;
  const detail = value as Partial<RentalDetailNavigationState>;
  if (
    typeof detail.returnUrl !== "string" ||
    !detail.returnUrl.startsWith("/cho-thue-do") ||
    typeof detail.returnEntryId !== "string" ||
    detail.returnEntryId.length === 0
  ) {
    return null;
  }
  return detail as RentalDetailNavigationState;
}
