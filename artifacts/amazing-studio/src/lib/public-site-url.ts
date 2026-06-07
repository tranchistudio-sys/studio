/**
 * Public marketing site origin + home path (always "/", never /calendar or /cms).
 */
export function getPublicSiteHomeUrl(): string {
  return getPublicPageUrl("/");
}

/** Absolute URL for a public route (e.g. `/bo-anh`, `/san-pham/slug`). */
export function getPublicPageUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const explicit = (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined)?.trim();
  if (explicit) {
    const origin = explicit.replace(/\/+$/, "");
    return normalized === "/" ? `${origin}/` : `${origin}${normalized}`;
  }
  const base = import.meta.env.BASE_URL.replace(/\/$/, "") || "";
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${base}${normalized}`;
  }
  return `${base}${normalized}` || normalized;
}

/**
 * Open public website in a new tab. Falls back to full-page navigation when
 * popups are blocked (common on mobile / in-app browsers).
 */
export function openPublicSite(path = "/"): void {
  const url = getPublicPageUrl(path);
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) {
    opened.opener = null;
    return;
  }
  window.location.assign(url);
}
