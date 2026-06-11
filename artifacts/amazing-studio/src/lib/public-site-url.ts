/**
 * Public marketing site origin + home path (always "/", never /calendar or /cms).
 */
const DEFAULT_PUBLIC_ORIGIN = "https://tranchistudio.com";

/** Query flag: staff opened globe / public preview — show marketing site, not /calendar. */
export const PUBLIC_PREVIEW_PARAM = "xem_web";
export const PUBLIC_PREVIEW_VALUE = "1";
export const PUBLIC_PREVIEW_SESSION_KEY = "amazingStudioPublicPreview_v1";

function isLocalOrLanHost(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

function withPublicPreviewQuery(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(PUBLIC_PREVIEW_PARAM, PUBLIC_PREVIEW_VALUE);
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${PUBLIC_PREVIEW_PARAM}=${PUBLIC_PREVIEW_VALUE}`;
  }
}

export function getPublicSiteHomeUrl(): string {
  return getPublicPageUrl("/");
}

/**
 * Staff globe / new-tab preview: always append preview query so logged-in staff
 * see the public site. LUÔN dùng origin hiện tại (app đang chạy) — không dùng
 * domain production, để khi browser đi theo href (middle-click, popup bị chặn,
 * React chưa hydrate) vẫn mở đúng app này với flag ?xem_web=1 thay vì bị
 * bản deploy cũ trên domain khác đá về /calendar.
 */
export function getPublicPreviewUrl(path = "/"): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (typeof window !== "undefined" && window.location?.origin) {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "") || "";
    return withPublicPreviewQuery(`${window.location.origin}${base}${normalized}`);
  }
  return withPublicPreviewQuery(getPublicPageUrl(normalized));
}

/** Absolute URL for a public route (e.g. `/bo-anh`, `/san-pham/slug`). */
export function getPublicPageUrl(path: string, options?: { preview?: boolean }): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const explicit = (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined)?.trim();

  let resolved: string;
  if (explicit) {
    const origin = explicit.replace(/\/+$/, "");
    resolved = normalized === "/" ? `${origin}/` : `${origin}${normalized}`;
  } else if (typeof window !== "undefined" && window.location?.hostname) {
    if (isLocalOrLanHost(window.location.hostname)) {
      resolved =
        normalized === "/"
          ? `${DEFAULT_PUBLIC_ORIGIN}/`
          : `${DEFAULT_PUBLIC_ORIGIN}${normalized}`;
    } else {
      const base = import.meta.env.BASE_URL.replace(/\/$/, "") || "";
      resolved = `${window.location.origin}${base}${normalized}`;
    }
  } else {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "") || "";
    resolved = `${DEFAULT_PUBLIC_ORIGIN}${normalized}`;
  }

  return options?.preview ? withPublicPreviewQuery(resolved) : resolved;
}

/**
 * Open public website in a new tab. Uses same origin + preview flag so logged-in
 * staff still see the customer website (not /calendar).
 */
export function openPublicSite(path = "/"): void {
  const url = getPublicPreviewUrl(path);

  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) {
    opened.opener = null;
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
