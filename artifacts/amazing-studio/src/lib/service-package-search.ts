/**
 * Search helpers for ServiceSearchBox — name + price matching (client-side only).
 */

export function removeDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export function normalizeSearchText(value: string): string {
  return removeDiacritics(value).toLowerCase().trim();
}

export function compactQuery(value: string): string {
  return normalizeSearchText(value).replace(/[.,\s]/g, "");
}

/** Parse user input into VND amount when it looks like a price query. */
export function parsePriceQuery(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lower = removeDiacritics(trimmed).toLowerCase();
  const compact = compactQuery(trimmed);

  const parseMillionTail = (millions, tailStr) => {
    const m = Number(millions);
    const t = tailStr ? Number(tailStr) : 0;
    if (!Number.isFinite(m) || !Number.isFinite(t)) return null;
    return m * 1_000_000 + t * 100_000;
  };

  // 5tr7, 5tr, 3trieu (sau compact)
  const trCompact = compact.match(/^(\d+)(?:tr|trieu|m)(\d*)$/);
  if (trCompact) {
    const parsed = parseMillionTail(trCompact[1], trCompact[2]);
    if (parsed !== null) return parsed;
  }

  // 5 triệu 7, 3 triệu, 6 trieu 7
  const trieuSpaced = lower.match(/(\d+)\s*(?:tr|trieu|m|mil)(?:\s+(\d+))?/);
  if (trieuSpaced) {
    const parsed = parseMillionTail(trieuSpaced[1], trieuSpaced[2]);
    if (parsed !== null) return parsed;
  }

  // 3000k -> 3.000.000 (k = nghìn đồng, chỉ khi có hậu tố k)
  const kCompact = compact.match(/^(\d+)k$/);
  if (kCompact) {
    const n = Number(kCompact[1]);
    return Number.isFinite(n) ? n * 1_000 : null;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  // Full VND: 3000000, 5700000, 3.000.000
  if (digits.length >= 7) {
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  // Shorthand 4–6 chữ số: 3000 -> 3.000.000, 5700 -> 5.700.000, 570000 -> 5.700.000
  if (/^[\d.,\s]+$/.test(trimmed) && digits.length >= 4 && digits.length <= 6) {
    const head = Number(digits[0]);
    const tail = Number(digits.slice(1));
    if (Number.isFinite(head) && Number.isFinite(tail)) {
      return head * 1_000_000 + tail * 1_000;
    }
  }

  return null;
}

export function priceDigits(price: number): string {
  return String(Math.round(price));
}

export function queryLooksLikePrice(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (parsePriceQuery(trimmed) !== null) return true;
  const lower = removeDiacritics(trimmed).toLowerCase();
  if (/(?:tr|trieu|triệu|mil)\b/.test(lower)) return true;
  if (/^\d[\d.,\s]*k?$/i.test(trimmed)) return true;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 3;
}

function priceTolerance(target: number): number {
  return Math.max(50_000, Math.round(target * 0.02));
}

export type ServiceSearchable = {
  key: string;
  id: number;
  name: string;
  groupName: string;
  price: number;
  serviceType?: string | null;
};

export function scoreServiceMatch(
  option: ServiceSearchable,
  rawQuery: string,
): number {
  const query = rawQuery.trim();
  if (!query) return 0;

  const norm = normalizeSearchText(query);
  const compact = compactQuery(query);
  const parsedPrice = parsePriceQuery(query);
  const digits = query.replace(/\D/g, "");

  const nameNorm = normalizeSearchText(option.name);
  const groupNorm = normalizeSearchText(option.groupName);
  const typeNorm = option.serviceType ? normalizeSearchText(option.serviceType) : "";
  const keyNorm = normalizeSearchText(option.key);
  const idStr = String(option.id);
  const priceStr = priceDigits(option.price);

  let score = 0;

  if (nameNorm === norm) score += 120;
  else if (nameNorm.includes(norm)) score += 90;

  if (groupNorm.includes(norm)) score += 50;
  if (typeNorm && typeNorm.includes(norm)) score += 45;
  if (keyNorm.includes(compact) || keyNorm.includes(norm)) score += 35;
  if (digits && idStr.includes(digits)) score += 30;

  if (parsedPrice !== null && option.price > 0) {
    const diff = Math.abs(option.price - parsedPrice);
    const tol = priceTolerance(parsedPrice);
    if (diff === 0) score += 150;
    else if (diff <= tol) score += 120 - Math.min(40, Math.round((diff / tol) * 40));
    else if (priceStr.includes(digits)) score += 55;
  } else if (digits.length >= 3 && priceStr.includes(digits)) {
    score += 65;
  }

  return score;
}

export function searchServiceOptions<T extends ServiceSearchable>(
  options: T[],
  rawQuery: string,
  limit = 20,
): T[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const priceMode = queryLooksLikePrice(query);

  return options
    .map((option) => ({ option, score: scoreServiceMatch(option, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (priceMode && a.score >= 100 && b.score >= 100) {
        const pa = parsePriceQuery(query);
        if (pa !== null) {
          return Math.abs(a.option.price - pa) - Math.abs(b.option.price - pa);
        }
      }
      if (b.score !== a.score) return b.score - a.score;
      return a.option.name.localeCompare(b.option.name, "vi");
    })
    .slice(0, limit)
    .map(({ option }) => option);
}
