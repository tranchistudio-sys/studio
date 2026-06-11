/**
 * Default month for list filters (YYYY-MM).
 * Local backup data is mostly May 2026 — set VITE_DEFAULT_VIEW_MONTH in .env.
 */
export function getDefaultViewMonth(): string {
  const env = import.meta.env.VITE_DEFAULT_VIEW_MONTH as string | undefined;
  if (env?.trim() && /^\d{4}-\d{2}$/.test(env.trim())) return env.trim();
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function getDefaultViewMonthParts(): { year: string; month: string; monthNum: number; yearNum: number } {
  const [year, month] = getDefaultViewMonth().split("-");
  return {
    year,
    month,
    monthNum: parseInt(month, 10),
    yearNum: parseInt(year, 10),
  };
}

/** First day of default view month — for calendar initial view. */
export function getDefaultCalendarDate(): Date {
  const { yearNum, monthNum } = getDefaultViewMonthParts();
  return new Date(yearNum, monthNum - 1, 1);
}
