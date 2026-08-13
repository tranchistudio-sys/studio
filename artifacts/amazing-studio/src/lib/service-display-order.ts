/**
 * Display-only ordering for services in a multi-service booking/contract.
 *
 * The database order, service labels and order codes are business identifiers, so
 * this helper always returns a new array and never rewrites any service data.
 */
export type ServiceDisplayOrderSource = {
  shootDate?: string | null;
  shootTime?: string | null;
  serviceLabel?: string | null;
  orderCode?: string | null;
};

function validUtcDate(y: number, m: number, d: number): boolean {
  const value = new Date(Date.UTC(y, m - 1, d));
  return (
    value.getUTCFullYear() === y &&
    value.getUTCMonth() === m - 1 &&
    value.getUTCDate() === d
  );
}

/**
 * Parse the stored wall-clock date/time without converting it through the
 * browser timezone. This keeps Vietnamese YYYY-MM-DD dates on their intended day.
 */
export function serviceEventSortKey(
  service: ServiceDisplayOrderSource,
): number {
  const rawDate = String(service.shootDate ?? "").trim();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(rawDate);
  if (!dateMatch) return Number.POSITIVE_INFINITY;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (!validUtcDate(year, month, day)) return Number.POSITIVE_INFINITY;

  const rawTime = String(service.shootTime ?? "").trim();
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(rawTime);
  const hour = timeMatch ? Number(timeMatch[1]) : 0;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  const second = timeMatch?.[3] ? Number(timeMatch[3]) : 0;
  const hasValidTime =
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59;

  return Date.UTC(
    year,
    month - 1,
    day,
    hasValidTime ? hour : 0,
    hasValidTime ? minute : 0,
    hasValidTime ? second : 0,
  );
}

/** Earliest service first; missing/invalid dates last; equal values stay stable. */
export function sortServicesByEventDate<T extends ServiceDisplayOrderSource>(
  services: readonly T[],
): T[] {
  return services
    .map((service, originalIndex) => ({
      service,
      originalIndex,
      key: serviceEventSortKey(service),
    }))
    .sort((a, b) => a.key - b.key || a.originalIndex - b.originalIndex)
    .map(({ service }) => service);
}

/**
 * Preserve the service's existing visual number after cards are reordered.
 * Prefer the saved label, then the immutable order-code suffix.
 */
export function serviceDisplayOrdinal(
  service: ServiceDisplayOrderSource,
  fallbackIndex: number,
): number {
  const labelMatch = /d(?:ị|i)ch\s*v(?:ụ|u)\s*(\d+)/i.exec(
    String(service.serviceLabel ?? ""),
  );
  if (labelMatch) return Number(labelMatch[1]);

  const codeMatch = /-(\d+)$/.exec(String(service.orderCode ?? ""));
  if (codeMatch) return Number(codeMatch[1]);

  return fallbackIndex + 1;
}
